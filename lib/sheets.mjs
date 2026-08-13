// lib/sheets.mjs — the ONLY layer that communicates with Google Sheets.
//
// NOVUS rule: the browser never talks to Google Sheets directly. Every read and
// write goes: NOVUS UI → /api/novus/* (serverless) → THIS FILE → Google Sheets.
//
// Zero external dependencies: we sign a service-account JWT with Node's built-in
// crypto, exchange it for an access token, and call the Google Sheets REST API
// with fetch. That keeps the serverless functions lean and avoids pulling in the
// heavy googleapis SDK.
//
// Auth/config (server-side env vars only — never exposed to the browser):
//   GOOGLE_SERVICE_ACCOUNT_JSON  service-account key, raw JSON or base64-encoded
//   NOVUS_SHEET_ID               the spreadsheet id of NOVUS_Data_V1_Master_v2
//
// Testability: the row logic lives in createRepo(valuesApi), which depends only
// on a tiny { get, append, update } transport. Production builds the real
// transport (token + fetch); tests inject an in-memory fake with the same shape.
// __setRepoForTests() lets the API handlers run against that fake without network.

import crypto from 'node:crypto';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// ── Service-account credentials ───────────────────────────────────────────────
function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  let text = raw.trim();
  if (!text.startsWith('{')) {
    // Assume base64-encoded JSON.
    text = Buffer.from(text, 'base64').toString('utf8');
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64 JSON)');
  }
  if (!json.client_email || !json.private_key) {
    throw new Error('Service account JSON missing client_email/private_key');
  }
  // Normalise escaped newlines that survive env-var round-trips.
  json.private_key = String(json.private_key).replace(/\\n/g, '\n');
  return json;
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ── Access token (cached until shortly before expiry) ─────────────────────────
let _token = null; // { value, exp }
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token && _token.exp - 60 > now) return _token.value;

  const sa = loadServiceAccount();
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  _token = { value: data.access_token, exp: now + (data.expires_in || 3600) };
  return _token.value;
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

export const _internal = { colLetter, loadServiceAccount };
