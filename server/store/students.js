'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const counters = require('./counters');
const journal = require('./journal');
const academics = require('./academics');
const errors = require('../errors');

/**
 * Students and guardians (SPEC §6).
 *
 * Never hard-delete: a student leaves by status change so fee history, marks and
 * attendance stay attached to a real record (CLAUDE.md data safety rules).
 */

const WB = 'Students';

const STATUSES = ['Active', 'TC Issued', 'Left', 'Alumni'];
const GENDERS = ['Male', 'Female', 'Other'];
const RELATIONS = ['father', 'mother', 'guardian'];

function fullName(student) {
  if (!student) return '';
  return [student.firstName, student.middleName, student.lastName]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ reading */

async function list(options = {}) {
  const {
    search = '',
    status = null,
    classId = null,
    sectionId = null,
    academicYearId = null,
    page = 1,
    pageSize = 50,
    sort = 'admissionNo',
    dir = 'asc',
  } = options;

  let allowedIds = null;
  if (classId || sectionId) {
    const year = await academics.resolveYear(academicYearId);
    const enrollments = await academics.listEnrollments({
      academicYearId: year.id,
      classId: classId || null,
      sectionId: sectionId || null,
    });
    allowedIds = new Set(enrollments.map((e) => e.studentId));
  }

  const term = String(search || '').trim().toLowerCase();
  let guardianMatches = null;
  if (term) {
    const guardians = await workbook.read(WB, 'Guardians');
    guardianMatches = new Set(
      guardians
        .filter(
          (g) =>
            String(g.name || '').toLowerCase().includes(term) ||
            String(g.phone || '').toLowerCase().includes(term)
        )
        .map((g) => g.studentId)
    );
  }

  const result = await crud.list(WB, 'Students', {
    where: (row) => {
      if (status && row.status !== status) return false;
      if (allowedIds && !allowedIds.has(row.id)) return false;
      if (term) {
        const haystack = [
          fullName(row),
          row.admissionNo,
          row.aadhaar,
          row.city,
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(term) && !guardianMatches.has(row.id)) return false;
      }
      return true;
    },
    sort,
    dir,
    page,
    pageSize,
  });

  return { ...result, rows: result.rows.map(decorate) };
}

function decorate(student) {
  return { ...student, fullName: fullName(student) };
}

async function get(id) {
  const student = await crud.get(WB, 'Students', id);
  return student ? decorate(student) : null;
}

async function getOrFail(id) {
  const student = await get(id);
  if (!student) throw errors.notFound('That student could not be found.');
  return student;
}

async function getByAdmissionNo(admissionNo) {
  if (!admissionNo) return null;
  const target = String(admissionNo).trim().toLowerCase();
  const row = await crud.findOne(
    WB,
    'Students',
    (r) => String(r.admissionNo || '').toLowerCase() === target
  );
  return row ? decorate(row) : null;
}

async function guardiansFor(studentId) {
  const rows = await workbook.read(WB, 'Guardians');
  return rows
    .filter((r) => r.studentId === studentId)
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return RELATIONS.indexOf(a.relation) - RELATIONS.indexOf(b.relation);
    });
}

async function primaryGuardian(studentId) {
  const guardians = await guardiansFor(studentId);
  return guardians.find((g) => g.isPrimary) || guardians[0] || null;
}

/** Full profile for the student screen: student + guardians + enrollment history. */
async function profile(id) {
  const student = await getOrFail(id);
  const [guardians, history, documents] = await Promise.all([
    guardiansFor(id),
    academics.enrollmentHistory(id),
    documentsFor(id),
  ]);
  const year = await academics.currentYear();
  const currentEnrollment = year ? await academics.enrollmentFor(id, year.id) : null;
  return { student, guardians, enrollments: history, currentEnrollment, documents };
}

async function documentsFor(studentId) {
  const rows = await workbook.read(WB, 'StudentDocuments');
  return rows
    .filter((r) => r.studentId === studentId)
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
}

/* --------------------------------------------------------------- validation */

function validate(data, { existing = null } = {}) {
  const fields = {};
  if (!data.firstName || !String(data.firstName).trim()) {
    fields.firstName = 'Enter the first name.';
  }
  if (!data.lastName || !String(data.lastName).trim()) {
    fields.lastName = 'Enter the last name.';
  }
  if (data.dob && !/^\d{4}-\d{2}-\d{2}$/.test(data.dob)) {
    fields.dob = 'Use the date picker, or type the date as YYYY-MM-DD.';
  }
  if (data.dob && data.dob > new Date().toISOString().slice(0, 10)) {
    fields.dob = 'A date of birth cannot be in the future.';
  }
  if (data.gender && !GENDERS.includes(data.gender)) {
    fields.gender = 'Choose Male, Female or Other.';
  }
  if (data.aadhaar && !/^\d{12}$/.test(String(data.aadhaar).replace(/\s/g, ''))) {
    fields.aadhaar = 'An Aadhaar number is 12 digits, or leave it blank.';
  }
  if (data.status && !STATUSES.includes(data.status)) {
    fields.status = 'Choose a valid status.';
  }
  if (Object.keys(fields).length) {
    throw errors.validation('Some details need fixing before this can be saved.', fields);
  }
}

