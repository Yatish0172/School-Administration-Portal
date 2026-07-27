'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const schema = require('./schema');
const counters = require('./counters');
const journal = require('./journal');
const academics = require('./academics');
const settings = require('./settings');
const errors = require('../errors');

/**
 * Fees and accounts (SPEC §11). The highest-risk module in the system: money
 * errors destroy trust immediately.
 *
 * Non-negotiables enforced here:
 *  - receipt numbers come from Counters under the same lock as the write (§7)
 *  - every payment carries a client-supplied idempotency key (§8)
 *  - multi-sheet writes run through the journal so a failure rolls back (§9)
 *  - a wrong receipt is cancelled by a reversal row; nothing is ever deleted
 */

const FREQUENCIES = ['monthly', 'term', 'annual', 'onetime'];
const MODES = ['cash', 'cheque', 'upi', 'bank transfer', 'card', 'dd'];
const HEAD_KINDS = ['tuition', 'transport', 'exam', 'admission', 'lab', 'latefee', 'other'];
const CONCESSION_KINDS = ['sibling', 'staff ward', 'merit', 'rte', 'other'];

function bookFor(yearName) {
  return schema.workbookKey('Fees', yearName);
}

function money(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/* --------------------------------------------------------------- fee heads */

async function listHeads(yearName, { includeInactive = false } = {}) {
  const rows = await workbook.read(bookFor(yearName), 'FeeHeads');
  return rows
    .filter((r) => includeInactive || r.status !== 'inactive')
    .sort(
      (a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || crud.compareValues(a.name, b.name)
    );
}

async function createHead(yearName, data, ctx) {
  const book = bookFor(yearName);
  if (!data.name) throw errors.validation('Enter a name for the fee head.', { name: 'Required.' });
  const clash = await crud.findOne(
    book,
    'FeeHeads',
    (r) => String(r.name).toLowerCase() === String(data.name).trim().toLowerCase() && r.status !== 'inactive'
  );
  if (clash) throw errors.validation('That fee head already exists.', { name: 'Already exists.' });
  return crud.create(
    book,
    'FeeHeads',
    {
      name: String(data.name).trim(),
      code: data.code || null,
      kind: HEAD_KINDS.includes(data.kind) ? data.kind : 'other',
      refundable: !!data.refundable,
      sortOrder: data.sortOrder ?? 0,
      description: data.description || null,
      status: 'active',
    },
    ctx,
    { label: 'create fee head' }
  );
}

async function updateHead(yearName, id, patch, ctx, options = {}) {
  return crud.update(bookFor(yearName), 'FeeHeads', id, patch, ctx, {
    expectedRev: options.expectedRev,
    label: 'fee head',
  });
}

/* -------------------------------------------------------------- structures */

async function listStructures(yearName, { classId = null, feeHeadId = null, onDate = null } = {}) {
  const rows = await workbook.read(bookFor(yearName), 'FeeStructures');
  return rows.filter((row) => {
    if (row.status === 'inactive') return false;
    if (classId && row.classId !== classId) return false;
    if (feeHeadId && row.feeHeadId !== feeHeadId) return false;
    if (onDate && !isEffective(row, onDate)) return false;
    return true;
  });
}

/**
 * Effective dating matters: a mid-year fee revision must not rewrite the amounts
 * on invoices already issued (SPEC §11).
 */
function isEffective(row, date) {
  if (row.effectiveFrom && date < row.effectiveFrom) return false;
  if (row.effectiveTo && date > row.effectiveTo) return false;
  return true;
}

async function setStructure(yearName, data, ctx) {
  const book = bookFor(yearName);
  for (const field of ['classId', 'feeHeadId', 'frequency']) {
    if (!data[field]) throw errors.validation('Choose a class, fee head and frequency.', { [field]: 'Required.' });
  }
  if (!FREQUENCIES.includes(data.frequency)) {
    throw errors.badRequest(`Frequency must be one of: ${FREQUENCIES.join(', ')}.`);
  }
  const amount = money(data.amount);
  if (amount <= 0) {
    throw errors.validation('Enter an amount greater than zero.', { amount: 'Must be more than zero.' });
  }
  const effectiveFrom = data.effectiveFrom || new Date().toISOString().slice(0, 10);

  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows('FeeStructures');
      // Close off the previous rate rather than editing it — history stays intact.
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (
          row.classId !== data.classId ||
          row.feeHeadId !== data.feeHeadId ||
          row.frequency !== data.frequency ||
          row.status === 'inactive' ||
          row.effectiveTo
        ) {
          continue;
        }
        const dayBefore = new Date(Date.parse(`${effectiveFrom}T00:00:00Z`) - 86400000)
          .toISOString()
          .slice(0, 10);
        rows[i] = {
          ...row,
          effectiveTo: dayBefore,
          _rev: Number(row._rev || 1) + 1,
          updatedBy: crud.actorOf(ctx),
          updatedAt: crud.nowIso(),
        };
      }
      return crud.insertInto(
        api,
        book,
        'FeeStructures',
        {
          academicYearId: data.academicYearId,
          classId: data.classId,
          feeHeadId: data.feeHeadId,
          amount,
          frequency: data.frequency,
          effectiveFrom,
          effectiveTo: data.effectiveTo || null,
          status: 'active',
        },
        ctx
      );
    },
    { label: 'set fee structure' }
  );
}

