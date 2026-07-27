'use strict';

const express = require('express');

const { ok, handler, body, str, num, bool, isoDate } = require('../http');
const { need, scope, assertSection } = require('../middleware/permission');
const exams = require('../store/exams');
const academics = require('../store/academics');
const students = require('../store/students');
const exporter = require('../store/exporter');
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

/* ------------------------------------------------------------------- exams */

router.get(
  '/exams',
  need('exam.view'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const rows = await exams.listExams(year.name, {
      classId: str(req.query.classId, { max: 40 }),
      status: str(req.query.status, { max: 12 }),
    });
    const classes = await academics.listClasses();
    const classById = new Map(classes.map((c) => [c.id, c]));
    return ok(res, {
      academicYearId: year.id,
      rows: rows.map((row) => ({ ...row, className: classById.get(row.classId)?.name || '' })),
      terms: exams.DEFAULT_TERMS,
      statuses: exams.STATUSES,
    });
  })
);

router.get(
  '/exams/:id',
  need('exam.view'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const exam = await exams.getExam(year.name, req.params.id);
    const examSubjects = await exams.listExamSubjects(year.name, req.params.id);
    const subjects = await academics.listSubjects({
      academicYearId: year.id,
      classId: exam.classId,
    });
    const subjectById = new Map(subjects.map((s) => [s.id, s]));
    const sections = await academics.listSections({
      academicYearId: year.id,
      classId: exam.classId,
    });

    return ok(res, {
      exam,
      sections,
      subjects,
      examSubjects: examSubjects.map((row) => ({
        ...row,
        subjectName: subjectById.get(row.subjectId)?.name || '',
      })),
      missing: exam.status === 'published' ? null : await exams.missingMarks(year.name, req.params.id),
    });
  })
);

router.post(
  '/exams',
  need('exam.setup'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const exam = await exams.createExam(
      year.name,
      {
        academicYearId: year.id,
        name: str(input.name, { max: 60 }),
        term: str(input.term, { max: 40 }),
        classId: str(input.classId, { max: 40 }),
        startDate: isoDate(input.startDate),
        endDate: isoDate(input.endDate),
        weightage: num(input.weightage, { min: 0, max: 100 }),
      },
      ctxOf(req)
    );
    return ok(res, exam);
  })
);

