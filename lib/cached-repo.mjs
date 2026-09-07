// Request-scoped write-through cache for the Sheets repository.
//
// A NOVUS rebuild is a pipeline over the same handful of tabs. Each stage used
// to call repo.getTable() independently, so one serverless invocation could
// download PROBES / INTELLIGENCE / PERSONALISATION / OUTBOUND several times.
// This wrapper keeps one in-memory copy per tab for the lifetime of the request
// and mirrors writes into that copy. It changes no persistence semantics: the
// underlying repo remains the only object that talks to Google Sheets.

const CACHE_MARK = Symbol.for('novus.cachedRepo');

function cloneRow(row) {
  return Array.isArray(row) ? row.slice() : [];
}

function cloneTable(table = {}) {
  const header = cloneRow(table.header || []);
  const rows = (table.rows || []).map(cloneRow);
  return {
    header,
    rows,
    allValues: [header, ...rows].map(cloneRow),
  };
}

function rowObject(header, row) {
  return Object.fromEntries((header || []).map((key, index) => [key, row?.[index] ?? '']));
}

function realRecord(table, idColumn, idValue = undefined) {
  const idIndex = table.header.indexOf(idColumn);
  if (idIndex < 0) return idValue === undefined ? [] : null;
  const records = [];
  for (let index = 0; index < table.rows.length; index += 1) {
    const raw = table.rows[index]?.[idIndex] ?? '';
    if (!raw || raw === 'SCHEMA NOTE') continue;
    const record = {
      index,
      rowNumber: index + 2,
      obj: rowObject(table.header, table.rows[index]),
    };
    if (idValue !== undefined && record.obj[idColumn] === idValue) return record;
    records.push(record);
  }
  return idValue === undefined ? records : null;
}

function refreshAllValues(table) {
  table.allValues = [table.header, ...table.rows].map(cloneRow);
}

export function createCachedRepo(baseRepo) {
  if (!baseRepo || baseRepo[CACHE_MARK]) return baseRepo;

  const cache = new Map();

  async function getTable(tab) {
    if (!cache.has(tab)) {
      cache.set(tab, Promise.resolve(baseRepo.getTable(tab)).then(cloneTable));
    }
    return cache.get(tab);
  }

  async function cachedIfPresent(tab) {
    if (!cache.has(tab)) return null;
    return cache.get(tab);
  }

  const overrides = {
    [CACHE_MARK]: true,

    getTable,

    async getRecords(tab, idColumn) {
      return realRecord(await getTable(tab), idColumn);
    },

    async findById(tab, idColumn, idValue) {
      return realRecord(await getTable(tab), idColumn, idValue);
    },

    async count(tab, idColumn) {
      return (await overrides.getRecords(tab, idColumn)).length;
    },

    async appendRowsBatch(tab, rows, chunkSize = 200) {
      const safeRows = (rows || []).map(cloneRow);
      await baseRepo.appendRowsBatch(tab, safeRows, chunkSize);
      const table = await cachedIfPresent(tab);
      if (table && safeRows.length) {
        table.rows.push(...safeRows.map(cloneRow));
        refreshAllValues(table);
      }
    },

    async appendRecord(tab, obj) {
      const table = await getTable(tab);
      const row = table.header.map((key) => obj?.[key] ?? '');
      await baseRepo.appendRowsBatch(tab, [row]);
      table.rows.push(cloneRow(row));
      refreshAllValues(table);
      return obj;
    },

    async writeRowsBatch(writes, chunkSize = 200) {
      const safeWrites = (writes || []).map((write) => ({ ...write, row: cloneRow(write.row) }));
      await baseRepo.writeRowsBatch(safeWrites, chunkSize);
      const touched = new Set();
      for (const write of safeWrites) {
        const table = await cachedIfPresent(write.tab);
        if (!table) continue;
        const index = Number(write.rowNumber) - 2;
        if (!Number.isInteger(index) || index < 0) continue;
        while (table.rows.length <= index) table.rows.push([]);
        table.rows[index] = cloneRow(write.row);
        touched.add(write.tab);
      }
      for (const tab of touched) refreshAllValues(await cache.get(tab));
    },

    async writeCellsBatch(writes, chunkSize = 200) {
      const safeWrites = (writes || []).map((write) => ({ ...write }));
      await baseRepo.writeCellsBatch(safeWrites, chunkSize);
      const touched = new Set();
      for (const write of safeWrites) {
        const table = await cachedIfPresent(write.tab);
        if (!table) continue;
        const rowIndex = Number(write.rowNumber) - 2;
        const columnIndex = Number(write.columnNumber) - 1;
        if (!Number.isInteger(rowIndex) || rowIndex < 0 || !Number.isInteger(columnIndex) || columnIndex < 0) continue;
        while (table.rows.length <= rowIndex) table.rows.push([]);
        while (table.rows[rowIndex].length <= columnIndex) table.rows[rowIndex].push('');
        table.rows[rowIndex][columnIndex] = write.value;
        touched.add(write.tab);
      }
      for (const tab of touched) refreshAllValues(await cache.get(tab));
    },

    async updateById(tab, idColumn, idValue, patch) {
      const table = await getTable(tab);
      const record = realRecord(table, idColumn, idValue);
      if (!record) return null;
      const merged = { ...record.obj, ...patch };
      const row = table.header.map((key) => merged[key] ?? '');
      await overrides.writeRowsBatch([{ tab, rowNumber: record.rowNumber, row }]);
      return merged;
    },

    async updateCell(tab, idColumn, idValue, columnName, value) {
      const table = await getTable(tab);
      const columnIndex = table.header.indexOf(columnName);
      if (columnIndex < 0) return false;
      const record = realRecord(table, idColumn, idValue);
      if (!record) return false;
      await overrides.writeCellsBatch([{
        tab,
        rowNumber: record.rowNumber,
        columnNumber: columnIndex + 1,
        value,
      }]);
      return true;
    },

    async deleteRows(tab, rowNumbers) {
      if (typeof baseRepo.deleteRows !== 'function') {
        throw new Error('Underlying repository does not support deleteRows');
      }
      await baseRepo.deleteRows(tab, rowNumbers);
      const table = await cachedIfPresent(tab);
      if (table) {
        const indexes = [...new Set(rowNumbers || [])]
          .map((rowNumber) => Number(rowNumber) - 2)
          .filter((index) => Number.isInteger(index) && index >= 0)
          .sort((a, b) => b - a);
        for (const index of indexes) {
          if (index < table.rows.length) table.rows.splice(index, 1);
        }
        refreshAllValues(table);
      }
    },
  };

  return new Proxy(baseRepo, {
    get(target, property) {
      if (property === CACHE_MARK) return true;
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
