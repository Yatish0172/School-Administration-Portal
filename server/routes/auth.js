'use strict';

const express = require('express');

const { ok, handler, body, str } = require('../http');
const users = require('../store/users');
const sessions = require('../store/sessions');
const devices = require('../store/devices');
const audit = require('../store/audit');
const settings = require('../store/settings');
const permissions = require('../store/permissions');
const academics = require('../store/academics');
const hours = require('../services/hours');
const license = require('../services/license');
const { evaluateLogin } = require('../middleware/hoursCheck');
const { rateLimit } = require('../middleware/rateLimit');
const { TOKEN_COOKIE, DEVICE_COOKIE, authenticate, clearAuthCookie } = require('../middleware/authenticate');
const errors = require('../errors');

const router = express.Router();

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
};

/** Device cookies are deliberately long-lived: enrolling once should last. */
const DEVICE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 5 * 365 * 24 * 3600 * 1000,
};

/**
 * POST /api/login
 *
 * Order matters: credentials, then device, then hours. A blocked role must never
 * receive a session token, so the hours check happens before the session is made.
 */
router.post(
  '/login',
  rateLimit({ windowMs: 60000, max: 15, message: 'Too many sign-in attempts. Wait a minute and try again.' }),
  handler(async (req, res) => {
    const input = body(req);
    const username = str(input.username, { max: 64 });
    const secret = input.secret ? String(input.secret) : '';
    const enrollmentCode = str(input.enrollmentCode, { max: 32 });
    const deviceName = str(input.deviceName, { max: 60 });

    if (!username || !secret) {
      throw errors.badRequest('Enter your username and password.');
    }

    const verdict = await users.verifyCredential(username, secret);

    if (!verdict.ok) {
      await audit.log({
        action:
          verdict.reason === 'justLocked' || verdict.reason === 'locked'
            ? audit.ACTIONS.LOGIN_LOCKED
            : audit.ACTIONS.LOGIN_FAILED,
        actor: verdict.user
          ? { id: verdict.user.id, name: verdict.user.name, roleKey: verdict.user.roleKey }
          : null,
        userName: username,
        ip: req.clientIp,
        deviceId: req.deviceId,
        entityType: 'user',
        entityId: verdict.user?.id || null,
        message: describeFailure(verdict, username),
        flush: verdict.reason === 'justLocked',
      });

      if (verdict.reason === 'locked' || verdict.reason === 'justLocked') {
        throw errors.tooMany(
          `Too many wrong attempts. This account is locked for ${verdict.lockedMinutes} minutes. Contact the office if you need it sooner.`
        );
      }
      if (verdict.reason === 'disabled') {
        throw errors.unauthorized('That account has been disabled. Contact the office.');
      }
      throw errors.unauthorized('That username or password is not correct.');
    }

    const user = verdict.user;

    // --- device -------------------------------------------------------------
    let deviceId = req.deviceId;
    let device = null;
    const deviceVerdict = await devices.evaluate({
      deviceId,
      userId: user.id,
      isLocalhost: req.isLocalhost,
    });

    if (!deviceVerdict.allowed) {
      if (!enrollmentCode) {
        await audit.log({
          action: audit.ACTIONS.DEVICE_REFUSED,
          actor: { id: user.id, name: user.name, roleKey: user.roleKey },
          ip: req.clientIp,
          deviceId,
          entityType: 'device',
          entityId: deviceId,
          message: `Login refused: ${deviceVerdict.reason}`,
        });
        throw errors.forbidden(devices.REFUSAL_MESSAGE);
      }

      device = await devices.redeemCode(enrollmentCode, user.id, {
        deviceId: deviceId || devices.newDeviceId(),
        deviceName,
        userAgent: req.get('user-agent'),
        ip: req.clientIp,
        deviceCap: user.deviceCap,
      });
      deviceId = device.deviceId;

      await audit.log({
        action: audit.ACTIONS.DEVICE_ENROLLED,
        actor: { id: user.id, name: user.name, roleKey: user.roleKey },
        ip: req.clientIp,
        deviceId,
        entityType: 'device',
        entityId: device.id,
        after: { name: device.name, os: device.os, browser: device.browser },
        message: `Device "${device.name}" enrolled`,
      });
    } else {
      device = deviceVerdict.device;
      if (device) deviceId = device.deviceId;
    }

    // --- school hours -------------------------------------------------------
    const hoursVerdict = await evaluateLogin(user.roleKey);
    if (!hoursVerdict.allowed) {
      await audit.log({
        action: audit.ACTIONS.LOGIN_OUT_OF_HOURS,
        actor: { id: user.id, name: user.name, roleKey: user.roleKey },
        ip: req.clientIp,
        deviceId,
        entityType: 'user',
        entityId: user.id,
        message: hoursVerdict.message,
      });
      throw errors.locked(hoursVerdict.message);
    }

    // --- session ------------------------------------------------------------
    const idleMinutes = Number(await settings.get('security.sessionIdleMinutes', 30));
    const { token, csrfToken, session } = await sessions.create(user, {
      deviceId,
      ip: req.clientIp,
      userAgent: req.get('user-agent'),
    });

    res.cookie(TOKEN_COOKIE, token, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: idleMinutes * 60000 * 4,
    });
    if (deviceId) res.cookie(DEVICE_COOKIE, deviceId, DEVICE_COOKIE_OPTIONS);

    await audit.log({
      action: audit.ACTIONS.LOGIN_SUCCESS,
      actor: { id: user.id, name: user.name, roleKey: user.roleKey },
      ip: req.clientIp,
      deviceId,
      entityType: 'user',
      entityId: user.id,
      message: `Signed in from ${req.clientIp}${req.isLocalhost ? ' (server PC)' : ''}`,
    });

    return ok(res, await sessionPayload(user, session, hoursVerdict));
  })
);

