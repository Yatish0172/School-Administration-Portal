'use strict';

const express = require('express');
const os = require('os');

const { ok, handler, body, str, num, bool, flag, isoDate, pagination } = require('../http');
const { need } = require('../middleware/permission');
const { rateLimit } = require('../middleware/rateLimit');
const { invalidateCache } = require('../middleware/licenseGuard');
const settings = require('../store/settings');
const counters = require('../store/counters');
const audit = require('../store/audit');
const journal = require('../store/journal');
const workbook = require('../store/workbook');
const sessions = require('../store/sessions');
const users = require('../store/users');
const lock = require('../store/lock');
const exporter = require('../store/exporter');
const hours = require('../services/hours');
const clock = require('../services/clock');
const net = require('../services/net');
const backup = require('../services/backup');
const license = require('../services/license');
const files = require('../services/files');
const errors = require('../errors');

const router = express.Router();

/**
 * Two routers: `openRouter` is mounted before the authentication chain, `router`
 * after it. Splitting them keeps the exemption list explicit instead of scattered
 * through middleware conditionals.
 */
const openRouter = express.Router();

/** Health check, deliberately unauthenticated so the Access screen can poll it. */
openRouter.get(
  '/health',
  handler(async (req, res) => {
    const state = await hours.state();
    return ok(res, {
      time: new Date().toISOString(),
      localTime: state.localTime,
      localDate: state.localDate,
      timezone: hours.TIMEZONE,
      phase: state.phase,
      open: state.open,
    });
  })
);

/**
 * The Access screen (SPEC §1). Available without a session because it is what the
 * admin looks at on the server PC before anyone has signed in.
 * Restricted to the server PC itself — the QR and firewall instructions are not
 * information a student on the Wi-Fi needs.
 */
openRouter.get(
  '/access',
  handler(async (req, res) => {
    if (!req.isLocalhost) {
      throw errors.forbidden('The access details are only shown on the server PC.');
    }
    const port = Number(process.env.PORT || 4700);
    const access = net.accessInfo(port);
    const previousIp = await settings.get('system.lastLanIp', '');
    const state = await hours.state();
    const clockState = clock.lastWarningState();

    return ok(res, {
      ...access,
      firewallCommand: net.firewallCommand(port),
      mdnsHostname: net.MDNS_HOSTNAME,
      addressChanged: !!(previousIp && access.ip && previousIp !== access.ip),
      previousIp: previousIp || null,
      // When the Wi-Fi route is off, none of the LAN guidance on this screen applies.
      lanEnabled: (await settings.get('network.lanEnabled', true)) !== false,
      serverTime: new Date().toISOString(),
      localTime: state.localTime,
      localDate: state.localDate,
      dayName: state.dayName,
      timezone: hours.TIMEZONE,
      phase: state.phase,
      closeTimeLabel: state.closeTimeLabel || null,
      usersOnline: sessions.count(),
      clockWarning: clockState ? clockState.message : null,
      schoolName: await settings.get('school.name', 'My School'),
      guidance: {
        dhcp:
          'Ask whoever manages the router to add a DHCP reservation binding this PC\'s MAC address to this IP. ' +
          'That keeps the address the same after a reboot.',
        mdns:
          `The name ${net.MDNS_HOSTNAME} is advertised on the network, so staff can use it even if the IP changes. ` +
          'Some routers block this, so print the IP as well.',
        security:
          'The QR code only tells a device where the server is. Anyone on the school Wi-Fi, including students, ' +
          'can reach the sign-in page. Device enrollment and passwords are what protect the data.',
        wiring:
          'Keep this PC on wired Ethernet if possible. If the school has separate staff and student Wi-Fi, ' +
          'put the server on the staff network only.',
      },
    });
  })
);

/* ------------------------------------------------------- authenticated below */

/** Public-ish settings every screen needs: school name, logo, doc types. */
router.get(
  '/settings/public',
  handler(async (req, res) => {
    const all = await settings.all();
    return ok(res, {
      school: {
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
      },
      attendance: {
        lockHours: all['attendance.lockHours'],
        periodWise: all['attendance.periodWise'],
        defaulterThreshold: all['attendance.defaulterThreshold'],
      },
      fees: { receiptFooter: all['fees.receiptFooter'] },
      uploads: { maxSizeMb: all['uploads.maxSizeMb'], docTypes: files.DOC_TYPES },
    });
  })
);

router.get(
  '/settings',
  need('settings.edit'),
  handler(async (req, res) =>
    ok(res, {
      values: await settings.all(),
      definitions: settings.editableDefinitions(),
      counters: await counters.listAll(),
    })
  )
);

