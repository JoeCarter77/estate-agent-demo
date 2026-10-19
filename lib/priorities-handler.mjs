// lib/priorities-handler.mjs — GET ?novus_operation=priorities.
//
// READ-ONLY by construction: parallel Sheets reads, one pure build
// (lib/priorities.mjs), no writer reachable. On SETTER_OPERATIONS: Joe and
// Louis share one workspace and both see the whole operation; filtering by
// person happens in the page. Cached for 20s in-process; every write path
// that changes ACTIONS/CALLS/DISCOVERY clears it via invalidatePrioritiesCache.

import { getRepo } from './sheets.mjs';
import { buildPriorities, PRIORITY_TABS } from './priorities.mjs';
import { readRoster } from './ownership-handlers.mjs';

const CACHE_TTL_MS = 20_000;
let cache = null;
export function invalidatePrioritiesCache() { cache = null; }

async function loadTables(repo) {
  const entries = await Promise.all(PRIORITY_TABS.map(async (tab) => {
    try { return [tab, await repo.getTable(tab)]; }
    catch (err) {
      if (tab === 'ACTIONS' || tab === 'AGENCIES') throw err;
      return [tab, { header: [], rows: [], unavailable: err?.message || 'unreadable' }];
    }
  }));
  return Object.fromEntries(entries);
}

export async function handlePriorities(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  const refresh = String(req.query?.refresh || '') === '1';
  const viewer = { user_id: req.novusUser?.user_id || 'admin', role: req.novusUser?.role || 'ADMIN', display_name: req.novusUser?.display_name || '' };
  const nowMs = Date.now();
  if (!refresh && cache && nowMs - cache.at < CACHE_TTL_MS) {
    return res.status(200).json({ ...cache.payload, viewer, cached: true, cache_age_ms: nowMs - cache.at });
  }
  try {
    const repo = getRepo();
    const [tables, roster] = await Promise.all([loadTables(repo), readRoster(repo).catch(() => [])]);
    const built = buildPriorities(tables, { now: new Date().toISOString(), roster: roster.filter((u) => u.status !== 'DELETED') });
    // A tab we could not read is said out loud, never silently treated as empty.
    const warnings = PRIORITY_TABS.filter((tab) => tables[tab]?.unavailable).map((tab) => `${tab} could not be read — items that depend on it may be missing`);
    const payload = { success: true, ...built, warnings, cache_ttl_ms: CACHE_TTL_MS };
    cache = { at: Date.now(), payload };
    return res.status(200).json({ ...payload, viewer, cached: false, cache_age_ms: 0 });
  } catch (err) {
    console.error('priorities error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Could not build priorities' });
  }
}
