'use strict';

const crypto = require('crypto');

const workbook = require('./workbook');
const crud = require('./crud');
const settings = require('./settings');
const sessions = require('./sessions');
const errors = require('../errors');

/**
 * Device enrollment (SPEC §2). An unenrolled device reaches the login page but
 * cannot sign in — the QR only says where the server is, it grants nothing.
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1

function generateCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function normaliseCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function newDeviceId() {
  return crypto.randomBytes(24).toString('hex');
}

/* --------------------------------------------------------- user agent sniff */

function describeUserAgent(userAgent) {
  const ua = String(userAgent || '');
  const os =
    /Windows NT 10/.test(ua) ? 'Windows 10/11'
    : /Windows/.test(ua) ? 'Windows'
    : /Android (\d+)/.test(ua) ? `Android ${ua.match(/Android (\d+)/)[1]}`
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Unknown';
  return { os, browser };
}

/* -------------------------------------------------------------------- reads */

async function listDevices(options = {}) {
  const { userId = null, status = null } = options;
  const rows = await workbook.read('Users', 'Devices');
  return rows
    .filter((row) => {
      if (userId && row.userId !== userId) return false;
      if (status && row.status !== status) return false;
      return true;
    })
    .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
}

async function getByDeviceId(deviceId) {
  if (!deviceId) return null;
  return crud.findOne('Users', 'Devices', (r) => r.deviceId === deviceId);
}

async function activeCountForUser(userId) {
  const rows = await workbook.read('Users', 'Devices');
  return rows.filter((r) => r.userId === userId && r.status === 'active').length;
}

async function listCodes(options = {}) {
  const rows = await workbook.read('Users', 'EnrollmentCodes');
  const { userId = null, activeOnly = false } = options;
  const now = Date.now();
  return rows
    .filter((row) => {
      if (userId && row.userId !== userId) return false;
      if (activeOnly) {
        if (row.status !== 'issued') return false;
        if (row.expiresAt && Date.parse(row.expiresAt) < now) return false;
      }
      return true;
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/* ------------------------------------------------------------------- writes */

async function issueCode(userId, ctx) {
  const user = await crud.getOrFail('Users', 'Users', userId, 'user');
  if (user.status !== 'active') {
    throw errors.badRequest('That user account is disabled, so it cannot enroll a device.');
  }

  const minutes = Number(await settings.get('devices.codeValidMinutes', 10)) || 10;
  const cap = Number(user.deviceCap) || Number(await settings.get('devices.capPerUser', 2));
  const active = await activeCountForUser(userId);
  if (active >= cap) {
    throw errors.badRequest(
      `${user.name} already has ${active} of ${cap} devices registered. Revoke one first.`
    );
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();

  await workbook.mutate(
    'Users',
    (api) => {
      // Supersede any code still outstanding for this user — a stack of live codes
      // is a stack of ways in.
      const rows = api.rows('EnrollmentCodes');
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].userId === userId && rows[i].status === 'issued') {
          rows[i] = { ...rows[i], status: 'superseded', _rev: Number(rows[i]._rev || 1) + 1 };
        }
      }
      crud.insertInto(
        api,
        'Users',
        'EnrollmentCodes',
        { code: normaliseCode(code), userId, expiresAt, status: 'issued' },
        ctx
      );
    },
    { label: 'issue enrollment code' }
  );

  return { code, expiresAt, minutes, user: { id: user.id, name: user.name, username: user.username } };
}

/**
 * Consumes a code and registers the device. Called during login so the staff
 * member proves both the code and their credentials in one step (SPEC §2 step 3).
 * Caller must have already verified the credentials for `userId`.
 */
async function redeemCode(code, userId, context = {}) {
  const normalised = normaliseCode(code);
  if (!normalised) {
    throw errors.badRequest('Enter the enrollment code from the office.');
  }

  const cap = Number(context.deviceCap) || Number(await settings.get('devices.capPerUser', 2));
  const deviceId = context.deviceId || newDeviceId();
  const { os, browser } = describeUserAgent(context.userAgent);

  return workbook.mutate(
    'Users',
    (api) => {
      const codes = api.rows('EnrollmentCodes');
      const index = codes.findIndex(
        (r) => normaliseCode(r.code) === normalised && r.userId === userId
      );
      if (index === -1) {
        throw errors.badRequest('That enrollment code is not valid for this user.');
      }
      const row = codes[index];
      if (row.status !== 'issued') {
        throw errors.badRequest('That enrollment code has already been used. Ask for a new one.');
      }
      if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) {
        codes[index] = { ...row, status: 'expired', _rev: Number(row._rev || 1) + 1 };
        throw errors.badRequest('That enrollment code has expired. Ask the office for a new one.');
      }

      const devices = api.rows('Devices');
      const active = devices.filter((d) => d.userId === userId && d.status === 'active').length;
      if (active >= cap) {
        throw errors.badRequest(
          `This user already has ${active} of ${cap} devices registered. Revoke one first.`
        );
      }

      const device = crud.insertInto(
        api,
        'Users',
        'Devices',
        {
          deviceId,
          name: context.deviceName || `${browser} on ${os}`,
          userId,
          userAgent: context.userAgent || null,
          os,
          browser,
          ip: context.ip || null,
          status: 'active',
          enrolledAt: crud.nowIso(),
          lastSeenAt: crud.nowIso(),
        },
        { userId }
      );

      codes[index] = {
        ...row,
        status: 'used',
        usedAt: crud.nowIso(),
        usedByDeviceId: deviceId,
        _rev: Number(row._rev || 1) + 1,
      };

      return device;
    },
    { label: 'redeem enrollment code' }
  );
}