/* -------------------------------------------------------------- concessions */

async function listConcessions(yearName, { studentId = null, status = null } = {}) {
  const rows = await workbook.read(bookFor(yearName), 'Concessions');
  return rows.filter((row) => {
    if (studentId && row.studentId !== studentId) return false;
    if (status && row.status !== status) return false;
    return true;
  });
}

async function requestConcession(yearName, data, ctx) {
  const book = bookFor(yearName);
  if (!data.studentId) throw errors.validation('Choose a student.', { studentId: 'Required.' });
  if (!CONCESSION_KINDS.includes(data.kind)) {
    throw errors.badRequest(`Concession kind must be one of: ${CONCESSION_KINDS.join(', ')}.`);
  }
  if (!['percent', 'fixed'].includes(data.mode)) {
    throw errors.badRequest('A concession is either a percentage or a fixed amount.');
  }
  const value = money(data.value);
  if (value <= 0) throw errors.validation('Enter a concession value above zero.', { value: 'Required.' });
  if (data.mode === 'percent' && value > 100) {
    throw errors.validation('A percentage concession cannot be over 100.', { value: 'Maximum 100.' });
  }
  if (!data.reason || String(data.reason).trim().length < 3) {
    throw errors.validation('Give a reason — concessions are approved on this note.', {
      reason: 'Enter a reason.',
    });
  }

  return crud.create(
    book,
    'Concessions',
    {
      studentId: data.studentId,
      feeHeadId: data.feeHeadId || null,
      kind: data.kind,
      mode: data.mode,
      value,
      reason: String(data.reason).trim(),
      status: 'pending',
      requestedBy: crud.actorOf(ctx),
      effectiveFrom: data.effectiveFrom || new Date().toISOString().slice(0, 10),
      effectiveTo: data.effectiveTo || null,
    },
    ctx,
    { label: 'request concession' }
  );
}

async function decideConcession(yearName, id, { approve, rejectionReason }, ctx) {
  const book = bookFor(yearName);
  const concession = await crud.getOrFail(book, 'Concessions', id, 'concession');
  if (concession.status !== 'pending') {
    throw errors.badRequest('That concession has already been decided.');
  }
  if (!approve && (!rejectionReason || String(rejectionReason).trim().length < 3)) {
    throw errors.validation('Give a reason for rejecting this concession.', {
      rejectionReason: 'Enter a reason.',
    });
  }
  return crud.update(
    book,
    'Concessions',
    id,
    {
      status: approve ? 'approved' : 'rejected',
      approvedBy: crud.actorOf(ctx),
      approvedAt: crud.nowIso(),
      rejectionReason: approve ? null : String(rejectionReason).trim(),
    },
    ctx,
    { label: 'concession' }
  );
}

function concessionAmount(concessions, studentId, feeHeadId, grossAmount, onDate) {
  const applicable = concessions.filter(
    (row) =>
      row.studentId === studentId &&
      row.status === 'approved' &&
      (!row.feeHeadId || row.feeHeadId === feeHeadId) &&
      isEffective(row, onDate)
  );
  let total = 0;
  for (const row of applicable) {
    total += row.mode === 'percent' ? (grossAmount * Number(row.value)) / 100 : Number(row.value);
  }
  return money(Math.min(total, grossAmount));
}

/* -------------------------------------------------------- invoice generation */

/**
 * Builds the invoice set for a class and period without writing anything.
 * The office reviews this before committing (SPEC §11 "preview before commit").
 */
async function previewInvoices(yearName, { yearId, classId, period, frequency, dueDate, issueDate }, ) {
  const students = require('./students');
  const book = bookFor(yearName);
  const onDate = issueDate || new Date().toISOString().slice(0, 10);

  const structures = await listStructures(yearName, { classId, onDate });
  const applicable = structures.filter((s) => s.frequency === frequency);
  if (!applicable.length) {
    throw errors.badRequest(
      'There is no fee structure for that class and frequency on that date. Set one up first.'
    );
  }

  const heads = await listHeads(yearName, { includeInactive: true });
  const headById = new Map(heads.map((h) => [h.id, h]));
  const concessions = await listConcessions(yearName, { status: 'approved' });
  const enrollments = await academics.listEnrollments({ academicYearId: yearId, classId });
  const existing = await workbook.read(book, 'Invoices');

  const rows = [];
  const skipped = [];
  for (const enrollment of enrollments) {
    const alreadyBilled = existing.find(
      (inv) =>
        inv.studentId === enrollment.studentId &&
        inv.period === period &&
        inv.status !== 'cancelled'
    );
    if (alreadyBilled) {
      skipped.push({
        studentId: enrollment.studentId,
        reason: `already invoiced (${alreadyBilled.invoiceNo})`,
      });
      continue;
    }

    const student = await students.get(enrollment.studentId);
    if (!student || student.status !== 'Active') {
      skipped.push({ studentId: enrollment.studentId, reason: 'not an active student' });
      continue;
    }

    const lines = applicable.map((structure) => {
      const gross = money(structure.amount);
      const concession = concessionAmount(
        concessions,
        enrollment.studentId,
        structure.feeHeadId,
        gross,
        onDate
      );
      return {
        feeHeadId: structure.feeHeadId,
        feeHeadName: headById.get(structure.feeHeadId)?.name || 'Unknown head',
        grossAmount: gross,
        concessionAmount: concession,
        netAmount: money(gross - concession),
      };
    });

    const gross = money(lines.reduce((sum, line) => sum + line.grossAmount, 0));
    const concession = money(lines.reduce((sum, line) => sum + line.concessionAmount, 0));

    rows.push({
      studentId: enrollment.studentId,
      enrollmentId: enrollment.id,
      admissionNo: student.admissionNo,
      name: student.fullName,
      rollNo: enrollment.rollNo,
      sectionId: enrollment.sectionId,
      classId: enrollment.classId,
      grossAmount: gross,
      concessionAmount: concession,
      netAmount: money(gross - concession),
      lines,
    });
  }

  return {
    period,
    frequency,
    classId,
    issueDate: onDate,
    dueDate: dueDate || onDate,
    count: rows.length,
    totalAmount: money(rows.reduce((sum, row) => sum + row.netAmount, 0)),
    rows,
    skipped,
  };
}

