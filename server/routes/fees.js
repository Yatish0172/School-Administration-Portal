'use strict';

const express = require('express');

const { ok, handler, body, str, num, bool, isoDate } = require('../http');
const { need } = require('../middleware/permission');
const fees = require('../store/fees');
const academics = require('../store/academics');
const students = require('../store/students');
const exporter = require('../store/exporter');
const settings = require('../store/settings');
const audit = require('../store/audit');
const { sendXlsx } = require('./system');
const { schoolHeader, exportMeta, auditExport } = require('./students');
const errors = require('../errors');

const router = express.Router();
const ctxOf = (req) => ({ userId: req.user.id, name: req.user.name });

async function yearOf(req, source = 'query') {
  const raw = source === 'query' ? req.query.academicYearId : req.body?.academicYearId;
  return academics.resolveYear(str(raw, { max: 40 }));
}

/* --------------------------------------------------------------- fee heads */

router.get(
  '/fees/heads',
  need('fees.view'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    return ok(res, {
      academicYearId: year.id,
      rows: await fees.listHeads(year.name, { includeInactive: bool(req.query.includeInactive) }),
      kinds: fees.HEAD_KINDS,
    });
  })
);

router.post(
  '/fees/heads',
  need('fees.structure'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const row = await fees.createHead(
      year.name,
      {
        name: str(input.name, { max: 60 }),
        code: str(input.code, { max: 12 }),
        kind: str(input.kind, { max: 20 }),
        refundable: bool(input.refundable),
        sortOrder: num(input.sortOrder, { min: 0, max: 999 }),
        description: str(input.description, { max: 200 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/fees/heads/:id',
  need('fees.structure'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const result = await fees.updateHead(
      year.name,
      req.params.id,
      {
        name: str(input.name, { max: 60 }),
        code: str(input.code, { max: 12 }),
        kind: str(input.kind, { max: 20 }),
        refundable: bool(input.refundable),
        sortOrder: num(input.sortOrder, { min: 0, max: 999 }),
        status: str(input.status, { max: 10 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

/* -------------------------------------------------------------- structures */

router.get(
  '/fees/structures',
  need('fees.view'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const rows = await fees.listStructures(year.name, {
      classId: str(req.query.classId, { max: 40 }),
      onDate: isoDate(req.query.onDate),
    });
    const heads = await fees.listHeads(year.name, { includeInactive: true });
    const headById = new Map(heads.map((h) => [h.id, h]));
    const classes = await academics.listClasses();
    const classById = new Map(classes.map((c) => [c.id, c]));

    return ok(res, {
      academicYearId: year.id,
      rows: rows.map((row) => ({
        ...row,
        feeHeadName: headById.get(row.feeHeadId)?.name || '',
        className: classById.get(row.classId)?.name || '',
      })),
      frequencies: fees.FREQUENCIES,
    });
  })
);

router.post(
  '/fees/structures',
  need('fees.structure'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const row = await fees.setStructure(
      year.name,
      {
        academicYearId: year.id,
        classId: str(input.classId, { max: 40 }),
        feeHeadId: str(input.feeHeadId, { max: 40 }),
        amount: num(input.amount, { min: 0 }),
        frequency: str(input.frequency, { max: 12 }),
        effectiveFrom: isoDate(input.effectiveFrom),
        effectiveTo: isoDate(input.effectiveTo),
      },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.SETTING_CHANGED,
      entityType: 'feeStructure',
      entityId: row.id,
      after: { amount: row.amount, frequency: row.frequency, effectiveFrom: row.effectiveFrom },
      message: `Set a fee amount of ${row.amount} effective ${row.effectiveFrom}`,
    });
    return ok(res, row);
  })
);

/* ------------------------------------------------------------- concessions */

router.get(
  '/fees/concessions',
  need('fees.view'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const rows = await fees.listConcessions(year.name, {
      studentId: str(req.query.studentId, { max: 40 }),
      status: str(req.query.status, { max: 12 }),
    });
    const heads = await fees.listHeads(year.name, { includeInactive: true });
    const headById = new Map(heads.map((h) => [h.id, h]));

    const out = [];
    for (const row of rows) {
      const student = await students.get(row.studentId);
      out.push({
        ...row,
        studentName: student?.fullName || 'Unknown',
        admissionNo: student?.admissionNo || '',
        feeHeadName: row.feeHeadId ? headById.get(row.feeHeadId)?.name || '' : 'All fee heads',
      });
    }
    return ok(res, { rows: out, kinds: fees.CONCESSION_KINDS });
  })
);

router.post(
  '/fees/concessions',
  need('fees.concession'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const row = await fees.requestConcession(
      year.name,
      {
        studentId: str(input.studentId, { max: 40 }),
        feeHeadId: str(input.feeHeadId, { max: 40 }),
        kind: str(input.kind, { max: 20 }),
        mode: str(input.mode, { max: 10 }),
        value: num(input.value, { min: 0 }),
        reason: str(input.reason, { max: 300 }),
        effectiveFrom: isoDate(input.effectiveFrom),
        effectiveTo: isoDate(input.effectiveTo),
      },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.CONCESSION_REQUESTED,
      entityType: 'concession',
      entityId: row.id,
      after: { kind: row.kind, mode: row.mode, value: row.value },
      message: `Requested a ${row.kind} concession: ${row.reason}`,
    });
    return ok(res, row);
  })
);

router.post(
  '/fees/concessions/:id/decide',
  need('fees.concession.approve'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const approve = bool(input.approve);
    const result = await fees.decideConcession(
      year.name,
      req.params.id,
      { approve, rejectionReason: str(input.rejectionReason, { max: 300 }) },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.CONCESSION_APPROVED,
      entityType: 'concession',
      entityId: req.params.id,
      before: { status: result.before.status },
      after: { status: result.after.status },
      message: `${approve ? 'Approved' : 'Rejected'} a ${result.after.kind} concession of ${
        result.after.mode === 'percent' ? `${result.after.value}%` : result.after.value
      }`,
    });
    return ok(res, result.after);
  })
);

/* ----------------------------------------------------------------- invoices */

/** Preview writes nothing — the office checks the numbers before committing. */
router.post(
  '/fees/invoices/preview',
  need('fees.invoice'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const preview = await fees.previewInvoices(year.name, {
      yearId: year.id,
      classId: str(input.classId, { max: 40 }),
      period: str(input.period, { max: 20 }),
      frequency: str(input.frequency, { max: 12 }),
      dueDate: isoDate(input.dueDate),
      issueDate: isoDate(input.issueDate),
    });
    return ok(res, { ...preview, academicYearId: year.id });
  })
);

router.post(
  '/fees/invoices/commit',
  need('fees.invoice'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    // Re-run the preview server-side: a client-supplied list of amounts is not
    // something to trust with money.
    const preview = await fees.previewInvoices(year.name, {
      yearId: year.id,
      classId: str(input.classId, { max: 40 }),
      period: str(input.period, { max: 20 }),
      frequency: str(input.frequency, { max: 12 }),
      dueDate: isoDate(input.dueDate),
      issueDate: isoDate(input.issueDate),
    });

    if (Number(input.expectedCount) && Number(input.expectedCount) !== preview.count) {
      throw errors.conflict(
        `The preview showed ${input.expectedCount} invoices but there are now ${preview.count}. Review the preview again.`
      );
    }

    const result = await fees.commitInvoices(
      year.name,
      { ...preview, academicYearId: year.id },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.FEE_INVOICE_GENERATED,
      entityType: 'invoiceBatch',
      entityId: result.batchId,
      after: result,
      message: `Generated ${result.count} invoices for ${preview.period} totalling ${result.totalAmount}`,
    });
    return ok(res, result);
  })
);

