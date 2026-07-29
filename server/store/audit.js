'use strict';

const workbook = require('./workbook');
const crud = require('./crud');

/**
 * Insert-only audit log (SPEC §14, CLAUDE.md data safety rules).
 * No function here updates or deletes a row, and none may be added.
 *
 * Events land in memory immediately and are flushed to disk on a short timer so a
 * burst of logins does not rewrite System.xlsx once per event. Anything involving
 * money, permissions or data restore is flushed synchronously.
 */

const ACTIONS = {
  LOGIN_SUCCESS: 'login.success',
  LOGIN_FAILED: 'login.failed',
  LOGIN_LOCKED: 'login.lockout',
  LOGIN_OUT_OF_HOURS: 'login.outOfHours',
  LOGOUT: 'logout',
  PASSWORD_CHANGED: 'user.passwordChanged',
  PIN_RESET: 'user.pinReset',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DISABLED: 'user.disabled',
  USER_ENABLED: 'user.enabled',
  PERMISSION_CHANGED: 'role.permissionsChanged',
  ROLE_CREATED: 'role.created',
  DEVICE_ENROLLED: 'device.enrolled',
  DEVICE_REVOKED: 'device.revoked',
  DEVICE_REFUSED: 'device.refused',
  ENROLLMENT_CODE_ISSUED: 'device.codeIssued',
  OUT_OF_HOURS_ATTEMPT: 'hours.refused',
  HOURS_UPDATED: 'hours.updated',
  HOURS_OVERRIDE: 'hours.override',
  HOURS_OVERRIDE_ENDED: 'hours.overrideEnded',
  CLOCK_WARNING: 'system.clockWarning',
  SETTING_CHANGED: 'settings.changed',
  STUDENT_CREATED: 'student.created',
  STUDENT_UPDATED: 'student.updated',
  STUDENT_STATUS_CHANGED: 'student.statusChanged',
  STUDENT_PROMOTED: 'student.promoted',
  TC_ISSUED: 'student.tcIssued',
  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_DOWNLOADED: 'document.downloaded',
  ATTENDANCE_MARKED: 'attendance.marked',
  ATTENDANCE_CORRECTED: 'attendance.corrected',
  MARKS_ENTERED: 'marks.entered',
  MARKS_PUBLISHED: 'marks.published',
  MARKS_UNPUBLISHED: 'marks.unpublished',
  FEE_INVOICE_GENERATED: 'fees.invoiceGenerated',
  FEE_PAYMENT: 'fees.payment',
  FEE_REVERSAL_REQUESTED: 'fees.reversalRequested',
  FEE_REVERSAL: 'fees.reversal',
  CONCESSION_REQUESTED: 'fees.concessionRequested',
  CONCESSION_APPROVED: 'fees.concessionApproved',
  RECEIPT_PRINTED: 'fees.receiptPrinted',
  REMOTE_TUNNEL_OPENED: 'remote.opened',
  REMOTE_TUNNEL_CLOSED: 'remote.closed',
  REMOTE_SIGN_IN: 'remote.signIn',
  BACKUP_RUN: 'backup.run',
  BACKUP_FAILED: 'backup.failed',
  RESTORE_RUN: 'backup.restore',
  LICENSE_ACTIVATED: 'license.activated',
  IMPORT_VALIDATED: 'import.validated',
  IMPORT_COMMITTED: 'import.committed',
  NOTICE_PUBLISHED: 'notice.published',
  EXPORT_GENERATED: 'export.generated',
  BOOK_ISSUED: 'library.issued',
  BOOK_RETURNED: 'library.returned',
  FINE_WAIVED: 'library.fineWaived',
  STAFF_CREATED: 'staff.created',
  STAFF_UPDATED: 'staff.updated',
  LEAVE_APPROVED: 'staff.leaveApproved',
  ENQUIRY_CONVERTED: 'enquiry.converted',
  YEAR_CLOSED: 'academics.yearClosed',
  YEAR_SET_CURRENT: 'academics.yearSetCurrent',
};

