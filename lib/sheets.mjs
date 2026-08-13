// lib/sheets.mjs — the ONLY layer that communicates with Google Sheets.
//
// NOVUS rule: the browser never talks to Google Sheets directly. Every read and
// write goes: NOVUS UI → /api/novus/* (serverless) → THIS FILE → Google Sheets.
//
// AUTH: keyless. No service-account private key ever exists (the GCP org policy
// iam.managed.disableServiceAccountKeyCreation forbids it, and we don't need it).
// Vercel issues a short-lived OIDC ID token per invocation (getVercelOidcToken);
// that token is federated through Google Workload Identity Federation and
// exchanged for a short-lived access token impersonating the dedicated
// novus-sheets service account. google-auth-library's ExternalAccountClient
// handles the OIDC→STS→impersonation chain and token caching internally — we
// only supply the WIF provider audience, the target service account, and a
// supplier function that hands over the current Vercel OIDC token on demand.
//
// Auth/config (server-side env vars only — never exposed to the browser):
//   GCP_WORKLOAD_IDENTITY_AUDIENCE  full WIF provider resource name, e.g.
//     //iam.googleapis.com/projects/<NUM>/locations/global/workloadIdentityPools/<POOL>/providers/<PROVIDER>
//   GCP_SERVICE_ACCOUNT_EMAIL       novus-sheets@first-metric-505115-n3.iam.gserviceaccount.com
//   NOVUS_SHEET_ID                  the spreadsheet id of NOVUS_Data_V1_Master_v2
//
// Testability: the row logic lives in createRepo(valuesApi), which depends only
// on a tiny { get, append, update } transport. Production builds the real
// transport (token + fetch); tests inject an in-memory fake with the same shape.
// __setRepoForTests() lets the API handlers run against that fake without network
// or GCP/Vercel credentials of any kind.

import { getVercelOidcToken } from '@vercel/oidc';
import { ExternalAccountClient } from 'google-auth-library';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// ── Workload Identity Federation auth client (built once, reused across warm
// invocations — ExternalAccountClient caches/refreshes the impersonated token
// internally, so we don't need to manage expiry ourselves) ───────────────────
let _authClient = null;
function getAuthClient() {
  if (_authClient) return _authClient;

  const audience = process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE;
  const serviceAccountEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL;
  if (!audience) throw new Error('GCP_WORKLOAD_IDENTITY_AUDIENCE is not set');
  if (!serviceAccountEmail) throw new Error('GCP_SERVICE_ACCOUNT_EMAIL is not set');

  const client = ExternalAccountClient.fromJSON({
    type: 'external_account',
    audience,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
    scopes: SCOPES,
    // Hands Google's client the live Vercel OIDC token on every refresh —
    // no file, no URL, no static credential of any kind.
    subject_token_supplier: {
      getSubjectToken: () => getVercelOidcToken(),
    },
  });
  if (!client) throw new Error('Failed to construct ExternalAccountClient (invalid WIF config)');

  _authClient = client;
  return _authClient;
}

// Test-only: replace the WIF auth client (e.g. with a stub) without touching
// real env vars or credentials.
export function __setAuthClientForTests(client) { _authClient = client; }

async function getAccessToken() {
  const client = getAuthClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain a Google access token via Workload Identity Federation');
  return token;
}

// ── Real Sheets transport (values.get / append / update over REST) ────────────
function realValuesApi(spreadsheetId) {
  async function authedFetch(url, init = {}) {
    const token = await getAccessToken();
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Sheets API ${init.method || 'GET'} ${url} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return res.json();
  }
  return {
    async get(range) {
      const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
      const data = await authedFetch(url);
      return data.values || [];
    },
    async append(range, rows) {
      const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      return authedFetch(url, { method: 'POST', body: JSON.stringify({ values: rows }) });
    },
    async update(range, rows) {
      const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
      return authedFetch(url, { method: 'PUT', body: JSON.stringify({ values: rows }) });
    },
  };
}

// ── A1 helpers ────────────────────────────────────────────────────────────────
function colLetter(n) {
  // 1 -> A, 26 -> Z, 27 -> AA
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── Repository (pure logic over a values transport) ───────────────────────────
// A tab in this workbook is laid out as:
//   row 1 = header, row 2 = "SCHEMA NOTE ...", row 3+ = data.
// append naturally lands after the last populated row; find/update skip any row
// whose id column is empty or the literal "SCHEMA NOTE".
export function createRepo(valuesApi) {
  async function getTable(tab) {
    const values = await valuesApi.get(tab);
    const header = values[0] || [];
    const rows = values.slice(1);
    return { header, rows, allValues: values };
  }

  function rowObject(header, row) {
    const obj = {};
    header.forEach((key, i) => { obj[key] = row[i] ?? ''; });
    return obj;
  }

  return {
    getTable,

    // Returns array of {index (0-based within data rows), rowNumber (sheet row), obj}
    async getRecords(tab, idColumn) {
      const { header, rows } = await getTable(tab);
      const idIdx = header.indexOf(idColumn);
      const out = [];
      rows.forEach((row, i) => {
        const idVal = idIdx >= 0 ? (row[idIdx] ?? '') : '';
        if (!idVal || idVal === 'SCHEMA NOTE') return;
        out.push({ index: i, rowNumber: i + 2, obj: rowObject(header, row) });
      });
      return out;
    },

    async findById(tab, idColumn, idValue) {
      const records = await this.getRecords(tab, idColumn);
      return records.find((r) => r.obj[idColumn] === idValue) || null;
    },

    // Count real data records (used for human-readable sequencing).
    async count(tab, idColumn) {
      const records = await this.getRecords(tab, idColumn);
      return records.length;
    },

    // Append one record. `obj` keys are mapped onto the header order; unknown
    // header columns become ''.
    async appendRecord(tab, obj) {
      const { header } = await getTable(tab);
      const row = header.map((key) => (obj[key] ?? ''));
      await valuesApi.append(`${tab}!A1`, [row]);
      return obj;
    },

    // Patch an existing record found by idColumn=idValue. Only provided keys are
    // changed; the rest of the row is preserved. Returns the merged object, or
    // null if not found.
    async updateById(tab, idColumn, idValue, patch) {
      const { header } = await getTable(tab);
      const record = await this.findById(tab, idColumn, idValue);
      if (!record) return null;
      const merged = { ...record.obj, ...patch };
      const row = header.map((key) => (merged[key] ?? ''));
      const lastCol = colLetter(header.length);
      await valuesApi.update(`${tab}!A${record.rowNumber}:${lastCol}${record.rowNumber}`, [row]);
      return merged;
    },
  };
}

// ── Production entry point + test override ────────────────────────────────────
let _repoOverride = null;

// Test-only: inject an in-memory repo so handlers run without network/creds.
export function __setRepoForTests(repo) { _repoOverride = repo; }

// Returns the singleton repo wired to the real workbook.
export function getRepo() {
  if (_repoOverride) return _repoOverride;
  const spreadsheetId = process.env.NOVUS_SHEET_ID;
  if (!spreadsheetId) throw new Error('NOVUS_SHEET_ID is not set');
  return createRepo(realValuesApi(spreadsheetId));
}

export const _internal = { colLetter, getAuthClient, getAccessToken };
