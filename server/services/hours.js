'use strict';

const workbook = require('../store/workbook');
const crud = require('../store/crud');
const settings = require('../store/settings');
const permissions = require('../store/permissions');
const errors = require('../errors');

/**
 * School-hours access control (SPEC §3).
 *
 * Enforcement is server-side only and always uses the server clock. The client
 * mirrors this state to show banners; it decides nothing.
 *
 * India has no daylight saving and the timezone is fixed at Asia/Kolkata by
 * design, so a constant +05:30 offset is exact — no ICU lookups needed on a
 * machine whose locale data may be stale.
 */

const TIMEZONE = 'Asia/Kolkata';
const OFFSET_MINUTES = 330;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Roles that are never restricted. Hard-coded on purpose (SPEC §3). */
const ALWAYS_ALLOWED_ROLES = new Set(['admin', 'principal']);

/* ------------------------------------------------------------------ clock */

function shift(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

/** Local wall-clock parts for the school's timezone. */
function parts(at = new Date()) {
  const local = shift(at, OFFSET_MINUTES);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate()
  )}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  return {
    iso: at.toISOString(),
    date,
    time,
    seconds: local.getUTCSeconds(),
    minuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
    day: local.getUTCDay(),
    dayName: DAY_NAMES[local.getUTCDay()],
    timezone: TIMEZONE,
  };
}

/** A local date + HH:MM back to a real instant. */
function instantAt(date, time) {
  const stamp = Date.parse(`${date}T${padTime(time)}:00.000Z`);
  if (!Number.isFinite(stamp)) return null;
  return new Date(stamp - OFFSET_MINUTES * 60000);
}

