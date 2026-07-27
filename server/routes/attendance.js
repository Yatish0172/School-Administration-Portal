'use strict';

const express = require('express');

const { ok, handler, body, str, num, isoDate } = require('../http');
const { need, needAny, scope, assertSection, has } = require('../middleware/permission');
const attendance = require('../store/attendance');
const academics = require('../store/academics');
const staff = require('../store/staff');
const exporter = require('../store/exporter');
const audit = require('../store/audit');
const settings = require('../store/settings');
const hours = require('../services/hours');
const { sendXlsx } = require('./system');
const { exportMeta, auditExport } = require('./students');
const errors = require('../errors');

const router = express.Router();
const ctxOf = (req) => ({ userId: req.user.id, name: req.user.name });

const today = () => hours.parts().date;

/* -------------------------------------------------------- student attendance */

/**
 * The marking screen. Scoped: a class teacher only ever sees their own sections,
 * enforced server-side (CLAUDE.md security rules).
 */
router.get(
  '/attendance/roster',
  need('attendance.view'),
  scope({ anyPermission: 'attendance.mark.any' }),
  handler(async (req, res) => {
    const year = req.scope.year;
    const sectionId = str(req.query.sectionId, { max: 40 });
    const date = isoDate(req.query.date) || today();
    assertSection(req, sectionId);

    const periodNo = num(req.query.periodNo, { min: 1, max: 20 });
    const roster = await attendance.roster({
      yearId: year.id,
      yearName: year.name,
      sectionId,
      date,
      periodNo,
    });

    return ok(res, {
      ...roster,
      statuses: attendance.STATUSES,
      canCorrect: has(req.user, 'attendance.correct'),
      periodWise: await settings.get('attendance.periodWise', false),
    });
  })
);

/** Which of my sections still need marking today. */
router.get(
  '/attendance/pending',
  need('attendance.view'),
  scope({ anyPermission: 'attendance.mark.any' }),
  handler(async (req, res) => {
    const year = req.scope.year;
    const date = isoDate(req.query.date) || today();
    const rows = await attendance.unmarkedSections({
      yearId: year.id,
      yearName: year.name,
      date,
      sectionIds: req.scope.allSections ? null : req.scope.sectionIds,
    });
    return ok(res, { date, rows });
  })
);

/**
 * Bulk save. The client sends the whole section — "mark all present, then flag
 * absentees" is the workflow teachers expect, and this is one disk write.
 */
router.post(
  '/attendance/mark',
  needAny('attendance.mark.assigned', 'attendance.mark.any'),
  scope({ anyPermission: 'attendance.mark.any' }),
  handler(async (req, res) => {
    const input = body(req);
    const year = req.scope.year;
    const sectionId = str(input.sectionId, { max: 40 });
    const date = isoDate(input.date) || today();
    assertSection(req, sectionId);

    if (!Array.isArray(input.entries)) throw errors.badRequest('There is nothing to save.');

    const result = await attendance.markSection(
      {
        yearId: year.id,
        yearName: year.name,
        date,
        sectionId,
        classId: str(input.classId, { max: 40 }),
        periodNo: num(input.periodNo, { min: 1, max: 20 }),
        entries: input.entries.map((entry) => ({
          studentId: String(entry.studentId),
          status: str(entry.status, { max: 12 }),
          reason: str(entry.reason, { max: 200 }),
        })),
      },
      ctxOf(req)
    );

    await audit.fromRequest(req, {
      action: audit.ACTIONS.ATTENDANCE_MARKED,
      entityType: 'attendance',
      entityId: `${sectionId}|${date}`,
      after: result.summary,
      message: `Marked attendance for ${date}: ${result.created} new, ${result.updated} changed`,
    });

    return ok(res, result);
  })
);

/** Correction after the lock window. Needs attendance.correct and a reason. */
router.post(
  '/attendance/correct',
  need('attendance.correct'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const result = await attendance.correct(
      {
        yearName: year.name,
        date: isoDate(input.date),
        studentId: str(input.studentId, { max: 40 }),
        sectionId: str(input.sectionId, { max: 40 }),
        periodNo: num(input.periodNo, { min: 1, max: 20 }),
        newStatus: str(input.newStatus, { max: 12 }),
        reason: str(input.reason, { max: 300 }),
      },
      ctxOf(req)
    );

    await audit.fromRequest(req, {
      action: audit.ACTIONS.ATTENDANCE_CORRECTED,
      entityType: 'attendance',
      entityId: result.after.id,
      before: { status: result.before.status },
      after: { status: result.after.status, reason: result.after.reason },
      message: `Corrected attendance for ${input.date}: ${result.before.status} to ${result.after.status}`,
    });

    return ok(res, result.after);
  })
);

router.get(
  '/attendance/corrections',
  need('attendance.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    return ok(res, {
      rows: await attendance.corrections({
        yearName: year.name,
        from: isoDate(req.query.from),
        to: isoDate(req.query.to),
        sectionId: str(req.query.sectionId, { max: 40 }),
      }),
    });
  })
);