/* ------------------------------------------------------------------ ledger */

router.get(
  '/fees/students/:studentId',
  need('fees.view'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const student = await students.getOrFail(req.params.studentId);
    const ledger = await fees.ledger(year.name, req.params.studentId);
    const enrollment = await academics.enrollmentFor(req.params.studentId, year.id);
    const classes = await academics.listClasses();
    const sections = await academics.listSections({ academicYearId: year.id });

    return ok(res, {
      student,
      className: enrollment ? classes.find((c) => c.id === enrollment.classId)?.name || '' : '',
      sectionName: enrollment ? sections.find((s) => s.id === enrollment.sectionId)?.name || '' : '',
      enrollmentId: enrollment?.id || null,
      ...ledger,
      modes: fees.MODES,
    });
  })
);

/* -------------------------------------------------------------- collection */

/**
 * Collect a payment. The client must supply an idempotency key; a repeat of the
 * same key returns the original receipt rather than charging twice.
 */
router.post(
  '/fees/payments',
  need('fees.collect'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);

    const result = await fees.collect(
      year.name,
      {
        idempotencyKey: str(input.idempotencyKey, { max: 64 }),
        studentId: str(input.studentId, { max: 40 }),
        enrollmentId: str(input.enrollmentId, { max: 40 }),
        mode: str(input.mode, { max: 20 }),
        amount: num(input.amount, { min: 0 }),
        instrumentNo: str(input.instrumentNo, { max: 40 }),
        instrumentDate: isoDate(input.instrumentDate),
        bankName: str(input.bankName, { max: 80 }),
        remarks: str(input.remarks, { max: 200 }),
        allocations: Array.isArray(input.allocations)
          ? input.allocations.map((allocation) => ({
              studentChargeId: String(allocation.studentChargeId),
              amount: num(allocation.amount, { min: 0 }),
            }))
          : [],
      },
      ctxOf(req)
    );

    if (!result.duplicate) {
      await audit.fromRequest(req, {
        action: audit.ACTIONS.FEE_PAYMENT,
        entityType: 'payment',
        entityId: result.payment.id,
        after: {
          receiptNo: result.receiptNo,
          amount: result.payment.amount,
          mode: result.payment.mode,
        },
        message: `Collected ${result.payment.amount} by ${result.payment.mode}, receipt ${result.receiptNo}`,
      });
    }

    return ok(res, result);
  })
);

