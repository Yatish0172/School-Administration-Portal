'use strict';

const hours = require('../services/hours');
const audit = require('../store/audit');
const errors = require('../errors');

/**
 * Third link: after deviceCheck, before permissionCheck (SPEC §3, T09).
 *
 * Server clock only, Asia/Kolkata hard-coded. The client shows banners from the
 * same state but enforces nothing.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Exports and printing stay allowed in read-only mode (SPEC §3 enforcement) —
 * a school locked out of its own data at 6pm is worse than useless.
 */
const READ_ONLY_ALLOWED = [
  /\/export(\/|$)/,
  /\/print(\/|$)/,
  /\/reports?\//,
  /^\/api\/logout$/,
  /^\/api\/me\/password$/,
  /^\/api\/notices\/[^/]+\/read$/,
  /^\/api\/drafts(\/|$)/,
];

function allowedWhileReadOnly(req) {
  if (!WRITE_METHODS.has(req.method)) return true;
  return READ_ONLY_ALLOWED.some((pattern) => pattern.test(req.path));
}

function hoursCheck() {
  return async (req, res, next) => {
    try {
      if (!req.user) return next();

      const verdict = await hours.accessFor(req.user.roleKey);
      req.hours = verdict.state;
      req.hoursAccess = verdict.access;

      if (verdict.access === 'full') return next();

      if (verdict.access === 'blocked') {
        await audit
          .fromRequest(req, {
            action: audit.ACTIONS.OUT_OF_HOURS_ATTEMPT,
            entityType: 'route',
            entityId: `${req.method} ${req.path}`,
            message: verdict.message,
          })
          .catch(() => {});
        return next(errors.locked(verdict.message));
      }

      // read-only
      if (allowedWhileReadOnly(req)) return next();

      await audit
        .fromRequest(req, {
          action: audit.ACTIONS.OUT_OF_HOURS_ATTEMPT,
          entityType: 'route',
          entityId: `${req.method} ${req.path}`,
          message: 'Write refused — portal is read-only',
        })
        .catch(() => {});

      return next(errors.locked(verdict.message));
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Decides whether a *login* may proceed. Called from the auth route before a
 * session is issued, because a blocked role must never get a token at all.
 */
async function evaluateLogin(roleKey) {
  const verdict = await hours.accessFor(roleKey);
  return {
    allowed: verdict.access !== 'blocked',
    access: verdict.access,
    message: verdict.message,
    state: verdict.state,
  };
}

module.exports = { hoursCheck, evaluateLogin, allowedWhileReadOnly };
