'use strict';

const crypto = require('crypto');
const errors = require('../errors');

/**
 * CSRF token on every state-changing request (CLAUDE.md security rules).
 *
 * The token belongs to the session and is handed to the client by /api/login and
 * /api/me. It travels in a header, so a cross-site form post cannot carry it even
 * though the session cookie would be sent automatically.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HEADER = 'x-csrf-token';

/** Routes that legitimately have no session yet. */
const EXEMPT = [/^\/api\/login$/, /^\/api\/logout$/, /^\/api\/health$/];

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function csrf() {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (EXEMPT.some((pattern) => pattern.test(req.path))) return next();
    if (!req.session) return next(); // authenticate will have already refused

    const supplied = req.get(HEADER) || req.body?._csrf;
    if (!supplied || !safeEqual(supplied, req.session.csrfToken)) {
      return next(
        errors.forbidden('Your page is out of date. Reload the portal and try again.')
      );
    }
    return next();
  };
}

module.exports = { csrf, HEADER };
