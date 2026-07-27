'use strict';

const sessions = require('../store/sessions');
const users = require('../store/users');
const devices = require('../store/devices');
const errors = require('../errors');

/**
 * First link in the chain: authenticate -> deviceCheck -> hoursCheck ->
 * permissionCheck -> handler (CLAUDE.md middleware order — do not reorder).
 */

const TOKEN_COOKIE = 'sessionToken';
const DEVICE_COOKIE = 'deviceId';

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

function clientIp(req) {
  const raw = req.socket?.remoteAddress || req.ip || '';
  return raw.replace(/^::ffff:/, '');
}

function isLocalhost(req) {
  const raw = req.socket?.remoteAddress || req.ip || '';
  return LOCAL_ADDRESSES.has(raw) || LOCAL_ADDRESSES.has(clientIp(req));
}

function tokenFrom(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.[TOKEN_COOKIE] || null;
}

/** Populates request context for every request, authenticated or not. */
function context() {
  return (req, res, next) => {
    req.clientIp = clientIp(req);
    req.isLocalhost = isLocalhost(req);
    req.deviceId = req.cookies?.[DEVICE_COOKIE] || null;
    next();
  };
}

/**
 * Requires a live session. Attaches `req.user` (with its permission set),
 * `req.session` and `req.sessionToken`.
 */
function authenticate({ optional = false } = {}) {
  return async (req, res, next) => {
    try {
      const token = tokenFrom(req);
      if (!token) {
        if (optional) return next();
        throw errors.unauthorized('Please sign in to continue.');
      }

      const session = await sessions.get(token);
      if (!session) {
        if (optional) return next();
        clearAuthCookie(res);
        throw errors.unauthorized('Your session has ended. Please sign in again.');
      }

      const record = await users.get(session.userId);
      if (!record || record.status !== 'active') {
        await sessions.destroy(token, 'userDisabled');
        clearAuthCookie(res);
        throw errors.unauthorized('That account is no longer active. Contact the office.');
      }

      req.sessionToken = token;
      req.session = session;
      req.user = await users.withPermissions(record);
      req.deviceId = session.deviceId || req.deviceId;

      sessions.touch(token);
      if (session.deviceId) devices.touch(session.deviceId, req.clientIp);

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * A forced credential change must not leave the rest of the app reachable —
 * the only routes allowed are the ones needed to set a new password.
 */
function blockIfMustChangePassword() {
  const allowed = new Set([
    '/api/me',
    '/api/me/password',
    '/api/logout',
    '/api/hours/state',
    '/api/health',
  ]);
  return (req, res, next) => {
    if (!req.user || !req.user.mustChangePassword) return next();
    if (allowed.has(req.path)) return next();
    if (req.method === 'GET' && req.path === '/api/settings/public') return next();
    return next(
      errors.forbidden('Set a new password before using the portal.')
    );
  };
}

function clearAuthCookie(res) {
  res.clearCookie(TOKEN_COOKIE, { path: '/' });
}

module.exports = {
  TOKEN_COOKIE,
  DEVICE_COOKIE,
  context,
  authenticate,
  blockIfMustChangePassword,
  clientIp,
  isLocalhost,
  clearAuthCookie,
};
