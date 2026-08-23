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

// ── The per-pass findings writer ─────────────────────────────────────────────
//
// THE DUPLICATION BUG THIS EXISTS TO CLOSE. The previous writer was a pure
// function over the table SNAPSHOT loaded at the start of the rebuild, plus a
// caller-owned "next free row" counter. Every call re-derived "which rows does
// this probe already own?" from that snapshot — which never changes during the
// pass. So if the SAME probe was written twice inside ONE rebuild, the second
// call still saw a snapshot with none of the first call's rows in it,
// allocated a fresh block from the counter, and appended a complete second
// copy of that probe's findings. One rebuild, one HTTP request, N findings ->
// 2N rows.
//
// That second visit is reachable: rebuildAllDiagnosis iterates INTELLIGENCE
// ROWS, and a workbook that carries two INTELLIGENCE rows for one probe_id
// (e.g. a 'prb_x' row and a 'prb_x ' row, which now normalise to the same
// trimmed id) puts that probe through the loop twice. DIAGNOSIS survived it
// because its upsert resolves through a probe_id -> row Map, so both visits
// land on the same row and the tab still shows exactly one row per probe —
// which is precisely why the duplication only ever showed up here.
//
// So the writer is now STATEFUL for the whole pass: it owns the row index AND
// the free-row counter together, and it updates the index as it allocates. A
// second visit to the same probe finds the rows the first visit already
// claimed and overwrites them in place. The invariant it enforces is exactly
// the one the pipeline needs: after one pass, ONE row per (probe_id,
// finding_index), whatever the caller does to it.
//
// table: the DIAGNOSIS_FINDINGS snapshot from loadFindingsTable().
export function createFindingsWriter(table) {
  const available = findingsTabExists(table);

  // probe_id -> Map(finding_index -> sheet row number). Seeded from the
  // snapshot, then kept LIVE: every row this pass allocates is recorded here
  // immediately, which is the whole fix.
  const rowsByProbe = new Map();
  const occupied = new Set();
  let nextRow = (table.rows ? table.rows.length : 0) + 2;

  if (available) {
    for (const { rowNumber, obj } of recordsOf(table)) {
      if (!rowsByProbe.has(obj.probe_id)) rowsByProbe.set(obj.probe_id, new Map());
      rowsByProbe.get(obj.probe_id).set(Number(obj.finding_index) || 0, rowNumber);
      occupied.add(rowNumber);
      // Guards the case where a previous run blanked the tab's trailing rows:
      // Sheets trims trailing empties on read, so rows.length can point BACK
      // AT a row another probe still owns. Never hand out an occupied row.
      if (rowNumber >= nextRow) nextRow = rowNumber + 1;
    }
  }

  function allocateRow() {
    while (occupied.has(nextRow)) nextRow += 1;
    const n = nextRow;
    occupied.add(n);
    nextRow += 1;
    return n;
  }

  // rowNumber -> write. A Map, not an array, so two writes to the same row
  // inside one pass collapse into one instead of both being sent.
  const writesByRow = new Map();
  const findingCountByProbe = new Map();

  function rowFor(probeId, findingIndex, f) {
    const obj = {
      probe_id: probeId,
      finding_index: findingIndex,
      finding: f.finding,
      evidence: f.evidence,
      significance_note: f.significance_note || '',
    };
    return table.header.map((key) => (obj[key] ?? ''));
  }

  return {
    available,

    // Persist ONE probe's findings. Idempotent per (probe_id, finding_index)
    // ACROSS the whole pass, not just against the snapshot: calling this twice
    // for the same probe rewrites the same rows and cannot append a second
    // copy. Surplus rows left by a previous, longer diagnosis are blanked so
    // they can never be read back as a genuine finding.
    write(probeId, findings) {
      if (!available) return 0;
      const items = Array.isArray(findings) ? findings : [];

      if (!rowsByProbe.has(probeId)) rowsByProbe.set(probeId, new Map());
      const byIndex = rowsByProbe.get(probeId);
      const surplus = new Map(byIndex);

      items.forEach((f, i) => {
        const findingIndex = i + 1;
        let rowNumber = byIndex.get(findingIndex);
        if (rowNumber === undefined) {
          rowNumber = allocateRow();
          byIndex.set(findingIndex, rowNumber);
        }
        surplus.delete(findingIndex);
        writesByRow.set(rowNumber, { tab: DIAGNOSIS_FINDINGS_TAB, rowNumber, row: rowFor(probeId, findingIndex, f) });
      });

      for (const [findingIndex, rowNumber] of surplus) {
        byIndex.delete(findingIndex);
        writesByRow.set(rowNumber, { tab: DIAGNOSIS_FINDINGS_TAB, rowNumber, row: table.header.map(() => '') });
      }

      findingCountByProbe.set(probeId, items.length);
      return items.length;
    },

    // Every write this pass accumulated, one per row, ready for
    // repo.writeRowsBatch().
    writes() {
      return [...writesByRow.values()];
    },

    // Total findings rows this pass will leave behind — counted per PROBE, so
    // a probe visited twice counts once, matching what the tab will hold.
    findingsWritten() {
      let total = 0;
      for (const n of findingCountByProbe.values()) total += n;
      return total;
    },
  };
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
