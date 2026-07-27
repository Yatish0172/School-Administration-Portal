'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const counters = require('./counters');
const academics = require('./academics');
const students = require('./students');
const errors = require('../errors');

/**
 * Admissions and enquiries (SPEC §7): capture, follow-up log with next-action
 * dates, conversion to admission with roll-number allocation, waiting list with
 * per-section capacity, and the enquiry funnel by source and month.
 */

const WB = 'Students';
const STATUSES = ['new', 'following up', 'visited', 'waiting', 'converted', 'lost'];
const SOURCES = ['Walk-in', 'Referral', 'Newspaper', 'Hoarding', 'Social media', 'Website', 'Other'];

async function list(options = {}) {
  const { status = null, source = null, from = null, to = null } = options;
  return crud.list(WB, 'Enquiries', {
    where: (row) => {
      if (status && row.status !== status) return false;
      if (source && row.source !== source) return false;
      if (from && String(row.createdAt || '').slice(0, 10) < from) return false;
      if (to && String(row.createdAt || '').slice(0, 10) > to) return false;
      return true;
    },
    searchFields: ['enquiryNo', 'childName', 'parentName', 'phone', 'email', 'classSought'],
    sort: options.sort || 'createdAt',
    dir: options.dir || 'desc',
    page: options.page,
    pageSize: options.pageSize,
    search: options.search,
  });
}

async function get(id) {
  return crud.get(WB, 'Enquiries', id);
}

async function withFollowUps(id) {
  const enquiry = await crud.getOrFail(WB, 'Enquiries', id, 'enquiry');
  const rows = await workbook.read(WB, 'EnquiryFollowUps');
  return {
    enquiry,
    followUps: rows
      .filter((r) => r.enquiryId === id)
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))),
  };
}

function validate(data) {
  const fields = {};
  if (!data.childName || !String(data.childName).trim()) fields.childName = "Enter the child's name.";
  if (!data.parentName || !String(data.parentName).trim()) fields.parentName = "Enter the parent's name.";
  if (!data.phone) fields.phone = 'Enter a contact number.';
  else if (!/^[0-9+\-\s]{6,15}$/.test(String(data.phone))) fields.phone = 'Enter a valid phone number.';
  if (!data.classSought) fields.classSought = 'Which class are they asking about?';
  if (data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(data.email))) {
    fields.email = 'Enter a valid email address, or leave it blank.';
  }
  if (Object.keys(fields).length) {
    throw errors.validation('Check the enquiry details.', fields);
  }
}

async function create(data, ctx) {
  validate(data);
  const enquiryNo = (await counters.next('enquiryNo', ctx)).formatted;
  return crud.create(
    WB,
    'Enquiries',
    {
      ...data,
      enquiryNo,
      status: 'new',
      source: SOURCES.includes(data.source) ? data.source : 'Other',
    },
    ctx,
    { label: 'create enquiry' }
  );
}

async function update(id, patch, ctx, options = {}) {
  const current = await crud.getOrFail(WB, 'Enquiries', id, 'enquiry');
  if (current.status === 'converted') {
    throw errors.badRequest('That enquiry has already become an admission and cannot be edited.');
  }
  validate({ ...current, ...crud.defined(patch) });
  const clean = { ...patch };
  delete clean.convertedStudentId;
  delete clean.convertedAt;
  return crud.update(WB, 'Enquiries', id, clean, ctx, {
    expectedRev: options.expectedRev,
    label: 'enquiry',
  });
}

/** Follow-up log with the next action date the office works from. */
async function addFollowUp(enquiryId, data, ctx) {
  const enquiry = await crud.getOrFail(WB, 'Enquiries', enquiryId, 'enquiry');
  if (!data.notes || String(data.notes).trim().length < 3) {
    throw errors.validation('Write what happened on this call or visit.', { notes: 'Required.' });
  }
  return workbook.mutate(
    WB,
    (api) => {
      const followUp = crud.insertInto(
        api,
        WB,
        'EnquiryFollowUps',
        {
          enquiryId,
          at: crud.nowIso(),
          byUserId: crud.actorOf(ctx),
          notes: String(data.notes).trim(),
          outcome: data.outcome || null,
          nextActionDate: data.nextActionDate || null,
        },
        ctx
      );
      crud.updateIn(
        api,
        WB,
        'Enquiries',
        enquiryId,
        {
          followUpDate: data.nextActionDate || enquiry.followUpDate,
          status:
            data.outcome && STATUSES.includes(data.outcome)
              ? data.outcome
              : enquiry.status === 'new'
                ? 'following up'
                : enquiry.status,
        },
        ctx,
        { label: 'enquiry' }
      );
      return followUp;
    },
    { label: 'add enquiry follow-up' }
  );
}

/** Enquiries due for a follow-up call today or earlier. */
async function dueFollowUps(onDate = null) {
  const date = onDate || new Date().toISOString().slice(0, 10);
  const rows = await workbook.read(WB, 'Enquiries');
  return rows
    .filter(
      (row) =>
        !['converted', 'lost'].includes(row.status) &&
        row.followUpDate &&
        row.followUpDate <= date
    )
    .sort((a, b) => crud.compareValues(a.followUpDate, b.followUpDate));
}

/**
 * Converts an enquiry into an admission. Delegates to students.admit so the
 * admission number, guardians and enrollment all follow the normal path.
 */