router.get(
  '/attendance/student/:studentId',
  need('attendance.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const rows = await attendance.forStudent({
      yearName: year.name,
      studentId: req.params.studentId,
      from: isoDate(req.query.from) || year.startDate,
      to: isoDate(req.query.to) || year.endDate,
    });
    return ok(res, { rows, summary: attendance.summarise(rows) });
  })
);

/* ------------------------------------------------------------------ reports */

router.get(
  '/attendance/reports/register',
  need('attendance.report'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const date = isoDate(req.query.date) || today();
    return ok(res, {
      date,
      rows: await attendance.dailyRegister({ yearId: year.id, yearName: year.name, date }),
    });
  })
);

router.get(
  '/attendance/reports/absent',
  need('attendance.report'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const date = isoDate(req.query.date) || today();
    return ok(res, {
      date,
      rows: await attendance.absentList({ yearId: year.id, yearName: year.name, date }),
    });
  })
);

router.get(
  '/attendance/reports/monthly',
  need('attendance.report'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const month = str(req.query.month, { max: 7 }) || today().slice(0, 7);
    const sectionId = str(req.query.sectionId, { max: 40 });
    if (!sectionId) throw errors.badRequest('Choose a section.');
    return ok(
      res,
      await attendance.monthlyReport({ yearId: year.id, yearName: year.name, month, sectionId })
    );
  })
);

router.get(
  '/attendance/reports/defaulters',
  need('attendance.report'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    return ok(
      res,
      await attendance.defaulters({
        yearId: year.id,
        yearName: year.name,
        from: isoDate(req.query.from) || year.startDate,
        to: isoDate(req.query.to) || today(),
        threshold: num(req.query.threshold, { min: 1, max: 100 }),
      })
    );
  })
);

router.get(
  '/attendance/reports/comparison',
  need('attendance.report'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    return ok(res, {
      rows: await attendance.classComparison({
        yearId: year.id,
        yearName: year.name,
        from: isoDate(req.query.from) || year.startDate,
        to: isoDate(req.query.to) || today(),
      }),
    });
  })
);

/**
 * Exports stay allowed in read-only mode and when the licence has lapsed, which is
 * why they live on their own path prefix the guards recognise.
 */
router.get(
  '/attendance/export/:report',
  need('report.export'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const date = isoDate(req.query.date) || today();
    const meta = await exportMeta(req);

    const specs = {
      register: async () => ({
        title: 'Daily attendance register',
        subtitle: date,
        columns: [
          { key: 'className', label: 'Class', width: 14 },
          { key: 'sectionName', label: 'Section', width: 10 },
          { key: 'strength', label: 'Strength', type: 'num' },
          { key: 'Present', label: 'Present', type: 'num' },
          { key: 'Absent', label: 'Absent', type: 'num' },
          { key: 'Late', label: 'Late', type: 'num' },
          { key: 'Half Day', label: 'Half Day', type: 'num' },
          { key: 'Leave', label: 'Leave', type: 'num' },
          { key: 'percent', label: 'Percent', type: 'num' },
          { key: 'markedBy', label: 'Marked by', width: 20 },
        ],
        rows: await attendance.dailyRegister({ yearId: year.id, yearName: year.name, date }),
      }),
      absent: async () => ({
        title: 'Absent list',
        subtitle: date,
        columns: [
          { key: 'admissionNo', label: 'Admission No', width: 16 },
          { key: 'name', label: 'Student', width: 26 },
          { key: 'className', label: 'Class', width: 12 },
          { key: 'sectionName', label: 'Section', width: 10 },
          { key: 'status', label: 'Status', width: 12 },
          { key: 'reason', label: 'Reason', width: 24 },
          { key: 'guardianName', label: 'Guardian', width: 22 },
          { key: 'guardianPhone', label: 'Phone', width: 14 },
        ],
        rows: await attendance.absentList({ yearId: year.id, yearName: year.name, date }),
      }),
      monthly: async () => {
        const sectionId = str(req.query.sectionId, { max: 40 });
        if (!sectionId) throw errors.badRequest('Choose a section.');
        const month = str(req.query.month, { max: 7 }) || date.slice(0, 7);
        const report = await attendance.monthlyReport({
          yearId: year.id,
          yearName: year.name,
          month,
          sectionId,
        });
        return {
          title: 'Monthly attendance',
          subtitle: `${month} — ${report.workingDays.length} working days`,
          columns: [
            { key: 'rollNo', label: 'Roll No', width: 10 },
            { key: 'admissionNo', label: 'Admission No', width: 16 },
            { key: 'name', label: 'Student', width: 26 },
            { key: 'workingDays', label: 'Working days', type: 'num' },
            { key: 'Present', label: 'Present', type: 'num' },
            { key: 'Absent', label: 'Absent', type: 'num' },
            { key: 'Late', label: 'Late', type: 'num' },
            { key: 'Leave', label: 'Leave', type: 'num' },
            { key: 'percent', label: 'Percent', type: 'num' },
          ],
          rows: report.rows,
        };
      },
      defaulters: async () => {
        const report = await attendance.defaulters({
          yearId: year.id,
          yearName: year.name,
          from: isoDate(req.query.from) || year.startDate,
          to: isoDate(req.query.to) || date,
          threshold: num(req.query.threshold, { min: 1, max: 100 }),
        });
        return {
          title: 'Attendance defaulters',
          subtitle: `Below ${report.threshold}% between ${report.from} and ${report.to}`,
          columns: [
            { key: 'admissionNo', label: 'Admission No', width: 16 },
            { key: 'name', label: 'Student', width: 26 },
            { key: 'className', label: 'Class', width: 12 },
            { key: 'sectionName', label: 'Section', width: 10 },
            { key: 'workingDays', label: 'Working days', type: 'num' },
            { key: 'present', label: 'Present', type: 'num' },
            { key: 'percent', label: 'Percent', type: 'num' },
            { key: 'guardianName', label: 'Guardian', width: 22 },
            { key: 'guardianPhone', label: 'Phone', width: 14 },
          ],
          rows: report.rows,
        };
      },
    };

    const build = specs[req.params.report];
    if (!build) throw errors.notFound('That report does not exist.');
    const spec = await build();
    const buffer = await exporter.buildSingleSheet({ ...spec, meta });
    await auditExport(req, spec.title, spec.rows.length);
    return sendXlsx(res, buffer, exporter.fileName(spec.title));
  })
);

