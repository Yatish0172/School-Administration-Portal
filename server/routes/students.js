'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const { ok, handler, body, str, num, isoDate, pagination } = require('../http');
const { need, needAny, studentView, trimStudent } = require('../middleware/permission');
const students = require('../store/students');
const academics = require('../store/academics');
const enquiries = require('../store/enquiries');
const imports = require('../store/imports');
const exporter = require('../store/exporter');
const settings = require('../store/settings');
const audit = require('../store/audit');
const files = require('../services/files');
const { sendXlsx } = require('./system');
const errors = require('../errors');
const { paths } = require('../paths');

const router = express.Router();
const ctxOf = (req) => ({ userId: req.user.id, name: req.user.name });

/* ----------------------------------------------------------------- students */

router.get(
  '/students',
  needAny('student.view', 'student.lookup'),
  handler(async (req, res) => {
    const page = pagination(req.query);
    const view = studentView(req.user);
    const result = await students.list({
      ...page,
      status: str(req.query.status, { max: 20 }),
      classId: str(req.query.classId, { max: 40 }),
      sectionId: str(req.query.sectionId, { max: 40 }),
      academicYearId: str(req.query.academicYearId, { max: 40 }),
    });

    // Library and Transport see name and class only (SPEC §4 limits).
    return ok(res, {
      ...result,
      view,
      rows: result.rows.map((row) => trimStudent(row, view, req.user.roleKey)),
      statuses: students.STATUSES,
    });
  })
);

router.get(
  '/students/:id',
  needAny('student.view', 'student.lookup'),
  handler(async (req, res) => {
    const view = studentView(req.user);
    if (view === 'lookup') {
      const student = await students.getOrFail(req.params.id);
      return ok(res, { student: trimStudent(student, view, req.user.roleKey), view });
    }
    const profile = await students.profile(req.params.id);
    const year = await academics.currentYear();
    const sections = year ? await academics.listSections({ academicYearId: year.id }) : [];
    const classes = await academics.listClasses();
    const sectionById = new Map(sections.map((s) => [s.id, s]));
    const classById = new Map(classes.map((c) => [c.id, c]));

    return ok(res, {
      ...profile,
      view,
      enrollments: profile.enrollments.map((row) => ({
        ...row,
        className: classById.get(row.classId)?.name || '',
        sectionName: sectionById.get(row.sectionId)?.name || '',
      })),
    });
  })
);

/** Admission: student + guardians + enrollment in one transaction. */
router.post(
  '/students',
  need('student.create'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await students.admit(
      {
        student: pickStudent(input.student || {}),
        guardians: (input.guardians || []).map(pickGuardian),
        enrollment: input.enrollment
          ? {
              academicYearId: str(input.enrollment.academicYearId, { max: 40 }),
              classId: str(input.enrollment.classId, { max: 40 }),
              sectionId: str(input.enrollment.sectionId, { max: 40 }),
              rollNo: str(input.enrollment.rollNo, { max: 10 }),
            }
          : null,
      },
      ctxOf(req)
    );

    await audit.fromRequest(req, {
      action: audit.ACTIONS.STUDENT_CREATED,
      entityType: 'student',
      entityId: result.student.id,
      after: { admissionNo: result.student.admissionNo, name: result.student.fullName },
      message: `Admitted ${result.student.fullName} (${result.student.admissionNo})`,
    });
    return ok(res, result);
  })
);

router.put(
  '/students/:id',
  need('student.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await students.update(
      req.params.id,
      pickStudent(input),
      ctxOf(req),
      { expectedRev: input._rev }
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.STUDENT_UPDATED,
      entityType: 'student',
      entityId: req.params.id,
      before: result.before,
      after: result.after,
      message: `Updated ${result.after.fullName}`,
    });
    return ok(res, result.after);
  })
);

router.put(
  '/students/:id/guardians',
  need('student.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await students.replaceGuardians(
      req.params.id,
      (input.guardians || []).map(pickGuardian),
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.STUDENT_UPDATED,
      entityType: 'student',
      entityId: req.params.id,
      before: result.before,
      after: result.after,
      message: 'Updated guardian details',
    });
    return ok(res, result.after);
  })
);

