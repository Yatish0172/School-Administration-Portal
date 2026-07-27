'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');

const { paths, ensureDirs } = require('../paths');
const { withLock, withLocks } = require('./lock');
const schema = require('./schema');

/**
 * The one place in the codebase allowed to touch exceljs (CLAUDE.md §1).
 *
 * Everything is served from memory. Writes update memory first, then rewrite the
 * whole workbook to a temp file and rename it over the original — a power cut
 * mid-write leaves the previous good file intact.
 */

/** workbookKey -> { file, sheets: Map<string, Array<object>>, loaded } */
const cache = new Map();

const MAX_ROWS_PER_SHEET = 50000;

/* ---------------------------------------------------------------- coercion */

function coerceOut(value, type) {
  // memory -> Excel cell
  if (value === undefined || value === null || value === '') return null;
  switch (type) {
    case 'num': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'bool':
      return value === true || value === 'true' || value === 1 ? true : false;
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return String(value);
  }
}

function coerceIn(value, type) {
  // Excel cell -> memory
  if (value === undefined || value === null) return type === 'bool' ? false : null;
  if (typeof value === 'object' && value !== null) {
    // exceljs returns rich text / formula / hyperlink objects for some cells.
    if (value.richText) return value.richText.map((r) => r.text).join('');
    if (value.text !== undefined) return value.text;
    if (value.result !== undefined) return value.result;
    if (value instanceof Date) return value.toISOString();
  }
  switch (type) {
    case 'num': {
      if (value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'bool':
      return value === true || value === 'TRUE' || value === 'true' || value === 1;
    case 'json': {
      const raw = String(value);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (err) {
        return raw;
      }
    }
    default: {
      const s = String(value);
      return s === '' ? null : s;
    }
  }
}

/* -------------------------------------------------------------- file layout */

function filePathFor(key) {
  return path.join(paths.data, schema.fileNameFor(key));
}

function emptySheets(key) {
  const { name } = schema.parseWorkbookKey(key);
  const def = schema.WORKBOOKS[name];
  const sheets = new Map();
  for (const sheetName of Object.keys(def.sheets)) {
    sheets.set(sheetName, []);
  }
  return sheets;
}

/* ------------------------------------------------------------------ loading */

async function loadFromDisk(key) {
  const file = filePathFor(key);
  const entry = { key, file, sheets: emptySheets(key), loaded: true };

  if (!fs.existsSync(file)) {
    cache.set(key, entry);
    await persistUnlocked(key);
    return entry;
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(file);
  } catch (err) {
    throw new Error(
      `Could not read ${path.basename(file)}. The file may be corrupt or open in Excel. ` +
        `Close Excel and restart, or restore the most recent backup. (${err.message})`
    );
  }

  for (const ws of wb.worksheets) {
    const sheetName = ws.name;
    if (!schema.hasSheetDef(key, sheetName)) continue; // ignore stray sheets
    const def = schema.sheetDef(key, sheetName);

    const headerRow = ws.getRow(1);
    const headerIndex = new Map();
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const name = String(cell.value || '').trim();
      if (name) headerIndex.set(name, colNumber);
    });

    const rows = [];
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const record = {};
      let empty = true;
      for (const col of def.columns) {
        const colNumber = headerIndex.get(col.name);
        const raw = colNumber ? row.getCell(colNumber).value : null;
        const value = coerceIn(raw, col.type);
        record[col.name] = value;
        if (value !== null && value !== false && value !== '') empty = false;
      }
      if (empty) continue; // trailing blank rows Excel leaves behind
      rows.push(record);
    }
    entry.sheets.set(sheetName, rows);
  }

  cache.set(key, entry);
  return entry;
}

/** Loads every static workbook. Year workbooks are loaded on first touch. */
async function init() {
  ensureDirs();
  for (const name of schema.STATIC_WORKBOOKS) {
    await withLock(name, () => loadFromDisk(name), { label: 'init' });
  }
}

async function ensureLoaded(key) {
  if (cache.has(key)) return cache.get(key);
  return withLock(key, async () => {
    if (cache.has(key)) return cache.get(key);
    return loadFromDisk(key);
  }, { label: 'ensureLoaded' });
}

