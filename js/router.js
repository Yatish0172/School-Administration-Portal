/**
 * Hash router. Screens are ES modules loaded on demand, each exporting
 * `render(container, params)` (CLAUDE.md code conventions).
 *
 * Hash routing rather than history API so the app works when opened from a file
 * path or behind any prefix, and so the Electron window's reload always lands
 * where the user was.
 */

import { el, clear, spinner, errorBox } from './ui.js';
import { can, canAny, state } from './state.js';

/**
 * Every route names the permission it needs. This drives both the sidebar and the
 * guard below — one list, so a menu item can never appear for a screen the user
 * cannot open.
 */
export const ROUTES = [
  { path: '/dashboard', title: 'Dashboard', icon: 'dashboard', module: './screens/dashboard.js', permission: 'dashboard.view', nav: 'Main' },

  { path: '/students', title: 'Students', icon: 'school', module: './screens/students.js', permission: ['student.view', 'student.lookup'], nav: 'Main' },
  { path: '/students/new', title: 'New admission', module: './screens/studentForm.js', permission: 'student.create' },
  { path: '/students/:id', title: 'Student', module: './screens/studentProfile.js', permission: ['student.view', 'student.lookup'] },
  { path: '/students/:id/edit', title: 'Edit student', module: './screens/studentForm.js', permission: 'student.edit' },
  { path: '/students/import', title: 'Import students', module: './screens/studentImport.js', permission: 'student.import' },
  { path: '/students/promote', title: 'Promote students', module: './screens/promote.js', permission: 'student.promote' },

  { path: '/admissions', title: 'Admissions', icon: 'how_to_reg', module: './screens/admissions.js', permission: 'enquiry.view', nav: 'Main' },

  { path: '/attendance', title: 'Attendance', icon: 'fact_check', module: './screens/attendance.js', permission: 'attendance.view', nav: 'Main' },
  { path: '/attendance/reports', title: 'Attendance reports', module: './screens/attendanceReports.js', permission: 'attendance.report' },

  { path: '/timetable', title: 'Timetable', icon: 'calendar_view_week', module: './screens/timetable.js', permission: 'timetable.view', nav: 'Main' },

  { path: '/exams', title: 'Exams', icon: 'assignment', module: './screens/exams.js', permission: 'exam.view', nav: 'Academics' },
  { path: '/exams/:id', title: 'Exam', module: './screens/examDetail.js', permission: 'exam.view' },
  { path: '/marks', title: 'Marks entry', icon: 'edit_note', module: './screens/marks.js', permission: 'marks.enter', nav: 'Academics' },
  { path: '/report-cards', title: 'Report cards', icon: 'description', module: './screens/reportCards.js', permission: 'reportcard.generate', nav: 'Academics' },
  { path: '/exams/analytics', title: 'Result analytics', icon: 'insights', module: './screens/analytics.js', permission: 'result.analytics', nav: 'Academics' },
  { path: '/grades', title: 'Grade bands', module: './screens/grades.js', permission: 'grade.manage' },

  { path: '/fees', title: 'Fee collection', icon: 'payments', module: './screens/fees.js', permission: 'fees.view', nav: 'Money' },
  { path: '/fees/collect/:studentId', title: 'Collect fees', module: './screens/feeCollect.js', permission: 'fees.collect' },
  { path: '/fees/setup', title: 'Fee setup', icon: 'tune', module: './screens/feeSetup.js', permission: 'fees.structure', nav: 'Money' },
  { path: '/fees/invoices', title: 'Generate invoices', icon: 'receipt_long', module: './screens/feeInvoices.js', permission: 'fees.invoice', nav: 'Money' },
  { path: '/fees/concessions', title: 'Concessions', icon: 'discount', module: './screens/concessions.js', permission: ['fees.concession', 'fees.concession.approve'], nav: 'Money' },
  { path: '/fees/reversals', title: 'Reversals', icon: 'undo', module: './screens/reversals.js', permission: ['fees.reverse', 'fees.reverse.approve'], nav: 'Money' },
  { path: '/fees/reports', title: 'Fee reports', icon: 'query_stats', module: './screens/feeReports.js', permission: 'fees.report', nav: 'Money' },

  { path: '/library', title: 'Library', icon: 'menu_book', module: './screens/library.js', permission: 'library.view', nav: 'Operations' },
  { path: '/transport', title: 'Transport', icon: 'directions_bus', module: './screens/transport.js', permission: 'transport.view', nav: 'Operations' },
  { path: '/staff', title: 'Staff', icon: 'badge', module: './screens/staff.js', permission: 'staff.view', nav: 'Operations' },
  { path: '/staff/:id', title: 'Staff member', module: './screens/staffProfile.js', permission: 'staff.view' },
  { path: '/staff-attendance', title: 'Staff attendance', icon: 'event_available', module: './screens/staffAttendance.js', permission: 'staffattendance.view', nav: 'Operations' },
  { path: '/leave', title: 'Leave', icon: 'beach_access', module: './screens/leave.js', permission: ['leave.approve', 'leave.request'], nav: 'Operations' },
  { path: '/payroll', title: 'Payroll', icon: 'account_balance_wallet', module: './screens/payroll.js', permission: 'payroll.view', nav: 'Operations' },

  { path: '/notices', title: 'Notices', icon: 'campaign', module: './screens/notices.js', permission: 'notice.view', nav: 'Operations' },
  { path: '/analytics', title: 'Analytics', icon: 'analytics', module: './screens/insights.js', permission: 'dashboard.view', nav: 'Main' },
  { path: '/reports', title: 'Reports', icon: 'summarize', module: './screens/reports.js', permission: 'report.view', nav: 'Operations' },

  { path: '/settings', title: 'Settings', icon: 'settings', module: './screens/settings.js', permission: 'settings.edit', nav: 'Administration' },
  { path: '/settings/academics', title: 'Academic structure', icon: 'account_tree', module: './screens/academics.js', permission: 'academics.view', nav: 'Administration' },
  { path: '/settings/users', title: 'Users', icon: 'group', module: './screens/users.js', permission: 'user.manage', nav: 'Administration' },
  { path: '/settings/roles', title: 'Roles', icon: 'admin_panel_settings', module: './screens/roles.js', permission: 'role.manage', nav: 'Administration' },
  { path: '/settings/devices', title: 'Devices', icon: 'devices', module: './screens/devices.js', permission: 'device.manage', nav: 'Administration' },
  { path: '/settings/hours', title: 'Access hours', icon: 'schedule', module: './screens/hours.js', permission: 'hours.manage', nav: 'Administration' },
  { path: '/access', title: 'Staff access', icon: 'qr_code_2', module: './screens/access.js', permission: 'settings.edit', nav: 'Administration' },
  { path: '/admin/backup', title: 'Backup', icon: 'backup', module: './screens/backup.js', permission: 'backup.run', nav: 'Administration' },
  { path: '/admin/audit', title: 'Audit log', icon: 'history', module: './screens/audit.js', permission: 'audit.view', nav: 'Administration' },
  { path: '/admin/license', title: 'Licence', icon: 'verified', module: './screens/license.js', permission: 'license.manage', nav: 'Administration' },
  { path: '/admin/health', title: 'System health', icon: 'monitor_heart', module: './screens/health.js', permission: 'health.view', nav: 'Administration' },

  { path: '/account', title: 'My account', module: './screens/account.js', permission: null },
];

