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

// ═══════════════════════════════════════════════════════════════════════════
// TEMPORARY DEV-ONLY C1 TEST FIXTURE — NOT real data, never touches Sheets.
//
// Lets anyone manually review the C1 Demo OS journey at
// /d/test-c1-fast-response without a real Google Sheets probe. Mirrors the
// exact seeded shape used by scripts/novus-demo-os-selftest.mjs (grade C,
// ~6-minute human reply, 0 genuine follow-ups) so it resolves to
// problem.key === 'fast_response_no_follow_up', same as a genuine linked
// probe would via lib/demoOs.mjs's real grade -> problem mapping.
//
// Scoped to exactly this one slug — every other slug (including the real
// Grade A agency already linked in the Sheet) takes the normal getRepo()
// path below completely unaffected. This function is the ONLY place this
// fixture lives; it is intentionally kept out of lib/demoOs.mjs so that
// module stays real-data-only.
//
// TO REMOVE: delete this block, the `if (slug === DEV_TEST_SLUG_C1)` branch
// below, the matching LEADS entry in api/_leads.mjs, and the Part D checks
// in scripts/novus-demo-os-selftest.mjs.
const DEV_TEST_SLUG_C1 = 'test-c1-fast-response';

function devFixtureProbeIntelligence() {
  const probeTimestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // "2 days ago", always fresh-looking
  const humanTouchAt = new Date(probeTimestamp.getTime() + 6 * 60 * 1000); // +6 minutes
  const probe = {
    probe_id: 'prb_dev_test_c1',
    probe_reference: 'RM-DEV-C1',
    property_address: '18 Oak Road, Demo Town',
    property_url: '',
    property_price: '£425,000',
    property_status: 'For Sale',
    probe_timestamp: probeTimestamp.toISOString(),
    probe_status: 'observing',
    enquiry_text: '',
  };
  const intelligence = {
    auto_acknowledgement: 'FALSE',
    auto_ack_timestamp: '',
    first_human_touch: 'yes',
    first_human_touch_at: humanTouchAt.toISOString(),
    human_lag_hours: String(6 / 60), // 0.1 = 6 minutes, same numbers as the self-test fixture
    follow_up_count: '0',
    follow_up_channels: '',
    last_touch_at: humanTouchAt.toISOString(),
    days_chased: '0',
    persistence_profile: 'none',
    contact_quality: 'Reactive',
    grade: 'C',
    grade_reason: 'Very fast human contact (≤1h) with 0 genuine follow-up attempts (Source Master §10).',
  };
  return { probe, intelligence };
}
// ═══════════════════════════════════════════════════════════════════════════

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
  if (slug === DEV_TEST_SLUG_C1) {
    console.warn('demo-state: serving DEV-ONLY C1 test fixture for slug=' + slug + ' (no Sheets access)');
    ({ probe, intelligence } = devFixtureProbeIntelligence());
  } else {
    try {
      const repo = getRepo();
      ({ probe, intelligence } = await getProbeIntelligenceForSlug(repo, slug));
    } catch (e) {
      // NOVUS_SHEET_ID not configured, or a transient Sheets error — fall back
      // to agency-only state rather than failing the page.
      console.error('demo-state: probe lookup failed:', e && e.message ? e.message : e);
    }
  }

  const state = buildDemoOsState({ slug, lead, probe, intelligence });
  return res.status(200).json(state);
}
