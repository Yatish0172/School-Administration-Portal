'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const schema = require('./schema');
const academics = require('./academics');
const settings = require('./settings');
const hoursService = require('../services/hours');
const errors = require('../errors');

/**
 * Student attendance (SPEC §9).
 *
 * This module carries the heaviest load — around 25 teachers submitting between
 * 8:00 and 8:30. A whole section is written in a single lock acquisition and a
 * single disk write, and reads never lock at all.
 *
 * One workbook per academic year, one sheet per month (CLAUDE.md §6).
 */

const STATUSES = ['Present', 'Absent', 'Late', 'Half Day', 'Leave'];
const PRESENT_WEIGHT = { Present: 1, Late: 1, 'Half Day': 0.5, Absent: 0, Leave: 0 };

function monthSheet(date) {
  return String(date).slice(0, 7);
}

function bookFor(yearName) {
  return schema.workbookKey('Attendance', yearName);
}

function requireStatus(status) {
  if (!STATUSES.includes(status)) {
    throw errors.badRequest(`Attendance status must be one of: ${STATUSES.join(', ')}.`);
  }
}

/* ------------------------------------------------------------------ reading */

async function forSection({ yearName, date, sectionId, periodNo = null }) {
  const book = bookFor(yearName);
  const rows = await workbook.read(book, monthSheet(date));
  return rows.filter(
    (row) =>
      row.date === date &&
      row.sectionId === sectionId &&
      (periodNo === null ? !row.periodNo : Number(row.periodNo) === Number(periodNo))
  );
}

async function forDate({ yearName, date }) {
  const book = bookFor(yearName);
  const rows = await workbook.read(book, monthSheet(date));
  return rows.filter((row) => row.date === date);
}

