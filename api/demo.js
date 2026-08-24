// api/demo.js — the DEMOS route. One Serverless Function, three jobs.
//
//   GET  /api/demo?slug=<demo_slug>                        PUBLIC — render
//   POST /api/demo {action:'cta_click'|'meeting_booked'}    PUBLIC — telemetry
//   POST /api/demo {action:'build'|'archive'|'restore'}     AUTHED — recovery
//
// THE GET PATH READS ONE ROW AND NOTHING ELSE. It resolves the slug in DEMOS,
// loads that row, and returns it. No AI call, no join against PROBES /
// INTELLIGENCE / DIAGNOSIS_FINDINGS / PERSONALISATION, no Rightmove request,
// no compilation of any kind. The row was compiled when PERSONALISATION
// completed (lib/demo-compile.mjs, from lib/rebuild-pass.mjs) — opening a
// demo only reads that snapshot.
//
// `build` IS NOT PART OF THE ACQUISITION WORKFLOW. Demos are compiled
// automatically by the pipeline; this action exists so a human can force a
// recompile when debugging or recovering one row, and it calls straight into
// the SAME compiler the pipeline uses, so a hand-triggered rebuild can never
// produce a row the pipeline would not have produced.
//
// PUBLIC ON PURPOSE, AND ONLY HERE. middleware.js gates /novus/* and
// /api/novus/* behind Basic Auth — a prospect cannot be asked for a password,
// so the demo read lives at /api/demo, outside that matcher. Every action that
// writes demo CONTENT calls requireAuth() explicitly.
//
// ONE ROUTE, NOT FOUR FILES. Vercel Hobby caps the project at 12 Serverless
// Functions and api/novus/probe.js was already consolidated for that reason.
// This route is the twelfth; anything further must merge into an existing one.

import { getRepo } from '../lib/sheets.mjs';
import { requireAuth } from './novus/_auth.mjs';
import { compileDemoForProbe } from '../lib/demo-compile.mjs';
import {
  DEMOS_TAB, DEMOS_HEADER,
  demosTabExists, findDemoBySlug, findDemoByProbe,
  loadDemosTable, toRenderReady, writeDemoRow,
} from '../lib/demos.mjs';

// Long enough for the build action's six tab reads plus one listing fetch.
// The public GET is two round-trips and never comes near it.
export const maxDuration = 60;

function nowIso() { return new Date().toISOString(); }
function text(value) { return String(value ?? '').trim(); }

