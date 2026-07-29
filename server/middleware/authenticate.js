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

function socketIp(req) {
  const raw = req.socket?.remoteAddress || req.ip || '';
  return raw.replace(/^::ffff:/, '');
}

/** Did the connection itself come from this machine? */
function socketIsLocal(req) {
  const raw = req.socket?.remoteAddress || req.ip || '';
  return LOCAL_ADDRESSES.has(raw) || LOCAL_ADDRESSES.has(socketIp(req));
}

function hasForwardingHeaders(req) {
  return !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']);
}

/**
 * True when the request came in through the Cloudflare tunnel rather than off the
 * LAN.
 *
 * This matters more than it looks. `cloudflared` runs on the server PC and proxies
 * to localhost, so every remote visitor arrives with a socket address of 127.0.0.1
 * — which the app otherwise treats as "sitting at the server PC" and therefore
 * exempt from device enrollment. Without this check, switching the tunnel on would
 * silently let anyone with the link sign in from any device.
 *
 * The forwarding headers are only believed when the socket is genuinely loopback,
 * which is the only way real tunnel traffic can arrive. A device on the school
 * Wi-Fi sending its own `x-forwarded-for` is ignored, so it cannot forge the
 * address recorded against its actions in the audit log.
 */
function isTunnelled(req) {
  return socketIsLocal(req) && hasForwardingHeaders(req);
}

/** The visitor's own address: through the tunnel that is the Cloudflare header. */
function clientIp(req) {
  if (isTunnelled(req)) {
    const forwarded = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return socketIp(req);
}

/**
 * Only a browser physically on the server PC counts as localhost. A tunnelled
 * request never does, however local its socket looks.
 */
function isLocalhost(req) {
  return socketIsLocal(req) && !isTunnelled(req);
}

/** Cloudflare terminates TLS, so cookies must be marked secure for tunnel traffic. */
function isSecureRequest(req) {
  if (req.secure) return true;
  if (!isTunnelled(req)) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
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
    req.viaTunnel = isTunnelled(req);
    req.isLocalhost = isLocalhost(req);
    req.isSecure = isSecureRequest(req);
    req.deviceId = req.cookies?.[DEVICE_COOKIE] || null;
    next();
  };
}

/**
 * Cookie flags for this request. Over the tunnel the connection is HTTPS at
 * Cloudflare's edge, so the cookie is marked secure; on the LAN it is plain HTTP
 * and marking it secure would stop it being stored at all.
 */
function cookieOptions(req, extra = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: req.isSecure === true,
    ...extra,
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
  isTunnelled,
  isSecureRequest,
  cookieOptions,
  clearAuthCookie,
};