router.get(
  '/fees/receipts/:receiptNo',
  need('fees.view'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const detail = await fees.getReceipt(year.name, req.params.receiptNo);
    const student = await students.get(detail.receipt.studentId);
    const enrollment = student ? await academics.enrollmentFor(student.id, year.id) : null;
    const classes = await academics.listClasses();
    const sections = await academics.listSections({ academicYearId: year.id });

    return ok(res, {
      ...detail,
      student,
      className: enrollment ? classes.find((c) => c.id === enrollment.classId)?.name || '' : '',
      sectionName: enrollment ? sections.find((s) => s.id === enrollment.sectionId)?.name || '' : '',
      school: await schoolHeader(),
      footer: await settings.get('fees.receiptFooter', ''),
      academicYear: year.name,
      isDuplicate: Number(detail.receipt.printCount || 0) > 0,
    });
  })
);

/** Records the print so a reprint is stamped DUPLICATE. */
router.post(
  '/fees/receipts/:receiptNo/print',
  need('fees.view'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const result = await fees.recordPrint(year.name, req.params.receiptNo, ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.RECEIPT_PRINTED,
      entityType: 'receipt',
      entityId: req.params.receiptNo,
      after: { printCount: result.printCount },
      message: `Printed receipt ${req.params.receiptNo}${result.isDuplicate ? ' (duplicate)' : ''}`,
    });
    return ok(res, { isDuplicate: result.isDuplicate, printCount: result.printCount });
  })
);

/* --------------------------------------------------------------- reversals */

router.get(
  '/fees/reversals',
  need('fees.view'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const rows = await fees.listReversals(year.name, { status: str(req.query.status, { max: 12 }) });
    return ok(res, { rows, needsApproval: await settings.get('fees.reversalNeedsApproval', true) });
  })
);

router.post(
  '/fees/reversals',
  need('fees.reverse'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const result = await fees.requestReversal(
      year.name,
      { receiptNo: str(input.receiptNo, { max: 30 }), reason: str(input.reason, { max: 300 }) },
      ctxOf(req)
    );

    await audit.fromRequest(req, {
      action: result.needsApproval
        ? audit.ACTIONS.FEE_REVERSAL_REQUESTED
        : audit.ACTIONS.FEE_REVERSAL,
      entityType: 'reversal',
      entityId: result.reversal?.id || input.receiptNo,
      after: result,
      message: result.needsApproval
        ? `Requested reversal of receipt ${input.receiptNo}: ${input.reason}`
        : `Reversed receipt ${input.receiptNo}: ${input.reason}`,
    });
    return ok(res, result);
  })
);

router.post(
  '/fees/reversals/:id/approve',
  need('fees.reverse.approve'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const result = await fees.applyReversal(year.name, req.params.id, ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.FEE_REVERSAL,
      entityType: 'reversal',
      entityId: req.params.id,
      after: result,
      message: `Approved and applied the reversal of receipt ${result.receiptNo} (${result.amount})`,
    });
    return ok(res, result);
  })
);

