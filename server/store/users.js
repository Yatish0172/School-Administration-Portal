'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const workbook = require('./workbook');
const crud = require('./crud');
const settings = require('./settings');
const permissions = require('./permissions');
const errors = require('../errors');

const BCRYPT_COST = 12;

/**
 * Users and credential checks. Plaintext passwords and PINs exist only as local
 * variables inside this file and are never returned, stored or logged.
 */

const PASSWORD_ROLES = new Set(['admin', 'principal', 'accounts', 'exam']);

function isPasswordRole(roleKey) {
  return PASSWORD_ROLES.has(roleKey);
}

/** Never let a hash or internal counter reach the client. */
function publicUser(user) {
  if (!user) return null;
  const {
    passwordHash,
    failedAttempts,
    ...rest
  } = user;
  return rest;
}

async function hash(secret) {
  return bcrypt.hash(secret, BCRYPT_COST);
}

async function list(options = {}) {
  return crud.list('Users', 'Users', {
    searchFields: ['name', 'username', 'email', 'phone', 'roleKey', 'department'],
    sort: 'name',
    ...options,
  });
}

async function all() {
  return workbook.read('Users', 'Users');
}

async function get(id) {
  return crud.get('Users', 'Users', id);
}

async function getByUsername(username) {
  if (!username) return null;
  const target = String(username).trim().toLowerCase();
  return crud.findOne('Users', 'Users', (r) => String(r.username || '').toLowerCase() === target);
}

async function getByStaffId(staffId) {
  return crud.findOne('Users', 'Users', (r) => r.staffId === staffId);
}

/* ------------------------------------------------------------- validation */

async function validate(data, { existingId = null } = {}) {
  const fields = {};
  const config = await settings.getMany([
    'security.minPasswordLength',
    'security.pinLength',
  ]);

  if (!data.name || !String(data.name).trim()) fields.name = 'Enter a full name.';
  if (!data.username || !String(data.username).trim()) {
    fields.username = 'Enter a username.';
  } else if (!/^[a-zA-Z0-9._-]{3,32}$/.test(String(data.username).trim())) {
    fields.username =
      'Usernames can use letters, numbers, dot, dash and underscore, 3 to 32 characters.';
  } else {
    const clash = await getByUsername(data.username);
    if (clash && clash.id !== existingId) fields.username = 'That username is already taken.';
  }

  if (!data.roleKey) {
    fields.roleKey = 'Choose a role.';
  } else {
    const role = await permissions.getRole(data.roleKey);
    if (!role) fields.roleKey = 'That role does not exist.';
  }

  if (data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(data.email))) {
    fields.email = 'Enter a valid email address, or leave it blank.';
  }
  if (data.phone && !/^[0-9+\-\s]{6,15}$/.test(String(data.phone))) {
    fields.phone = 'Enter a valid phone number, or leave it blank.';
  }

  const credentialType = data.credentialType || (isPasswordRole(data.roleKey) ? 'password' : 'pin');
  if (!['password', 'pin'].includes(credentialType)) {
    fields.credentialType = 'Choose either a password or a PIN.';
  }
  if (credentialType === 'pin' && isPasswordRole(data.roleKey)) {
    fields.credentialType =
      'This role handles sensitive data and needs a password, not a PIN.';
  }

  if (data.secret) {
    const secret = String(data.secret);
    if (credentialType === 'pin') {
      const len = config['security.pinLength'] || 6;
      if (!new RegExp(`^\\d{${len}}$`).test(secret)) {
        fields.secret = `The PIN must be exactly ${len} digits.`;
      }
    } else {
      const min = config['security.minPasswordLength'] || 8;
      if (secret.length < min) {
        fields.secret = `The password must be at least ${min} characters.`;
      }
    }
  }

  if (Object.keys(fields).length) {
    throw errors.validation('Some details need fixing before this can be saved.', fields);
  }
  return { credentialType };
}

/* ------------------------------------------------------------------ writes */