/**
 * Commits a previewed invoice run. Invoice numbers come from Counters in
 * System.xlsx, so this spans two workbooks and runs journaled.
 */
async function commitInvoices(yearName, preview, ctx) {
  const book = bookFor(yearName);
  if (!preview.rows.length) throw errors.badRequest('There are no invoices to generate.');

  return journal.runJournaled(
    [book, 'System'],
    async (api) => {
      const feesApi = api[book];
      const systemApi = api.System;

      const batch = crud.insertInto(
        feesApi,
        book,
        'InvoiceBatches',
        {
          academicYearId: preview.academicYearId || null,
          classId: preview.classId,
          period: preview.period,
          frequency: preview.frequency,
          dueDate: preview.dueDate,
          count: preview.rows.length,
          totalAmount: preview.totalAmount,
          status: 'committed',
          generatedBy: crud.actorOf(ctx),
          committedAt: crud.nowIso(),
        },
        ctx
      );

      const created = [];
      for (const row of preview.rows) {
        const invoiceNo = counters.nextIn(systemApi, 'invoiceNo', ctx).formatted;
        const invoice = crud.insertInto(
          feesApi,
          book,
          'Invoices',
          {
            invoiceNo,
            batchId: batch.id,
            studentId: row.studentId,
            enrollmentId: row.enrollmentId,
            classId: row.classId,
            sectionId: row.sectionId,
            period: preview.period,
            issueDate: preview.issueDate,
            dueDate: preview.dueDate,
            grossAmount: row.grossAmount,
            concessionAmount: row.concessionAmount,
            netAmount: row.netAmount,
            paidAmount: 0,
            status: 'unpaid',
          },
          ctx
        );

        for (const line of row.lines) {
          crud.insertInto(
            feesApi,
            book,
            'StudentCharges',
            {
              invoiceId: invoice.id,
              invoiceNo,
              studentId: row.studentId,
              enrollmentId: row.enrollmentId,
              classId: row.classId,
              feeHeadId: line.feeHeadId,
              period: preview.period,
              dueDate: preview.dueDate,
              grossAmount: line.grossAmount,
              concessionAmount: line.concessionAmount,
              netAmount: line.netAmount,
              paidAmount: 0,
              status: line.netAmount > 0 ? 'unpaid' : 'paid',
            },
            ctx
          );
        }
        created.push(invoice);
      }

      return { batchId: batch.id, count: created.length, totalAmount: preview.totalAmount };
    },
    { label: 'commit invoices' }
  );
}

/* ---------------------------------------------------------------- ledger */

async function chargesFor(yearName, studentId, { unpaidOnly = false } = {}) {
  const rows = await workbook.read(bookFor(yearName), 'StudentCharges');
  return rows
    .filter((row) => {
      if (row.studentId !== studentId) return false;
      if (row.status === 'cancelled') return false;
      if (unpaidOnly && money(row.netAmount) - money(row.paidAmount) <= 0) return false;
      return true;
    })
    .sort((a, b) => crud.compareValues(a.dueDate, b.dueDate));
}

async function invoicesFor(yearName, studentId) {
  const rows = await workbook.read(bookFor(yearName), 'Invoices');
  return rows
    .filter((row) => row.studentId === studentId)
    .sort((a, b) => crud.compareValues(b.issueDate, a.issueDate));
}

async function paymentsFor(yearName, studentId) {
  const rows = await workbook.read(bookFor(yearName), 'Payments');
  return rows
    .filter((row) => row.studentId === studentId)
    .sort((a, b) => String(b.paidAt || '').localeCompare(String(a.paidAt || '')));
}