function validateGuardians(guardians) {
  if (!Array.isArray(guardians) || guardians.length === 0) {
    throw errors.validation('Add at least one guardian with a contact number.', {
      guardians: 'At least one guardian is required.',
    });
  }
  const fields = {};
  let hasPhone = false;
  guardians.forEach((guardian, index) => {
    if (!guardian.name || !String(guardian.name).trim()) {
      fields[`guardians.${index}.name`] = 'Enter a name.';
    }
    if (guardian.phone) {
      if (!/^[0-9+\-\s]{6,15}$/.test(String(guardian.phone))) {
        fields[`guardians.${index}.phone`] = 'Enter a valid phone number.';
      } else {
        hasPhone = true;
      }
    }
    if (guardian.relation && !RELATIONS.includes(guardian.relation)) {
      fields[`guardians.${index}.relation`] = 'Choose father, mother or guardian.';
    }
  });
  if (!hasPhone) {
    fields.guardians = 'At least one guardian needs a phone number the office can call.';
  }
  if (Object.keys(fields).length) {
    throw errors.validation('Check the guardian details.', fields);
  }
}

/* ------------------------------------------------------------------ writing */

/**
 * Highest roll number in a section, plus one. Takes the rows it is given rather
 * than reading them itself, so the caller can compute this while holding the
 * Academics lock.
 */
function nextRollFrom(enrollmentRows, sectionId, academicYearId) {
  const used = enrollmentRows
    .filter((row) => row.sectionId === sectionId && row.academicYearId === academicYearId)
    .map((row) => Number(row.rollNo))
    .filter((value) => Number.isFinite(value) && value > 0);
  return used.length ? Math.max(...used) + 1 : 1;
}

/**
 * Admission: creates the student, their guardians and (optionally) the enrollment
 * for the current year, allocating the admission number from Counters.
 *
 * Touches Students, System and Academics, so it runs through the journal — a
 * failure part-way must not leave a student with no enrollment and a burnt
 * admission number (CLAUDE.md §9).
 */
async function admit({ student, guardians, enrollment }, ctx) {
  validate(student);
  validateGuardians(guardians);

  const year = enrollment ? await academics.resolveYear(enrollment.academicYearId) : null;
  if (year) {
    await academics.assertYearOpen(year.id);
    if (!enrollment.classId || !enrollment.sectionId) {
      throw errors.validation('Choose the class and section for this admission.', {
        classId: !enrollment.classId ? 'Required.' : undefined,
        sectionId: !enrollment.sectionId ? 'Required.' : undefined,
      });
    }
    await academics.assertSectionCapacity(enrollment.sectionId, year.id);
  }

  if (student.admissionNo) {
    const clash = await getByAdmissionNo(student.admissionNo);
    if (clash) {
      throw errors.validation('That admission number is already used.', {
        admissionNo: 'Already used.',
      });
    }
  }

  const books = ['Students', 'System'];
  if (year) books.push('Academics');

  return journal.runJournaled(
    books,
    async (api) => {
      const admissionNo =
        student.admissionNo || counters.nextIn(api.System, 'admissionNo', ctx).formatted;

      const created = crud.insertInto(
        api.Students,
        WB,
        'Students',
        {
          ...student,
          admissionNo,
          status: student.status || 'Active',
          admissionDate: student.admissionDate || new Date().toISOString().slice(0, 10),
        },
        ctx
      );

      for (const guardian of guardians) {
        crud.insertInto(
          api.Students,
          WB,
          'Guardians',
          { ...guardian, studentId: created.id, isPrimary: !!guardian.isPrimary },
          ctx
        );
      }

      let enrolled = null;
      if (year) {
        // A blank roll number means "the next free one", which the admission form
        // promises. Computed inside the lock from the rows we already hold, so two
        // simultaneous admissions into one section cannot be given the same number.
        const rollNo =
          enrollment.rollNo ||
          String(
            nextRollFrom(
              api.Academics.rows('StudentEnrollments'),
              enrollment.sectionId,
              year.id
            )
          );

        enrolled = academics.enrollIn(
          api.Academics,
          {
            studentId: created.id,
            academicYearId: year.id,
            classId: enrollment.classId,
            sectionId: enrollment.sectionId,
            rollNo,
          },
          ctx
        );
      }

      return { student: decorate(created), enrollment: enrolled };
    },
    { label: 'admit student' }
  );
}

async function update(id, patch, ctx, options = {}) {
  const current = await crud.getOrFail(WB, 'Students', id, 'student');
  validate({ ...current, ...crud.defined(patch) }, { existing: current });

  if (patch.admissionNo && patch.admissionNo !== current.admissionNo) {
    const clash = await getByAdmissionNo(patch.admissionNo);
    if (clash && clash.id !== id) {
      throw errors.validation('That admission number is already used.', {
        admissionNo: 'Already used.',
      });
    }
  }

  const clean = { ...patch };
  delete clean.status; // status changes go through setStatus so they are audited properly
  const result = await crud.update(WB, 'Students', id, clean, ctx, {
    expectedRev: options.expectedRev,
    label: 'student',
  });
  return { before: result.before, after: decorate(result.after) };
}