router.put(
  '/exams/:id',
  need('exam.setup'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const result = await exams.updateExam(
      year.name,
      req.params.id,
      {
        name: str(input.name, { max: 60 }),
        term: str(input.term, { max: 40 }),
        startDate: isoDate(input.startDate),
        endDate: isoDate(input.endDate),
        weightage: num(input.weightage, { min: 0, max: 100 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

router.put(
  '/exams/:id/subjects',
  need('exam.setup'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    if (!Array.isArray(input.subjects)) throw errors.badRequest('Send the date sheet rows.');
    const rows = await exams.setExamSubjects(
      year.name,
      req.params.id,
      input.subjects.map((subject) => ({
        subjectId: str(subject.subjectId, { max: 40 }),
        maxMarks: num(subject.maxMarks, { min: 1, max: 1000 }),
        passMarks: num(subject.passMarks, { min: 0, max: 1000 }),
        examDate: isoDate(subject.examDate),
        startTime: str(subject.startTime, { max: 5 }),
        endTime: str(subject.endTime, { max: 5 }),
        weightage: num(subject.weightage, { min: 0, max: 100 }),
      })),
      ctxOf(req)
    );
    return ok(res, rows);
  })
);

/* ------------------------------------------------------------------- marks */

router.get(
  '/marks/grid',
  need('marks.view'),
  scope({ anyPermission: 'marks.publish' }),
  handler(async (req, res) => {
    const year = req.scope.year;
    const sectionId = str(req.query.sectionId, { max: 40 });
    assertSection(req, sectionId);
    const grid = await exams.marksGrid(year.name, {
      examId: str(req.query.examId, { max: 40 }),
      examSubjectId: str(req.query.examSubjectId, { max: 40 }),
      sectionId,
      yearId: year.id,
    });
    return ok(res, grid);
  })
);

/** Incremental save: the grid posts as the teacher moves down the list. */
router.post(
  '/marks',
  need('marks.enter'),
  scope({ anyPermission: 'marks.publish' }),
  handler(async (req, res) => {
    const input = body(req);
    const year = req.scope.year;
    const sectionId = str(input.sectionId, { max: 40 });
    assertSection(req, sectionId);
    if (!Array.isArray(input.entries)) throw errors.badRequest('There is nothing to save.');

    const result = await exams.saveMarks(
      year.name,
      {
        examId: str(input.examId, { max: 40 }),
        examSubjectId: str(input.examSubjectId, { max: 40 }),
        sectionId,
        entries: input.entries.map((entry) => ({
          studentId: String(entry.studentId),
          enrollmentId: str(entry.enrollmentId, { max: 40 }),
          marksObtained:
            entry.marksObtained === '' || entry.marksObtained === null
              ? null
              : Number(entry.marksObtained),
          isAbsent: bool(entry.isAbsent),
          remarks: str(entry.remarks, { max: 200 }),
        })),
      },
      ctxOf(req)
    );

    if (result.created || result.updated) {
      await audit.fromRequest(req, {
        action: audit.ACTIONS.MARKS_ENTERED,
        entityType: 'marks',
        entityId: `${input.examSubjectId}|${sectionId}`,
        after: result,
        message: `Saved marks: ${result.created} new, ${result.updated} changed`,
      });
    }
    return ok(res, result);
  })
);

/* -------------------------------------------------------------- publication */

router.post(
  '/exams/:id/publish',
  need('marks.publish'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const result = await exams.publish(
      year.name,
      req.params.id,
      { force: bool(input.force) },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.MARKS_PUBLISHED,
      entityType: 'exam',
      entityId: req.params.id,
      before: { status: result.before.status },
      after: { status: 'published' },
      message: `Published results for ${result.after.name}${input.force ? ' (with blank marks)' : ''}`,
    });
    return ok(res, result.after);
  })
);

router.post(
  '/exams/:id/unpublish',
  need('marks.publish'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const reason = str(input.reason, { max: 300 });
    const result = await exams.unpublish(year.name, req.params.id, reason, ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.MARKS_UNPUBLISHED,
      entityType: 'exam',
      entityId: req.params.id,
      before: { status: 'published' },
      after: { status: 'marks' },
      message: `Reopened published results for ${result.after.name}: ${reason}`,
    });
    return ok(res, result.after);
  })
);

/* ------------------------------------------------------------- grade rules */

router.get(
  '/grades',
  need('exam.view'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    return ok(res, {
      rows: await exams.listGradeRules(year.name, str(req.query.classId, { max: 40 })),
      classes: await academics.listClasses(),
    });
  })
);

router.put(
  '/grades',
  need('grade.manage'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    if (!Array.isArray(input.rules)) throw errors.badRequest('Send the grade bands.');
    const rows = await exams.setGradeRules(
      year.name,
      {
        classId: str(input.classId, { max: 40 }),
        rules: input.rules.map((rule) => ({
          grade: str(rule.grade, { max: 5 }),
          name: str(rule.name, { max: 30 }),
          minPercent: num(rule.minPercent, { min: 0, max: 100 }),
          maxPercent: num(rule.maxPercent, { min: 0, max: 100 }),
          points: num(rule.points, { min: 0, max: 10 }),
          description: str(rule.description, { max: 100 }),
        })),
      },
      ctxOf(req)
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.SETTING_CHANGED,
      entityType: 'gradeRules',
      entityId: str(input.classId, { max: 40 }) || 'all',
      after: rows.map((r) => ({ grade: r.grade, min: r.minPercent, max: r.maxPercent })),
      message: 'Changed the grade bands',
    });
    return ok(res, rows);
  })
);

/* ------------------------------------------------------------ report cards */

router.get(
  '/report-cards/:examId/student/:studentId',
  need('reportcard.generate'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const card = await exams.reportCard(year.name, {
      examId: req.params.examId,
      studentId: req.params.studentId,
      yearId: year.id,
    });
    const classes = await academics.listClasses();
    const sections = await academics.listSections({ academicYearId: year.id });
    return ok(res, {
      ...card,
      className: classes.find((c) => c.id === card.exam.classId)?.name || '',
      sectionName: sections.find((s) => s.id === card.enrollment?.sectionId)?.name || '',
      academicYear: year.name,
      school: await schoolHeader(),
      generatedBy: req.user.name,
      generatedAt: new Date().toISOString(),
    });
  })
);

