'use strict';

const express = require('express');

const { ok, handler, body, str, num, bool, pagination } = require('../http');
const { need } = require('../middleware/permission');
const users = require('../store/users');
const permissions = require('../store/permissions');
const devices = require('../store/devices');
const sessions = require('../store/sessions');
const settings = require('../store/settings');
const audit = require('../store/audit');
const staff = require('../store/staff');
const errors = require('../errors');

const router = express.Router();

/* -------------------------------------------------------------------- users */

router.get(
  '/users',
  need('user.manage'),
  handler(async (req, res) => {
    const page = pagination(req.query);
    const result = await users.list({
      ...page,
      where: req.query.status ? (row) => row.status === req.query.status : null,
    });
    return ok(res, {
      ...result,
      rows: result.rows.map((row) => ({
        ...users.publicUser(row),
        locked: users.lockRemainingMinutes(row) > 0,
        lockedMinutes: users.lockRemainingMinutes(row),
      })),
      roles: await permissions.listRoles(),
    });
  })
);

router.get(
  '/users/:id',
  need('user.manage'),
  handler(async (req, res) => {
    const user = await users.get(req.params.id);
    if (!user) throw errors.notFound('That user could not be found.');
    return ok(res, {
      user: users.publicUser(user),
      devices: await devices.listDevices({ userId: user.id }),
      permissions: await permissions.permissionsForRole(user.roleKey),
    });
  })
);

router.post(
  '/users',
  need('user.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const created = await users.create(
      {
        username: str(input.username, { max: 32 }),
        name: str(input.name, { max: 80 }),
        email: str(input.email, { max: 120 }),
        phone: str(input.phone, { max: 15 }),
        roleKey: str(input.roleKey, { max: 30 }),
        department: str(input.department, { max: 60 }),
        credentialType: str(input.credentialType, { max: 10 }),
        secret: input.secret ? String(input.secret) : null,
        staffId: str(input.staffId, { max: 40 }),
        deviceCap: num(input.deviceCap, { min: 1, max: 20 }),
        mustChangePassword: input.mustChangePassword !== false,
      },
      { userId: req.user.id }
    );

    await audit.fromRequest(req, {
      action: audit.ACTIONS.USER_CREATED,
      entityType: 'user',
      entityId: created.id,
      after: { username: created.username, name: created.name, roleKey: created.roleKey },
      message: `Created user ${created.username} (${created.roleKey})`,
    });
    return ok(res, created);
  })
);

router.put(
  '/users/:id',
  need('user.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const result = await users.update(
      req.params.id,
      {
        name: str(input.name, { max: 80 }),
        email: str(input.email, { max: 120 }),
        phone: str(input.phone, { max: 15 }),
        roleKey: str(input.roleKey, { max: 30 }),
        department: str(input.department, { max: 60 }),
        credentialType: str(input.credentialType, { max: 10 }),
        staffId: str(input.staffId, { max: 40 }),
        deviceCap: num(input.deviceCap, { min: 1, max: 20 }),
      },
      { userId: req.user.id },
      { expectedRev: input._rev }
    );

    await audit.fromRequest(req, {
      action: audit.ACTIONS.USER_UPDATED,
      entityType: 'user',
      entityId: req.params.id,
      before: result.before,
      after: result.after,
      message: `Updated user ${result.after.username}`,
    });

    // A role change rewrites what they can do; make them pick up the new set.
    if (result.before.roleKey !== result.after.roleKey) {
      await sessions.destroyForUser(req.params.id, 'roleChanged');
    }
    return ok(res, result.after);
  })
);

router.post(
  '/users/:id/status',
  need('user.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const status = str(input.status, { max: 10 });
    if (req.params.id === req.user.id && status === 'disabled') {
      throw errors.badRequest('You cannot disable your own account.');
    }

    const result = await users.setStatus(req.params.id, status, { userId: req.user.id });
    if (status === 'disabled') {
      await sessions.destroyForUser(req.params.id, 'disabled');
    }

    await audit.fromRequest(req, {
      action: status === 'disabled' ? audit.ACTIONS.USER_DISABLED : audit.ACTIONS.USER_ENABLED,
      entityType: 'user',
      entityId: req.params.id,
      before: { status: result.before.status },
      after: { status: result.after.status },
      message: `${status === 'disabled' ? 'Disabled' : 'Re-enabled'} user ${result.after.username}`,
    });
    return ok(res, result.after);
  })
);

/**
 * Admin-initiated reset. The temporary secret is returned exactly once, for the
 * admin to read out, and the user must change it at first sign-in.
 */
router.post(
  '/users/:id/reset-credential',
  need('user.manage'),
  handler(async (req, res) => {
    const result = await users.resetSecret(req.params.id, { userId: req.user.id });
    await sessions.destroyForUser(req.params.id, 'credentialReset');

    const target = await users.get(req.params.id);
    await audit.fromRequest(req, {
      action: audit.ACTIONS.PIN_RESET,
      entityType: 'user',
      entityId: req.params.id,
      message: `Reset the ${result.credentialType} for ${target.username}`,
    });

    return ok(res, {
      credentialType: result.credentialType,
      secret: result.secret,
      note: 'Read this out to them now. It is not stored and cannot be shown again.',
    });
  })
);

router.post(
  '/users/:id/unlock',
  need('user.manage'),
  handler(async (req, res) => {
    await users.unlock(req.params.id, { userId: req.user.id });
    const target = await users.get(req.params.id);
    await audit.fromRequest(req, {
      action: audit.ACTIONS.USER_UPDATED,
      entityType: 'user',
      entityId: req.params.id,
      message: `Unlocked ${target.username} after failed sign-ins`,
    });
    return ok(res, { unlocked: true });
  })
);