export const NAV_SECTIONS = ['Main', 'Academics', 'Money', 'Operations', 'Administration'];

const moduleCache = new Map();
let container = null;
let currentPath = null;
let renderToken = 0;
const changeHandlers = new Set();

export function onRouteChange(handler) {
  changeHandlers.add(handler);
  return () => changeHandlers.delete(handler);
}

function permitted(route) {
  if (!route.permission) return true;
  if (Array.isArray(route.permission)) return canAny(...route.permission);
  return can(route.permission);
}

export function visibleNavRoutes() {
  return ROUTES.filter((route) => route.nav && permitted(route));
}

/**
 * Turns '/students/:id' into a matcher and pulls out the params.
 *
 * All candidates are collected and the most literal one wins, so '/students/import'
 * beats '/students/:id' regardless of the order they are declared in. Relying on
 * declaration order silently turns a real screen into a "not found" lookup, which is
 * exactly the bug this avoids.
 */
function matchRoute(path) {
  const pathParts = path.split('/').filter(Boolean);
  let best = null;

  for (const route of ROUTES) {
    const routeParts = route.path.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;

    const params = {};
    let matched = true;
    let literals = 0;
    for (let i = 0; i < routeParts.length; i += 1) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (routeParts[i] === pathParts[i]) {
        literals += 1;
      } else {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (!best || literals > best.literals) best = { route, params, literals };
  }

  return best ? { route: best.route, params: best.params } : null;
}

export function currentLocation() {
  const raw = window.location.hash.replace(/^#/, '') || '/dashboard';
  const [path, queryString] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryString || ''));
  return { path: path || '/dashboard', query, raw };
}

