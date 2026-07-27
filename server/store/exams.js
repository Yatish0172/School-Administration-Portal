'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const schema = require('./schema');
const academics = require('./academics');
const errors = require('../errors');

/**
 * Exams, marks and report cards (SPEC §10).
 *
 * Publication is a lock, not a label: once an exam is published its marks are
 * read-only, and reopening it needs `marks.publish` and is audited.
 */

const STATUSES = ['setup', 'marks', 'published'];
const DEFAULT_TERMS = ['Unit Test 1', 'Half Yearly', 'Unit Test 2', 'Annual'];

function bookFor(yearName) {
  return schema.workbookKey('Exams', yearName);
}

/* ------------------------------------------------------------------- exams */

async function listExams(yearName, { classId = null, status = null } = {}) {
  const rows = await workbook.read(bookFor(yearName), 'Exams');
  return rows
    .filter((row) => {
      if (classId && row.classId !== classId) return false;
      if (status && row.status !== status) return false;
      return true;
    })
    .sort((a, b) => crud.compareValues(a.startDate, b.startDate));
}

async function getExam(yearName, id) {
  return crud.getOrFail(bookFor(yearName), 'Exams', id, 'exam');
}

async function createExam(yearName, data, ctx) {
  const book = bookFor(yearName);
  if (!data.name) throw errors.validation('Enter a name for the exam.', { name: 'Required.' });
  if (!data.classId) throw errors.validation('Choose a class.', { classId: 'Required.' });
  if (data.startDate && data.endDate && data.endDate < data.startDate) {
    throw errors.validation('The exam cannot end before it starts.', {
      endDate: 'Must be on or after the start date.',
    });
  }
  const clash = await crud.findOne(
    book,
    'Exams',
    (r) =>
      r.classId === data.classId &&
      String(r.name).toLowerCase() === String(data.name).trim().toLowerCase()
  );
  if (clash) {
    throw errors.validation('That exam already exists for this class.', { name: 'Already exists.' });
  }

  return crud.create(
    book,
    'Exams',
    {
      academicYearId: data.academicYearId,
      name: String(data.name).trim(),
      term: data.term || data.name,
      classId: data.classId,
      startDate: data.startDate || null,
      endDate: data.endDate || null,
      weightage: data.weightage ?? 100,
      status: 'setup',
    },
    ctx,
    { label: 'create exam' }
  );
}

async function updateExam(yearName, id, patch, ctx, options = {}) {
  const exam = await getExam(yearName, id);
  if (exam.status === 'published') {
    throw errors.locked(
      'This exam is published. Reopen it first if you need to change the setup.'
    );
  }
  const clean = { ...patch };
  delete clean.status;
  delete clean.publishedAt;
  delete clean.publishedBy;
  return crud.update(bookFor(yearName), 'Exams', id, clean, ctx, {
    expectedRev: options.expectedRev,
    label: 'exam',
  });
}

/* ----------------------------------------------------------- exam subjects */

async function listExamSubjects(yearName, examId) {
  const rows = await workbook.read(bookFor(yearName), 'ExamSubjects');
  return rows.filter((row) => row.examId === examId);
}

/**
 * Replaces the whole subject set for an exam in one write. The date sheet is
 * edited as a grid, so partial saves would leave gaps.
 */