/** Status change, never deletion (CLAUDE.md data safety rules). */
router.post(
  '/students/:id/status',
  need('student.status'),
  handler(async (req, res) => {
    const input = body(req);
    const status = str(input.status, { max: 20 });
    const result = await students.setStatus(
      req.params.id,
      status,
      { reason: str(input.reason, { max: 300 }), date: isoDate(input.date) },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.STUDENT_STATUS_CHANGED,
      entityType: 'student',
      entityId: req.params.id,
      before: { status: result.before.status },
      after: { status: result.after.status },
      message: `${result.after.fullName} marked ${status}${input.reason ? `: ${input.reason}` : ''}`,
    });
    return ok(res, result.after);
  })
);

router.post(
  '/students/:id/transfer-certificate',
  need('student.tc'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await students.issueTransferCertificate(
      req.params.id,
      { reason: str(input.reason, { max: 300 }), date: isoDate(input.date) },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.TC_ISSUED,
      entityType: 'student',
      entityId: req.params.id,
      after: { tcNumber: result.tcNumber },
      message: `Issued transfer certificate ${result.tcNumber} to ${result.after.fullName}`,
    });
    return ok(res, result);
  })
);

/** Data for a printable TC. The layout itself is rendered and printed client-side. */
router.get(
  '/students/:id/transfer-certificate',
  need('student.tc'),
  handler(async (req, res) => {
    const profile = await students.profile(req.params.id);
    const year = await academics.currentYear();
    const classes = await academics.listClasses();
    const classById = new Map(classes.map((c) => [c.id, c]));
    const sections = year ? await academics.listSections({ academicYearId: year.id }) : [];
    const sectionById = new Map(sections.map((s) => [s.id, s]));
    const latest = profile.enrollments[0] || null;

    return ok(res, {
      student: profile.student,
      guardians: profile.guardians,
      className: latest ? classById.get(latest.classId)?.name || '' : '',
      sectionName: latest ? sectionById.get(latest.sectionId)?.name || '' : '',
      school: await schoolHeader(),
      generatedBy: req.user.name,
      generatedAt: new Date().toISOString(),
    });
  })
);

/** ID card data: photo, name, class, guardian phone and a QR payload. */
router.get(
  '/students/:id/id-card',
  need('student.idcard'),
  handler(async (req, res) => {
    const profile = await students.profile(req.params.id);
    const year = await academics.currentYear();
    const enrollment = profile.currentEnrollment;
    const classes = await academics.listClasses();
    const sections = year ? await academics.listSections({ academicYearId: year.id }) : [];
    const guardian = profile.guardians.find((g) => g.isPrimary) || profile.guardians[0] || null;

    return ok(res, {
      student: profile.student,
      className: enrollment
        ? classes.find((c) => c.id === enrollment.classId)?.name || ''
        : '',
      sectionName: enrollment
        ? sections.find((s) => s.id === enrollment.sectionId)?.name || ''
        : '',
      rollNo: enrollment?.rollNo || '',
      guardianName: guardian?.name || '',
      guardianPhone: guardian?.phone || '',
      academicYear: year?.name || '',
      qrPayload: JSON.stringify({
        adm: profile.student.admissionNo,
        n: profile.student.fullName,
        y: year?.name || '',
      }),
      school: await schoolHeader(),
    });
  })
);

/** Bulk ID card data for a whole section — one print run per class. */
router.get(
  '/students/id-cards/print',
  need('student.idcard'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const sectionId = str(req.query.sectionId, { max: 40 });
    if (!sectionId) throw errors.badRequest('Choose a section.');

    const enrollments = await academics.listEnrollments({ academicYearId: year.id, sectionId });
    const classes = await academics.listClasses();
    const sections = await academics.listSections({ academicYearId: year.id });
    const section = sections.find((s) => s.id === sectionId);
    const className = classes.find((c) => c.id === section?.classId)?.name || '';

    const rows = [];
    for (const enrollment of enrollments) {
      const student = await students.get(enrollment.studentId);
      if (!student || student.status !== 'Active') continue;
      const guardian = await students.primaryGuardian(enrollment.studentId);
      rows.push({
        student,
        rollNo: enrollment.rollNo,
        className,
        sectionName: section?.name || '',
        guardianName: guardian?.name || '',
        guardianPhone: guardian?.phone || '',
        qrPayload: JSON.stringify({ adm: student.admissionNo, n: student.fullName, y: year.name }),
      });
    }

    return ok(res, {
      rows,
      academicYear: year.name,
      school: await schoolHeader(),
      generatedBy: req.user.name,
      generatedAt: new Date().toISOString(),
    });
  })
);

