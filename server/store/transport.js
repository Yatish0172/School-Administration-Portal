'use strict';

const workbook = require('./workbook');
const crud = require('./crud');
const errors = require('../errors');

/**
 * Transport (SPEC §12): routes, stops, vehicles, drivers with licence-expiry
 * alerts, student assignment to route and stop, and route-wise lists.
 */

const WB = 'Transport';
const DIRECTIONS = ['both', 'pickup', 'drop'];

/* ------------------------------------------------------------------ routes */

async function listRoutes({ includeInactive = false } = {}) {
  const rows = await workbook.read(WB, 'Routes');
  return rows
    .filter((r) => includeInactive || r.status !== 'inactive')
    .sort((a, b) => crud.compareValues(a.name, b.name));
}

async function createRoute(data, ctx) {
  if (!data.name) throw errors.validation('Enter a route name.', { name: 'Required.' });
  const clash = await crud.findOne(
    WB,
    'Routes',
    (r) => String(r.name).toLowerCase() === String(data.name).trim().toLowerCase() && r.status !== 'inactive'
  );
  if (clash) throw errors.validation('That route already exists.', { name: 'Already exists.' });
  return crud.create(WB, 'Routes', { ...data, status: 'active' }, ctx, { label: 'create route' });
}

async function updateRoute(id, patch, ctx, options = {}) {
  return crud.update(WB, 'Routes', id, patch, ctx, {
    expectedRev: options.expectedRev,
    label: 'route',
  });
}

/* -------------------------------------------------------------------- stops */

async function listStops(routeId = null) {
  const rows = await workbook.read(WB, 'Stops');
  return rows
    .filter((r) => !routeId || r.routeId === routeId)
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
}

/** Stops are edited as an ordered list, so the whole route is replaced in one write. */
async function setStops(routeId, stops, ctx) {
  await crud.getOrFail(WB, 'Routes', routeId, 'route');
  const assignments = await workbook.read(WB, 'RouteAssignments');

  return workbook.mutate(
    WB,
    (api) => {
      const rows = api.rows('Stops');
      const existing = rows.filter((r) => r.routeId === routeId);
      const inUse = new Set(
        assignments.filter((a) => a.status === 'active').map((a) => a.stopId)
      );
      const keeping = new Set(stops.map((s) => s.id).filter(Boolean));
      for (const stop of existing) {
        if (inUse.has(stop.id) && !keeping.has(stop.id)) {
          throw errors.badRequest(
            `The stop "${stop.name}" still has students assigned to it. Move them before removing it.`
          );
        }
      }

      api.replace(
        'Stops',
        rows.filter((r) => r.routeId !== routeId)
      );
      return stops.map((stop, index) =>
        crud.insertInto(
          api,
          WB,
          'Stops',
          {
            id: stop.id || undefined,
            routeId,
            name: stop.name,
            sequence: index + 1,
            arrivalTime: stop.arrivalTime || null,
            departureTime: stop.departureTime || null,
            landmark: stop.landmark || null,
            fare: stop.fare ?? null,
          },
          ctx
        )
      );
    },
    { label: 'set route stops' }
  );
}

/* ---------------------------------------------------------------- vehicles */

async function listVehicles({ includeInactive = false } = {}) {
  const rows = await workbook.read(WB, 'Vehicles');
  return rows.filter((r) => includeInactive || r.status !== 'inactive');
}

async function createVehicle(data, ctx) {
  if (!data.regNo) throw errors.validation('Enter the registration number.', { regNo: 'Required.' });
  const clash = await crud.findOne(
    WB,
    'Vehicles',
    (r) => String(r.regNo).toLowerCase() === String(data.regNo).trim().toLowerCase()
  );
  if (clash) throw errors.validation('That vehicle is already registered.', { regNo: 'Already exists.' });
  return crud.create(WB, 'Vehicles', { ...data, status: 'active' }, ctx, { label: 'create vehicle' });
}

async function updateVehicle(id, patch, ctx, options = {}) {
  return crud.update(WB, 'Vehicles', id, patch, ctx, {
    expectedRev: options.expectedRev,
    label: 'vehicle',
  });
}

/* ----------------------------------------------------------------- drivers */

async function listDrivers({ includeInactive = false } = {}) {
  const rows = await workbook.read(WB, 'Drivers');
  return rows.filter((r) => includeInactive || r.status !== 'inactive');
}

async function createDriver(data, ctx) {
  if (!data.name) throw errors.validation('Enter the driver name.', { name: 'Required.' });
  if (!data.licenceNo) throw errors.validation('Enter the licence number.', { licenceNo: 'Required.' });
  return crud.create(WB, 'Drivers', { ...data, status: 'active' }, ctx, { label: 'create driver' });
}

async function updateDriver(id, patch, ctx, options = {}) {
  return crud.update(WB, 'Drivers', id, patch, ctx, {
    expectedRev: options.expectedRev,
    label: 'driver',
  });
}

/**
 * Expiry alerts (SPEC §12). A bus running on an expired fitness certificate is a
 * legal problem, so this surfaces on the Transport screen and the dashboard.
 */