/* ------------------------------------------------------------------ writing */

async function persistUnlocked(key) {
  const entry = cache.get(key);
  if (!entry) throw new Error(`Workbook ${key} is not loaded`);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'School Admin Portal';
  wb.modified = new Date();

  for (const [sheetName, rows] of entry.sheets) {
    const def = schema.sheetDef(key, sheetName);
    const ws = wb.addWorksheet(sheetName);
    ws.columns = def.columns.map((col) => ({
      header: col.name,
      key: col.name,
      width: columnWidth(col.name),
    }));
    for (const record of rows) {
      const values = {};
      for (const col of def.columns) {
        values[col.name] = coerceOut(record[col.name], col.type);
      }
      ws.addRow(values);
    }
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (rows.length > MAX_ROWS_PER_SHEET) {
      console.warn(
        `[workbook] ${key}/${sheetName} has ${rows.length} rows — over the ${MAX_ROWS_PER_SHEET} cap. Split it.`
      );
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  await atomicWrite(entry.file, buffer);
}

function columnWidth(name) {
  if (name === 'id' || name.endsWith('Id')) return 38;
  if (name === '_rev') return 6;
  if (name.includes('At') || name.includes('Date')) return 22;
  if (name === 'before' || name === 'after' || name === 'body') return 50;
  return Math.max(12, Math.min(28, name.length + 6));
}

/**
 * tmp -> fsync -> rename. Never write in place (CLAUDE.md §4).
 *
 * The rename is retried on Windows lock errors. `rename` over an existing file
 * fails with EPERM or EBUSY whenever anything else holds a handle on the target
 * for a moment — Defender scanning the file that was just written, the Search
 * indexer, a backup agent, or the office having opened the workbook in Excel.
 * These clear in milliseconds, and a school PC rewriting these files hundreds of
 * times a day will hit them. Failing the write instead of waiting would lose a
 * receipt for something that fixes itself.
 */
const RENAME_RETRY_DELAYS_MS = [15, 40, 90, 180, 350, 700];

async function atomicWrite(file, buffer) {
  const tmp = `${file}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }

  let lastError = null;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      if (attempt > 0) {
        console.warn(
          `[workbook] ${path.basename(file)} was locked; the write succeeded on attempt ${attempt + 1}`
        );
      }
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      lastError = err;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  await fsp.rm(tmp, { force: true }).catch(() => {});
  throw new Error(
    `Could not save ${path.basename(file)} — the file is being held open by another program. ` +
      'If it is open in Excel, close it. Otherwise a backup or antivirus tool may be scanning it; ' +
      `try again in a moment. (${lastError ? lastError.code : 'unknown'})`
  );
}

/**
 * The only supported write path. `fn` receives helpers that mutate memory; the
 * workbook is persisted once when `fn` resolves, so a bulk operation costs one
 * disk write rather than one per row.
 */
async function mutate(key, fn, options = {}) {
  return mutateMany([key], (api) => fn(api[key]), {
    ...options,
    label: options.label || 'mutate',
  });
}

function cloneSheets(sheets) {
  const copy = new Map();
  for (const [name, rows] of sheets) {
    copy.set(name, rows.map((r) => ({ ...r })));
  }
  return copy;
}

/**
 * Mutate several workbooks under all their locks, persisting each at the end.
 *
 * `options.hooks` lets journal.js snapshot files inside the locked region and
 * restore them if a persist fails part-way through a multi-workbook write —
 * memory rollback alone is not enough once bytes have hit disk.
 */
async function mutateMany(keys, fn, options = {}) {
  const ordered = [...new Set(keys)].sort();
  for (const key of ordered) await ensureLoaded(key);

  const hooks = options.hooks || {};

  return withLocks(
    ordered,
    async () => {
      const snapshots = new Map();
      for (const key of ordered) {
        snapshots.set(key, cloneSheets(cache.get(key).sheets));
      }
      let hookState = null;
      try {
        const api = {};
        for (const key of ordered) api[key] = sheetApi(key);
        const result = await fn(api);

        // The file snapshot is taken here, not before `fn`, because nothing has
        // touched the disk yet — `fn` only mutates memory. A validation error
        // therefore needs no disk rollback and leaves no journal folder behind.
        if (hooks.before) hookState = await hooks.before(ordered);
        for (const key of ordered) await persistUnlocked(key);
        if (hooks.afterPersist) await hooks.afterPersist(hookState);
        return result;
      } catch (err) {
        for (const key of ordered) {
          cache.get(key).sheets = snapshots.get(key);
        }
        // Only a failure during persistence can have left half-written files.
        if (hookState && hooks.onError) await hooks.onError(hookState, err);
        throw err;
      }
    },
    { label: options.label || 'mutateMany' }
  );
}

/* -------------------------------------------------------------- sheet access */

function sheetRows(key, sheetName, { create = false } = {}) {
  const entry = cache.get(key);
  if (!entry) throw new Error(`Workbook ${key} is not loaded — call ensureLoaded first`);
  if (!entry.sheets.has(sheetName)) {
    if (!schema.hasSheetDef(key, sheetName)) {
      throw new Error(`Unknown sheet ${sheetName} in ${key}`);
    }
    if (!create) return [];
    entry.sheets.set(sheetName, []);
  }
  return entry.sheets.get(sheetName);
}

function sheetApi(key) {
  return {
    key,
    rows: (sheetName) => sheetRows(key, sheetName, { create: true }),
    replace: (sheetName, rows) => {
      cache.get(key).sheets.set(sheetName, rows);
    },
    sheetNames: () => [...cache.get(key).sheets.keys()],
  };
}

/**
 * Mutates memory under the lock but leaves persistence to a later `flush`.
 * Only for high-frequency insert-only writes (the audit log), where persisting
 * the whole workbook per event would dominate request time. Everything else must
 * use `mutate`, which is write-through.
 */
async function mutateDeferred(key, fn, options = {}) {
  await ensureLoaded(key);
  return withLock(
    key,
    async () => {
      const entry = cache.get(key);
      const result = await fn(sheetApi(key));
      entry.dirty = true;
      return result;
    },
    { label: options.label || 'mutateDeferred' }
  );
}

async function flush(key) {
  const entry = cache.get(key);
  if (!entry || !entry.dirty) return false;
  return withLock(
    key,
    async () => {
      const current = cache.get(key);
      if (!current || !current.dirty) return false;
      await persistUnlocked(key);
      current.dirty = false;
      return true;
    },
    { label: 'flush' }
  );
}

/** Reads are lock-free and served from memory. Returns a live array — do not mutate. */
async function read(key, sheetName) {
  await ensureLoaded(key);
  return sheetRows(key, sheetName);
}

async function sheetNames(key) {
  await ensureLoaded(key);
  return [...cache.get(key).sheets.keys()];
}

function loadedKeys() {
  return [...cache.keys()];
}

function fileFor(key) {
  return filePathFor(key);
}

/** Used by the backup service, which needs every workbook on disk to be current. */
async function flushAll() {
  for (const key of cache.keys()) {
    await withLock(
      key,
      async () => {
        await persistUnlocked(key);
        const entry = cache.get(key);
        if (entry) entry.dirty = false;
      },
      { label: 'flushAll' }
    );
  }
}

/** Drops the in-memory cache so the next read comes from disk. Used after restore. */
function invalidateAll() {
  cache.clear();
}

/**
 * Holds every loaded workbook's lock, flushes them all to disk, then runs `fn`.
 * This is how backup gets a consistent set of files (SPEC §16) — no write can
 * land between the flush and the copy.
 */
async function withAllLocksFlushed(fn) {
  const keys = [...cache.keys()].sort();
  return withLocks(
    keys,
    async () => {
      for (const key of keys) {
        await persistUnlocked(key);
        const entry = cache.get(key);
        if (entry) entry.dirty = false;
      }
      return fn(keys);
    },
    { label: 'withAllLocksFlushed' }
  );
}

module.exports = {
  init,
  ensureLoaded,
  read,
  mutate,
  mutateMany,
  mutateDeferred,
  flush,
  sheetNames,
  loadedKeys,
  fileFor,
  flushAll,
  invalidateAll,
  withAllLocksFlushed,
  MAX_ROWS_PER_SHEET,
};
