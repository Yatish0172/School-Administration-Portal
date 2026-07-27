'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const settings = require('./settings');
const errors = require('../errors');

/**
 * Academic structure (SPEC §8). Everything academic hangs off StudentEnrollment
 * (student + academic year + class + section), never directly off Student —
 * getting this wrong forces a rewrite at year rollover.
 */

const WB = 'Academics';

/* --------------------------------------------------------- academic years */

async function listYears() {
  const rows = await workbook.read(WB, 'AcademicYears');
  return rows.slice().sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
}

async function currentYear() {
  const rows = await workbook.read(WB, 'AcademicYears');
  const flagged = rows.find((r) => r.isCurrent);
  if (flagged) return flagged;
  // Fall back to the newest open year so a fresh install is still usable.
  const open = rows.filter((r) => r.status !== 'closed');
  open.sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
  return open[0] || null;
}

async function requireCurrentYear() {
  const year = await currentYear();
  if (!year) {
    throw errors.badRequest(
      'No academic year has been set up yet. Create one under Settings → Academic Years.'
    );
  }
  return year;
}

async function getYear(id) {
  return crud.get(WB, 'AcademicYears', id);
}

/** Resolves a year from a request parameter, falling back to the current year. */
async function resolveYear(yearId) {
  if (yearId) {
    const year = await getYear(yearId);
    if (!year) throw errors.notFound('That academic year could not be found.');
    return year;
  }
  return requireCurrentYear();
}

function validateYearName(name) {
  if (!/^\d{4}-\d{2}$/.test(String(name || '').trim())) {
    throw errors.validation('Academic years are named like 2026-27.', {
      name: 'Use the format 2026-27.',
    });
  }
}

async function createYear(data, ctx) {
  validateYearName(data.name);
  const name = String(data.name).trim();
  const clash = await crud.findOne(WB, 'AcademicYears', (r) => r.name === name);
  if (clash) throw errors.validation('That academic year already exists.', { name: 'Already exists.' });
  if (!data.startDate || !data.endDate) {
    throw errors.validation('Set the start and end dates for the year.', {
      startDate: !data.startDate ? 'Required.' : undefined,
      endDate: !data.endDate ? 'Required.' : undefined,
    });
  }
  if (data.endDate <= data.startDate) {
    throw errors.validation('The year must end after it starts.', {
      endDate: 'Must be after the start date.',
    });
  }

  const existing = await workbook.read(WB, 'AcademicYears');
  const isFirst = existing.length === 0;

  const row = await crud.create(
    WB,
    'AcademicYears',
    {
      name,
      startDate: data.startDate,
      endDate: data.endDate,
      isCurrent: isFirst,
      status: 'open',
    },
    ctx,
    { label: 'create academic year' }
  );
  if (isFirst) await settings.set('system.currentAcademicYearId', row.id, ctx);
  return row;
}

async function setCurrentYear(id, ctx) {
  const year = await crud.getOrFail(WB, 'AcademicYears', id, 'academic year');
  if (year.status === 'closed') {
    throw errors.badRequest('That year is closed. Reopen it before making it current.');
  }
  await workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('AcademicYears');
      for (let i = 0; i < rows.length; i += 1) {
        const shouldBeCurrent = rows[i].id === id;
        if (!!rows[i].isCurrent === shouldBeCurrent) continue;
        rows[i] = {
          ...rows[i],
          isCurrent: shouldBeCurrent,
          _rev: Number(rows[i]._rev || 1) + 1,
          updatedBy: crud.actorOf(ctx),
          updatedAt: crud.nowIso(),
        };
      }
    },
    { label: 'set current year' }
  );
  await settings.set('system.currentAcademicYearId', id, ctx);
  return year;
}

/** Closing a year keeps it readable forever; it only stops new writes. */
async function closeYear(id, ctx) {
  const year = await crud.getOrFail(WB, 'AcademicYears', id, 'academic year');
  if (year.isCurrent) {
    throw errors.badRequest(
      'Make another year current before closing this one — the portal needs a current year.'
    );
  }
  return crud.update(WB, 'AcademicYears', id, { status: 'closed' }, ctx, { label: 'academic year' });
}

async function reopenYear(id, ctx) {
  return crud.update(WB, 'AcademicYears', id, { status: 'open' }, ctx, { label: 'academic year' });
}