async function forStudent({ yearName, studentId, from = null, to = null }) {
  const book = bookFor(yearName);
  const months = await workbook.sheetNames(book);
  const out = [];
  for (const sheet of months) {
    if (!/^\d{4}-\d{2}$/.test(sheet)) continue;
    if (from && sheet < from.slice(0, 7)) continue;
    if (to && sheet > to.slice(0, 7)) continue;
    const rows = await workbook.read(book, sheet);
    for (const row of rows) {
      if (row.studentId !== studentId) continue;
      if (from && row.date < from) continue;
      if (to && row.date > to) continue;
      out.push(row);
    }
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

async function forRange({ yearName, from, to, sectionId = null, classId = null }) {
  const book = bookFor(yearName);
  const months = await workbook.sheetNames(book);
  const out = [];
  for (const sheet of months) {
    if (!/^\d{4}-\d{2}$/.test(sheet)) continue;
    if (sheet < from.slice(0, 7) || sheet > to.slice(0, 7)) continue;
    const rows = await workbook.read(book, sheet);
    for (const row of rows) {
      if (row.date < from || row.date > to) continue;
      if (sectionId && row.sectionId !== sectionId) continue;
      if (classId && row.classId !== classId) continue;
      out.push(row);
    }
  }
  return out;
}

/**
 * Roster plus whatever is already marked, which is what the marking screen loads.
 * Returns students in roll-number order so the teacher's eye can follow the list.
 */
async function roster({ yearId, yearName, sectionId, date, periodNo = null }) {
  const students = require('./students');
  const users = require('./users');
  const enrollments = await academics.listEnrollments({
    academicYearId: yearId,
    sectionId,
  });
  const existing = await forSection({ yearName, date, sectionId, periodNo });
  const byStudent = new Map(existing.map((row) => [row.studentId, row]));
  const names = await users.displayNames();

  const rows = [];
  for (const enrollment of enrollments) {
    const student = await students.get(enrollment.studentId);
    if (!student || student.status !== 'Active') continue;
    const marked = byStudent.get(enrollment.studentId) || null;
    rows.push({
      studentId: enrollment.studentId,
      enrollmentId: enrollment.id,
      admissionNo: student.admissionNo,
      name: student.fullName,
      rollNo: enrollment.rollNo,
      status: marked ? marked.status : null,
      reason: marked ? marked.reason : null,
      markedAt: marked ? marked.markedAt : null,
      markedBy: marked ? names.get(marked.markedBy) || marked.markedBy : null,
      _rev: marked ? marked._rev : null,
      recordId: marked ? marked.id : null,
    });
  }

  rows.sort((a, b) => crud.compareValues(a.rollNo, b.rollNo) || crud.compareValues(a.name, b.name));

  const lock = await lockState(date);
  return { rows, date, sectionId, periodNo, lock, marked: existing.length > 0 };
}

/* -------------------------------------------------------------------- locking */

/**
 * Attendance locks a configurable number of hours after the date it belongs to
 * (default 24h). After that, changes need `attendance.correct` and are logged
 * with old value, new value and reason.
 */
async function lockState(date) {
  const lockHours = Number(await settings.get('attendance.lockHours', 24)) || 24;
  const dayEnd = hoursService.instantAt(date, '23:59');
  const locksAt = new Date(dayEnd.getTime() + lockHours * 3600000);
  const locked = Date.now() > locksAt.getTime();
  return {
    locked,
    locksAt: locksAt.toISOString(),
    lockHours,
    message: locked
      ? `Attendance for ${date} locked ${lockHours} hours after that day. A correction needs the attendance-correction permission and a reason.`
      : null,
  };
}

/* ------------------------------------------------------------------ writing */

/**
 * Marks a whole section in one write. Existing rows for the same
 * date + student + period are updated in place, so re-submitting is safe.
 *
 * @param {object} input
 * @param {Array<{studentId, status, reason}>} input.entries
 */
async function markSection({ yearId, yearName, date, sectionId, classId, periodNo = null, entries }, ctx) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw errors.badRequest('Choose a valid date.');
  }
  if (date > hoursService.parts().date) {
    throw errors.badRequest('Attendance cannot be marked for a future date.');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw errors.badRequest('There is nothing to save.');
  }
  for (const entry of entries) requireStatus(entry.status);

  const lock = await lockState(date);
  if (lock.locked) throw errors.locked(lock.message);

  await academics.assertYearOpen(yearId);

  const book = bookFor(yearName);
  const sheet = monthSheet(date);

  // Enrollment ids are resolved before the lock so the locked section stays short.
  const enrollments = await academics.listEnrollments({ academicYearId: yearId, sectionId });
  const enrollmentByStudent = new Map(enrollments.map((e) => [e.studentId, e]));
  for (const entry of entries) {
    if (!enrollmentByStudent.has(entry.studentId)) {
      throw errors.badRequest(
        'One of those students is not enrolled in this section. Reload the screen and try again.'
      );
    }
  }

  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows(sheet);
      const index = new Map();
      rows.forEach((row, position) => {
        if (row.date !== date || row.sectionId !== sectionId) return;
        const key = `${row.studentId}|${row.periodNo || ''}`;
        index.set(key, position);
      });

      let created = 0;
      let updated = 0;
      const now = crud.nowIso();

      for (const entry of entries) {
        const key = `${entry.studentId}|${periodNo || ''}`;
        const position = index.get(key);
        const enrollment = enrollmentByStudent.get(entry.studentId);
        const payload = {
          date,
          studentId: entry.studentId,
          enrollmentId: enrollment.id,
          classId: classId || enrollment.classId,
          sectionId,
          periodNo: periodNo || null,
          status: entry.status,
          reason: entry.reason || null,
          markedBy: crud.actorOf(ctx),
          markedAt: now,
        };

        if (position === undefined) {
          crud.insertInto(api, book, sheet, payload, ctx);
          created += 1;
        } else {
          const current = rows[position];
          if (current.status === entry.status && (current.reason || null) === (entry.reason || null)) {
            continue; // no change, no version bump
          }
          rows[position] = {
            ...current,
            ...payload,
            id: current.id,
            _rev: Number(current._rev || 1) + 1,
            createdBy: current.createdBy,
            createdAt: current.createdAt,
            updatedBy: crud.actorOf(ctx),
            updatedAt: now,
          };
          updated += 1;
        }
      }

      const summary = summarise(
        rows.filter((row) => row.date === date && row.sectionId === sectionId)
      );
      return { created, updated, total: entries.length, summary };
    },
    { label: `mark attendance ${sectionId} ${date}` }
  );
}

/**
 * Correction after the lock window. Records old value, new value and reason in
 * AttendanceCorrections as well as updating the row (SPEC §9).
 */
async function correct({ yearName, date, studentId, sectionId, periodNo = null, newStatus, reason }, ctx) {
  requireStatus(newStatus);
  if (!reason || String(reason).trim().length < 3) {
    throw errors.validation('Give a reason for the correction — it is recorded against your name.', {
      reason: 'Enter a reason.',
    });
  }

  const book = bookFor(yearName);
  const sheet = monthSheet(date);

  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows(sheet);
      const position = rows.findIndex(
        (row) =>
          row.date === date &&
          row.studentId === studentId &&
          row.sectionId === sectionId &&
          (periodNo === null ? !row.periodNo : Number(row.periodNo) === Number(periodNo))
      );
      if (position === -1) {
        throw errors.notFound('There is no attendance record for that student on that date.');
      }
      const current = rows[position];
      if (current.status === newStatus) {
        throw errors.badRequest('That is already the recorded status.');
      }

      rows[position] = {
        ...current,
        status: newStatus,
        reason: String(reason).trim(),
        _rev: Number(current._rev || 1) + 1,
        updatedBy: crud.actorOf(ctx),
        updatedAt: crud.nowIso(),
      };

      crud.insertInto(
        api,
        book,
        'AttendanceCorrections',
        {
          date,
          studentId,
          sectionId,
          periodNo: periodNo || null,
          oldStatus: current.status,
          newStatus,
          reason: String(reason).trim(),
          correctedBy: crud.actorOf(ctx),
          correctedAt: crud.nowIso(),
        },
        ctx
      );

      return { before: current, after: rows[position] };
    },
    { label: 'correct attendance' }
  );
}