async function replaceGuardians(studentId, guardians, ctx) {
  validateGuardians(guardians);
  await crud.getOrFail(WB, 'Students', studentId, 'student');
  return workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('Guardians');
      const before = rows.filter((r) => r.studentId === studentId);
      api.replace(
        'Guardians',
        rows.filter((r) => r.studentId !== studentId)
      );
      const after = guardians.map((guardian) =>
        crud.insertInto(
          api,
          WB,
          'Guardians',
          { ...guardian, studentId, isPrimary: !!guardian.isPrimary },
          ctx
        )
      );
      return { before, after };
    },
    { label: 'replace guardians' }
  );
}

/**
 * Status change instead of deletion. Setting TC Issued or Left also closes the
 * active enrollment so class lists and attendance stop including the student.
 */
async function setStatus(id, status, { reason = null, date = null, tcNumber = null } = {}, ctx) {
  if (!STATUSES.includes(status)) {
    throw errors.badRequest(`A student status must be one of: ${STATUSES.join(', ')}.`);
  }
  const student = await crud.getOrFail(WB, 'Students', id, 'student');
  const year = await academics.currentYear();
  const enrollment = year ? await academics.enrollmentFor(id, year.id) : null;

  const books = ['Students'];
  if (enrollment) books.push('Academics');

  return journal.runJournaled(
    books,
    async (api) => {
      const patch = { status };
      if (status === 'TC Issued') {
        patch.tcNumber = tcNumber || student.tcNumber;
        patch.tcDate = date || new Date().toISOString().slice(0, 10);
        patch.leftDate = date || new Date().toISOString().slice(0, 10);
      }
      if (status === 'Left') {
        patch.leftDate = date || new Date().toISOString().slice(0, 10);
      }
      if (reason) patch.remarks = `${student.remarks ? `${student.remarks}\n` : ''}${reason}`;

      const result = crud.updateIn(api.Students, WB, 'Students', id, patch, ctx, {
        label: 'student',
      });

      if (enrollment && status !== 'Active') {
        crud.updateIn(
          api.Academics,
          'Academics',
          'StudentEnrollments',
          enrollment.id,
          { status: status === 'TC Issued' ? 'tc' : 'left', leftReason: reason || status },
          ctx,
          { label: 'enrollment' }
        );
      }

      return { before: result.before, after: decorate(result.after) };
    },
    { label: 'student status change' }
  );
}

/** Allocates the next TC number and marks the student TC Issued in one write. */
async function issueTransferCertificate(id, { reason, date }, ctx) {
  const student = await crud.getOrFail(WB, 'Students', id, 'student');
  if (student.status === 'TC Issued') {
    throw errors.badRequest('A transfer certificate has already been issued for this student.');
  }
  const tc = await counters.next('tcNumber', ctx);
  const result = await setStatus(
    id,
    'TC Issued',
    { reason, date, tcNumber: tc.formatted },
    ctx
  );
  return { ...result, tcNumber: tc.formatted };
}

/* ------------------------------------------------------- documents metadata */

async function addDocument(studentId, meta, ctx) {
  await crud.getOrFail(WB, 'Students', studentId, 'student');
  return crud.create(
    WB,
    'StudentDocuments',
    {
      studentId,
      docType: meta.docType || 'Other',
      title: meta.title || meta.originalName,
      storedName: meta.storedName,
      originalName: meta.originalName,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      uploadedAt: crud.nowIso(),
    },
    ctx,
    { label: 'add student document' }
  );
}

async function getDocument(documentId) {
  return crud.get(WB, 'StudentDocuments', documentId);
}

/** Documents are withdrawn by status, never deleted, so the audit trail holds. */
async function withdrawDocument(documentId, ctx) {
  return crud.update(WB, 'StudentDocuments', documentId, { docType: 'Withdrawn' }, ctx, {
    label: 'document',
  });
}

/* ------------------------------------------------------------------- counts */

async function counts() {
  const rows = await workbook.read(WB, 'Students');
  const byStatus = {};
  for (const status of STATUSES) byStatus[status] = 0;
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  }
  return { total: rows.length, byStatus };
}

/** Today's birthdays for the Front Office dashboard (SPEC §5). */
async function birthdaysToday(monthDay) {
  const rows = await workbook.read(WB, 'Students');
  return rows
    .filter((r) => r.status === 'Active' && r.dob && r.dob.slice(5) === monthDay)
    .map(decorate);
}

module.exports = {
  WB,
  STATUSES,
  GENDERS,
  RELATIONS,
  fullName,
  decorate,
  list,
  get,
  getOrFail,
  getByAdmissionNo,
  guardiansFor,
  primaryGuardian,
  profile,
  documentsFor,
  validate,
  validateGuardians,
  admit,
  update,
  replaceGuardians,
  setStatus,
  issueTransferCertificate,
  addDocument,
  getDocument,
  withdrawDocument,
  counts,
  birthdaysToday,
};