async function assertYearOpen(yearId) {
  const year = await getYear(yearId);
  if (year && year.status === 'closed') {
    throw errors.locked(
      `${year.name} is closed. Records from a closed year can be read and printed but not changed.`
    );
  }
  return year;
}

/* ---------------------------------------------------------------- classes */

async function listClasses(options = {}) {
  const rows = await workbook.read(WB, 'Classes');
  const filtered = options.includeInactive ? rows.slice() : rows.filter((r) => r.status !== 'inactive');
  return filtered.sort(
    (a, b) =>
      Number(a.sortOrder || 0) - Number(b.sortOrder || 0) ||
      crud.compareValues(a.name, b.name)
  );
}

async function createClass(data, ctx) {
  if (!data.name) throw errors.validation('Enter a class name.', { name: 'Required.' });
  const name = String(data.name).trim();
  const clash = await crud.findOne(WB, 'Classes', (r) => r.name === name && r.status !== 'inactive');
  if (clash) throw errors.validation('That class already exists.', { name: 'Already exists.' });
  return crud.create(
    WB,
    'Classes',
    {
      name,
      level: data.level ?? null,
      sortOrder: data.sortOrder ?? 0,
      stream: data.stream || null,
      status: 'active',
    },
    ctx,
    { label: 'create class' }
  );
}

async function updateClass(id, patch, ctx, options = {}) {
  return crud.update(WB, 'Classes', id, patch, ctx, {
    expectedRev: options.expectedRev,
    label: 'class',
  });
}

/* --------------------------------------------------------------- sections */

async function listSections(options = {}) {
  const { academicYearId = null, classId = null, includeInactive = false } = options;
  const rows = await workbook.read(WB, 'Sections');
  return rows
    .filter((row) => {
      if (academicYearId && row.academicYearId !== academicYearId) return false;
      if (classId && row.classId !== classId) return false;
      if (!includeInactive && row.status === 'inactive') return false;
      return true;
    })
    .sort((a, b) => crud.compareValues(a.name, b.name));
}

async function createSection(data, ctx) {
  await assertYearOpen(data.academicYearId);
  if (!data.classId) throw errors.validation('Choose a class.', { classId: 'Required.' });
  if (!data.name) throw errors.validation('Enter a section name.', { name: 'Required.' });
  const clash = await crud.findOne(
    WB,
    'Sections',
    (r) =>
      r.classId === data.classId &&
      r.academicYearId === data.academicYearId &&
      String(r.name).toLowerCase() === String(data.name).trim().toLowerCase() &&
      r.status !== 'inactive'
  );
  if (clash) {
    throw errors.validation('That section already exists for this class and year.', {
      name: 'Already exists.',
    });
  }
  return crud.create(
    WB,
    'Sections',
    {
      classId: data.classId,
      academicYearId: data.academicYearId,
      name: String(data.name).trim(),
      capacity: data.capacity ?? null,
      classTeacherId: data.classTeacherId || null,
      roomNo: data.roomNo || null,
      status: 'active',
    },
    ctx,
    { label: 'create section' }
  );
}

async function updateSection(id, patch, ctx, options = {}) {
  const section = await crud.getOrFail(WB, 'Sections', id, 'section');
  await assertYearOpen(section.academicYearId);
  return crud.update(WB, 'Sections', id, patch, ctx, {
    expectedRev: options.expectedRev,
    label: 'section',
  });
}

async function sectionOccupancy(academicYearId) {
  const enrollments = await workbook.read(WB, 'StudentEnrollments');
  const counts = new Map();
  for (const row of enrollments) {
    if (row.academicYearId !== academicYearId) continue;
    if (row.status !== 'active') continue;
    counts.set(row.sectionId, (counts.get(row.sectionId) || 0) + 1);
  }
  return counts;
}

/* --------------------------------------------------------------- subjects */

async function listSubjects(options = {}) {
  const { academicYearId = null, classId = null, includeInactive = false } = options;
  const rows = await workbook.read(WB, 'Subjects');
  return rows
    .filter((row) => {
      if (academicYearId && row.academicYearId !== academicYearId) return false;
      if (classId && row.classId !== classId) return false;
      if (!includeInactive && row.status === 'inactive') return false;
      return true;
    })
    .sort(
      (a, b) =>
        Number(a.sortOrder || 0) - Number(b.sortOrder || 0) ||
        crud.compareValues(a.name, b.name)
    );
}

