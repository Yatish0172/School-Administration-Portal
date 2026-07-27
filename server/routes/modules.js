'use strict';

const express = require('express');
const fs = require('fs');

const { ok, handler, body, str, num, bool, isoDate, pagination } = require('../http');
const { need, needAny } = require('../middleware/permission');
const library = require('../store/library');
const transport = require('../store/transport');
const notices = require('../store/notices');
const staff = require('../store/staff');
const students = require('../store/students');
const academics = require('../store/academics');
const permissions = require('../store/permissions');
const exporter = require('../store/exporter');
const audit = require('../store/audit');
const files = require('../services/files');
const { sendXlsx } = require('./system');
const { exportMeta, auditExport } = require('./students');
const errors = require('../errors');

const router = express.Router();
const ctxOf = (req) => ({ userId: req.user.id, name: req.user.name });

/* ==========================================================================
 * Library
 * ====================================================================== */

router.get(
  '/library/titles',
  need('library.view'),
  handler(async (req, res) => {
    const page = pagination(req.query);
    const result = await library.listTitles(page);
    const copies = await library.listCopies();
    const byTitle = new Map();
    for (const copy of copies) {
      if (!byTitle.has(copy.titleId)) byTitle.set(copy.titleId, { total: 0, available: 0 });
      const entry = byTitle.get(copy.titleId);
      entry.total += 1;
      if (copy.status === 'available') entry.available += 1;
    }
    return ok(res, {
      ...result,
      rows: result.rows.map((row) => ({
        ...row,
        copies: byTitle.get(row.id)?.total || 0,
        available: byTitle.get(row.id)?.available || 0,
      })),
    });
  })
);