/** Whole-section print run: one request, one print dialogue. */
router.get(
  '/report-cards/:examId/print',
  need('reportcard.generate'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const sectionId = str(req.query.sectionId, { max: 40 });
    if (!sectionId) throw errors.badRequest('Choose a section.');

    const enrollments = await academics.listEnrollments({
      academicYearId: year.id,
      sectionId,
    });
    const classes = await academics.listClasses();
    const sections = await academics.listSections({ academicYearId: year.id });
    const section = sections.find((s) => s.id === sectionId);

    const cards = [];
    for (const enrollment of enrollments) {
      const student = await students.get(enrollment.studentId);
      if (!student || student.status !== 'Active') continue;
      cards.push(
        await exams.reportCard(year.name, {
          examId: req.params.examId,
          studentId: enrollment.studentId,
          yearId: year.id,
        })
      );
    }

    await auditExport(req, 'Report cards', cards.length);
    return ok(res, {
      cards,
      className: classes.find((c) => c.id === section?.classId)?.name || '',
      sectionName: section?.name || '',
      academicYear: year.name,
      school: await schoolHeader(),
      generatedBy: req.user.name,
      generatedAt: new Date().toISOString(),
    });
  })
);

router.put(
  '/report-cards/:examId/student/:studentId/remarks',
  need('reportcard.generate'),
  handler(async (req, res) => {
    const year = await yearOf(req, 'body');
    const input = body(req);
    const row = await exams.setReportRemarks(
      year.name,
      {
        examId: req.params.examId,
        studentId: req.params.studentId,
        remarks: str(input.remarks, { max: 500 }),
        conduct: str(input.conduct, { max: 60 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

/* -------------------------------------------------------------- analytics */

router.get(
  '/exams/:id/analytics',
  need('result.analytics'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    return ok(
      res,
      await exams.analytics(year.name, {
        examId: req.params.id,
        yearId: year.id,
        sectionId: str(req.query.sectionId, { max: 40 }),
      })
    );
  })
);

router.get(
  '/exams/analytics/comparison',
  need('result.analytics'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const classId = str(req.query.classId, { max: 40 });
    if (!classId) throw errors.badRequest('Choose a class.');
    return ok(
      res,
      await exams.termComparison(year.name, {
        classId,
        yearId: year.id,
        sectionId: str(req.query.sectionId, { max: 40 }),
      })
    );
  })
);

router.get(
  '/exams/:id/export/analytics',
  need('report.export'),
  handler(async (req, res) => {
    const year = await yearOf(req);
    const report = await exams.analytics(year.name, {
      examId: req.params.id,
      yearId: year.id,
      sectionId: str(req.query.sectionId, { max: 40 }),
    });
    const meta = await exportMeta(req);

    const buffer = await exporter.buildWorkbook(
      [
        {
          sheetName: 'By subject',
          title: `${report.exam.name} — subject analysis`,
          subtitle: `Pass ${report.summary.passPercent ?? '—'}% • class average ${
            report.summary.classAverage ?? '—'
          }%`,
          columns: [
            { key: 'subjectName', label: 'Subject', width: 26 },
            { key: 'maxMarks', label: 'Max', type: 'num' },
            { key: 'entered', label: 'Appeared', type: 'num' },
            { key: 'absent', label: 'Absent', type: 'num' },
            { key: 'average', label: 'Average', type: 'num' },
            { key: 'highest', label: 'Highest', type: 'num' },
            { key: 'lowest', label: 'Lowest', type: 'num' },
            { key: 'passPercent', label: 'Pass %', type: 'num' },
          ],
          rows: report.bySubject,
        },
        {
          sheetName: 'Ranked',
          title: `${report.exam.name} — student results`,
          columns: [
            { key: 'rank', label: 'Rank', type: 'num' },
            { key: 'admissionNo', label: 'Admission No', width: 16 },
            { key: 'name', label: 'Student', width: 26 },
            { key: 'obtained', label: 'Obtained', type: 'num' },
            { key: 'max', label: 'Total', type: 'num' },
            { key: 'percent', label: 'Percent', type: 'num' },
            { key: 'failedSubjects', label: 'Failed subjects', type: 'num' },
          ],
          rows: report.ranked,
        },
      ],
      meta
    );

    await auditExport(req, `${report.exam.name} analytics`, report.ranked.length);
    return sendXlsx(res, buffer, exporter.fileName(`${report.exam.name}-analytics`));
  })
);

module.exports = { router };