async function createSubject(data, ctx) {
  await assertYearOpen(data.academicYearId);
  if (!data.classId) throw errors.validation('Choose a class.', { classId: 'Required.' });
  if (!data.name) throw errors.validation('Enter a subject name.', { name: 'Required.' });
  const maxMarks = Number(data.maxMarks ?? 100);
  const passMarks = Number(data.passMarks ?? 33);
  if (passMarks > maxMarks) {
    throw errors.validation('Pass marks cannot be higher than maximum marks.', {
      passMarks: 'Lower than maximum marks.',
    });
  }
  return crud.create(
    WB,
    'Subjects',
    {
      classId: data.classId,
      academicYearId: data.academicYearId,
      name: String(data.name).trim(),
      code: data.code || null,
      type: data.type || 'core',
      mode: data.mode || 'theory',
      maxMarks,
      passMarks,
      sortOrder: data.sortOrder ?? 0,
      status: 'active',
    },
    ctx,
    { label: 'create subject' }
  );
}

async function updateSubject(id, patch, ctx, options = {}) {
  return crud.update(WB, 'Subjects', id, patch, ctx, {
    expectedRev: options.expectedRev,
    label: 'subject',
  });
}

/** Copies a year's subjects into another year so setup is not retyped annually. */
async function copySubjects(fromYearId, toYearId, ctx) {
  await assertYearOpen(toYearId);
  const source = await listSubjects({ academicYearId: fromYearId });
  const existing = await listSubjects({ academicYearId: toYearId });
  const seen = new Set(existing.map((s) => `${s.classId}|${String(s.name).toLowerCase()}`));
  const toCreate = source.filter(
    (s) => !seen.has(`${s.classId}|${String(s.name).toLowerCase()}`)
  );
  if (!toCreate.length) return [];
  return crud.createMany(
    WB,
    'Subjects',
    toCreate.map((s) => ({
      classId: s.classId,
      academicYearId: toYearId,
      name: s.name,
      code: s.code,
      type: s.type,
      mode: s.mode,
      maxMarks: s.maxMarks,
      passMarks: s.passMarks,
      sortOrder: s.sortOrder,
      status: 'active',
    })),
    ctx,
    { label: 'copy subjects' }
  );
}

/* ----------------------------------------------------- teacher assignments */

async function listAssignments(options = {}) {
  const {
    academicYearId = null,
    teacherUserId = null,
    sectionId = null,
    classId = null,
    subjectId = null,
    includeInactive = false,
  } = options;
  const rows = await workbook.read(WB, 'TeacherAssignments');
  return rows.filter((row) => {
    if (academicYearId && row.academicYearId !== academicYearId) return false;
    if (teacherUserId && row.teacherUserId !== teacherUserId) return false;
    if (sectionId && row.sectionId !== sectionId) return false;
    if (classId && row.classId !== classId) return false;
    if (subjectId && row.subjectId !== subjectId) return false;
    if (!includeInactive && row.status === 'inactive') return false;
    return true;
  });
}

async function createAssignment(data, ctx) {
  await assertYearOpen(data.academicYearId);
  for (const field of ['teacherUserId', 'classId', 'sectionId']) {
    if (!data[field]) {
      throw errors.validation('Choose a teacher, class and section.', { [field]: 'Required.' });
    }
  }
  const clash = await crud.findOne(
    WB,
    'TeacherAssignments',
    (r) =>
      r.academicYearId === data.academicYearId &&
      r.teacherUserId === data.teacherUserId &&
      r.sectionId === data.sectionId &&
      (r.subjectId || null) === (data.subjectId || null) &&
      r.status !== 'inactive'
  );
  if (clash) throw errors.badRequest('That teacher is already assigned to this section and subject.');

  const assignment = await crud.create(
    WB,
    'TeacherAssignments',
    {
      academicYearId: data.academicYearId,
      teacherUserId: data.teacherUserId,
      classId: data.classId,
      sectionId: data.sectionId,
      subjectId: data.subjectId || null,
      isClassTeacher: !!data.isClassTeacher,
      status: 'active',
    },
    ctx,
    { label: 'create assignment' }
  );

  // Keep Sections.classTeacherId in step — the section screen reads it directly.
  if (data.isClassTeacher) {
    await crud.update(
      WB,
      'Sections',
      data.sectionId,
      { classTeacherId: data.teacherUserId },
      ctx,
      { label: 'section' }
    );
  }
  return assignment;
}

