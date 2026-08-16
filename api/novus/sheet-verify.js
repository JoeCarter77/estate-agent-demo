// api/novus/sheet-verify.js — GET /api/novus/sheet-verify
//
// Read-only diagnostic to confirm the app is reading the connected master
// Google Sheet (NOVUS_SHEET_ID) correctly: counts + a sample of existing ids
// for AGENCIES, PROBES and COMMUNICATIONS, straight through the same
// getRepo()/getRecords() path every other NOVUS route uses.
//
// Deliberately scoped to identity + communications data only — does not read
// or touch INTELLIGENCE, GRADING, TIERS or ACTIONS. No writes of any kind.

import { getRepo } from '../../lib/sheets.mjs';
import { requireAuth } from './_auth.mjs';

async function summarizeTab(repo, tab, idColumn) {
  const { header } = await repo.getTable(tab);
  const records = await repo.getRecords(tab, idColumn);
  return {
    tab,
    idColumn,
    header,
    count: records.length,
    sampleIds: records.slice(0, 5).map((r) => r.obj[idColumn]),
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const repo = getRepo();

    const [agencies, probes, communications] = await Promise.all([
      summarizeTab(repo, 'AGENCIES', 'agency_id'),
      summarizeTab(repo, 'PROBES', 'probe_id'),
      summarizeTab(repo, 'COMMUNICATIONS', 'communication_id'),
    ]);

    return res.status(200).json({
      spreadsheetId: process.env.NOVUS_SHEET_ID || null,
      agencies,
      probes,
      communications,
    });
  } catch (err) {
    console.error('sheet-verify error:', err);
    return res.status(500).json({ error: err.message || 'Failed to verify sheet data' });
  }
}
