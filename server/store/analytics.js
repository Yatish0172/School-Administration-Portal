'use strict';

const workbook = require('./workbook');
const academics = require('./academics');
const attendance = require('./attendance');
const students = require('./students');
const staff = require('./staff');
const fees = require('./fees');
const exams = require('./exams');
const library = require('./library');
const transport = require('./transport');
const enquiries = require('./enquiries');
const settings = require('./settings');
const users = require('./users');
const hours = require('../services/hours');

/**
 * Department analytics (one aggregate per department in SPEC §4).
 *
 * Everything here is read-only and computed from data already held in memory, so
 * these are cheap enough to recompute per request rather than cached and
 * invalidated — a cache that can go stale is worse than a few milliseconds.
 *
 * Each function returns tiles (headline numbers) plus named series ready to plot.
 * Deciding what to show is the server's job; the client only draws it.
 */

const DAY_MS = 86400000;

/* ------------------------------------------------------------------ helpers */

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** School days going back from today, Sundays excluded. */
function recentDays(count, from = new Date()) {
  const out = [];
  for (let back = 0; out.length < count; back += 1) {
    const date = new Date(from.getTime() - back * DAY_MS);
    if (date.getUTCDay() === 0) continue;
    out.push(isoDate(date));
    if (back > count * 3) break;
  }
  return out.reverse();
}