async function removeAssignment(id, ctx) {
  return crud.update(WB, 'TeacherAssignments', id, { status: 'inactive' }, ctx, {
    label: 'assignment',
  });
}

/**
 * The scoping primitive: which sections may this user touch?
 * Used by permission.js so a class teacher is filtered server-side.
 */
async function sectionsForTeacher(userId, academicYearId) {
  const assignments = await listAssignments({ academicYearId, teacherUserId: userId });
  const sectionIds = new Set(assignments.map((a) => a.sectionId).filter(Boolean));
  // A class-teacher record on the section itself also counts.
  const sections = await listSections({ academicYearId });
  for (const section of sections) {
    if (section.classTeacherId === userId) sectionIds.add(section.id);
  }
  return [...sectionIds];
}

async function subjectsForTeacher(userId, academicYearId) {
  const assignments = await listAssignments({ academicYearId, teacherUserId: userId });
  return [...new Set(assignments.map((a) => a.subjectId).filter(Boolean))];
}

/* ------------------------------------------------------------ enrollments */

async function listEnrollments(options = {}) {
  const {
    academicYearId = null,
    sectionId = null,
    classId = null,
    studentId = null,
    status = 'active',
  } = options;
  const rows = await workbook.read(WB, 'StudentEnrollments');
  return rows.filter((row) => {
    if (academicYearId && row.academicYearId !== academicYearId) return false;
    if (sectionId && row.sectionId !== sectionId) return false;
    if (classId && row.classId !== classId) return false;
    if (studentId && row.studentId !== studentId) return false;
    if (status && row.status !== status) return false;
    return true;
  });
}

async function enrollmentFor(studentId, academicYearId) {
  return crud.findOne(
    WB,
    'StudentEnrollments',
    (r) => r.studentId === studentId && r.academicYearId === academicYearId && r.status === 'active'
  );
}

async function enrollmentHistory(studentId) {
  const rows = await workbook.read(WB, 'StudentEnrollments');
  return rows
    .filter((r) => r.studentId === studentId)
    .sort((a, b) => String(b.enrolledAt || '').localeCompare(String(a.enrolledAt || '')));
}

/** Applies in memory; caller holds the Academics lock. Used by admissions + import. */
function enrollIn(api, data, ctx) {
  const rows = api.rows('StudentEnrollments');
  const duplicate = rows.find(
    (r) =>
      r.studentId === data.studentId &&
      r.academicYearId === data.academicYearId &&
      r.status === 'active'
  );
  if (duplicate) {
    throw errors.badRequest('That student is already enrolled for this academic year.');
  }
  return crud.insertInto(
    api,
    WB,
    'StudentEnrollments',
    {
      studentId: data.studentId,
      academicYearId: data.academicYearId,
      classId: data.classId,
      sectionId: data.sectionId,
      rollNo: data.rollNo || null,
      status: 'active',
      promotedFromId: data.promotedFromId || null,
      enrolledAt: data.enrolledAt || crud.nowIso(),
    },
    ctx
  );
}

async function enroll(data, ctx) {
  await assertYearOpen(data.academicYearId);
  await assertSectionCapacity(data.sectionId, data.academicYearId);
  return workbook.mutate(WB, (api) => enrollIn(api, data, ctx), { label: 'enroll student' });
}

async function assertSectionCapacity(sectionId, academicYearId) {
  const section = await crud.get(WB, 'Sections', sectionId);
  if (!section || !section.capacity) return;
  const counts = await sectionOccupancy(academicYearId);
  const used = counts.get(sectionId) || 0;
  if (used >= Number(section.capacity)) {
    throw errors.badRequest(
      `That section is full (${used} of ${section.capacity}). Raise the capacity or choose another section.`
    );
  }
}

async function updateEnrollment(id, patch, ctx, options = {}) {
  const enrollment = await crud.getOrFail(WB, 'StudentEnrollments', id, 'enrollment');
  await assertYearOpen(enrollment.academicYearId);
  if (patch.sectionId && patch.sectionId !== enrollment.sectionId) {
    await assertSectionCapacity(patch.sectionId, enrollment.academicYearId);
  }
  return crud.update(WB, 'StudentEnrollments', id, patch, ctx, {
    expectedRev: options.expectedRev,
    label: 'enrollment',
  });
}

