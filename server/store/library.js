'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const counters = require('./counters');
const settings = require('./settings');
const errors = require('../errors');

/**
 * Library (SPEC §12): titles, copies with accession numbers, issue and return,
 * renewals, fines, overdue list and catalogue search.
 *
 * Accession numbers come from Counters, never from a row count — a lost copy must
 * not cause the next book to reuse its number.
 */

const WB = 'Library';
const COPY_STATUSES = ['available', 'issued', 'lost', 'damaged', 'withdrawn'];

/* ------------------------------------------------------------------ titles */

async function listTitles(options = {}) {
  return crud.list(WB, 'Titles', {
    searchFields: ['title', 'author', 'publisher', 'isbn', 'category', 'shelf'],
    sort: 'title',
    ...options,
  });
}

async function getTitle(id) {
  return crud.get(WB, 'Titles', id);
}

async function createTitle(data, ctx) {
  if (!data.title) throw errors.validation('Enter the book title.', { title: 'Required.' });
  if (!data.author) throw errors.validation('Enter the author.', { author: 'Required.' });
  return crud.create(
    WB,
    'Titles',
    { ...data, totalCopies: 0, status: 'active' },
    ctx,
    { label: 'create title' }
  );
}

async function updateTitle(id, patch, ctx, options = {}) {
  const clean = { ...patch };
  delete clean.totalCopies; // maintained by copy operations
  return crud.update(WB, 'Titles', id, clean, ctx, {
    expectedRev: options.expectedRev,
    label: 'title',
  });
}

/* ------------------------------------------------------------------- copies */

async function listCopies({ titleId = null, status = null } = {}) {
  const rows = await workbook.read(WB, 'Copies');
  return rows.filter((row) => {
    if (titleId && row.titleId !== titleId) return false;
    if (status && row.status !== status) return false;
    return true;
  });
}

async function addCopies(titleId, { count = 1, price = null, purchaseDate = null }, ctx) {
  const title = await crud.getOrFail(WB, 'Titles', titleId, 'title');
  const quantity = Math.max(1, Math.min(200, Number(count) || 1));

  const accessions = [];
  for (let i = 0; i < quantity; i += 1) {
    accessions.push((await counters.next('accessionNo', ctx)).formatted);
  }

  return workbook.mutate(
    WB,
    (api) => {
      const created = accessions.map((accessionNo) =>
        crud.insertInto(
          api,
          WB,
          'Copies',
          {
            titleId,
            accessionNo,
            status: 'available',
            purchaseDate: purchaseDate || new Date().toISOString().slice(0, 10),
            price,
            condition: 'good',
          },
          ctx
        )
      );
      crud.updateIn(
        api,
        WB,
        'Titles',
        titleId,
        { totalCopies: Number(title.totalCopies || 0) + created.length },
        ctx,
        { label: 'title' }
      );
      return created;
    },
    { label: 'add library copies' }
  );
}

async function setCopyStatus(copyId, status, ctx) {
  if (!COPY_STATUSES.includes(status)) {
    throw errors.badRequest(`A copy status must be one of: ${COPY_STATUSES.join(', ')}.`);
  }
  const copy = await crud.getOrFail(WB, 'Copies', copyId, 'copy');
  if (copy.status === 'issued' && status !== 'lost') {
    throw errors.badRequest('That copy is issued. Take the return first, or mark it lost.');
  }
  return crud.update(WB, 'Copies', copyId, { status }, ctx, { label: 'copy' });
}

async function findCopyByAccession(accessionNo) {
  const target = String(accessionNo || '').trim().toLowerCase();
  if (!target) return null;
  return crud.findOne(
    WB,
    'Copies',
    (r) => String(r.accessionNo || '').toLowerCase() === target
  );
}

/* --------------------------------------------------------------- issue flow */

