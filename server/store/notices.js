'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const errors = require('../errors');

/**
 * Notices (SPEC §12): create, target by role/class/all, publish window, read
 * tracking, print. No sending — SMS and WhatsApp are explicitly out of scope; the
 * parent-contact CSV export is the supported hand-off to an external tool.
 */

const WB = 'Notices';
const AUDIENCES = ['all', 'role', 'class'];
const PRIORITIES = ['normal', 'important', 'urgent'];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isLive(notice, on = null) {
  const date = on || today();
  if (notice.status !== 'published') return false;
  if (notice.publishFrom && date < notice.publishFrom) return false;
  if (notice.publishTo && date > notice.publishTo) return false;
  return true;
}

async function list({ status = null, includeExpired = true } = {}) {
  const rows = await workbook.read(WB, 'Notices');
  return rows
    .filter((row) => {
      if (status && row.status !== status) return false;
      if (!includeExpired && !isLive(row)) return false;
      return true;
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function get(id) {
  return crud.get(WB, 'Notices', id);
}

/** Notices a specific user should see, newest and most urgent first. */
async function forUser(user, { classIds = [] } = {}) {
  const rows = await workbook.read(WB, 'Notices');
  const reads = await workbook.read(WB, 'NoticeReads');
  const readIds = new Set(reads.filter((r) => r.userId === user.id).map((r) => r.noticeId));

  const visible = rows.filter((notice) => {
    if (!isLive(notice)) return false;
    if (notice.audience === 'all') return true;
    if (notice.audience === 'role') {
      const targets = Array.isArray(notice.targetRoles) ? notice.targetRoles : [];
      return targets.includes(user.roleKey);
    }
    if (notice.audience === 'class') {
      const targets = Array.isArray(notice.targetClassIds) ? notice.targetClassIds : [];
      return targets.some((id) => classIds.includes(id));
    }
    return false;
  });

  return visible
    .map((notice) => ({ ...notice, read: readIds.has(notice.id) }))
    .sort(
      (a, b) =>
        PRIORITIES.indexOf(b.priority || 'normal') - PRIORITIES.indexOf(a.priority || 'normal') ||
        String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))
    );
}

function validate(data) {
  const fields = {};
  if (!data.title || String(data.title).trim().length < 3) fields.title = 'Enter a title.';
  if (!data.body || String(data.body).trim().length < 3) fields.body = 'Write the notice.';
  if (data.audience && !AUDIENCES.includes(data.audience)) {
    fields.audience = 'Target everyone, specific roles, or specific classes.';
  }
  if (data.audience === 'role' && (!data.targetRoles || !data.targetRoles.length)) {
    fields.targetRoles = 'Choose at least one role.';
  }
  if (data.audience === 'class' && (!data.targetClassIds || !data.targetClassIds.length)) {
    fields.targetClassIds = 'Choose at least one class.';
  }
  if (data.publishFrom && data.publishTo && data.publishTo < data.publishFrom) {
    fields.publishTo = 'The end date must be on or after the start date.';
  }
  if (Object.keys(fields).length) {
    throw errors.validation('Check the notice details.', fields);
  }
}

async function create(data, ctx) {
  validate(data);
  return crud.create(
    WB,
    'Notices',
    {
      title: String(data.title).trim(),
      body: String(data.body).trim(),
      audience: data.audience || 'all',
      targetRoles: data.targetRoles || [],
      targetClassIds: data.targetClassIds || [],
      publishFrom: data.publishFrom || today(),
      publishTo: data.publishTo || null,
      priority: PRIORITIES.includes(data.priority) ? data.priority : 'normal',
      status: 'draft',
      attachmentFile: data.attachmentFile || null,
    },
    ctx,
    { label: 'create notice' }
  );
}

async function update(id, patch, ctx, options = {}) {
  const current = await crud.getOrFail(WB, 'Notices', id, 'notice');
  validate({ ...current, ...crud.defined(patch) });
  const clean = { ...patch };
  delete clean.status;
  delete clean.publishedAt;
  delete clean.publishedBy;
  return crud.update(WB, 'Notices', id, clean, ctx, {
    expectedRev: options.expectedRev,
    label: 'notice',
  });
}

async function publish(id, ctx) {
  const notice = await crud.getOrFail(WB, 'Notices', id, 'notice');
  if (notice.status === 'published') throw errors.badRequest('That notice is already published.');
  return crud.update(
    WB,
    'Notices',
    id,
    {
      status: 'published',
      publishedAt: crud.nowIso(),
      publishedBy: crud.actorOf(ctx),
      publishFrom: notice.publishFrom || today(),
    },
    ctx,
    { label: 'notice' }
  );
}

async function archive(id, ctx) {
  return crud.update(WB, 'Notices', id, { status: 'archived' }, ctx, { label: 'notice' });
}

/** Read tracking. Insert-once per user, so a second read is a no-op. */
async function markRead(noticeId, userId, ctx) {
  return workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('NoticeReads');
      if (rows.some((r) => r.noticeId === noticeId && r.userId === userId)) return null;
      return crud.insertInto(
        api,
        WB,
        'NoticeReads',
        { noticeId, userId, readAt: crud.nowIso() },
        ctx
      );
    },
    { label: 'mark notice read' }
  );
}

async function readStats(noticeId) {
  const users = require('./users');
  const reads = (await workbook.read(WB, 'NoticeReads')).filter((r) => r.noticeId === noticeId);
  const allUsers = await users.all();
  const byId = new Map(allUsers.map((u) => [u.id, u]));
  return {
    total: reads.length,
    readers: reads.map((r) => ({
      userId: r.userId,
      name: byId.get(r.userId)?.name || 'Unknown user',
      readAt: r.readAt,
    })),
  };
}

async function unreadCount(user, classIds = []) {
  const visible = await forUser(user, { classIds });
  return visible.filter((notice) => !notice.read).length;
}

module.exports = {
  WB,
  AUDIENCES,
  PRIORITIES,
  isLive,
  list,
  get,
  forUser,
  create,
  update,
  publish,
  archive,
  markRead,
  readStats,
  unreadCount,
};
