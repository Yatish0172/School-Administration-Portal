'use strict';

const workbook = require('./workbook');
const crud = require('./crud');

/**
 * Atomic permissions and the department matrix from SPEC §4.
 *
 * Routes check permission keys, never role names (CLAUDE.md security rules), so a
 * school that splits or merges departments only needs a new row in Roles plus
 * rows in RolePermissions — no code change.
 */

const PERMISSIONS = [
  ['dashboard.view', 'Dashboard', 'See the dashboard'],

  ['student.view', 'Students', 'View student profiles'],
  ['student.lookup', 'Students', 'Look up a student name and class only'],
  ['student.create', 'Students', 'Admit a new student'],
  ['student.edit', 'Students', 'Edit student profiles'],
  ['student.status', 'Students', 'Change a student status (TC, left, alumni)'],
  ['student.promote', 'Students', 'Run bulk promotion at year rollover'],
  ['student.tc', 'Students', 'Generate transfer certificates'],
  ['student.idcard', 'Students', 'Print ID cards'],
  ['student.import', 'Students', 'Import students from Excel'],

  ['document.view', 'Documents', 'See the document list'],
  ['document.upload', 'Documents', 'Upload documents'],
  ['document.download', 'Documents', 'Download documents'],

  ['enquiry.view', 'Admissions', 'View admission enquiries'],
  ['enquiry.create', 'Admissions', 'Record an enquiry'],
  ['enquiry.edit', 'Admissions', 'Edit enquiries and follow-ups'],
  ['enquiry.convert', 'Admissions', 'Convert an enquiry to an admission'],

  ['academics.view', 'Academics', 'View classes, sections and subjects'],
  ['academics.edit', 'Academics', 'Edit classes, sections, subjects and assignments'],
  ['academics.year', 'Academics', 'Create, set current and close academic years'],
  ['enrollment.view', 'Academics', 'View student enrollments'],
  ['enrollment.edit', 'Academics', 'Edit student enrollments and roll numbers'],

  ['timetable.view', 'Timetable', 'View timetables'],
  ['timetable.edit', 'Timetable', 'Edit timetables and substitutions'],

  ['attendance.view', 'Attendance', 'View student attendance'],
  ['attendance.mark.assigned', 'Attendance', 'Mark attendance for own sections'],
  ['attendance.mark.any', 'Attendance', 'Mark attendance for any section'],
  ['attendance.correct', 'Attendance', 'Correct locked attendance'],
  ['attendance.report', 'Attendance', 'Run attendance reports'],

  ['staffattendance.view', 'Staff attendance', 'View staff attendance'],
  ['staffattendance.mark', 'Staff attendance', 'Mark staff attendance'],
  ['leave.request', 'Staff attendance', 'Request leave'],
  ['leave.approve', 'Staff attendance', 'Approve leave'],

  ['exam.view', 'Exams', 'View exams and date sheets'],
  ['exam.setup', 'Exams', 'Create and configure exams'],
  ['marks.view', 'Exams', 'View marks'],
  ['marks.enter', 'Exams', 'Enter marks'],
  ['marks.publish', 'Exams', 'Publish results and unlock published marks'],
  ['grade.manage', 'Exams', 'Configure grade rules'],
  ['reportcard.generate', 'Exams', 'Generate report cards'],
  ['result.analytics', 'Exams', 'View result analytics'],

  ['fees.view', 'Fees', 'View fee records and dues'],
  ['fees.structure', 'Fees', 'Configure fee heads and structures'],
  ['fees.invoice', 'Fees', 'Generate invoices'],
  ['fees.collect', 'Fees', 'Collect payments and issue receipts'],
  ['fees.reverse', 'Fees', 'Request a payment reversal'],
  ['fees.reverse.approve', 'Fees', 'Approve a payment reversal'],
  ['fees.concession', 'Fees', 'Request a concession'],
  ['fees.concession.approve', 'Fees', 'Approve a concession'],
  ['fees.report', 'Fees', 'Run fee and finance reports'],

  ['library.view', 'Library', 'Search the catalogue'],
  ['library.manage', 'Library', 'Manage titles and copies'],
  ['library.issue', 'Library', 'Issue, renew and return books'],
  ['library.fine', 'Library', 'Collect or waive fines'],

  ['transport.view', 'Transport', 'View routes and assignments'],
  ['transport.manage', 'Transport', 'Manage routes, vehicles, drivers and assignments'],

  ['staff.view', 'Staff', 'View staff records'],
  ['staff.manage', 'Staff', 'Create and edit staff records'],
  ['payroll.view', 'Staff', 'View salary structures and payslips'],
  ['payroll.manage', 'Staff', 'Manage payroll'],

  ['notice.view', 'Notices', 'Read notices'],
  ['notice.create', 'Notices', 'Draft notices'],
  ['notice.publish', 'Notices', 'Publish notices'],

  ['report.view', 'Reports', 'Open the reports centre'],
  ['report.export', 'Reports', 'Export to Excel or PDF'],

  ['user.manage', 'Administration', 'Create, edit and disable users'],
  ['role.manage', 'Administration', 'Edit roles and permissions'],
  ['device.manage', 'Administration', 'Enroll and revoke devices'],
  ['settings.edit', 'Administration', 'Edit school settings'],
  ['hours.manage', 'Administration', 'Configure access hours, holidays and special days'],
  ['hours.override', 'Administration', 'Grant an emergency hours override'],
  ['backup.run', 'Administration', 'Run a backup'],
  ['backup.restore', 'Administration', 'Restore from a backup'],
  ['license.manage', 'Administration', 'Activate and view licence status'],
  ['audit.view', 'Administration', 'Read the audit log'],
  ['health.view', 'Administration', 'See system health'],
].map(([key, module, description]) => ({ key, module, description }));