router.get(
  '/students/export/list',
  need('report.export'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const result = await students.list({
      pageSize: 0,
      status: str(req.query.status, { max: 20 }),
      classId: str(req.query.classId, { max: 40 }),
      sectionId: str(req.query.sectionId, { max: 40 }),
      academicYearId: year.id,
      search: str(req.query.search, { max: 100 }) || '',
    });

    const classes = await academics.listClasses();
    const sections = await academics.listSections({ academicYearId: year.id });
    const classById = new Map(classes.map((c) => [c.id, c]));
    const sectionById = new Map(sections.map((s) => [s.id, s]));

    const rows = [];
    for (const student of result.rows) {
      const enrollment = await academics.enrollmentFor(student.id, year.id);
      const guardian = await students.primaryGuardian(student.id);
      rows.push({
        admissionNo: student.admissionNo,
        fullName: student.fullName,
        className: enrollment ? classById.get(enrollment.classId)?.name || '' : '',
        sectionName: enrollment ? sectionById.get(enrollment.sectionId)?.name || '' : '',
        rollNo: enrollment?.rollNo || '',
        dob: student.dob,
        gender: student.gender,
        category: student.category,
        status: student.status,
        guardianName: guardian?.name || '',
        guardianPhone: guardian?.phone || '',
        city: student.city,
      });
    }

    const buffer = await exporter.buildSingleSheet({
      title: 'Student list',
      subtitle: `Academic year ${year.name}`,
      columns: [
        { key: 'admissionNo', label: 'Admission No', width: 16 },
        { key: 'fullName', label: 'Name', width: 28 },
        { key: 'className', label: 'Class', width: 14 },
        { key: 'sectionName', label: 'Section', width: 10 },
        { key: 'rollNo', label: 'Roll No', width: 10 },
        { key: 'dob', label: 'Date of Birth', width: 14 },
        { key: 'gender', label: 'Gender', width: 10 },
        { key: 'category', label: 'Category', width: 12 },
        { key: 'status', label: 'Status', width: 12 },
        { key: 'guardianName', label: 'Guardian', width: 24 },
        { key: 'guardianPhone', label: 'Phone', width: 14 },
        { key: 'city', label: 'City', width: 16 },
      ],
      rows,
      meta: await exportMeta(req),
    });
    await auditExport(req, 'Student list', rows.length);
    return sendXlsx(res, buffer, exporter.fileName('students'));
  })
);

/** Parent contact CSV for an external bulk SMS tool (T40). No sending from here. */
router.get(
  '/students/export/contacts',
  need('report.export'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const result = await students.list({
      pageSize: 0,
      status: 'Active',
      classId: str(req.query.classId, { max: 40 }),
      sectionId: str(req.query.sectionId, { max: 40 }),
      academicYearId: year.id,
    });
    const classes = await academics.listClasses();
    const classById = new Map(classes.map((c) => [c.id, c]));

    const rows = [];
    for (const student of result.rows) {
      const guardians = await students.guardiansFor(student.id);
      const enrollment = await academics.enrollmentFor(student.id, year.id);
      for (const guardian of guardians) {
        if (!guardian.phone) continue;
        rows.push({
          phone: String(guardian.phone).replace(/\s/g, ''),
          guardianName: guardian.name,
          relation: guardian.relation,
          studentName: student.fullName,
          admissionNo: student.admissionNo,
          className: enrollment ? classById.get(enrollment.classId)?.name || '' : '',
        });
      }
    }

    const csv = exporter.buildCsv(
      [
        { key: 'phone', label: 'Phone' },
        { key: 'guardianName', label: 'Guardian' },
        { key: 'relation', label: 'Relation' },
        { key: 'studentName', label: 'Student' },
        { key: 'admissionNo', label: 'Admission No' },
        { key: 'className', label: 'Class' },
      ],
      rows
    );

    await auditExport(req, 'Parent contact list', rows.length);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exporter.fileName('parent-contacts', 'csv')}"`
    );
    return res.send(csv);
  })
);

