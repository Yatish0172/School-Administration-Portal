'use strict';

/**
 * Every error that can reach a user carries a code, an HTTP status and a
 * plain-English message. The message is rendered verbatim in the UI, so it is
 * written for an office clerk, not a developer (CLAUDE.md code conventions).
 */
class AppError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

const badRequest = (message, details) =>
  new AppError('BAD_REQUEST', message, 400, details);

const unauthorized = (message = 'Please sign in to continue.') =>
  new AppError('UNAUTHORIZED', message, 401);

const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError('FORBIDDEN', message, 403);

const notFound = (message = 'That record could not be found.') =>
  new AppError('NOT_FOUND', message, 404);

const conflict = (
  message = 'This record was changed by someone else. Reload and try again.'
) => new AppError('CONFLICT', message, 409);

const locked = (message) => new AppError('LOCKED', message, 423);

const tooMany = (message) => new AppError('TOO_MANY_REQUESTS', message, 429);

const validation = (message, fields) =>
  new AppError('VALIDATION_FAILED', message, 422, { fields });

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  locked,
  tooMany,
  validation,
};
