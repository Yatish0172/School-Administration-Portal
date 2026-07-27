'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const schema = require('./schema');
const counters = require('./counters');
const errors = require('../errors');

/**
 * Staff, staff attendance, leave and payroll (SPEC §12).
 *
 * Payroll here is deliberately basic: salary structure, deductions, payslip. Full
 * payroll is a product of its own and is flagged as Phase 4 or drop.
 */

const WB = 'Staff';
const LEAVE_TYPES = ['CL', 'SL', 'EL', 'LWP', 'ML'];
const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Late', 'Half Day', 'Leave', 'Holiday'];
const DEFAULT_BALANCES = { CL: 12, SL: 12, EL: 15, LWP: 0, ML: 0 };

function attendanceBook(yearName) {
  return schema.workbookKey('StaffAttendance', yearName);
}

function monthSheet(date) {
  return String(date).slice(0, 7);
}

/* ------------------------------------------------------------------- staff */

async function list(options = {}) {
  return crud.list(WB, 'Staff', {
    searchFields: ['name', 'staffCode', 'designation', 'department', 'phone', 'email'],
    sort: 'name',
    ...options,
  });
}

async function get(id) {
  return crud.get(WB, 'Staff', id);
}

async function getByUserId(userId) {
  return crud.findOne(WB, 'Staff', (r) => r.userId === userId);
}

function validate(data) {
  const fields = {};
  if (!data.name || !String(data.name).trim()) fields.name = 'Enter the full name.';
  if (!data.designation) fields.designation = 'Enter the designation.';
  if (data.phone && !/^[0-9+\-\s]{6,15}$/.test(String(data.phone))) {
    fields.phone = 'Enter a valid phone number.';
  }
  if (data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(data.email))) {
    fields.email = 'Enter a valid email address, or leave it blank.';
  }
  if (data.joiningDate && data.dob && data.joiningDate <= data.dob) {
    fields.joiningDate = 'The joining date must be after the date of birth.';
  }
  if (Object.keys(fields).length) {
    throw errors.validation('Some details need fixing before this can be saved.', fields);
  }
}

async function create(data, ctx) {
  validate(data);
  const code = data.staffCode || (await counters.next('staffCode', ctx)).formatted;
  const clash = await crud.findOne(WB, 'Staff', (r) => r.staffCode === code);
  if (clash) {
    throw errors.validation('That staff code is already used.', { staffCode: 'Already used.' });
  }
  const staff = await crud.create(
    WB,
    'Staff',
    { ...data, staffCode: code, status: 'active' },
    ctx,
    { label: 'create staff' }
  );
  await seedLeaveBalances(staff.id, ctx).catch(() => {});
  return staff;
}

async function update(id, patch, ctx, options = {}) {
  const current = await crud.getOrFail(WB, 'Staff', id, 'staff member');
  validate({ ...current, ...crud.defined(patch) });
  const clean = { ...patch };
  delete clean.status;
  return crud.update(WB, 'Staff', id, clean, ctx, {
    expectedRev: options.expectedRev,
    label: 'staff member',
  });
}

/** Staff leave the school by status change, so payroll and attendance history survive. */
async function setStatus(id, status, { leavingDate = null } = {}, ctx) {
  if (!['active', 'inactive', 'left'].includes(status)) {
    throw errors.badRequest('A staff record can be active, inactive or left.');
  }
  const patch = { status };
  if (status === 'left') patch.leavingDate = leavingDate || new Date().toISOString().slice(0, 10);
  return crud.update(WB, 'Staff', id, patch, ctx, { label: 'staff member' });
}

async function addDocument(staffId, meta, ctx) {
  await crud.getOrFail(WB, 'Staff', staffId, 'staff member');
  return crud.create(
    WB,
    'StaffDocuments',
    {
      staffId,
      docType: meta.docType || 'Other',
      title: meta.title || meta.originalName,
      storedName: meta.storedName,
      originalName: meta.originalName,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      uploadedAt: crud.nowIso(),
    },
    ctx,
    { label: 'add staff document' }
  );
}

async function documentsFor(staffId) {
  const rows = await workbook.read(WB, 'StaffDocuments');
  return rows.filter((r) => r.staffId === staffId);
}

async function getDocument(id) {
  return crud.get(WB, 'StaffDocuments', id);
}

/* --------------------------------------------------------- staff attendance */