router.post(
  '/library/titles',
  need('library.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await library.createTitle(
      {
        title: str(input.title, { max: 200 }),
        author: str(input.author, { max: 120 }),
        publisher: str(input.publisher, { max: 120 }),
        isbn: str(input.isbn, { max: 20 }),
        category: str(input.category, { max: 60 }),
        edition: str(input.edition, { max: 40 }),
        language: str(input.language, { max: 40 }),
        price: num(input.price, { min: 0 }),
        shelf: str(input.shelf, { max: 30 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/library/titles/:id',
  need('library.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await library.updateTitle(
      req.params.id,
      {
        title: str(input.title, { max: 200 }),
        author: str(input.author, { max: 120 }),
        publisher: str(input.publisher, { max: 120 }),
        isbn: str(input.isbn, { max: 20 }),
        category: str(input.category, { max: 60 }),
        edition: str(input.edition, { max: 40 }),
        language: str(input.language, { max: 40 }),
        price: num(input.price, { min: 0 }),
        shelf: str(input.shelf, { max: 30 }),
        status: str(input.status, { max: 10 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

router.get(
  '/library/titles/:id/copies',
  need('library.view'),
  handler(async (req, res) =>
    ok(res, {
      title: await library.getTitle(req.params.id),
      rows: await library.listCopies({ titleId: req.params.id }),
      statuses: library.COPY_STATUSES,
    })
  )
);

router.post(
  '/library/titles/:id/copies',
  need('library.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const created = await library.addCopies(
      req.params.id,
      {
        count: num(input.count, { min: 1, max: 200 }),
        price: num(input.price, { min: 0 }),
        purchaseDate: isoDate(input.purchaseDate),
      },
      ctxOf(req)
    );
    return ok(res, { created: created.length, accessionNumbers: created.map((c) => c.accessionNo) });
  })
);

router.post(
  '/library/copies/:id/status',
  need('library.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await library.setCopyStatus(
      req.params.id,
      str(input.status, { max: 12 }),
      ctxOf(req)
    );
    return ok(res, result.after);
  })
);

router.get(
  '/library/issues',
  need('library.view'),
  handler(async (req, res) => {
    const rows = await library.activeIssues({
      studentId: str(req.query.studentId, { max: 40 }),
      staffId: str(req.query.staffId, { max: 40 }),
    });
    const titles = await library.listTitles({ pageSize: 0 });
    const byId = new Map(titles.rows.map((t) => [t.id, t]));

    const out = [];
    for (const row of rows) {
      let borrower = '';
      if (row.borrowerType === 'student') {
        const student = await students.get(row.studentId);
        borrower = student?.fullName || 'Unknown student';
      } else {
        const member = await staff.get(row.staffId);
        borrower = member?.name || 'Unknown staff';
      }
      out.push({
        ...row,
        title: byId.get(row.titleId)?.title || '',
        borrower,
        daysOverdue: library.overdueDays(row.dueDate),
      });
    }
    return ok(res, { rows: out });
  })
);

router.post(
  '/library/issues',
  need('library.issue'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await library.issue(
      {
        accessionNo: str(input.accessionNo, { max: 30 }),
        borrowerType: str(input.borrowerType, { max: 10 }),
        studentId: str(input.studentId, { max: 40 }),
        staffId: str(input.staffId, { max: 40 }),
      },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.BOOK_ISSUED,
      entityType: 'bookIssue',
      entityId: row.id,
      after: { accessionNo: row.accessionNo, dueDate: row.dueDate },
      message: `Issued accession ${row.accessionNo}, due ${row.dueDate}`,
    });
    return ok(res, row);
  })
);

router.post(
  '/library/issues/:id/return',
  need('library.issue'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await library.takeReturn(
      { issueId: req.params.id, condition: str(input.condition, { max: 12 }) || 'good' },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.BOOK_RETURNED,
      entityType: 'bookIssue',
      entityId: req.params.id,
      after: { daysOverdue: result.daysOverdue, fineAmount: result.fineAmount },
      message: `Returned accession ${result.issue.accessionNo}${
        result.fineAmount ? ` with a fine of ${result.fineAmount}` : ''
      }`,
    });
    return ok(res, result);
  })
);

router.post(
  '/library/issues/:id/renew',
  need('library.issue'),
  handler(async (req, res) => {
    const result = await library.renew(req.params.id, ctxOf(req));
    return ok(res, result.after);
  })
);

router.get(
  '/library/fines',
  need('library.view'),
  handler(async (req, res) => {
    const rows = await library.listFines({ status: str(req.query.status, { max: 12 }) });
    const out = [];
    for (const row of rows) {
      const student = row.studentId ? await students.get(row.studentId) : null;
      const member = row.staffId ? await staff.get(row.staffId) : null;
      out.push({ ...row, borrower: student?.fullName || member?.name || 'Unknown' });
    }
    return ok(res, { rows: out });
  })
);

router.post(
  '/library/fines/:id/settle',
  need('library.fine'),
  handler(async (req, res) => {
    const input = body(req);
    const waive = bool(input.waive);
    const result = await library.settleFine(
      req.params.id,
      { waive, reason: str(input.reason, { max: 200 }) },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: waive ? audit.ACTIONS.FINE_WAIVED : audit.ACTIONS.BOOK_RETURNED,
      entityType: 'fine',
      entityId: req.params.id,
      after: { status: result.after.status, amount: result.after.amount },
      message: `${waive ? 'Waived' : 'Collected'} a library fine of ${result.after.amount}`,
    });
    return ok(res, result.after);
  })
);

router.get(
  '/library/reports/overdue',
  need('library.view'),
  handler(async (req, res) => ok(res, { rows: await library.overdueList() }))
);

router.get(
  '/library/reports/stock',
  need('library.view'),
  handler(async (req, res) => ok(res, { rows: await library.stockReport() }))
);

router.get(
  '/library/export/:report',
  need('report.export'),
  handler(async (req, res) => {
    const meta = await exportMeta(req);
    const specs = {
      overdue: async () => ({
        title: 'Overdue books',
        columns: [
          { key: 'accessionNo', label: 'Accession', width: 14 },
          { key: 'title', label: 'Title', width: 34 },
          { key: 'borrower', label: 'Borrower', width: 24 },
          { key: 'contact', label: 'Contact', width: 14 },
          { key: 'issuedAt', label: 'Issued', width: 14 },
          { key: 'dueDate', label: 'Due', width: 14 },
          { key: 'daysOverdue', label: 'Days overdue', type: 'num' },
          { key: 'estimatedFine', label: 'Fine', type: 'money' },
        ],
        rows: await library.overdueList(),
      }),
      stock: async () => ({
        title: 'Library stock',
        columns: [
          { key: 'title', label: 'Title', width: 34 },
          { key: 'author', label: 'Author', width: 24 },
          { key: 'category', label: 'Category', width: 18 },
          { key: 'total', label: 'Copies', type: 'num' },
          { key: 'available', label: 'Available', type: 'num' },
          { key: 'issued', label: 'Issued', type: 'num' },
          { key: 'lost', label: 'Lost', type: 'num' },
          { key: 'damaged', label: 'Damaged', type: 'num' },
        ],
        rows: await library.stockReport(),
      }),
    };
    const build = specs[req.params.report];
    if (!build) throw errors.notFound('That report does not exist.');
    const spec = await build();
    const buffer = await exporter.buildSingleSheet({ ...spec, meta });
    await auditExport(req, spec.title, spec.rows.length);
    return sendXlsx(res, buffer, exporter.fileName(spec.title));
  })
);