/** Staff members who have no login yet — the picker when creating a user. */
router.get(
  '/users/link/staff',
  need('user.manage'),
  handler(async (req, res) => {
    const all = await staff.list({ pageSize: 0 });
    const linked = new Set((await users.all()).map((u) => u.staffId).filter(Boolean));
    return ok(
      res,
      all.rows
        .filter((member) => member.status === 'active' && !linked.has(member.id))
        .map((member) => ({
          id: member.id,
          name: member.name,
          staffCode: member.staffCode,
          designation: member.designation,
          department: member.department,
          email: member.email,
          phone: member.phone,
        }))
    );
  })
);

/* -------------------------------------------------------------------- roles */

router.get(
  '/roles',
  need('role.manage'),
  handler(async (req, res) => ok(res, await permissions.matrix()))
);

router.put(
  '/roles/:roleKey/permissions',
  need('role.manage'),
  handler(async (req, res) => {
    const input = body(req);
    if (!Array.isArray(input.permissions)) {
      throw errors.badRequest('Send the list of permissions for this role.');
    }
    if (req.params.roleKey === 'admin') {
      throw errors.badRequest(
        'The Administrator role always has every permission. This cannot be changed — it is how you recover from a mistake here.'
      );
    }

    const result = await permissions.setRolePermissions(
      req.params.roleKey,
      input.permissions.map(String),
      { userId: req.user.id }
    );

    await audit.fromRequest(req, {
      action: audit.ACTIONS.PERMISSION_CHANGED,
      entityType: 'role',
      entityId: req.params.roleKey,
      before: result.before,
      after: result.after,
      message: `Changed permissions for ${req.params.roleKey}`,
    });

    // Everyone in that role needs to reload their permission set.
    const affected = (await users.all()).filter((u) => u.roleKey === req.params.roleKey);
    for (const user of affected) {
      await sessions.destroyForUser(user.id, 'permissionsChanged');
    }

    return ok(res, { ...result, sessionsEnded: affected.length });
  })
);

/* ------------------------------------------------------------------ devices */

router.get(
  '/devices',
  need('device.manage'),
  handler(async (req, res) => {
    const rows = await devices.listDevices({
      userId: str(req.query.userId, { max: 40 }),
      status: str(req.query.status, { max: 10 }),
    });
    const allUsers = await users.all();
    const byId = new Map(allUsers.map((u) => [u.id, u]));
    return ok(res, {
      rows: rows.map((row) => ({
        ...row,
        userName: byId.get(row.userId)?.name || 'Unknown user',
        username: byId.get(row.userId)?.username || '',
      })),
      codes: await devices.listCodes({ activeOnly: true }),
      settings: await settings.getMany([
        'devices.enforce',
        'devices.capPerUser',
        'devices.codeValidMinutes',
      ]),
      users: allUsers
        .filter((u) => u.status === 'active')
        .map((u) => ({ id: u.id, name: u.name, username: u.username, roleKey: u.roleKey })),
    });
  })
);

/**
 * Issues a one-time enrollment code. The QR the admin shows contains the sign-in
 * URL with the code pre-filled, which is the whole point — nobody types it.
 */
router.post(
  '/devices/codes',
  need('device.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const userId = str(input.userId, { max: 40 });
    if (!userId) throw errors.badRequest('Choose which staff member this device is for.');

    const result = await devices.issueCode(userId, { userId: req.user.id });
    const net = require('../services/net');
    const port = Number(process.env.PORT || 4700);
    const access = net.accessInfo(port);
    const base = access.url || access.localUrl;

    await audit.fromRequest(req, {
      action: audit.ACTIONS.ENROLLMENT_CODE_ISSUED,
      entityType: 'user',
      entityId: userId,
      message: `Issued a device enrollment code for ${result.user.name}, valid ${result.minutes} minutes`,
    });

    return ok(res, {
      ...result,
      url: `${base}/#/login?code=${encodeURIComponent(result.code)}&user=${encodeURIComponent(result.user.username)}`,
      baseUrl: base,
    });
  })
);

router.put(
  '/devices/:id',
  need('device.manage'),
  handler(async (req, res) => {
    const input = body(req);
    const name = str(input.name, { max: 60 });
    if (!name) throw errors.badRequest('Give the device a name staff will recognise.');
    const result = await devices.rename(req.params.id, name, { userId: req.user.id }, {
      expectedRev: input._rev,
    });
    return ok(res, result.after);
  })
);

router.post(
  '/devices/:id/revoke',
  need('device.manage'),
  handler(async (req, res) => {
    const result = await devices.revoke(req.params.id, { userId: req.user.id });
    await audit.fromRequest(req, {
      action: audit.ACTIONS.DEVICE_REVOKED,
      entityType: 'device',
      entityId: req.params.id,
      before: { status: result.before.status },
      after: { status: 'revoked' },
      message: `Revoked device "${result.before.name}" and ended ${result.sessionsEnded} session(s)`,
    });
    return ok(res, { revoked: true, sessionsEnded: result.sessionsEnded });
  })
);

/** Who is signed in right now — the Admin dashboard tile. */
router.get(
  '/sessions',
  need('user.manage'),
  handler(async (req, res) => ok(res, { count: sessions.count(), online: sessions.online() }))
);

module.exports = { router };
