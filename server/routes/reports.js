'use strict';

const express = require('express');

const { ok, handler } = require('../http');
const { need, has } = require('../middleware/permission');
const academics = require('../store/academics');

const router = express.Router();

/**
 * The reports centre (SPEC §12). One catalogue so staff do not have to remember
 * which module a report lives under. Each entry names the screen that renders it
 * and the export endpoint that produces the Excel file.
 *
 * Filtered by permission, so the list a class teacher sees is the list they can
 * actually run.
 */
const CATALOGUE = [
  {
    key: 'students',
    module: 'Students',
    title: 'Student list',
    description: 'Every student with class, section, guardian and contact number.',
    permission: 'student.view',
    route: '#/students',
    exportPath: '/api/students/export/list',
    filters: ['academicYear', 'class', 'section', 'status'],
  },
  {
    key: 'parent-contacts',
    module: 'Students',
    title: 'Parent contact list (CSV)',
    description: 'Phone numbers for an external bulk SMS tool. Nothing is sent from the portal.',
    permission: 'report.export',
    route: '#/students',
    exportPath: '/api/students/export/contacts',
    filters: ['academicYear', 'class', 'section'],
    format: 'csv',
  },
  {
    key: 'attendance-register',
    module: 'Attendance',
    title: 'Daily attendance register',
    description: 'One row per section for a date, with counts and who marked it.',
    permission: 'attendance.report',
    route: '#/attendance/reports',
    exportPath: '/api/attendance/export/register',
    filters: ['date'],
  },
  {
    key: 'attendance-absent',
    module: 'Attendance',
    title: 'Absent list',
    description: "Today's absentees with guardian phone numbers, for the office to call.",
    permission: 'attendance.report',
    route: '#/attendance/reports',
    exportPath: '/api/attendance/export/absent',
    filters: ['date'],
  },
  {
    key: 'attendance-monthly',
    module: 'Attendance',
    title: 'Monthly attendance percentage',
    description: 'Per-student percentage for a section over one month.',
    permission: 'attendance.report',
    route: '#/attendance/reports',
    exportPath: '/api/attendance/export/monthly',
    filters: ['month', 'section'],
  },
  {
    key: 'attendance-defaulters',
    module: 'Attendance',
    title: 'Attendance defaulters',
    description: 'Students below the threshold over a date range.',
    permission: 'attendance.report',
    route: '#/attendance/reports',
    exportPath: '/api/attendance/export/defaulters',
    filters: ['dateRange', 'threshold'],
  },
  {
    key: 'exam-analytics',
    module: 'Exams',
    title: 'Result analytics',
    description: 'Subject averages, pass percentage, toppers and the failure list.',
    permission: 'result.analytics',
    route: '#/exams/analytics',
    exportPath: '/api/exams/:examId/export/analytics',
    filters: ['exam', 'section'],
  },
  {
    key: 'fees-day-book',
    module: 'Fees',
    title: 'Fee day book',
    description: 'Every transaction on a date, for tallying physical cash.',
    permission: 'fees.report',
    route: '#/fees/reports',
    exportPath: '/api/fees/export/day-book',
    filters: ['date'],
  },
  {
    key: 'fees-dues',
    module: 'Fees',
    title: 'Outstanding dues with ageing',
    description: 'Balance per student in 30, 60 and 90 day buckets.',
    permission: 'fees.report',
    route: '#/fees/reports',
    exportPath: '/api/fees/export/dues',
    filters: ['class', 'section', 'asOf'],
  },
  {
    key: 'fees-collection',
    module: 'Fees',
    title: 'Collection summary',
    description: 'Collected per fee head and per payment mode over a date range.',
    permission: 'fees.report',
    route: '#/fees/reports',
    exportPath: '/api/fees/export/collection',
    filters: ['dateRange'],
  },
  {
    key: 'fees-reconciliation',
    module: 'Fees',
    title: 'Reconciliation check',
    description: 'Confirms payments, allocations, fee lines and invoices all agree.',
    permission: 'fees.report',
    route: '#/fees/reports',
    exportPath: null,
    filters: [],
  },
  {
    key: 'library-overdue',
    module: 'Library',
    title: 'Overdue books',
    description: 'Outstanding loans past their due date with the fine so far.',
    permission: 'library.view',
    route: '#/library/reports',
    exportPath: '/api/library/export/overdue',
    filters: [],
  },
  {
    key: 'library-stock',
    module: 'Library',
    title: 'Stock report',
    description: 'Copies per title with available, issued, lost and damaged counts.',
    permission: 'library.view',
    route: '#/library/reports',
    exportPath: '/api/library/export/stock',
    filters: [],
  },
  {
    key: 'transport-route',
    module: 'Transport',
    title: 'Route list',
    description: 'Students per stop in pick-up order, with guardian phone numbers.',
    permission: 'transport.view',
    route: '#/transport',
    exportPath: '/api/transport/export/route/:routeId',
    filters: ['route', 'academicYear'],
  },
  {
    key: 'enquiry-funnel',
    module: 'Admissions',
    title: 'Enquiry funnel',
    description: 'Enquiries and conversions by source and by month.',
    permission: 'enquiry.view',
    route: '#/admissions/funnel',
    exportPath: null,
    filters: ['dateRange'],
  },
  {
    key: 'staff-attendance-monthly',
    module: 'Staff',
    title: 'Staff attendance summary',
    description: 'Monthly present, absent and payable days per staff member.',
    permission: 'staffattendance.view',
    route: '#/staff/attendance',
    exportPath: null,
    filters: ['month'],
  },
  {
    key: 'audit-log',
    module: 'Administration',
    title: 'Audit log',
    description: 'Every recorded action, filterable by date, user and action type.',
    permission: 'audit.view',
    route: '#/admin/audit',
    exportPath: '/api/audit/export',
    filters: ['dateRange', 'user', 'action'],
  },
];

router.get(
  '/reports',
  need('report.view'),
  handler(async (req, res) => {
    const available = CATALOGUE.filter((entry) => has(req.user, entry.permission));
    const modules = [...new Set(available.map((entry) => entry.module))];
    const year = await academics.currentYear();

    return ok(res, {
      modules,
      rows: available.map((entry) => ({
        ...entry,
        canExport: entry.exportPath ? has(req.user, 'report.export') : false,
      })),
      academicYear: year ? { id: year.id, name: year.name } : null,
      note:
        'Every export is stamped with your name and the time it was generated. ' +
        'Exports keep working when the portal is read-only.',
    });
  })
);

module.exports = { router, CATALOGUE };
