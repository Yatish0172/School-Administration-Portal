/**
 * Audit viewer (SPEC §14, T06). Read-only by design — the log is insert-only and no
 * code path in the app updates or deletes a row.
 */

import { api } from '../api.js';
import { el, page, card, table, fmt, spinner, chip, modal, button, searchBox, filterSelect, filterInput, pager } from '../ui.js';
import { exportButton } from './_common.js';

export async function render(container, context = {}) {
  const view = {
    from: context.query?.from || null,
    to: context.query?.to || null,
    userId: context.query?.userId || null,
    action: context.query?.action || null,
    search: '',
    page: 1,
  };

  const host = el('div');
  const filterHost = el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' });

  function paintFilters(data) {
    filterHost.replaceChildren(
      searchBox('Search user, action or detail…', (value) => {
        view.search = value;
        view.page = 1;
        load();
      }, view.search),
      filterInput({
        label: 'From',
        type: 'date',
        value: view.from,
        onChange: (value) => {
          view.from = value;
          view.page = 1;
          load();
        },
      }),
      filterInput({
        label: 'To',
        type: 'date',
        value: view.to,
        onChange: (value) => {
          view.to = value;
          view.page = 1;
          load();
        },
      }),
      filterSelect({
        label: 'User',
        width: '13rem',
        options: data.users.map((user) => ({ value: user.id, label: user.name })),
        value: view.userId,
        placeholder: 'Anyone',
        onChange: (value) => {
          view.userId = value;
          view.page = 1;
          load();
        },
      }),
      filterSelect({
        label: 'Action',
        width: '15rem',
        options: data.actions.map((action) => ({ value: action, label: fmt.humanise(action) })),
        value: view.action,
        placeholder: 'Everything',
        onChange: (value) => {
          view.action = value;
          view.page = 1;
          load();
        },
      }),
      exportButton('/api/audit/export', { from: view.from, to: view.to, userId: view.userId, action: view.action })
    );
  }

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/audit', {
        from: view.from,
        to: view.to,
        userId: view.userId,
        action: view.action,
        search: view.search,
        page: view.page,
        pageSize: 100,
      });
      paintFilters(data);
      host.replaceChildren(listCard(data, view, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Audit log',
      subtitle:
        'Every recorded action, with who did it, from where, and what changed. Insert-only — nothing here can be edited or removed.',
      wide: true,
      children: el('div', {}, [filterHost, host]),
    })
  );

  await load();
}

function listCard(data, view, reload) {
  return card({
    title: `${fmt.number(data.total)} event${data.total === 1 ? '' : 's'}`,
    body: el('div', {}, [
      table({
        dense: true,
        columns: [
          { key: 'at', label: 'When', type: 'dateTime', width: '13rem' },
          { key: 'userName', label: 'Who', width: '12rem', render: (row) => fmt.text(row.userName, 'system') },
          {
            key: 'role',
            label: 'Role',
            width: '8rem',
            render: (row) => (row.role ? chip(fmt.humanise(row.role), 'neutral') : '—'),
          },
          {
            key: 'action',
            label: 'Action',
            width: '14rem',
            render: (row) => chip(fmt.humanise(row.action), toneFor(row.action)),
          },
          { key: 'message', label: 'Detail', flex: true },
          { key: 'ip', label: 'From', width: '9rem' },
          {
            key: 'changes',
            label: '',
            width: '6.5rem',
            render: (row) =>
              row.before || row.after
                ? button('Changes', { size: 'sm', onClick: () => showChanges(row) })
                : null,
          },
        ],
        rows: data.rows,
        emptyMessage: 'No events match those filters.',
      }),
      pager({
        page: data.page,
        pages: data.pages,
        total: data.total,
        onChange: (next) => {
          view.page = next;
          reload();
        },
      }),
    ]),
  });
}

function toneFor(action) {
  if (/failed|lockout|refused|reversal|restore|disabled/.test(action)) return 'bad';
  if (/override|correct|unpublish|waived|reversalRequested/.test(action)) return 'warn';
  if (/payment|published|created|activated|enrolled|committed/.test(action)) return 'good';
  return 'neutral';
}

function showChanges(row) {
  modal({
    title: `${fmt.humanise(row.action)} — ${fmt.dateTime(row.at)}`,
    size: 'lg',
    body: el('div', { class: 'space-y-3' }, [
      el('div', { class: 'grid grid-cols-2 gap-x-4 gap-y-1 text-sm' }, [
        pair('Who', fmt.text(row.userName, 'system')),
        pair('Role', row.role ? fmt.humanise(row.role) : '—'),
        pair('Record type', fmt.text(row.entityType)),
        pair('Record', fmt.text(row.entityId)),
        pair('From', fmt.text(row.ip)),
        pair('Device', fmt.text(row.deviceId ? `${String(row.deviceId).slice(0, 12)}…` : null)),
      ]),
      row.message ? el('p', { class: 'rounded bg-ink-50 p-2 text-sm', text: row.message }) : null,
      el('div', { class: 'grid grid-cols-1 gap-3 md:grid-cols-2' }, [
        blob('Before', row.before),
        blob('After', row.after),
      ]),
    ]),
    actions: (close) => [button('Close', { variant: 'primary', onClick: close })],
  });
}

function blob(label, value) {
  return el('div', {}, [
    el('p', { class: 'mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500', text: label }),
    el('pre', {
      class: 'max-h-64 overflow-auto rounded-lg bg-ink-900 p-2 text-[11px] leading-relaxed text-ink-100',
      text: pretty(value),
    }),
  ]);
}

function pretty(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch (err) {
    return String(value);
  }
}

function pair(label, value) {
  return el('div', {}, [
    el('p', { class: 'text-xs uppercase tracking-wide text-ink-500', text: label }),
    el('p', { class: 'font-medium', text: value }),
  ]);
}