function lastMonths(count, from = new Date()) {
  const out = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const date = new Date(from.getFullYear(), from.getMonth() - back, 1);
    out.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function monthLabel(month) {
  const [year, m] = month.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${String(year).slice(2)}`;
}

function dayLabel(date) {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

function percentChange(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
}

/**
 * Rupees for a hint string. `fees.money` rounds, it does not format — printing its
 * result straight into a sentence gives "251775 of 832125 billed", which nobody
 * reads as money.
 */
function rupees(value) {
  const n = Number(value || 0);
  if (Math.abs(n) >= 10000000) return `₹${round(n / 10000000, 1)}Cr`;
  if (Math.abs(n) >= 100000) return `₹${round(n / 100000, 1)}L`;
  if (Math.abs(n) >= 1000) return `₹${round(n / 1000, 1)}K`;
  return `₹${Math.round(n)}`;
}

async function context(academicYearId) {
  const year = await academics.resolveYear(academicYearId);
  const today = hours.parts().date;
  return { year, today };
}

/* ==========================================================================
 * Whole school — Admin and Principal
 * ====================================================================== */

/**
 * The whole-school panel is assembled from several modules, so it is filtered by
 * the viewer's permissions the same way the dashboard is. Without this, a class
 * teacher opening "Whole school" would see fee collection totals their role does
 * not grant anywhere else — analytics must never be a side door.
 *
 * @param {string[]} permissions the signed-in user's permission keys
 */
async function overview(academicYearId, permissions = []) {
  const may = (key) => permissions.includes(key);
  const { year, today } = await context(academicYearId);

  const [counts, classes, sections, enrollments, staffList] = await Promise.all([
    students.counts(),
    academics.listClasses(),
    academics.listSections({ academicYearId: year.id }),
    academics.listEnrollments({ academicYearId: year.id }),
    may('staff.view') ? staff.list({ pageSize: 0 }) : Promise.resolve({ rows: [] }),
  ]);

  const classById = new Map(classes.map((row) => [row.id, row]));
  const sectionById = new Map(sections.map((row) => [row.id, row]));

  // Enrolment by class
  const perClass = new Map();
  for (const enrollment of enrollments) {
    const name = classById.get(enrollment.classId)?.name || 'Unassigned';
    perClass.set(name, (perClass.get(name) || 0) + 1);
  }

  // Attendance trend over the last 20 school days
  let attendanceTrend = [];
  let attendanceAverage = null;
  if (may('attendance.view')) {
    const days = recentDays(20);
    for (const date of days) {
      const rows = await attendance.forDate({ yearName: year.name, date });
      const summary = attendance.summarise(rows);
      attendanceTrend.push({ label: dayLabel(date), date, value: rows.length ? summary.percent : null });
    }
    const recorded = attendanceTrend.filter((point) => point.value !== null);
    attendanceAverage = recorded.length
      ? round(recorded.reduce((sum, point) => sum + point.value, 0) / recorded.length)
      : null;
  }
  const recordedDays = attendanceTrend.filter((point) => point.value !== null).length;

  // Fee collection over the last 6 months
  let collectionTrend = [];
  let feeTotals = null;
  let dues = null;
  if (may('fees.view')) {
    const months = lastMonths(6);
    const payments = (await workbook.read(fees.bookFor(year.name), 'Payments')).filter(
      (row) => row.status !== 'reversed'
    );
    collectionTrend = months.map((month) => ({
      label: monthLabel(month),
      value: fees.money(
        payments
          .filter((row) => String(row.paidAt || '').slice(0, 7) === month)
          .reduce((sum, row) => sum + Number(row.amount || 0), 0)
      ),
    }));
    feeTotals = await fees.dashboardTotals(year.name, today);
    if (may('fees.report')) dues = await fees.dues(year.name, { yearId: year.id });
  }

  // Gender split, which the board asks for every year
  const activeStudents = (await workbook.read('Students', 'Students')).filter((row) => row.status === 'Active');
  const genderSplit = ['Male', 'Female', 'Other'].map((gender) => ({
    label: gender,
    value: activeStudents.filter((row) => row.gender === gender).length,
  }));
  const unknownGender = activeStudents.filter((row) => !row.gender).length;
  if (unknownGender) genderSplit.push({ label: 'Not recorded', value: unknownGender });

  const libraryTotals = may('library.view') ? await library.dashboardTotals() : null;
  const thisMonth = collectionTrend[collectionTrend.length - 1]?.value || 0;
  const lastMonth = collectionTrend[collectionTrend.length - 2]?.value || 0;

  const tiles = [
    {
      label: 'Students on roll',
      value: counts.byStatus.Active || 0,
      hint: `${counts.total} records in total`,
      format: 'number',
    },
    { label: 'Sections running', value: sections.length, format: 'number', hint: `${classes.length} classes` },
  ];

  if (may('attendance.view')) {
    tiles.push({
      label: 'Attendance, 20-day average',
      value: attendanceAverage,
      format: 'percent',
      hint: `${recordedDays} day(s) recorded`,
      tone: attendanceAverage === null ? null : attendanceAverage >= 90 ? 'good' : attendanceAverage >= 75 ? 'warn' : 'bad',
      trend: attendanceTrend.slice(-12).map((point) => point.value),
    });
  }
  if (may('fees.view')) {
    tiles.push(
      {
        label: 'Collected this month',
        value: thisMonth,
        format: 'money',
        delta: percentChange(thisMonth, lastMonth),
        deltaLabel: 'vs last month',
        trend: collectionTrend.map((point) => point.value),
      },
      {
        label: 'Collected today',
        value: feeTotals.todayTotal,
        format: 'money',
        hint: `${feeTotals.receiptsToday} receipt(s)`,
      }
    );
  }
  if (dues) {
    tiles.push({
      label: 'Outstanding dues',
      value: dues.totals.outstanding,
      format: 'money',
      hint: `${dues.totals.students} student(s) with a balance`,
      tone: dues.totals.outstanding > 0 ? 'warn' : 'good',
      upIsGood: false,
    });
  }
  if (may('staff.view')) {
    tiles.push({
      label: 'Staff on roll',
      value: staffList.rows.filter((row) => row.status === 'active').length,
      format: 'number',
    });
  }
  if (libraryTotals) {
    tiles.push({
      label: 'Books on loan',
      value: libraryTotals.outstanding,
      format: 'number',
      hint: `${libraryTotals.overdue} overdue`,
    });
  }

  const charts = {
    enrolmentByClass: [...perClass.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true })),
    genderSplit: genderSplit.filter((row) => row.value > 0),
    sectionFill: sections
      .map((section) => {
        const enrolled = enrollments.filter((row) => row.sectionId === section.id).length;
        return {
          label: `${classById.get(section.classId)?.name || ''} ${section.name}`.trim(),
          value: enrolled,
          capacity: Number(section.capacity) || null,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true })),
  };

  if (may('attendance.view')) charts.attendanceTrend = attendanceTrend;
  if (may('fees.view')) charts.collectionTrend = collectionTrend;
  if (dues) {
    charts.ageing = dues.totals.byBucket.map((bucket) => ({
      label: bucket.bucket === 'current' ? 'Not yet due' : `${bucket.bucket} days`,
      value: bucket.amount,
    }));
  }

  return { scope: `${year.name} • as at ${today}`, tiles, charts };
}

/* ==========================================================================
 * Admissions — Front Office
 * ====================================================================== */

async function admissions(academicYearId) {
  const { year } = await context(academicYearId);
  const funnel = await enquiries.funnel({});
  const capacity = await enquiries.capacity(year.id);
  const rows = await workbook.read('Students', 'Enquiries');
  const due = await enquiries.dueFollowUps();

  // How long a conversion actually takes, which nobody tracks by hand
  const converted = rows.filter((row) => row.status === 'converted' && row.convertedAt && row.createdAt);
  const durations = converted.map(
    (row) => (Date.parse(row.convertedAt) - Date.parse(row.createdAt)) / DAY_MS
  );
  const averageDays = durations.length
    ? round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : null;

  const admissionsByMonth = lastMonths(6).map((month) => {
    const admitted = 0;
    return { month, admitted };
  });
  const studentRows = await workbook.read('Students', 'Students');
  for (const entry of admissionsByMonth) {
    entry.admitted = studentRows.filter(
      (row) => String(row.admissionDate || '').slice(0, 7) === entry.month
    ).length;
  }

  const stageOrder = ['new', 'following up', 'visited', 'waiting', 'converted', 'lost'];

  return {
    scope: `${year.name} • ${funnel.total} enquiries recorded`,
    tiles: [
      { label: 'Enquiries', value: funnel.total, format: 'number' },
      {
        label: 'Converted to admissions',
        value: funnel.converted,
        format: 'number',
        hint: funnel.total ? `${round((funnel.converted / funnel.total) * 100)}% conversion` : null,
        tone: 'good',
      },
      {
        label: 'Still open',
        value: funnel.total - funnel.converted - (funnel.byStatus.lost || 0),
        format: 'number',
        hint: `${funnel.byStatus.lost || 0} lost`,
      },
      {
        label: 'Follow-up calls due',
        value: due.length,
        format: 'number',
        tone: due.length ? 'warn' : 'good',
        upIsGood: false,
      },
      {
        label: 'Average days to convert',
        value: averageDays,
        format: 'number',
        hint: averageDays === null ? 'no conversions yet' : `across ${converted.length}`,
        upIsGood: false,
      },
      {
        label: 'Seats free',
        value: capacity.reduce((sum, row) => sum + (row.free ?? 0), 0),
        format: 'number',
        hint: `${capacity.filter((row) => row.full).length} section(s) full`,
      },
    ],
    charts: {
      funnelStages: stageOrder
        .map((stage) => ({
          label: stage === 'new' ? 'New enquiry' : stage.charAt(0).toUpperCase() + stage.slice(1),
          value: funnel.byStatus[stage] || 0,
        }))
        .filter((row) => row.value > 0),
      bySource: funnel.bySource.map((row) => ({
        label: row.source,
        value: row.total,
        note: `${row.converted} converted`,
        conversionPercent: row.conversionPercent,
      })),
      byMonth: funnel.byMonth.map((row) => ({ label: monthLabel(row.month), value: row.total })),
      conversionByMonth: funnel.byMonth.map((row) => ({ label: monthLabel(row.month), value: row.converted })),
      admissionsByMonth: admissionsByMonth.map((row) => ({ label: monthLabel(row.month), value: row.admitted })),
      capacity: capacity.map((row) => ({
        label: `${row.className} ${row.sectionName}`.trim(),
        value: row.enrolled,
        capacity: row.capacity,
        free: row.free,
      })),
    },
  };
}

/* ==========================================================================
 * Attendance
 * ====================================================================== */

async function attendanceAnalytics(academicYearId, { sectionIds = null } = {}) {
  const { year, today } = await context(academicYearId);
  const days = recentDays(30);
  const sections = await academics.listSections({ academicYearId: year.id });
  const classes = await academics.listClasses();
  const classById = new Map(classes.map((row) => [row.id, row]));
  const allowed = sectionIds ? new Set(sectionIds) : null;

  const trend = [];
  const weekdayTotals = new Map();
  const statusTotals = {};
  let recordedDays = 0;

  for (const date of days) {
    let rows = await attendance.forDate({ yearName: year.name, date });
    if (allowed) rows = rows.filter((row) => allowed.has(row.sectionId));
    if (!rows.length) {
      trend.push({ label: dayLabel(date), date, value: null });
      continue;
    }
    recordedDays += 1;
    const summary = attendance.summarise(rows);
    trend.push({ label: dayLabel(date), date, value: summary.percent });

    for (const status of attendance.STATUSES) {
      statusTotals[status] = (statusTotals[status] || 0) + (summary[status] || 0);
    }

    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${date}T00:00:00Z`).getUTCDay()];
    if (!weekdayTotals.has(weekday)) weekdayTotals.set(weekday, { present: 0, total: 0 });
    const bucket = weekdayTotals.get(weekday);
    bucket.present += summary.presentEquivalent;
    bucket.total += summary.total;
  }

  const recorded = trend.filter((point) => point.value !== null);
  const average = recorded.length
    ? round(recorded.reduce((sum, point) => sum + point.value, 0) / recorded.length)
    : null;
  const best = recorded.length ? recorded.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const worst = recorded.length ? recorded.reduce((a, b) => (b.value < a.value ? b : a)) : null;

  const from = days[0];
  const comparison = await attendance.classComparison({ yearId: year.id, yearName: year.name, from, to: today });
  const threshold = Number(await settings.get('attendance.defaulterThreshold', 75));
  const defaulters = await attendance.defaulters({
    yearId: year.id,
    yearName: year.name,
    from,
    to: today,
    threshold,
    sectionIds: sectionIds || null,
  });

  const todayRows = await attendance.forDate({ yearName: year.name, date: today });
  const todaySummary = attendance.summarise(allowed ? todayRows.filter((r) => allowed.has(r.sectionId)) : todayRows);

  const unmarked = await attendance.unmarkedSections({
    yearId: year.id,
    yearName: year.name,
    date: today,
    sectionIds: sectionIds || null,
  });

  return {
    scope: `${year.name} • last ${recordedDays} recorded day(s)`,
    tiles: [
      {
        label: 'Attendance today',
        value: todayRows.length ? todaySummary.percent : null,
        format: 'percent',
        hint: todayRows.length ? `${todaySummary.total} marked` : 'not marked yet',
        tone: !todayRows.length ? 'warn' : todaySummary.percent >= 90 ? 'good' : 'warn',
      },
      {
        label: '30-day average',
        value: average,
        format: 'percent',
        trend: trend.slice(-12).map((point) => point.value),
        tone: average === null ? null : average >= 90 ? 'good' : average >= 75 ? 'warn' : 'bad',
      },
      {
        label: `Below ${threshold}%`,
        value: defaulters.rows.length,
        format: 'number',
        hint: 'students needing a call home',
        tone: defaulters.rows.length ? 'warn' : 'good',
        upIsGood: false,
      },
      {
        label: 'Sections not marked today',
        value: unmarked.length,
        format: 'number',
        tone: unmarked.length ? 'warn' : 'good',
        upIsGood: false,
      },
      { label: 'Best day', value: best ? best.value : null, format: 'percent', hint: best ? best.date : null },
      { label: 'Worst day', value: worst ? worst.value : null, format: 'percent', hint: worst ? worst.date : null, upIsGood: false },
    ],
    charts: {
      trend,
      byClass: comparison.map((row) => ({ label: row.className, value: row.percent ?? 0 })),
      statusMix: attendance.STATUSES.map((status) => ({ label: status, value: statusTotals[status] || 0 })).filter(
        (row) => row.value > 0
      ),
      byWeekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        .filter((day) => weekdayTotals.has(day))
        .map((day) => {
          const bucket = weekdayTotals.get(day);
          return { label: day, value: bucket.total ? round((bucket.present / bucket.total) * 100) : 0 };
        }),
      bySection: sections
        .filter((section) => !allowed || allowed.has(section.id))
        .map((section) => {
          const rows = comparison.find((row) => row.classId === section.classId);
          return {
            label: `${classById.get(section.classId)?.name || ''} ${section.name}`.trim(),
            value: rows ? rows.percent ?? 0 : 0,
          };
        }),
      defaulters: defaulters.rows.slice(0, 15),
    },
  };
}