async function convert(enquiryId, { student, guardians, enrollment }, ctx) {
  const enquiry = await crud.getOrFail(WB, 'Enquiries', enquiryId, 'enquiry');
  if (enquiry.status === 'converted') {
    throw errors.badRequest('That enquiry has already become an admission.');
  }

  const year = await academics.resolveYear(enrollment?.academicYearId);
  // Roll number is left to students.admit, which allocates it inside the same lock
  // as the write. Computing it here would open a gap two conversions could both
  // slip through.
  const result = await students.admit(
    {
      student: {
        firstName: student?.firstName || enquiry.childName.split(' ')[0],
        lastName:
          student?.lastName || enquiry.childName.split(' ').slice(1).join(' ') || enquiry.childName,
        middleName: student?.middleName || null,
        dob: student?.dob || enquiry.dob,
        gender: student?.gender || enquiry.gender,
        permanentAddress: student?.permanentAddress || enquiry.address,
        ...student,
      },
      guardians:
        guardians && guardians.length
          ? guardians
          : [
              {
                relation: enquiry.relation || 'father',
                name: enquiry.parentName,
                phone: enquiry.phone,
                email: enquiry.email,
                isPrimary: true,
              },
            ],
      enrollment: { ...enrollment, academicYearId: year.id, rollNo: enrollment?.rollNo || null },
    },
    ctx
  );

  await crud.update(
    WB,
    'Enquiries',
    enquiryId,
    {
      status: 'converted',
      convertedStudentId: result.student.id,
      convertedAt: crud.nowIso(),
    },
    ctx,
    { label: 'enquiry' }
  );

  return result;
}

/* ------------------------------------------------------------ waiting list */

async function listWaiting({ academicYearId = null, classId = null } = {}) {
  const rows = await workbook.read(WB, 'WaitingList');
  return rows
    .filter((row) => {
      if (row.status !== 'waiting') return false;
      if (academicYearId && row.academicYearId !== academicYearId) return false;
      if (classId && row.classId !== classId) return false;
      return true;
    })
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
}

async function addToWaitingList(enquiryId, { academicYearId, classId, sectionId, notes }, ctx) {
  await crud.getOrFail(WB, 'Enquiries', enquiryId, 'enquiry');
  return workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('WaitingList');
      if (rows.some((r) => r.enquiryId === enquiryId && r.status === 'waiting')) {
        throw errors.badRequest('That enquiry is already on the waiting list.');
      }
      const peers = rows.filter(
        (r) => r.academicYearId === academicYearId && r.classId === classId && r.status === 'waiting'
      );
      const entry = crud.insertInto(
        api,
        WB,
        'WaitingList',
        {
          enquiryId,
          academicYearId,
          classId,
          sectionId: sectionId || null,
          position: peers.length + 1,
          status: 'waiting',
          notes: notes || null,
        },
        ctx
      );
      crud.updateIn(api, WB, 'Enquiries', enquiryId, { status: 'waiting' }, ctx, {
        label: 'enquiry',
      });
      return entry;
    },
    { label: 'add to waiting list' }
  );
}

/** Seats free per section, which is what the waiting list is queued against. */
async function capacity(academicYearId) {
  const sections = await academics.listSections({ academicYearId });
  const occupancy = await academics.sectionOccupancy(academicYearId);
  const classes = await academics.listClasses();
  const classById = new Map(classes.map((c) => [c.id, c]));

  return sections.map((section) => {
    const used = occupancy.get(section.id) || 0;
    const total = Number(section.capacity || 0);
    return {
      sectionId: section.id,
      sectionName: section.name,
      classId: section.classId,
      className: classById.get(section.classId)?.name || '',
      capacity: total || null,
      enrolled: used,
      free: total ? Math.max(0, total - used) : null,
      full: total ? used >= total : false,
    };
  });
}

/* -------------------------------------------------------------- funnel report */

async function funnel({ from = null, to = null } = {}) {
  const rows = await workbook.read(WB, 'Enquiries');
  const filtered = rows.filter((row) => {
    const date = String(row.createdAt || '').slice(0, 10);
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });

  const bySource = new Map();
  const byMonth = new Map();
  const byStatus = {};
  for (const status of STATUSES) byStatus[status] = 0;

  for (const row of filtered) {
    const source = row.source || 'Other';
    const month = String(row.createdAt || '').slice(0, 7);
    if (!bySource.has(source)) bySource.set(source, { source, total: 0, converted: 0 });
    if (!byMonth.has(month)) byMonth.set(month, { month, total: 0, converted: 0 });
    bySource.get(source).total += 1;
    byMonth.get(month).total += 1;
    if (row.status === 'converted') {
      bySource.get(source).converted += 1;
      byMonth.get(month).converted += 1;
    }
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  }

  const rate = (entry) =>
    entry.total ? Math.round((entry.converted / entry.total) * 1000) / 10 : null;

  return {
    total: filtered.length,
    converted: filtered.filter((r) => r.status === 'converted').length,
    byStatus,
    bySource: [...bySource.values()]
      .map((entry) => ({ ...entry, conversionPercent: rate(entry) }))
      .sort((a, b) => b.total - a.total),
    byMonth: [...byMonth.values()]
      .map((entry) => ({ ...entry, conversionPercent: rate(entry) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

module.exports = {
  WB,
  STATUSES,
  SOURCES,
  list,
  get,
  withFollowUps,
  create,
  update,
  addFollowUp,
  dueFollowUps,
  convert,
  listWaiting,
  addToWaitingList,
  capacity,
  funnel,
};