router.put(
  '/settings',
  need('settings.edit'),
  handler(async (req, res) => {
    const input = body(req);
    const patch = input.values && typeof input.values === 'object' ? input.values : {};
    const before = await settings.all();
    const applied = await settings.setMany(patch, { userId: req.user.id });

    const changed = {};
    for (const key of Object.keys(applied)) {
      if (String(before[key]) !== String(applied[key])) {
        changed[key] = { from: before[key], to: applied[key] };
      }
    }

    if (Object.keys(changed).length) {
      await audit.fromRequest(req, {
        action: audit.ACTIONS.SETTING_CHANGED,
        entityType: 'settings',
        entityId: Object.keys(changed).join(','),
        before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.from])),
        after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])),
        message: `Changed ${Object.keys(changed).length} setting(s)`,
      });
    }

    return ok(res, { values: await settings.all(), changed });
  })
);

router.put(
  '/settings/counters/:name',
  need('settings.edit'),
  handler(async (req, res) => {
    const input = body(req);
    await counters.configure(
      req.params.name,
      { prefix: str(input.prefix, { max: 12 }) ?? '', padding: num(input.padding, { min: 0, max: 12 }) },
      { userId: req.user.id }
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.SETTING_CHANGED,
      entityType: 'counter',
      entityId: req.params.name,
      after: { prefix: input.prefix, padding: input.padding },
      message: `Changed the ${req.params.name} number format`,
    });
    return ok(res, await counters.listAll());
  })
);

/* -------------------------------------------------------------------- hours */

router.get(
  '/hours/state',
  handler(async (req, res) => {
    const verdict = await hours.accessFor(req.user.roleKey);
    return ok(res, {
      access: verdict.access,
      message: verdict.message,
      ...verdict.state,
    });
  })
);

router.get(
  '/hours/config',
  need('hours.manage'),
  handler(async (req, res) =>
    ok(res, {
      week: await hours.weeklySchedule(),
      roles: await hours.roleHours(),
      holidays: await workbook.read('System', 'Holidays'),
      specialDays: await workbook.read('System', 'SpecialDays'),
      overrides: await hours.listOverrides(),
      activeOverride: await hours.activeOverride(),
      settings: await settings.getMany([
        'hours.enabled',
        'hours.graceMinutes',
        'hours.warningLeadMinutes',
        'hours.sessionEndMinutesAfterGrace',
      ]),
      behaviours: hours.BEHAVIOURS,
      alwaysAllowed: [...hours.ALWAYS_ALLOWED_ROLES],
    })
  )
);

router.put(
  '/hours/week',
  need('hours.manage'),
  handler(async (req, res) => {
    const input = body(req);
    if (!Array.isArray(input.days)) throw errors.badRequest('Send the seven days of the week.');
    const before = await hours.weeklySchedule();
    await hours.setWeeklySchedule(input.days, { userId: req.user.id });
    const after = await hours.weeklySchedule();
    await audit.fromRequest(req, {
      action: audit.ACTIONS.HOURS_UPDATED,
      entityType: 'accessHours',
      entityId: 'week',
      before,
      after,
      message: 'Changed the weekly opening hours',
    });
    return ok(res, after);
  })
);

router.put(
  '/hours/roles/:roleKey',
  need('hours.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const before = (await hours.roleHours()).find((r) => r.roleKey === req.params.roleKey);
    await hours.setRoleHours(
      req.params.roleKey,
      {
        behaviour: str(input.behaviour, { max: 20 }),
        extendedUntil: str(input.extendedUntil, { max: 5 }),
        note: str(input.note, { max: 200 }),
      },
      { userId: req.user.id }
    );
    const after = (await hours.roleHours()).find((r) => r.roleKey === req.params.roleKey);
    await audit.fromRequest(req, {
      action: audit.ACTIONS.HOURS_UPDATED,
      entityType: 'roleHours',
      entityId: req.params.roleKey,
      before,
      after,
      message: `Changed out-of-hours access for ${req.params.roleKey}`,
    });
    return ok(res, after);
  })
);