async function activeIssues({ borrowerType = null, studentId = null, staffId = null } = {}) {
  const rows = await workbook.read(WB, 'BookIssues');
  return rows.filter((row) => {
    if (row.status !== 'issued') return false;
    if (borrowerType && row.borrowerType !== borrowerType) return false;
    if (studentId && row.studentId !== studentId) return false;
    if (staffId && row.staffId !== staffId) return false;
    return true;
  });
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Issues a copy. Enforces the per-borrower cap and the copy's availability inside
 * the lock so two counters cannot issue the same book at once.
 */
async function issue({ accessionNo, borrowerType, studentId, staffId }, ctx) {
  const config = await settings.getMany([
    'library.loanDays',
    'library.maxBooksStudent',
  ]);
  const loanDays = Number(config['library.loanDays'] ?? 14);
  const maxBooks = Number(config['library.maxBooksStudent'] ?? 2);

  if (!['student', 'staff'].includes(borrowerType)) {
    throw errors.badRequest('Choose whether this is for a student or a staff member.');
  }
  if (borrowerType === 'student' && !studentId) throw errors.badRequest('Choose a student.');
  if (borrowerType === 'staff' && !staffId) throw errors.badRequest('Choose a staff member.');

  const today = new Date().toISOString().slice(0, 10);

  return workbook.mutate(
    WB,
    (api) => {
      const copies = api.rows('Copies');
      const target = String(accessionNo || '').trim().toLowerCase();
      const copyIndex = copies.findIndex(
        (c) => String(c.accessionNo || '').toLowerCase() === target
      );
      if (copyIndex === -1) {
        throw errors.notFound('No copy with that accession number. Check the number on the book.');
      }
      const copy = copies[copyIndex];
      if (copy.status === 'issued') {
        throw errors.badRequest('That copy is already issued to someone else.');
      }
      if (copy.status !== 'available') {
        throw errors.badRequest(`That copy is marked ${copy.status} and cannot be issued.`);
      }

      const issues = api.rows('BookIssues');
      const held = issues.filter(
        (row) =>
          row.status === 'issued' &&
          row.borrowerType === borrowerType &&
          (borrowerType === 'student' ? row.studentId === studentId : row.staffId === staffId)
      );
      if (borrowerType === 'student' && held.length >= maxBooks) {
        throw errors.badRequest(
          `This student already has ${held.length} book${held.length === 1 ? '' : 's'}. The limit is ${maxBooks}.`
        );
      }

      const record = crud.insertInto(
        api,
        WB,
        'BookIssues',
        {
          copyId: copy.id,
          titleId: copy.titleId,
          accessionNo: copy.accessionNo,
          borrowerType,
          studentId: borrowerType === 'student' ? studentId : null,
          staffId: borrowerType === 'staff' ? staffId : null,
          issuedAt: today,
          dueDate: addDays(today, loanDays),
          renewCount: 0,
          status: 'issued',
          issuedBy: crud.actorOf(ctx),
          fineAmount: 0,
        },
        ctx
      );

      copies[copyIndex] = {
        ...copy,
        status: 'issued',
        _rev: Number(copy._rev || 1) + 1,
        updatedBy: crud.actorOf(ctx),
        updatedAt: crud.nowIso(),
      };

      return record;
    },
    { label: 'issue book' }
  );
}

function overdueDays(dueDate, on = null) {
  const today = on || new Date().toISOString().slice(0, 10);
  if (!dueDate || today <= dueDate) return 0;
  return Math.floor((Date.parse(today) - Date.parse(dueDate)) / 86400000);
}

/**
 * Takes a return, calculates the fine and raises a Fines row if anything is owed.
 * The fine is recorded, not collected — collection is a separate, audited action.
 */
async function takeReturn({ issueId, condition = 'good' }, ctx) {
  const config = await settings.getMany(['library.finePerDay']);
  const finePerDay = Number(config['library.finePerDay'] ?? 1);
  const today = new Date().toISOString().slice(0, 10);

  return workbook.mutate(
    WB,
    (api) => {
      const issues = api.rows('BookIssues');
      const index = issues.findIndex((row) => row.id === issueId);
      if (index === -1) throw errors.notFound('That issue record could not be found.');
      const record = issues[index];
      if (record.status !== 'issued') throw errors.badRequest('That book has already been returned.');

      const days = overdueDays(record.dueDate, today);
      const fine = Math.round(days * finePerDay * 100) / 100;

      issues[index] = {
        ...record,
        returnedAt: today,
        returnedBy: crud.actorOf(ctx),
        status: 'returned',
        fineAmount: fine,
        _rev: Number(record._rev || 1) + 1,
        updatedBy: crud.actorOf(ctx),
        updatedAt: crud.nowIso(),
      };

      const copies = api.rows('Copies');
      const copyIndex = copies.findIndex((c) => c.id === record.copyId);
      if (copyIndex !== -1) {
        copies[copyIndex] = {
          ...copies[copyIndex],
          status: condition === 'damaged' ? 'damaged' : 'available',
          condition,
          _rev: Number(copies[copyIndex]._rev || 1) + 1,
          updatedBy: crud.actorOf(ctx),
          updatedAt: crud.nowIso(),
        };
      }

      let fineRow = null;
      if (fine > 0) {
        fineRow = crud.insertInto(
          api,
          WB,
          'Fines',
          {
            bookIssueId: record.id,
            borrowerType: record.borrowerType,
            studentId: record.studentId,
            staffId: record.staffId,
            amount: fine,
            daysOverdue: days,
            reason: `${days} day${days === 1 ? '' : 's'} overdue`,
            status: 'pending',
          },
          ctx
        );
      }

      return { issue: issues[index], fine: fineRow, daysOverdue: days, fineAmount: fine };
    },
    { label: 'return book' }
  );
}

async function renew(issueId, ctx) {
  const config = await settings.getMany(['library.loanDays', 'library.maxRenewals']);
  const loanDays = Number(config['library.loanDays'] ?? 14);
  const maxRenewals = Number(config['library.maxRenewals'] ?? 2);
  const today = new Date().toISOString().slice(0, 10);

  const record = await crud.getOrFail(WB, 'BookIssues', issueId, 'issue record');
  if (record.status !== 'issued') throw errors.badRequest('That book is not currently issued.');
  if (Number(record.renewCount || 0) >= maxRenewals) {
    throw errors.badRequest(
      `This book has already been renewed ${maxRenewals} times. It must be returned.`
    );
  }
  if (overdueDays(record.dueDate, today) > 0) {
    throw errors.badRequest('This book is overdue. Take the return and settle the fine first.');
  }

  return crud.update(
    WB,
    'BookIssues',
    issueId,
    {
      dueDate: addDays(record.dueDate, loanDays),
      renewCount: Number(record.renewCount || 0) + 1,
    },
    ctx,
    { label: 'issue record' }
  );
}

/* -------------------------------------------------------------------- fines */

async function listFines({ status = null, studentId = null } = {}) {
  const rows = await workbook.read(WB, 'Fines');
  return rows.filter((row) => {
    if (status && row.status !== status) return false;
    if (studentId && row.studentId !== studentId) return false;
    return true;
  });
}

async function settleFine(id, { waive = false, reason = null }, ctx) {
  const fine = await crud.getOrFail(WB, 'Fines', id, 'fine');
  if (fine.status !== 'pending') throw errors.badRequest('That fine has already been settled.');
  if (waive && (!reason || String(reason).trim().length < 3)) {
    throw errors.validation('Give a reason for waiving the fine — it is recorded.', {
      reason: 'Enter a reason.',
    });
  }
  return crud.update(
    WB,
    'Fines',
    id,
    waive
      ? { status: 'waived', waivedBy: crud.actorOf(ctx), reason: `${fine.reason} — waived: ${reason}` }
      : { status: 'paid', paidAt: crud.nowIso(), collectedBy: crud.actorOf(ctx) },
    ctx,
    { label: 'fine' }
  );
}

/* ------------------------------------------------------------------ reports */

async function overdueList() {
  const students = require('./students');
  const staffStore = require('./staff');
  const issues = await activeIssues();
  const today = new Date().toISOString().slice(0, 10);
  const titles = await workbook.read(WB, 'Titles');
  const titleById = new Map(titles.map((t) => [t.id, t]));
  const finePerDay = Number(await settings.get('library.finePerDay', 1));

  const rows = [];
  for (const issue of issues) {
    const days = overdueDays(issue.dueDate, today);
    if (days <= 0) continue;
    let borrower = 'Unknown';
    let contact = '';
    if (issue.borrowerType === 'student') {
      const student = await students.get(issue.studentId);
      borrower = student?.fullName || 'Unknown student';
      const guardian = student ? await students.primaryGuardian(issue.studentId) : null;
      contact = guardian?.phone || '';
    } else {
      const member = await staffStore.get(issue.staffId);
      borrower = member?.name || 'Unknown staff';
      contact = member?.phone || '';
    }
    rows.push({
      issueId: issue.id,
      accessionNo: issue.accessionNo,
      title: titleById.get(issue.titleId)?.title || 'Unknown title',
      borrowerType: issue.borrowerType,
      borrower,
      contact,
      issuedAt: issue.issuedAt,
      dueDate: issue.dueDate,
      daysOverdue: days,
      estimatedFine: Math.round(days * finePerDay * 100) / 100,
    });
  }
  return rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

async function stockReport() {
  const titles = await workbook.read(WB, 'Titles');
  const copies = await workbook.read(WB, 'Copies');
  const byTitle = new Map();
  for (const copy of copies) {
    if (!byTitle.has(copy.titleId)) byTitle.set(copy.titleId, []);
    byTitle.get(copy.titleId).push(copy);
  }
  return titles.map((title) => {
    const own = byTitle.get(title.id) || [];
    const count = (status) => own.filter((c) => c.status === status).length;
    return {
      titleId: title.id,
      title: title.title,
      author: title.author,
      category: title.category,
      total: own.length,
      available: count('available'),
      issued: count('issued'),
      lost: count('lost'),
      damaged: count('damaged'),
    };
  });
}

async function dashboardTotals() {
  const today = new Date().toISOString().slice(0, 10);
  const issues = await workbook.read(WB, 'BookIssues');
  const fines = await workbook.read(WB, 'Fines');
  return {
    issuedToday: issues.filter((r) => r.issuedAt === today).length,
    returnedToday: issues.filter((r) => r.returnedAt === today).length,
    outstanding: issues.filter((r) => r.status === 'issued').length,
    overdue: issues.filter((r) => r.status === 'issued' && overdueDays(r.dueDate, today) > 0).length,
    finesPending: Math.round(
      fines.filter((f) => f.status === 'pending').reduce((sum, f) => sum + Number(f.amount || 0), 0) * 100
    ) / 100,
  };
}

module.exports = {
  WB,
  COPY_STATUSES,
  listTitles,
  getTitle,
  createTitle,
  updateTitle,
  listCopies,
  addCopies,
  setCopyStatus,
  findCopyByAccession,
  activeIssues,
  issue,
  takeReturn,
  renew,
  overdueDays,
  listFines,
  settleFine,
  overdueList,
  stockReport,
  dashboardTotals,
};