async function expiryAlerts({ withinDays = 45 } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + withinDays * 86400000).toISOString().slice(0, 10);
  const alerts = [];

  const check = (label, entity, field, name) => {
    const value = entity[field];
    if (!value) return;
    if (value > cutoff) return;
    alerts.push({
      kind: label,
      name,
      field,
      expiresOn: value,
      expired: value < today,
      daysLeft: Math.ceil((Date.parse(value) - Date.parse(today)) / 86400000),
    });
  };

  for (const vehicle of await listVehicles()) {
    check('Vehicle', vehicle, 'insuranceExpiry', vehicle.regNo);
    check('Vehicle', vehicle, 'fitnessExpiry', vehicle.regNo);
    check('Vehicle', vehicle, 'pucExpiry', vehicle.regNo);
    check('Vehicle', vehicle, 'permitExpiry', vehicle.regNo);
  }
  for (const driver of await listDrivers()) {
    check('Driver', driver, 'licenceExpiry', driver.name);
  }

  return alerts.sort((a, b) => crud.compareValues(a.expiresOn, b.expiresOn));
}

/* -------------------------------------------------------------- assignments */

async function listAssignments({ academicYearId = null, routeId = null, studentId = null } = {}) {
  const rows = await workbook.read(WB, 'RouteAssignments');
  return rows.filter((row) => {
    if (row.status !== 'active') return false;
    if (academicYearId && row.academicYearId !== academicYearId) return false;
    if (routeId && row.routeId !== routeId) return false;
    if (studentId && row.studentId !== studentId) return false;
    return true;
  });
}

async function assign(data, ctx) {
  for (const field of ['studentId', 'academicYearId', 'routeId', 'stopId']) {
    if (!data[field]) throw errors.validation('Choose a student, route and stop.', { [field]: 'Required.' });
  }
  if (data.direction && !DIRECTIONS.includes(data.direction)) {
    throw errors.badRequest('Direction must be both, pickup or drop.');
  }
  const route = await crud.getOrFail(WB, 'Routes', data.routeId, 'route');
  const stop = await crud.getOrFail(WB, 'Stops', data.stopId, 'stop');
  if (stop.routeId !== route.id) {
    throw errors.badRequest('That stop is not on the chosen route.');
  }

  const vehicle = route.vehicleId ? await crud.get(WB, 'Vehicles', route.vehicleId) : null;
  const existing = await listAssignments({ academicYearId: data.academicYearId, routeId: route.id });
  if (vehicle?.capacity && existing.length >= Number(vehicle.capacity)) {
    throw errors.badRequest(
      `${route.name} is at capacity (${existing.length} of ${vehicle.capacity}). Choose another route.`
    );
  }

  const already = await crud.findOne(
    WB,
    'RouteAssignments',
    (r) =>
      r.studentId === data.studentId &&
      r.academicYearId === data.academicYearId &&
      r.status === 'active'
  );
  if (already) {
    throw errors.badRequest('That student is already assigned to a route for this year.');
  }

  return crud.create(
    WB,
    'RouteAssignments',
    {
      ...data,
      direction: data.direction || 'both',
      fare: data.fare ?? stop.fare ?? route.fare ?? null,
      fromDate: data.fromDate || new Date().toISOString().slice(0, 10),
      status: 'active',
    },
    ctx,
    { label: 'assign transport' }
  );
}

async function unassign(id, { toDate = null } = {}, ctx) {
  return crud.update(
    WB,
    'RouteAssignments',
    id,
    { status: 'ended', toDate: toDate || new Date().toISOString().slice(0, 10) },
    ctx,
    { label: 'transport assignment' }
  );
}

/** Route-wise list for the driver: stop order, students, guardian phone. */
async function routeList(routeId, academicYearId) {
  const students = require('./students');
  const academics = require('./academics');
  const route = await crud.getOrFail(WB, 'Routes', routeId, 'route');
  const stops = await listStops(routeId);
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const assignments = await listAssignments({ routeId, academicYearId });

  const sections = await academics.listSections({ academicYearId });
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const classes = await academics.listClasses();
  const classById = new Map(classes.map((c) => [c.id, c]));

  const rows = [];
  for (const assignment of assignments) {
    const student = await students.get(assignment.studentId);
    if (!student) continue;
    const guardian = await students.primaryGuardian(assignment.studentId);
    const enrollment = await academics.enrollmentFor(assignment.studentId, academicYearId);
    const section = enrollment ? sectionById.get(enrollment.sectionId) : null;
    const stop = stopById.get(assignment.stopId);
    rows.push({
      studentId: assignment.studentId,
      admissionNo: student.admissionNo,
      name: student.fullName,
      className: enrollment ? classById.get(enrollment.classId)?.name || '' : '',
      sectionName: section?.name || '',
      stopName: stop?.name || '',
      stopSequence: stop?.sequence || 999,
      arrivalTime: stop?.arrivalTime || '',
      direction: assignment.direction,
      address: student.permanentAddress || '',
      guardianName: guardian?.name || '',
      guardianPhone: guardian?.phone || '',
      fare: assignment.fare,
    });
  }

  rows.sort(
    (a, b) => a.stopSequence - b.stopSequence || crud.compareValues(a.name, b.name)
  );

  const vehicle = route.vehicleId ? await crud.get(WB, 'Vehicles', route.vehicleId) : null;
  const driver = route.driverId ? await crud.get(WB, 'Drivers', route.driverId) : null;

  return { route, vehicle, driver, stops, rows, total: rows.length };
}

module.exports = {
  WB,
  DIRECTIONS,
  listRoutes,
  createRoute,
  updateRoute,
  listStops,
  setStops,
  listVehicles,
  createVehicle,
  updateVehicle,
  listDrivers,
  createDriver,
  updateDriver,
  expiryAlerts,
  listAssignments,
  assign,
  unassign,
  routeList,
};
