'use strict';

const express = require('express');

const { ok, handler } = require('../http');
const { need, has } = require('../middleware/permission');
const academics = require('../store/academics');
const students = require('../store/students');
const attendance = require('../store/attendance');
const fees = require('../store/fees');
const library = require('../store/library');
const transport = require('../store/transport');
const notices = require('../store/notices');
const enquiries = require('../store/enquiries');
const staff = require('../store/staff');
const audit = require('../store/audit');
const sessions = require('../store/sessions');
const settings = require('../store/settings');
const hours = require('../services/hours');
const backup = require('../services/backup');
const license = require('../services/license');

const router = express.Router();

/**
 * Role-aware dashboard (SPEC §5). Every version carries the server time and the
 * portal's closing time, because that is the thing staff most need to know.
 *
 * Tiles are gathered by permission, not by role name, so a school that reshuffles
 * departments gets a sensible dashboard without a code change.
 */
router.get(
  '/dashboard',
  need('dashboard.view'),
  handler(async (req, res) => {
    const state = await hours.state();
    const verdict = await hours.accessFor(req.user.roleKey, state);
    const year = await academics.currentYear();
    const today = state.localDate;

    const payload = {
      serverTime: state.serverTime,
      localTime: state.localTime,
      localDate: today,
      dayName: state.dayName,
      phase: state.phase,
      access: verdict.access,
      hoursMessage: verdict.message,
      closesAt: state.closesAt || null,
      closeTimeLabel: state.closeTimeLabel || null,
      nextOpening: state.nextOpening || null,
      override: state.override,
      academicYear: year ? { id: year.id, name: year.name, status: year.status } : null,
      schoolName: await settings.get('school.name', 'My School'),
      greetingName: req.user.name,
      tiles: {},
      alerts: [],
      notices: [],
    };

    if (!year) {
      payload.alerts.push({
        severity: 'warning',
        message:
          'No academic year has been set up yet. An administrator needs to create one under Settings → Academic Years before students can be admitted.',
      });
    }

    /* ---------------------------------------------------------- enrolment */
    if (has(req.user, 'student.view')) {
      const counts = await students.counts();
      payload.tiles.enrolment = {
        active: counts.byStatus.Active || 0,
        total: counts.total,
        byStatus: counts.byStatus,
      };
    }

    /* -------------------------------------------------------- attendance */
    if (year && has(req.user, 'attendance.view')) {
      payload.tiles.attendance = await attendance.todayPercent({ yearName: year.name, date: today });

      const scopedSections =
        has(req.user, 'attendance.mark.any')
          ? null
          : await academics.sectionsForTeacher(req.user.id, year.id);
      const pending = await attendance.unmarkedSections({
        yearId: year.id,
        yearName: year.name,
        date: today,
        sectionIds: scopedSections,
      });
      payload.tiles.attendancePending = {
        count: pending.length,
        sections: pending.slice(0, 10).map((entry) => ({
          sectionId: entry.sectionId,
          label: `${entry.className} ${entry.sectionName}`.trim(),
          strength: entry.strength,
        })),
      };
    }

    /* --------------------------------------------------------------- fees */
    if (year && has(req.user, 'fees.view')) {
      payload.tiles.fees = await fees.dashboardTotals(year.name, today);
    }
    if (year && has(req.user, 'fees.report')) {
      const dues = await fees.dues(year.name, { yearId: year.id });
      payload.tiles.dues = {
        outstanding: dues.totals.outstanding,
        students: dues.totals.students,
        topDefaulters: dues.rows.slice(0, 5).map((row) => ({
          name: row.name,
          className: `${row.className} ${row.sectionName}`.trim(),
          total: row.total,
          phone: row.guardianPhone,
        })),
      };
    }
    if (year && has(req.user, 'fees.concession.approve')) {
      const pending = await fees.listConcessions(year.name, { status: 'pending' });
      if (pending.length) {
        payload.alerts.push({
          severity: 'info',
          message: `${pending.length} concession request${pending.length === 1 ? '' : 's'} waiting for your approval.`,
          route: '#/fees/concessions',
        });
      }
    }
    if (year && has(req.user, 'fees.reverse.approve')) {
      const pending = await fees.listReversals(year.name, { status: 'pending' });
      if (pending.length) {
        payload.alerts.push({
          severity: 'warning',
          message: `${pending.length} payment reversal${pending.length === 1 ? '' : 's'} waiting for your approval.`,
          route: '#/fees/reversals',
        });
      }
    }

    /* ---------------------------------------------------------- admissions */
    if (has(req.user, 'enquiry.view')) {
      const due = await enquiries.dueFollowUps(today);
      const funnel = await enquiries.funnel({});
      payload.tiles.admissions = {
        openEnquiries: funnel.total - funnel.converted,
        converted: funnel.converted,
        followUpsDue: due.length,
        due: due.slice(0, 8).map((row) => ({
          id: row.id,
          childName: row.childName,
          parentName: row.parentName,
          phone: row.phone,
          followUpDate: row.followUpDate,
        })),
      };
    }

    /* ------------------------------------------------------------ birthdays */
    if (has(req.user, 'student.view')) {
      const birthdays = await students.birthdaysToday(today.slice(5));
      payload.tiles.birthdays = birthdays.slice(0, 12).map((student) => ({
        id: student.id,
        name: student.fullName,
        admissionNo: student.admissionNo,
      }));
    }

    /* ------------------------------------------------------------- library */
    if (has(req.user, 'library.view')) {
      payload.tiles.library = await library.dashboardTotals();
    }

    /* ----------------------------------------------------------- transport */
    if (has(req.user, 'transport.view')) {
      const alerts = await transport.expiryAlerts();
      payload.tiles.transport = {
        routes: (await transport.listRoutes()).length,
        expiring: alerts.length,
        alerts: alerts.slice(0, 5),
      };
      for (const alert of alerts.filter((a) => a.expired)) {
        payload.alerts.push({
          severity: 'critical',
          message: `${alert.kind} ${alert.name}: ${labelFor(alert.field)} expired on ${alert.expiresOn}.`,
          route: '#/transport',
        });
      }
    }

    /* --------------------------------------------------------------- staff */
    if (has(req.user, 'staff.view')) {
      const all = await staff.list({ pageSize: 0 });
      payload.tiles.staff = {
        active: all.rows.filter((s) => s.status === 'active').length,
        total: all.rows.length,
      };
    }
    if (year && has(req.user, 'leave.approve')) {
      const pending = await staff.listLeave(year.name, { status: 'pending' });
      if (pending.length) {
        payload.alerts.push({
          severity: 'info',
          message: `${pending.length} leave request${pending.length === 1 ? '' : 's'} waiting for approval.`,
          route: '#/leave',
        });
      }
    }

    /* ------------------------------------------------------- admin tiles */
    if (has(req.user, 'backup.run')) {
      const status = await backup.status();
      payload.tiles.backup = {
        lastSuccessAt: status.lastSuccess?.at || null,
        hoursSince: status.hoursSince,
        severity: status.severity,
        sizeBytes: status.lastSuccess?.sizeBytes || null,
      };
      if (status.message) {
        payload.alerts.push({
          severity: status.severity === 'critical' ? 'critical' : 'warning',
          message: status.message,
          route: '#/admin/backup',
        });
      }
    }

    if (has(req.user, 'license.manage')) {
      const state2 = await license.state();
      payload.tiles.license = {
        status: state2.status,
        daysLeft: state2.daysLeft,
        severity: state2.severity,
      };
      if (state2.message) {
        payload.alerts.push({
          severity: state2.severity === 'critical' ? 'critical' : 'info',
          message: state2.message,
          route: '#/admin/license',
        });
      }
    }

    if (has(req.user, 'user.manage')) {
      payload.tiles.online = { count: sessions.count(), users: sessions.online().slice(0, 10) };
    }

    if (has(req.user, 'audit.view')) {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      payload.tiles.security = {
        refusedForHours: await audit.countSince(audit.ACTIONS.OUT_OF_HOURS_ATTEMPT, weekAgo),
        failedLogins: await audit.countSince(audit.ACTIONS.LOGIN_FAILED, weekAgo),
        lockouts: await audit.countSince(audit.ACTIONS.LOGIN_LOCKED, weekAgo),
        deviceRefusals: await audit.countSince(audit.ACTIONS.DEVICE_REFUSED, weekAgo),
      };
    }

    /* ------------------------------------------------------------ notices */
    let classIds = [];
    if (year) {
      classIds = (await academics.listClasses()).map((c) => c.id);
    }
    payload.notices = (await notices.forUser(req.user, { classIds })).slice(0, 5);

    /* ------------------------------------------------- teacher's own day */
    if (year && has(req.user, 'timetable.view')) {
      const slots = await academics.listTimetable({
        academicYearId: year.id,
        teacherUserId: req.user.id,
      });
      const todaySlots = slots.filter((slot) => Number(slot.day) === hours.dayOfDate(today));
      if (todaySlots.length) {
        const subjects = await academics.listSubjects({ academicYearId: year.id });
        const subjectById = new Map(subjects.map((s) => [s.id, s]));
        const sections = await academics.listSections({ academicYearId: year.id });
        const sectionById = new Map(sections.map((s) => [s.id, s]));
        const classes = await academics.listClasses();
        const classById = new Map(classes.map((c) => [c.id, c]));
        const periods = await academics.listPeriods(year.id);
        const periodById = new Map(periods.map((p) => [Number(p.period), p]));

        payload.tiles.myPeriods = todaySlots
          .sort((a, b) => Number(a.period) - Number(b.period))
          .map((slot) => ({
            period: slot.period,
            startTime: periodById.get(Number(slot.period))?.startTime || null,
            endTime: periodById.get(Number(slot.period))?.endTime || null,
            subjectName: subjectById.get(slot.subjectId)?.name || '',
            label: `${classById.get(slot.classId)?.name || ''} ${
              sectionById.get(slot.sectionId)?.name || ''
            }`.trim(),
            sectionId: slot.sectionId,
            roomNo: slot.roomNo,
          }));
      }
    }

    return ok(res, payload);
  })
);

function labelFor(field) {
  const labels = {
    insuranceExpiry: 'insurance',
    fitnessExpiry: 'fitness certificate',
    pucExpiry: 'PUC certificate',
    permitExpiry: 'permit',
    licenceExpiry: 'driving licence',
  };
  return labels[field] || field;
}

module.exports = { router };