/* ==========================================================================
 * Fees
 * ====================================================================== */

async function feesAnalytics(academicYearId) {
  const { year, today } = await context(academicYearId);
  const book = fees.bookFor(year.name);

  const [payments, allocations, charges, heads, concessions] = await Promise.all([
    workbook.read(book, 'Payments'),
    workbook.read(book, 'PaymentAllocations'),
    workbook.read(book, 'StudentCharges'),
    fees.listHeads(year.name, { includeInactive: true }),
    fees.listConcessions(year.name, {}),
  ]);

  const active = payments.filter((row) => row.status !== 'reversed');
  const headById = new Map(heads.map((row) => [row.id, row]));
  const activeIds = new Set(active.map((row) => row.id));

  const days = recentDays(30);
  const dailyCollection = days.map((date) => ({
    label: dayLabel(date),
    date,
    value: fees.money(
      active
        .filter((row) => String(row.paidAt || '').slice(0, 10) === date)
        .reduce((sum, row) => sum + Number(row.amount || 0), 0)
    ),
  }));

  const months = lastMonths(6);
  const monthlyCollection = months.map((month) => ({
    label: monthLabel(month),
    value: fees.money(
      active
        .filter((row) => String(row.paidAt || '').slice(0, 7) === month)
        .reduce((sum, row) => sum + Number(row.amount || 0), 0)
    ),
  }));

  const byHead = new Map();
  for (const allocation of allocations) {
    if (!activeIds.has(allocation.paymentId)) continue;
    byHead.set(allocation.feeHeadId, fees.money((byHead.get(allocation.feeHeadId) || 0) + Number(allocation.amount || 0)));
  }

  const byMode = new Map();
  for (const payment of active) {
    byMode.set(payment.mode, fees.money((byMode.get(payment.mode) || 0) + Number(payment.amount || 0)));
  }

  const billed = fees.money(
    charges.filter((row) => row.status !== 'cancelled').reduce((sum, row) => sum + Number(row.netAmount || 0), 0)
  );
  const collected = fees.money(
    charges.filter((row) => row.status !== 'cancelled').reduce((sum, row) => sum + Number(row.paidAmount || 0), 0)
  );
  const concessionTotal = fees.money(
    charges.filter((row) => row.status !== 'cancelled').reduce((sum, row) => sum + Number(row.concessionAmount || 0), 0)
  );

  const dues = await fees.dues(year.name, { yearId: year.id });
  const classes = await academics.listClasses();
  const classById = new Map(classes.map((row) => [row.id, row]));

  const byClass = new Map();
  for (const charge of charges) {
    if (charge.status === 'cancelled') continue;
    const name = classById.get(charge.classId)?.name || 'Unassigned';
    if (!byClass.has(name)) byClass.set(name, { billed: 0, paid: 0 });
    const bucket = byClass.get(name);
    bucket.billed += Number(charge.netAmount || 0);
    bucket.paid += Number(charge.paidAmount || 0);
  }

  const reversed = payments.filter((row) => row.status === 'reversed');
  const thisMonth = monthlyCollection[monthlyCollection.length - 1]?.value || 0;
  const lastMonth = monthlyCollection[monthlyCollection.length - 2]?.value || 0;

  return {
    scope: `${year.name} • ${active.length} receipts issued`,
    tiles: [
      {
        label: 'Collected this month',
        value: thisMonth,
        format: 'money',
        delta: percentChange(thisMonth, lastMonth),
        deltaLabel: 'vs last month',
        trend: monthlyCollection.map((row) => row.value),
      },
      {
        label: 'Collection efficiency',
        value: billed ? round((collected / billed) * 100) : null,
        format: 'percent',
        hint: `${rupees(collected)} of ${rupees(billed)} billed`,
        tone: billed && collected / billed > 0.9 ? 'good' : 'warn',
      },
      {
        label: 'Outstanding',
        value: dues.totals.outstanding,
        format: 'money',
        hint: `${dues.totals.students} student(s)`,
        upIsGood: false,
        tone: dues.totals.outstanding > 0 ? 'warn' : 'good',
      },
      {
        label: 'Over 90 days late',
        value: dues.totals.byBucket.find((bucket) => bucket.bucket === '90+')?.amount || 0,
        format: 'money',
        upIsGood: false,
        tone: 'bad',
      },
      { label: 'Concessions given', value: concessionTotal, format: 'money', hint: `${concessions.filter((row) => row.status === 'approved').length} approved` },
      {
        label: 'Reversals',
        value: reversed.length,
        format: 'number',
        hint: reversed.length
          ? `${rupees(reversed.reduce((sum, row) => sum + Number(row.amount || 0), 0))} reversed`
          : 'none',
        upIsGood: false,
      },
    ],
    charts: {
      dailyCollection,
      monthlyCollection,
      byHead: [...byHead.entries()]
        .map(([id, value]) => ({ label: headById.get(id)?.name || 'Unknown head', value }))
        .sort((a, b) => b.value - a.value),
      byMode: [...byMode.entries()].map(([mode, value]) => ({ label: mode, value })).sort((a, b) => b.value - a.value),
      ageing: dues.totals.byBucket.map((bucket) => ({
        label: bucket.bucket === 'current' ? 'Not yet due' : `${bucket.bucket} days`,
        value: bucket.amount,
      })),
      byClass: [...byClass.entries()]
        .map(([label, bucket]) => ({
          label,
          value: fees.money(bucket.paid),
          outstanding: fees.money(bucket.billed - bucket.paid),
          billed: fees.money(bucket.billed),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true })),
      topDefaulters: dues.rows.slice(0, 15),
    },
  };
}