async function setExamSubjects(yearName, examId, subjects, ctx) {
  const book = bookFor(yearName);
  const exam = await getExam(yearName, examId);
  if (exam.status === 'published') {
    throw errors.locked('This exam is published. Reopen it before changing the date sheet.');
  }

  const marks = await workbook.read(book, 'Marks');
  const withMarks = new Set(marks.filter((m) => m.examId === examId).map((m) => m.subjectId));

  for (const subject of subjects) {
    if (!subject.subjectId) throw errors.badRequest('Every row needs a subject.');
    const maxMarks = Number(subject.maxMarks ?? 100);
    const passMarks = Number(subject.passMarks ?? 33);
    if (maxMarks <= 0) throw errors.badRequest('Maximum marks must be above zero.');
    if (passMarks > maxMarks) {
      throw errors.badRequest('Pass marks cannot be higher than maximum marks.');
    }
  }

  const keeping = new Set(subjects.map((s) => s.subjectId));
  for (const subjectId of withMarks) {
    if (!keeping.has(subjectId)) {
      throw errors.badRequest(
        'One of the subjects you removed already has marks entered. Clear those marks first.'
      );
    }
  }

  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows('ExamSubjects');
      const existing = rows.filter((r) => r.examId === examId);
      const others = rows.filter((r) => r.examId !== examId);
      api.replace('ExamSubjects', others);

      const created = [];
      for (const subject of subjects) {
        const previous = existing.find((r) => r.subjectId === subject.subjectId);
        created.push(
          crud.insertInto(
            api,
            book,
            'ExamSubjects',
            {
              id: previous?.id, // keep the id so Marks rows stay attached
              examId,
              classId: exam.classId,
              subjectId: subject.subjectId,
              maxMarks: Number(subject.maxMarks ?? 100),
              passMarks: Number(subject.passMarks ?? 33),
              examDate: subject.examDate || null,
              startTime: subject.startTime || null,
              endTime: subject.endTime || null,
              weightage: subject.weightage ?? 100,
            },
            ctx
          )
        );
      }
      return created;
    },
    { label: 'set exam subjects' }
  );
}

/* ------------------------------------------------------------------- marks */

/**
 * The marks grid for one exam subject and one section, in roll-number order.
 * Blank is deliberately distinct from zero: `marksObtained` stays null until a
 * number is typed (SPEC §10 validation).
 */
async function marksGrid(yearName, { examId, examSubjectId, sectionId, yearId }) {
  const students = require('./students');
  const book = bookFor(yearName);
  const exam = await getExam(yearName, examId);
  const examSubject = await crud.getOrFail(book, 'ExamSubjects', examSubjectId, 'exam subject');

  const enrollments = await academics.listEnrollments({
    academicYearId: yearId,
    sectionId,
  });
  const marks = (await workbook.read(book, 'Marks')).filter(
    (row) => row.examSubjectId === examSubjectId && row.sectionId === sectionId
  );
  const byStudent = new Map(marks.map((row) => [row.studentId, row]));

  const rows = [];
  for (const enrollment of enrollments) {
    const student = await students.get(enrollment.studentId);
    if (!student || student.status !== 'Active') continue;
    const mark = byStudent.get(enrollment.studentId) || null;
    rows.push({
      studentId: enrollment.studentId,
      enrollmentId: enrollment.id,
      admissionNo: student.admissionNo,
      rollNo: enrollment.rollNo,
      name: student.fullName,
      marksObtained: mark ? mark.marksObtained : null,
      isAbsent: mark ? !!mark.isAbsent : false,
      grade: mark ? mark.grade : null,
      remarks: mark ? mark.remarks : null,
      recordId: mark ? mark.id : null,
      _rev: mark ? mark._rev : null,
    });
  }
  rows.sort((a, b) => crud.compareValues(a.rollNo, b.rollNo) || crud.compareValues(a.name, b.name));

  return {
    exam,
    examSubject,
    locked: exam.status === 'published',
    rows,
  };
}

/**
 * Saves a batch of marks. The grid saves incrementally as the teacher moves down
 * the list, so this must be cheap and idempotent — one lock, one disk write.
 */
