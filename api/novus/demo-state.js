// api/novus/demo-state.js — Vercel Serverless Function
// GET /api/novus/demo-state?slug=ashton-white-dxfw
//
// Public, customer-facing endpoint (same trust level as /api/lead — no
// NOVUS_BASIC_AUTH here; that guard is only for the internal /novus/* ops
// tools and their write endpoints). Returns the Demo OS state contract
// (lib/demoOs.mjs): agency + property + probe + evidence + grade + problem +
// journey. Read-only — never triggers a recompute, never writes to Sheets.
//
// Never 500s for "no data yet" — a missing/unlinked probe, an unconfigured
// NOVUS_SHEET_ID, or a Sheets outage all resolve to the same safe
// agency-only state (probe/evidence/grade/problem = null) so the page never
// breaks. A 404 is reserved for an unknown agency slug.
import { LEADS } from '../_leads.mjs';
import { getRepo } from '../../lib/sheets.mjs';
import { getProbeIntelligenceForSlug, buildDemoOsState } from '../../lib/demoOs.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const slug = (req.query.slug || '').toString().trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const lead = LEADS[slug];
  if (!lead) return res.status(404).json({ error: 'Not found' });

  let probe = null;
  let intelligence = null;
  try {
    const repo = getRepo();
    ({ probe, intelligence } = await getProbeIntelligenceForSlug(repo, slug));
  } catch (e) {
    // NOVUS_SHEET_ID not configured, or a transient Sheets error — fall back
    // to agency-only state rather than failing the page.
    console.error('demo-state: probe lookup failed:', e && e.message ? e.message : e);
  }

  const state = buildDemoOsState({ slug, lead, probe, intelligence });
  return res.status(200).json(state);
}