/* ---------------------------------------------------------------- documents */

router.get(
  '/students/:id/documents',
  need('document.view'),
  handler(async (req, res) =>
    ok(res, {
      rows: await students.documentsFor(req.params.id),
      docTypes: files.DOC_TYPES,
      maxSizeMb: await settings.get('uploads.maxSizeMb', 5),
    })
  )
);

router.post(
  '/students/:id/documents',
  need('document.upload'),
  files.uploader({ kind: 'student' }).single('file'),
  handler(async (req, res) => {
    if (!req.file) throw errors.badRequest('Choose a file to upload.');
    await files.enforceSizeCap(req.file);
    const meta = files.describe(req.file, 'student');
    const row = await students.addDocument(
      req.params.id,
      { ...meta, docType: str(req.body.docType, { max: 40 }), title: str(req.body.title, { max: 120 }) },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.DOCUMENT_UPLOADED,
      entityType: 'studentDocument',
      entityId: row.id,
      after: { docType: row.docType, originalName: row.originalName, sizeBytes: row.sizeBytes },
      message: `Uploaded ${row.docType} for a student`,
    });
    return ok(res, row);
  })
);

/**
 * The only way a document leaves the server. File paths are never exposed and the
 * folder is never served statically (SPEC §17).
 */
router.get(
  '/documents/:id/download',
  need('document.download'),
  handler(async (req, res) => {
    const doc = await students.getDocument(req.params.id);
    if (!doc) throw errors.notFound('That document could not be found.');
    const filePath = files.resolveStored('student', doc.storedName);

    await audit.fromRequest(req, {
      action: audit.ACTIONS.DOCUMENT_DOWNLOADED,
      entityType: 'studentDocument',
      entityId: doc.id,
      message: `Downloaded ${doc.docType} (${doc.originalName})`,
    });

    res.setHeader('Content-Type', files.contentTypeFor(doc.storedName));
    res.setHeader(
      'Content-Disposition',
      `${req.query.inline ? 'inline' : 'attachment'}; filename="${sanitiseFilename(doc.originalName)}"`
    );
    return fs.createReadStream(filePath).pipe(res);
  })
);

/** Student photo, served through the same authorising path as documents. */
router.post(
  '/students/:id/photo',
  need('student.edit'),
  files.uploader({ kind: 'photo', imagesOnly: true }).single('file'),
  handler(async (req, res) => {
    if (!req.file) throw errors.badRequest('Choose an image to upload.');
    await files.enforceSizeCap(req.file);
    const meta = files.describe(req.file, 'photo');
    const student = await students.getOrFail(req.params.id);
    if (student.photoFile) await files.remove('photo', student.photoFile);
    const result = await students.update(
      req.params.id,
      { photoFile: meta.storedName },
      ctxOf(req)
    );
    return ok(res, { photoFile: result.after.photoFile });
  })
);

router.get(
  '/students/:id/photo',
  needAny('student.view', 'student.lookup'),
  handler(async (req, res) => {
    const student = await students.getOrFail(req.params.id);
    if (!student.photoFile) throw errors.notFound('No photo has been uploaded for this student.');
    const filePath = files.resolveStored('photo', student.photoFile);
    res.setHeader('Content-Type', files.contentTypeFor(student.photoFile));
    res.setHeader('Cache-Control', 'private, max-age=300');
    return fs.createReadStream(filePath).pipe(res);
  })
);

/* ------------------------------------------------------------------ imports */

router.get(
  '/imports/template',
  need('student.import'),
  handler(async (req, res) => {
    const buffer = await imports.template();
    return sendXlsx(res, buffer, `student-import-template-${imports.TEMPLATE_VERSION}.xlsx`);
  })
);

router.get(
  '/imports',
  need('student.import'),
  handler(async (req, res) => ok(res, { rows: await imports.listBatches() }))
);

router.get(
  '/imports/:id',
  need('student.import'),
  handler(async (req, res) =>
    ok(res, {
      batch: await imports.getBatch(req.params.id),
      errors: await imports.batchErrors(req.params.id),
    })
  )
);

