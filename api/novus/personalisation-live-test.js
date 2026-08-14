// api/novus/personalisation-live-test.js
//
// *** TEMPORARY endpoint — for one-off live Personalisation Engine quality
// verification against the real Anthropic API. Delete once the live outputs
// have been captured and reviewed; do not leave this deployed long-term. ***
//
// Auth: identical to every other /api/novus/* route — Vercel Edge Middleware
// (middleware.js) plus requireAuth() below, both against the existing
// NOVUS_BASIC_AUTH_USER/PASS. No new auth mechanism.
//
// Runs the real, unmodified production pipeline —
//   fixed observation -> buildSalesStrategy() (lib/sales-strategy.mjs)
//                      -> generatePersonalisation() (lib/personalisation.mjs,
//                         real Anthropic call, callAi NOT overridden)
// — for four hardcoded, fixed test cases (A/C/F/H). Evidence is baked in
// server-side, not accepted from the request body: this keeps the endpoint
// from being a general-purpose "generate AI copy from arbitrary input"
// surface, which is the whole reason it's safe to expose even temporarily.
//
// GET/POST /api/novus/personalisation-live-test            -> runs all four
// GET/POST /api/novus/personalisation-live-test?case=A      -> just one
//
// ANTHROPIC_API_KEY is read only inside generatePersonalisation() (via its
// existing defaultCallAi()) exactly as in production. It is never read,
// logged, or returned by this file.

import { buildSalesStrategy } from '../../lib/sales-strategy.mjs';
import { classifyTier } from '../../lib/tier.mjs';
import { generatePersonalisation } from '../../lib/personalisation.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 60;

// Same fictional agency across all four cases, no other agency facts invented.
const AGENCY = { agency_name: 'Riverside & Co' };
// No property/probe facts supplied or invented — the evidence packet's
// `property` section will simply be empty for these test cases.
const PROBE = {};

const MIN = 1 / 60; // hours

const CASES = {
  A: {
    grade: 'A',
    observation: {
      auto_acknowledgement: false,
      first_human_touch: 'yes',
      first_human_touch_at: '2026-08-10T21:02:00.000Z',
      human_lag_hours: 2 * MIN,
      follow_up_count: 3,
      follow_up_channels: 'email,sms',
      channels_used: 'email,sms',
      last_touch_at: '2026-08-11T10:00:00.000Z',
      days_chased: 0.5,
    },
  },
  C: {
    grade: 'C',
    observation: {
      auto_acknowledgement: false,
      first_human_touch: 'yes',
      first_human_touch_at: '2026-08-10T21:02:00.000Z',
      human_lag_hours: 2 * MIN,
      follow_up_count: 0,
      follow_up_channels: '',
      channels_used: 'email',
      last_touch_at: '2026-08-10T21:02:00.000Z',
      days_chased: 0.001,
    },
  },
  F: {
    grade: 'F',
    observation: {
      auto_acknowledgement: false,
      first_human_touch: 'yes',
      first_human_touch_at: '2026-08-12T03:00:00.000Z',
      human_lag_hours: 30,
      follow_up_count: 0,
      follow_up_channels: '',
      channels_used: 'email',
      last_touch_at: '2026-08-12T03:00:00.000Z',
      days_chased: 1.25,
    },
  },
  H: {
    grade: 'H',
    observation: {
      auto_acknowledgement: false,
      auto_ack_timestamp: '',
      first_human_touch: 'no',
      first_human_touch_at: '',
      human_lag_hours: '',
      follow_up_count: 0,
      follow_up_channels: '',
      channels_used: '',
      last_touch_at: '',
      days_chased: '',
    },
  },
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAuth(req, res)) return;

  const requested = (req.query && req.query.case) || (req.body && req.body.case) || '';
  const keys = requested ? [String(requested).toUpperCase()] : Object.keys(CASES);

  const results = {};
  for (const key of keys) {
    const testCase = CASES[key];
    if (!testCase) {
      results[key] = { error: `Unknown case "${key}". Valid: ${Object.keys(CASES).join(', ')}` };
      continue;
    }

    const { grade, observation } = testCase;
    const { tier, tier_reason, segment } = classifyTier({ grade, agency: AGENCY });
    const strategy = buildSalesStrategy({ grade, tier, observation, agency: AGENCY });

    let personalisation = null;
    let error = null;
    try {
      personalisation = await generatePersonalisation({
        grade, tier, strategy, probe: PROBE, agency: AGENCY, observation,
      });
    } catch (err) {
      error = { name: err.name, message: err.message, details: err.details || undefined };
    }

    results[key] = { grade, tier, tier_reason, segment, observation, strategy, personalisation, error };
  }

  return res.status(200).json({
    _temporary_endpoint: 'api/novus/personalisation-live-test.js — delete after live verification is complete',
    agency: AGENCY,
    results,
  });
}
