// lib/twilio-signature.mjs — Twilio request-signature verification.
//
// Pure crypto, no @twilio/... SDK dependency — same "no unnecessary
// dependency" posture as the rest of this repo (keyless Sheets auth, no
// service-account keys). Implements Twilio's documented X-Twilio-Signature
// algorithm: base64(HMAC-SHA1(authToken, url + sorted-concatenated-params)).
// https://www.twilio.com/docs/usage/security#validating-requests
//
// This is the ONLY authentication for the voice/SMS webhooks — there is no
// human password on /api/novus/webhooks/* (middleware.js excludes it) and no
// shared ingest secret like the email webhook uses, because Twilio signs
// every request with TWILIO_AUTH_TOKEN instead.

import crypto from 'node:crypto';

export function computeTwilioSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + String(params[key] ?? ''), url);
  return crypto.createHmac('sha1', String(authToken)).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function verifyTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
