// api/demo.js — the DEMOS route. One Serverless Function, three jobs.
//
//   GET  /api/demo?slug=<demo_slug>                     PUBLIC  — render the demo
//   POST /api/demo {action:'cta_click'|'meeting_booked'} PUBLIC  — CTA telemetry
//   POST /api/demo {action:'build'|'publish'|'unpublish'} AUTHED — manage a row
//
// PUBLIC ON PURPOSE, AND ONLY HERE. middleware.js gates /novus/* and
// /api/novus/* behind Basic Auth — a prospect cannot be asked for a password,
// so the demo read lives at /api/demo, outside that matcher. The admin actions
// on this same route call requireAuth() explicitly, so the Sheets WRITE path
// stays behind the same credential as the rest of NOVUS.
//
// ONE ROUTE, NOT FOUR FILES. Vercel Hobby caps the project at 12 Serverless
// Functions and api/novus/probe.js was already consolidated for that reason.
// This route is the twelfth; anything further must merge into an existing one.
//
// The prospect's browser reads ONE row. It never queries PROBES, AGENCIES,
// INTELLIGENCE, DIAGNOSIS_FINDINGS or PERSONALISATION, and it never touches
// Rightmove — DEMOS is the render-ready projection of all of them, frozen at
// build time.

import { getRepo } from '../lib/sheets.mjs';
import { requireAuth } from './novus/_auth.mjs';
import { loadFindingsTable, groupFindingsByProbe } from '../lib/diagnosis-findings.mjs';
import { resolvePropertyImageUrl } from '../lib/property-image.mjs';
import {
  DEMOS_TAB, DEMOS_HEADER,
  buildDemoRow, buildDemoSlug, demosTabExists, findDemoBySlug, findDemoByProbe,
  loadDemosTable, slugOwners, toRenderReady, writeDemoRow,
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

// ── GET: resolve a slug and render ───────────────────────────────────────────

async function handleGet(req, res) {
  const slug = text(req.query?.slug);
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const repo = getRepo();
  const table = await loadDemosTable(repo);
  if (!demosTabExists(table)) {
    return res.status(404).json({ error: 'No DEMOS tab in the workbook yet' });
  }

  const record = findDemoBySlug(table, slug);
  if (!record) return res.status(404).json({ error: 'No demo found for this link' });

  const status = text(record.obj.demo_status) || 'draft';
  // An archived demo is deliberately gone. A draft one still resolves so the
  // URL can be checked before it is sent — flagged, so the page can say so.
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
  return res.status(200).json({ demo: toRenderReady(record.obj), draft: status !== 'published' });
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

// ── POST: telemetry (public) and management (authed) ─────────────────────────

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

// Build (or rebuild) one probe's DEMOS row from the pipeline's own output.
// Reads five upstream tabs; writes exactly one row. Nothing upstream is
// modified — DEMOS is downstream of the pipeline and never feeds back into it.
async function handleBuild(body, res) {
  const probeId = text(body?.probe_id);
  if (!probeId) return res.status(400).json({ error: 'Missing probe_id' });

  const repo = getRepo();

  const probeRecord = await repo.findById('PROBES', 'probe_id', probeId);
  if (!probeRecord) return res.status(404).json({ error: `No PROBES row for ${probeId}` });
  const probe = probeRecord.obj;

  const personalisationRecord = await repo.findById('PERSONALISATION', 'probe_id', probeId);
  if (!personalisationRecord) {
    return res.status(409).json({ error: `No PERSONALISATION row for ${probeId} — the probe has not been diagnosed and personalised yet` });
  }
  const personalisation = personalisationRecord.obj;

  const intelligenceRecord = await repo.findById('INTELLIGENCE', 'probe_id', probeId);
  const intelligence = intelligenceRecord?.obj || {};

  const agencyId = text(probe.agency_id);
  const agencyRecord = agencyId ? await repo.findById('AGENCIES', 'agency_id', agencyId) : null;
  const agency = agencyRecord?.obj || {};

  const findings = groupFindingsByProbe(await loadFindingsTable(repo)).get(probeId) || [];

  const demosTable = await loadDemosTable(repo);
  if (!demosTabExists(demosTable)) {
    return res.status(409).json({
      error: `The workbook has no DEMOS tab yet. Create a "${DEMOS_TAB}" tab whose row 1 is exactly: ${DEMOS_HEADER.join(', ')}`,
    });
  }
  const existingRecord = findDemoByProbe(demosTable, probeId);

  // The image is resolved ONCE, here. An existing one is kept unless the
  // caller explicitly asks for a refresh, so a rebuild never re-hits the
  // portal and never loses a good image to a now-blocked request.
  let propertyImageUrl = text(existingRecord?.obj.property_image_url);
  const refreshImage = body?.refresh_image === true;
  if (text(body?.property_image_url)) {
    propertyImageUrl = text(body.property_image_url);           // hand-supplied wins
  } else if (!propertyImageUrl || refreshImage) {
    // Serverless path only — never Playwright. A blank result is expected on
    // Rightmove and must not fail the build (see lib/property-image.mjs).
    const resolved = await resolvePropertyImageUrl(probe.property_url, { allowBrowser: false })
      .catch(() => '');
    propertyImageUrl = resolved || propertyImageUrl;
  }

  const status = body?.publish === true ? 'published' : (text(existingRecord?.obj.demo_status) || 'draft');

  let built;
  try {
    built = buildDemoRow({
      probe, agency, intelligence, findings, personalisation,
      propertyImageUrl,
      existing: existingRecord?.obj || null,
      status,
    });
  } catch (err) {
    if (err?.code === 'unsupported_hero_journey') {
      return res.status(422).json({ error: err.message, hero_journey: err.hero_journey });
    }
    throw err;
  }

  const slug = text(body?.slug) || text(existingRecord?.obj.demo_slug) || buildDemoSlug({
    agencyName: agency.agency_name,
    probeReference: probe.probe_reference,
    probeId,
  }, slugOwners(demosTable));
  built.row.demo_slug = slug;
  if (status === 'published' && !text(built.row.published_at)) built.row.published_at = nowIso();

  if (existingRecord) {
    await writeDemoRow(repo, demosTable.header, existingRecord.rowNumber, built.row);
  } else {
    await repo.appendRecord(DEMOS_TAB, built.row);
  }

  return res.status(200).json({
    ok: true,
    created: !existingRecord,
    demo_slug: slug,
    demo_status: built.row.demo_status,
    demo_url: `/demo/${slug}`,
    // Echoed so a caller that CAN run a real browser (scripts/novus-demo.mjs)
    // knows which listing to re-extract from when the cheap fetch came back
    // blank — without needing its own read access to PROBES.
    property_url: built.row.property_url,
    property_image_url: built.row.property_image_url,
    hero_journey: built.row.hero_journey,
    warnings: built.warnings,
  });
}

async function handlePublish(body, res, publish) {
  const slug = text(body?.slug);
  const probeId = text(body?.probe_id);
  if (!slug && !probeId) return res.status(400).json({ error: 'Missing slug or probe_id' });

  const repo = getRepo();
  const table = await loadDemosTable(repo);
  if (!demosTabExists(table)) return res.status(409).json({ error: 'No DEMOS tab in the workbook yet' });

  const record = slug ? findDemoBySlug(table, slug) : findDemoByProbe(table, probeId);
  if (!record) return res.status(404).json({ error: 'No demo found' });

  const merged = {
    ...record.obj,
    demo_status: publish ? 'published' : 'draft',
    published_at: publish ? (text(record.obj.published_at) || nowIso()) : record.obj.published_at,
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
      if (action === 'publish') return await handlePublish(body, res, true);
      if (action === 'unpublish') return await handlePublish(body, res, false);
      return res.status(400).json({ error: `Unknown action "${action}"` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('demo route error:', err);
    return res.status(500).json({ error: err?.message || 'Demo request failed' });
  }
}
