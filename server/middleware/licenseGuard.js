'use strict';

const license = require('../services/license');
const errors = require('../errors');

/**
 * Write guard for an expired licence (SPEC §18).
 *
 * Export and print routes are never blocked — the school must always be able to
 * get its data out, whatever the licence says. Licence activation itself has to
 * stay reachable too, otherwise an expired copy could never be fixed.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ALWAYS_ALLOWED = [
  /\/export(\/|$)/,
  /\/print(\/|$)/,
  /^\/api\/license(\/|$)/,
  /^\/api\/logout$/,
  /^\/api\/me\/password$/,
  /^\/api\/backup\/run$/,
];

let cached = { at: 0, value: null };
const CACHE_MS = 60000;

async function currentState() {
  if (cached.value && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await license.state();
  cached = { at: Date.now(), value };
  return value;
}

function invalidateCache() {
  cached = { at: 0, value: null };
}

function licenseGuard() {
  return async (req, res, next) => {
    try {
      const state = await currentState();
      req.license = state;

      if (state.canWrite) return next();
      if (!WRITE_METHODS.has(req.method)) return next();
      if (ALWAYS_ALLOWED.some((pattern) => pattern.test(req.path))) return next();

      return next(errors.locked(state.message));
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { licenseGuard, currentState, invalidateCache };
