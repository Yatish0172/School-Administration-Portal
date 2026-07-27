'use strict';

const { AppError } = require('./errors');

/**
 * Response shape is fixed: `{ ok: true, data }` or
 * `{ ok: false, error: { code, message } }` (CLAUDE.md code conventions).
 */

function ok(res, data, extra = {}) {
  return res.json({ ok: true, data, ...extra });
}

function fail(res, status, code, message, details = null) {
  const error = { code, message };
  if (details) error.details = details;
  return res.status(status).json({ ok: false, error });
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
function handler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function errorHandler() {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof AppError) {
      return fail(res, err.status, err.code, err.message, err.details);
    }

    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 413, 'FILE_TOO_LARGE', 'That file is too large to upload.');
    }
    if (err && err.type === 'entity.too.large') {
      return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'That request was too large.');
    }
    if (err && err.type === 'entity.parse.failed') {
      return fail(res, 400, 'BAD_JSON', 'The request could not be read. Please try again.');
    }

    // Anything unexpected: log the detail, show the user something calm.
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    return fail(
      res,
      500,
      'SERVER_ERROR',
      'Something went wrong on the server. The problem has been logged — tell the administrator what you were doing.'
    );
  };
}

function notFoundHandler() {
  return (req, res) =>
    fail(res, 404, 'NOT_FOUND', 'That page or action does not exist.');
}

/* ------------------------------------------------------------- input helpers */

/**
 * These return `undefined` when the field was absent from the request and `null`
 * when it was explicitly cleared. The distinction matters: a PUT that sends only
 * `{ city }` must leave the student's name alone, and `crud.pickColumns` skips
 * `undefined` for exactly that reason. Returning null for both would let a partial
 * update wipe every field the client did not mention.
 */
function str(value, { max = 500, trim = true } = {}) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = trim ? String(value).trim() : String(value);
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function num(value, { min = null, max = null } = {}) {
  if (value === undefined) return undefined;
  if (value === '' || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (min !== null && n < min) return min;
  if (max !== null && n > max) return max;
  return n;
}

function bool(value) {
  if (value === undefined) return undefined;
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

/** Same rule as `bool` but for places that need a definite true/false. */
function flag(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function pagination(query) {
  return {
    page: Math.max(1, Number(query.page) || 1),
    pageSize: Math.min(500, Math.max(1, Number(query.pageSize) || 50)),
    search: str(query.search, { max: 100 }) || '',
    sort: str(query.sort, { max: 40 }),
    dir: query.dir === 'desc' ? 'desc' : 'asc',
  };
}

/** Rejects anything that is not a plain object, so `req.body` is always safe to read. */
function body(req) {
  const value = req.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function isoDate(value) {
  if (value === undefined) return undefined;
  const text = str(value, { max: 10 });
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

module.exports = {
  ok,
  fail,
  handler,
  errorHandler,
  notFoundHandler,
  str,
  num,
  bool,
  flag,
  pagination,
  body,
  isoDate,
};