/** Full ledger for the collection screen: what is owed, what is paid, what is left. */
async function ledger(yearName, studentId) {
  const [charges, invoices, payments, heads] = await Promise.all([
    chargesFor(yearName, studentId),
    invoicesFor(yearName, studentId),
    paymentsFor(yearName, studentId),
    listHeads(yearName, { includeInactive: true }),
  ]);
  const headById = new Map(heads.map((h) => [h.id, h]));

  const outstanding = charges
    .filter((c) => money(c.netAmount) - money(c.paidAmount) > 0)
    .map((c) => ({
      ...c,
      feeHeadName: headById.get(c.feeHeadId)?.name || 'Unknown head',
      balance: money(money(c.netAmount) - money(c.paidAmount)),
    }));

  const totals = {
    billed: money(charges.reduce((sum, c) => sum + money(c.netAmount), 0)),
    paid: money(charges.reduce((sum, c) => sum + money(c.paidAmount), 0)),
    concession: money(charges.reduce((sum, c) => sum + money(c.concessionAmount), 0)),
  };
  totals.balance = money(totals.billed - totals.paid);

  return { charges, invoices, payments: payments.filter((p) => p.status !== 'reversed'), reversed: payments.filter((p) => p.status === 'reversed'), outstanding, totals };
}

/* -------------------------------------------------------------- collection */

/**
 * Records a payment. `idempotencyKey` is mandatory: a dropped Wi-Fi connection
 * plus a re-click must never charge a parent twice (CLAUDE.md §8).
 *
 * @param {object} input
 * @param {Array<{studentChargeId: string, amount: number}>} input.allocations
 */
async function collect(yearName, input, ctx) {
  const book = bookFor(yearName);

  if (!input.idempotencyKey || String(input.idempotencyKey).length < 8) {
    throw errors.badRequest(
      'This payment is missing its safety key. Reload the page and enter it again.'
    );
  }
  if (!input.studentId) throw errors.badRequest('Choose a student.');
  if (!MODES.includes(input.mode)) {
    throw errors.badRequest(`Payment mode must be one of: ${MODES.join(', ')}.`);
  }
  const amount = money(input.amount);
  if (amount <= 0) {
    throw errors.validation('Enter an amount greater than zero.', { amount: 'Must be more than zero.' });
  }
  if (!Array.isArray(input.allocations) || input.allocations.length === 0) {
    throw errors.badRequest('Choose which fees this payment covers.');
  }
  const allocationTotal = money(
    input.allocations.reduce((sum, a) => sum + money(a.amount), 0)
  );
  if (allocationTotal !== amount) {
    throw errors.validation(
      `The amounts against each fee add up to ${allocationTotal}, but the payment is ${amount}. They must match.`,
      { allocations: 'Allocation total must equal the payment amount.' }
    );
  }
  if (input.mode !== 'cash' && !input.instrumentNo) {
    throw errors.validation('Record the cheque, UPI or transaction reference.', {
      instrumentNo: 'Required for this payment mode.',
    });
  }

  // Idempotency is checked twice: once cheaply here, once inside the lock where
  // it actually matters.
  const existingKeys = await workbook.read(book, 'IdempotencyKeys');
  const seen = existingKeys.find((row) => row.key === input.idempotencyKey);
  if (seen) {
    const receipt = await crud.findOne(book, 'Receipts', (r) => r.receiptNo === seen.receiptNo);
    return { duplicate: true, receipt, receiptNo: seen.receiptNo };
  }

  return journal.runJournaled(
    [book, 'System'],
    async (api) => {
      const feesApi = api[book];
      const systemApi = api.System;

      const keys = feesApi.rows('IdempotencyKeys');
      const replay = keys.find((row) => row.key === input.idempotencyKey);
      if (replay) {
        const receipts = feesApi.rows('Receipts');
        return {
          duplicate: true,
          receiptNo: replay.receiptNo,
          receipt: receipts.find((r) => r.receiptNo === replay.receiptNo) || null,
        };
      }

      const charges = feesApi.rows('StudentCharges');
      const invoices = feesApi.rows('Invoices');

      // Validate every allocation against the live balance before writing anything.
      const planned = [];
      for (const allocation of input.allocations) {
        const index = charges.findIndex((c) => c.id === allocation.studentChargeId);
        if (index === -1) {
          throw errors.notFound('One of those fee lines no longer exists. Reload and try again.');
        }
        const charge = charges[index];
        if (charge.studentId !== input.studentId) {
          throw errors.badRequest('One of those fee lines belongs to a different student.');
        }
        const balance = money(money(charge.netAmount) - money(charge.paidAmount));
        const applied = money(allocation.amount);
        if (applied <= 0) throw errors.badRequest('Allocation amounts must be above zero.');
        if (applied > balance) {
          throw errors.badRequest(
            `You are trying to pay ${applied} against a fee with only ${balance} outstanding. Reload and try again.`
          );
        }
        planned.push({ index, charge, applied });
      }

      const receiptNo = counters.nextIn(systemApi, 'receiptNo', ctx).formatted;
      const paidAt = input.paidAt || crud.nowIso();

      const payment = crud.insertInto(
        feesApi,
        book,
        'Payments',
        {
          receiptNo,
          studentId: input.studentId,
          enrollmentId: input.enrollmentId || null,
          paidAt,
          mode: input.mode,
          amount,
          instrumentNo: input.instrumentNo || null,
          instrumentDate: input.instrumentDate || null,
          bankName: input.bankName || null,
          collectedBy: crud.actorOf(ctx),
          status: 'active',
          idempotencyKey: input.idempotencyKey,
          remarks: input.remarks || null,
        },
        ctx
      );

      for (const { index, charge, applied } of planned) {
        const nextPaid = money(money(charge.paidAmount) + applied);
        const settled = nextPaid >= money(charge.netAmount);
        charges[index] = {
          ...charge,
          paidAmount: nextPaid,
          status: settled ? 'paid' : 'partial',
          _rev: Number(charge._rev || 1) + 1,
          updatedBy: crud.actorOf(ctx),
          updatedAt: crud.nowIso(),
        };

        crud.insertInto(
          feesApi,
          book,
          'PaymentAllocations',
          {
            paymentId: payment.id,
            studentChargeId: charge.id,
            invoiceId: charge.invoiceId,
            feeHeadId: charge.feeHeadId,
            amount: applied,
          },
          ctx
        );

        // Roll the invoice header forward too.
        const invoiceIndex = invoices.findIndex((inv) => inv.id === charge.invoiceId);
        if (invoiceIndex !== -1) {
          const invoice = invoices[invoiceIndex];
          const invoicePaid = money(money(invoice.paidAmount) + applied);
          invoices[invoiceIndex] = {
            ...invoice,
            paidAmount: invoicePaid,
            status:
              invoicePaid >= money(invoice.netAmount)
                ? 'paid'
                : invoicePaid > 0
                  ? 'partial'
                  : 'unpaid',
            _rev: Number(invoice._rev || 1) + 1,
            updatedBy: crud.actorOf(ctx),
            updatedAt: crud.nowIso(),
          };
        }
      }

      const receipt = crud.insertInto(
        feesApi,
        book,
        'Receipts',
        {
          receiptNo,
          paymentId: payment.id,
          studentId: input.studentId,
          issuedAt: paidAt,
          issuedBy: crud.actorOf(ctx),
          amount,
          printCount: 0,
          status: 'active',
        },
        ctx
      );

      crud.insertInto(
        feesApi,
        book,
        'IdempotencyKeys',
        {
          key: input.idempotencyKey,
          scope: 'payment',
          paymentId: payment.id,
          receiptNo,
          usedAt: crud.nowIso(),
        },
        ctx
      );

      return { duplicate: false, payment, receipt, receiptNo };
    },
    { label: 'collect payment' }
  );
}

