// api/novus/intelligence/rebuild-all.js — POST /api/novus/intelligence/rebuild-all
//
// Manual "Rebuild All Intelligence" action — the canonical full-rebuild path
// (V2 schema, docs/V2_COMMS_INTELLIGENCE_DIAGNOSIS_SCHEMA.md §6):
// PROBES -> find matched COMMUNICATIONS -> recompute deterministic evidence
// + A-H grade -> AI-interpret (only where that hasn't run before, or when
// forced) -> create/update INTELLIGENCE, for every probe currently in the
// sheet. Then, for every INTELLIGENCE row whose observation_status is
// 'closed', rebuilds DIAGNOSIS the same way (lib/diagnosis-rebuild.mjs) — a
// pure commercial read of the INTELLIGENCE row just computed, no new
// evidence, no grading, and the grade is never used to select the result.
// Same NOVUS_BASIC_AUTH guard as the rest of /api/novus/*.
//
// Idempotent by construction: both rebuild steps upsert exactly one row per
// probe_id — running this twice produces the same INTELLIGENCE/DIAGNOSIS
// rows both times, never duplicates, and makes zero further AI calls once
// every row has been interpreted/diagnosed.
//
// No body required for the normal full rebuild.
//
// Optional body: { "probe_id": "..." } — SINGLE-PROBE recompute instead of a
// full rebuild (lib/observation-recompute.mjs — the same code path the
// communications webhooks trigger automatically). Returns exactly what that
// path returns, NOT wrapped in the full-rebuild summary shape, and
// short-circuits before touching the full-rebuild path.
//
// Optional body: { "force_ai": true } — re-runs AI interpretation on every
// probe that isn't yet finalised, even ones already interpreted. Use after a
// prompt change; otherwise leave unset so a routine rebuild costs no AI calls.
// Has no effect on DIAGNOSIS: once a probe is finalised (closed, with a
// non-blank DIAGNOSIS.diagnosis_summary) it is frozen for good — see the
// probe-lifecycle comments in lib/diagnosis-rebuild.mjs and
// lib/intelligence-rebuild.mjs. force_ai only ever touches probes that
// haven't been finalised yet.
//
// BATCHING (fixes 504 FUNCTION_INVOCATION_TIMEOUT on large historical
// datasets): the deterministic pass and the sheet writes are cheap and
// batched, but the AI interpretation/diagnosis calls are awaited one probe
// at a time and are the only part slow enough to blow the maxDuration below.
// So each invocation only runs up to `batch_size` AI calls total (shared
// between interpretation and diagnosis), then returns with `complete: false`
// and a `remaining` count instead of pushing through the whole dataset.
// Resumability needs no cursor: "needs AI" is defined by a blank
// communication_quality/diagnosis_summary field on the row itself
// (lib/intelligence-rebuild.mjs, lib/diagnosis-rebuild.mjs), so simply
// calling this endpoint again continues from wherever the last call stopped
// — same idempotent upsert-by-probe_id as before, safe to rerun, never
// duplicates a row, never touches manual_override'd communications. The
// Apps Script button (google-apps-script/RebuildIntelligence.gs) loops this
// call until `complete: true` and reports one aggregated final result.
//
// Optional body: { "batch_size": N } — override the per-invocation AI-call
// budget (default below / NOVUS_REBUILD_BATCH_SIZE). Mainly for tests.

// Optional body: { "operation": "rebuild_outbound", "dry_run": true } —
// compile the current AGENCIES + PROBES + PERSONALISATION + DEMOS state into an
// operator report without running the Intelligence pipeline. Only literal
// dry_run:false writes the resulting upserts to OUTBOUND.

// Optional body: { "operation": "instantly_outbound", "dry_run": true } —
// read the compiled OUTBOUND queue and report eligible rows plus bounded exact
// Instantly payload samples. Dry-run makes no Instantly request and no Sheet
// write. Literal dry_run:false enters the separately guarded one-outbound_id
// live path; that path requires an exact confirmation value and cannot upload
// more than one lead.
//
// Optional body: { "probe_ids": ["prb_...", "prb_..."] } — restricts the full
// rebuild (Intelligence, then Diagnosis, then Personalisation) to exactly
// this list of probes; every other probe on the sheet is left untouched.
// Distinct from the singular "probe_id" above: that one is the older,
// separate single-probe recompute path (webhook-shaped, no Diagnosis
// findings persistence, no Personalisation); "probe_ids" runs the real
// three-step batch pipeline, just narrowed to a known set. Exists because a
// full, untargeted rebuild will personalise EVERY already-diagnosed probe on
// an otherwise-empty PERSONALISATION tab, not just the ones you meant to
// test — see lib/personalisation-rebuild.mjs's file header. Ignored if
// "probe_id" (singular) is also present, since that short-circuits first.
// Also accepts a comma-separated string ("prb_a,prb_b") in case the caller's
// tooling can't easily send a JSON array. If "probe_ids" is present in the
// body but resolves to zero usable ids (wrong type, empty array, empty
// string), the request 400s explicitly rather than silently falling back to
// an untargeted full rebuild — the whole point of this field is to avoid an
// accidental full rebuild, so a malformed value for it must never quietly
// behave as if it had been omitted.
//
// A body that arrives as text but isn't valid JSON (e.g. mangled by shell
// quoting) also 400s explicitly now, with the parse error, instead of being
// silently treated as an empty body — the same reasoning: a request meant to
// be scoped by probe_ids must never silently degrade into a full rebuild.

