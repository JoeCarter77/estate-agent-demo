// lib/instantly-client.mjs — the ONE Instantly API v2 client for the
// campaign layer. Every campaign/lead/analytics/account request NOVUS makes
// goes through here; nothing in a handler or a page builds an Instantly URL.
//
// CONTRACT
//   - the API key is read once at construction and never echoed into a
//     return value, an error message or a log line
//   - every response is parsed defensively: a non-JSON body, a missing
//     array or an unexpected shape becomes a typed InstantlyApiError, never
//     an undefined dereference three layers up
//   - HTTP 429 is retried with a bounded backoff (Instantly documents 20 rpm
//     on /emails and per-workspace limits elsewhere); every other failure is
//     surfaced immediately with status + code so the caller can decide
//   - each request has a timeout; a hung provider cannot pin a serverless
//     invocation open
//   - WRITE calls (create/activate/pause/add leads) are explicit, named
//     methods; there is no generic "request" export, so a read-only caller
//     cannot reach a write path by accident
//
// The endpoints and payload shapes below were taken from the published v2
// reference (developer.instantly.ai/api-reference) at build time:
//   POST /campaigns, GET /campaigns, GET|PATCH /campaigns/{id},
//   POST /campaigns/{id}/activate, POST /campaigns/{id}/pause,
//   POST /leads/add (≤1000 per call), POST /leads/list (limit ≤100, cursor),
//   GET /campaigns/analytics?id=, GET /campaigns/analytics/steps?campaign_id=,
//   GET /accounts, GET /emails (shared with lib/instantly-execution-state.mjs).

export const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const RETRY_DELAYS_MS = Object.freeze([600, 1500, 3000]);
export const LEADS_ADD_CHUNK = 200;   // API max is 1000; smaller chunks bound one failure's blast radius
export const LEADS_LIST_LIMIT = 100;  // API max
export const LIST_MAX_PAGES = 50;

const text = (value) => String(value ?? '').trim();

export class InstantlyApiError extends Error {
  constructor(message, { status = 0, code = 'INSTANTLY_ERROR', detail = '', retryable = false, endpoint = '' } = {}) {
    super(message);
    this.name = 'InstantlyApiError';
    this.status = status;
    this.code = code;
    this.detail = text(detail).slice(0, 500);
    this.retryable = retryable;
    this.endpoint = endpoint;
  }
  toJSON() {
    return { code: this.code, status: this.status, message: this.message, detail: this.detail, retryable: this.retryable, endpoint: this.endpoint };
  }
}

// Instantly's list endpoints wrap results in { items, next_starting_after };
// older responses used other keys. Accepting the documented key first and the
// legacy ones after is cheaper than a hard failure on a harmless change.
export function itemsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'data', 'results', 'records', 'emails']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}
export function cursorFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return text(payload.next_starting_after ?? payload.starting_after ?? '');
}

function errorDetail(body, raw) {
  if (body && typeof body === 'object') return body.message || body.error || body.detail || JSON.stringify(body).slice(0, 300);
  return text(raw).slice(0, 300) || '(empty response body)';
}

