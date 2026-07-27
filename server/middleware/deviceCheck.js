'use strict';

const devices = require('../store/devices');
const audit = require('../store/audit');
const sessions = require('../store/sessions');
const errors = require('../errors');
const { clearAuthCookie } = require('./authenticate');

/**
 * Second link: runs after authenticate, before hoursCheck (SPEC §2, T08).
 *
 * A device that was enrolled when the session started can be revoked mid-session.
 * Re-checking on every request is what makes "revoke" instant.
 */
function deviceCheck() {
  return async (req, res, next) => {
    try {
      if (!req.user) return next();

      const verdict = await devices.evaluate({
        deviceId: req.deviceId,
        userId: req.user.id,
        isLocalhost: req.isLocalhost,
      });

      req.device = verdict.device;
      req.deviceTrustReason = verdict.reason;

      if (verdict.allowed) return next();

      // The session is no longer valid from this device.
      if (req.sessionToken) await sessions.destroy(req.sessionToken, 'deviceRefused');
      clearAuthCookie(res);

      await audit
        .fromRequest(req, {
          action: audit.ACTIONS.DEVICE_REFUSED,
          entityType: 'device',
          entityId: req.deviceId,
          message: `Refused mid-session: ${verdict.reason}`,
        })
        .catch(() => {});

      return next(errors.unauthorized(devices.REFUSAL_MESSAGE));
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { deviceCheck };