const ALL_KEYS = PERMISSIONS.map((p) => p.key);

const READ_ONLY_KEYS = ALL_KEYS.filter((key) =>
  /\.(view|lookup|report|analytics|generate|export)$/.test(key)
);

/**
 * `outsideHours` seeds the RoleHours sheet (SPEC §3). Admin and Principal are
 * hard-coded as always-allowed in hoursCheck as well — this row is only a label.
 */
const ROLES = [
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Full access to everything including users, devices, hours and backups',
    isSystem: true,
    sortOrder: 1,
    outsideHours: { behaviour: 'full', extendedUntil: '' },
    permissions: ALL_KEYS,
  },
  {
    key: 'principal',
    name: 'Principal',
    description: 'Reads everything, grants approvals, sees all reports',
    isSystem: true,
    sortOrder: 2,
    outsideHours: { behaviour: 'full', extendedUntil: '' },
    permissions: [
      ...READ_ONLY_KEYS,
      'academics.year',
      'fees.reverse.approve',
      'fees.concession.approve',
      'leave.approve',
      'marks.publish',
      'notice.create',
      'notice.publish',
      'student.status',
      'student.tc',
      'attendance.correct',
      'hours.manage',
      'audit.view',
      'backup.run',
      'license.manage',
      'health.view',
      'document.download',
    ],
  },
  {
    key: 'office',
    name: 'Front Office / Admissions',
    description: 'Students, enquiries, ID cards and notices. No fees, no marks.',
    isSystem: true,
    sortOrder: 3,
    outsideHours: { behaviour: 'blocked', extendedUntil: '' },
    permissions: [
      'dashboard.view',
      'student.view',
      'student.create',
      'student.edit',
      'student.status',
      'student.tc',
      'student.idcard',
      'student.import',
      'document.view',
      'document.upload',
      'document.download',
      'enquiry.view',
      'enquiry.create',
      'enquiry.edit',
      'enquiry.convert',
      'academics.view',
      'enrollment.view',
      'enrollment.edit',
      'attendance.view',
      'attendance.report',
      'notice.view',
      'notice.create',
      'report.view',
      'report.export',
      'timetable.view',
    ],
  },
  {
    key: 'accounts',
    name: 'Accounts / Fees',
    description: 'Fee heads, collection, dues, receipts and finance reports',
    isSystem: true,
    sortOrder: 4,
    outsideHours: { behaviour: 'extended', extendedUntil: '19:00' },
    permissions: [
      'dashboard.view',
      'student.view',
      'academics.view',
      'enrollment.view',
      'fees.view',
      'fees.structure',
      'fees.invoice',
      'fees.collect',
      'fees.reverse',
      'fees.concession',
      'fees.report',
      'report.view',
      'report.export',
      'notice.view',
      'transport.view',
    ],
  },
  {
    key: 'teacher',
    name: 'Class Teacher',
    description: 'Own sections only — attendance, marks, remarks and timetable',
    isSystem: true,
    sortOrder: 5,
    outsideHours: { behaviour: 'readonly', extendedUntil: '' },
    permissions: [
      'dashboard.view',
      'student.view',
      'academics.view',
      'enrollment.view',
      'attendance.view',
      'attendance.mark.assigned',
      'attendance.report',
      'exam.view',
      'marks.view',
      'marks.enter',
      'timetable.view',
      'notice.view',
      'leave.request',
      'report.view',
      'document.view',
    ],
  },
  {
    key: 'exam',
    name: 'Examination Cell',
    description: 'Exam setup, marks, report cards and analytics. Cannot edit student profiles.',
    isSystem: true,
    sortOrder: 6,
    outsideHours: { behaviour: 'extended', extendedUntil: '20:00' },
    permissions: [
      'dashboard.view',
      'student.view',
      'academics.view',
      'enrollment.view',
      'exam.view',
      'exam.setup',
      'marks.view',
      'marks.enter',
      'marks.publish',
      'grade.manage',
      'reportcard.generate',
      'result.analytics',
      'attendance.view',
      'attendance.report',
      'timetable.view',
      'notice.view',
      'report.view',
      'report.export',
    ],
  },
  {
    key: 'attendance',
    name: 'Attendance In-charge',
    description: 'Student and staff attendance with corrections. Read-only on students.',
    isSystem: true,
    sortOrder: 7,
    outsideHours: { behaviour: 'blocked', extendedUntil: '' },
    permissions: [
      'dashboard.view',
      'student.view',
      'academics.view',
      'enrollment.view',
      'attendance.view',
      'attendance.mark.any',
      'attendance.correct',
      'attendance.report',
      'staffattendance.view',
      'staffattendance.mark',
      'timetable.view',
      'notice.view',
      'report.view',
      'report.export',
    ],
  },
  {
    key: 'library',
    name: 'Library',
    description: 'Catalogue, issue and return, fines. Student name and class lookup only.',
    isSystem: true,
    sortOrder: 8,
    outsideHours: { behaviour: 'blocked', extendedUntil: '' },
    permissions: [
      'dashboard.view',
      'student.lookup',
      'library.view',
      'library.manage',
      'library.issue',
      'library.fine',
      'notice.view',
      'report.view',
      'report.export',
    ],
  },
  {
    key: 'transport',
    name: 'Transport',
    description: 'Routes, vehicles and assignments. Student name and address lookup only.',
    isSystem: true,
    sortOrder: 9,
    outsideHours: { behaviour: 'blocked', extendedUntil: '' },
    permissions: [
      'dashboard.view',
      'student.lookup',
      'transport.view',
      'transport.manage',
      'notice.view',
      'report.view',
      'report.export',
    ],
  },
  {
    key: 'hr',
    name: 'HR / Staff',
    description: 'Staff records, staff attendance and payroll. No student data.',
    isSystem: true,
    sortOrder: 10,
    outsideHours: { behaviour: 'blocked', extendedUntil: '' },
    permissions: [
      'dashboard.view',
      'staff.view',
      'staff.manage',
      'staffattendance.view',
      'staffattendance.mark',
      'leave.approve',
      'payroll.view',
      'payroll.manage',
      'document.view',
      'document.upload',
      'document.download',
      'notice.view',
      'report.view',
      'report.export',
    ],
  },
];

