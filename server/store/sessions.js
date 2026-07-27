'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const { paths } = require('../paths');
const workbook = require('./workbook');
const crud = require('./crud');
const settings = require('./settings');

/**
 * Session tokens live in Database/sessions.json, not in a workbook — they change
 * on every request and Excel is the wrong shape for that. Users.xlsx → Sessions
 * keeps the durable login history instead.
 *
 * Only the SHA-256 of a token is stored, so a copied sessions.json cannot be
 * replayed as a live session.
 */

/** tokenHash -> session */
const store = new Map();
let dirty = false;
let flushTimer = null;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function load() {
  if (!fs.existsSync(paths.sessionsFile)) return;
  try {
    const raw = await fsp.readFile(paths.sessionsFile, 'utf8');
    const data = JSON.parse(raw || '{}');
    for (const [tokenHash, session] of Object.entries(data.sessions || {})) {
      store.set(tokenHash, session);
    }
    await sweep();
  } catch (err) {
    // A damaged sessions file must not stop the app — everyone simply signs in again.
    console.warn(`[sessions] could not read sessions.json, starting fresh: ${err.message}`);
    store.clear();
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    persist().catch((err) => console.error(`[sessions] flush failed: ${err.message}`));
  }, 2000);
  if (flushTimer.unref) flushTimer.unref();
}

async function persist() {
  if (!dirty) return false;
  dirty = false;
  const payload = {
    savedAt: new Date().toISOString(),
    sessions: Object.fromEntries(store),
  };
  const tmp = `${paths.sessionsFile}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(payload));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, paths.sessionsFile);
  return true;
}

async function idleMinutes() {
  return Number(await settings.get('security.sessionIdleMinutes', 30)) || 30;
}

function isExpired(session, idleMs) {
  const last = Date.parse(session.lastSeenAt || session.startedAt);
  if (!Number.isFinite(last)) return true;
  if (Date.now() - last > idleMs) return true;
  if (session.hardExpiresAt && Date.parse(session.hardExpiresAt) < Date.now()) return true;
  return false;
}

async function create(user, context = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();

  const session = {
    id: crud.newId(),
    userId: user.id,
    userName: user.name,
    roleKey: user.roleKey,
    department: user.department || null,
    deviceId: context.deviceId || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    csrfToken,
    startedAt: now,
    lastSeenAt: now,
    // Set when the portal closes for the day so the session ends with a message
    // rather than being hard-killed (SPEC §3 closing sequence).
    hardExpiresAt: null,
  };
  store.set(tokenHash, session);
  scheduleFlush();

  // Durable login history.
  await crud.create(
    'Users',
    'Sessions',
    {
      userId: user.id,
      deviceId: session.deviceId,
      ip: session.ip,
      userAgent: session.userAgent,
      startedAt: now,
    },
    { userId: user.id },
    { label: 'session start' }
  );

  return { token, csrfToken, session };
}

async function get(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = store.get(tokenHash);
  if (!session) return null;
  const idleMs = (await idleMinutes()) * 60000;
  if (isExpired(session, idleMs)) {
    store.delete(tokenHash);
    scheduleFlush();
    await recordEnd(session, 'expired');
    return null;
  }
  return session;
}

function touch(token) {
  const tokenHash = hashToken(token);
  const session = store.get(tokenHash);
  if (!session) return;
  session.lastSeenAt = new Date().toISOString();
  scheduleFlush();
}

async function destroy(token, reason = 'signedOut') {
  const tokenHash = hashToken(token);
  const session = store.get(tokenHash);
  if (!session) return false;
  store.delete(tokenHash);
  scheduleFlush();
  await recordEnd(session, reason);
  await persist();
  return true;
}

async function destroyForUser(userId, reason = 'revoked') {
  const removed = [];
  for (const [tokenHash, session] of store) {
    if (session.userId === userId) {
      store.delete(tokenHash);
      removed.push(session);
    }
  }
  if (removed.length) {
    scheduleFlush();
    for (const session of removed) await recordEnd(session, reason);
    await persist();
  }
  return removed.length;
}

/** Revoking a device must kill its live sessions immediately (SPEC §2). */
async function destroyForDevice(deviceId, reason = 'deviceRevoked') {
  const removed = [];
  for (const [tokenHash, session] of store) {
    if (session.deviceId && session.deviceId === deviceId) {
      store.delete(tokenHash);
      removed.push(session);
    }
  }
  if (removed.length) {
    scheduleFlush();
    for (const session of removed) await recordEnd(session, reason);
    await persist();
  }
  return removed.length;
}

/**
 * Ends every session except one. Used after a restore: the users and permissions
 * everyone was holding may no longer exist in the restored data, but the admin who
 * ran the restore should not be thrown out of the screen they are looking at.
 */
async function destroyAllExcept(keepToken = null, reason = 'restored') {
  const keepHash = keepToken ? hashToken(keepToken) : null;
  const removed = [];
  for (const [tokenHash, session] of store) {
    if (keepHash && tokenHash === keepHash) continue;
    store.delete(tokenHash);
    removed.push(session);
  }
  if (removed.length) {
    scheduleFlush();
    for (const session of removed) await recordEnd(session, reason);
    await persist();
  }
  return removed.length;
}

async function recordEnd(session, reason) {
  try {
    const rows = await workbook.read('Users', 'Sessions');
    const row = rows.find(
      (r) => r.userId === session.userId && r.startedAt === session.startedAt && !r.endedAt
    );
    if (!row) return;
    await crud.update(
      'Users',
      'Sessions',
      row.id,
      { endedAt: crud.nowIso(), endedReason: reason },
      { userId: session.userId },
      { label: 'session end' }
    );
  } catch (err) {
    console.warn(`[sessions] could not record session end: ${err.message}`);
  }
}

/** Drops expired sessions. Called on load and on a timer. */
async function sweep() {
  const idleMs = (await idleMinutes()) * 60000;
  const expired = [];
  for (const [tokenHash, session] of store) {
    if (isExpired(session, idleMs)) {
      store.delete(tokenHash);
      expired.push(session);
    }
  }
  if (expired.length) {
    scheduleFlush();
    for (const session of expired) await recordEnd(session, 'expired');
  }
  return expired.length;
}

/** Marks every live session to end at a given time — used by the closing sequence. */
function setHardExpiry(expiresAtIso, { exceptRoles = [] } = {}) {
  let count = 0;
  for (const session of store.values()) {
    if (exceptRoles.includes(session.roleKey)) {
      session.hardExpiresAt = null;
      continue;
    }
    session.hardExpiresAt = expiresAtIso;
    count += 1;
  }
  if (count) scheduleFlush();
  return count;
}

function online() {
  const seen = new Map();
  for (const session of store.values()) {
    if (!seen.has(session.userId)) {
      seen.set(session.userId, {
        userId: session.userId,
        userName: session.userName,
        roleKey: session.roleKey,
        deviceId: session.deviceId,
        ip: session.ip,
        lastSeenAt: session.lastSeenAt,
      });
    }
  }
  return [...seen.values()];
}

function count() {
  return store.size;
}

function startSweeper(intervalMs = 60000) {
  const timer = setInterval(() => {
    sweep().catch(() => {});
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  load,
  persist,
  create,
  get,
  touch,
  destroy,
  destroyForUser,
  destroyForDevice,
  destroyAllExcept,
  sweep,
  setHardExpiry,
  online,
  count,
  startSweeper,
};