/* ==========================================================================
 * Transport
 * ====================================================================== */

router.get(
  '/transport/routes',
  need('transport.view'),
  handler(async (req, res) => {
    const routes = await transport.listRoutes({ includeInactive: bool(req.query.includeInactive) });
    const vehicles = await transport.listVehicles({ includeInactive: true });
    const drivers = await transport.listDrivers({ includeInactive: true });
    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
    const driverById = new Map(drivers.map((d) => [d.id, d]));
    const year = await academics.currentYear();
    const assignments = year
      ? await transport.listAssignments({ academicYearId: year.id })
      : [];
    const counts = new Map();
    for (const assignment of assignments) {
      counts.set(assignment.routeId, (counts.get(assignment.routeId) || 0) + 1);
    }

    return ok(res, {
      rows: routes.map((route) => ({
        ...route,
        vehicleRegNo: vehicleById.get(route.vehicleId)?.regNo || '',
        capacity: vehicleById.get(route.vehicleId)?.capacity || null,
        driverName: driverById.get(route.driverId)?.name || '',
        assigned: counts.get(route.id) || 0,
      })),
      vehicles,
      drivers,
      alerts: await transport.expiryAlerts(),
    });
  })
);

router.post(
  '/transport/routes',
  need('transport.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await transport.createRoute(
      {
        name: str(input.name, { max: 60 }),
        code: str(input.code, { max: 20 }),
        description: str(input.description, { max: 200 }),
        driverId: str(input.driverId, { max: 40 }),
        vehicleId: str(input.vehicleId, { max: 40 }),
        fare: num(input.fare, { min: 0 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/transport/routes/:id',
  need('transport.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await transport.updateRoute(
      req.params.id,
      {
        name: str(input.name, { max: 60 }),
        code: str(input.code, { max: 20 }),
        description: str(input.description, { max: 200 }),
        driverId: str(input.driverId, { max: 40 }),
        vehicleId: str(input.vehicleId, { max: 40 }),
        fare: num(input.fare, { min: 0 }),
        status: str(input.status, { max: 10 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

router.get(
  '/transport/routes/:id/stops',
  need('transport.view'),
  handler(async (req, res) => ok(res, { rows: await transport.listStops(req.params.id) }))
);

router.put(
  '/transport/routes/:id/stops',
  need('transport.manage'),
  handler(async (req, res) => {
    const input = body(req);
    if (!Array.isArray(input.stops)) throw errors.badRequest('Send the list of stops in order.');
    const rows = await transport.setStops(
      req.params.id,
      input.stops.map((stop) => ({
        id: str(stop.id, { max: 40 }),
        name: str(stop.name, { max: 80 }),
        arrivalTime: str(stop.arrivalTime, { max: 5 }),
        departureTime: str(stop.departureTime, { max: 5 }),
        landmark: str(stop.landmark, { max: 120 }),
        fare: num(stop.fare, { min: 0 }),
      })),
      ctxOf(req)
    );
    return ok(res, rows);
  })
);

router.get(
  '/transport/routes/:id/list',
  need('transport.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    return ok(res, await transport.routeList(req.params.id, year.id));
  })
);

router.post(
  '/transport/vehicles',
  need('transport.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await transport.createVehicle(
      {
        regNo: str(input.regNo, { max: 20 }),
        model: str(input.model, { max: 60 }),
        capacity: num(input.capacity, { min: 1, max: 100 }),
        insuranceExpiry: isoDate(input.insuranceExpiry),
        fitnessExpiry: isoDate(input.fitnessExpiry),
        pucExpiry: isoDate(input.pucExpiry),
        permitExpiry: isoDate(input.permitExpiry),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/transport/vehicles/:id',
  need('transport.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await transport.updateVehicle(
      req.params.id,
      {
        regNo: str(input.regNo, { max: 20 }),
        model: str(input.model, { max: 60 }),
        capacity: num(input.capacity, { min: 1, max: 100 }),
        insuranceExpiry: isoDate(input.insuranceExpiry),
        fitnessExpiry: isoDate(input.fitnessExpiry),
        pucExpiry: isoDate(input.pucExpiry),
        permitExpiry: isoDate(input.permitExpiry),
        status: str(input.status, { max: 10 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

router.post(
  '/transport/drivers',
  need('transport.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await transport.createDriver(
      {
        name: str(input.name, { max: 80 }),
        phone: str(input.phone, { max: 15 }),
        licenceNo: str(input.licenceNo, { max: 30 }),
        licenceExpiry: isoDate(input.licenceExpiry),
        address: str(input.address, { max: 200 }),
        bloodGroup: str(input.bloodGroup, { max: 5 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/transport/drivers/:id',
  need('transport.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await transport.updateDriver(
      req.params.id,
      {
        name: str(input.name, { max: 80 }),
        phone: str(input.phone, { max: 15 }),
        licenceNo: str(input.licenceNo, { max: 30 }),
        licenceExpiry: isoDate(input.licenceExpiry),
        address: str(input.address, { max: 200 }),
        status: str(input.status, { max: 10 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

router.get(
  '/transport/assignments',
  need('transport.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const rows = await transport.listAssignments({
      academicYearId: year.id,
      routeId: str(req.query.routeId, { max: 40 }),
      studentId: str(req.query.studentId, { max: 40 }),
    });
    const out = [];
    for (const row of rows) {
      const student = await students.get(row.studentId);
      out.push({
        ...row,
        studentName: student?.fullName || 'Unknown',
        admissionNo: student?.admissionNo || '',
      });
    }
    return ok(res, { rows: out, directions: transport.DIRECTIONS });
  })
);

router.post(
  '/transport/assignments',
  need('transport.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const row = await transport.assign(
      {
        studentId: str(input.studentId, { max: 40 }),
        academicYearId: year.id,
        routeId: str(input.routeId, { max: 40 }),
        stopId: str(input.stopId, { max: 40 }),
        direction: str(input.direction, { max: 10 }),
        fromDate: isoDate(input.fromDate),
        fare: num(input.fare, { min: 0 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.post(
  '/transport/assignments/:id/end',
  need('transport.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await transport.unassign(
      req.params.id,
      { toDate: isoDate(input.toDate) },
      ctxOf(req)
    );
    return ok(res, result.after);
  })
);

router.get(
  '/transport/export/route/:id',
  need('report.export'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const report = await transport.routeList(req.params.id, year.id);
    const buffer = await exporter.buildSingleSheet({
      title: `Route list — ${report.route.name}`,
      subtitle: [
        report.vehicle ? `Vehicle ${report.vehicle.regNo}` : null,
        report.driver ? `Driver ${report.driver.name} (${report.driver.phone || 'no phone'})` : null,
        `${report.total} students`,
      ]
        .filter(Boolean)
        .join(' • '),
      columns: [
        { key: 'stopSequence', label: 'Stop #', type: 'num' },
        { key: 'stopName', label: 'Stop', width: 22 },
        { key: 'arrivalTime', label: 'Time', width: 10 },
        { key: 'admissionNo', label: 'Admission No', width: 16 },
        { key: 'name', label: 'Student', width: 26 },
        { key: 'className', label: 'Class', width: 12 },
        { key: 'sectionName', label: 'Section', width: 10 },
        { key: 'guardianName', label: 'Guardian', width: 22 },
        { key: 'guardianPhone', label: 'Phone', width: 14 },
      ],
      rows: report.rows,
      meta: await exportMeta(req),
    });
    await auditExport(req, `Route list ${report.route.name}`, report.rows.length);
    return sendXlsx(res, buffer, exporter.fileName(`route-${report.route.name}`));
  })
);

/* ==========================================================================
 * Notices
 * ====================================================================== */

/** Every signed-in user sees their own notices; no permission needed to read. */
router.get(
  '/notices/mine',
  handler(async (req, res) => {
    const year = await academics.currentYear();
    let classIds = [];
    if (year && permissions.SECTION_SCOPED_ROLES.has(req.user.roleKey)) {
      const assignments = await academics.listAssignments({
        academicYearId: year.id,
        teacherUserId: req.user.id,
      });
      classIds = [...new Set(assignments.map((a) => a.classId))];
    } else if (year) {
      classIds = (await academics.listClasses()).map((c) => c.id);
    }
    return ok(res, { rows: await notices.forUser(req.user, { classIds }) });
  })
);

router.post(
  '/notices/:id/read',
  handler(async (req, res) => {
    await notices.markRead(req.params.id, req.user.id, ctxOf(req));
    return ok(res, { read: true });
  })
);

router.get(
  '/notices',
  need('notice.view'),
  handler(async (req, res) =>
    ok(res, {
      rows: await notices.list({ status: str(req.query.status, { max: 12 }) }),
      audiences: notices.AUDIENCES,
      priorities: notices.PRIORITIES,
      roles: await permissions.listRoles(),
      classes: await academics.listClasses(),
    })
  )
);

router.get(
  '/notices/:id',
  need('notice.view'),
  handler(async (req, res) =>
    ok(res, {
      notice: await notices.get(req.params.id),
      reads: await notices.readStats(req.params.id),
    })
  )
);

router.post(
  '/notices',
  need('notice.create'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await notices.create(pickNotice(input), ctxOf(req));
    return ok(res, row);
  })
);

router.put(
  '/notices/:id',
  need('notice.create'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await notices.update(req.params.id, pickNotice(input), ctxOf(req), {
      expectedRev: input._rev,
    });
    return ok(res, result.after);
  })
);

router.post(
  '/notices/:id/publish',
  need('notice.publish'),
  handler(async (req, res) => {
    const result = await notices.publish(req.params.id, ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.NOTICE_PUBLISHED,
      entityType: 'notice',
      entityId: req.params.id,
      after: { title: result.after.title, audience: result.after.audience },
      message: `Published notice "${result.after.title}"`,
    });
    return ok(res, result.after);
  })
);

router.post(
  '/notices/:id/archive',
  need('notice.publish'),
  handler(async (req, res) => {
    const result = await notices.archive(req.params.id, ctxOf(req));
    return ok(res, result.after);
  })
);

function pickNotice(input) {
  return {
    title: str(input.title, { max: 150 }),
    body: str(input.body, { max: 5000 }),
    audience: str(input.audience, { max: 10 }),
    targetRoles: Array.isArray(input.targetRoles) ? input.targetRoles.map(String) : [],
    targetClassIds: Array.isArray(input.targetClassIds) ? input.targetClassIds.map(String) : [],
    publishFrom: isoDate(input.publishFrom),
    publishTo: isoDate(input.publishTo),
    priority: str(input.priority, { max: 12 }),
  };
}

/* ==========================================================================
 * Staff and HR
 * ====================================================================== */

router.get(
  '/staff',
  need('staff.view'),
  handler(async (req, res) => {
    const page = pagination(req.query);
    const result = await staff.list({
      ...page,
      where: req.query.status ? (row) => row.status === req.query.status : null,
    });
    return ok(res, result);
  })
);

router.get(
  '/staff/:id',
  need('staff.view'),
  handler(async (req, res) => {
    const year = await academics.currentYear();
    const member = await staff.get(req.params.id);
    if (!member) throw errors.notFound('That staff member could not be found.');
    return ok(res, {
      staff: member,
      documents: await staff.documentsFor(req.params.id),
      salary: await staff.salaryStructure(req.params.id),
      leaveBalances: year ? await staff.leaveBalances(year.name, req.params.id) : [],
      docTypes: files.DOC_TYPES,
    });
  })
);

router.post(
  '/staff',
  need('staff.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await staff.create(pickStaff(input), ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.STAFF_CREATED,
      entityType: 'staff',
      entityId: row.id,
      after: { staffCode: row.staffCode, name: row.name, designation: row.designation },
      message: `Added staff member ${row.name} (${row.staffCode})`,
    });
    return ok(res, row);
  })
);

router.put(
  '/staff/:id',
  need('staff.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await staff.update(req.params.id, pickStaff(input), ctxOf(req), {
      expectedRev: input._rev,
    });
    await audit.fromRequest(req, {
      action: audit.ACTIONS.STAFF_UPDATED,
      entityType: 'staff',
      entityId: req.params.id,
      before: result.before,
      after: result.after,
      message: `Updated ${result.after.name}`,
    });
    return ok(res, result.after);
  })
);

router.post(
  '/staff/:id/status',
  need('staff.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await staff.setStatus(
      req.params.id,
      str(input.status, { max: 10 }),
      { leavingDate: isoDate(input.leavingDate) },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.STAFF_UPDATED,
      entityType: 'staff',
      entityId: req.params.id,
      before: { status: result.before.status },
      after: { status: result.after.status },
      message: `${result.after.name} marked ${result.after.status}`,
    });
    return ok(res, result.after);
  })
);

router.post(
  '/staff/:id/documents',
  need('document.upload'),
  files.uploader({ kind: 'staff' }).single('file'),
  handler(async (req, res) => {
    if (!req.file) throw errors.badRequest('Choose a file to upload.');
    await files.enforceSizeCap(req.file);
    const meta = files.describe(req.file, 'staff');
    const row = await staff.addDocument(
      req.params.id,
      { ...meta, docType: str(req.body.docType, { max: 40 }), title: str(req.body.title, { max: 120 }) },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.DOCUMENT_UPLOADED,
      entityType: 'staffDocument',
      entityId: row.id,
      message: `Uploaded ${row.docType} for a staff member`,
    });
    return ok(res, row);
  })
);

router.get(
  '/staff/documents/:id/download',
  need('document.download'),
  handler(async (req, res) => {
    const doc = await staff.getDocument(req.params.id);
    if (!doc) throw errors.notFound('That document could not be found.');
    const filePath = files.resolveStored('staff', doc.storedName);
    await audit.fromRequest(req, {
      action: audit.ACTIONS.DOCUMENT_DOWNLOADED,
      entityType: 'staffDocument',
      entityId: doc.id,
      message: `Downloaded ${doc.docType} (${doc.originalName})`,
    });
    res.setHeader('Content-Type', files.contentTypeFor(doc.storedName));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(doc.originalName).replace(/[^a-zA-Z0-9._-]/g, '_')}"`
    );
    return fs.createReadStream(filePath).pipe(res);
  })
);

router.put(
  '/staff/:id/salary',
  need('payroll.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await staff.setSalaryStructure(
      req.params.id,
      {
        effectiveFrom: isoDate(input.effectiveFrom),
        basic: num(input.basic, { min: 0 }),
        hra: num(input.hra, { min: 0 }),
        da: num(input.da, { min: 0 }),
        allowances: num(input.allowances, { min: 0 }),
        pf: num(input.pf, { min: 0 }),
        professionalTax: num(input.professionalTax, { min: 0 }),
        incomeTax: num(input.incomeTax, { min: 0 }),
        otherDeductions: num(input.otherDeductions, { min: 0 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.get(
  '/payroll/payslips',
  need('payroll.view'),
  handler(async (req, res) => {
    const rows = await staff.listPayslips({
      month: str(req.query.month, { max: 7 }),
      staffId: str(req.query.staffId, { max: 40 }),
    });
    const all = await staff.list({ pageSize: 0 });
    const byId = new Map(all.rows.map((s) => [s.id, s]));
    return ok(res, {
      rows: rows.map((row) => ({
        ...row,
        staffName: byId.get(row.staffId)?.name || 'Unknown',
        staffCode: byId.get(row.staffId)?.staffCode || '',
      })),
    });
  })
);

router.post(
  '/payroll/generate',
  need('payroll.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const month = str(input.month, { max: 7 });
    if (!/^\d{4}-\d{2}$/.test(String(month))) {
      throw errors.badRequest('Choose the month as YYYY-MM.');
    }
    const created = await staff.generatePayslips(year.name, month, ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.STAFF_UPDATED,
      entityType: 'payroll',
      entityId: month,
      after: { generated: created.length },
      message: `Generated ${created.length} payslips for ${month}`,
    });
    return ok(res, { generated: created.length });
  })
);

function pickStaff(input) {
  return {
    name: str(input.name, { max: 80 }),
    designation: str(input.designation, { max: 60 }),
    department: str(input.department, { max: 60 }),
    qualification: str(input.qualification, { max: 120 }),
    phone: str(input.phone, { max: 15 }),
    email: str(input.email, { max: 120 }),
    dob: isoDate(input.dob),
    gender: str(input.gender, { max: 10 }),
    bloodGroup: str(input.bloodGroup, { max: 5 }),
    joiningDate: isoDate(input.joiningDate),
    address: str(input.address, { max: 300 }),
    aadhaar: str(input.aadhaar, { max: 14 }),
    panNo: str(input.panNo, { max: 12 }),
    bankAccount: str(input.bankAccount, { max: 30 }),
    ifsc: str(input.ifsc, { max: 15 }),
    employmentType: str(input.employmentType, { max: 30 }),
    userId: str(input.userId, { max: 40 }),
  };
}

module.exports = { router };