/* ---------------------------------------------------------- staff attendance */

router.get(
  '/staff-attendance/roster',
  need('staffattendance.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const date = isoDate(req.query.date) || today();
    return ok(res, {
      date,
      rows: await staff.attendanceRoster(year.name, date),
      statuses: staff.ATTENDANCE_STATUSES,
      leaveTypes: staff.LEAVE_TYPES,
    });
  })
);

router.post(
  '/staff-attendance/mark',
  need('staffattendance.mark'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    if (!Array.isArray(input.entries)) throw errors.badRequest('There is nothing to save.');
    const result = await staff.markAttendance(
      year.name,
      {
        date: isoDate(input.date) || today(),
        entries: input.entries.map((entry) => ({
          staffId: String(entry.staffId),
          status: str(entry.status, { max: 12 }),
          inTime: str(entry.inTime, { max: 5 }),
          outTime: str(entry.outTime, { max: 5 }),
          leaveType: str(entry.leaveType, { max: 6 }),
          remarks: str(entry.remarks, { max: 200 }),
        })),
      },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.ATTENDANCE_MARKED,
      entityType: 'staffAttendance',
      entityId: isoDate(input.date) || today(),
      after: result,
      message: `Marked staff attendance for ${isoDate(input.date) || today()}`,
    });
    return ok(res, result);
  })
);

router.get(
  '/staff-attendance/monthly',
  need('staffattendance.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const month = str(req.query.month, { max: 7 }) || today().slice(0, 7);
    return ok(res, await staff.monthlySummary(year.name, month));
  })
);

/* -------------------------------------------------------------------- leave */

router.get(
  '/leave',
  needAny('leave.approve', 'leave.request', 'staffattendance.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const canApprove = has(req.user, 'leave.approve');
    const own = await staff.getByUserId(req.user.id);

    const rows = await staff.listLeave(year.name, {
      staffId: canApprove ? str(req.query.staffId, { max: 40 }) : own?.id,
      status: str(req.query.status, { max: 12 }),
    });

    const allStaff = await staff.list({ pageSize: 0 });
    const byId = new Map(allStaff.rows.map((s) => [s.id, s]));

    return ok(res, {
      rows: rows.map((row) => ({ ...row, staffName: byId.get(row.staffId)?.name || 'Unknown' })),
      leaveTypes: staff.LEAVE_TYPES,
      canApprove,
      ownStaffId: own?.id || null,
      balances: own ? await staff.leaveBalances(year.name, own.id) : [],
    });
  })
);

router.post(
  '/leave',
  needAny('leave.request', 'staffattendance.mark'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const own = await staff.getByUserId(req.user.id);
    const staffId = has(req.user, 'leave.approve')
      ? str(input.staffId, { max: 40 }) || own?.id
      : own?.id;
    if (!staffId) {
      throw errors.badRequest('Your login is not linked to a staff record. Ask the office to link it.');
    }

    const row = await staff.requestLeave(
      year.name,
      {
        staffId,
        leaveType: str(input.leaveType, { max: 6 }),
        fromDate: isoDate(input.fromDate),
        toDate: isoDate(input.toDate),
        reason: str(input.reason, { max: 300 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.post(
  '/leave/:id/decide',
  need('leave.approve'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const approve = input.approve === true || input.approve === 'true';
    const result = await staff.decideLeave(
      year.name,
      req.params.id,
      { approve, rejectionReason: str(input.rejectionReason, { max: 300 }) },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.LEAVE_APPROVED,
      entityType: 'leaveRequest',
      entityId: req.params.id,
      before: { status: result.before.status },
      after: { status: result.after.status },
      message: `${approve ? 'Approved' : 'Rejected'} a leave request of ${result.after.days} day(s)`,
    });
    return ok(res, result.after);
  })
);

module.exports = { router };