/* ---------------------------------------------------------------- receipts */

async function getReceipt(yearName, receiptNo) {
  const book = bookFor(yearName);
  const receipt = await crud.findOne(book, 'Receipts', (r) => r.receiptNo === receiptNo);
  if (!receipt) throw errors.notFound('That receipt could not be found.');
  const payment = await crud.get(book, 'Payments', receipt.paymentId);
  const allocations = (await workbook.read(book, 'PaymentAllocations')).filter(
    (a) => a.paymentId === receipt.paymentId
  );
  const heads = await listHeads(yearName, { includeInactive: true });
  const headById = new Map(heads.map((h) => [h.id, h]));
  return {
    receipt,
    payment,
    allocations: allocations.map((a) => ({
      ...a,
      feeHeadName: headById.get(a.feeHeadId)?.name || 'Unknown head',
    })),
  };
}

/** Reprints are marked DUPLICATE (SPEC §11) — the print count drives that. */
async function recordPrint(yearName, receiptNo, ctx) {
  const book = bookFor(yearName);
  const receipt = await crud.findOne(book, 'Receipts', (r) => r.receiptNo === receiptNo);
  if (!receipt) throw errors.notFound('That receipt could not be found.');
  const result = await crud.update(
    book,
    'Receipts',
    receipt.id,
    {
      printCount: Number(receipt.printCount || 0) + 1,
      lastPrintedAt: crud.nowIso(),
    },
    ctx,
    { label: 'receipt' }
  );
  return {
    ...result,
    isDuplicate: Number(receipt.printCount || 0) > 0,
    printCount: Number(receipt.printCount || 0) + 1,
  };
}

/* --------------------------------------------------------------- reversals */

async function requestReversal(yearName, { receiptNo, reason }, ctx) {
  const book = bookFor(yearName);
  if (!reason || String(reason).trim().length < 5) {
    throw errors.validation('Give a reason for the reversal — it stays on the record.', {
      reason: 'Enter a reason.',
    });
  }
  const payment = await crud.findOne(book, 'Payments', (p) => p.receiptNo === receiptNo);
  if (!payment) throw errors.notFound('That receipt could not be found.');
  if (payment.status === 'reversed') {
    throw errors.badRequest('That payment has already been reversed.');
  }
  const pending = await crud.findOne(
    book,
    'Reversals',
    (r) => r.paymentId === payment.id && r.status === 'pending'
  );
  if (pending) throw errors.badRequest('A reversal for that receipt is already awaiting approval.');

  const needsApproval = await settings.get('fees.reversalNeedsApproval', true);
  const row = await crud.create(
    book,
    'Reversals',
    {
      paymentId: payment.id,
      receiptNo,
      amount: money(payment.amount),
      reason: String(reason).trim(),
      requestedBy: crud.actorOf(ctx),
      requestedAt: crud.nowIso(),
      status: needsApproval ? 'pending' : 'approved',
    },
    ctx,
    { label: 'request reversal' }
  );

  if (!needsApproval) {
    return applyReversal(yearName, row.id, ctx);
  }
  return { reversal: row, needsApproval: true };
}