/* ==========================================================================
 * Examinations
 * ====================================================================== */

async function examsAnalytics(academicYearId, { examId = null } = {}) {
  const { year } = await context(academicYearId);
  const allExams = await exams.listExams(year.name, {});
  const target = examId
    ? allExams.find((row) => row.id === examId)
    : allExams.find((row) => row.status === 'published') || allExams[0];

  if (!target) {
    return {
      scope: `${year.name}`,
      empty: 'No exams have been set up yet.',
      tiles: [],
      charts: {},
      exams: [],
    };
  }

  const classes = await academics.listClasses();
  const classById = new Map(classes.map((row) => [row.id, row]));
  const report = await exams.analytics(year.name, { examId: target.id, yearId: year.id });
  const gradeRules = await exams.listGradeRules(year.name, target.classId);

  // Grade distribution across the whole exam
  const distribution = new Map(gradeRules.map((rule) => [rule.grade, 0]));
  for (const row of report.ranked) {
    if (row.percent === null) continue;
    const grade = exams.gradeFor(gradeRules, row.percent);
    if (!grade) continue;
    distribution.set(grade, (distribution.get(grade) || 0) + 1);
  }

  const comparison = await exams.termComparison(year.name, { classId: target.classId, yearId: year.id });

  return {
    scope: `${classById.get(target.classId)?.name || ''} — ${target.name}`,
    exams: allExams.map((row) => ({
      id: row.id,
      label: `${classById.get(row.classId)?.name || ''} — ${row.name}${row.status === 'published' ? '' : ' (draft)'}`,
      status: row.status,
    })),
    selectedExamId: target.id,
    tiles: [
      { label: 'Students appeared', value: report.summary.appeared, format: 'number' },
      {
        label: 'Pass rate',
        value: report.summary.passPercent,
        format: 'percent',
        tone: report.summary.passPercent >= 90 ? 'good' : report.summary.passPercent >= 70 ? 'warn' : 'bad',
      },
      { label: 'Class average', value: report.summary.classAverage, format: 'percent' },
      {
        label: 'Needing attention',
        value: report.failures.length,
        format: 'number',
        upIsGood: false,
        tone: report.failures.length ? 'warn' : 'good',
      },
      {
        label: 'Highest',
        value: report.toppers[0] ? report.toppers[0].percent : null,
        format: 'percent',
        hint: report.toppers[0] ? report.toppers[0].name : null,
      },
      {
        label: 'Subjects below 60% average',
        value: report.bySubject.filter((row) => row.average !== null && (row.average / row.maxMarks) * 100 < 60).length,
        format: 'number',
        upIsGood: false,
      },
    ],
    charts: {
      subjectAverages: report.bySubject.map((row) => ({
        label: row.subjectName,
        value: row.maxMarks ? round((row.average / row.maxMarks) * 100) : 0,
        note: `avg ${row.average} of ${row.maxMarks}`,
      })),
      passBySubject: report.bySubject.map((row) => ({ label: row.subjectName, value: row.passPercent ?? 0 })),
      gradeDistribution: [...distribution.entries()].map(([label, value]) => ({ label, value })),
      toppers: report.toppers,
      failures: report.failures,
      termComparison: comparison,
    },
  };
}