async function saveMarks(yearName, { examId, examSubjectId, sectionId, entries }, ctx) {
  const book = bookFor(yearName);
  const exam = await getExam(yearName, examId);
  if (exam.status === 'published') {
    throw errors.locked(
      'These marks are published and cannot be changed. Reopen the exam to make a correction.'
    );
  }
  const examSubject = await crud.getOrFail(book, 'ExamSubjects', examSubjectId, 'exam subject');
  const maxMarks = Number(examSubject.maxMarks || 100);

  for (const entry of entries) {
    if (entry.isAbsent) continue;
    if (entry.marksObtained === null || entry.marksObtained === undefined || entry.marksObtained === '') {
      continue; // blank stays blank
    }
    const value = Number(entry.marksObtained);
    if (!Number.isFinite(value) || value < 0) {
      throw errors.badRequest('Marks must be zero or a positive number.');
    }
    if (value > maxMarks) {
      throw errors.badRequest(`Marks cannot be more than ${maxMarks} for this subject.`);
    }
  }

  const gradeRules = await listGradeRules(yearName, exam.classId);

  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows('Marks');
      const index = new Map();
      rows.forEach((row, position) => {
        if (row.examSubjectId !== examSubjectId) return;
        index.set(row.studentId, position);
      });

      let created = 0;
      let updated = 0;
      const now = crud.nowIso();

      for (const entry of entries) {
        const isAbsent = !!entry.isAbsent;
        const value =
          isAbsent || entry.marksObtained === '' || entry.marksObtained === null
            ? null
            : Number(entry.marksObtained);
        const grade = value === null ? null : gradeFor(gradeRules, (value / maxMarks) * 100);

        const payload = {
          examId,
          examSubjectId,
          subjectId: examSubject.subjectId,
          studentId: entry.studentId,
          enrollmentId: entry.enrollmentId || null,
          sectionId,
          marksObtained: value,
          isAbsent,
          grade,
          remarks: entry.remarks || null,
          enteredBy: crud.actorOf(ctx),
          enteredAt: now,
        };

        const position = index.get(entry.studentId);
        if (position === undefined) {
          if (value === null && !isAbsent) continue; // nothing typed, nothing to store
          crud.insertInto(api, book, 'Marks', payload, ctx);
          created += 1;
        } else {
          const current = rows[position];
          const unchanged =
            Number(current.marksObtained) === Number(value) &&
            !!current.isAbsent === isAbsent &&
            (current.remarks || null) === (entry.remarks || null);
          if (unchanged) continue;
          rows[position] = {
            ...current,
            ...payload,
            id: current.id,
            _rev: Number(current._rev || 1) + 1,
            createdBy: current.createdBy,
            createdAt: current.createdAt,
            updatedBy: crud.actorOf(ctx),
            updatedAt: now,
          };
          updated += 1;
        }
      }

      if ((created || updated) && exam.status === 'setup') {
        crud.updateIn(api, book, 'Exams', examId, { status: 'marks' }, ctx, { label: 'exam' });
      }

      return { created, updated };
    },
    { label: 'save marks' }
  );
}

/* ------------------------------------------------------------ grade rules */

async function listGradeRules(yearName, classId = null) {
  const rows = await workbook.read(bookFor(yearName), 'GradeRules');
  const scoped = rows.filter((row) => !row.classId || row.classId === classId);
  const specific = scoped.filter((row) => row.classId === classId);
  const chosen = specific.length ? specific : scoped;
  return chosen.sort((a, b) => Number(b.minPercent || 0) - Number(a.minPercent || 0));
}

function gradeFor(rules, percent) {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
  const match = rules.find(
    (rule) => percent >= Number(rule.minPercent) && percent <= Number(rule.maxPercent)
  );
  return match ? match.grade : null;
}

async function setGradeRules(yearName, { classId = null, rules }, ctx) {
  const book = bookFor(yearName);
  const sorted = [...rules].sort((a, b) => Number(a.minPercent) - Number(b.minPercent));
  for (let i = 0; i < sorted.length; i += 1) {
    const rule = sorted[i];
    if (!rule.grade) throw errors.badRequest('Every band needs a grade letter.');
    const min = Number(rule.minPercent);
    const max = Number(rule.maxPercent);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw errors.badRequest('Each band needs a valid range, with the lower bound first.');
    }
    if (i > 0 && min <= Number(sorted[i - 1].maxPercent)) {
      throw errors.badRequest(
        `The bands ${sorted[i - 1].grade} and ${rule.grade} overlap. Ranges must not overlap.`
      );
    }
  }

  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows('GradeRules');
      api.replace(
        'GradeRules',
        rows.filter((row) => (row.classId || null) !== (classId || null))
      );
      return sorted.map((rule) =>
        crud.insertInto(
          api,
          book,
          'GradeRules',
          {
            name: rule.name || rule.grade,
            classId: classId || null,
            minPercent: Number(rule.minPercent),
            maxPercent: Number(rule.maxPercent),
            grade: rule.grade,
            points: rule.points ?? null,
            description: rule.description || null,
          },
          ctx
        )
      );
    },
    { label: 'set grade rules' }
  );
}