/**
 * Applies an approved reversal. The payment row stays visible with status
 * `reversed`; the reversal row is its counterpart. Nothing is deleted.
 */
async function applyReversal(yearName, reversalId, ctx) {
  const book = bookFor(yearName);
  const reversal = await crud.getOrFail(book, 'Reversals', reversalId, 'reversal');
  if (reversal.status === 'applied') {
    throw errors.badRequest('That reversal has already been applied.');
  }

  return journal.runJournaled(
    [book],
    async (api) => {
      const feesApi = api[book];
      const payments = feesApi.rows('Payments');
      const charges = feesApi.rows('StudentCharges');
      const invoices = feesApi.rows('Invoices');
      const receipts = feesApi.rows('Receipts');
      const allocations = feesApi.rows('PaymentAllocations');

      const paymentIndex = payments.findIndex((p) => p.id === reversal.paymentId);
      if (paymentIndex === -1) throw errors.notFound('That payment could not be found.');
      const payment = payments[paymentIndex];
      if (payment.status === 'reversed') {
        throw errors.badRequest('That payment has already been reversed.');
      }

      for (const allocation of allocations.filter((a) => a.paymentId === payment.id)) {
        const chargeIndex = charges.findIndex((c) => c.id === allocation.studentChargeId);
        if (chargeIndex !== -1) {
          const charge = charges[chargeIndex];
          const nextPaid = money(money(charge.paidAmount) - money(allocation.amount));
          charges[chargeIndex] = {
            ...charge,
            paidAmount: Math.max(0, nextPaid),
            status: nextPaid <= 0 ? 'unpaid' : nextPaid >= money(charge.netAmount) ? 'paid' : 'partial',
            _rev: Number(charge._rev || 1) + 1,
            updatedBy: crud.actorOf(ctx),
            updatedAt: crud.nowIso(),
          };
        }
        const invoiceIndex = invoices.findIndex((inv) => inv.id === allocation.invoiceId);
        if (invoiceIndex !== -1) {
          const invoice = invoices[invoiceIndex];
          const nextPaid = money(money(invoice.paidAmount) - money(allocation.amount));
          invoices[invoiceIndex] = {
            ...invoice,
            paidAmount: Math.max(0, nextPaid),
            status: nextPaid <= 0 ? 'unpaid' : nextPaid >= money(invoice.netAmount) ? 'paid' : 'partial',
            _rev: Number(invoice._rev || 1) + 1,
            updatedBy: crud.actorOf(ctx),
            updatedAt: crud.nowIso(),
          };
        }
      }

      payments[paymentIndex] = {
        ...payment,
        status: 'reversed',
        reversalId: reversal.id,
        _rev: Number(payment._rev || 1) + 1,
        updatedBy: crud.actorOf(ctx),
        updatedAt: crud.nowIso(),
      };

      const receiptIndex = receipts.findIndex((r) => r.paymentId === payment.id);
      if (receiptIndex !== -1) {
        receipts[receiptIndex] = {
          ...receipts[receiptIndex],
          status: 'cancelled',
          _rev: Number(receipts[receiptIndex]._rev || 1) + 1,
          updatedBy: crud.actorOf(ctx),
          updatedAt: crud.nowIso(),
        };
      }

      crud.updateIn(
        feesApi,
        book,
        'Reversals',
        reversal.id,
        {
          status: 'applied',
          approvedBy: crud.actorOf(ctx),
          approvedAt: crud.nowIso(),
        },
        ctx,
        { label: 'reversal' }
      );

      return { receiptNo: payment.receiptNo, amount: money(payment.amount) };
    },
    { label: 'apply reversal' }
  );
}

async function rejectReversal(yearName, reversalId, rejectionReason, ctx) {
  const book = bookFor(yearName);
  if (!rejectionReason || String(rejectionReason).trim().length < 3) {
    throw errors.validation('Give a reason for rejecting the reversal.', {
      rejectionReason: 'Enter a reason.',
    });
  }
  return crud.update(
    book,
    'Reversals',
    reversalId,
    {
      status: 'rejected',
      approvedBy: crud.actorOf(ctx),
      approvedAt: crud.nowIso(),
      rejectionReason: String(rejectionReason).trim(),
    },
    ctx,
    { label: 'reversal' }
  );
}

async function listReversals(yearName, { status = null } = {}) {
  const rows = await workbook.read(bookFor(yearName), 'Reversals');
  return rows
    .filter((row) => !status || row.status === status)
    .sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
}

/* ----------------------------------------------------------------- reports */