/** Upload and validate. Nothing is written to the student data at this point. */
router.post(
  '/imports/validate',
  need('student.import'),
  files.uploader({ kind: 'import' }).single('file'),
  handler(async (req, res) => {
    if (!req.file) throw errors.badRequest('Choose the filled-in template to upload.');
    await files.enforceSizeCap(req.file);
    const result = await imports.validateUpload(
      {
        filePath: req.file.path,
        originalName: req.file.originalname,
        storedName: path.basename(req.file.path),
        academicYearId: str(req.body.academicYearId, { max: 40 }),
      },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.IMPORT_VALIDATED,
      entityType: 'importBatch',
      entityId: result.batch.id,
      after: {
        totalRows: result.totalRows,
        validRows: result.validRows,
        errorRows: result.errorRows,
      },
      message: `Validated ${req.file.originalname}: ${result.validRows} of ${result.totalRows} rows are ready`,
    });
    return ok(res, result);
  })
);

router.post(
  '/imports/:id/commit',
  need('student.import'),
  handler(async (req, res) => {
    const result = await imports.commit(req.params.id, ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.IMPORT_COMMITTED,
      entityType: 'importBatch',
      entityId: req.params.id,
      after: result,
      message: `Imported ${result.imported} students${
        result.failures.length ? `, ${result.failures.length} failed` : ''
      }`,
    });
    return ok(res, result);
  })
);

router.post(
  '/imports/:id/discard',
  need('student.import'),
  handler(async (req, res) => {
    await imports.discard(req.params.id, ctxOf(req));
    return ok(res, { discarded: true });
  })
);

/* ---------------------------------------------------------------- enquiries */

router.get(
  '/enquiries',
  need('enquiry.view'),
  handler(async (req, res) => {
    const page = pagination(req.query);
    const result = await enquiries.list({
      ...page,
      status: str(req.query.status, { max: 20 }),
      source: str(req.query.source, { max: 30 }),
      from: isoDate(req.query.from),
      to: isoDate(req.query.to),
    });
    return ok(res, {
      ...result,
      statuses: enquiries.STATUSES,
      sources: enquiries.SOURCES,
      due: await enquiries.dueFollowUps(),
    });
  })
);

router.get(
  '/enquiries/:id',
  need('enquiry.view'),
  handler(async (req, res) => ok(res, await enquiries.withFollowUps(req.params.id)))
);

