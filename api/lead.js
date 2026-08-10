// api/lead.js — Vercel Serverless Function
// GET /api/lead?slug=ashton-white-dxfw
// Returns ONLY the page-facing merge fields for a slug. Phone and outreach-tracking
// columns are never returned — they stay inside api/_leads.mjs, which Vercel does not
// serve statically.
import { LEADS } from './_leads.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const slug = (req.query.slug || '').toString().trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const rec = LEADS[slug];
  if (!rec) return res.status(404).json({ error: 'Not found' });

  return res.status(200).json({
    company:       rec.company || '',
    url:           rec.url || '',
    town:          rec.town || '',
    first_name:    rec.first_name || '',
    probe_address: rec.probe_address || '',
    probe_sent:    rec.probe_sent || ''
  });
}
