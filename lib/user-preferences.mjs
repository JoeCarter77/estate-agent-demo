// lib/user-preferences.mjs — each person's own working preferences, kept
// apart from shared company data. Joe and Louis share one workspace (agencies,
// contacts, script library, templates) but choose their own scripts, queue
// filter and email signature without changing each other's.
//
// STORAGE. One small JSON record per user in the session store (Redis,
// lib/kv.mjs): `novus:prefs:<user_id>`, no TTL. Not a Sheets tab — these are
// read on every Calling Mode load, and Sheets read quota is exactly what used
// to sign Louis out. Losing them would only revert someone to the company
// defaults; nothing commercial lives here.
//
// ALLOWLIST. Only the keys in PREFERENCE_FIELDS are stored, each validated;
// anything else in a request is ignored. Add a preference here deliberately.
//
//   GET  my-preferences        → { preferences, defaults }
//   POST my-preferences-save   confirm=SAVE_PREFERENCES, preferences:{…}
//        (a key set to '' clears it back to the company default)

import { kvStore } from './kv.mjs';

const text = (value) => String(value ?? '').trim();
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');

export const prefsKey = (userId) => `novus:prefs:${text(userId)}`;

const id = (max = 80) => (v) => (/^[A-Za-z0-9_.:-]*$/.test(text(v)) ? text(v).slice(0, max) : null);
export const PREFERENCE_FIELDS = Object.freeze({
  // A SCRIPTS script_id of the matching kind, or '' = company default.
  main_script_id: id(),
  gatekeeper_script_id: id(),
  // Default owner filter for the calling queue.
  queue_owner_filter: (v) => (['', 'all', 'mine', 'unassigned'].includes(text(v)) ? text(v) : null),
  // Appended to emails sent from your own inbox (plain text).
  email_signature: (v) => String(v ?? '').replace(/\r\n/g, '\n').slice(0, 2000),
});

export function sanitisePreferences(input) {
  const out = {};
  for (const [key, check] of Object.entries(PREFERENCE_FIELDS)) {
    if (!(key in (input || {}))) continue;
    const value = check(input[key]);
    if (value === null) return { error: `Invalid value for ${key}` };
    out[key] = value;
  }
  return { value: out };
}

export async function readPreferences(userId, { kv = null } = {}) {
  if (!text(userId)) return {};
  const raw = await (kv || kvStore()).command(['GET', prefsKey(userId)]);
  try { const parsed = JSON.parse(raw || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

// Never throws: a page still works on company defaults if Redis is down.
export async function readPreferencesSafe(userId, opts) {
  try { return { preferences: await readPreferences(userId, opts), available: true }; }
  catch { return { preferences: {}, available: false }; }
}

export async function savePreferences(userId, patch, { kv = null, nowIso = new Date().toISOString() } = {}) {
  const store = kv || kvStore();
  const current = await readPreferences(userId, { kv: store });
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === '') delete next[key]; else next[key] = value;
  }
  next.updated_at = nowIso;
  await store.command(['SET', prefsKey(userId), JSON.stringify(next)]);
  return next;
}

export async function handleMyPreferences(req, res) {
  noStore(res);
  const userId = req.novusUser?.user_id;
  if (!userId) return res.status(401).json({ success: false, error: 'Sign in first' });
  const { preferences, available } = await readPreferencesSafe(userId);
  return res.status(200).json({ success: true, user_id: userId, preferences, available, fields: Object.keys(PREFERENCE_FIELDS) });
}

export async function handleMyPreferencesSave(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SAVE_PREFERENCES') return res.status(400).json({ success: false, error: 'Missing confirm=SAVE_PREFERENCES' });
  const userId = req.novusUser?.user_id;
  if (!userId) return res.status(401).json({ success: false, error: 'Sign in first' });
  const { value, error } = sanitisePreferences(req.body?.preferences);
  if (error) return res.status(400).json({ success: false, error });
  if (!Object.keys(value).length) return res.status(400).json({ success: false, error: 'Nothing to save' });
  try {
    const preferences = await savePreferences(userId, value);
    return res.status(200).json({ success: true, user_id: userId, preferences });
  } catch {
    return res.status(503).json({ success: false, retryable: true, error: 'Your preferences could not be saved just now. Try again in a moment.' });
  }
}
