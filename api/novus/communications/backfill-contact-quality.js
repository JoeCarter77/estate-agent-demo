// api/novus/communications/backfill-contact-quality.js
// POST /api/novus/communications/backfill-contact-quality
//
// One-time (idempotent, safe to re-run) historical backfill: applies the
// same 'proactive_booking_push' detector lib/classification.mjs now runs on
// every new communication to the COMMUNICATIONS rows that already exist.
// See lib/communications-backfill.mjs for exactly what it does and does not
// touch — it writes ONLY contact_quality; automated_or_human, human_contact,
// communication_classification, booking_attempt, intent, and every
// INTELLIGENCE/DIAGNOSIS field (including the A-H grade) are untouched.
//
// Same NOVUS_BASIC_AUTH guard as the rest of /api/novus/*. No body required.

import { getRepo } from '../../../lib/sheets.mjs';
import { backfillContactQuality } from '../../../lib/communications-backfill.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const repo = getRepo();
    const summary = await backfillContactQuality(repo);
    return res.status(200).json(summary);
  } catch (err) {
    console.error('backfill-contact-quality error:', err);
    return res.status(500).json({ error: err.message || 'Failed to backfill contact_quality' });
  }
}
