// lib/pipeline-snapshot.mjs — an INVOCATION-SCOPED read cache in front of the
// Sheets repo.
//
// THE PROBLEM IT REMOVES. One nightly pass used to download the same tabs over
// and over: PROBES five times, INTELLIGENCE four, PERSONALISATION three,
// DIAGNOSIS_FINDINGS three, AGENCIES three — because every stage was written to
// be independently correct and therefore batch-loaded everything it needed for
// itself. That is roughly 25 full-tab reads before the ACTIONS reconciler adds
// its own, on a Sheets quota that is per-minute and shared with the live UI.
//
// THE FIX, AND ITS LIMITS. This wrapper memoises getTable() per invocation and
// keeps the memo CONSISTENT WITH WRITES: every write path a pipeline stage uses
// (writeRowsBatch, appendRowsBatch, writeCellsBatch, appendRecord, updateById,
// updateCell) is applied to the cached rows as well as to the sheet, so a later
// stage reading the same tab sees what the earlier stage just wrote. A tab
// touched by a write path this module does NOT model is evicted rather than
// guessed at.
//
// IT IS DELIBERATELY NOT A GLOBAL CACHE. One instance per HTTP invocation,
// created by the handler, discarded when the response is sent. Nothing is
// shared between requests, so a warm serverless container can never serve a
// stale row to the next caller — the single most dangerous thing a cache could
// do to a Sheets-backed pipeline.

