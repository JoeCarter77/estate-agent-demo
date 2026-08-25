// api/demo.js — the DEMOS route. One Serverless Function, three jobs.
//
//   GET  /api/demo?slug=<demo_slug>                        PUBLIC — render
//   POST /api/demo {action:'cta_click'|'meeting_booked'}    PUBLIC — telemetry
//   POST /api/demo {action:'build'|'archive'|'restore'}     AUTHED — recovery
//   POST /api/demo {action:'audit'}                         AUTHED — every link
//
// THE GET PATH READS ONE ROW AND NOTHING ELSE. It resolves the slug in DEMOS,
// loads that row, and returns it. No AI call, no join against PROBES /
// INTELLIGENCE / DIAGNOSIS_FINDINGS / PERSONALISATION, no Rightmove request,
// no compilation of any kind. The row was compiled when PERSONALISATION
// completed (lib/demo-compile.mjs, from lib/rebuild-pass.mjs) — opening a
// demo only reads that snapshot.
//
// ONLY `ready` RESOLVES NORMALLY. A `needs_review` row is an unfinished
// prospect experience (something in review_reasons is missing or unreviewed)
// and a plain request to it gets the SAME 404 as an unknown slug — nothing
// distinguishes "not ready yet" from "never existed" from the outside. The
// only way to see one is `?preview=1`, the internal viewing mechanism (also
// how we open our own demos without inflating view telemetry). `archived` is
// always gone, preview or not.
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
import { compileDemoForProbe, compileDemos, isPersonalised } from '../lib/demo-compile.mjs';
import {
  DEMOS_TAB, DEMOS_HEADER,
  demoRecords, demosTabExists, effectiveDemoStatus, findDemoBySlug, findDemoByProbe,
  loadDemosTable, resolveDemoBySlug, toRenderReady, writeDemoRow,
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

  // ?preview=1 is the INTERNAL viewing mechanism — how a demo is checked
  // before it is sent, and how we open our own demo without inflating the
  // prospect's view history. It is not a credential (no auth behind it,
  // same as every other value in the query string), so it must never be
  // required to see a demo that is genuinely ready to send — only to see
  // one that isn't.
  const preview = text(req.query?.preview) === '1';

  // ONE RESOLUTION RULE, SHARED WITH THE AUDIT. lib/demos.mjs owns slug
  // normalisation (stray spaces, a pasted trailing slash, case), the
  // archived/needs_review gate, and the self-heal for a hand-blanked
  // demo_status — so `audit` and a real prospect request can never disagree
  // about whether a link works.
  const resolved = resolveDemoBySlug(table, slug, { preview });
  if (!resolved.ok) return res.status(resolved.httpStatus).json({ error: resolved.error });

  const { record, status } = resolved;

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

// ── audit: does every demo link actually resolve? ────────────────────────────
//
// A demo that 404s is invisible from the inside: the DEMOS row still says
// `ready`, the slug still looks right, and the only way anyone finds out is a
// prospect clicking a dead link in an email we sent them. This action answers
// the question in one call, for every row at once, by putting each slug
// through resolveDemoBySlug() — THE SAME function the prospect's own GET goes
// through, so a demo cannot pass the audit and fail in the wild.
//
// It also reports the demos that were never written: a probe PERSONALISATION
// finished but that has no DEMOS row at all is a link that would 404 with no
// row to explain why, and it is the one failure mode a per-row check cannot
// see.
//
// WITH `fix: true` it repairs rather than reports, and only through the
// pipeline's own compiler — never by editing a URL. Every row that does not
// resolve, plus every personalised probe with no row, is recompiled by
// lib/demo-compile.mjs exactly as the automatic pass would have compiled it;
// then the whole set is re-resolved so the returned counts are what is true
// AFTER the repair. A demo that still cannot resolve is reported, with the
// review_reasons that say why — it is never left silently campaign-ready.
async function handleAudit(body, res) {
  const fix = body?.fix === true;
  const repo = getRepo();

  let table = await loadDemosTable(repo);
  if (!demosTabExists(table)) {
    return res.status(409).json({
      error: `The workbook has no DEMOS tab yet. Create a "${DEMOS_TAB}" tab whose row 1 is exactly: ${DEMOS_HEADER.join(', ')}`,
    });
  }

  // Personalised probes with no demo row of their own — "the record was never
  // written", which no amount of checking slugs can reveal.
  const missingRows = async () => {
    const personalisation = await repo.getTable('PERSONALISATION').catch(() => ({ header: [], rows: [] }));
    const probeIdx = (personalisation.header || []).indexOf('probe_id');
    if (probeIdx === -1) return [];
    const withRow = new Set(demoRecords(table).map(({ obj }) => text(obj.probe_id)).filter(Boolean));
    const out = [];
    const seen = new Set();
    (personalisation.rows || []).forEach((row) => {
      const probeId = String(row[probeIdx] ?? '').trim();
      if (!probeId || probeId === 'SCHEMA NOTE' || seen.has(probeId)) return;
      seen.add(probeId);
      const obj = {};
      (personalisation.header || []).forEach((key, i) => { obj[key] = row[i] ?? ''; });
      if (!isPersonalised(obj) || withRow.has(probeId)) return;
      out.push(probeId);
    });
    return out;
  };

  const auditRows = () => demoRecords(table).map(({ obj }) => {
    const resolved = resolveDemoBySlug(table, obj.demo_slug, { preview: false });
    const stored = text(obj.demo_status);
    return {
      demo_slug: obj.demo_slug,
      demo_url: `/demo/${obj.demo_slug}`,
      probe_id: text(obj.probe_id),
      agency_name: text(obj.agency_name),
      hero_journey: text(obj.hero_journey),
      demo_status: stored,
      effective_status: effectiveDemoStatus(obj),
      demo_version: text(obj.demo_version),
      resolves: resolved.ok,
      // Why a prospect would not see this demo, in the terms the row itself
      // can explain: retired, unfinished (with the reasons), or a slug that
      // does not survive the round trip.
      reason: resolved.ok ? '' : (text(obj.review_reasons) || resolved.error),
      review_reasons: text(obj.review_reasons),
    };
  });

  let missing = await missingRows();
  let rows = auditRows();
  const fixed = { recompiled: 0, repaired: 0, still_broken: 0, problems: [] };

  if (fix) {
    const probeIds = [
      ...new Set([...rows.filter((r) => !r.resolves).map((r) => r.probe_id).filter(Boolean), ...missing]),
    ];
    if (probeIds.length > 0) {
      // The pipeline's own compiler, forced onto exactly these probes. Nothing
      // here writes a slug, a status or a line of copy by hand.
      const summary = await compileDemos(repo, { probeIds, force: true, compiledBy: 'audit' });
      fixed.recompiled = summary.demos_compiled;
      fixed.problems = summary.problems;
      table = await loadDemosTable(repo);
      const before = new Set(rows.filter((r) => !r.resolves).map((r) => r.demo_slug));
      rows = auditRows();
      missing = await missingRows();
      fixed.repaired = rows.filter((r) => r.resolves && before.has(r.demo_slug)).length;
    }
    fixed.still_broken = rows.filter((r) => !r.resolves).length + missing.length;
  }

  const working = rows.filter((r) => r.resolves);
  const broken = rows.filter((r) => !r.resolves);
  return res.status(200).json({
    ok: true,
    tested: rows.length,
    working: working.length,
    broken: broken.length,
    missing_demo_rows: missing,
    demos: rows,
    ...(fix ? { fixed } : {}),
  });
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
      if (action === 'audit') return await handleAudit(body, res);
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