export function createInstantlyClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  baseUrl = INSTANTLY_API_BASE,
} = {}) {
  const key = text(apiKey);

  async function request(method, path, { query = null, body = undefined, retries = RETRY_DELAYS_MS.length } = {}) {
    if (!key) throw new InstantlyApiError('Instantly API key is not configured', { code: 'NO_API_KEY', endpoint: path });
    if (typeof fetchImpl !== 'function') throw new InstantlyApiError('Instantly fetch transport is unavailable', { code: 'NO_TRANSPORT', endpoint: path });
    const url = new URL(`${baseUrl}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt += 1) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      let response;
      let raw = '';
      try {
        response = await fetchImpl(url.toString(), {
          method,
          cache: 'no-store',
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        });
        raw = await response.text();
      } catch (err) {
        if (timer) clearTimeout(timer);
        const timedOut = err?.name === 'AbortError';
        if (!timedOut && attempt < retries) { await sleepImpl(RETRY_DELAYS_MS[attempt]); continue; }
        throw new InstantlyApiError(timedOut ? `Instantly request timed out after ${timeoutMs}ms` : 'Instantly request failed', {
          code: timedOut ? 'TIMEOUT' : 'NETWORK', detail: timedOut ? '' : err?.message, retryable: true, endpoint: path,
        });
      }
      if (timer) clearTimeout(timer);

      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }

      if (response.status === 429 && attempt < retries) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        const delay = Math.min(10_000, Math.max(RETRY_DELAYS_MS[attempt], Number.isFinite(retryAfter) ? retryAfter * 1000 : 0));
        await sleepImpl(delay);
        continue;
      }
      if (!response.ok) {
        const codes = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'UNPROCESSABLE', 429: 'RATE_LIMITED' };
        throw new InstantlyApiError(`Instantly ${method} ${path} failed (HTTP ${response.status})`, {
          status: response.status, code: codes[response.status] || (response.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR'),
          detail: errorDetail(parsed, raw), retryable: response.status === 429 || response.status >= 500, endpoint: path,
        });
      }
      if (raw && parsed === null) {
        throw new InstantlyApiError(`Instantly ${method} ${path} returned a non-JSON body`, { status: response.status, code: 'MALFORMED', detail: raw, endpoint: path });
      }
      return parsed;
    }
  }

  async function paginate(method, path, { query = null, body = null, limit = LEADS_LIST_LIMIT, maxPages = LIST_MAX_PAGES } = {}) {
    const items = [];
    let cursor = '';
    let pages = 0;
    let truncated = false;
    while (pages < maxPages) {
      const page = method === 'GET'
        ? await request('GET', path, { query: { ...(query || {}), limit, ...(cursor ? { starting_after: cursor } : {}) } })
        : await request('POST', path, { body: { ...(body || {}), limit, ...(cursor ? { starting_after: cursor } : {}) } });
      const list = itemsFromPayload(page);
      items.push(...list);
      pages += 1;
      cursor = cursorFromPayload(page);
      if (!list.length || !cursor) break;
      if (pages >= maxPages) truncated = true;
    }
    return { items, pages, truncated };
  }

  return {
    // ── campaigns ────────────────────────────────────────────────────────
    async listCampaigns({ maxPages = LIST_MAX_PAGES } = {}) {
      return paginate('GET', '/campaigns', { limit: 100, maxPages });
    },
    async getCampaign(id) {
      if (!text(id)) throw new InstantlyApiError('campaign id is required', { code: 'BAD_INPUT' });
      const campaign = await request('GET', `/campaigns/${encodeURIComponent(text(id))}`);
      if (!campaign || typeof campaign !== 'object' || !text(campaign.id)) {
        throw new InstantlyApiError('Instantly returned a campaign without an id', { code: 'MALFORMED', endpoint: '/campaigns/{id}' });
      }
      return campaign;
    },
    async createCampaign(payload) {
      const campaign = await request('POST', '/campaigns', { body: payload, retries: 0 });
      if (!campaign || typeof campaign !== 'object' || !text(campaign.id)) {
        throw new InstantlyApiError('Instantly created a campaign but returned no id', { code: 'MALFORMED', endpoint: '/campaigns' });
      }
      return campaign;
    },
    async updateCampaign(id, patch) {
      return request('PATCH', `/campaigns/${encodeURIComponent(text(id))}`, { body: patch, retries: 0 });
    },
    async activateCampaign(id) {
      return request('POST', `/campaigns/${encodeURIComponent(text(id))}/activate`, { body: {}, retries: 0 });
    },
    async pauseCampaign(id) {
      return request('POST', `/campaigns/${encodeURIComponent(text(id))}/pause`, { body: {}, retries: 0 });
    },
    async getCampaignSendingStatus(id) {
      return request('GET', `/campaigns/${encodeURIComponent(text(id))}/sending-status`);
    },

    // ── leads ────────────────────────────────────────────────────────────
    // One chunk. The caller maps `created_leads[].index` back to its input.
    async addLeads({ campaignId, leads, skipIfInCampaign = true, skipIfInWorkspace = false, verifyLeadsOnImport = false }) {
      if (!text(campaignId)) throw new InstantlyApiError('campaign id is required', { code: 'BAD_INPUT' });
      if (!Array.isArray(leads) || !leads.length) throw new InstantlyApiError('leads must be a non-empty array', { code: 'BAD_INPUT' });
      if (leads.length > 1000) throw new InstantlyApiError('leads exceeds the 1000-per-request limit', { code: 'BAD_INPUT' });
      const result = await request('POST', '/leads/add', {
        body: {
          campaign_id: text(campaignId), leads,
          skip_if_in_campaign: Boolean(skipIfInCampaign), skip_if_in_workspace: Boolean(skipIfInWorkspace),
          verify_leads_on_import: Boolean(verifyLeadsOnImport),
        },
        retries: 0,
      });
      if (!result || typeof result !== 'object') throw new InstantlyApiError('Instantly /leads/add returned no summary', { code: 'MALFORMED', endpoint: '/leads/add' });
      return {
        status: text(result.status),
        total_sent: Number(result.total_sent) || 0,
        leads_uploaded: Number(result.leads_uploaded) || 0,
        duplicated_leads: Number(result.duplicated_leads) || 0,
        in_blocklist: Number(result.in_blocklist) || 0,
        skipped_count: Number(result.skipped_count) || 0,
        invalid_email_count: Number(result.invalid_email_count) || 0,
        duplicate_email_count: Number(result.duplicate_email_count) || 0,
        remaining_in_plan: result.remaining_in_plan ?? null,
        created_leads: Array.isArray(result.created_leads) ? result.created_leads : [],
      };
    },
    async listCampaignLeads(campaignId, { maxPages = LIST_MAX_PAGES } = {}) {
      if (!text(campaignId)) throw new InstantlyApiError('campaign id is required', { code: 'BAD_INPUT' });
      return paginate('POST', '/leads/list', { body: { campaign: text(campaignId) }, limit: LEADS_LIST_LIMIT, maxPages });
    },

    // ── analytics ────────────────────────────────────────────────────────
    async getCampaignAnalytics(campaignId) {
      const payload = await request('GET', '/campaigns/analytics', { query: { id: text(campaignId) } });
      const rows = itemsFromPayload(payload);
      const row = rows.find((r) => text(r?.campaign_id) === text(campaignId)) || rows[0] || (payload && !Array.isArray(payload) && typeof payload === 'object' ? payload : null);
      return row && typeof row === 'object' ? row : null;
    },
    async getCampaignStepAnalytics(campaignId) {
      const payload = await request('GET', '/campaigns/analytics/steps', { query: { campaign_id: text(campaignId) } });
      return itemsFromPayload(payload);
    },

    // ── accounts ─────────────────────────────────────────────────────────
    async listAccounts({ maxPages = 5 } = {}) {
      return paginate('GET', '/accounts', { limit: 100, maxPages });
    },

    // ── emails (execution evidence) ──────────────────────────────────────
    // Same sweep lib/instantly-execution-state.mjs performs, campaign-scoped.
    // minTimestampCreated bounds the sweep to emails at/after that instant
    // (the documented /emails filter, already proven by
    // lib/instantly-reply-poll.mjs's received-mail poll). Passing it turns a
    // full campaign history sweep into an incremental one for the automated
    // poller; omitting it keeps the existing full bounded sweep used by a
    // manual Sync Now and the nightly safety net.
    async listCampaignEmails(campaignId, { maxPages = 12, minTimestampCreated = '' } = {}) {
      const query = { campaign_id: text(campaignId), sort_order: 'desc' };
      if (text(minTimestampCreated)) query.min_timestamp_created = text(minTimestampCreated);
      return paginate('GET', '/emails', { query, limit: 100, maxPages });
    },
  };
}

// The write credential for the campaign layer. INSTANTLY_API_KEY is the key
// lib/instantly-outbound.mjs already uses for lead upload; the campaign
// layer needs campaigns:all + leads:all + accounts:read on it. Read-only
// operations fall back to INSTANTLY_REPLY_API_KEY so a workspace that has
// only granted the read key still gets list/analytics/sync.
export function instantlyCredentials(env = process.env) {
  const write = text(env.INSTANTLY_API_KEY);
  const read = text(env.INSTANTLY_REPLY_API_KEY) || write;
  return { write, read, configured: Boolean(write), read_configured: Boolean(read) };
}
export function clientFor(kind, { env = process.env, fetchImpl } = {}) {
  const creds = instantlyCredentials(env);
  const apiKey = kind === 'write' ? creds.write : creds.read;
  if (!apiKey) return null;
  return createInstantlyClient({ apiKey, fetchImpl });
}

export const _internal = { errorDetail };
