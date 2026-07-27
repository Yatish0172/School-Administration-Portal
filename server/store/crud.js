'use strict';

const crypto = require('crypto');

const workbook = require('./workbook');
const { sheetDef } = require('./schema');
const errors = require('../errors');

/**
 * Generic row operations every repository builds on. Enforces the two rules that
 * are easy to forget per-module: `_rev` optimistic concurrency and the
 * createdBy/createdAt/updatedBy/updatedAt stamps.
 */

function newId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function actorOf(ctx) {
  if (!ctx) return 'system';
  return ctx.userId || ctx.user?.id || 'system';
}

/** Drops unknown keys so a client cannot inject columns that are not in the schema. */
function pickColumns(key, sheet, data) {
  const def = sheetDef(key, sheet);
  const out = {};
  const reserved = new Set([
    'id',
    '_rev',
    'createdBy',
    'createdAt',
    'updatedBy',
    'updatedAt',
  ]);
  for (const col of def.columns) {
    if (reserved.has(col.name)) continue;
    if (!Object.prototype.hasOwnProperty.call(data, col.name)) continue;
    // `undefined` means "not supplied", so a partial update leaves the stored
    // value alone. An explicit null still clears the field.
    if (data[col.name] === undefined) continue;
    out[col.name] = normalise(data[col.name], col.type);
  }
  return out;
}

function normalise(value, type) {
  if (value === undefined) return undefined;
  if (value === '' ) return type === 'bool' ? false : null;
  if (value === null) return type === 'bool' ? false : null;
  if (type === 'num') {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n;
  }
  if (type === 'bool') {
    return value === true || value === 'true' || value === 1 || value === '1';
  }
  if (type === 'text') return String(value).trim();
  return value;
}

/**
 * Strips keys whose value is `undefined` so a patch can be merged over a stored
 * row for validation without absent fields clobbering what is already there.
 */
function defined(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function blankRow(key, sheet) {
  const def = sheetDef(key, sheet);
  const row = {};
  for (const col of def.columns) {
    row[col.name] = col.type === 'bool' ? false : null;
  }
  return row;
}

/* --------------------------------------------------------------------- reads */

async function all(key, sheet) {
  return workbook.read(key, sheet);
}

async function find(key, sheet, predicate) {
  const rows = await workbook.read(key, sheet);
  return predicate ? rows.filter(predicate) : rows.slice();
}

async function findOne(key, sheet, predicate) {
  const rows = await workbook.read(key, sheet);
  return rows.find(predicate) || null;
}

async function get(key, sheet, id) {
  if (!id) return null;
  return findOne(key, sheet, (r) => r.id === id);
}

async function getOrFail(key, sheet, id, label = 'record') {
  const row = await get(key, sheet, id);
  if (!row) throw errors.notFound(`That ${label} could not be found.`);
  return row;
}

async function exists(key, sheet, predicate) {
  return (await findOne(key, sheet, predicate)) !== null;
}

/**
 * Paginated listing with optional filtering, free-text search and sorting.
 * Applied in memory — every read is already in memory (CLAUDE.md §2).
 */
async function list(key, sheet, options = {}) {
  const {
    where = null,
    search = '',
    searchFields = [],
    sort = null,
    dir = 'asc',
    page = 1,
    pageSize = 50,
  } = options;

  let rows = await workbook.read(key, sheet);
  rows = where ? rows.filter(where) : rows.slice();

  const term = String(search || '').trim().toLowerCase();
  if (term && searchFields.length) {
    rows = rows.filter((row) =>
      searchFields.some((field) =>
        String(row[field] ?? '')
          .toLowerCase()
          .includes(term)
      )
    );
  }

  if (sort) {
    const factor = dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => compareValues(a[sort], b[sort]) * factor);
  }

  const total = rows.length;
  const size = pageSize === 0 ? total : Math.max(1, Number(pageSize) || 50);
  const pages = size ? Math.max(1, Math.ceil(total / size)) : 1;
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * size;

  return {
    rows: pageSize === 0 ? rows : rows.slice(start, start + size),
    total,
    page: current,
    pageSize: size,
    pages,
  };
}