/** Next free roll number in a section, so the office does not have to hunt for one. */
async function nextRollNo(sectionId, academicYearId) {
  const rows = await listEnrollments({ sectionId, academicYearId, status: null });
  const used = rows
    .map((r) => Number(r.rollNo))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!used.length) return 1;
  return Math.max(...used) + 1;
}

/**
 * Bulk promotion at year rollover (SPEC §6). `mapping` is a list of
 * { fromSectionId, toClassId, toSectionId }, `exceptions` a list of studentIds to
 * hold back or exclude. Runs as one write per workbook.
 */
async function promoteBulk({ fromYearId, toYearId, mapping, exceptions = [], ctx }) {
  await assertYearOpen(toYearId);
  const holdBack = new Set(exceptions);
  const source = await listEnrollments({ academicYearId: fromYearId });

  const plan = [];
  for (const rule of mapping) {
    const cohort = source.filter((e) => e.sectionId === rule.fromSectionId);
    for (const enrollment of cohort) {
      if (holdBack.has(enrollment.studentId)) continue;
      plan.push({ enrollment, rule });
    }
  }

  return workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('StudentEnrollments');
      const created = [];
      const skipped = [];
      let rollCounters = new Map();

      for (const { enrollment, rule } of plan) {
        const already = rows.find(
          (r) =>
            r.studentId === enrollment.studentId &&
            r.academicYearId === toYearId &&
            r.status === 'active'
        );
        if (already) {
          skipped.push({ studentId: enrollment.studentId, reason: 'already enrolled' });
          continue;
        }
        const key = rule.toSectionId;
        if (!rollCounters.has(key)) {
          const used = rows
            .filter((r) => r.sectionId === key && r.academicYearId === toYearId)
            .map((r) => Number(r.rollNo))
            .filter((n) => Number.isFinite(n));
          rollCounters.set(key, used.length ? Math.max(...used) : 0);
        }
        const nextRoll = rollCounters.get(key) + 1;
        rollCounters.set(key, nextRoll);

        created.push(
          crud.insertInto(
            api,
            WB,
            'StudentEnrollments',
            {
              studentId: enrollment.studentId,
              academicYearId: toYearId,
              classId: rule.toClassId,
              sectionId: rule.toSectionId,
              rollNo: String(nextRoll),
              status: 'active',
              promotedFromId: enrollment.id,
              enrolledAt: crud.nowIso(),
            },
            ctx
          )
        );

        const index = rows.findIndex((r) => r.id === enrollment.id);
        if (index !== -1) {
          rows[index] = {
            ...rows[index],
            status: 'promoted',
            _rev: Number(rows[index]._rev || 1) + 1,
            updatedBy: crud.actorOf(ctx),
            updatedAt: crud.nowIso(),
          };
        }
      }
      return { promoted: created.length, skipped, heldBack: holdBack.size };
    },
    { label: 'bulk promotion' }
  );
}

/* ---------------------------------------------------------------- periods */

async function listPeriods(academicYearId) {
  const rows = await workbook.read(WB, 'Periods');
  return rows
    .filter((r) => r.academicYearId === academicYearId)
    .sort((a, b) => Number(a.period || 0) - Number(b.period || 0));
}

async function setPeriods(academicYearId, periods, ctx) {
  await assertYearOpen(academicYearId);
  return workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('Periods');
      const kept = rows.filter((r) => r.academicYearId !== academicYearId);
      api.replace('Periods', kept);
      for (const period of periods) {
        crud.insertInto(
          api,
          WB,
          'Periods',
          {
            academicYearId,
            period: Number(period.period),
            label: period.label || `Period ${period.period}`,
            startTime: period.startTime || null,
            endTime: period.endTime || null,
            isBreak: !!period.isBreak,
          },
          ctx
        );
      }
      return periods.length;
    },
    { label: 'set periods' }
  );
}

/* -------------------------------------------------------------- timetable */

async function listTimetable(options = {}) {
  const { academicYearId, sectionId = null, teacherUserId = null } = options;
  const rows = await workbook.read(WB, 'Timetable');
  return rows.filter((row) => {
    if (academicYearId && row.academicYearId !== academicYearId) return false;
    if (sectionId && row.sectionId !== sectionId) return false;
    if (teacherUserId && row.teacherUserId !== teacherUserId) return false;
    if (row.status === 'inactive') return false;
    return true;
  });
}

