// api/novus/demo-state.js — Vercel Serverless Function
// GET /api/novus/demo-state?slug=ashton-white-dxfw
//
// Public, customer-facing endpoint (same trust level as /api/lead — no
// NOVUS_BASIC_AUTH here; that guard is only for the internal /novus/* ops
// tools and their write endpoints). Returns the Demo OS state contract
// (lib/demoOs.mjs): agency + property + probe + evidence + grade + problem +
// acknowledgement + timeline + journeyVariant. Read-only — never triggers a
// recompute, never writes to Sheets.
//
// Never 500s for "no data yet" — a missing/unlinked probe, an unconfigured
// NOVUS_SHEET_ID, or a Sheets outage all resolve to the same safe
// agency-only state (probe/evidence/grade/problem = null) so the page never
// breaks. A 404 is reserved for an unknown agency slug.
import { LEADS } from '../_leads.mjs';
import { getRepo } from '../../lib/sheets.mjs';
import { getProbeIntelligenceForSlug, buildDemoOsState } from '../../lib/demoOs.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// TEMPORARY DEV-ONLY TEST FIXTURES — NOT real data, never touch Sheets.
//
// Let anyone manually review the two C/G seller-ask journey branches without
// a real Google Sheets probe:
//   /d/test-c1-fast-response — grade C, auto-ack DOES ask the seller
//                              question -> journeyVariant C_G_SELLER_ASK
//   /d/test-g-no-ask         — grade G, auto-ack exists but does NOT ask it
//                              -> journeyVariant C_G_SELLER_NO_ASK
// Both are clearly-labelled dev-only fixtures (agency.company says so), not a
// claim about any real agency's actual auto-reply wording. Scoped to exactly
// these two slugs — every other slug takes the normal getRepo() path below,
// completely unaffected. TO REMOVE: delete this block, the two branches in
// the handler below, the matching LEADS entries in api/_leads.mjs, and the
// dev-fixture checks in scripts/novus-demo-os-selftest.mjs.
const DEV_TEST_SLUG_C_ASK = 'test-c1-fast-response';
const DEV_TEST_SLUG_G_NO_ASK = 'test-g-no-ask';

// Fixed, not relative-to-now: a dev fixture that silently changes its
// "received" timestamp on every request isn't actually deterministic, even
// though the numbers that matter (grade/lag/follow-ups/seller-ask) were
// already fixed.
function devFixtureCAsk() {
  const probeTimestamp = new Date('2026-08-12T09:14:00.000Z'); // Monday
  const ackAt = probeTimestamp; // instant auto-reply
  const humanTouchAt = new Date(probeTimestamp.getTime() + 6 * 60 * 1000); // +6 minutes
  const probe = {
    probe_id: 'prb_dev_test_c_ask',
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
    auto_acknowledgement: 'TRUE',
    auto_ack_timestamp: ackAt.toISOString(),
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
  const communications = [{
    communication_id: 'com_dev_test_c_ask_1',
    probe_id: probe.probe_id,
    occurred_at: ackAt.toISOString(),
    channel: 'email',
    communication_classification: 'auto_acknowledgement',
    subject: 'Thanks for your enquiry',
    body_text: 'Thanks for your enquiry, one of our team will be in touch shortly. In the meantime, do you have a property you’d like to sell?',
  }];
  return { probe, intelligence, communications };
}

function devFixtureGNoAsk() {
  const probeTimestamp = new Date('2026-08-10T21:04:00.000Z'); // 21:04, out of hours
  const ackAt = probeTimestamp;
  const probe = {
    probe_id: 'prb_dev_test_g_no_ask',
    probe_reference: 'RM-DEV-G1',
    property_address: '4 Mill Lane, Demo Town',
    property_url: '',
    property_price: '£310,000',
    property_status: 'For Sale',
    probe_timestamp: probeTimestamp.toISOString(),
    probe_status: 'observing',
    enquiry_text: '',
  };
  const intelligence = {
    auto_acknowledgement: 'TRUE',
    auto_ack_timestamp: ackAt.toISOString(),
    first_human_touch: 'no',
    first_human_touch_at: '',
    human_lag_hours: '',
    follow_up_count: '0',
    follow_up_channels: '',
    last_touch_at: ackAt.toISOString(),
    days_chased: '0',
    persistence_profile: 'none',
    contact_quality: 'Generic acknowledgement',
    grade: 'G',
    grade_reason: 'Automated acknowledgement only; no human contact observed (Source Master §10).',
  };
  const communications = [{
    communication_id: 'com_dev_test_g_no_ask_1',
    probe_id: probe.probe_id,
    occurred_at: ackAt.toISOString(),
    channel: 'email',
    communication_classification: 'auto_acknowledgement',
    subject: 'We have received your enquiry',
    body_text: 'We have received your enquiry and a member of our team will be in touch shortly.',
  }];
  return { probe, intelligence, communications };
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
  let communications = [];
  if (slug === DEV_TEST_SLUG_C_ASK) {
    console.warn('demo-state: serving DEV-ONLY C-ask test fixture for slug=' + slug + ' (no Sheets access)');
    ({ probe, intelligence, communications } = devFixtureCAsk());
  } else if (slug === DEV_TEST_SLUG_G_NO_ASK) {
    console.warn('demo-state: serving DEV-ONLY G-no-ask test fixture for slug=' + slug + ' (no Sheets access)');
    ({ probe, intelligence, communications } = devFixtureGNoAsk());
  } else {
    try {
      const repo = getRepo();
      ({ probe, intelligence, communications } = await getProbeIntelligenceForSlug(repo, slug));
    } catch (e) {
      // NOVUS_SHEET_ID not configured, or a transient Sheets error — fall back
      // to agency-only state rather than failing the page.
      console.error('demo-state: probe lookup failed:', e && e.message ? e.message : e);
    }
  }

  const state = buildDemoOsState({ slug, lead, probe, intelligence, communications });
  return res.status(200).json(state);
}