async function markAttendance(yearName, { date, entries }, ctx) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw errors.badRequest('Choose a valid date.');
  }
  for (const entry of entries) {
    if (!ATTENDANCE_STATUSES.includes(entry.status)) {
      throw errors.badRequest(`Status must be one of: ${ATTENDANCE_STATUSES.join(', ')}.`);
    }
  }
  const book = attendanceBook(yearName);
  const sheet = monthSheet(date);

  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows(sheet);
      const index = new Map();
      rows.forEach((row, position) => {
        if (row.date === date) index.set(row.staffId, position);
      });

      let created = 0;
      let updated = 0;
      for (const entry of entries) {
        const payload = {
          date,
          staffId: entry.staffId,
          inTime: entry.inTime || null,
          outTime: entry.outTime || null,
          status: entry.status,
          leaveType: entry.leaveType || null,
          remarks: entry.remarks || null,
          markedBy: crud.actorOf(ctx),
          markedAt: crud.nowIso(),
        };
        const position = index.get(entry.staffId);
        if (position === undefined) {
          crud.insertInto(api, book, sheet, payload, ctx);
          created += 1;
        } else {
          const current = rows[position];
          rows[position] = {
            ...current,
            ...payload,
            id: current.id,
            _rev: Number(current._rev || 1) + 1,
            createdBy: current.createdBy,
            createdAt: current.createdAt,
          };
          updated += 1;
        }
      }
      return { created, updated };
    },
    { label: 'mark staff attendance' }
  );
}

async function attendanceForDate(yearName, date) {
  const rows = await workbook.read(attendanceBook(yearName), monthSheet(date));
  return rows.filter((row) => row.date === date);
}

async function attendanceRoster(yearName, date) {
  const staff = (await workbook.read(WB, 'Staff')).filter((s) => s.status === 'active');
  const marked = await attendanceForDate(yearName, date);
  const byStaff = new Map(marked.map((row) => [row.staffId, row]));
  return staff
    .map((member) => {
      const row = byStaff.get(member.id) || null;
      return {
        staffId: member.id,
        staffCode: member.staffCode,
        name: member.name,
        designation: member.designation,
        department: member.department,
        status: row?.status || null,
        inTime: row?.inTime || null,
        outTime: row?.outTime || null,
        leaveType: row?.leaveType || null,
        remarks: row?.remarks || null,
      };
    })
    .sort((a, b) => crud.compareValues(a.name, b.name));
}