async function create(data, ctx) {
  const { credentialType } = await validate(data);
  if (!data.secret) {
    throw errors.validation('Set a password or PIN for this user.', {
      secret: 'Required for a new user.',
    });
  }
  const passwordHash = await hash(String(data.secret));
  const cap = Number(data.deviceCap) || (await settings.get('devices.capPerUser', 2));

  const row = await crud.create(
    'Users',
    'Users',
    {
      username: String(data.username).trim().toLowerCase(),
      name: String(data.name).trim(),
      email: data.email || null,
      phone: data.phone || null,
      roleKey: data.roleKey,
      department: data.department || null,
      credentialType,
      passwordHash,
      status: 'active',
      mustChangePassword: data.mustChangePassword !== false,
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      deviceCap: cap,
      staffId: data.staffId || null,
    },
    ctx,
    { label: 'create user' }
  );
  return publicUser(row);
}

async function update(id, patch, ctx, options = {}) {
  const current = await crud.getOrFail('Users', 'Users', id, 'user');
  await validate({ ...current, ...crud.defined(patch), secret: undefined }, { existingId: id });

  // Credentials and lock state are changed through their own functions so they
  // cannot be altered by a stray field on a profile edit.
  const clean = { ...patch };
  delete clean.passwordHash;
  delete clean.secret;
  delete clean.failedAttempts;
  delete clean.lockedUntil;
  delete clean.status;

  const result = await crud.update('Users', 'Users', id, clean, ctx, {
    expectedRev: options.expectedRev,
    label: 'user',
  });
  return { before: publicUser(result.before), after: publicUser(result.after) };
}

async function setStatus(id, status, ctx) {
  if (!['active', 'disabled'].includes(status)) {
    throw errors.badRequest('A user can only be active or disabled.');
  }
  const result = await crud.update(
    'Users',
    'Users',
    id,
    { status, failedAttempts: 0, lockedUntil: null },
    ctx,
    { label: 'user' }
  );
  return { before: publicUser(result.before), after: publicUser(result.after) };
}

async function setSecret(id, secret, ctx, { mustChange = false } = {}) {
  const user = await crud.getOrFail('Users', 'Users', id, 'user');
  await validate({ ...user, secret }, { existingId: id });
  const passwordHash = await hash(String(secret));
  await crud.update(
    'Users',
    'Users',
    id,
    {
      passwordHash,
      mustChangePassword: mustChange,
      failedAttempts: 0,
      lockedUntil: null,
    },
    ctx,
    { label: 'user' }
  );
  return true;
}

/** Admin-initiated reset: returns a one-time secret the admin reads out once. */
async function resetSecret(id, ctx) {
  const user = await crud.getOrFail('Users', 'Users', id, 'user');
  const secret =
    user.credentialType === 'pin'
      ? randomDigits(Number(await settings.get('security.pinLength', 6)))
      : randomPassword();
  await setSecret(id, secret, ctx, { mustChange: true });
  return { secret, credentialType: user.credentialType };
}

async function changeOwnSecret(id, currentSecret, newSecret, ctx) {
  const user = await crud.getOrFail('Users', 'Users', id, 'user');
  const ok = await bcrypt.compare(String(currentSecret || ''), user.passwordHash || '');
  if (!ok) {
    throw errors.validation('Your current password is not correct.', {
      currentPassword: 'Not correct.',
    });
  }
  const same = await bcrypt.compare(String(newSecret || ''), user.passwordHash || '');
  if (same) {
    throw errors.validation('Choose a password you have not used here before.', {
      newPassword: 'This is your current password.',
    });
  }
  await setSecret(id, newSecret, ctx, { mustChange: false });
  return true;
}

/* -------------------------------------------------------- credential check */

function lockRemainingMinutes(user) {
  if (!user.lockedUntil) return 0;
  const until = Date.parse(user.lockedUntil);
  if (!Number.isFinite(until)) return 0;
  const remaining = until - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 60000) : 0;
}

/**
 * Verifies a credential and maintains the lockout counter.
 * Returns `{ ok, user, reason }` rather than throwing, so the caller can audit a
 * failure before responding. Never reveals whether the username exists.
 */