router.post(
  '/hours/holidays',
  need('hours.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const crud = require('../store/crud');
    const fromDate = isoDate(input.fromDate);
    if (!fromDate) throw errors.validation('Choose a start date.', { fromDate: 'Required.' });
    if (!str(input.name)) throw errors.validation('Name the holiday.', { name: 'Required.' });
    const row = await crud.create(
      'System',
      'Holidays',
      {
        name: str(input.name, { max: 100 }),
        fromDate,
        toDate: isoDate(input.toDate) || fromDate,
        description: str(input.description, { max: 200 }),
      },
      { userId: req.user.id },
      { label: 'create holiday' }
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.HOURS_UPDATED,
      entityType: 'holiday',
      entityId: row.id,
      after: row,
      message: `Added holiday "${row.name}"`,
    });
    return ok(res, row);
  })
);

router.delete(
  '/hours/holidays/:id',
  need('hours.manage'),
  handler(async (req, res) => {
    const crud = require('../store/crud');
    const before = await crud.getOrFail('System', 'Holidays', req.params.id, 'holiday');
    await workbook.mutate('System', (api) => {
      api.replace(
        'Holidays',
        api.rows('Holidays').filter((r) => r.id !== req.params.id)
      );
    });
    await audit.fromRequest(req, {
      action: audit.ACTIONS.HOURS_UPDATED,
      entityType: 'holiday',
      entityId: req.params.id,
      before,
      message: `Removed holiday "${before.name}"`,
    });
    return ok(res, { removed: true });
  })
);

router.post(
  '/hours/special-days',
  need('hours.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const crud = require('../store/crud');
    const date = isoDate(input.date);
    if (!date) throw errors.validation('Choose the date.', { date: 'Required.' });
    const closed = flag(input.closed);
    if (!closed) {
      if (!hours.toMinutes(input.open) || !hours.toMinutes(input.close)) {
        throw errors.validation('Set the opening and closing time for that day.', {
          open: 'Enter a time like 06:30.',
        });
      }
    }

    const row = await workbook.mutate(
      'System',
      (api) => {
        const rows = api.rows('SpecialDays');
        const index = rows.findIndex((r) => r.date === date);
        const payload = {
          date,
          name: str(input.name, { max: 100 }) || 'Special day',
          open: closed ? '' : hours.padTime(input.open),
          close: closed ? '' : hours.padTime(input.close),
          closed,
          reason: str(input.reason, { max: 200 }),
        };
        if (index === -1) {
          return crud.insertInto(api, 'System', 'SpecialDays', payload, { userId: req.user.id });
        }
        return crud.updateIn(api, 'System', 'SpecialDays', rows[index].id, payload, {
          userId: req.user.id,
        }, { label: 'special day' });
      },
      { label: 'set special day' }
    );

    await audit.fromRequest(req, {
      action: audit.ACTIONS.HOURS_UPDATED,
      entityType: 'specialDay',
      entityId: date,
      after: row,
      message: `Set special hours for ${date}`,
    });
    return ok(res, row);
  })
);

router.delete(
  '/hours/special-days/:id',
  need('hours.manage'),
  handler(async (req, res) => {
    await workbook.mutate('System', (api) => {
      api.replace(
        'SpecialDays',
        api.rows('SpecialDays').filter((r) => r.id !== req.params.id)
      );
    });
    await audit.fromRequest(req, {
      action: audit.ACTIONS.HOURS_UPDATED,
      entityType: 'specialDay',
      entityId: req.params.id,
      message: 'Removed a special day',
    });
    return ok(res, { removed: true });
  })
);

/** Emergency override: Admin only, reason mandatory, auto-expiring, audited. */
router.post(
  '/hours/override',
  need('hours.override'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await hours.grantOverride(
      { hours: input.hours === 'midnight' ? 'midnight' : Number(input.hours), reason: input.reason },
      { userId: req.user.id }
    );
    await audit.fromRequest(req, {
      action: audit.ACTIONS.HOURS_OVERRIDE,
      entityType: 'hoursOverride',
      entityId: result.expiresAt,
      after: result,
      message: `Extended today until ${result.expiresAt}: ${result.reason}`,
    });
    return ok(res, result);
  })
);

router.delete(
  '/hours/override',
  need('hours.override'),
  handler(async (req, res) => {
    const ended = await hours.endOverride({ userId: req.user.id });
    if (ended) {
      await audit.fromRequest(req, {
        action: audit.ACTIONS.HOURS_OVERRIDE_ENDED,
        entityType: 'hoursOverride',
        entityId: ended.id,
        before: ended,
        message: 'Ended the hours override early',
      });
    }
    return ok(res, { ended: !!ended });
  })
);

/* -------------------------------------------------------------------- audit */