/**
 * Roles a class teacher-style user belongs to are scoped to their own sections.
 * Listed here so scope helpers and the UI agree on which roles are section-bound.
 */
const SECTION_SCOPED_ROLES = new Set(['teacher']);

async function listPermissions() {
  return workbook.read('Users', 'Permissions');
}

async function listRoles() {
  const rows = await workbook.read('Users', 'Roles');
  return rows.slice().sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
}

async function listRolePermissions() {
  return workbook.read('Users', 'RolePermissions');
}

async function getRole(roleKey) {
  return crud.findOne('Users', 'Roles', (r) => r.key === roleKey);
}

async function permissionsForRole(roleKey) {
  const rows = await workbook.read('Users', 'RolePermissions');
  return rows.filter((r) => r.roleKey === roleKey).map((r) => r.permissionKey);
}

/** Full map so the client can render the permission matrix in one request. */
async function matrix() {
  const [roles, permissions, rolePermissions] = await Promise.all([
    listRoles(),
    listPermissions(),
    listRolePermissions(),
  ]);
  const byRole = {};
  for (const role of roles) byRole[role.key] = [];
  for (const link of rolePermissions) {
    if (!byRole[link.roleKey]) byRole[link.roleKey] = [];
    byRole[link.roleKey].push(link.permissionKey);
  }
  return { roles, permissions, byRole };
}