/**
 * A teacher in two rooms at once is the classic timetable bug, so the clash check
 * runs inside the same lock as the write.
 */
function findClash(rows, entry, ignoreId = null) {
  return rows.find(
    (row) =>
      row.id !== ignoreId &&
      row.status !== 'inactive' &&
      row.academicYearId === entry.academicYearId &&
      Number(row.day) === Number(entry.day) &&
      Number(row.period) === Number(entry.period) &&
      row.teacherUserId &&
      row.teacherUserId === entry.teacherUserId &&
      row.sectionId !== entry.sectionId
  );
}

async function setTimetableSlot(entry, ctx) {
  await assertYearOpen(entry.academicYearId);
  return workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('Timetable');
      const existing = rows.find(
        (r) =>
          r.academicYearId === entry.academicYearId &&
          r.sectionId === entry.sectionId &&
          Number(r.day) === Number(entry.day) &&
          Number(r.period) === Number(entry.period) &&
          r.status !== 'inactive'
      );

      if (entry.teacherUserId) {
        const clash = findClash(rows, entry, existing?.id);
        if (clash) {
          throw errors.badRequest(
            'That teacher is already taking another section in this period. Pick a different period or teacher.'
          );
        }
      }

      const payload = {
        academicYearId: entry.academicYearId,
        sectionId: entry.sectionId,
        classId: entry.classId,
        day: Number(entry.day),
        period: Number(entry.period),
        subjectId: entry.subjectId || null,
        teacherUserId: entry.teacherUserId || null,
        roomNo: entry.roomNo || null,
        status: 'active',
      };

      if (!entry.subjectId && !entry.teacherUserId && existing) {
        // Clearing a slot.
        return crud.updateIn(api, WB, 'Timetable', existing.id, { status: 'inactive' }, ctx, {
          label: 'timetable slot',
        });
      }
      if (existing) {
        return crud.updateIn(api, WB, 'Timetable', existing.id, payload, ctx, {
          label: 'timetable slot',
        });
      }
      return crud.insertInto(api, WB, 'Timetable', payload, ctx);
    },
    { label: 'set timetable slot' }
  );
}

async function listSubstitutions(options = {}) {
  const { date = null, sectionId = null, substituteTeacherId = null } = options;
  const rows = await workbook.read(WB, 'TimetableSubstitutions');
  return rows.filter((row) => {
    if (date && row.date !== date) return false;
    if (sectionId && row.sectionId !== sectionId) return false;
    if (substituteTeacherId && row.substituteTeacherId !== substituteTeacherId) return false;
    return true;
  });
}

async function createSubstitution(data, ctx) {
  const slot = await crud.getOrFail(WB, 'Timetable', data.timetableId, 'timetable slot');
  if (!data.date) throw errors.validation('Choose a date.', { date: 'Required.' });
  const clash = await crud.findOne(
    WB,
    'TimetableSubstitutions',
    (r) => r.date === data.date && r.timetableId === data.timetableId
  );
  if (clash) throw errors.badRequest('A substitution is already recorded for that period.');
  return crud.create(
    WB,
    'TimetableSubstitutions',
    {
      date: data.date,
      timetableId: data.timetableId,
      sectionId: slot.sectionId,
      period: slot.period,
      originalTeacherId: slot.teacherUserId,
      substituteTeacherId: data.substituteTeacherId,
      reason: data.reason || null,
    },
    ctx,
    { label: 'create substitution' }
  );
}

module.exports = {
  WB,
  listYears,
  currentYear,
  requireCurrentYear,
  getYear,
  resolveYear,
  createYear,
  setCurrentYear,
  closeYear,
  reopenYear,
  assertYearOpen,
  listClasses,
  createClass,
  updateClass,
  listSections,
  createSection,
  updateSection,
  sectionOccupancy,
  assertSectionCapacity,
  listSubjects,
  createSubject,
  updateSubject,
  copySubjects,
  listAssignments,
  createAssignment,
  removeAssignment,
  sectionsForTeacher,
  subjectsForTeacher,
  listEnrollments,
  enrollmentFor,
  enrollmentHistory,
  enroll,
  enrollIn,
  updateEnrollment,
  nextRollNo,
  promoteBulk,
  listPeriods,
  setPeriods,
  listTimetable,
  setTimetableSlot,
  listSubstitutions,
  createSubstitution,
};