router.get(
  '/audit',
  need('audit.view'),
  handler(async (req, res) => {
    const page = pagination(req.query);
    const result = await audit.list({
      from: isoDate(req.query.from),
      to: isoDate(req.query.to),
      userId: str(req.query.userId, { max: 40 }),
      action: str(req.query.action, { max: 60 }),
      entityType: str(req.query.entityType, { max: 40 }),
      search: page.search,
      page: page.page,
      pageSize: page.pageSize,
    });
    const allUsers = await users.all();
    return ok(res, {
      ...result,
      actions: await audit.distinctActions(),
      users: allUsers.map((u) => ({ id: u.id, name: u.name, roleKey: u.roleKey })),
    });
  })
);

router.get(
  '/audit/export',
  need('audit.view'),
  handler(async (req, res) => {
    const result = await audit.list({
      from: isoDate(req.query.from),
      to: isoDate(req.query.to),
      userId: str(req.query.userId, { max: 40 }),
      action: str(req.query.action, { max: 60 }),
      pageSize: 100000,
      page: 1,
    });
    const buffer = await exporter.buildSingleSheet({
      title: 'Audit log',
      subtitle: [req.query.from, req.query.to].filter(Boolean).join(' to ') || 'All dates',
      columns: [
        { key: 'at', label: 'When', width: 24 },
        { key: 'userName', label: 'User', width: 20 },
        { key: 'role', label: 'Role', width: 14 },
        { key: 'action', label: 'Action', width: 26 },
        { key: 'entityType', label: 'Record type', width: 16 },
        { key: 'entityId', label: 'Record', width: 36 },
        { key: 'message', label: 'Detail', width: 50 },
        { key: 'ip', label: 'From', width: 16 },
      ],
      rows: result.rows,
      meta: {
        schoolName: await settings.get('school.name'),
        generatedBy: req.user.name,
        generatedAt: new Date().toISOString(),
      },
    });
    return sendXlsx(res, buffer, exporter.fileName('audit-log'));
  })
);

/* ------------------------------------------------------------------- backup */

router.get(
  '/backup',
  need('backup.run'),
  handler(async (req, res) =>
    ok(res, {
      status: await backup.status(),
      history: await backup.history(50),
      files: await backup.listFiles(),
      settings: await settings.getMany([
        'backup.dailyHour',
        'backup.retainDaily',
        'backup.retainMonthly',
        'backup.secondaryPath',
      ]),
    })
  )
);

router.post(
  '/backup/run',
  need('backup.run'),
  handler(async (req, res) => {
    const result = await backup.run({ kind: 'manual', ctx: { userId: req.user.id } });
    return ok(res, result);
  })
);

/**
 * Restore requires the admin to re-enter their password. A misdirected click here
 * would overwrite the school's live data.
 */
router.post(
  '/backup/restore',
  need('backup.restore'),
  rateLimit({ windowMs: 300000, max: 5, message: 'Too many restore attempts. Wait five minutes.' }),
  handler(async (req, res) => {
    const input = body(req);
    const file = str(input.file, { max: 200 });
    const password = input.password ? String(input.password) : '';
    if (!file) throw errors.badRequest('Choose which backup to restore.');
    if (input.confirm !== 'RESTORE') {
      throw errors.badRequest('Type RESTORE to confirm. This replaces all current data.');
    }

    const verdict = await users.verifyCredential(req.user.username, password);
    if (!verdict.ok) {
      await audit.fromRequest(req, {
        action: audit.ACTIONS.LOGIN_FAILED,
        entityType: 'restore',
        entityId: file,
        message: 'Restore refused: re-authentication failed',
      });
      throw errors.unauthorized('That password is not correct. The restore was not started.');
    }

    const result = await backup.restore(file, {
      userId: req.user.id,
      name: req.user.name,
      roleKey: req.user.roleKey,
      sessionToken: req.sessionToken,
    });
    return ok(res, result);
  })
);

/* ------------------------------------------------------- remote access */

/**
 * Remote access is administrator-only: it decides whether the school's data is
 * reachable from outside the building at all.
 */