async function seedGradeRules(yearName, ctx) {
  const existing = await workbook.read(bookFor(yearName), 'GradeRules');
  if (existing.length) return [];
  return setGradeRules(
    yearName,
    {
      classId: null,
      rules: [
        { grade: 'A1', minPercent: 91, maxPercent: 100, points: 10 },
        { grade: 'A2', minPercent: 81, maxPercent: 90, points: 9 },
        { grade: 'B1', minPercent: 71, maxPercent: 80, points: 8 },
        { grade: 'B2', minPercent: 61, maxPercent: 70, points: 7 },
        { grade: 'C1', minPercent: 51, maxPercent: 60, points: 6 },
        { grade: 'C2', minPercent: 41, maxPercent: 50, points: 5 },
        { grade: 'D', minPercent: 33, maxPercent: 40, points: 4 },
        { grade: 'E', minPercent: 0, maxPercent: 32, points: 0 },
      ],
    },
    ctx
  );
}

/* -------------------------------------------------------------- publishing */

/**
 * Publication lock (SPEC §10). Refuses to publish while marks are missing, since
 * an incomplete report card reaching a parent is the expensive kind of mistake.
 */
async function publish(yearName, examId, { force = false }, ctx) {
  const book = bookFor(yearName);
  const exam = await getExam(yearName, examId);
  if (exam.status === 'published') throw errors.badRequest('That exam is already published.');

  const subjects = await listExamSubjects(yearName, examId);
  if (!subjects.length) {
    throw errors.badRequest('Set up the subjects and date sheet before publishing.');
  }

  const gaps = await missingMarks(yearName, examId);
  if (gaps.total > 0 && !force) {
    throw errors.badRequest(
      `${gaps.total} mark${gaps.total === 1 ? '' : 's'} across ${gaps.subjects.length} subject${
        gaps.subjects.length === 1 ? '' : 's'
      } are still blank. Fill them in, or publish anyway if those students genuinely have no marks.`
    );
  }

  return crud.update(
    book,
    'Exams',
    examId,
    { status: 'published', publishedAt: crud.nowIso(), publishedBy: crud.actorOf(ctx) },
    ctx,
    { label: 'exam' }
  );
}

async function unpublish(yearName, examId, reason, ctx) {
  if (!reason || String(reason).trim().length < 5) {
    throw errors.validation('Give a reason for reopening published results.', {
      reason: 'Enter a reason.',
    });
  }
  const book = bookFor(yearName);
  const exam = await getExam(yearName, examId);
  if (exam.status !== 'published') throw errors.badRequest('That exam is not published.');
  return crud.update(
    book,
    'Exams',
    examId,
    { status: 'marks', publishedAt: null, publishedBy: null },
    ctx,
    { label: 'exam' }
  );
}

async function missingMarks(yearName, examId) {
  const book = bookFor(yearName);
  const exam = await getExam(yearName, examId);
  const subjects = await listExamSubjects(yearName, examId);
  const marks = (await workbook.read(book, 'Marks')).filter((m) => m.examId === examId);
  const enrollments = await academics.listEnrollments({
    academicYearId: exam.academicYearId,
    classId: exam.classId,
  });

  const bySubject = [];
  let total = 0;
  for (const subject of subjects) {
    const entered = new Set(
      marks
        .filter(
          (m) =>
            m.examSubjectId === subject.id &&
            (m.marksObtained !== null || m.isAbsent)
        )
        .map((m) => m.studentId)
    );
    const missing = enrollments.filter((e) => !entered.has(e.studentId)).length;
    if (missing > 0) bySubject.push({ examSubjectId: subject.id, subjectId: subject.subjectId, missing });
    total += missing;
  }
  return { total, subjects: bySubject, students: enrollments.length };
}

/* ------------------------------------------------------------ report cards */

/**
 * Everything a report card needs for one student: subject marks, grades, totals,
 * attendance percentage and remarks.
 */
