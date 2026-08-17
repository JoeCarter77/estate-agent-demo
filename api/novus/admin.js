// api/novus/admin.js — POST/GET /api/novus/admin?resource=<name>
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
// Vercel's Hobby plan caps a project at 12 Serverless Functions, one per file
// under /api (excluding files/folders prefixed with `_`, which Vercel does not
// route — see api/_leads.mjs's header comment; this codebase already relied on
// that convention before this file existed). Adding agencies.js, action-create.js,
// and the three admin/*.js files individually pushed the project from 11 to 16
// functions and broke deployment. This file collapses those five into ONE
// routed function, bringing the count back to 12 (see the tally at the bottom
// of this comment) without touching probe-create.js, probe-get.js,
// probe-mark-sent.js, observation/recompute.js, or any webhook — the original,
// externally-depended-on (Twilio/Gmail-configured) endpoints are untouched.
//
// HOW: the five original handlers moved verbatim (their internal logic is
// UNCHANGED — see the git history / api/novus/_admin/*.js header comments) into
// api/novus/_admin/, which Vercel excludes from routing because of the leading
// underscore on the directory. This file is a thin dispatcher that imports each
// one and calls it directly, unmodified, passing through the exact same (req, res)
// it received. Each handler still does its own method check, its own OPTIONS
// short-circuit, and its own requireAuth() — nothing about their behaviour,
// request/response contract, or auth model changed. Only the URL changed:
//
//   resource            old path                              new path
//   ──────────────────  ────────────────────────────────────  ─────────────────────────────────────
//   agencies       (GET) /api/novus/agencies                  /api/novus/admin?resource=agencies
//   actions   (GET/POST) /api/novus/action-create              /api/novus/admin?resource=actions
//   ensure-schema  (POST) /api/novus/admin/ensure-schema        /api/novus/admin?resource=ensure-schema
//   rightmove-migrate(POST)/api/novus/admin/rightmove-migrate   /api/novus/admin?resource=rightmove-migrate
//   agency-merge   (POST) /api/novus/admin/agency-merge         /api/novus/admin?resource=agency-merge
//
// Every caller of the old paths was updated in the same change: novus/probe.html,
// scripts/novus-rightmove-migrate.mjs, and docs/NOVUS_PROBE_FLOW_AND_RIGHTMOVE_MIGRATION.md.
//
// FUNCTION TALLY (post-refactor):
//   api/chat.js, api/lead.js, api/scrape.js                                  3
//   api/novus/probe-create.js, probe-get.js, probe-mark-sent.js              3
//   api/novus/observation/recompute.js                                      1
//   api/novus/webhooks/{email,sms,voice}-inbound.js, voice-recording.js     4
//   api/novus/admin.js (this file)                                          1
//                                                                    total = 12
// (api/_leads.mjs and api/novus/_auth.mjs are library files, not routes —
// already excluded before this change, per the underscore convention.)

import agenciesHandler from './_admin/agencies.js';
import actionsHandler from './_admin/action-create.js';
import ensureSchemaHandler from './_admin/ensure-schema.js';
import rightmoveMigrateHandler from './_admin/rightmove-migrate.js';
import agencyMergeHandler from './_admin/agency-merge.js';

// Longest sub-operation's original budget (rightmove-migrate.js was 60s;
// ensure-schema.js and agency-merge.js were 30s; agencies.js and
// action-create.js were 20s). One function now needs to cover all of them.
export const maxDuration = 60;

const RESOURCES = {
  agencies: agenciesHandler,
  actions: actionsHandler,
  'ensure-schema': ensureSchemaHandler,
  'rightmove-migrate': rightmoveMigrateHandler,
  'agency-merge': agencyMergeHandler,
};

export default async function handler(req, res) {
  // CORS preflight is resource-agnostic — every sub-handler would answer it
  // identically (200, no body), so it's handled once here rather than relying
  // on `resource` being present on every OPTIONS request a browser might send.
  if (req.method === 'OPTIONS') return res.status(200).end();

  const resource = String(req.query?.resource || '').trim();
  const fn = RESOURCES[resource];
  if (!fn) {
    return res.status(400).json({
      error: `Missing or unknown "resource" query parameter. Expected one of: ${Object.keys(RESOURCES).join(', ')}`,
    });
  }
  return fn(req, res);
}