router.get(
  '/remote',
  need('settings.edit'),
  handler(async (req, res) => {
    const tunnel = require('../services/tunnel');
    const state = await tunnel.status();
    // What to tell the office depends on whether enrollment is gating sign-in.
    const deviceEnforcement = await settings.get('devices.enforce', false);
    return ok(res, {
      ...state,
      deviceEnforcement,
      warning: deviceEnforcement
        ? 'Anyone holding the link reaches the sign-in page, exactly as anyone on the school Wi-Fi does. ' +
          'Device enrollment, passwords and school hours are what protect the data — not the secrecy of the address.'
        : 'Device enrollment is off, so anyone with today’s link and a staff password can sign in from anywhere ' +
          'on the internet. Treat the link as staff-only, never post it in a group parents can see, and change ' +
          'any password you think has been shared. Accounts lock for 15 minutes after 5 wrong attempts.',
      staffGuidance: deviceEnforcement
        ? [
            'Send the staff member the current link.',
            'Their first sign-in from a new phone or laptop needs an enrollment code from Settings → Devices.',
            'After that the device is remembered and they can sign in from anywhere the link works.',
            'Their role still limits what they see, and school hours still apply.',
          ]
        : [
            'Send staff the current link — it changes every day, so send the new one each morning.',
            'They sign in with their own username and password. No enrollment code is needed.',
            'Yesterday’s link stops working, and it signs them out, so they sign in again on the new one.',
            'Their role still limits what they see, and school hours still apply.',
          ],
    });
  })
);

router.post(
  '/remote/start',
  need('settings.edit'),
  handler(async (req, res) => {
    const tunnel = require('../services/tunnel');
    const state = await tunnel.start({ userId: req.user.id, name: req.user.name, roleKey: req.user.roleKey });
    return ok(res, state);
  })
);

router.post(
  '/remote/stop',
  need('settings.edit'),
  handler(async (req, res) => {
    const tunnel = require('../services/tunnel');
    const state = await tunnel.stop({
      ctx: { userId: req.user.id, name: req.user.name, roleKey: req.user.roleKey },
    });
    return ok(res, state);
  })
);

/** Issues a new link immediately; the old one stops working at once. */
router.post(
  '/remote/rotate',
  need('settings.edit'),
  handler(async (req, res) => {
    const tunnel = require('../services/tunnel');
    const state = await tunnel.rotate({ userId: req.user.id, name: req.user.name, roleKey: req.user.roleKey });
    return ok(res, state);
  })
);

/* ------------------------------------------------------------------ license */

router.get(
  '/license',
  handler(async (req, res) => {
    const state = await license.state();
    const canManage = req.user.permissions.includes('license.manage');
    return ok(res, {
      ...state,
      trialDays: license.TRIAL_DAYS,
      graceDays: license.GRACE_DAYS,
      canManage,
      emergencyProcess: canManage
        ? [
            'If this PC fails, a replacement key can be issued for the new machine.',
            'Send support the machine ID shown on this screen from the new PC.',
            'A replacement key is normally issued the same working day.',
            'Your data lives in the Database folder — restore it from a backup on the new PC first.',
            'Export always works, whatever the licence says.',
          ]
        : null,
    });
  })
);

router.post(
  '/license/activate',
  need('license.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const key = input.key ? String(input.key) : '';
    if (!key) throw errors.badRequest('Paste the product key.');
    const state = await license.activate(key, { userId: req.user.id });
    invalidateCache();
    await audit.fromRequest(req, {
      action: audit.ACTIONS.LICENSE_ACTIVATED,
      entityType: 'license',
      entityId: state.machineId,
      after: { status: state.status, licensedTo: state.licensedTo, expiresAt: state.expiresAt },
      message: `Licence activated for ${state.licensedTo || 'this school'}`,
    });
    return ok(res, state);
  })
);

/* ------------------------------------------------------------------- health */

router.get(
  '/health/detail',
  need('health.view'),
  handler(async (req, res) => {
    const state = await hours.state();
    const licenseState = await license.state();
    return ok(res, {
      server: {
        time: new Date().toISOString(),
        localTime: state.localTime,
        localDate: state.localDate,
        timezone: hours.TIMEZONE,
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        platform: `${os.type()} ${os.release()}`,
        hostname: os.hostname(),
        freeMemoryMb: Math.round(os.freemem() / 1048576),
        totalMemoryMb: Math.round(os.totalmem() / 1048576),
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
      },
      storage: {
        loadedWorkbooks: workbook.loadedKeys(),
        heldLocks: lock.heldLocks(),
        maxRowsPerSheet: workbook.MAX_ROWS_PER_SHEET,
      },
      journal: await journal.pendingSnapshots(),
      backup: await backup.status(),
      license: {
        status: licenseState.status,
        daysLeft: licenseState.daysLeft,
        machineId: licenseState.machineId,
      },
      hours: state,
      sessions: { count: sessions.count(), online: sessions.online() },
      clockWarning: clock.lastWarningState(),
    });
  })
);

function sendXlsx(res, buffer, filename) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(Buffer.from(buffer));
}

module.exports = { router, openRouter, sendXlsx };