/** Day book: every transaction on a date, for tallying physical cash. */
async function dayBook(yearName, date) {
  const students = require('./students');
  const users = require('./users');
  const book = bookFor(yearName);
  const payments = (await workbook.read(book, 'Payments')).filter(
    (p) => String(p.paidAt || '').slice(0, 10) === date
  );
  const names = await users.displayNames();

  const rows = [];
  for (const payment of payments) {
    const student = await students.get(payment.studentId);
    rows.push({
      receiptNo: payment.receiptNo,
      paidAt: payment.paidAt,
      studentName: student?.fullName || 'Unknown',
      admissionNo: student?.admissionNo || '',
      mode: payment.mode,
      instrumentNo: payment.instrumentNo,
      amount: money(payment.amount),
      status: payment.status,
      // Stored as a user id; the cash box is tallied against a person, not a UUID.
      collectedBy: names.get(payment.collectedBy) || payment.collectedBy,
    });
  }
  rows.sort((a, b) => String(a.paidAt).localeCompare(String(b.paidAt)));

  const active = rows.filter((r) => r.status !== 'reversed');
  const byMode = {};
  for (const mode of MODES) byMode[mode] = 0;
  for (const row of active) byMode[row.mode] = money((byMode[row.mode] || 0) + row.amount);

  return {
    date,
    rows,
    totals: {
      collected: money(active.reduce((sum, r) => sum + r.amount, 0)),
      reversed: money(
        rows.filter((r) => r.status === 'reversed').reduce((sum, r) => sum + r.amount, 0)
      ),
      count: active.length,
      byMode,
    },
  };
}

