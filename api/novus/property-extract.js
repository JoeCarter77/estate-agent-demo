// api/novus/property-extract.js — POST /api/novus/property-extract
// Body: { url }
//
// STEP 1 of probe creation: try to read the listing automatically. This endpoint
// creates NOTHING — it only reports what could be extracted, so the UI can show
// the fields for confirmation (sufficient=true) or drop straight into the
// CTRL+V screenshot fallback (sufficient=false).
//
// Automatic extraction is deliberately NOT a dependency of probe creation:
// a failure here is a 200 with sufficient=false, never an error that blocks Joe.

import { fetchListingFields, isSufficient } from '../../lib/rightmove-meta.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const url = String(body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!/^https?:\/\/|^www\./i.test(url) && !url.includes('.')) {
    return res.status(400).json({ error: 'That does not look like a valid URL' });
  }

  try {
    const result = await fetchListingFields(url);
    const { _source: source, _blocked: blocked, ...fields } = result;
    const sufficient = isSufficient(fields);
    return res.status(200).json({
      fields,
      source,               // 'fetch' | 'brightdata' | 'none'
      blocked,              // listing refused/timed out the automatic read
      sufficient,           // enough to confirm without a screenshot
      fallback: sufficient ? null : 'screenshot',
    });
  } catch (err) {
    // Extraction must never hard-fail the flow — degrade to the screenshot path.
    console.error('property-extract error:', err);
    return res.status(200).json({
      fields: {}, source: 'none', blocked: true, sufficient: false, fallback: 'screenshot',
    });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