import { getRepo } from '../../../lib/sheets.mjs';
import { runRebuildPass } from '../../../lib/rebuild-pass.mjs';
import { recomputeProbeObservation } from '../../../lib/observation-recompute.mjs';
import { rebuildOutbound } from '../../../lib/outbound.mjs';
import { buildInstantlyDryRun, uploadSingleOutboundLead } from '../../../lib/instantly-outbound.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

// Conservative default: ~2-3s per AI call observed in practice, so 15 calls
// leaves comfortable headroom under the 60s maxDuration for the batch's
// reads/writes and any slower-than-average calls.
const DEFAULT_BATCH_SIZE = 15;

// req.body as Vercel hands it to us can be: already-parsed JSON (object —
// the common case, when Content-Type: application/json was set correctly
// and the platform's own parser succeeded), a raw string (some proxies/
// tools, or a Content-Type the platform didn't recognise as JSON), a Buffer,
// or undefined/null/'' (no body at all). Throws on a non-empty string/Buffer
// that isn't valid JSON, instead of silently discarding it — see the "Also
// accepts..." note above for why that matters specifically for probe_ids.
function parseBody(req) {
  const raw = req.body;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err.message}`);
  }
}

// undefined -> not present at all (the untargeted-rebuild default).
// Array -> each entry trimmed to a string, blanks dropped.
// Comma-separated string -> same, split first.
// Anything else present (number, object, boolean, empty array/string after
// trimming) -> invalid: true, so the caller can 400 rather than silently
// running an untargeted rebuild.
function normalizeProbeIds(raw) {
  if (raw === undefined) return { present: false, ids: null, invalid: false };
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : null);
  if (list === null) return { present: true, ids: null, invalid: true };
  const ids = list.map((id) => String(id ?? '').trim()).filter(Boolean);
  return { present: true, ids, invalid: ids.length === 0 };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  let body;
  try {
    body = parseBody(req);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const probeId = String(body.probe_id || '').trim();

  // The OUTBOUND compiler shares this protected operator endpoint instead of
  // consuming a thirteenth Vercel Function. It is a separate deterministic
  // operation: no Intelligence rebuild, AI call, Instantly call or email send
  // occurs. Writes remain fail-safe and require literal dry_run: false.
  if (body.operation === 'rebuild_outbound') {
    try {
      const result = await rebuildOutbound(getRepo(), { dryRun: body.dry_run !== false });
      return res.status(200).json(result);
    } catch (err) {
      console.error('outbound rebuild error:', err);
      return res.status(500).json({ error: err.message || 'Failed to rebuild OUTBOUND' });
    }
  }

  // Instantly is only the execution layer: this operation reads the existing
  // OUTBOUND tab and never invokes the OUTBOUND compiler. It shares this
  // protected operator endpoint so no additional Vercel Function is created.
  if (body.operation === 'instantly_outbound') {
    try {
      const repo = getRepo();
      if (body.dry_run !== false) {
        const result = await buildInstantlyDryRun(repo, {
          campaignId: process.env.INSTANTLY_CAMPAIGN_ID,
          sampleLimit: body.sample_limit,
        });
        return res.status(200).json(result);
      }
      const result = await uploadSingleOutboundLead(repo, {
        outboundId: body.outbound_id,
        confirmation: body.confirmation,
        ...(body.test_email !== undefined ? { testEmail: body.test_email } : {}),
        apiKey: process.env.INSTANTLY_API_KEY,
        campaignId: process.env.INSTANTLY_CAMPAIGN_ID,
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error('instantly outbound error:', err?.message || String(err));
      return res.status(400).json({ error: err?.message || 'Instantly OUTBOUND handoff failed' });
    }
  }

  // probe_ids is genuinely ignored (not even validated) once the singular
  // probe_id short-circuits below — matches the documented precedence.
  const probeIdsField = probeId ? { present: false, ids: null, invalid: false } : normalizeProbeIds(body.probe_ids);
  if (probeIdsField.invalid) {
    return res.status(400).json({
      error: 'probe_ids must be a non-empty array of probe_id strings (or a non-empty comma-separated string)',
    });
  }
  const probeIds = probeIdsField.ids;
  const forceAi = body.force_ai === true;
  const batchSize = Number.isFinite(Number(body.batch_size)) && Number(body.batch_size) > 0
    ? Number(body.batch_size)
    : Number(process.env.NOVUS_REBUILD_BATCH_SIZE) || DEFAULT_BATCH_SIZE;

  try {
    const repo = getRepo();

    // Single-probe recompute. Entirely separate operation from the full
    // rebuild below; returns immediately.
    if (probeId) {
      const result = await recomputeProbeObservation(repo, probeId);
      if (!result) return res.status(404).json({ error: `Probe ${probeId} not found` });
      return res.status(200).json(result);
    }

    const summary = await runRebuildPass(repo, {
      forceAi,
      maxAiCalls: batchSize,
      probeIds: probeIds || undefined,
      rebuildOutbound: true,
    });

    return res.status(200).json({ ...summary, batch_size: batchSize, ...(probeIds ? { targeted_probe_ids: probeIds } : {}) });
  } catch (err) {
    console.error('intelligence rebuild-all error:', err);
    return res.status(500).json({ error: err.message || 'Failed to rebuild intelligence' });
  }
}
