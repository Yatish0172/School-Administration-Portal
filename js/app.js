/**
 * Boot and app shell.
 *
 * Restores the session, builds the sidebar and top bar, and hands over to the
 * router. The sidebar renders only the modules the signed-in role may open — which
 * is a convenience, not a control; the server checks every request regardless.
 */

import { api, on as onApi } from './api.js';
import { state, setSession, clearSession, setSchool, can } from './state.js';
import { el, clear, icon, toast, fmt, modal, button } from './ui.js';
import * as router from './router.js';
import * as hours from './hours.js';
import * as drafts from './drafts.js';
import { renderLogin } from './auth.js';

const bootNode = document.getElementById('boot');
const appNode = document.getElementById('app');

let shell = null;

async function boot() {
  // A device that is not enrolled still reaches this page; /api/me tells us which
  // situation we are in.
  try {
    const session = await api.get('/api/me');
    setSession(session);
    await afterSignIn({ fresh: false });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      showLogin();
      return;
    }
    if (err.code === 'OFFLINE') {
      showBootError(err.message);
      return;
    }
    showBootError(err.message || 'The portal could not start.');
  }
}

function showBootError(message) {
  const target = document.getElementById('boot-error');
  target.textContent = message;
  target.classList.remove('hidden');
  const retry = el('button', {
    class: 'btn-secondary mt-4',
    text: 'Try again',
    on: { click: () => window.location.reload() },
  });
  target.after(retry);
}

function showLogin() {
  bootNode.classList.add('hidden');
  appNode.classList.remove('hidden');
  clear(appNode);
  hours.stop();
  shell = null;
  renderLogin(appNode, async () => {
    await afterSignIn({ fresh: true });
  });
}

async function afterSignIn({ fresh }) {
  bootNode.classList.add('hidden');
  appNode.classList.remove('hidden');

  // A forced credential change gets its own screen; nothing else is reachable.
  if (state.user?.mustChangePassword) {
    clear(appNode);
    const { renderForcedChange } = await import('./auth.js');
    renderForcedChange(appNode, () => window.location.reload());
    return;
  }

  try {
    const settings = await api.get('/api/settings/public');
    setSchool(settings);
  } catch (err) {
    // Not fatal — screens fall back to sensible defaults.
    console.warn('[boot] could not load school settings', err.message);
  }

  buildShell();
  router.mount(shell.content);
  hours.start({ bannerContainer: shell.banners, clockContainer: shell.clock });
  drafts.installUnloadHandler();

  await router.render();

  if (fresh) {
    drafts.offerRecovery((path) => router.navigate(path));
  }
}

/* ------------------------------------------------------------------- shell */

function buildShell() {
  clear(appNode);

  const clockNode = el('span', { class: 'font-medium tabular-nums', text: '—' });
  const bannerNode = el('div', {});
  const contentNode = el('main', { class: 'flex-1 overflow-y-auto' });
  const navNode = el('nav', { class: 'flex-1 space-y-0.5 overflow-y-auto px-2 pb-4' });

  const sidebar = el(
    'aside',
    {
      id: 'sidebar',
      class:
        'fixed inset-y-0 left-0 z-30 flex w-64 -translate-x-full flex-col border-r border-ink-200 bg-white transition-transform lg:static lg:translate-x-0 no-print',
    },
    [
      el('div', { class: 'flex h-14 items-center gap-2 border-b border-ink-200 px-4' }, [
        el('div', { class: 'flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white' }, [
          icon('school', 'text-lg'),
        ]),
        el('div', { class: 'min-w-0' }, [
          el('p', {
            class: 'truncate text-sm font-semibold leading-tight',
            text: state.school?.name || 'School Admin Portal',
          }),
          el('p', {
            class: 'truncate text-xs text-ink-500',
            text: state.academicYear ? state.academicYear.name : 'No academic year',
          }),
        ]),
      ]),
      navNode,
      userCard(),
    ]
  );

  const backdrop = el('div', {
    id: 'sidebar-backdrop',
    class: 'fixed inset-0 z-20 hidden bg-ink-900/40 lg:hidden',
    on: { click: closeSidebar },
  });

  const header = el(
    'header',
    { class: 'app-header sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-ink-200 bg-white/95 px-3 backdrop-blur sm:px-4 no-print' },
    [
      el('button', {
        class: 'btn-ghost lg:hidden',
        'aria-label': 'Menu',
        on: { click: openSidebar },
      }, [icon('menu')]),
      el('div', { class: 'min-w-0 flex-1' }, [
        el('p', { id: 'page-title', class: 'truncate text-sm font-medium text-ink-700', text: '' }),
      ]),
      el('div', { class: 'flex items-center gap-3 text-xs text-ink-500' }, [
        el('div', { class: 'hidden items-center gap-1.5 sm:flex' }, [
          icon('schedule', 'text-base'),
          clockNode,
        ]),
        el('span', { id: 'closing-note', class: 'hidden text-xs text-ink-500 sm:inline' }),
      ]),
    ]
  );

  appNode.appendChild(
    el('div', { class: 'flex min-h-screen' }, [
      sidebar,
      backdrop,
      el('div', { class: 'flex min-w-0 flex-1 flex-col' }, [header, bannerNode, contentNode]),
    ])
  );

  shell = { nav: navNode, content: contentNode, banners: bannerNode, clock: clockNode, sidebar, backdrop };
  buildNav();

  router.onRouteChange(({ route }) => {
    document.getElementById('page-title').textContent = route.title;
    document.title = `${route.title} — ${state.school?.name || 'School Admin Portal'}`;
    highlightNav();
    closeSidebar();
  });

  updateClosingNote();
  setInterval(updateClosingNote, 30000);
}