router.post(
  '/fees/reversals/:id/reject',
  need('fees.reverse.approve'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const result = await fees.rejectReversal(
      year.name,
      req.params.id,
      str(input.rejectionReason, { max: 300 }),
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.FEE_REVERSAL_REQUESTED,
      entityType: 'reversal',
      entityId: req.params.id,
      after: { status: 'rejected' },
      message: `Rejected a reversal request: ${input.rejectionReason}`,
    });
    return ok(res, result.after);
  })
);

/* ----------------------------------------------------------------- reports */

router.get(
  '/fees/reports/day-book',
  need('fees.report'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const date = isoDate(req.query.date) || new Date().toISOString().slice(0, 10);
    return ok(res, await fees.dayBook(year.name, date));
  })
);

router.get(
  '/fees/reports/collection',
  need('fees.report'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    return ok(
      res,
      await fees.collectionSummary(year.name, {
        from: isoDate(req.query.from) || year.startDate,
        to: isoDate(req.query.to) || new Date().toISOString().slice(0, 10),
      })
    );
  })
);

router.get(
  '/fees/reports/dues',
  need('fees.report'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    return ok(
      res,
      await fees.dues(year.name, {
        yearId: year.id,
        classId: str(req.query.classId, { max: 40 }),
        sectionId: str(req.query.sectionId, { max: 40 }),
        asOf: isoDate(req.query.asOf),
      })
    );
  })
);

router.get(
  '/fees/reports/reconciliation',
  need('fees.report'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    return ok(res, await fees.reconciliation(year.name));
  })
);

router.get(
  '/fees/export/:report',
  need('report.export'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const meta = await exportMeta(req);
    const date = isoDate(req.query.date) || new Date().toISOString().slice(0, 10);

    const specs = {
      'day-book': async () => {
        const report = await fees.dayBook(year.name, date);
        return {
          title: 'Fee day book',
          subtitle: `${date} — collected ${report.totals.collected} in ${report.totals.count} receipts`,
          columns: [
            { key: 'receiptNo', label: 'Receipt', width: 16 },
            { key: 'paidAt', label: 'Time', width: 22 },
            { key: 'admissionNo', label: 'Admission No', width: 16 },
            { key: 'studentName', label: 'Student', width: 26 },
            { key: 'mode', label: 'Mode', width: 14 },
            { key: 'instrumentNo', label: 'Reference', width: 18 },
            { key: 'amount', label: 'Amount', type: 'money' },
            { key: 'status', label: 'Status', width: 12 },
            { key: 'collectedBy', label: 'Collected by', width: 20 },
          ],
          rows: report.rows,
          totals: { amount: report.totals.collected },
        };
      },
      dues: async () => {
        const report = await fees.dues(year.name, {
          yearId: year.id,
          classId: str(req.query.classId, { max: 40 }),
          sectionId: str(req.query.sectionId, { max: 40 }),
          asOf: isoDate(req.query.asOf),
        });
        return {
          title: 'Outstanding dues',
          subtitle: `As at ${report.asOf} — ${report.totals.outstanding} across ${report.totals.students} students`,
          columns: [
            { key: 'admissionNo', label: 'Admission No', width: 16 },
            { key: 'name', label: 'Student', width: 26 },
            { key: 'className', label: 'Class', width: 12 },
            { key: 'sectionName', label: 'Section', width: 10 },
            { key: 'current', label: 'Not yet due', type: 'money' },
            { key: '1-30', label: '1-30 days', type: 'money' },
            { key: '31-60', label: '31-60 days', type: 'money' },
            { key: '61-90', label: '61-90 days', type: 'money' },
            { key: '90+', label: 'Over 90 days', type: 'money' },
            { key: 'total', label: 'Total due', type: 'money' },
            { key: 'guardianPhone', label: 'Phone', width: 14 },
          ],
          rows: report.rows,
          totals: { total: report.totals.outstanding },
        };
      },
      collection: async () => {
        const report = await fees.collectionSummary(year.name, {
          from: isoDate(req.query.from) || year.startDate,
          to: isoDate(req.query.to) || date,
        });
        return {
          title: 'Collection summary by fee head',
          subtitle: `${report.from} to ${report.to} — total ${report.total}`,
          columns: [
            { key: 'feeHeadName', label: 'Fee head', width: 26 },
            { key: 'amount', label: 'Collected', type: 'money' },
          ],
          rows: report.byHead,
          totals: { amount: report.total },
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

module.exports = { router };
