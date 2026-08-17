// api/novus/property-extract-image.js — POST /api/novus/property-extract-image
// Body: { image_base64, media_type }  (a pasted clipboard screenshot)
//
// STEP 1b: the screenshot fallback, used when the listing blocked or under-served
// the automatic read. Joe screenshots the listing, presses CTRL+V in the probe
// page, and the browser sends the clipboard image here.
//
// This is PROPERTY ENRICHMENT ONLY. It returns fields for confirmation; it never
// creates a probe, never touches Google Sheets, and never has any say over agency
// or probe identity. The confirmed fields then flow into the SAME probe-create
// path a URL-extracted property uses — there is no screenshot-probe variant, no
// separate schema and no separate storage. The image itself is not persisted.

import { extractPropertyFromImage } from '../../lib/vision-extract.mjs';
import { isSufficient } from '../../lib/rightmove-meta.mjs';
import { requireAuth } from './_auth.mjs';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};

  try {
    const result = await extractPropertyFromImage({
      image_base64: body.image_base64,
      media_type: body.media_type,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });

    const fields = result.fields;
    const anything = Object.values(fields).some((v) => v !== '' && v !== null);
    return res.status(200).json({
      fields,
      source: 'screenshot',
      sufficient: isSufficient(fields),
      empty: !anything, // nothing legible — Joe can re-paste a clearer screenshot
    });
  } catch (err) {
    console.error('property-extract-image error:', err);
    return res.status(500).json({ error: err.message || 'Screenshot extraction failed' });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