async function reportCard(yearName, { examId, studentId, yearId }) {
  const students = require('./students');
  const attendance = require('./attendance');
  const book = bookFor(yearName);

  const exam = await getExam(yearName, examId);
  const student = await students.getOrFail(studentId);
  const enrollment = await academics.enrollmentFor(studentId, yearId);
  const subjects = await listExamSubjects(yearName, examId);
  const allSubjects = await academics.listSubjects({ academicYearId: yearId, classId: exam.classId });
  const subjectById = new Map(allSubjects.map((s) => [s.id, s]));
  const marks = (await workbook.read(book, 'Marks')).filter(
    (m) => m.examId === examId && m.studentId === studentId
  );
  const markBySubject = new Map(marks.map((m) => [m.examSubjectId, m]));
  const gradeRules = await listGradeRules(yearName, exam.classId);

  const lines = subjects.map((subject) => {
    const mark = markBySubject.get(subject.id) || null;
    const obtained = mark && !mark.isAbsent ? Number(mark.marksObtained) : null;
    const percent = obtained === null ? null : (obtained / Number(subject.maxMarks)) * 100;
    return {
      subjectId: subject.subjectId,
      subjectName: subjectById.get(subject.subjectId)?.name || 'Subject',
      maxMarks: Number(subject.maxMarks),
      passMarks: Number(subject.passMarks),
      marksObtained: obtained,
      isAbsent: mark ? !!mark.isAbsent : false,
      percent: percent === null ? null : Math.round(percent * 10) / 10,
      grade: mark?.grade || gradeFor(gradeRules, percent),
      passed: obtained === null ? null : obtained >= Number(subject.passMarks),
      remarks: mark?.remarks || null,
    };
  });

  const counted = lines.filter((line) => line.marksObtained !== null);
  const totalMax = counted.reduce((sum, line) => sum + line.maxMarks, 0);
  const totalObtained = counted.reduce((sum, line) => sum + line.marksObtained, 0);
  const percent = totalMax ? Math.round((totalObtained / totalMax) * 1000) / 10 : null;

  const year = await academics.getYear(yearId);
  const attendanceSummary = year
    ? await attendance
        .forStudent({
          yearName,
          studentId,
          from: year.startDate,
          to: year.endDate,
        })
        .then((rows) => attendance.summarise(rows))
    : null;

  const remarksRow = await crud.findOne(
    book,
    'ReportRemarks',
    (r) => r.examId === examId && r.studentId === studentId
  );

  return {
    exam,
    student,
    enrollment,
    lines,
    totals: {
      totalMax,
      totalObtained,
      percent,
      grade: gradeFor(gradeRules, percent),
      failedSubjects: lines.filter((line) => line.passed === false).length,
      result:
        lines.some((line) => line.passed === false)
          ? 'Needs improvement'
          : percent === null
            ? 'Pending'
            : 'Passed',
    },
    attendance: attendanceSummary,
    remarks: remarksRow?.remarks || null,
    conduct: remarksRow?.conduct || null,
    published: exam.status === 'published',
  };
}

async function setReportRemarks(yearName, { examId, studentId, remarks, conduct }, ctx) {
  const book = bookFor(yearName);
  return workbook.mutate(
    book,
    (api) => {
      const rows = api.rows('ReportRemarks');
      const index = rows.findIndex((r) => r.examId === examId && r.studentId === studentId);
      const payload = { examId, studentId, remarks, conduct, enteredBy: crud.actorOf(ctx) };
      if (index === -1) return crud.insertInto(api, book, 'ReportRemarks', payload, ctx);
      return crud.updateIn(api, book, 'ReportRemarks', rows[index].id, payload, ctx, {
        label: 'report remarks',
      });
    },
    { label: 'set report remarks' }
  );
}

/* ----------------------------------------------------------------analytics */