function userCard() {
  return el('div', { class: 'border-t border-ink-200 p-2' }, [
    el(
      'a',
      { class: 'nav-link', href: '#/account' },
      [
        el('div', { class: 'flex h-7 w-7 items-center justify-center rounded-full bg-ink-200 text-xs font-semibold text-ink-700', text: initials(state.user?.name) }),
        el('div', { class: 'min-w-0 flex-1' }, [
          el('p', { class: 'truncate text-sm font-medium text-ink-900', text: state.user?.name || '' }),
          el('p', { class: 'truncate text-xs text-ink-500', text: roleLabel() }),
        ]),
      ]
    ),
    el('button', { class: 'nav-link w-full', on: { click: signOut } }, [
      icon('logout', 'text-base'),
      'Sign out',
    ]),
  ]);
}

function initials(name) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function roleLabel() {
  const key = state.user?.roleKey;
  if (!key) return '';
  return fmt.humanise(key);
}

function buildNav() {
  clear(shell.nav);
  const routes = router.visibleNavRoutes();

  for (const section of router.NAV_SECTIONS) {
    const inSection = routes.filter((route) => route.nav === section);
    if (!inSection.length) continue;
    shell.nav.appendChild(el('p', { class: 'nav-section', text: section }));
    for (const route of inSection) {
      shell.nav.appendChild(
        el('a', { class: 'nav-link', href: `#${route.path}`, dataset: { path: route.path } }, [
          icon(route.icon || 'chevron_right', 'text-base'),
          route.title,
        ])
      );
    }
  }
  highlightNav();
}

function highlightNav() {
  const active = router.activePath();
  for (const link of shell.nav.querySelectorAll('a[data-path]')) {
    const path = link.dataset.path;
    const isActive = active === path || (active && active.startsWith(`${path}/`) && path !== '/');
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function updateClosingNote() {
  const node = document.getElementById('closing-note');
  if (!node) return;
  const current = state.hours;
  if (!current) {
    node.classList.add('hidden');
    return;
  }
  node.classList.remove('hidden');
  if (current.phase === 'closed' || current.phase === 'beforeOpen') {
    node.textContent = current.nextOpening
      ? `Opens ${current.nextOpening.offset === 0 ? 'today' : current.nextOpening.offset === 1 ? 'tomorrow' : current.nextOpening.dayName} ${fmt.time(current.nextOpening.open)}`
      : 'Closed';
  } else if (current.closeTimeLabel) {
    node.textContent = `Closes ${current.closeTimeLabel}`;
  } else {
    node.textContent = '';
  }
}

function openSidebar() {
  shell.sidebar.classList.remove('-translate-x-full');
  shell.backdrop.classList.remove('hidden');
}

function closeSidebar() {
  if (!shell) return;
  if (window.innerWidth >= 1024) return;
  shell.sidebar.classList.add('-translate-x-full');
  shell.backdrop.classList.add('hidden');
}

async function signOut() {
  drafts.flushDrafts();
  try {
    await api.post('/api/logout');
  } catch (err) {
    // Signing out locally matters more than the server acknowledging it.
  }
  clearSession();
  hours.stop();
  window.location.hash = '';
  showLogin();
}

/* --------------------------------------------------------- global reactions */

onApi('unauthorised', () => {
  if (!state.user) return;
  clearSession();
  hours.stop();
  toast('Your session has ended. Please sign in again.', 'warn');
  showLogin();
});

onApi('locked', (error) => {
  // The banner already explains the state; a toast makes the refused action clear.
  toast(error.message, 'warn', 8000);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason?.name === 'AbortError') return;
  console.error('[unhandled]', reason);
});

/** Keyboard shortcut a busy office actually uses: `/` focuses the search box. */
window.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const search = document.querySelector('input[type="search"]');
  if (search) {
    event.preventDefault();
    search.focus();
  }
});

export function showHelp() {
  modal({
    title: 'Keyboard shortcuts',
    size: 'sm',
    body: el('dl', { class: 'space-y-2 text-sm' }, [
      el('div', { class: 'flex justify-between gap-4' }, [el('dt', { text: 'Focus search' }), el('dd', { class: 'font-mono', text: '/' })]),
      el('div', { class: 'flex justify-between gap-4' }, [el('dt', { text: 'Save the current grid' }), el('dd', { class: 'font-mono', text: 'Ctrl + S' })]),
      el('div', { class: 'flex justify-between gap-4' }, [el('dt', { text: 'Move down a grid' }), el('dd', { class: 'font-mono', text: 'Enter' })]),
      el('div', { class: 'flex justify-between gap-4' }, [el('dt', { text: 'Close a dialogue' }), el('dd', { class: 'font-mono', text: 'Esc' })]),
    ]),
    actions: (close) => [button('Close', { variant: 'primary', onClick: close })],
  });
}

void can;
boot();