/** Monthly summary that feeds payroll (SPEC §9). */
async function monthlySummary(yearName, month) {
  const book = attendanceBook(yearName);
  const rows = await workbook.read(book, month);
  const staff = await workbook.read(WB, 'Staff');
  const byStaff = new Map();
  for (const row of rows) {
    if (!byStaff.has(row.staffId)) byStaff.set(row.staffId, []);
    byStaff.get(row.staffId).push(row);
  }
  const workingDays = new Set(rows.filter((r) => r.status !== 'Holiday').map((r) => r.date)).size;

  return {
    month,
    workingDays,
    rows: staff
      .filter((member) => member.status === 'active' || byStaff.has(member.id))
      .map((member) => {
        const own = byStaff.get(member.id) || [];
        const count = (status) => own.filter((r) => r.status === status).length;
        const present = count('Present') + count('Late') + count('Half Day') * 0.5;
        return {
          staffId: member.id,
          staffCode: member.staffCode,
          name: member.name,
          present,
          absent: count('Absent'),
          late: count('Late'),
          halfDay: count('Half Day'),
          leave: count('Leave'),
          payableDays: present + count('Leave'),
          percent: workingDays ? Math.round((present / workingDays) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => crud.compareValues(a.name, b.name)),
  };
}

/* -------------------------------------------------------------------- leave */

async function listLeave(yearName, { staffId = null, status = null } = {}) {
  const rows = await workbook.read(attendanceBook(yearName), 'LeaveRequests');
  return rows
    .filter((row) => {
      if (staffId && row.staffId !== staffId) return false;
      if (status && row.status !== status) return false;
      return true;
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function countDays(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.round((to - from) / 86400000) + 1;
}

async function requestLeave(yearName, data, ctx) {
  const book = attendanceBook(yearName);
  if (!LEAVE_TYPES.includes(data.leaveType)) {
    throw errors.badRequest(`Leave type must be one of: ${LEAVE_TYPES.join(', ')}.`);
  }
  const days = countDays(data.fromDate, data.toDate);
  if (days <= 0) {
    throw errors.validation('Check the leave dates.', { toDate: 'Must be on or after the start date.' });
  }
  if (!data.reason) {
    throw errors.validation('Give a reason for the leave.', { reason: 'Required.' });
  }

  const balance = await leaveBalance(yearName, data.staffId, data.leaveType);
  if (data.leaveType !== 'LWP' && days > balance.remaining) {
    throw errors.badRequest(
      `Only ${balance.remaining} day${balance.remaining === 1 ? '' : 's'} of ${data.leaveType} remain. Apply for loss of pay instead.`
    );
  }

  return crud.create(
    book,
    'LeaveRequests',
    {
      staffId: data.staffId,
      leaveType: data.leaveType,
      fromDate: data.fromDate,
      toDate: data.toDate,
      days,
      reason: data.reason,
      status: 'pending',
    },
    ctx,
    { label: 'request leave' }
  );
}

async function decideLeave(yearName, id, { approve, rejectionReason }, ctx) {
  const book = attendanceBook(yearName);
  const request = await crud.getOrFail(book, 'LeaveRequests', id, 'leave request');
  if (request.status !== 'pending') throw errors.badRequest('That request has already been decided.');
  if (!approve && !rejectionReason) {
    throw errors.validation('Give a reason for rejecting the leave.', {
      rejectionReason: 'Required.',
    });
  }

  const result = await crud.update(
    book,
    'LeaveRequests',
    id,
    {
      status: approve ? 'approved' : 'rejected',
      approvedBy: crud.actorOf(ctx),
      approvedAt: crud.nowIso(),
      rejectionReason: approve ? null : rejectionReason,
    },
    ctx,
    { label: 'leave request' }
  );

  if (approve) {
    await consumeBalance(yearName, request.staffId, request.leaveType, Number(request.days), ctx);
  }
  return result;
}

async function seedLeaveBalances(staffId, ctx) {
  const academics = require('./academics');
  const year = await academics.currentYear();
  if (!year) return [];
  const book = attendanceBook(year.name);
  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows('LeaveBalances');
      const created = [];
      for (const [leaveType, opening] of Object.entries(DEFAULT_BALANCES)) {
        if (rows.some((r) => r.staffId === staffId && r.leaveType === leaveType)) continue;
        created.push(
          crud.insertInto(
            api,
            book,
            'LeaveBalances',
            { staffId, leaveType, opening, accrued: 0, used: 0 },
            ctx
          )
        );
      }
      return created;
    },
    { label: 'seed leave balances' }
  );
}

async function leaveBalance(yearName, staffId, leaveType) {
  const rows = await workbook.read(attendanceBook(yearName), 'LeaveBalances');
  const row = rows.find((r) => r.staffId === staffId && r.leaveType === leaveType);
  const opening = Number(row?.opening ?? DEFAULT_BALANCES[leaveType] ?? 0);
  const accrued = Number(row?.accrued || 0);
  const used = Number(row?.used || 0);
  return { leaveType, opening, accrued, used, remaining: opening + accrued - used };
}

async function leaveBalances(yearName, staffId) {
  return Promise.all(LEAVE_TYPES.map((type) => leaveBalance(yearName, staffId, type)));
}

async function consumeBalance(yearName, staffId, leaveType, days, ctx) {
  const book = attendanceBook(yearName);
  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows('LeaveBalances');
      const index = rows.findIndex((r) => r.staffId === staffId && r.leaveType === leaveType);
      if (index === -1) {
        return crud.insertInto(
          api,
          book,
          'LeaveBalances',
          {
            staffId,
            leaveType,
            opening: DEFAULT_BALANCES[leaveType] ?? 0,
            accrued: 0,
            used: days,
          },
          ctx
        );
      }
      return crud.updateIn(
        api,
        book,
        'LeaveBalances',
        rows[index].id,
        { used: Number(rows[index].used || 0) + days },
        ctx,
        { label: 'leave balance' }
      );
    },
    { label: 'consume leave balance' }
  );
}

/* ----------------------------------------------------------------- payroll */

async function setSalaryStructure(staffId, data, ctx) {
  await crud.getOrFail(WB, 'Staff', staffId, 'staff member');
  const gross =
    Number(data.basic || 0) + Number(data.hra || 0) + Number(data.da || 0) + Number(data.allowances || 0);
  const deductions =
    Number(data.pf || 0) +
    Number(data.professionalTax || 0) +
    Number(data.incomeTax || 0) +
    Number(data.otherDeductions || 0);
  if (gross <= 0) throw errors.validation('Enter the salary components.', { basic: 'Required.' });

  return workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('SalaryStructures');
      // Supersede the previous structure rather than editing it, so payslips
      // already issued still reconcile.
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].staffId === staffId && rows[i].status === 'active') {
          rows[i] = { ...rows[i], status: 'superseded', _rev: Number(rows[i]._rev || 1) + 1 };
        }
      }
      return crud.insertInto(
        api,
        WB,
        'SalaryStructures',
        {
          staffId,
          effectiveFrom: data.effectiveFrom || new Date().toISOString().slice(0, 10),
          basic: Number(data.basic || 0),
          hra: Number(data.hra || 0),
          da: Number(data.da || 0),
          allowances: Number(data.allowances || 0),
          pf: Number(data.pf || 0),
          professionalTax: Number(data.professionalTax || 0),
          incomeTax: Number(data.incomeTax || 0),
          otherDeductions: Number(data.otherDeductions || 0),
          netSalary: Math.round((gross - deductions) * 100) / 100,
          status: 'active',
        },
        ctx
      );
    },
    { label: 'set salary structure' }
  );
}