async function rename(id, name, ctx, options = {}) {
  return crud.update('Users', 'Devices', id, { name }, ctx, {
    expectedRev: options.expectedRev,
    label: 'device',
  });
}

async function revoke(id, ctx) {
  const device = await crud.getOrFail('Users', 'Devices', id, 'device');
  const result = await crud.update(
    'Users',
    'Devices',
    id,
    { status: 'revoked', revokedAt: crud.nowIso(), revokedBy: crud.actorOf(ctx) },
    ctx,
    { label: 'device' }
  );
  // Revocation must take effect now, not at the next idle timeout.
  const killed = await sessions.destroyForDevice(device.deviceId);
  return { ...result, sessionsEnded: killed };
}

/** Cheap heartbeat; batched to disk by the Users workbook write-through. */
const touchQueue = new Map();
let touchTimer = null;

function touch(deviceId, ip) {
  if (!deviceId) return;
  touchQueue.set(deviceId, { ip, at: crud.nowIso() });
  if (touchTimer) return;
  touchTimer = setTimeout(() => {
    touchTimer = null;
    const pending = new Map(touchQueue);
    touchQueue.clear();
    workbook
      .mutate(
        'Users',
        (api) => {
          const rows = api.rows('Devices');
          for (let i = 0; i < rows.length; i += 1) {
            const update = pending.get(rows[i].deviceId);
            if (!update) continue;
            rows[i] = { ...rows[i], lastSeenAt: update.at, ip: update.ip || rows[i].ip };
          }
        },
        { label: 'device heartbeat' }
      )
      .catch((err) => console.warn(`[devices] heartbeat failed: ${err.message}`));
  }, 30000);
  if (touchTimer.unref) touchTimer.unref();
}

/**
 * Decides whether a request's device may sign in.
 * Localhost is always trusted — the server PC itself must never be locked out.
 */
async function evaluate({ deviceId, userId, isLocalhost }) {
  if (isLocalhost) return { allowed: true, reason: 'localhost', device: null };

  const enforce = await settings.get('devices.enforce', true);
  if (!enforce) return { allowed: true, reason: 'enforcementOff', device: null };

  const device = await getByDeviceId(deviceId);
  if (!device) return { allowed: false, reason: 'unknown', device: null };
  if (device.status !== 'active') return { allowed: false, reason: 'revoked', device };
  if (userId && device.userId !== userId) {
    return { allowed: false, reason: 'wrongUser', device };
  }
  return { allowed: true, reason: 'enrolled', device };
}

const REFUSAL_MESSAGE = 'This device is not registered. Contact the office.';

module.exports = {
  generateCode,
  normaliseCode,
  newDeviceId,
  describeUserAgent,
  listDevices,
  getByDeviceId,
  activeCountForUser,
  listCodes,
  issueCode,
  redeemCode,
  rename,
  revoke,
  touch,
  evaluate,
  REFUSAL_MESSAGE,
};
