'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');

const { paths } = require('../paths');
const errors = require('../errors');

/**
 * Licensing (SPEC §18). Ported from Cure Max with three deliberate changes:
 *
 *  1. Expiry is a 14-day grace period with escalating warnings, not a cliff.
 *  2. Export routes work regardless of licence state — the school must always be
 *     able to get its own data out.
 *  3. The emergency re-issue process is documented on the Licence screen.
 */

const TRIAL_DAYS = 60;
const GRACE_DAYS = 14;
const DAY_MS = 86400000;

/* --------------------------------------------------------------- machine id */

/**
 * Stable enough to lock a licence to one PC, forgiving enough to survive a
 * Windows update. Uses hostname + the first non-virtual MAC + CPU model.
 */
function machineFingerprint() {
  const macs = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces).sort()) {
    for (const iface of interfaces[name] || []) {
      if (iface.internal) continue;
      if (!iface.mac || iface.mac === '00:00:00:00:00:00') continue;
      macs.push(iface.mac.toLowerCase());
    }
  }
  const cpu = os.cpus()[0]?.model || 'unknown-cpu';
  const raw = [os.hostname().toLowerCase(), macs[0] || 'no-mac', cpu.trim()].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

let cachedMachineId = null;
function machineId() {
  if (!cachedMachineId) cachedMachineId = machineFingerprint();
  return cachedMachineId;
}

/* ------------------------------------------------------------------ key I/O */

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function readPublicKey() {
  if (!fs.existsSync(paths.publicKey)) return null;
  try {
    return crypto.createPublicKey(fs.readFileSync(paths.publicKey, 'utf8'));
  } catch (err) {
    console.error(`[license] public key unreadable: ${err.message}`);
    return null;
  }
}

/**
 * Key format: `<base64url(payload JSON)>.<base64url(Ed25519 signature)>`
 * Payload: { machineId, issuedTo, issuedAt, expiresAt|null, seats, features[] }
 */
function decode(key) {
  const text = String(key || '').trim().replace(/\s+/g, '');
  const dot = text.indexOf('.');
  if (dot === -1) throw errors.badRequest('That product key is not in the right format.');
  const payloadPart = text.slice(0, dot);
  const signaturePart = text.slice(dot + 1);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch (err) {
    throw errors.badRequest('That product key could not be read. Check for a typo.');
  }
  return { payload, payloadPart, signature: Buffer.from(signaturePart, 'base64url') };
}

function verifySignature(payloadPart, signature) {
  const publicKey = readPublicKey();
  if (!publicKey) {
    throw errors.badRequest(
      'This copy has no licence public key installed. Contact support for a replacement build.'
    );
  }
  return crypto.verify(null, Buffer.from(payloadPart, 'utf8'), publicKey, signature);
}

/* ------------------------------------------------------------------- store */

async function readFile() {
  if (!fs.existsSync(paths.licenseFile)) return {};
  try {
    return JSON.parse(await fsp.readFile(paths.licenseFile, 'utf8')) || {};
  } catch (err) {
    console.warn(`[license] license.json unreadable: ${err.message}`);
    return {};
  }
}