function compareValues(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/* -------------------------------------------------------------------- writes */

/** Builds the row in memory. Caller must already hold the workbook lock. */
function insertInto(api, key, sheet, data, ctx) {
  const rows = api.rows(sheet);
  const row = {
    ...blankRow(key, sheet),
    ...pickColumns(key, sheet, data),
    id: data.id || newId(),
    _rev: 1,
    createdBy: actorOf(ctx),
    createdAt: nowIso(),
    updatedBy: actorOf(ctx),
    updatedAt: nowIso(),
  };
  rows.push(row);
  return row;
}

async function create(key, sheet, data, ctx, options = {}) {
  return workbook.mutate(
    key,
    (api) => insertInto(api, key, sheet, data, ctx),
    { label: options.label || `create ${sheet}` }
  );
}

async function createMany(key, sheet, records, ctx, options = {}) {
  return workbook.mutate(
    key,
    (api) => records.map((data) => insertInto(api, key, sheet, data, ctx)),
    { label: options.label || `createMany ${sheet}` }
  );
}

/** Applies a patch in memory. Caller must already hold the workbook lock. */
function updateIn(api, key, sheet, id, patch, ctx, options = {}) {
  const rows = api.rows(sheet);
  const index = rows.findIndex((r) => r.id === id);
  if (index === -1) {
    throw errors.notFound(`That ${options.label || 'record'} could not be found.`);
  }
  const current = rows[index];

  const expected = options.expectedRev;
  if (expected !== undefined && expected !== null && expected !== '') {
    if (Number(expected) !== Number(current._rev)) throw errors.conflict();
  }

  const next = {
    ...current,
    ...pickColumns(key, sheet, patch),
    id: current.id,
    _rev: Number(current._rev || 1) + 1,
    createdBy: current.createdBy,
    createdAt: current.createdAt,
    updatedBy: actorOf(ctx),
    updatedAt: nowIso(),
  };
  rows[index] = next;
  return { before: current, after: next };
}

async function update(key, sheet, id, patch, ctx, options = {}) {
  return workbook.mutate(
    key,
    (api) => updateIn(api, key, sheet, id, patch, ctx, options),
    { label: options.label || `update ${sheet}` }
  );
}

/** Status change instead of deletion — nothing is ever hard-deleted. */
async function setStatus(key, sheet, id, status, ctx, options = {}) {
  return update(key, sheet, id, { status }, ctx, options);
}

/**
 * Replaces every row matching `where` with the given patch. Used for operations
 * like "revoke all devices for this user" that must land in one disk write.
 */
async function updateWhere(key, sheet, where, patch, ctx, options = {}) {
  return workbook.mutate(
    key,
    (api) => {
      const rows = api.rows(sheet);
      const changed = [];
      for (let i = 0; i < rows.length; i += 1) {
        if (!where(rows[i])) continue;
        const current = rows[i];
        rows[i] = {
          ...current,
          ...pickColumns(key, sheet, patch),
          id: current.id,
          _rev: Number(current._rev || 1) + 1,
          createdBy: current.createdBy,
          createdAt: current.createdAt,
          updatedBy: actorOf(ctx),
          updatedAt: nowIso(),
        };
        changed.push(rows[i]);
      }
      return changed;
    },
    { label: options.label || `updateWhere ${sheet}` }
  );
}

module.exports = {
  newId,
  nowIso,
  actorOf,
  pickColumns,
  defined,
  blankRow,
  all,
  find,
  findOne,
  get,
  getOrFail,
  exists,
  list,
  create,
  createMany,
  update,
  updateWhere,
  setStatus,
  insertInto,
  updateIn,
  compareValues,
};
