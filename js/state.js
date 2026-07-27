/**
 * Client-side session state. Purely a mirror of what the server told us — no
 * decision here is load-bearing. Hiding a menu item is not access control; the
 * server checks every request regardless (CLAUDE.md security rules).
 */

export const state = {
  user: null,
  csrfToken: null,
  hours: null,
  license: null,
  academicYear: null,
  school: null,
  settings: null,
  lookups: null,
};

const subscribers = new Set();

export function subscribe(handler) {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

function notify() {
  for (const handler of subscribers) {
    try {
      handler(state);
    } catch (err) {
      console.error(err);
    }
  }
}

export function setSession(payload) {
  state.user = payload?.user || null;
  state.csrfToken = payload?.csrfToken || null;
  state.hours = payload?.hours || null;
  state.license = payload?.license || null;
  state.academicYear = payload?.academicYear || null;
  notify();
}

export function clearSession() {
  state.user = null;
  state.csrfToken = null;
  state.hours = null;
  state.license = null;
  state.academicYear = null;
  state.lookups = null;
  notify();
}

export function setHours(hours) {
  state.hours = hours;
  notify();
}

export function setSchool(payload) {
  state.school = payload?.school || null;
  state.settings = payload || null;
  notify();
}

export function setLookups(lookups) {
  state.lookups = lookups;
  notify();
}

export function can(permission) {
  if (!state.user) return false;
  return state.user.permissions.includes(permission);
}

export function canAny(...permissions) {
  return permissions.some((permission) => can(permission));
}

/** True when the server has told us writes are refused right now. */
export function isReadOnly() {
  if (state.hours && state.hours.access === 'readOnly') return true;
  if (state.license && state.license.canWrite === false) return true;
  return false;
}

export function readOnlyReason() {
  if (state.hours?.access === 'readOnly') return state.hours.message;
  if (state.license?.canWrite === false) return state.license.message;
  return null;
}

export function isAdminRole() {
  return state.user?.roleKey === 'admin';
}

/** Sections a section-scoped user may touch, or null when unrestricted. */
export function scopeSectionIds() {
  return state.user?.scopeSectionIds || null;
}