/* ==========================================================================
 * Library
 * ====================================================================== */

async function libraryAnalytics() {
  const [issues, titles, copies, fines] = await Promise.all([
    workbook.read('Library', 'BookIssues'),
    workbook.read('Library', 'Titles'),
    workbook.read('Library', 'Copies'),
    workbook.read('Library', 'Fines'),
  ]);

  const titleById = new Map(titles.map((row) => [row.id, row]));
  const days = recentDays(30);

  const issuesPerDay = days.map((date) => ({
    label: dayLabel(date),
    date,
    value: issues.filter((row) => row.issuedAt === date).length,
  }));

  const byTitle = new Map();
  for (const issue of issues) {
    byTitle.set(issue.titleId, (byTitle.get(issue.titleId) || 0) + 1);
  }

  const byCategory = new Map();
  for (const copy of copies) {
    const category = titleById.get(copy.titleId)?.category || 'Uncategorised';
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
  }

  const outstanding = issues.filter((row) => row.status === 'issued');
  const overdue = outstanding.filter((row) => library.overdueDays(row.dueDate) > 0);
  const borrowers = new Set(outstanding.map((row) => row.studentId || row.staffId).filter(Boolean));

  const overdueBuckets = [
    { label: '1–7 days', min: 1, max: 7 },
    { label: '8–14 days', min: 8, max: 14 },
    { label: '15–30 days', min: 15, max: 30 },
    { label: 'Over 30 days', min: 31, max: Infinity },
  ].map((bucket) => ({
    label: bucket.label,
    value: overdue.filter((row) => {
      const days2 = library.overdueDays(row.dueDate);
      return days2 >= bucket.min && days2 <= bucket.max;
    }).length,
  }));

  const thisMonth = new Date().toISOString().slice(0, 7);
  const circulationThisMonth = issues.filter((row) => String(row.issuedAt || '').slice(0, 7) === thisMonth).length;
  const available = copies.filter((row) => row.status === 'available').length;

  return {
    scope: `${titles.length} titles • ${copies.length} copies`,
    tiles: [
      { label: 'Issued this month', value: circulationThisMonth, format: 'number' },
      { label: 'Out on loan', value: outstanding.length, format: 'number', hint: `${borrowers.size} borrower(s)` },
      {
        label: 'Overdue',
        value: overdue.length,
        format: 'number',
        upIsGood: false,
        tone: overdue.length ? 'warn' : 'good',
      },
      {
        label: 'Fines pending',
        value: fees.money(
          fines.filter((row) => row.status === 'pending').reduce((sum, row) => sum + Number(row.amount || 0), 0)
        ),
        format: 'money',
        upIsGood: false,
      },
      {
        label: 'Stock available',
        value: available,
        format: 'number',
        hint: copies.length ? `${round((available / copies.length) * 100)}% of stock` : null,
      },
      {
        label: 'Copies lost or damaged',
        value: copies.filter((row) => ['lost', 'damaged'].includes(row.status)).length,
        format: 'number',
        upIsGood: false,
      },
    ],
    charts: {
      issuesPerDay,
      topTitles: [...byTitle.entries()]
        .map(([id, value]) => ({ label: titleById.get(id)?.title || 'Unknown', value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10),
      byCategory: [...byCategory.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
      stockStatus: ['available', 'issued', 'lost', 'damaged']
        .map((status) => ({ label: status, value: copies.filter((row) => row.status === status).length }))
        .filter((row) => row.value > 0),
      overdueBuckets: overdueBuckets.filter((row) => row.value > 0),
    },
  };
}

/* ==========================================================================
 * Transport
 * ====================================================================== */

async function transportAnalytics(academicYearId) {
  const { year } = await context(academicYearId);
  const [routes, vehicles, drivers, assignments, stops] = await Promise.all([
    transport.listRoutes({ includeInactive: true }),
    transport.listVehicles({ includeInactive: true }),
    transport.listDrivers({ includeInactive: true }),
    transport.listAssignments({ academicYearId: year.id }),
    workbook.read('Transport', 'Stops'),
  ]);

  const vehicleById = new Map(vehicles.map((row) => [row.id, row]));
  const stopById = new Map(stops.map((row) => [row.id, row]));
  const alerts = await transport.expiryAlerts({ withinDays: 90 });

  const perRoute = routes.map((route) => {
    const riders = assignments.filter((row) => row.routeId === route.id);
    const capacity = Number(vehicleById.get(route.vehicleId)?.capacity) || null;
    return {
      label: route.name,
      value: riders.length,
      capacity,
      free: capacity ? Math.max(0, capacity - riders.length) : null,
      fare: fees.money(riders.reduce((sum, row) => sum + Number(row.fare || 0), 0)),
    };
  });

  const perStop = new Map();
  for (const assignment of assignments) {
    const stop = stopById.get(assignment.stopId);
    const label = stop ? stop.name : 'Unassigned stop';
    perStop.set(label, (perStop.get(label) || 0) + 1);
  }

  const totalCapacity = perRoute.reduce((sum, row) => sum + (row.capacity || 0), 0);
  const totalRiders = assignments.length;

  return {
    scope: `${year.name} • ${routes.length} route(s)`,
    tiles: [
      { label: 'Students on transport', value: totalRiders, format: 'number' },
      {
        label: 'Seat utilisation',
        value: totalCapacity ? round((totalRiders / totalCapacity) * 100) : null,
        format: 'percent',
        hint: totalCapacity ? `${totalRiders} of ${totalCapacity} seats` : 'no vehicle capacity set',
        tone: totalCapacity && totalRiders / totalCapacity > 0.95 ? 'warn' : 'good',
      },
      { label: 'Seats free', value: totalCapacity ? totalCapacity - totalRiders : null, format: 'number' },
      {
        label: 'Documents expiring',
        value: alerts.length,
        format: 'number',
        hint: `${alerts.filter((row) => row.expired).length} already expired`,
        upIsGood: false,
        tone: alerts.filter((row) => row.expired).length ? 'bad' : alerts.length ? 'warn' : 'good',
      },
      { label: 'Vehicles', value: vehicles.filter((row) => row.status !== 'inactive').length, format: 'number' },
      { label: 'Drivers', value: drivers.filter((row) => row.status !== 'inactive').length, format: 'number' },
    ],
    charts: {
      routeUtilisation: perRoute,
      byStop: [...perStop.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
      fareByRoute: perRoute.map((row) => ({ label: row.label, value: row.fare })),
      expiries: alerts.map((row) => ({
        kind: row.kind,
        name: row.name,
        document: row.field.replace('Expiry', ''),
        expiresOn: row.expiresOn,
        daysLeft: row.daysLeft,
        expired: row.expired,
      })),
    },
  };
}

/* ==========================================================================
 * Staff and HR
 * ====================================================================== */

async function staffAnalytics(academicYearId) {
  const { year } = await context(academicYearId);
  const all = await staff.list({ pageSize: 0 });
  const rows = all.rows;
  const activeStaff = rows.filter((row) => row.status === 'active');

  const byDepartment = new Map();
  for (const member of activeStaff) {
    const key = member.department || 'Unassigned';
    byDepartment.set(key, (byDepartment.get(key) || 0) + 1);
  }

  const byType = new Map();
  for (const member of activeStaff) {
    const key = member.employmentType || 'Not recorded';
    byType.set(key, (byType.get(key) || 0) + 1);
  }

  const months = lastMonths(6);
  const attendanceTrend = [];
  for (const month of months) {
    const summary = await staff.monthlySummary(year.name, month);
    const percentages = summary.rows.map((row) => row.percent).filter((value) => value !== null);
    attendanceTrend.push({
      label: monthLabel(month),
      value: percentages.length ? round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length) : null,
    });
  }

  const thisMonth = months[months.length - 1];
  const summary = await staff.monthlySummary(year.name, thisMonth);
  const leave = await staff.listLeave(year.name, {});
  const byLeaveType = new Map();
  for (const request of leave.filter((row) => row.status === 'approved')) {
    byLeaveType.set(request.leaveType, (byLeaveType.get(request.leaveType) || 0) + Number(request.days || 0));
  }

  const payslips = await staff.listPayslips({ month: thisMonth });
  const payrollTotal = fees.money(payslips.reduce((sum, row) => sum + Number(row.netAmount || 0), 0));

  const structures = await workbook.read('Staff', 'SalaryStructures');
  const activeStructures = structures.filter((row) => row.status === 'active');
  const committed = fees.money(activeStructures.reduce((sum, row) => sum + Number(row.netSalary || 0), 0));

  const currentAverage = attendanceTrend[attendanceTrend.length - 1]?.value ?? null;

  return {
    scope: `${year.name} • ${activeStaff.length} on roll`,
    tiles: [
      { label: 'Staff on roll', value: activeStaff.length, format: 'number', hint: `${rows.length} records in total` },
      {
        label: 'Attendance this month',
        value: currentAverage,
        format: 'percent',
        trend: attendanceTrend.map((row) => row.value),
        tone: currentAverage === null ? null : currentAverage >= 95 ? 'good' : 'warn',
      },
      {
        label: 'Leave awaiting approval',
        value: leave.filter((row) => row.status === 'pending').length,
        format: 'number',
        upIsGood: false,
        tone: leave.filter((row) => row.status === 'pending').length ? 'warn' : 'good',
      },
      {
        label: 'Leave days approved',
        value: [...byLeaveType.values()].reduce((sum, value) => sum + value, 0),
        format: 'number',
      },
      {
        label: 'Payroll this month',
        value: payrollTotal,
        format: 'money',
        hint: `${payslips.length} payslip(s) generated`,
      },
      {
        label: 'Monthly salary committed',
        value: committed,
        format: 'money',
        hint: `${activeStructures.length} structure(s) on record`,
      },
    ],
    charts: {
      attendanceTrend,
      byDepartment: [...byDepartment.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
      byEmploymentType: [...byType.entries()].map(([label, value]) => ({ label, value })),
      leaveByType: [...byLeaveType.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
      lowestAttendance: summary.rows
        .filter((row) => row.percent !== null)
        .sort((a, b) => a.percent - b.percent)
        .slice(0, 10),
    },
  };
}

/* ==========================================================================
 * Which departments may this user see?
 * ====================================================================== */

/**
 * Each panel is gated by the permission that already governs that data, so
 * analytics can never widen what somebody can see.
 */
const DEPARTMENTS = [
  { key: 'overview', label: 'Whole school', permission: 'dashboard.view', extra: 'student.view' },
  { key: 'admissions', label: 'Admissions', permission: 'enquiry.view' },
  { key: 'attendance', label: 'Attendance', permission: 'attendance.report' },
  { key: 'fees', label: 'Fees', permission: 'fees.report' },
  { key: 'exams', label: 'Examinations', permission: 'result.analytics' },
  { key: 'library', label: 'Library', permission: 'library.view' },
  { key: 'transport', label: 'Transport', permission: 'transport.view' },
  { key: 'staff', label: 'Staff and HR', permission: 'staff.view' },
];

function availableFor(user) {
  return DEPARTMENTS.filter((department) => {
    if (!user.permissions.includes(department.permission)) return false;
    if (department.extra && !user.permissions.includes(department.extra)) return false;
    return true;
  }).map(({ key, label }) => ({ key, label }));
}

module.exports = {
  DEPARTMENTS,
  availableFor,
  overview,
  admissions,
  attendance: attendanceAnalytics,
  fees: feesAnalytics,
  exams: examsAnalytics,
  library: libraryAnalytics,
  transport: transportAnalytics,
  staff: staffAnalytics,
  users,
};