router.post(
  '/enquiries',
  need('enquiry.create'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await enquiries.create(
      {
        childName: str(input.childName, { max: 80 }),
        dob: isoDate(input.dob),
        gender: str(input.gender, { max: 10 }),
        classSought: str(input.classSought, { max: 40 }),
        parentName: str(input.parentName, { max: 80 }),
        relation: str(input.relation, { max: 20 }),
        phone: str(input.phone, { max: 15 }),
        email: str(input.email, { max: 120 }),
        address: str(input.address, { max: 300 }),
        source: str(input.source, { max: 30 }),
        followUpDate: isoDate(input.followUpDate),
        notes: str(input.notes, { max: 500 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/enquiries/:id',
  need('enquiry.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await enquiries.update(
      req.params.id,
      {
        childName: str(input.childName, { max: 80 }),
        dob: isoDate(input.dob),
        gender: str(input.gender, { max: 10 }),
        classSought: str(input.classSought, { max: 40 }),
        parentName: str(input.parentName, { max: 80 }),
        phone: str(input.phone, { max: 15 }),
        email: str(input.email, { max: 120 }),
        address: str(input.address, { max: 300 }),
        source: str(input.source, { max: 30 }),
        status: str(input.status, { max: 20 }),
        followUpDate: isoDate(input.followUpDate),
        notes: str(input.notes, { max: 500 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

router.post(
  '/enquiries/:id/follow-ups',
  need('enquiry.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await enquiries.addFollowUp(
      req.params.id,
      {
        notes: str(input.notes, { max: 500 }),
        outcome: str(input.outcome, { max: 20 }),
        nextActionDate: isoDate(input.nextActionDate),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.post(
  '/enquiries/:id/convert',
  need('enquiry.convert'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await enquiries.convert(
      req.params.id,
      {
        student: pickStudent(input.student || {}),
        guardians: (input.guardians || []).map(pickGuardian),
        enrollment: {
          academicYearId: str(input.enrollment?.academicYearId, { max: 40 }),
          classId: str(input.enrollment?.classId, { max: 40 }),
          sectionId: str(input.enrollment?.sectionId, { max: 40 }),
          rollNo: str(input.enrollment?.rollNo, { max: 10 }),
        },
      },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.ENQUIRY_CONVERTED,
      entityType: 'enquiry',
      entityId: req.params.id,
      after: { studentId: result.student.id, admissionNo: result.student.admissionNo },
      message: `Converted an enquiry into admission ${result.student.admissionNo}`,
    });
    return ok(res, result);
  })
);

router.get(
  '/enquiries/waiting/list',
  need('enquiry.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    return ok(res, {
      rows: await enquiries.listWaiting({ academicYearId: year.id }),
      capacity: await enquiries.capacity(year.id),
    });
  })
);

router.post(
  '/enquiries/:id/waiting',
  need('enquiry.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const row = await enquiries.addToWaitingList(
      req.params.id,
      {
        academicYearId: year.id,
        classId: str(input.classId, { max: 40 }),
        sectionId: str(input.sectionId, { max: 40 }),
        notes: str(input.notes, { max: 200 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.get(
  '/enquiries/reports/funnel',
  need('enquiry.view'),
  handler(async (req, res) =>
    ok(res, await enquiries.funnel({ from: isoDate(req.query.from), to: isoDate(req.query.to) }))
  )
);

/* ----------------------------------------------------------------- helpers */

function pickStudent(input) {
  return {
    admissionNo: str(input.admissionNo, { max: 30 }),
    firstName: str(input.firstName, { max: 40 }),
    middleName: str(input.middleName, { max: 40 }),
    lastName: str(input.lastName, { max: 40 }),
    dob: isoDate(input.dob),
    gender: str(input.gender, { max: 10 }),
    bloodGroup: str(input.bloodGroup, { max: 5 }),
    category: str(input.category, { max: 30 }),
    religion: str(input.religion, { max: 30 }),
    nationality: str(input.nationality, { max: 30 }),
    motherTongue: str(input.motherTongue, { max: 30 }),
    admissionDate: isoDate(input.admissionDate),
    aadhaar: str(input.aadhaar, { max: 14 }),
    permanentAddress: str(input.permanentAddress, { max: 300 }),
    correspondenceAddress: str(input.correspondenceAddress, { max: 300 }),
    city: str(input.city, { max: 60 }),
    state: str(input.state, { max: 60 }),
    pincode: str(input.pincode, { max: 10 }),
    previousSchool: str(input.previousSchool, { max: 120 }),
    remarks: str(input.remarks, { max: 500 }),
  };
}

function pickGuardian(input) {
  return {
    relation: str(input.relation, { max: 20 }) || 'guardian',
    name: str(input.name, { max: 80 }),
    phone: str(input.phone, { max: 15 }),
    email: str(input.email, { max: 120 }),
    occupation: str(input.occupation, { max: 60 }),
    qualification: str(input.qualification, { max: 60 }),
    annualIncome: num(input.annualIncome, { min: 0 }),
    isPrimary: input.isPrimary === true || input.isPrimary === 'true',
  };
}

async function schoolHeader() {
  const all = await settings.all();
  return {
    name: all['school.name'],
    tagline: all['school.tagline'],
    addressLine1: all['school.addressLine1'],
    addressLine2: all['school.addressLine2'],
    city: all['school.city'],
    state: all['school.state'],
    pincode: all['school.pincode'],
    phone: all['school.phone'],
    email: all['school.email'],
    board: all['school.board'],
    affiliationNo: all['school.affiliationNo'],
    logoFile: all['school.logoFile'],
    principalName: all['school.principalName'],
  };
}

async function exportMeta(req) {
  return {
    schoolName: await settings.get('school.name'),
    generatedBy: req.user.name,
    generatedAt: new Date().toISOString(),
  };
}

async function auditExport(req, title, rowCount) {
  return audit.fromRequest(req, {
    action: audit.ACTIONS.EXPORT_GENERATED,
    entityType: 'export',
    entityId: title,
    message: `Exported "${title}" with ${rowCount} row(s)`,
  });
}

function sanitiseFilename(name) {
  return String(name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
}

module.exports = { router, schoolHeader, exportMeta, auditExport };
