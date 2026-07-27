'use strict';

const fsp = require('fs/promises');
const path = require('path');

const workbook = require('./workbook');
const crud = require('./crud');
const counters = require('./counters');
const journal = require('./journal');
const exporter = require('./exporter');
const academics = require('./academics');
const students = require('./students');
const errors = require('../errors');
const { paths } = require('../paths');

/**
 * Excel import (SPEC §15). Validate, show the office every bad row, write nothing
 * until they approve.
 *
 * Schools hand over spreadsheets with merged cells, dates stored as text and three
 * students sharing an admission number. None of that may reach the data files.
 */

const WB = 'Imports';
const TEMPLATE_VERSION = 'students-v1';

const STUDENT_COLUMNS = [
  { key: 'admissionNo', label: 'Admission No', hint: 'Leave blank to auto-generate' },
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'middleName', label: 'Middle Name' },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'dob', label: 'Date of Birth', hint: 'YYYY-MM-DD' },
  { key: 'gender', label: 'Gender', hint: 'Male, Female or Other' },
  { key: 'bloodGroup', label: 'Blood Group' },
  { key: 'category', label: 'Category' },
  { key: 'className', label: 'Class', required: true, hint: 'Must already exist' },
  { key: 'sectionName', label: 'Section', required: true, hint: 'Must already exist' },
  { key: 'rollNo', label: 'Roll No' },
  { key: 'admissionDate', label: 'Admission Date', hint: 'YYYY-MM-DD' },
  { key: 'fatherName', label: 'Father Name' },
  { key: 'fatherPhone', label: 'Father Phone' },
  { key: 'motherName', label: 'Mother Name' },
  { key: 'motherPhone', label: 'Mother Phone' },
  { key: 'guardianName', label: 'Guardian Name' },
  { key: 'guardianPhone', label: 'Guardian Phone' },
  { key: 'permanentAddress', label: 'Address', width: 32 },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'pincode', label: 'PIN Code' },
  { key: 'aadhaar', label: 'Aadhaar' },
];

const LABEL_TO_KEY = new Map(STUDENT_COLUMNS.map((c) => [c.label.toLowerCase(), c.key]));

async function template() {
  return exporter.buildTemplate({
    title: 'Student import template',
    version: TEMPLATE_VERSION,
    columns: STUDENT_COLUMNS,
    example: {
      admissionNo: '',
      firstName: 'Aarav',
      middleName: 'Kumar',
      lastName: 'Sharma',
      dob: '2015-04-23',
      gender: 'Male',
      bloodGroup: 'B+',
      category: 'General',
      className: 'Grade 5',
      sectionName: 'A',
      rollNo: '12',
      admissionDate: '2026-04-01',
      fatherName: 'Rajesh Sharma',
      fatherPhone: '9876543210',
      motherName: 'Priya Sharma',
      motherPhone: '9876543211',
      guardianName: '',
      guardianPhone: '',
      permanentAddress: '14 Nehru Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      aadhaar: '',
    },
    notes: [
      'Class and Section must already exist in the portal for the academic year you are importing into.',
      'At least one guardian phone number is required per student.',
      'Admission numbers left blank are generated automatically in sequence.',
      'A duplicate admission number stops that row only — the rest still import.',
    ],
  });
}

/* ---------------------------------------------------------------- batches */

async function listBatches(limit = 30) {
  const rows = await workbook.read(WB, 'ImportBatches');
  return rows
    .slice()
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))
    .slice(0, limit);
}

async function getBatch(id) {
  return crud.getOrFail(WB, 'ImportBatches', id, 'import batch');
}

async function batchErrors(batchId) {
  const rows = await workbook.read(WB, 'ImportErrors');
  return rows
    .filter((r) => r.batchId === batchId)
    .sort((a, b) => Number(a.rowNumber || 0) - Number(b.rowNumber || 0));
}

/* -------------------------------------------------------------- validation */

function normaliseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  // Dates stored as text in dd/mm/yyyy or dd-mm-yyyy, which is what schools send.
  const match = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (match) {
    const [, d, m, y] = match;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

function mapHeaders(headers) {
  const mapping = new Map();
  const unknown = [];
  for (const header of headers) {
    const key = LABEL_TO_KEY.get(String(header).trim().toLowerCase());
    if (key) mapping.set(header, key);
    else unknown.push(header);
  }
  return { mapping, unknown };
}

/**
 * Parses and checks the uploaded file. Writes an ImportBatch and its ImportErrors
 * but no student data — that only happens on commit.
 */
async function validateUpload({ filePath, originalName, storedName, academicYearId }, ctx) {
  const year = await academics.resolveYear(academicYearId);
  const parsed = await exporter.readUpload(filePath).catch((err) => {
    throw errors.badRequest(`That file could not be read: ${err.message}`);
  });

  const { mapping, unknown } = mapHeaders(parsed.headers);
  const missingRequired = STUDENT_COLUMNS.filter(
    (column) => column.required && ![...mapping.values()].includes(column.key)
  );
  if (missingRequired.length) {
    throw errors.badRequest(
      `The file is missing required columns: ${missingRequired
        .map((c) => c.label)
        .join(', ')}. Download the template and use that.`
    );
  }

  const [classes, sections, existingStudents] = await Promise.all([
    academics.listClasses(),
    academics.listSections({ academicYearId: year.id }),
    workbook.read(students.WB, 'Students'),
  ]);
  const classByName = new Map(classes.map((c) => [String(c.name).toLowerCase(), c]));
  const sectionKey = (classId, name) => `${classId}|${String(name).toLowerCase()}`;
  const sectionByKey = new Map(sections.map((s) => [sectionKey(s.classId, s.name), s]));
  const existingAdmissionNos = new Set(
    existingStudents.map((s) => String(s.admissionNo || '').toLowerCase()).filter(Boolean)
  );

  const seenAdmissionNos = new Set();
  const problems = [];
  const valid = [];

  for (const row of parsed.rows) {
    const record = {};
    for (const [header, key] of mapping) {
      record[key] = row.values[header] ?? null;
    }

    const rowProblems = [];
    const add = (column, value, message, severity = 'error') =>
      rowProblems.push({ rowNumber: row.rowNumber, column, value, message, severity });

    for (const column of STUDENT_COLUMNS) {
      if (column.required && !record[column.key]) {
        add(column.label, '', `${column.label} is required.`);
      }
    }

    const dob = normaliseDate(record.dob);
    if (record.dob && !dob) add('Date of Birth', record.dob, 'Could not read this date. Use YYYY-MM-DD.');
    if (dob && dob > new Date().toISOString().slice(0, 10)) {
      add('Date of Birth', record.dob, 'Date of birth is in the future.');
    }
    const admissionDate = normaliseDate(record.admissionDate);
    if (record.admissionDate && !admissionDate) {
      add('Admission Date', record.admissionDate, 'Could not read this date. Use YYYY-MM-DD.');
    }

    if (record.gender && !students.GENDERS.includes(record.gender)) {
      add('Gender', record.gender, 'Use Male, Female or Other.', 'warning');
      record.gender = null;
    }

    if (record.admissionNo) {
      const key = String(record.admissionNo).toLowerCase();
      if (existingAdmissionNos.has(key)) {
        add('Admission No', record.admissionNo, 'A student with this admission number already exists.');
      }
      if (seenAdmissionNos.has(key)) {
        add('Admission No', record.admissionNo, 'This admission number appears more than once in the file.');
      }
      seenAdmissionNos.add(key);
    }

    const klass = record.className ? classByName.get(String(record.className).toLowerCase()) : null;
    if (record.className && !klass) {
      add('Class', record.className, 'No class with that name. Create it first, or fix the spelling.');
    }
    const section =
      klass && record.sectionName ? sectionByKey.get(sectionKey(klass.id, record.sectionName)) : null;
    if (klass && record.sectionName && !section) {
      add(
        'Section',
        record.sectionName,
        `No section "${record.sectionName}" in ${klass.name} for ${year.name}.`
      );
    }

    const phones = [record.fatherPhone, record.motherPhone, record.guardianPhone].filter(Boolean);
    if (!phones.length) {
      add('Father Phone', '', 'At least one guardian phone number is needed.');
    }
    for (const [label, phone] of [
      ['Father Phone', record.fatherPhone],
      ['Mother Phone', record.motherPhone],
      ['Guardian Phone', record.guardianPhone],
    ]) {
      if (phone && !/^[0-9+\-\s]{6,15}$/.test(String(phone))) {
        add(label, phone, 'That does not look like a phone number.');
      }
    }
    if (record.aadhaar && !/^\d{12}$/.test(String(record.aadhaar).replace(/\s/g, ''))) {
      add('Aadhaar', record.aadhaar, 'An Aadhaar number is 12 digits.', 'warning');
      record.aadhaar = null;
    }

    if (rowProblems.some((p) => p.severity === 'error')) {
      problems.push(...rowProblems);
      continue;
    }
    problems.push(...rowProblems.filter((p) => p.severity === 'warning'));

    valid.push({
      rowNumber: row.rowNumber,
      student: {
        admissionNo: record.admissionNo || null,
        firstName: record.firstName,
        middleName: record.middleName,
        lastName: record.lastName,
        dob,
        gender: record.gender,
        bloodGroup: record.bloodGroup,
        category: record.category,
        admissionDate: admissionDate || new Date().toISOString().slice(0, 10),
        permanentAddress: record.permanentAddress,
        city: record.city,
        state: record.state,
        pincode: record.pincode,
        aadhaar: record.aadhaar ? String(record.aadhaar).replace(/\s/g, '') : null,
        status: 'Active',
      },
      guardians: [
        record.fatherName && {
          relation: 'father',
          name: record.fatherName,
          phone: record.fatherPhone,
          isPrimary: true,
        },
        record.motherName && {
          relation: 'mother',
          name: record.motherName,
          phone: record.motherPhone,
          isPrimary: !record.fatherName,
        },
        record.guardianName && {
          relation: 'guardian',
          name: record.guardianName,
          phone: record.guardianPhone,
          isPrimary: !record.fatherName && !record.motherName,
        },
      ].filter(Boolean),
      enrollment: {
        academicYearId: year.id,
        classId: klass.id,
        sectionId: section.id,
        rollNo: record.rollNo ? String(record.rollNo) : null,
      },
    });
  }

  const errorRows = new Set(
    problems.filter((p) => p.severity === 'error').map((p) => p.rowNumber)
  ).size;

  const batch = await workbook.mutate(
    WB,
    (api) => {
      const created = crud.insertInto(
        api,
        WB,
        'ImportBatches',
        {
          kind: 'students',
          fileName: originalName,
          storedName,
          templateVersion: TEMPLATE_VERSION,
          uploadedBy: crud.actorOf(ctx),
          uploadedAt: crud.nowIso(),
          totalRows: parsed.rows.length,
          validRows: valid.length,
          errorRows,
          importedRows: 0,
          status: 'validated',
        },
        ctx
      );
      for (const problem of problems) {
        crud.insertInto(api, WB, 'ImportErrors', { ...problem, batchId: created.id }, ctx);
      }
      return created;
    },
    { label: 'record import batch' }
  );

  // The parsed plan is held on disk beside the upload, so committing does not
  // re-parse a file the office may have changed in the meantime.
  await fsp.writeFile(
    path.join(paths.temp, `${batch.id}.plan.json`),
    JSON.stringify({ batchId: batch.id, academicYearId: year.id, valid }),
    'utf8'
  );

  return {
    batch,
    totalRows: parsed.rows.length,
    validRows: valid.length,
    errorRows,
    unknownColumns: unknown,
    problems: problems.slice(0, 500),
    preview: valid.slice(0, 20),
  };
}

/**
 * Writes the validated rows. Runs through the journal because it touches Students,
 * Academics and the admission-number counter in System.
 */
async function commit(batchId, ctx) {
  const batch = await getBatch(batchId);
  if (batch.status === 'committed') {
    throw errors.badRequest('That import has already been committed.');
  }
  if (batch.status !== 'validated') {
    throw errors.badRequest('That import has not been validated. Upload the file again.');
  }

  const planPath = path.join(paths.temp, `${batchId}.plan.json`);
  let plan;
  try {
    plan = JSON.parse(await fsp.readFile(planPath, 'utf8'));
  } catch (err) {
    throw errors.badRequest(
      'The validated data for that import is no longer available. Upload the file again.'
    );
  }
  if (!plan.valid.length) throw errors.badRequest('There are no valid rows to import.');

  const result = await journal.runJournaled(
    ['Students', 'Academics', 'System', WB],
    async (api) => {
      let imported = 0;
      const failures = [];
      const rollCounters = new Map();

      for (const entry of plan.valid) {
        try {
          const admissionNo =
            entry.student.admissionNo ||
            counters.nextIn(api.System, 'admissionNo', ctx).formatted;

          const student = crud.insertInto(
            api.Students,
            'Students',
            'Students',
            { ...entry.student, admissionNo },
            ctx
          );
          for (const guardian of entry.guardians) {
            crud.insertInto(
              api.Students,
              'Students',
              'Guardians',
              { ...guardian, studentId: student.id },
              ctx
            );
          }

          let rollNo = entry.enrollment.rollNo;
          if (!rollNo) {
            const key = entry.enrollment.sectionId;
            if (!rollCounters.has(key)) {
              const used = api.Academics
                .rows('StudentEnrollments')
                .filter(
                  (r) =>
                    r.sectionId === key && r.academicYearId === entry.enrollment.academicYearId
                )
                .map((r) => Number(r.rollNo))
                .filter((n) => Number.isFinite(n));
              rollCounters.set(key, used.length ? Math.max(...used) : 0);
            }
            const next = rollCounters.get(key) + 1;
            rollCounters.set(key, next);
            rollNo = String(next);
          }

          academics.enrollIn(
            api.Academics,
            { ...entry.enrollment, studentId: student.id, rollNo },
            ctx
          );
          imported += 1;
        } catch (err) {
          failures.push({ rowNumber: entry.rowNumber, message: err.message });
        }
      }

      for (const failure of failures) {
        crud.insertInto(
          api[WB],
          WB,
          'ImportErrors',
          {
            batchId,
            rowNumber: failure.rowNumber,
            column: '',
            value: '',
            message: failure.message,
            severity: 'error',
          },
          ctx
        );
      }

      crud.updateIn(
        api[WB],
        WB,
        'ImportBatches',
        batchId,
        {
          status: 'committed',
          importedRows: imported,
          committedAt: crud.nowIso(),
          committedBy: crud.actorOf(ctx),
          error: failures.length ? `${failures.length} rows failed during import` : null,
        },
        ctx,
        { label: 'import batch' }
      );

      return { imported, failures };
    },
    { label: 'commit student import' }
  );

  // Temp file deleted (SPEC §15 step 6).
  await fsp.rm(planPath, { force: true }).catch(() => {});
  if (batch.storedName) {
    await fsp.rm(path.join(paths.temp, batch.storedName), { force: true }).catch(() => {});
  }

  return result;
}

async function discard(batchId, ctx) {
  const batch = await getBatch(batchId);
  if (batch.status === 'committed') {
    throw errors.badRequest('That import is already committed and cannot be discarded.');
  }
  await fsp.rm(path.join(paths.temp, `${batchId}.plan.json`), { force: true }).catch(() => {});
  if (batch.storedName) {
    await fsp.rm(path.join(paths.temp, batch.storedName), { force: true }).catch(() => {});
  }
  return crud.update(WB, 'ImportBatches', batchId, { status: 'discarded' }, ctx, {
    label: 'import batch',
  });
}

module.exports = {
  WB,
  TEMPLATE_VERSION,
  STUDENT_COLUMNS,
  template,
  listBatches,
  getBatch,
  batchErrors,
  validateUpload,
  commit,
  discard,
  normaliseDate,
};