async function corrections({ yearName, from = null, to = null, sectionId = null }) {
  const users = require('./users');
  const book = bookFor(yearName);
  const rows = await workbook.read(book, 'AttendanceCorrections');
  const names = await users.displayNames();
  return rows
    .filter((row) => {
      if (from && row.date < from) return false;
      if (to && row.date > to) return false;
      if (sectionId && row.sectionId !== sectionId) return false;
      return true;
    })
    .map((row) => ({ ...row, correctedBy: names.get(row.correctedBy) || row.correctedBy }))
    .sort((a, b) => String(b.correctedAt || '').localeCompare(String(a.correctedAt || '')));
}

/* ------------------------------------------------------------------ reports */

function summarise(rows) {
  const summary = { total: rows.length };
  for (const status of STATUSES) summary[status] = 0;
  for (const row of rows) {
    summary[row.status] = (summary[row.status] || 0) + 1;
  }
  summary.presentEquivalent = rows.reduce(
    (sum, row) => sum + (PRESENT_WEIGHT[row.status] ?? 0),
    0
  );
  summary.percent = rows.length
    ? Math.round((summary.presentEquivalent / rows.length) * 1000) / 10
    : null;
  return summary;
}

/** Daily register: one row per section for a date, with counts and who marked it. */
async function dailyRegister({ yearId, yearName, date }) {
  const users = require('./users');
  const rows = await forDate({ yearName, date });
  const sections = await academics.listSections({ academicYearId: yearId });
  const classes = await academics.listClasses();
  const classById = new Map(classes.map((c) => [c.id, c]));
  const names = await users.displayNames();
  const bySection = new Map();

  for (const row of rows) {
    if (!bySection.has(row.sectionId)) bySection.set(row.sectionId, []);
    bySection.get(row.sectionId).push(row);
  }

  const enrollments = await academics.listEnrollments({ academicYearId: yearId });
  const strength = new Map();
  for (const enrollment of enrollments) {
    strength.set(enrollment.sectionId, (strength.get(enrollment.sectionId) || 0) + 1);
  }

  return sections.map((section) => {
    const sectionRows = bySection.get(section.id) || [];
    const summary = summarise(sectionRows);
    return {
      sectionId: section.id,
      sectionName: section.name,
      classId: section.classId,
      className: classById.get(section.classId)?.name || '',
      strength: strength.get(section.id) || 0,
      marked: sectionRows.length > 0,
      markedBy: sectionRows[0]?.markedBy
        ? names.get(sectionRows[0].markedBy) || sectionRows[0].markedBy
        : null,
      markedAt: sectionRows[0]?.markedAt || null,
      ...summary,
    };
  });
}

/** Sections that have not been marked today — the teacher dashboard tile. */
async function unmarkedSections({ yearId, yearName, date, sectionIds = null }) {
  const register = await dailyRegister({ yearId, yearName, date });
  return register.filter((entry) => {
    if (entry.strength === 0) return false;
    if (sectionIds && !sectionIds.includes(entry.sectionId)) return false;
    return !entry.marked;
  });
}

/** Absent list for the office to call parents (SPEC §9). */
async function absentList({ yearId, yearName, date }) {
  const students = require('./students');
  const rows = (await forDate({ yearName, date })).filter(
    (row) => row.status === 'Absent' || row.status === 'Leave'
  );
  const sections = await academics.listSections({ academicYearId: yearId });
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const classes = await academics.listClasses();
  const classById = new Map(classes.map((c) => [c.id, c]));

  const out = [];
  for (const row of rows) {
    const student = await students.get(row.studentId);
    if (!student) continue;
    const guardian = await students.primaryGuardian(row.studentId);
    const section = sectionById.get(row.sectionId);
    out.push({
      studentId: row.studentId,
      admissionNo: student.admissionNo,
      name: student.fullName,
      className: classById.get(section?.classId)?.name || '',
      sectionName: section?.name || '',
      status: row.status,
      reason: row.reason,
      guardianName: guardian?.name || '',
      guardianPhone: guardian?.phone || '',
    });
  }
  return out.sort(
    (a, b) =>
      crud.compareValues(a.className, b.className) ||
      crud.compareValues(a.sectionName, b.sectionName) ||
      crud.compareValues(a.name, b.name)
  );
}

