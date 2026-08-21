// lib/diagnosis-findings.mjs — the DIAGNOSIS_FINDINGS tab: one row per
// individual finding, linked to its probe by probe_id.
//
// DIAGNOSIS holds the whole-probe commercial read (strengths,
// missed_opportunities, commercial_implication, novus_opportunity,
// diagnosis_summary). The findings[] array lib/probe-diagnosis.mjs produces
// is 0-4 SEPARATE, independently evidence-backed items, so it does not fit
// one cell of that row — it is persisted here instead, one row each, in the
// order Diagnosis ranked them (finding_index 1 = most commercially damaging).
//
// Live tab header (created by hand, matched literally here):
//   probe_id | finding_index | finding | evidence | significance_note
//
// Written by lib/diagnosis-rebuild.mjs at the moment the diagnosis is
// generated; read back by lib/personalisation-rebuild.mjs, which is the
// layer that decides which of these findings combine into one story. Neither
// side ever invents a finding: the rows here are exactly the items that
// survived lib/probe-diagnosis.mjs's evidence gate.
//
// The tab is addressed by probe_id, never by a decorative *_id column — the
// same discipline the rest of the pipeline settled on after DIAGNOSIS stayed
// empty for exactly that reason (see scripts/novus-diagnosis-persistence-selftest.mjs).

export const DIAGNOSIS_FINDINGS_TAB = 'DIAGNOSIS_FINDINGS';

// A workbook that predates this tab (or a test fake that doesn't define it)
// must not take the whole rebuild down — findings persistence degrades to
// "not available" and Diagnosis itself still writes. An empty header is the
// signal for "no such tab", checked by every caller below.
export async function loadFindingsTable(repo) {
  try {
    const table = await repo.getTable(DIAGNOSIS_FINDINGS_TAB);
    return { header: table.header || [], rows: table.rows || [] };
  } catch {
    return { header: [], rows: [] };
  }
}

export function findingsTabExists(table) {
  return Array.isArray(table.header) && table.header.includes('probe_id');
}

// probeId is TRIMMED and written back onto obj.probe_id — same fix as the
// recordsFromTable() helpers in lib/intelligence-rebuild.mjs,
// lib/diagnosis-rebuild.mjs and lib/personalisation-rebuild.mjs: a stray
// leading/trailing space in the sheet must not make groupFindingsByProbe()
// or existingRowsFor() key this row under a probe_id that never matches the
// one the rest of the pipeline is looking it up by.
function recordsOf(table) {
  const idIdx = table.header.indexOf('probe_id');
  if (idIdx === -1) return [];
  const out = [];
  table.rows.forEach((row, i) => {
    const probeId = String(row[idIdx] ?? '').trim();
    if (!probeId || probeId === 'SCHEMA NOTE') return;
    const obj = {};
    table.header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    obj.probe_id = probeId;
    out.push({ rowNumber: i + 2, obj });
  });
  return out;
}

// -> Map(probe_id -> [{ finding_index, finding, evidence, significance_note }])
// sorted by finding_index, so Personalisation always sees the findings in the
// order Diagnosis ranked them regardless of physical row order in the sheet.
// A row whose finding or evidence is blank is dropped: the same evidence gate
// lib/probe-diagnosis.mjs applies, re-applied on the way back out, so a
// hand-edited half-row can never reach Personalisation as a real finding.
export function groupFindingsByProbe(table) {
  const byProbe = new Map();
  for (const { obj } of recordsOf(table)) {
    const finding = String(obj.finding || '').trim();
    const evidence = String(obj.evidence || '').trim();
    if (!finding || !evidence) continue;
    const item = {
      finding_index: Number(obj.finding_index) || 0,
      finding,
      evidence,
      significance_note: String(obj.significance_note || '').trim(),
    };
    if (!byProbe.has(obj.probe_id)) byProbe.set(obj.probe_id, []);
    byProbe.get(obj.probe_id).push(item);
  }
  for (const items of byProbe.values()) {
    items.sort((a, b) => a.finding_index - b.finding_index);
  }
  return byProbe;
}

// Row numbers of this probe's existing findings rows, by finding_index, so a
// re-run overwrites in place rather than appending a second copy.
function existingRowsFor(table, probeId) {
  const byIndex = new Map();
  for (const { rowNumber, obj } of recordsOf(table)) {
    if (obj.probe_id !== probeId) continue;
    byIndex.set(Number(obj.finding_index) || 0, rowNumber);
  }
  return byIndex;
}

// Builds the writeRowsBatch entries that persist ONE probe's findings.
//
// findings: the sanitized array lib/probe-diagnosis.mjs produced (already
// evidence-gated and capped at 4). allocateRow(): called for each row that
// has no existing home, returns the next free sheet row number — the caller
// owns that counter because it is appending to the same table across many
// probes in one pass.
//
// Idempotent per (probe_id, finding_index): re-running a probe overwrites its
// own rows and blanks any surplus row left by a previous, longer run, so the
// tab can never accumulate a stale finding that Personalisation would then
// read as genuine.
export function buildFindingsWrites(table, probeId, findings, allocateRow) {
  if (!findingsTabExists(table)) return [];

  const existing = existingRowsFor(table, probeId);
  const writes = [];

  findings.forEach((f, i) => {
    const findingIndex = i + 1;
    const obj = {
      probe_id: probeId,
      finding_index: findingIndex,
      finding: f.finding,
      evidence: f.evidence,
      significance_note: f.significance_note || '',
    };
    const rowNumber = existing.get(findingIndex) ?? allocateRow();
    existing.delete(findingIndex);
    writes.push({
      tab: DIAGNOSIS_FINDINGS_TAB,
      rowNumber,
      row: table.header.map((key) => (obj[key] ?? '')),
    });
  });

  // Anything this probe left behind from a previous, longer diagnosis is
  // blanked rather than left to be read back as a real finding.
  for (const rowNumber of existing.values()) {
    writes.push({ tab: DIAGNOSIS_FINDINGS_TAB, rowNumber, row: table.header.map(() => '') });
  }

  return writes;
}

// Formats findings for an AI prompt. Shared so Diagnosis and Personalisation
// always describe a finding the same way.
export function formatFindingsForPrompt(findings) {
  if (!findings || findings.length === 0) return '(none — the evidence shows no genuine problem)';
  return findings
    .map((f, i) => {
      const idx = f.finding_index || i + 1;
      const significance = f.significance_note ? `\n     Why it matters: ${f.significance_note}` : '';
      return `  Finding ${idx}: ${f.finding}\n     Evidence: ${f.evidence}${significance}`;
    })
    .join('\n');
}