const colLetter = (n) => {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

function tabOf(range) {
  return String(range ?? '').split('!')[0];
}

export function createSnapshotRepo(repo) {
  // tab -> { header, rows, allValues } | Promise of it. Errors are cached too
  // (as a rejected marker) so a missing optional tab is not re-requested by
  // every stage that probes for it.
  const tables = new Map();
  const stats = { sheets_read_count: 0, sheets_write_request_count: 0, cache_hits: 0 };

  function snapshotOf(tab) {
    return tables.get(tab) || null;
  }

  // Sheets trims trailing empty rows on read, so a snapshot's row array can be
  // shorter than the row number a write targets. Grow it rather than leaving a
  // hole a later read would mis-index.
  function ensureRow(snapshot, rowNumber) {
    const index = rowNumber - 2;
    while (snapshot.rows.length <= index) snapshot.rows.push([]);
    return index;
  }

  function applyRowWrite(tab, rowNumber, row) {
    const snapshot = snapshotOf(tab);
    if (!snapshot) return;
    const index = ensureRow(snapshot, rowNumber);
    snapshot.rows[index] = [...row];
    snapshot.allValues = [snapshot.header, ...snapshot.rows];
  }

  function applyCellWrite(tab, rowNumber, columnNumber, value) {
    const snapshot = snapshotOf(tab);
    if (!snapshot) return;
    const index = ensureRow(snapshot, rowNumber);
    const row = [...(snapshot.rows[index] || [])];
    while (row.length < columnNumber) row.push('');
    row[columnNumber - 1] = value;
    snapshot.rows[index] = row;
    snapshot.allValues = [snapshot.header, ...snapshot.rows];
  }

  function applyAppend(tab, rows) {
    const snapshot = snapshotOf(tab);
    if (!snapshot) return;
    for (const row of rows) snapshot.rows.push([...row]);
    snapshot.allValues = [snapshot.header, ...snapshot.rows];
  }

  function evict(tab) {
    tables.delete(tab);
  }

  function rowObject(header, row) {
    return Object.fromEntries(header.map((key, i) => [key, row[i] ?? '']));
  }

  const snapshotRepo = {
    // ── reads ────────────────────────────────────────────────────────────────
    async getTable(tab) {
      if (tables.has(tab)) {
        stats.cache_hits += 1;
        const cached = tables.get(tab);
        return cached instanceof Promise ? cached : cached;
      }
      const pending = (async () => {
        const table = await repo.getTable(tab);
        const materialised = {
          header: table.header || [],
          rows: (table.rows || []).map((row) => [...row]),
          allValues: table.allValues || [],
        };
        tables.set(tab, materialised);
        return materialised;
      })();
      // Cache the in-flight promise so two stages loading the same tab in
      // parallel (Promise.all over tabs) share ONE request rather than racing.
      tables.set(tab, pending);
      stats.sheets_read_count += 1;
      try {
        return await pending;
      } catch (err) {
        tables.delete(tab);
        throw err;
      }
    },

    async getRecords(tab, idColumn) {
      const { header, rows } = await this.getTable(tab);
      const idIdx = header.indexOf(idColumn);
      const out = [];
      rows.forEach((row, i) => {
        const idVal = idIdx >= 0 ? (row[idIdx] ?? '') : '';
        if (!idVal || idVal === 'SCHEMA NOTE') return;
        out.push({ index: i, rowNumber: i + 2, obj: rowObject(header, row) });
      });
      return out;
    },

    async findById(tab, idColumn, idValue) {
      const records = await this.getRecords(tab, idColumn);
      return records.find((r) => r.obj[idColumn] === idValue) || null;
    },

    async count(tab, idColumn) {
      return (await this.getRecords(tab, idColumn)).length;
    },

    // ── writes (sheet first, then the snapshot) ──────────────────────────────
    async writeRowsBatch(writes, chunkSize) {
      const list = writes || [];
      if (!list.length) return;
      await repo.writeRowsBatch(list, chunkSize);
      stats.sheets_write_request_count += Math.ceil(list.length / (chunkSize || 200));
      for (const { tab, rowNumber, row } of list) applyRowWrite(tab, rowNumber, row);
    },

    async writeCellsBatch(writes, chunkSize) {
      const list = writes || [];
      if (!list.length) return;
      await repo.writeCellsBatch(list, chunkSize);
      stats.sheets_write_request_count += Math.ceil(list.length / (chunkSize || 200));
      for (const { tab, rowNumber, columnNumber, value } of list) applyCellWrite(tab, rowNumber, columnNumber, value);
    },

    async appendRowsBatch(tab, rows, chunkSize) {
      const list = rows || [];
      if (!list.length) return;
      await repo.appendRowsBatch(tab, list, chunkSize);
      stats.sheets_write_request_count += Math.ceil(list.length / (chunkSize || 200));
      applyAppend(tab, list);
    },

    // ── single-record writes ─────────────────────────────────────────────────
    //
    // These three DELEGATE to the underlying repo rather than reimplementing
    // its merge and its choice of Sheets primitive. That matters for two
    // reasons: the base repo deliberately writes a single cell for updateCell
    // (so a neighbouring formula column is never replaced by its last computed
    // text), and a transport that does not implement values.batchUpdate — an
    // in-memory fixture, say — must keep working exactly as it did. The
    // snapshot is then refreshed from the result, so a later read sees the
    // write.
    async appendRecord(tab, obj) {
      const result = await repo.appendRecord(tab, obj);
      stats.sheets_write_request_count += 1;
      const snapshot = snapshotOf(tab);
      if (snapshot) applyAppend(tab, [snapshot.header.map((key) => (obj[key] ?? ''))]);
      return result;
    },

    async updateById(tab, idColumn, idValue, patch) {
      const merged = await repo.updateById(tab, idColumn, idValue, patch);
      stats.sheets_write_request_count += 1;
      if (merged === null) return null;
      const snapshot = snapshotOf(tab);
      if (snapshot) {
        const record = (await this.getRecords(tab, idColumn)).find((r) => r.obj[idColumn] === idValue);
        if (record) applyRowWrite(tab, record.rowNumber, snapshot.header.map((key) => (merged[key] ?? '')));
        else evict(tab);
      }
      return merged;
    },

    async updateCell(tab, idColumn, idValue, columnName, value) {
      const written = await repo.updateCell(tab, idColumn, idValue, columnName, value);
      stats.sheets_write_request_count += 1;
      if (!written) return written;
      const snapshot = snapshotOf(tab);
      if (snapshot) {
        const colIdx = snapshot.header.indexOf(columnName);
        const record = (await this.getRecords(tab, idColumn)).find((r) => r.obj[idColumn] === idValue);
        if (colIdx >= 0 && record) applyCellWrite(tab, record.rowNumber, colIdx + 1, value);
        else evict(tab);
      }
      return written;
    },

    // Physical row deletion renumbers everything below it — the one operation
    // this snapshot cannot model. Evict and let the next read be honest.
    async deleteRows(tab, rowNumbers) {
      const result = await repo.deleteRows(tab, rowNumbers);
      stats.sheets_write_request_count += 1;
      evict(tab);
      return result;
    },

    // ── introspection ────────────────────────────────────────────────────────
    snapshotStats() {
      return { ...stats, tabs_cached: tables.size };
    },
    invalidate(tab) { evict(tab); },
  };

  return snapshotRepo;
}

// True for a repo already wrapped — handlers can wrap unconditionally without
// stacking two caches (and two divergent copies of the same rows).
export function isSnapshotRepo(repo) {
  return typeof repo?.snapshotStats === 'function';
}

export function asSnapshotRepo(repo) {
  return isSnapshotRepo(repo) ? repo : createSnapshotRepo(repo);
}