export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = target;
  if (replace) render();
}

export function mount(node) {
  container = node;
  window.addEventListener('hashchange', render);
}

function landingRoute() {
  if (can('dashboard.view')) return '/dashboard';
  const first = visibleNavRoutes()[0];
  return first ? first.path : '/account';
}

export async function render() {
  if (!container) return;
  const { path, query } = currentLocation();

  if (path === '/' || path === '') {
    navigate(landingRoute(), { replace: true });
    return;
  }

  const match = matchRoute(path);
  const token = ++renderToken;

  if (!match) {
    clear(container);
    container.appendChild(notFound(path));
    return;
  }

  if (!permitted(match.route)) {
    clear(container);
    container.appendChild(noAccess(match.route));
    return;
  }

  currentPath = path;
  for (const handler of changeHandlers) handler({ path, route: match.route, query });

  clear(container);
  container.appendChild(spinner());

  try {
    let screen = moduleCache.get(match.route.module);
    if (!screen) {
      screen = await import(match.route.module);
      moduleCache.set(match.route.module, screen);
    }
    // A slower earlier navigation must not paint over a newer one.
    if (token !== renderToken) return;

    clear(container);
    const context = { params: match.params, query, route: match.route, navigate };
    await screen.render(container, context);
    window.scrollTo({ top: 0 });
  } catch (err) {
    if (token !== renderToken) return;
    console.error(err);
    clear(container);
    container.appendChild(
      el('div', { class: 'mx-auto w-full max-w-3xl px-4 py-6' }, [
        errorBox(
          err?.message || 'That screen could not be opened.',
          () => render()
        ),
      ])
    );
  }
}

function notFound(path) {
  return el('div', { class: 'mx-auto w-full max-w-xl px-4 py-16 text-center' }, [
    el('h1', { class: 'text-xl font-semibold', text: 'That screen does not exist' }),
    el('p', { class: 'mt-2 text-sm text-ink-500', text: `Nothing is mapped to ${path}.` }),
    el('a', { class: 'btn-primary mt-4 inline-flex', href: `#${landingRoute()}`, text: 'Go to the start' }),
  ]);
}

function noAccess(route) {
  return el('div', { class: 'mx-auto w-full max-w-xl px-4 py-16 text-center' }, [
    el('h1', { class: 'text-xl font-semibold', text: 'You do not have access to this' }),
    el('p', {
      class: 'mt-2 text-sm text-ink-500',
      text: `${route.title} is not available for the ${state.user?.roleKey || 'current'} role. Ask the administrator if you need it.`,
    }),
    el('a', { class: 'btn-primary mt-4 inline-flex', href: `#${landingRoute()}`, text: 'Go to the start' }),
  ]);
}

export function activePath() {
  return currentPath;
}