/** Anything here is written to disk before the response goes out. */
const CRITICAL = new Set([
  ACTIONS.FEE_PAYMENT,
  ACTIONS.FEE_REVERSAL,
  ACTIONS.CONCESSION_APPROVED,
  ACTIONS.MARKS_PUBLISHED,
  ACTIONS.RESTORE_RUN,
  ACTIONS.BACKUP_RUN,
  ACTIONS.LICENSE_ACTIVATED,
  ACTIONS.PERMISSION_CHANGED,
  ACTIONS.USER_DISABLED,
  ACTIONS.HOURS_OVERRIDE,
  ACTIONS.IMPORT_COMMITTED,
  ACTIONS.REMOTE_TUNNEL_OPENED,
  ACTIONS.REMOTE_TUNNEL_CLOSED,
]);

const FLUSH_DELAY_MS = 1500;
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    workbook.flush('System').catch((err) => {
      console.error(`[audit] flush failed: ${err.message}`);
    });
  }, FLUSH_DELAY_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function truncate(value, max = 4000) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/** Passwords and PINs must never reach the log, not even inside a before/after blob. */
const REDACT = new Set([
  'password',
  'passwordHash',
  'pin',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'tempPassword',
  'token',
  'code',
]);

function sanitise(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(sanitise);
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACT.has(key) ? '[redacted]' : sanitise(val);
  }
  return out;
}

/**
 * @param {object} event
 * @param {string} event.action     one of ACTIONS
 * @param {object} [event.actor]    { id, name, roleKey } — usually req.user
 * @param {object} [event.request]  { ip, deviceId } — usually req
 */
async function log(event) {
  const actor = event.actor || {};
  const row = {
    at: crud.nowIso(),
    userId: actor.id || event.userId || null,
    userName: actor.name || event.userName || null,
    role: actor.roleKey || event.role || null,
    deviceId: event.deviceId || null,
    ip: event.ip || null,
    action: event.action,
    entityType: event.entityType || null,
    entityId: event.entityId || null,
    before: truncate(sanitise(event.before)),
    after: truncate(sanitise(event.after)),
    message: event.message || null,
  };

  await workbook.mutateDeferred(
    'System',
    (api) => {
      api.rows('AuditEvents').push({ ...row, id: crud.newId() });
    },
    { label: 'audit' }
  );

  if (CRITICAL.has(event.action) || event.flush) {
    await workbook.flush('System');
  } else {
    scheduleFlush();
  }
  return row;
}

/** Convenience wrapper for route handlers: pulls actor and request context off req. */
function fromRequest(req, event) {
  return log({
    ...event,
    actor: req.user
      ? { id: req.user.id, name: req.user.name, roleKey: req.user.roleKey }
      : event.actor,
    deviceId: req.deviceId || req.cookies?.deviceId || null,
    ip: req.clientIp || req.ip || null,
  });
}

async function list(options = {}) {
  const {
    from = null,
    to = null,
    userId = null,
    action = null,
    entityType = null,
    search = '',
    page = 1,
    pageSize = 50,
  } = options;

  const rows = await workbook.read('System', 'AuditEvents');
  const term = String(search || '').trim().toLowerCase();

  let filtered = rows.filter((row) => {
    if (from && (!row.at || row.at < from)) return false;
    if (to && (!row.at || row.at > `${to}T23:59:59.999Z`)) return false;
    if (userId && row.userId !== userId) return false;
    if (action && row.action !== action) return false;
    if (entityType && row.entityType !== entityType) return false;
    if (term) {
      const haystack = [
        row.userName,
        row.action,
        row.entityType,
        row.entityId,
        row.message,
        row.ip,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  const total = filtered.length;
  const size = Math.max(1, Number(pageSize) || 50);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * size;

  return {
    rows: filtered.slice(start, start + size),
    total,
    page: current,
    pageSize: size,
    pages,
  };
}

async function countSince(action, sinceIso) {
  const rows = await workbook.read('System', 'AuditEvents');
  return rows.filter((r) => r.action === action && r.at && r.at >= sinceIso).length;
}

async function distinctActions() {
  const rows = await workbook.read('System', 'AuditEvents');
  return [...new Set(rows.map((r) => r.action).filter(Boolean))].sort();
}

async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return workbook.flush('System');
}

module.exports = {
  ACTIONS,
  log,
  fromRequest,
  list,
  countSince,
  distinctActions,
  flushNow,
};