/** Monthly percentage per student for a section. */
async function monthlyReport({ yearId, yearName, month, sectionId }) {
  const students = require('./students');
  const from = `${month}-01`;
  const to = `${month}-31`;
  const rows = await forRange({ yearName, from, to, sectionId });

  const workingDays = [...new Set(rows.map((row) => row.date))].sort();
  const byStudent = new Map();
  for (const row of rows) {
    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
    byStudent.get(row.studentId).push(row);
  }

  const enrollments = await academics.listEnrollments({ academicYearId: yearId, sectionId });
  const out = [];
  for (const enrollment of enrollments) {
    const student = await students.get(enrollment.studentId);
    if (!student) continue;
    const studentRows = byStudent.get(enrollment.studentId) || [];
    const summary = summarise(studentRows);
    out.push({
      studentId: enrollment.studentId,
      admissionNo: student.admissionNo,
      rollNo: enrollment.rollNo,
      name: student.fullName,
      workingDays: workingDays.length,
      ...summary,
      percent: workingDays.length
        ? Math.round((summary.presentEquivalent / workingDays.length) * 1000) / 10
        : null,
    });
  }

  out.sort((a, b) => crud.compareValues(a.rollNo, b.rollNo));
  return { month, sectionId, workingDays, rows: out };
}

/** Students below the defaulter threshold across a date range. */
async function defaulters({ yearId, yearName, from, to, threshold = null, sectionIds = null }) {
  const students = require('./students');
  const limit = Number(threshold ?? (await settings.get('attendance.defaulterThreshold', 75)));
  const rows = await forRange({ yearName, from, to });

  const byStudent = new Map();
  const daysBySection = new Map();
  for (const row of rows) {
    if (sectionIds && !sectionIds.includes(row.sectionId)) continue;
    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
    byStudent.get(row.studentId).push(row);
    if (!daysBySection.has(row.sectionId)) daysBySection.set(row.sectionId, new Set());
    daysBySection.get(row.sectionId).add(row.date);
  }

  const sections = await academics.listSections({ academicYearId: yearId });
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const classes = await academics.listClasses();
  const classById = new Map(classes.map((c) => [c.id, c]));

  const out = [];
  for (const [studentId, studentRows] of byStudent) {
    const summary = summarise(studentRows);
    const sectionId = studentRows[0].sectionId;
    const days = daysBySection.get(sectionId)?.size || studentRows.length;
    const percent = days ? Math.round((summary.presentEquivalent / days) * 1000) / 10 : null;
    if (percent === null || percent >= limit) continue;
    const student = await students.get(studentId);
    if (!student) continue;
    const guardian = await students.primaryGuardian(studentId);
    const section = sectionById.get(sectionId);
    out.push({
      studentId,
      admissionNo: student.admissionNo,
      name: student.fullName,
      className: classById.get(section?.classId)?.name || '',
      sectionName: section?.name || '',
      workingDays: days,
      present: summary.presentEquivalent,
      absent: summary.Absent,
      percent,
      guardianName: guardian?.name || '',
      guardianPhone: guardian?.phone || '',
    });
  }

  return { threshold: limit, from, to, rows: out.sort((a, b) => a.percent - b.percent) };
}

/** Class comparison for the admin dashboard and reports. */
async function classComparison({ yearId, yearName, from, to }) {
  const rows = await forRange({ yearName, from, to });
  const sections = await academics.listSections({ academicYearId: yearId });
  const classes = await academics.listClasses();
  const classById = new Map(classes.map((c) => [c.id, c]));
  const sectionById = new Map(sections.map((s) => [s.id, s]));

  const byClass = new Map();
  for (const row of rows) {
    const section = sectionById.get(row.sectionId);
    const classId = section?.classId || row.classId;
    if (!byClass.has(classId)) byClass.set(classId, []);
    byClass.get(classId).push(row);
  }

  const out = [];
  for (const [classId, classRows] of byClass) {
    const summary = summarise(classRows);
    out.push({
      classId,
      className: classById.get(classId)?.name || 'Unknown',
      records: classRows.length,
      ...summary,
    });
  }
  return out.sort((a, b) => crud.compareValues(a.className, b.className));
}

/** Today's overall percentage for the dashboard. */
async function todayPercent({ yearName, date }) {
  const rows = await forDate({ yearName, date });
  if (!rows.length) return { percent: null, marked: 0 };
  const summary = summarise(rows);
  return { percent: summary.percent, marked: rows.length, ...summary };
}

module.exports = {
  STATUSES,
  PRESENT_WEIGHT,
  monthSheet,
  bookFor,
  forSection,
  forDate,
  forStudent,
  forRange,
  roster,
  lockState,
  markSection,
  correct,
  corrections,
  summarise,
  dailyRegister,
  unmarkedSections,
  absentList,
  monthlyReport,
  defaulters,
  classComparison,
  todayPercent,
};