function describeFailure(verdict, username) {
  switch (verdict.reason) {
    case 'unknown':
      return `Sign-in failed: no user named "${username}"`;
    case 'disabled':
      return 'Sign-in failed: account disabled';
    case 'locked':
      return `Sign-in blocked: locked for another ${verdict.lockedMinutes} minutes`;
    case 'justLocked':
      return 'Account locked after too many wrong attempts';
    default:
      return `Sign-in failed: wrong password (${verdict.attemptsLeft} attempts left)`;
  }
}

async function sessionPayload(user, session, hoursVerdict = null) {
  const withPermissions = await users.withPermissions(user);
  const verdict = hoursVerdict || (await hours.accessFor(user.roleKey));
  const licenseState = await license.state();
  const year = await academics.currentYear();

  let scopeSectionIds = null;
  if (permissions.SECTION_SCOPED_ROLES.has(user.roleKey) && year) {
    scopeSectionIds = await academics.sectionsForTeacher(user.id, year.id);
  }

  return {
    user: {
      ...withPermissions,
      scopeSectionIds,
    },
    csrfToken: session.csrfToken,
    hours: {
      access: verdict.access,
      message: verdict.message,
      ...(verdict.state || {}),
    },
    license: {
      status: licenseState.status,
      message: licenseState.message,
      severity: licenseState.severity,
      daysLeft: licenseState.daysLeft,
      canWrite: licenseState.canWrite,
    },
    academicYear: year ? { id: year.id, name: year.name, status: year.status } : null,
  };
}

router.post(
  '/logout',
  authenticate({ optional: true }),
  handler(async (req, res) => {
    if (req.sessionToken) {
      await sessions.destroy(req.sessionToken, 'signedOut');
      if (req.user) {
        await audit.fromRequest(req, {
          action: audit.ACTIONS.LOGOUT,
          entityType: 'user',
          entityId: req.user.id,
          message: 'Signed out',
        });
      }
    }
    clearAuthCookie(res);
    return ok(res, { signedOut: true });
  })
);

/** GET /api/me — used on every page load to restore the session. */
router.get(
  '/me',
  authenticate(),
  handler(async (req, res) => {
    const record = await users.get(req.user.id);
    return ok(res, await sessionPayload(record, req.session));
  })
);

/** Forced first-login change and voluntary changes both land here. */
router.post(
  '/me/password',
  authenticate(),
  handler(async (req, res) => {
    const input = body(req);
    const current = input.currentPassword ? String(input.currentPassword) : '';
    const next = input.newPassword ? String(input.newPassword) : '';
    const confirm = input.confirmPassword ? String(input.confirmPassword) : '';

    if (next !== confirm) {
      throw errors.validation('The two new passwords do not match.', {
        confirmPassword: 'Does not match.',
      });
    }

    await users.changeOwnSecret(req.user.id, current, next, { userId: req.user.id });

    await audit.fromRequest(req, {
      action: audit.ACTIONS.PASSWORD_CHANGED,
      entityType: 'user',
      entityId: req.user.id,
      message: 'Changed their own password',
    });

    // Every other session for this user is now stale.
    await sessions.destroyForUser(req.user.id, 'passwordChanged');
    clearAuthCookie(res);

    return ok(res, { changed: true, signInAgain: true });
  })
);

module.exports = { router, sessionPayload };
