// lib/twilio-access-token.mjs — short-lived Twilio Voice access tokens for
// the browser dialer, minted server-side.
//
// Pure node:crypto, no Twilio SDK — the same "no unnecessary dependency"
// posture as lib/twilio-signature.mjs. The token is the documented Twilio
// Access Token format: an HS256 JWT with cty "twilio-fpa;v=1", issued by an
// API Key (iss) on behalf of the Account (sub), carrying a Voice grant that
// names the TwiML App whose Voice URL builds the outbound <Dial>.
// https://www.twilio.com/docs/iam/access-tokens
//
// NOTHING SECRET REACHES THE BROWSER. The API key secret signs the token here
// and is never sent; the browser only ever holds the signed, expiring token.
//
// Env (all server-side):
//   TWILIO_ACCOUNT_SID      the account (existing)
//   TWILIO_API_KEY_SID      an API Key SID (SK...) created in the Console
//   TWILIO_API_KEY_SECRET   that key's secret
//   TWILIO_TWIML_APP_SID    the TwiML App (AP...) whose Voice Request URL is
//                           https://<NOVUS_PUBLIC_BASE_URL>/api/novus/webhooks/voice-outbound
//   TWILIO_CALLER_ID        the verified caller ID shown to the prospect (E.164)

import crypto from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const b64url = (input) => Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export const TWILIO_CALLING_ENV = Object.freeze([
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_TWIML_APP_SID', 'TWILIO_CALLER_ID', 'NOVUS_PUBLIC_BASE_URL',
]);

// What the browser needs to know before it asks for a token: is browser
// calling configured at all, and if not, exactly which variables are missing.
export function twilioCallingConfig(env = process.env) {
  const missing = TWILIO_CALLING_ENV.filter((key) => !text(env[key]));
  const callerId = text(env.TWILIO_CALLER_ID);
  if (callerId && !/^\+[1-9]\d{6,14}$/.test(callerId)) missing.push('TWILIO_CALLER_ID (must be E.164, e.g. +447700900123)');
  return { enabled: missing.length === 0, missing, caller_id: callerId };
}

export function createVoiceAccessToken({
  accountSid, apiKeySid, apiKeySecret, twimlAppSid, identity, ttlSeconds = 3600, nowMs = Date.now(),
}) {
  for (const [name, value] of Object.entries({ accountSid, apiKeySid, apiKeySecret, twimlAppSid, identity })) {
    if (!text(value)) throw new Error(`${name} is required to mint a Twilio access token`);
  }
  const iat = Math.floor(nowMs / 1000);
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${apiKeySid}-${iat}-${crypto.randomBytes(4).toString('hex')}`,
    iss: apiKeySid,
    sub: accountSid,
    iat,
    nbf: iat,
    exp: iat + Math.max(60, Math.min(24 * 3600, Number(ttlSeconds) || 3600)),
    grants: {
      identity: text(identity),
      voice: {
        // Outgoing only. NOVUS's inbound number is handled by voice-inbound.js
        // (voicemail capture); the browser never rings.
        outgoing: { application_sid: twimlAppSid },
        incoming: { allow: false },
      },
    },
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', String(apiKeySecret)).update(signingInput).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return { token: `${signingInput}.${signature}`, expires_at: new Date(payload.exp * 1000).toISOString(), identity: payload.grants.identity };
}

// Test helper: decode without verifying.
export function decodeJwt(token) {
  const [h, p] = String(token).split('.');
  const parse = (part) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  return { header: parse(h), payload: parse(p) };
}
