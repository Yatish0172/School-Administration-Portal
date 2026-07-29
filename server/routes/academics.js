'use strict';

const express = require('express');

const { ok, handler, body, str, num, bool, isoDate } = require('../http');
const {
  need,
  needAny,
  sectionBoundScope,
  assertSection,
  filterBySection,
} = require('../middleware/permission');
const academics = require('../store/academics');
const users = require('../store/users');
const audit = require('../store/audit');
const errors = require('../errors');

const router = express.Router();

const ctxOf = (req) => ({ userId: req.user.id, name: req.user.name });

/* --------------------------------------------------------- academic years */

router.get(
  '/years',
  need('academics.view'),
  handler(async (req, res) =>
    ok(res, {
      rows: await academics.listYears(),
      current: await academics.currentYear(),
    })
  )
);

router.post(
  '/years',
  need('academics.year'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.createYear(
      {
        name: str(input.name, { max: 10 }),
        startDate: isoDate(input.startDate),
        endDate: isoDate(input.endDate),
      },
      ctxOf(req)
    );

    // The year-scoped workbooks get their defaults now, so the first exam has
    // grade bands to grade against and the first invoice has fee heads to bill.
    // Seeded here rather than in the store to keep academics free of a circular
    // dependency on exams and fees.
    const exams = require('../store/exams');
    const fees = require('../store/fees');
    await exams.seedGradeRules(year.name, ctxOf(req));
    await fees.seedHeads(year.name, ctxOf(req));

    await audit.fromRequest(req, {
      action: audit.ACTIONS.YEAR_SET_CURRENT,
      entityType: 'academicYear',
      entityId: year.id,
      after: year,
      message: `Created academic year ${year.name}`,
    });
    return ok(res, year);
  })
);

router.post(
  '/years/:id/current',
  need('academics.year'),
  handler(async (req, res) => {
    const year = await academics.setCurrentYear(req.params.id, ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.YEAR_SET_CURRENT,
      entityType: 'academicYear',
      entityId: req.params.id,
      after: { name: year.name, isCurrent: true },
      message: `Made ${year.name} the current academic year`,
    });
    return ok(res, await academics.currentYear());
  })
);

router.post(
  '/years/:id/close',
  need('academics.year'),
  handler(async (req, res) => {
    const result = await academics.closeYear(req.params.id, ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.YEAR_CLOSED,
      entityType: 'academicYear',
      entityId: req.params.id,
      before: { status: result.before.status },
      after: { status: 'closed' },
      message: `Closed academic year ${result.after.name}. It stays readable.`,
    });
    return ok(res, result.after);
  })
);

router.post(
  '/years/:id/reopen',
  need('academics.year'),
  handler(async (req, res) => {
    const result = await academics.reopenYear(req.params.id, ctxOf(req));
    await audit.fromRequest(req, {
      action: audit.ACTIONS.YEAR_CLOSED,
      entityType: 'academicYear',
      entityId: req.params.id,
      after: { status: 'open' },
      message: `Reopened academic year ${result.after.name}`,
    });
    return ok(res, result.after);
  })
);

/* ------------------------------------------------------------------ classes */

router.get(
  '/classes',
  need('academics.view'),
  handler(async (req, res) =>
    ok(res, await academics.listClasses({ includeInactive: bool(req.query.includeInactive) }))
  )
);

