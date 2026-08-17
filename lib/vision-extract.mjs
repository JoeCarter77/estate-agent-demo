// lib/vision-extract.mjs — screenshot → structured property fields.
//
// Reuses the EXISTING AI infrastructure this repo already has: the same
// Anthropic Messages API and the same ANTHROPIC_API_KEY that api/chat.js uses
// for the public demo, with the same model family. No new provider, no new
// account, no new key, no SDK dependency (plain fetch, like api/chat.js).
//
// Role boundary: this is PROPERTY ENRICHMENT ONLY. It reads a picture of a
// listing and reports the fields visible in it. It never sees, decides or
// guesses agency identity, probe identity, matching or grading — those stay
// deterministic (lib/agencies.mjs, lib/matching.mjs, lib/grading.mjs).
//
// Anti-hallucination posture, enforced on both sides:
//   • The prompt states, explicitly, that a field not legible in the image must
//     be returned as null — never inferred, never completed from world
//     knowledge, never guessed from the agency's other listings.
//   • Whatever comes back is re-validated here (shape, types, ranges) and any
//     non-conforming value is dropped rather than repaired.
// Joe confirms every field before a probe is created, so the AI's output is a
// draft for human confirmation — never an authority.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // same model family as api/chat.js
const TIMEOUT_MS = 25000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic per-image limit

export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const SYSTEM_PROMPT = `You extract UK property listing details from a screenshot of a property portal page (usually Rightmove).

Return ONLY a JSON object, no prose and no code fences, with exactly these keys:
{"address":null,"street":null,"postcode":null,"price":null,"bedrooms":null,"bathrooms":null,"property_type":null,"listing_status":null,"agent_branch":null,"title":null,"details":null}

Rules, all mandatory:
- Report ONLY what is legibly visible in the image. If a field is not visible, its value MUST be null.
- Never infer, complete or guess a value from general knowledge, from the look of the property, or from partially visible text.
- price: exactly as displayed, including the £ and any qualifier shown (e.g. "£450,000", "Offers over £299,950").
- bedrooms/bathrooms: integers, or null.
- property_type: as shown on the listing (e.g. "Detached", "Terraced", "Flat").
- listing_status: as shown (e.g. "For sale", "To let", "Sold STC", "Under offer"), else null.
- agent_branch: the agent/branch name shown on the listing, else null.
- postcode: only if a postcode or outcode is actually printed on the page.
- details: a short factual summary of the visible listing text, max 300 characters, else null.
- If the image is not a property listing at all, return every key as null.`;

function clampInt(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n >= 0 && n < 100 ? n : null;
}

function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'unknown') return '';
  return s.slice(0, max);
}

// Re-validates the model's JSON into the same field bag lib/rightmove-meta.mjs
// produces. Anything unexpected is dropped, never coerced into a plausible value.
export function sanitiseVisionFields(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    address: clampStr(o.address, 200),
    street: clampStr(o.street, 120),
    postcode: clampStr(o.postcode, 12).toUpperCase(),
    price: clampStr(o.price, 60),
    bedrooms: clampInt(o.bedrooms),
    bathrooms: clampInt(o.bathrooms),
    property_type: clampStr(o.property_type, 60),
    listing_status: clampStr(o.listing_status, 60),
    agent_branch: clampStr(o.agent_branch, 120),
    title: clampStr(o.title, 200),
    details: clampStr(o.details, 600),
  };
}

// Accepts either a bare base64 string or a browser clipboard data: URL
// ("data:image/png;base64,..."), which is exactly what a CTRL+V paste yields.
// Returns { ok, media_type, base64 } | { ok:false, error }.
export function parseImagePayload({ image_base64, media_type }) {
  let data = String(image_base64 || '').trim();
  let type = String(media_type || '').trim().toLowerCase();

  const dataUrl = data.match(/^data:([a-z/+.-]+);base64,(.*)$/is);
  if (dataUrl) {
    type = type || dataUrl[1].toLowerCase();
    data = dataUrl[2];
  }
  data = data.replace(/\s/g, '');

  if (!data) return { ok: false, error: 'No image data received' };
  if (!type) return { ok: false, error: 'Missing image media type' };
  if (!SUPPORTED_IMAGE_TYPES.includes(type)) {
    return { ok: false, error: `Unsupported image type "${type}". Paste a PNG, JPEG, WebP or GIF screenshot.` };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { ok: false, error: 'Image data is not valid base64' };

  const bytes = Math.floor((data.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Screenshot is too large (max 5MB). Crop it to the listing details and paste again.' };
  }
  return { ok: true, media_type: type, base64: data };
}

// Pulls the JSON object out of a model reply that may (despite instructions)
// carry a code fence or a sentence around it. Returns null if there is none.
export function parseModelJson(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

// Returns { ok: true, fields } | { ok: false, error }. Never throws.
// `callApi` is injectable so tests exercise the real sanitising/parsing logic
// without an API key or a network call.
export async function extractPropertyFromImage({ image_base64, media_type }, callApi = callAnthropic) {
  const parsed = parseImagePayload({ image_base64, media_type });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  let text;
  try {
    text = await callApi({ media_type: parsed.media_type, base64: parsed.base64 });
  } catch (err) {
    return { ok: false, error: err.message || 'Screenshot extraction failed' };
  }

  const json = parseModelJson(text);
  if (!json) return { ok: false, error: 'Could not read structured property data from that screenshot' };
  return { ok: true, fields: sanitiseVisionFields(json) };
}

async function callAnthropic({ media_type, base64 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured — screenshot extraction is unavailable');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: base64 } },
            { type: 'text', text: 'Extract the property details visible in this screenshot as JSON. Any field you cannot actually read must be null.' },
          ],
        }],
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Vision API error ${res.status}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}