async function verifyCredential(username, secret) {
  const config = await settings.getMany([
    'security.lockoutThreshold',
    'security.lockoutMinutes',
  ]);
  const threshold = config['security.lockoutThreshold'] || 5;
  const lockMinutes = config['security.lockoutMinutes'] || 15;

  const user = await getByUsername(username);
  if (!user) {
    // Constant-ish work so a missing user is not obviously faster than a wrong password.
    await bcrypt.compare(String(secret || ''), '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    return { ok: false, reason: 'unknown' };
  }

  if (user.status !== 'active') {
    return { ok: false, reason: 'disabled', user };
  }

  const locked = lockRemainingMinutes(user);
  if (locked > 0) {
    return { ok: false, reason: 'locked', user, lockedMinutes: locked };
  }

  const match = await bcrypt.compare(String(secret || ''), user.passwordHash || '');
  if (!match) {
    const attempts = Number(user.failedAttempts || 0) + 1;
    const shouldLock = attempts >= threshold;
    await crud.update(
      'Users',
      'Users',
      user.id,
      {
        failedAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock
          ? new Date(Date.now() + lockMinutes * 60000).toISOString()
          : null,
      },
      { userId: 'system' },
      { label: 'user' }
    );
    return {
      ok: false,
      reason: shouldLock ? 'justLocked' : 'wrong',
      user,
      lockedMinutes: shouldLock ? lockMinutes : 0,
      attemptsLeft: shouldLock ? 0 : threshold - attempts,
    };
  }

  await crud.update(
    'Users',
    'Users',
    user.id,
    { failedAttempts: 0, lockedUntil: null, lastLoginAt: crud.nowIso() },
    { userId: user.id },
    { label: 'user' }
  );

  return { ok: true, user };
}

async function unlock(id, ctx) {
  await crud.update(
    'Users',
    'Users',
    id,
    { failedAttempts: 0, lockedUntil: null },
    ctx,
    { label: 'user' }
  );
  return true;
}

/* -------------------------------------------------------------- generation */

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomPassword(length = 12) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

function randomDigits(length = 6) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i += 1) out += String(bytes[i] % 10);
  return out;
}

/**
 * First run only. The password is returned to the caller (main.js prints it to the
 * Electron console) and never written anywhere else.
 */
async function seedAdmin() {
  const existing = await workbook.read('Users', 'Users');
  if (existing.length > 0) return null;

  const password = randomPassword(14);
  const passwordHash = await hash(password);
  const user = await crud.create(
    'Users',
    'Users',
    {
      username: 'admin',
      name: 'Administrator',
      roleKey: 'admin',
      department: 'Administration',
      credentialType: 'password',
      passwordHash,
      status: 'active',
      mustChangePassword: true,
      failedAttempts: 0,
      deviceCap: 5,
    },
    { userId: 'system' },
    { label: 'seed admin' }
  );
  return { username: user.username, password };
}

/**
 * id -> display name, for the `createdBy` / `markedBy` / `collectedBy` columns.
 * Those fields store a user id; showing the raw id to an accountant asking "who
 * took this money" is useless, so every screen that surfaces one resolves it here.
 */
async function displayNames() {
  const rows = await workbook.read('Users', 'Users');
  const map = new Map(rows.map((row) => [row.id, row.name]));
  map.set('system', 'System');
  return map;
}

/** Safe single lookup for one-off use. */
async function displayName(userId) {
  if (!userId) return null;
  if (userId === 'system') return 'System';
  const user = await get(userId);
  return user ? user.name : userId;
}

/** A user with an effective permission set, used by authenticate + permissionCheck. */
async function withPermissions(user) {
  if (!user) return null;
  const keys = await permissions.permissionsForRole(user.roleKey);
  return { ...publicUser(user), permissions: keys };
}

module.exports = {
  BCRYPT_COST,
  isPasswordRole,
  publicUser,
  list,
  all,
  get,
  getByUsername,
  getByStaffId,
  validate,
  create,
  update,
  setStatus,
  setSecret,
  resetSecret,
  changeOwnSecret,
  verifyCredential,
  unlock,
  lockRemainingMinutes,
  randomPassword,
  randomDigits,
  seedAdmin,
  withPermissions,
  displayNames,
  displayName,
};