router.post(
  '/classes',
  need('academics.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await academics.createClass(
      {
        name: str(input.name, { max: 40 }),
        level: num(input.level, { min: 0, max: 20 }),
        sortOrder: num(input.sortOrder, { min: 0, max: 999 }),
        stream: str(input.stream, { max: 40 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/classes/:id',
  need('academics.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await academics.updateClass(
      req.params.id,
      {
        name: str(input.name, { max: 40 }),
        level: num(input.level, { min: 0, max: 20 }),
        sortOrder: num(input.sortOrder, { min: 0, max: 999 }),
        stream: str(input.stream, { max: 40 }),
        status: str(input.status, { max: 10 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

/* ----------------------------------------------------------------- sections */

router.get(
  '/sections',
  need('academics.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const rows = await academics.listSections({
      academicYearId: year.id,
      classId: str(req.query.classId, { max: 40 }),
      includeInactive: bool(req.query.includeInactive),
    });
    const occupancy = await academics.sectionOccupancy(year.id);
    const teachers = await users.all();
    const byId = new Map(teachers.map((u) => [u.id, u]));

    return ok(res, {
      academicYearId: year.id,
      rows: rows.map((row) => ({
        ...row,
        enrolled: occupancy.get(row.id) || 0,
        free: row.capacity ? Math.max(0, Number(row.capacity) - (occupancy.get(row.id) || 0)) : null,
        classTeacherName: byId.get(row.classTeacherId)?.name || null,
      })),
    });
  })
);

router.post(
  '/sections',
  need('academics.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const row = await academics.createSection(
      {
        academicYearId: year.id,
        classId: str(input.classId, { max: 40 }),
        name: str(input.name, { max: 20 }),
        capacity: num(input.capacity, { min: 1, max: 200 }),
        classTeacherId: str(input.classTeacherId, { max: 40 }),
        roomNo: str(input.roomNo, { max: 20 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/sections/:id',
  need('academics.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await academics.updateSection(
      req.params.id,
      {
        name: str(input.name, { max: 20 }),
        capacity: num(input.capacity, { min: 1, max: 200 }),
        classTeacherId: str(input.classTeacherId, { max: 40 }),
        roomNo: str(input.roomNo, { max: 20 }),
        status: str(input.status, { max: 10 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

/* ----------------------------------------------------------------- subjects */

router.get(
  '/subjects',
  need('academics.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    return ok(res, {
      academicYearId: year.id,
      rows: await academics.listSubjects({
        academicYearId: year.id,
        classId: str(req.query.classId, { max: 40 }),
        includeInactive: bool(req.query.includeInactive),
      }),
    });
  })
);

router.post(
  '/subjects',
  need('academics.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const row = await academics.createSubject(
      {
        academicYearId: year.id,
        classId: str(input.classId, { max: 40 }),
        name: str(input.name, { max: 60 }),
        code: str(input.code, { max: 20 }),
        type: str(input.type, { max: 20 }),
        mode: str(input.mode, { max: 20 }),
        maxMarks: num(input.maxMarks, { min: 1, max: 1000 }),
        passMarks: num(input.passMarks, { min: 0, max: 1000 }),
        sortOrder: num(input.sortOrder, { min: 0, max: 999 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/subjects/:id',
  need('academics.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await academics.updateSubject(
      req.params.id,
      {
        name: str(input.name, { max: 60 }),
        code: str(input.code, { max: 20 }),
        type: str(input.type, { max: 20 }),
        mode: str(input.mode, { max: 20 }),
        maxMarks: num(input.maxMarks, { min: 1, max: 1000 }),
        passMarks: num(input.passMarks, { min: 0, max: 1000 }),
        sortOrder: num(input.sortOrder, { min: 0, max: 999 }),
        status: str(input.status, { max: 10 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

router.post(
  '/subjects/copy',
  need('academics.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const created = await academics.copySubjects(
      str(input.fromYearId, { max: 40 }),
      str(input.toYearId, { max: 40 }),
      ctxOf(req)
    );
    return ok(res, { copied: created.length });
  })
);

/* ------------------------------------------------------ teacher assignments */

router.get(
  '/assignments',
  need('academics.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const rows = await academics.listAssignments({
      academicYearId: year.id,
      teacherUserId: str(req.query.teacherUserId, { max: 40 }),
      sectionId: str(req.query.sectionId, { max: 40 }),
    });
    const allUsers = await users.all();
    const byId = new Map(allUsers.map((u) => [u.id, u]));
    const sections = await academics.listSections({ academicYearId: year.id });
    const sectionById = new Map(sections.map((s) => [s.id, s]));
    const classes = await academics.listClasses();
    const classById = new Map(classes.map((c) => [c.id, c]));
    const subjects = await academics.listSubjects({ academicYearId: year.id });
    const subjectById = new Map(subjects.map((s) => [s.id, s]));

    return ok(res, {
      academicYearId: year.id,
      rows: rows.map((row) => ({
        ...row,
        teacherName: byId.get(row.teacherUserId)?.name || 'Unknown',
        className: classById.get(row.classId)?.name || '',
        sectionName: sectionById.get(row.sectionId)?.name || '',
        subjectName: row.subjectId ? subjectById.get(row.subjectId)?.name || '' : 'Class teacher',
      })),
      teachers: allUsers
        .filter((u) => u.status === 'active')
        .map((u) => ({ id: u.id, name: u.name, roleKey: u.roleKey })),
    });
  })
);

router.post(
  '/assignments',
  need('academics.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const row = await academics.createAssignment(
      {
        academicYearId: year.id,
        teacherUserId: str(input.teacherUserId, { max: 40 }),
        classId: str(input.classId, { max: 40 }),
        sectionId: str(input.sectionId, { max: 40 }),
        subjectId: str(input.subjectId, { max: 40 }),
        isClassTeacher: bool(input.isClassTeacher),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.delete(
  '/assignments/:id',
  need('academics.edit'),
  handler(async (req, res) => {
    await academics.removeAssignment(req.params.id, ctxOf(req));
    return ok(res, { removed: true });
  })
);

/* -------------------------------------------------------------- enrollments */

router.get(
  '/enrollments',
  need('enrollment.view'),
  handler(async (req, res) => {
    const students = require('../store/students');
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const rows = await academics.listEnrollments({
      academicYearId: year.id,
      classId: str(req.query.classId, { max: 40 }),
      sectionId: str(req.query.sectionId, { max: 40 }),
      studentId: str(req.query.studentId, { max: 40 }),
      status: str(req.query.status, { max: 20 }) || 'active',
    });

    const out = [];
    for (const row of rows) {
      const student = await students.get(row.studentId);
      out.push({
        ...row,
        admissionNo: student?.admissionNo || '',
        studentName: student?.fullName || 'Unknown',
        studentStatus: student?.status || '',
      });
    }
    out.sort((a, b) => {
      const roll = Number(a.rollNo) - Number(b.rollNo);
      if (Number.isFinite(roll) && roll !== 0) return roll;
      return String(a.studentName).localeCompare(String(b.studentName));
    });
    return ok(res, { academicYearId: year.id, rows: out });
  })
);

router.post(
  '/enrollments',
  need('enrollment.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const rollNo =
      str(input.rollNo, { max: 10 }) ||
      String(await academics.nextRollNo(str(input.sectionId, { max: 40 }), year.id));
    const row = await academics.enroll(
      {
        studentId: str(input.studentId, { max: 40 }),
        academicYearId: year.id,
        classId: str(input.classId, { max: 40 }),
        sectionId: str(input.sectionId, { max: 40 }),
        rollNo,
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

router.put(
  '/enrollments/:id',
  need('enrollment.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await academics.updateEnrollment(
      req.params.id,
      {
        classId: str(input.classId, { max: 40 }),
        sectionId: str(input.sectionId, { max: 40 }),
        rollNo: str(input.rollNo, { max: 10 }),
        status: str(input.status, { max: 20 }),
      },
      ctxOf(req),
      { expectedRev: input._rev }
    );
    return ok(res, result.after);
  })
);

router.get(
  '/enrollments/next-roll',
  need('enrollment.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const sectionId = str(req.query.sectionId, { max: 40 });
    if (!sectionId) throw errors.badRequest('Choose a section.');
    return ok(res, { rollNo: String(await academics.nextRollNo(sectionId, year.id)) });
  })
);

/**
 * Bulk promotion at year rollover (SPEC §6). Exceptions are students held back,
 * which is the whole reason this cannot be a single button.
 */
router.post(
  '/enrollments/promote',
  need('student.promote'),
  handler(async (req, res) => {
    const input = body(req);
    if (!Array.isArray(input.mapping) || !input.mapping.length) {
      throw errors.badRequest('Map each section to the section its students move into.');
    }
    const result = await academics.promoteBulk({
      fromYearId: str(input.fromYearId, { max: 40 }),
      toYearId: str(input.toYearId, { max: 40 }),
      mapping: input.mapping.map((rule) => ({
        fromSectionId: String(rule.fromSectionId),
        toClassId: String(rule.toClassId),
        toSectionId: String(rule.toSectionId),
      })),
      exceptions: Array.isArray(input.exceptions) ? input.exceptions.map(String) : [],
      ctx: ctxOf(req),
    });

    await audit.fromRequest(req, {
      action: audit.ACTIONS.STUDENT_PROMOTED,
      entityType: 'academicYear',
      entityId: str(input.toYearId, { max: 40 }),
      after: result,
      message: `Promoted ${result.promoted} students, held back ${result.heldBack}`,
    });
    return ok(res, result);
  })
);

/* ------------------------------------------------------------------ periods */

router.get(
  '/periods',
  need('timetable.view'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    return ok(res, { academicYearId: year.id, rows: await academics.listPeriods(year.id) });
  })
);

router.put(
  '/periods',
  need('timetable.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    if (!Array.isArray(input.periods)) throw errors.badRequest('Send the list of periods.');
    const count = await academics.setPeriods(
      year.id,
      input.periods.map((period, index) => ({
        period: num(period.period, { min: 1, max: 20 }) || index + 1,
        label: str(period.label, { max: 30 }),
        startTime: str(period.startTime, { max: 5 }),
        endTime: str(period.endTime, { max: 5 }),
        isBreak: bool(period.isBreak),
      })),
      ctxOf(req)
    );
    return ok(res, { periods: count });
  })
);

/* ---------------------------------------------------------------- timetable */

router.get(
  '/timetable',
  need('timetable.view'),
  sectionBoundScope(),
  handler(async (req, res) => {
    const year = req.scope.year;
    const sectionId = str(req.query.sectionId, { max: 40 });
    const teacherUserId = str(req.query.teacherUserId, { max: 40 });
    if (!sectionId && !teacherUserId) {
      throw errors.badRequest('Choose a section or a teacher.');
    }

    // A class teacher sees their own sections and their own load, nothing wider.
    if (sectionId) assertSection(req, sectionId);
    if (teacherUserId && !req.scope.allSections && teacherUserId !== req.user.id) {
      throw errors.forbidden(
        'You can only see your own timetable. Ask the office for another teacher’s.'
      );
    }

    const rows = filterBySection(
      req,
      await academics.listTimetable({
        academicYearId: year.id,
        sectionId,
        teacherUserId,
      })
    );
    const subjects = await academics.listSubjects({ academicYearId: year.id });
    const subjectById = new Map(subjects.map((s) => [s.id, s]));
    const allUsers = await users.all();
    const byId = new Map(allUsers.map((u) => [u.id, u]));
    const sections = await academics.listSections({ academicYearId: year.id });
    const sectionById = new Map(sections.map((s) => [s.id, s]));
    const classes = await academics.listClasses();
    const classById = new Map(classes.map((c) => [c.id, c]));

    return ok(res, {
      academicYearId: year.id,
      periods: await academics.listPeriods(year.id),
      rows: rows.map((row) => ({
        ...row,
        subjectName: subjectById.get(row.subjectId)?.name || '',
        teacherName: byId.get(row.teacherUserId)?.name || '',
        sectionName: sectionById.get(row.sectionId)?.name || '',
        className: classById.get(row.classId)?.name || '',
      })),
      // Filtered by scope as well as by section: a by-teacher request carries no
      // section id, so without this a class teacher would receive the whole
      // school's substitutions for the day.
      substitutions: filterBySection(
        req,
        await academics.listSubstitutions({
          date: isoDate(req.query.date),
          sectionId,
        })
      ),
    });
  })
);

router.put(
  '/timetable/slot',
  need('timetable.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const year = await academics.resolveYear(str(input.academicYearId, { max: 40 }));
    const result = await academics.setTimetableSlot(
      {
        academicYearId: year.id,
        sectionId: str(input.sectionId, { max: 40 }),
        classId: str(input.classId, { max: 40 }),
        day: num(input.day, { min: 0, max: 6 }),
        period: num(input.period, { min: 1, max: 20 }),
        subjectId: str(input.subjectId, { max: 40 }),
        teacherUserId: str(input.teacherUserId, { max: 40 }),
        roomNo: str(input.roomNo, { max: 20 }),
      },
      ctxOf(req)
    );
    return ok(res, result);
  })
);

router.post(
  '/timetable/substitutions',
  need('timetable.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const row = await academics.createSubstitution(
      {
        date: isoDate(input.date),
        timetableId: str(input.timetableId, { max: 40 }),
        substituteTeacherId: str(input.substituteTeacherId, { max: 40 }),
        reason: str(input.reason, { max: 200 }),
      },
      ctxOf(req)
    );
    return ok(res, row);
  })
);

/** Everything the sidebar pickers need, in one request. */
router.get(
  '/lookups',
  needAny('academics.view', 'student.view', 'student.lookup'),
  handler(async (req, res) => {
    const year = await academics.resolveYear(str(req.query.academicYearId, { max: 40 }));
    const [years, classes, sections, subjects] = await Promise.all([
      academics.listYears(),
      academics.listClasses(),
      academics.listSections({ academicYearId: year.id }),
      academics.listSubjects({ academicYearId: year.id }),
    ]);
    const allUsers = await users.all();
    return ok(res, {
      currentYear: year,
      years,
      classes,
      sections,
      subjects,
      teachers: allUsers
        .filter((u) => u.status === 'active')
        .map((u) => ({ id: u.id, name: u.name, roleKey: u.roleKey })),
    });
  })
);

module.exports = { router };