// Same shapes api/novus/intelligence/rebuild-all.js has to cope with: Vercel
// hands the body over as a parsed object, a raw string, a Buffer, or nothing
// at all depending on the Content-Type the caller sent. A non-empty body that
// is not valid JSON is an error, never a silently-empty request.
function parseBody(req) {
  const raw = req.body;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const asText = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!asText.trim()) return {};
  try {
    return JSON.parse(asText);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err.message}`);
  }
}

// ── GET: resolve a slug and render, from the snapshot alone ──────────────────

async function handleGet(req, res) {
  const slug = text(req.query?.slug);
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const repo = getRepo();
  const table = await loadDemosTable(repo);            // ← the only tab read
  if (!demosTabExists(table)) {
    return res.status(404).json({ error: 'No DEMOS tab in the workbook yet' });
  }

  const record = findDemoBySlug(table, slug);
  if (!record) return res.status(404).json({ error: 'No demo found for this link' });

  const status = text(record.obj.demo_status) || 'needs_review';
  // An archived demo is deliberately retired. A needs_review one still
  // resolves — flagged, so it can be looked at rather than silently sent.
  if (status === 'archived') return res.status(404).json({ error: 'This demo is no longer available' });

  // ?preview=1 is how we open our own demo without inflating the prospect's
  // view history. It is a courtesy flag, not a security boundary.
  const preview = text(req.query?.preview) === '1';
  if (!preview) {
    await recordView(repo, table, record).catch((err) => {
      console.error('demo view telemetry failed (serving the demo anyway):', err?.message || err);
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    demo: toRenderReady(record.obj),
    needs_review: status === 'needs_review',
  });
}

// One read (already done) + one write. Never fails the page: the caller
// swallows errors, because a demo that renders without its view being counted
// is strictly better than a demo that 500s.
async function recordView(repo, table, record) {
  const previous = parseInt(record.obj.view_count, 10);
  const count = (Number.isFinite(previous) && previous > 0 ? previous : 0) + 1;
  const at = nowIso();
  const merged = {
    ...record.obj,
    first_viewed_at: text(record.obj.first_viewed_at) || at,
    last_viewed_at: at,
    view_count: String(count),
  };
  await writeDemoRow(repo, table.header, record.rowNumber, merged);
}

// ── POST: telemetry (public) and recovery (authed) ───────────────────────────

const PUBLIC_ACTIONS = new Set(['cta_click', 'meeting_booked']);
const TELEMETRY_COLUMN = { cta_click: 'cta_clicked_at', meeting_booked: 'meeting_booked_at' };

async function handleTelemetry(body, res, action) {
  const slug = text(body?.slug);
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const repo = getRepo();
  const table = await loadDemosTable(repo);
  if (!demosTabExists(table)) return res.status(404).json({ error: 'No DEMOS tab in the workbook yet' });

  const record = findDemoBySlug(table, slug);
  if (!record) return res.status(404).json({ error: 'No demo found for this link' });

  const column = TELEMETRY_COLUMN[action];
  // FIRST click wins. Overwriting would turn "when did they engage" into
  // "when did they last reload", which is not the question we are asking.
  if (!text(record.obj[column])) {
    await writeDemoRow(repo, table.header, record.rowNumber, { ...record.obj, [column]: nowIso() });
  }
  return res.status(200).json({ ok: true });
}

// DEBUGGING / RECOVERY ONLY — the pipeline compiles demos on its own. This is
// the same lib/demo-compile.mjs the automatic pass runs, restricted to one
// probe and forced, so what comes out is byte-identical to what the pipeline
// would have written.
async function handleBuild(body, res) {
  const probeId = text(body?.probe_id);
  if (!probeId) return res.status(400).json({ error: 'Missing probe_id' });

  const repo = getRepo();
  const summary = await compileDemoForProbe(repo, probeId, {
    compiledBy: text(body?.compiled_by) || 'manual',
    suppliedImageUrl: text(body?.property_image_url),
    forceImage: body?.refresh_image === true,
    slug: text(body?.slug),
  });

  if (summary.demos_tab_missing) {
    return res.status(409).json({
      error: `The workbook has no DEMOS tab yet. Create a "${DEMOS_TAB}" tab whose row 1 is exactly: ${DEMOS_HEADER.join(', ')}`,
    });
  }

  const problem = summary.problems[0];
  if (!summary.result) {
    if (problem?.hero_journey) {
      return res.status(422).json({ error: problem.error, hero_journey: problem.hero_journey });
    }
    if (problem) return res.status(500).json({ error: problem.error });
    // No row, no problem reported: the probe exists but has no finalised
    // PERSONALISATION row, so there is no story to compile a demo from yet.
    return res.status(409).json({
      error: `No finalised PERSONALISATION row for ${probeId} — a demo is compiled automatically once the probe is diagnosed and personalised`,
    });
  }

  return res.status(200).json({ ok: true, created: summary.demos_created > 0, ...summary.result });
}

// Retire a demo link, or bring it back. `archived` is sticky across
// recompiles — see lib/demos.mjs — so this is the only way in or out of it.
async function handleArchive(body, res, archive) {
  const slug = text(body?.slug);
  const probeId = text(body?.probe_id);
  if (!slug && !probeId) return res.status(400).json({ error: 'Missing slug or probe_id' });

  const repo = getRepo();
  const table = await loadDemosTable(repo);
  if (!demosTabExists(table)) return res.status(409).json({ error: 'No DEMOS tab in the workbook yet' });

  const record = slug ? findDemoBySlug(table, slug) : findDemoByProbe(table, probeId);
  if (!record) return res.status(404).json({ error: 'No demo found' });

  // Restoring re-derives the status from the reasons already on the row,
  // rather than assuming `ready` — a demo archived while incomplete comes back
  // as needs_review, which is what it is.
  const restored = text(record.obj.review_reasons) ? 'needs_review' : 'ready';
  const merged = {
    ...record.obj,
    demo_status: archive ? 'archived' : restored,
    updated_at: nowIso(),
  };
  await writeDemoRow(repo, table.header, record.rowNumber, merged);
  return res.status(200).json({ ok: true, demo_slug: merged.demo_slug, demo_status: merged.demo_status });
}

// ── entry point ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') return await handleGet(req, res);

    if (req.method === 'POST') {
      const body = parseBody(req);
      const action = text(body?.action);
      if (PUBLIC_ACTIONS.has(action)) return await handleTelemetry(body, res, action);

      // Everything past this line writes demo CONTENT, so it needs the same
      // credential as the rest of NOVUS.
      if (!requireAuth(req, res)) return undefined;
      if (action === 'build') return await handleBuild(body, res);
      if (action === 'archive') return await handleArchive(body, res, true);
      if (action === 'restore') return await handleArchive(body, res, false);
      return res.status(400).json({ error: `Unknown action "${action}"` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('demo route error:', err);
    return res.status(500).json({ error: err?.message || 'Demo request failed' });
  }
}