async function writeFile(data) {
  const tmp = `${paths.licenseFile}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(data, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, paths.licenseFile);
}

/** Records the trial start on first run. */
async function init() {
  const data = await readFile();
  if (!data.firstRunAt) {
    data.firstRunAt = new Date().toISOString();
    data.machineId = machineId();
    await writeFile(data);
  }
  return data;
}

/* ------------------------------------------------------------------- state */

function daysBetween(from, to) {
  return Math.ceil((to - from) / DAY_MS);
}

/**
 * @returns {{
 *   status: 'trial'|'active'|'grace'|'expired'|'invalid',
 *   canWrite: boolean, daysLeft: number|null, message: string|null,
 *   severity: 'none'|'info'|'warning'|'critical'
 * }}
 */
async function state() {
  const data = await readFile();
  const now = Date.now();

  if (data.key) {
    try {
      const { payload, payloadPart, signature } = decode(data.key);
      if (!verifySignature(payloadPart, signature)) {
        return invalidState('The product key on this PC is not valid. Contact support.');
      }
      if (payload.machineId && payload.machineId !== machineId()) {
        return invalidState(
          'This product key belongs to a different PC. Contact support for a replacement key.'
        );
      }

      const expiresAt = payload.expiresAt ? Date.parse(payload.expiresAt) : null;
      if (!expiresAt) {
        return {
          status: 'active',
          canWrite: true,
          daysLeft: null,
          severity: 'none',
          message: null,
          licensedTo: payload.issuedTo || null,
          expiresAt: null,
          activatedAt: data.activatedAt || null,
          machineId: machineId(),
        };
      }

      if (now < expiresAt) {
        const daysLeft = daysBetween(now, expiresAt);
        return {
          status: 'active',
          canWrite: true,
          daysLeft,
          severity: daysLeft <= 30 ? 'info' : 'none',
          message:
            daysLeft <= 30
              ? `Your licence expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Contact support to renew.`
              : null,
          licensedTo: payload.issuedTo || null,
          expiresAt: payload.expiresAt,
          activatedAt: data.activatedAt || null,
          machineId: machineId(),
        };
      }

      const graceEnd = expiresAt + GRACE_DAYS * DAY_MS;
      if (now < graceEnd) {
        return graceState(daysBetween(now, graceEnd), payload.issuedTo, payload.expiresAt);
      }
      return expiredState(payload.issuedTo, payload.expiresAt);
    } catch (err) {
      return invalidState(err.expose ? err.message : 'The product key on this PC could not be read.');
    }
  }

  // No key — trial.
  const firstRunAt = data.firstRunAt ? Date.parse(data.firstRunAt) : now;
  const trialEnd = firstRunAt + TRIAL_DAYS * DAY_MS;

  if (now < trialEnd) {
    const daysLeft = daysBetween(now, trialEnd);
    return {
      status: 'trial',
      canWrite: true,
      daysLeft,
      severity: daysLeft <= 14 ? 'warning' : 'info',
      message: `Trial: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left. Activate a product key before it ends.`,
      licensedTo: null,
      expiresAt: new Date(trialEnd).toISOString(),
      activatedAt: null,
      machineId: machineId(),
    };
  }

  const graceEnd = trialEnd + GRACE_DAYS * DAY_MS;
  if (now < graceEnd) {
    return graceState(daysBetween(now, graceEnd), null, new Date(trialEnd).toISOString());
  }
  return expiredState(null, new Date(trialEnd).toISOString());
}

function graceState(daysLeft, issuedTo, expiresAt) {
  return {
    status: 'grace',
    canWrite: true,
    daysLeft,
    severity: daysLeft <= 3 ? 'critical' : 'warning',
    message:
      `Your licence has expired. You have ${daysLeft} day${daysLeft === 1 ? '' : 's'} of full access left, ` +
      'after which the portal becomes read-only. Contact support now.',
    licensedTo: issuedTo || null,
    expiresAt,
    graceDays: GRACE_DAYS,
    machineId: machineId(),
  };
}

function expiredState(issuedTo, expiresAt) {
  return {
    status: 'expired',
    canWrite: false,
    daysLeft: 0,
    severity: 'critical',
    message:
      'Your licence has expired and the grace period is over. The portal is read-only. ' +
      'You can still view, print and export all of your data. Contact support for a product key.',
    licensedTo: issuedTo || null,
    expiresAt,
    machineId: machineId(),
  };
}

function invalidState(message) {
  return {
    status: 'invalid',
    canWrite: false,
    daysLeft: 0,
    severity: 'critical',
    message,
    licensedTo: null,
    expiresAt: null,
    machineId: machineId(),
  };
}

/* --------------------------------------------------------------- activation */

async function activate(key, ctx) {
  const { payload, payloadPart, signature } = decode(key);
  if (!verifySignature(payloadPart, signature)) {
    throw errors.badRequest('That product key is not valid. Check for a typo, or contact support.');
  }
  if (payload.machineId && payload.machineId !== machineId()) {
    throw errors.badRequest(
      'That product key was issued for a different PC. Send support the machine ID shown on this screen.'
    );
  }
  if (payload.expiresAt && Date.parse(payload.expiresAt) < Date.now()) {
    throw errors.badRequest('That product key has already expired. Contact support for a current key.');
  }

  const data = await readFile();
  data.key = String(key).trim().replace(/\s+/g, '');
  data.activatedAt = new Date().toISOString();
  data.activatedBy = ctx?.userId || 'system';
  data.machineId = machineId();
  data.payload = payload;
  if (!data.firstRunAt) data.firstRunAt = data.activatedAt;
  await writeFile(data);

  return state();
}

async function deactivate(ctx) {
  const data = await readFile();
  delete data.key;
  delete data.payload;
  data.deactivatedAt = new Date().toISOString();
  data.deactivatedBy = ctx?.userId || 'system';
  await writeFile(data);
  return state();
}

module.exports = {
  TRIAL_DAYS,
  GRACE_DAYS,
  machineId,
  machineFingerprint,
  init,
  state,
  activate,
  deactivate,
  decode,
  b64url,
};
