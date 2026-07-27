'use strict';

const express = require('express');

const { context, authenticate, blockIfMustChangePassword } = require('../middleware/authenticate');
const { deviceCheck } = require('../middleware/deviceCheck');
const { hoursCheck } = require('../middleware/hoursCheck');
const { licenseGuard } = require('../middleware/licenseGuard');
const { csrf } = require('../middleware/csrf');
const { notFoundHandler, errorHandler } = require('../http');

const auth = require('./auth');
const system = require('./system');
const users = require('./users');
const academics = require('./academics');
const students = require('./students');
const attendance = require('./attendance');
const exams = require('./exams');
const fees = require('./fees');
const modules = require('./modules');
const dashboard = require('./dashboard');
const analytics = require('./analytics');
const reports = require('./reports');

/**
 * Mounts the API with the fixed middleware order from CLAUDE.md:
 *
 *   authenticate -> deviceCheck -> hoursCheck -> permissionCheck -> handler
 *
 * Do not reorder. The licence write-guard sits after hoursCheck because both are
 * "you may read but not write" gates and the hours message is the more useful one
 * to show first. Permission checks are declared per route inside each router.
 */
function apiRouter() {
  const api = express.Router();

  // Request context (client IP, localhost detection, device cookie) for everything.
  api.use(context());

  // Unauthenticated: health, the Access screen, login and logout.
  api.use(system.openRouter);
  api.use(auth.router);

  // Everything below needs a session.
  api.use(authenticate());
  api.use(deviceCheck());
  api.use(hoursCheck());
  api.use(licenseGuard());
  api.use(csrf());
  api.use(blockIfMustChangePassword());

  api.use(system.router);
  api.use(users.router);
  api.use(academics.router);
  api.use(students.router);
  api.use(attendance.router);
  api.use(exams.router);
  api.use(fees.router);
  api.use(modules.router);
  api.use(dashboard.router);
  api.use(analytics.router);
  api.use(reports.router);

  api.use(notFoundHandler());
  api.use(errorHandler());

  return api;
}

module.exports = { apiRouter };