async function analytics(yearName, { examId, yearId, sectionId = null }) {
  const students = require('./students');
  const book = bookFor(yearName);
  const exam = await getExam(yearName, examId);
  const subjects = await listExamSubjects(yearName, examId);
  const allSubjects = await academics.listSubjects({ academicYearId: yearId, classId: exam.classId });
  const subjectById = new Map(allSubjects.map((s) => [s.id, s]));
  let marks = (await workbook.read(book, 'Marks')).filter((m) => m.examId === examId);
  if (sectionId) marks = marks.filter((m) => m.sectionId === sectionId);

  const bySubject = subjects.map((subject) => {
    const rows = marks.filter((m) => m.examSubjectId === subject.id && !m.isAbsent && m.marksObtained !== null);
    const values = rows.map((m) => Number(m.marksObtained));
    const passed = rows.filter((m) => Number(m.marksObtained) >= Number(subject.passMarks)).length;
    return {
      subjectId: subject.subjectId,
      subjectName: subjectById.get(subject.subjectId)?.name || 'Subject',
      maxMarks: Number(subject.maxMarks),
      entered: rows.length,
      absent: marks.filter((m) => m.examSubjectId === subject.id && m.isAbsent).length,
      average: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null,
      highest: values.length ? Math.max(...values) : null,
      lowest: values.length ? Math.min(...values) : null,
      passPercent: rows.length ? Math.round((passed / rows.length) * 1000) / 10 : null,
    };
  });

  // Per-student totals for toppers and the failure list.
  const byStudent = new Map();
  const maxBySubject = new Map(subjects.map((s) => [s.id, Number(s.maxMarks)]));
  const passBySubject = new Map(subjects.map((s) => [s.id, Number(s.passMarks)]));
  for (const mark of marks) {
    if (!byStudent.has(mark.studentId)) {
      byStudent.set(mark.studentId, { obtained: 0, max: 0, failed: 0, absent: 0 });
    }
    const entry = byStudent.get(mark.studentId);
    const max = maxBySubject.get(mark.examSubjectId) || 0;
    entry.max += max;
    if (mark.isAbsent) {
      entry.absent += 1;
      entry.failed += 1;
    } else if (mark.marksObtained !== null) {
      entry.obtained += Number(mark.marksObtained);
      if (Number(mark.marksObtained) < (passBySubject.get(mark.examSubjectId) || 0)) entry.failed += 1;
    }
  }

  const ranked = [];
  for (const [studentId, entry] of byStudent) {
    const student = await students.get(studentId);
    if (!student) continue;
    ranked.push({
      studentId,
      admissionNo: student.admissionNo,
      name: student.fullName,
      obtained: entry.obtained,
      max: entry.max,
      percent: entry.max ? Math.round((entry.obtained / entry.max) * 1000) / 10 : null,
      failedSubjects: entry.failed,
      absentSubjects: entry.absent,
    });
  }
  ranked.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });

  const appeared = ranked.filter((r) => r.percent !== null);
  return {
    exam,
    bySubject,
    toppers: ranked.slice(0, 10),
    failures: ranked.filter((r) => r.failedSubjects > 0),
    summary: {
      appeared: appeared.length,
      passed: appeared.filter((r) => r.failedSubjects === 0).length,
      passPercent: appeared.length
        ? Math.round((appeared.filter((r) => r.failedSubjects === 0).length / appeared.length) * 1000) / 10
        : null,
      classAverage: appeared.length
        ? Math.round((appeared.reduce((sum, r) => sum + r.percent, 0) / appeared.length) * 10) / 10
        : null,
    },
    ranked,
  };
}

/** Term comparison: the same student's percentage across every published exam. */
async function termComparison(yearName, { classId, yearId, sectionId = null }) {
  const students = require('./students');
  const exams = (await listExams(yearName, { classId })).filter((e) => e.status === 'published');
  const book = bookFor(yearName);
  const marks = await workbook.read(book, 'Marks');
  const examSubjects = await workbook.read(book, 'ExamSubjects');
  const maxById = new Map(examSubjects.map((s) => [s.id, Number(s.maxMarks)]));

  const enrollments = await academics.listEnrollments({
    academicYearId: yearId,
    classId,
    sectionId: sectionId || null,
  });

  const rows = [];
  for (const enrollment of enrollments) {
    const student = await students.get(enrollment.studentId);
    if (!student) continue;
    const entry = { studentId: enrollment.studentId, name: student.fullName, rollNo: enrollment.rollNo, terms: {} };
    for (const exam of exams) {
      const own = marks.filter((m) => m.examId === exam.id && m.studentId === enrollment.studentId);
      const max = own.reduce((sum, m) => sum + (maxById.get(m.examSubjectId) || 0), 0);
      const obtained = own
        .filter((m) => !m.isAbsent && m.marksObtained !== null)
        .reduce((sum, m) => sum + Number(m.marksObtained), 0);
      entry.terms[exam.id] = max ? Math.round((obtained / max) * 1000) / 10 : null;
    }
    rows.push(entry);
  }

  return { exams: exams.map((e) => ({ id: e.id, name: e.name })), rows };
}

module.exports = {
  STATUSES,
  DEFAULT_TERMS,
  bookFor,
  listExams,
  getExam,
  createExam,
  updateExam,
  listExamSubjects,
  setExamSubjects,
  marksGrid,
  saveMarks,
  listGradeRules,
  gradeFor,
  setGradeRules,
  seedGradeRules,
  publish,
  unpublish,
  missingMarks,
  reportCard,
  setReportRemarks,
  analytics,
  termComparison,
};