async function salaryStructure(staffId) {
  const rows = await workbook.read(WB, 'SalaryStructures');
  return rows.find((r) => r.staffId === staffId && r.status === 'active') || null;
}

/**
 * Generates payslips for a month from the active salary structure and the
 * attendance summary. Pro-rates on payable days.
 */
async function generatePayslips(yearName, month, ctx) {
  const summary = await monthlySummary(yearName, month);
  const structures = await workbook.read(WB, 'SalaryStructures');
  const active = new Map(
    structures.filter((s) => s.status === 'active').map((s) => [s.staffId, s])
  );

  return workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('Payslips');
      const created = [];
      for (const entry of summary.rows) {
        const structure = active.get(entry.staffId);
        if (!structure) continue;
        if (rows.some((r) => r.staffId === entry.staffId && r.month === month && r.status !== 'cancelled')) {
          continue;
        }
        const gross =
          Number(structure.basic || 0) +
          Number(structure.hra || 0) +
          Number(structure.da || 0) +
          Number(structure.allowances || 0);
        const deductions =
          Number(structure.pf || 0) +
          Number(structure.professionalTax || 0) +
          Number(structure.incomeTax || 0) +
          Number(structure.otherDeductions || 0);
        const ratio = summary.workingDays ? entry.payableDays / summary.workingDays : 1;
        const proRatedGross = Math.round(gross * Math.min(1, ratio) * 100) / 100;

        created.push(
          crud.insertInto(
            api,
            WB,
            'Payslips',
            {
              staffId: entry.staffId,
              month,
              daysPresent: entry.present,
              daysPayable: entry.payableDays,
              grossAmount: proRatedGross,
              deductions,
              netAmount: Math.round((proRatedGross - deductions) * 100) / 100,
              status: 'generated',
              generatedAt: crud.nowIso(),
              generatedBy: crud.actorOf(ctx),
            },
            ctx
          )
        );
      }
      return created;
    },
    { label: 'generate payslips' }
  );
}

async function listPayslips({ month = null, staffId = null } = {}) {
  const rows = await workbook.read(WB, 'Payslips');
  return rows.filter((row) => {
    if (month && row.month !== month) return false;
    if (staffId && row.staffId !== staffId) return false;
    return true;
  });
}

module.exports = {
  WB,
  LEAVE_TYPES,
  ATTENDANCE_STATUSES,
  attendanceBook,
  list,
  get,
  getByUserId,
  validate,
  create,
  update,
  setStatus,
  addDocument,
  documentsFor,
  getDocument,
  markAttendance,
  attendanceForDate,
  attendanceRoster,
  monthlySummary,
  listLeave,
  requestLeave,
  decideLeave,
  seedLeaveBalances,
  leaveBalance,
  leaveBalances,
  setSalaryStructure,
  salaryStructure,
  generatePayslips,
  listPayslips,
};
