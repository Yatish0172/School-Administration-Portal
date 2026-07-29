'use strict';

const permissions = require('../store/permissions');
const academics = require('../store/academics');
const errors = require('../errors');

/**
 * Fourth link: permission checks (CLAUDE.md security rules).
 *
 * Always checks atomic permission keys, never role names. Hiding a menu item is
 * not access control — every protected route passes through here.
 */

const DESCRIPTIONS = new Map(permissions.PERMISSIONS.map((p) => [p.key, p]));

function describe(key) {
  const permission = DESCRIPTIONS.get(key);
  if (!permission) return 'do that';
  return permission.description.charAt(0).toLowerCase() + permission.description.slice(1);
}

function has(user, key) {
  return !!user && Array.isArray(user.permissions) && user.permissions.includes(key);
}

function hasAny(user, keys) {
  return keys.some((key) => has(user, key));
}

/** Requires every listed permission. */
function need(...keys) {
  return (req, res, next) => {
    if (!req.user) return next(errors.unauthorized());
    const missing = keys.filter((key) => !has(req.user, key));
    if (missing.length === 0) return next();
    return next(
      errors.forbidden(
        `Your role cannot ${describe(missing[0])}. Ask the administrator if you need this.`
      )
    );
  };
}

/** Requires at least one of the listed permissions. */
function needAny(...keys) {
  return (req, res, next) => {
    if (!req.user) return next(errors.unauthorized());
    if (hasAny(req.user, keys)) return next();
    return next(
      errors.forbidden(
        `Your role cannot ${describe(keys[0])}. Ask the administrator if you need this.`
      )
    );
  };
}

/* -------------------------------------------------------------- scope rules */

/**
 * Section scope. A class teacher holding `attendance.mark.assigned` is filtered to
 * their own sections here, server-side — a section id from the client is never
 * trusted (CLAUDE.md: "Scope, not just permission").
 *
 * Attaches `req.scope = { allSections, sectionIds, academicYearId }`.
 */
function scope(options = {}) {
  const { anyPermission = null } = options;
  return async (req, res, next) => {
    try {
      if (!req.user) return next(errors.unauthorized());

      const year = await academics.resolveYear(req.query.academicYearId || req.body?.academicYearId);
      const unrestricted = anyPermission ? has(req.user, anyPermission) : false;

      if (unrestricted) {
        req.scope = { allSections: true, sectionIds: null, academicYearId: year.id, year };
        return next();
      }

      const sectionIds = await academics.sectionsForTeacher(req.user.id, year.id);
      req.scope = {
        allSections: false,
        sectionIds,
        academicYearId: year.id,
        year,
      };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Scope for data the whole school may read but a class teacher may read only for
 * their own sections — the timetable, for one (SPEC §4: "Class Teacher — own
 * sections ... cannot see other sections").
 *
 * The difference from `scope` is what happens to a role with no sections assigned.
 * `scope` leaves it with an empty list, which is right for marking attendance and
 * wrong here: the front office and exam cell have no sections and must still see
 * the whole school's timetable. So the restriction is applied to section-bound
 * roles and nobody else.
 */
function sectionBoundScope() {
  return async (req, res, next) => {
    try {
      if (!req.user) return next(errors.unauthorized());
      const year = await academics.resolveYear(req.query.academicYearId || req.body?.academicYearId);

      if (!permissions.SECTION_SCOPED_ROLES.has(req.user.roleKey)) {
        req.scope = { allSections: true, sectionIds: null, academicYearId: year.id, year };
        return next();
      }

      const sectionIds = await academics.sectionsForTeacher(req.user.id, year.id);
      req.scope = { allSections: false, sectionIds, academicYearId: year.id, year };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Throws unless the request's scope covers the section. */
function assertSection(req, sectionId) {
  if (!sectionId) {
    throw errors.badRequest('Choose a section.');
  }
  if (!req.scope) {
    throw new Error('assertSection called without the scope middleware');
  }
  if (req.scope.allSections) return true;
  if (req.scope.sectionIds.includes(sectionId)) return true;
  throw errors.forbidden(
    'You can only work with the sections assigned to you. Ask the office if this looks wrong.'
  );
}

/** Filters a list of rows down to the sections the request may see. */
function filterBySection(req, rows, key = 'sectionId') {
  if (!req.scope || req.scope.allSections) return rows;
  const allowed = new Set(req.scope.sectionIds);
  return rows.filter((row) => allowed.has(row[key]));
}

/**
 * Library and Transport get name + class lookup only (SPEC §4 limits), so their
 * student payload is trimmed rather than refused.
 */
function studentView(user) {
  if (has(user, 'student.view')) return 'full';
  if (has(user, 'student.lookup')) return 'lookup';
  return 'none';
}

const LOOKUP_FIELDS = [
  'id',
  'admissionNo',
  'firstName',
  'middleName',
  'lastName',
  'status',
  'photoFile',
];

const TRANSPORT_LOOKUP_EXTRA = ['permanentAddress', 'correspondenceAddress', 'city', 'pincode'];

function trimStudent(student, view, roleKey) {
  if (view === 'full') return student;
  const fields = [...LOOKUP_FIELDS];
  if (roleKey === 'transport') fields.push(...TRANSPORT_LOOKUP_EXTRA);
  const out = {};
  for (const field of fields) out[field] = student[field];
  return out;
}

module.exports = {
  has,
  hasAny,
  need,
  needAny,
  scope,
  sectionBoundScope,
  assertSection,
  filterBySection,
  studentView,
  trimStudent,
  describe,
};
