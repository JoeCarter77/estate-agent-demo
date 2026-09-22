// worker/src/config.mjs — every tunable in one place.
//
// The worker is a LOCAL process. It holds no probe data of its own: NOVUS
// (Google Sheets, via the existing /api/novus/probe route) stays authoritative
// for probes, agencies and probe_sent. Everything here is operational state —
// where the browser is, what it is allowed to do, and how to reach NOVUS.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(WORKER_ROOT, '..');

// .env / .env.local live at the repo root and already carry NOVUS_BASE_URL and
// the Basic Auth pair. Reuse them rather than inventing a second config file.
export function loadRepoEnv() {
  if (typeof process.loadEnvFile !== 'function') return;
  for (const file of ['.env.local', '.env']) {
    try { process.loadEnvFile(path.join(REPO_ROOT, file)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function loadConfig(env = process.env) {
  const base = String(env.NOVUS_BASE_URL || '').replace(/\/+$/, '');
  return {
    novusBaseUrl: base,
    basicAuthUser: env.NOVUS_BASIC_AUTH_USER || '',
    basicAuthPass: env.NOVUS_BASIC_AUTH_PASS || '',

    // The control server the NOVUS Prober panel talks to. Loopback only.
    controlHost: '127.0.0.1',
    controlPort: Number(env.NOVUS_OPERATOR_PORT || 8787),
    controlToken: env.NOVUS_OPERATOR_TOKEN || '',
    // Browser origins allowed to drive the control server. The deployed NOVUS
    // origin plus local preview. Anything else is refused outright.
    allowedOrigins: [base, 'http://127.0.0.1:4311', 'http://localhost:4311'].filter(Boolean),

    // Persistent Chromium profile: the approved Rightmove identity, cookies and
    // the accepted cookie choice live here, so the enquiry form arrives
    // pre-filled exactly as it does for a human.
    profileDir: env.NOVUS_OPERATOR_PROFILE || path.join(WORKER_ROOT, '.state', 'chrome-profile'),
    statePath: env.NOVUS_OPERATOR_STATE || path.join(WORKER_ROOT, '.state', 'operator-state.json'),
    evidenceDir: env.NOVUS_OPERATOR_EVIDENCE || path.join(WORKER_ROOT, '.state', 'evidence'),
    headless: bool(env.NOVUS_OPERATOR_HEADLESS, false),
    channel: env.NOVUS_OPERATOR_CHANNEL || 'chrome',

    // THE APPROVED ENQUIRY IDENTITY. These are verified against the form, never
    // invented. probe_email / probe_phone are the same values the existing
    // probe-create endpoint stamps onto the PROBES row, so a mismatch means the
    // browser is enquiring as somebody other than the probe — a hard stop.
    identity: {
      firstName: env.NOVUS_PROBE_FIRST_NAME || '',
      lastName: env.NOVUS_PROBE_LAST_NAME || '',
      email: env.NOVUS_PROBE_EMAIL || '',
      phone: env.NOVUS_PROBE_PHONE || '',
      postcode: env.NOVUS_PROBE_POSTCODE || '',
    },

    // Defaults for the run controls; the panel overrides them per run.
    defaultBatchSize: Number(env.NOVUS_OPERATOR_BATCH || 5),
    dailyProbeLimit: Number(env.NOVUS_OPERATOR_DAILY_LIMIT || 25),

    // Live submission is OFF unless explicitly enabled. Everything else — queue
    // advance, property selection, form verification, create probe, mark as
    // sent — still runs; only the Rightmove "Send email" click is withheld.
    // This is the switch behind "only after I explicitly authorise".
    liveSubmit: bool(env.NOVUS_OPERATOR_LIVE_SUBMIT, false),
    // When live submission is off, restrict the run to these agency ids.
    // Empty = the whole queue (dry runs only).
    allowedAgencyIds: String(env.NOVUS_OPERATOR_ALLOWED_AGENCIES || '')
      .split(',').map((s) => s.trim()).filter(Boolean),

    // PACING. A pause between one confirmed enquiry and the next agency, so a
    // batch arrives at a human rhythm rather than as a burst. It is a delay and
    // nothing more: it does not retry, does not touch verification, and is not
    // a way around anything. Each wait is a fresh random value in the range.
    cooldown: {
      minSeconds: Math.max(0, Number(env.NOVUS_OPERATOR_COOLDOWN_MIN_SECONDS ?? 30)),
      maxSeconds: Math.max(0, Number(env.NOVUS_OPERATOR_COOLDOWN_MAX_SECONDS ?? 60)),
    },
    actionDelayMs: Math.max(0, Number(env.NOVUS_OPERATOR_ACTION_DELAY_MS ?? 750)),

    aiModel: env.NOVUS_OPERATOR_AI_MODEL || 'claude-sonnet-5',
    aiEnabled: bool(env.NOVUS_OPERATOR_AI, true),

    timeouts: {
      nav: Number(env.NOVUS_OPERATOR_NAV_TIMEOUT || 45000),
      control: Number(env.NOVUS_OPERATOR_CTRL_TIMEOUT || 20000),
      submitResult: Number(env.NOVUS_OPERATOR_SUBMIT_TIMEOUT || 40000),
    },
  };
}

// A single wait, in milliseconds. Exported so the pacing rule can be tested
// without waiting for it.
export function cooldownMs(config, random = Math.random) {
  const min = Math.min(config.cooldown.minSeconds, config.cooldown.maxSeconds);
  const max = Math.max(config.cooldown.minSeconds, config.cooldown.maxSeconds);
  if (max <= 0) return 0;
  return Math.round((min + random() * (max - min)) * 1000);
}

export function assertConfig(config) {
  const missing = [];
  if (!config.novusBaseUrl) missing.push('NOVUS_BASE_URL');
  if (!config.basicAuthUser) missing.push('NOVUS_BASIC_AUTH_USER');
  if (!config.basicAuthPass) missing.push('NOVUS_BASIC_AUTH_PASS');
  if (!config.controlToken) missing.push('NOVUS_OPERATOR_TOKEN');
  if (!config.identity.email) missing.push('NOVUS_PROBE_EMAIL');
  if (!config.identity.phone) missing.push('NOVUS_PROBE_PHONE');
  if (!config.identity.firstName) missing.push('NOVUS_PROBE_FIRST_NAME');
  if (!config.identity.lastName) missing.push('NOVUS_PROBE_LAST_NAME');
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}