async function collectionSummary(yearName, { from, to }) {
  const book = bookFor(yearName);
  const payments = (await workbook.read(book, 'Payments')).filter((p) => {
    const date = String(p.paidAt || '').slice(0, 10);
    return date >= from && date <= to && p.status !== 'reversed';
  });
  const allocations = await workbook.read(book, 'PaymentAllocations');
  const heads = await listHeads(yearName, { includeInactive: true });
  const headById = new Map(heads.map((h) => [h.id, h]));
  const paymentIds = new Set(payments.map((p) => p.id));

  const byHead = new Map();
  for (const allocation of allocations) {
    if (!paymentIds.has(allocation.paymentId)) continue;
    const key = allocation.feeHeadId;
    byHead.set(key, money((byHead.get(key) || 0) + money(allocation.amount)));
  }

  const byMode = new Map();
  const byDate = new Map();
  for (const payment of payments) {
    byMode.set(payment.mode, money((byMode.get(payment.mode) || 0) + money(payment.amount)));
    const date = String(payment.paidAt).slice(0, 10);
    byDate.set(date, money((byDate.get(date) || 0) + money(payment.amount)));
  }

  return {
    from,
    to,
    total: money(payments.reduce((sum, p) => sum + money(p.amount), 0)),
    count: payments.length,
    byHead: [...byHead.entries()].map(([feeHeadId, amount]) => ({
      feeHeadId,
      feeHeadName: headById.get(feeHeadId)?.name || 'Unknown head',
      amount,
    })),
    byMode: [...byMode.entries()].map(([mode, amount]) => ({ mode, amount })),
    byDate: [...byDate.entries()]
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Dues with ageing buckets (SPEC §11). */
async function dues(yearName, { yearId, classId = null, sectionId = null, asOf = null } = {}) {
  const students = require('./students');
  const book = bookFor(yearName);
  const today = asOf || new Date().toISOString().slice(0, 10);
  const charges = (await workbook.read(book, 'StudentCharges')).filter(
    (c) => c.status !== 'cancelled' && money(c.netAmount) - money(c.paidAmount) > 0
  );

  const enrollments = await academics.listEnrollments({
    academicYearId: yearId,
    classId: classId || null,
    sectionId: sectionId || null,
  });
  const enrollmentByStudent = new Map(enrollments.map((e) => [e.studentId, e]));

  const sections = await academics.listSections({ academicYearId: yearId });
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const classes = await academics.listClasses();
  const classById = new Map(classes.map((c) => [c.id, c]));
  const heads = await listHeads(yearName, { includeInactive: true });
  const headById = new Map(heads.map((h) => [h.id, h]));

  const byStudent = new Map();
  for (const charge of charges) {
    if (!enrollmentByStudent.has(charge.studentId)) continue;
    if (!byStudent.has(charge.studentId)) byStudent.set(charge.studentId, []);
    byStudent.get(charge.studentId).push(charge);
  }

  const rows = [];
  const headTotals = new Map();
  for (const [studentId, studentCharges] of byStudent) {
    const student = await students.get(studentId);
    if (!student) continue;
    const enrollment = enrollmentByStudent.get(studentId);
    const section = sectionById.get(enrollment.sectionId);
    const guardian = await students.primaryGuardian(studentId);

    const buckets = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    let total = 0;
    for (const charge of studentCharges) {
      const balance = money(money(charge.netAmount) - money(charge.paidAmount));
      total = money(total + balance);
      buckets[bucketFor(charge.dueDate, today)] = money(
        buckets[bucketFor(charge.dueDate, today)] + balance
      );
      headTotals.set(
        charge.feeHeadId,
        money((headTotals.get(charge.feeHeadId) || 0) + balance)
      );
    }

    rows.push({
      studentId,
      admissionNo: student.admissionNo,
      name: student.fullName,
      className: classById.get(enrollment.classId)?.name || '',
      sectionName: section?.name || '',
      rollNo: enrollment.rollNo,
      guardianName: guardian?.name || '',
      guardianPhone: guardian?.phone || '',
      total,
      ...buckets,
    });
  }

  rows.sort((a, b) => b.total - a.total);

  return {
    asOf: today,
    rows,
    totals: {
      outstanding: money(rows.reduce((sum, r) => sum + r.total, 0)),
      students: rows.length,
      byHead: [...headTotals.entries()].map(([feeHeadId, amount]) => ({
        feeHeadId,
        feeHeadName: headById.get(feeHeadId)?.name || 'Unknown head',
        amount,
      })),
      byBucket: ['current', '1-30', '31-60', '61-90', '90+'].map((bucket) => ({
        bucket,
        amount: money(rows.reduce((sum, r) => sum + (r[bucket] || 0), 0)),
      })),
    },
  };
}

function bucketFor(dueDate, today) {
  if (!dueDate || dueDate >= today) return 'current';
  const days = Math.floor((Date.parse(today) - Date.parse(dueDate)) / 86400000);
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

/**
 * Reconciliation: what the ledger says versus the sum of its parts. A mismatch
 * means something wrote outside the intended path and must be investigated.
 */
async function reconciliation(yearName) {
  const book = bookFor(yearName);
  const [charges, invoices, payments, allocations] = await Promise.all([
    workbook.read(book, 'StudentCharges'),
    workbook.read(book, 'Invoices'),
    workbook.read(book, 'Payments'),
    workbook.read(book, 'PaymentAllocations'),
  ]);

  const activePayments = payments.filter((p) => p.status !== 'reversed');
  const activePaymentIds = new Set(activePayments.map((p) => p.id));
  const allocatedTotal = money(
    allocations
      .filter((a) => activePaymentIds.has(a.paymentId))
      .reduce((sum, a) => sum + money(a.amount), 0)
  );
  const paymentTotal = money(activePayments.reduce((sum, p) => sum + money(p.amount), 0));
  const chargePaidTotal = money(
    charges.filter((c) => c.status !== 'cancelled').reduce((sum, c) => sum + money(c.paidAmount), 0)
  );
  const invoicePaidTotal = money(
    invoices.filter((i) => i.status !== 'cancelled').reduce((sum, i) => sum + money(i.paidAmount), 0)
  );

  const checks = [
    {
      name: 'Payments total equals allocations total',
      expected: paymentTotal,
      actual: allocatedTotal,
      ok: paymentTotal === allocatedTotal,
    },
    {
      name: 'Allocations total equals fee lines paid',
      expected: allocatedTotal,
      actual: chargePaidTotal,
      ok: allocatedTotal === chargePaidTotal,
    },
    {
      name: 'Fee lines paid equals invoices paid',
      expected: chargePaidTotal,
      actual: invoicePaidTotal,
      ok: chargePaidTotal === invoicePaidTotal,
    },
  ];

  return {
    checks,
    ok: checks.every((check) => check.ok),
    totals: { paymentTotal, allocatedTotal, chargePaidTotal, invoicePaidTotal },
  };
}

/** Collected today / month-to-date for the dashboard. */
async function dashboardTotals(yearName, today) {
  const book = bookFor(yearName);
  const payments = (await workbook.read(book, 'Payments')).filter((p) => p.status !== 'reversed');
  const month = today.slice(0, 7);
  const todayTotal = money(
    payments
      .filter((p) => String(p.paidAt || '').slice(0, 10) === today)
      .reduce((sum, p) => sum + money(p.amount), 0)
  );
  const monthTotal = money(
    payments
      .filter((p) => String(p.paidAt || '').slice(0, 7) === month)
      .reduce((sum, p) => sum + money(p.amount), 0)
  );
  const charges = await workbook.read(book, 'StudentCharges');
  const outstanding = money(
    charges
      .filter((c) => c.status !== 'cancelled')
      .reduce((sum, c) => sum + Math.max(0, money(c.netAmount) - money(c.paidAmount)), 0)
  );
  const receiptsToday = payments.filter(
    (p) => String(p.paidAt || '').slice(0, 10) === today
  ).length;

  return { todayTotal, monthTotal, outstanding, receiptsToday };
}

async function seedHeads(yearName, ctx) {
  const existing = await listHeads(yearName, { includeInactive: true });
  if (existing.length) return [];
  const defaults = [
    { name: 'Tuition Fee', code: 'TUI', kind: 'tuition', sortOrder: 1 },
    { name: 'Admission Fee', code: 'ADM', kind: 'admission', sortOrder: 2 },
    { name: 'Examination Fee', code: 'EXM', kind: 'exam', sortOrder: 3 },
    { name: 'Transport Fee', code: 'TRN', kind: 'transport', sortOrder: 4 },
    { name: 'Laboratory Fee', code: 'LAB', kind: 'lab', sortOrder: 5 },
    { name: 'Late Fee', code: 'LATE', kind: 'latefee', sortOrder: 6 },
  ];
  const created = [];
  for (const head of defaults) {
    created.push(await createHead(yearName, head, ctx));
  }
  return created;
}

module.exports = {
  FREQUENCIES,
  MODES,
  HEAD_KINDS,
  CONCESSION_KINDS,
  bookFor,
  money,
  listHeads,
  createHead,
  updateHead,
  listStructures,
  setStructure,
  isEffective,
  listConcessions,
  requestConcession,
  decideConcession,
  previewInvoices,
  commitInvoices,
  chargesFor,
  invoicesFor,
  paymentsFor,
  ledger,
  collect,
  getReceipt,
  recordPrint,
  requestReversal,
  applyReversal,
  rejectReversal,
  listReversals,
  dayBook,
  collectionSummary,
  dues,
  reconciliation,
  dashboardTotals,
  seedHeads,
};