function padTime(time) {
  const [h = '0', m = '0'] = String(time || '').split(':');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function toMinutes(time) {
  const [h, m] = padTime(time).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function fromMinutes(minutes) {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 17:00 -> "5:00 PM". Used in messages staff read. */
function friendlyTime(time) {
  const minutes = toMinutes(time);
  if (minutes === null) return time;
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function addDays(date, days) {
  const stamp = Date.parse(`${date}T00:00:00.000Z`);
  const next = new Date(stamp + days * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

function dayOfDate(date) {
  const stamp = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(stamp).getUTCDay();
}

/* --------------------------------------------------------------- schedule */

const DEFAULT_WEEK = [
  { day: 0, dayName: 'Sunday', open: '', close: '', closed: true },
  { day: 1, dayName: 'Monday', open: '07:30', close: '17:00', closed: false },
  { day: 2, dayName: 'Tuesday', open: '07:30', close: '17:00', closed: false },
  { day: 3, dayName: 'Wednesday', open: '07:30', close: '17:00', closed: false },
  { day: 4, dayName: 'Thursday', open: '07:30', close: '17:00', closed: false },
  { day: 5, dayName: 'Friday', open: '07:30', close: '17:00', closed: false },
  { day: 6, dayName: 'Saturday', open: '07:30', close: '13:00', closed: false },
];

async function weeklySchedule() {
  const rows = await workbook.read('System', 'AccessHours');
  if (!rows.length) return DEFAULT_WEEK.map((d) => ({ ...d }));
  const byDay = new Map(rows.map((r) => [Number(r.day), r]));
  return DEFAULT_WEEK.map((fallback) => {
    const row = byDay.get(fallback.day);
    if (!row) return { ...fallback };
    return {
      id: row.id,
      _rev: row._rev,
      day: Number(row.day),
      dayName: row.dayName || fallback.dayName,
      open: padTime(row.open || fallback.open),
      close: padTime(row.close || fallback.close),
      closed: !!row.closed,
    };
  });
}

async function holidays() {
  return workbook.read('System', 'Holidays');
}

async function specialDays() {
  return workbook.read('System', 'SpecialDays');
}

function holidayFor(rows, date) {
  return (
    rows.find((row) => {
      const from = row.fromDate || row.toDate;
      const to = row.toDate || row.fromDate;
      if (!from) return false;
      return date >= from && date <= to;
    }) || null
  );
}

/**
 * Precedence: special day > holiday > weekly schedule (SPEC §3).
 */
async function scheduleFor(date) {
  const [week, holidayRows, specialRows] = await Promise.all([
    weeklySchedule(),
    holidays(),
    specialDays(),
  ]);

  const special = specialRows.find((row) => row.date === date);
  if (special) {
    return {
      date,
      source: 'special',
      sourceName: special.name || 'Special day',
      closed: !!special.closed,
      open: special.closed ? null : padTime(special.open || '07:30'),
      close: special.closed ? null : padTime(special.close || '17:00'),
    };
  }

  const holiday = holidayFor(holidayRows, date);
  if (holiday) {
    return {
      date,
      source: 'holiday',
      sourceName: holiday.name || 'Holiday',
      closed: true,
      open: null,
      close: null,
    };
  }

  const day = week.find((d) => d.day === dayOfDate(date)) || week[0];
  return {
    date,
    source: 'weekly',
    sourceName: day.dayName,
    closed: !!day.closed,
    open: day.closed ? null : day.open,
    close: day.closed ? null : day.close,
  };
}

/** Next day the portal opens, looking up to a fortnight ahead. */
async function nextOpening(fromDate, afterMinutes = null) {
  for (let offset = 0; offset <= 14; offset += 1) {
    const date = addDays(fromDate, offset);
    const schedule = await scheduleFor(date);
    if (schedule.closed) continue;
    if (offset === 0 && afterMinutes !== null && toMinutes(schedule.open) <= afterMinutes) {
      continue;
    }
    return { date, open: schedule.open, dayName: DAY_NAMES[dayOfDate(date)], offset };
  }
  return null;
}

/* --------------------------------------------------------------- overrides */

async function activeOverride(at = new Date()) {
  const rows = await workbook.read('System', 'HoursOverrides');
  const now = at.getTime();
  return (
    rows.find(
      (row) =>
        row.status === 'active' &&
        row.expiresAt &&
        Date.parse(row.expiresAt) > now &&
        Date.parse(row.startedAt || row.createdAt || 0) <= now
    ) || null
  );
}

const OVERRIDE_CHOICES = [1, 2, 4, 'midnight'];

async function grantOverride({ hours, reason }, ctx) {
  const trimmed = String(reason || '').trim();
  if (trimmed.length < 5) {
    throw errors.validation('Give a reason for extending today — this is recorded.', {
      reason: 'Enter at least a few words.',
    });
  }
  if (!OVERRIDE_CHOICES.includes(hours) && !OVERRIDE_CHOICES.includes(Number(hours))) {
    throw errors.badRequest('Choose 1, 2 or 4 hours, or until midnight.');
  }

  const now = new Date();
  const current = parts(now);
  const expiresAt =
    String(hours) === 'midnight'
      ? instantAt(addDays(current.date, 1), '00:00')
      : shift(now, Number(hours) * 60);

  await workbook.mutate(
    'System',
    (api) => {
      // Only one override at a time; a fresh grant replaces the old one.
      const rows = api.rows('HoursOverrides');
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].status === 'active') {
          rows[i] = { ...rows[i], status: 'superseded', _rev: Number(rows[i]._rev || 1) + 1 };
        }
      }
      crud.insertInto(
        api,
        'System',
        'HoursOverrides',
        {
          date: current.date,
          startedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          hours: String(hours) === 'midnight' ? null : Number(hours),
          reason: trimmed,
          status: 'active',
          grantedBy: crud.actorOf(ctx),
        },
        ctx
      );
    },
    { label: 'grant hours override' }
  );

  return { expiresAt: expiresAt.toISOString(), reason: trimmed, hours };
}

async function endOverride(ctx) {
  const override = await activeOverride();
  if (!override) return null;
  await crud.update(
    'System',
    'HoursOverrides',
    override.id,
    { status: 'ended', expiresAt: new Date().toISOString() },
    ctx,
    { label: 'hours override' }
  );
  return override;
}

async function listOverrides() {
  const rows = await workbook.read('System', 'HoursOverrides');
  return rows
    .slice()
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

/* ------------------------------------------------------------- role config */

async function roleHours() {
  const rows = await workbook.read('System', 'RoleHours');
  const byRole = new Map(rows.map((r) => [r.roleKey, r]));
  return permissions.ROLES.map((role) => {
    const row = byRole.get(role.key);
    return {
      id: row?.id,
      _rev: row?._rev,
      roleKey: role.key,
      roleName: role.name,
      behaviour: row?.behaviour || role.outsideHours.behaviour,
      extendedUntil: padTimeOrEmpty(row?.extendedUntil ?? role.outsideHours.extendedUntil),
      note: row?.note || '',
      locked: ALWAYS_ALLOWED_ROLES.has(role.key),
    };
  });
}

function padTimeOrEmpty(time) {
  if (!time) return '';
  return padTime(time);
}

const BEHAVIOURS = ['full', 'extended', 'readonly', 'blocked'];

async function setRoleHours(roleKey, { behaviour, extendedUntil, note }, ctx) {
  if (ALWAYS_ALLOWED_ROLES.has(roleKey)) {
    throw errors.badRequest(
      'Administrator and Principal always have access. This cannot be changed — it is how you fix a bad schedule at 9pm.'
    );
  }
  if (!BEHAVIOURS.includes(behaviour)) {
    throw errors.badRequest('Choose full access, an extended window, read-only, or blocked.');
  }
  if (behaviour === 'extended' && !toMinutes(extendedUntil)) {
    throw errors.validation('Set the time the extended window ends.', {
      extendedUntil: 'Enter a time like 19:00.',
    });
  }

  return workbook.mutate(
    'System',
    (api) => {
      const rows = api.rows('RoleHours');
      const index = rows.findIndex((r) => r.roleKey === roleKey);
      const payload = {
        roleKey,
        behaviour,
        extendedUntil: behaviour === 'extended' ? padTime(extendedUntil) : '',
        note: note || '',
      };
      if (index === -1) {
        return crud.insertInto(api, 'System', 'RoleHours', payload, ctx);
      }
      return crud.updateIn(api, 'System', 'RoleHours', rows[index].id, payload, ctx, {
        label: 'role hours',
      });
    },
    { label: 'set role hours' }
  );
}

/* -------------------------------------------------------------- the state */

/**
 * The single computation everything else reads.
 *
 * Phases through a normal day:
 *   beforeOpen -> open -> warning -> grace -> readonly -> closed
 */
async function state(at = new Date()) {
  const now = parts(at);
  const config = await settings.getMany([
    'hours.enabled',
    'hours.graceMinutes',
    'hours.warningLeadMinutes',
    'hours.sessionEndMinutesAfterGrace',
  ]);

  const schedule = await scheduleFor(now.date);
  const override = await activeOverride(at);

  const graceMinutes = Number(config['hours.graceMinutes'] ?? 15);
  const warnLead = Number(config['hours.warningLeadMinutes'] ?? 15);
  const sessionEndAfter = Number(config['hours.sessionEndMinutesAfterGrace'] ?? 30);

  const base = {
    serverTime: at.toISOString(),
    localDate: now.date,
    localTime: now.time,
    dayName: now.dayName,
    timezone: TIMEZONE,
    enforced: config['hours.enabled'] !== false,
    schedule,
    override: override
      ? {
          expiresAt: override.expiresAt,
          reason: override.reason,
          grantedBy: override.grantedBy,
        }
      : null,
    graceMinutes,
    warnLeadMinutes: warnLead,
  };

  const openMinutes = schedule.closed ? null : toMinutes(schedule.open);
  let closeMinutes = schedule.closed ? null : toMinutes(schedule.close);

  // An override pushes today's closing time out; it never pulls it in.
  let overrideCloseMinutes = null;
  if (override) {
    const overrideParts = parts(new Date(Date.parse(override.expiresAt)));
    overrideCloseMinutes =
      overrideParts.date === now.date ? overrideParts.minuteOfDay : 24 * 60;
    if (closeMinutes === null || overrideCloseMinutes > closeMinutes) {
      closeMinutes = overrideCloseMinutes;
    }
  }

  // A closed day with an active override becomes open from now until the override ends.
  const effectivelyClosed = schedule.closed && overrideCloseMinutes === null;

  if (effectivelyClosed) {
    const next = await nextOpening(addDays(now.date, 1));
    return {
      ...base,
      phase: 'closed',
      open: false,
      closesAt: null,
      graceEndsAt: null,
      sessionEndsAt: null,
      nextOpening: next,
      reason: schedule.source === 'holiday' ? `${schedule.sourceName} (holiday)` : 'Closed today',
    };
  }

  const effectiveOpen = schedule.closed ? now.minuteOfDay : openMinutes;
  const graceEnd = closeMinutes + graceMinutes;
  const sessionEnd = graceEnd + sessionEndAfter;
  const warnFrom = closeMinutes - warnLead;

  const closesAt = instantAt(now.date, fromMinutes(closeMinutes)).toISOString();
  const graceEndsAt = instantAt(now.date, fromMinutes(Math.min(graceEnd, 1439))).toISOString();
  const sessionEndsAt = instantAt(now.date, fromMinutes(Math.min(sessionEnd, 1439))).toISOString();
  const opensAt = instantAt(now.date, fromMinutes(effectiveOpen)).toISOString();

  let phase;
  if (now.minuteOfDay < effectiveOpen) phase = 'beforeOpen';
  else if (now.minuteOfDay < warnFrom) phase = 'open';
  else if (now.minuteOfDay < closeMinutes) phase = 'warning';
  else if (now.minuteOfDay < graceEnd) phase = 'grace';
  else if (now.minuteOfDay < sessionEnd) phase = 'readonly';
  else phase = 'closed';

  const next =
    phase === 'closed'
      ? await nextOpening(now.date, now.minuteOfDay)
      : await nextOpening(now.date, null);

  return {
    ...base,
    phase,
    open: phase === 'open' || phase === 'warning' || phase === 'grace',
    opensAt,
    closesAt,
    graceEndsAt,
    sessionEndsAt,
    closeTimeLabel: friendlyTime(fromMinutes(closeMinutes)),
    openTimeLabel: friendlyTime(fromMinutes(effectiveOpen)),
    minutesToClose: closeMinutes - now.minuteOfDay,
    nextOpening: next,
    reason: null,
  };
}

/* --------------------------------------------------------- role resolution */

function describeNextOpening(next) {
  if (!next) return 'Check with the office for the next opening time.';
  const when =
    next.offset === 0 ? 'today' : next.offset === 1 ? 'tomorrow' : `on ${next.dayName}`;
  return `Opens ${when} at ${friendlyTime(next.open)}.`;
}

/**
 * @returns {{access: 'full'|'readOnly'|'blocked', message: string|null, phase: string}}
 */
async function accessFor(roleKey, current = null) {
  const snapshot = current || (await state());

  if (ALWAYS_ALLOWED_ROLES.has(roleKey)) {
    return { access: 'full', message: null, phase: snapshot.phase, state: snapshot };
  }
  if (!snapshot.enforced) {
    return { access: 'full', message: null, phase: snapshot.phase, state: snapshot };
  }
  if (snapshot.override) {
    return { access: 'full', message: null, phase: snapshot.phase, state: snapshot };
  }

  if (snapshot.phase === 'open' || snapshot.phase === 'warning' || snapshot.phase === 'grace') {
    return { access: 'full', message: null, phase: snapshot.phase, state: snapshot };
  }

  if (snapshot.phase === 'readonly') {
    return {
      access: 'readOnly',
      message:
        'The portal has closed for the day. You can still view, print and export, but not save changes.',
      phase: snapshot.phase,
      state: snapshot,
    };
  }

  // Fully outside hours — the per-role table decides.
  const roles = await roleHours();
  const config = roles.find((r) => r.roleKey === roleKey);
  const behaviour = config?.behaviour || 'blocked';
  const nextText = describeNextOpening(snapshot.nextOpening);

  if (behaviour === 'full') {
    return { access: 'full', message: null, phase: snapshot.phase, state: snapshot };
  }

  if (behaviour === 'extended') {
    const now = parts();
    const until = toMinutes(config.extendedUntil);
    const withinExtended =
      snapshot.phase !== 'beforeOpen' && until !== null && now.minuteOfDay < until;
    if (withinExtended) {
      return {
        access: 'full',
        message: `Your extended window ends at ${friendlyTime(config.extendedUntil)}.`,
        phase: snapshot.phase,
        state: snapshot,
      };
    }
    return {
      access: 'readOnly',
      message: `Your extended window ended at ${friendlyTime(
        config.extendedUntil
      )}. You can view, print and export until the portal reopens.`,
      phase: snapshot.phase,
      state: snapshot,
    };
  }

  if (behaviour === 'readonly') {
    return {
      access: 'readOnly',
      message: `The portal is closed. ${nextText} You can view, print and export in the meantime.`,
      phase: snapshot.phase,
      state: snapshot,
    };
  }

  return {
    access: 'blocked',
    message: `The portal is closed. ${nextText}`,
    phase: snapshot.phase,
    state: snapshot,
  };
}

/* ------------------------------------------------------------------ seeding */

async function seed(ctx) {
  await workbook.mutate(
    'System',
    (api) => {
      const hoursRows = api.rows('AccessHours');
      for (const day of DEFAULT_WEEK) {
        if (hoursRows.some((r) => Number(r.day) === day.day)) continue;
        crud.insertInto(api, 'System', 'AccessHours', day, ctx);
      }
      const roleRows = api.rows('RoleHours');
      for (const role of permissions.ROLES) {
        if (roleRows.some((r) => r.roleKey === role.key)) continue;
        crud.insertInto(
          api,
          'System',
          'RoleHours',
          {
            roleKey: role.key,
            behaviour: role.outsideHours.behaviour,
            extendedUntil: role.outsideHours.extendedUntil,
            note: '',
          },
          ctx
        );
      }
    },
    { label: 'seed access hours' }
  );
}

async function setWeeklySchedule(days, ctx) {
  for (const day of days) {
    if (day.closed) continue;
    const open = toMinutes(day.open);
    const close = toMinutes(day.close);
    if (open === null || close === null) {
      throw errors.validation('Enter both an opening and a closing time.', {
        [`day${day.day}`]: 'Times must look like 07:30.',
      });
    }
    if (close <= open) {
      throw errors.validation(
        `${DAY_NAMES[day.day]} closes before it opens. Check the times.`,
        { [`day${day.day}`]: 'Closing time must be after opening time.' }
      );
    }
  }

  return workbook.mutate(
    'System',
    (api) => {
      const rows = api.rows('AccessHours');
      for (const day of days) {
        const index = rows.findIndex((r) => Number(r.day) === Number(day.day));
        const payload = {
          day: Number(day.day),
          dayName: DAY_NAMES[Number(day.day)],
          open: day.closed ? '' : padTime(day.open),
          close: day.closed ? '' : padTime(day.close),
          closed: !!day.closed,
        };
        if (index === -1) crud.insertInto(api, 'System', 'AccessHours', payload, ctx);
        else crud.updateIn(api, 'System', 'AccessHours', rows[index].id, payload, ctx, {
          label: 'access hours',
        });
      }
      return true;
    },
    { label: 'set weekly schedule' }
  );
}

module.exports = {
  TIMEZONE,
  DAY_NAMES,
  ALWAYS_ALLOWED_ROLES,
  BEHAVIOURS,
  OVERRIDE_CHOICES,
  parts,
  instantAt,
  toMinutes,
  fromMinutes,
  padTime,
  friendlyTime,
  addDays,
  dayOfDate,
  weeklySchedule,
  setWeeklySchedule,
  scheduleFor,
  nextOpening,
  describeNextOpening,
  activeOverride,
  grantOverride,
  endOverride,
  listOverrides,
  roleHours,
  setRoleHours,
  state,
  accessFor,
  seed,
};
