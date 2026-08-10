// api/lead.js - Vercel Serverless Function
// GET /api/lead?slug=ashton-white-dxfw
//
// Stable prospect fields (company/url/town/first_name) come from the committed
// api/_leads.mjs. Probe data is pulled LIVE from a Google Sheet per request and
// returned as a single pre-formatted `probe_line` (or omitted when there's no
// usable probe data). Response is not cached, so editing the sheet is reflected
// on the next page load without a redeploy.
import { LEADS } from './_leads.mjs';
import { getProbeData } from '../lib/probes.mjs';
import { buildProbeLine } from '../lib/probeCopy.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const slug = (req.query.slug || '').toString().trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const rec = LEADS[slug];
  if (!rec) return res.status(404).json({ error: 'Not found' });

  // Live probe lookup - null when the sheet isn't configured or has no usable row.
  const probe = await getProbeData(slug);
  const probeLine = buildProbeLine(probe);

  const out = {
    company:    rec.company || '',
    url:        rec.url || '',
    town:       rec.town || '',
    first_name: rec.first_name || ''
  };
  if (probeLine) out.probe_line = probeLine;

  return res.status(200).json(out);
}