async function setRolePermissions(roleKey, permissionKeys, ctx) {
  const valid = new Set(ALL_KEYS);
  const wanted = [...new Set(permissionKeys.filter((key) => valid.has(key)))];

  return workbook.mutate(
    'Users',
    (api) => {
      const rows = api.rows('RolePermissions');
      const before = rows.filter((r) => r.roleKey === roleKey).map((r) => r.permissionKey);
      const kept = rows.filter((r) => r.roleKey !== roleKey);
      api.replace('RolePermissions', kept);
      for (const permissionKey of wanted) {
        crud.insertInto(api, 'Users', 'RolePermissions', { roleKey, permissionKey }, ctx);
      }
      return { before, after: wanted };
    },
    { label: `role permissions ${roleKey}` }
  );
}

async function seed(ctx) {
  return workbook.mutate(
    'Users',
    (api) => {
      const permRows = api.rows('Permissions');
      for (const permission of PERMISSIONS) {
        if (permRows.some((r) => r.key === permission.key)) continue;
        crud.insertInto(api, 'Users', 'Permissions', permission, ctx);
      }

      const roleRows = api.rows('Roles');
      const linkRows = api.rows('RolePermissions');
      for (const role of ROLES) {
        if (!roleRows.some((r) => r.key === role.key)) {
          crud.insertInto(
            api,
            'Users',
            'Roles',
            {
              key: role.key,
              name: role.name,
              description: role.description,
              isSystem: role.isSystem,
              sortOrder: role.sortOrder,
            },
            ctx
          );
        }
        const existing = new Set(
          linkRows.filter((r) => r.roleKey === role.key).map((r) => r.permissionKey)
        );
        for (const permissionKey of role.permissions) {
          if (existing.has(permissionKey)) continue;
          crud.insertInto(
            api,
            'Users',
            'RolePermissions',
            { roleKey: role.key, permissionKey },
            ctx
          );
        }
      }
      return true;
    },
    { label: 'seed roles and permissions' }
  );
}

module.exports = {
  PERMISSIONS,
  ALL_KEYS,
  READ_ONLY_KEYS,
  ROLES,
  SECTION_SCOPED_ROLES,
  listPermissions,
  listRoles,
  listRolePermissions,
  getRole,
  permissionsForRole,
  matrix,
  setRolePermissions,
  seed,
};
