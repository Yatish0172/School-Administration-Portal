/**
 * System health. The first screen to open when something feels wrong: it shows the
 * clock, the locks, anything left in the journal folder, and the backup state.
 */

import { api } from '../api.js';
import { el, page, card, table, fmt, spinner, chip, stat, grid, icon, empty, button } from '../ui.js';
import { renderAsync } from './_common.js';

export async function render(container) {
  await renderAsync(container, () => api.get('/api/health/detail'), build);
}

function build(data) {
  const server = data.server;
  const pending = (data.journal || []).filter((entry) => !entry.restored);
  const restored = (data.journal || []).filter((entry) => entry.restored);

  return page({
    title: 'System health',
    subtitle: 'What the server itself is doing right now.',
    wide: true,
    actions: [button('Refresh', { iconName: 'refresh', onClick: () => window.location.reload() })],
    children: el('div', { class: 'space-y-4' }, [
      data.clockWarning
        ? el('div', { class: 'banner-bad rounded-lg' }, [
            icon('error'),
            el('span', { class: 'flex-1', text: data.clockWarning.message }),
          ])
        : null,
      pending.length
        ? el('div', { class: 'banner-warn rounded-lg' }, [
            icon('warning'),
            el('span', {
              class: 'flex-1',
              text: `${pending.length} unfinished write snapshot(s) in Database/journal/. The last shutdown may not have been clean — check the data those files cover, then delete the folders.`,
            }),
          ])
        : null,

      grid(4, [
        stat({
          label: 'Server time',
          value: fmt.time(server.time),
          sub: `${fmt.date(server.localDate)} • ${server.timezone}`,
        }),
        stat({
          label: 'Up for',
          value: uptime(server.uptimeSeconds),
          sub: `Node ${server.nodeVersion}`,
        }),
        stat({
          label: 'Memory in use',
          value: `${server.rssMb} MB`,
          sub: `${server.freeMemoryMb} MB free of ${server.totalMemoryMb} MB`,
          tone: server.freeMemoryMb < 400 ? 'warn' : 'neutral',
        }),
        stat({
          label: 'Signed in',
          value: String(data.sessions.count),
          sub: `${data.sessions.online.length} distinct user(s)`,
        }),
      ]),

      el('div', { class: 'grid grid-cols-1 gap-4 lg:grid-cols-2' }, [
        card({
          title: 'Storage',
          subtitle: 'Workbooks are held in memory and written through to disk under a per-file lock.',
          body: el('div', { class: 'space-y-3' }, [
            el('div', {}, [
              el('p', { class: 'mb-1 text-xs uppercase tracking-wide text-ink-500', text: 'Loaded workbooks' }),
              el(
                'div',
                { class: 'flex flex-wrap gap-1' },
                data.storage.loadedWorkbooks.map((name) => chip(name, 'neutral'))
              ),
            ]),
            el('div', {}, [
              el('p', { class: 'mb-1 text-xs uppercase tracking-wide text-ink-500', text: 'Locks held right now' }),
              data.storage.heldLocks.length
                ? el(
                    'ul',
                    { class: 'space-y-1 text-sm' },
                    data.storage.heldLocks.map((lock) =>
                      el('li', {
                        class: lock.heldMs > 5000 ? 'text-rose-700' : '',
                        text: `${lock.name} — ${lock.heldMs} ms ${lock.label ? `(${lock.label})` : ''}`,
                      })
                    )
                  )
                : el('p', { class: 'text-sm text-emerald-700', text: 'None — no write is in progress.' }),
            ]),
            el('p', {
              class: 'text-xs text-ink-500',
              text: `Sheets are split before they reach ${fmt.number(data.storage.maxRowsPerSheet)} rows.`,
            }),
          ]),
        }),

        card({
          title: 'Backup',
          body: el('div', { class: 'space-y-1 text-sm' }, [
            row(
              'Last successful',
              data.backup.lastSuccess ? `${fmt.dateTime(data.backup.lastSuccess.at)} (${fmt.ago(data.backup.lastSuccess.at)})` : 'never'
            ),
            row('Hours since', data.backup.hoursSince === null ? '—' : String(data.backup.hoursSince)),
            row('State', data.backup.severity === 'none' ? 'Healthy' : fmt.humanise(data.backup.severity)),
            data.backup.message ? el('p', { class: 'pt-1 text-xs text-amber-700', text: data.backup.message }) : null,
          ]),
        }),

        card({
          title: 'Licence',
          body: el('div', { class: 'space-y-1 text-sm' }, [
            row('Status', fmt.humanise(data.license.status)),
            row('Days left', data.license.daysLeft === null ? 'Perpetual' : String(data.license.daysLeft)),
            row('Machine ID', `${data.license.machineId.slice(0, 16)}…`),
          ]),
        }),

        card({
          title: 'Access hours',
          body: el('div', { class: 'space-y-1 text-sm' }, [
            row('Phase', fmt.humanise(data.hours.phase)),
            row('Enforced', data.hours.enforced ? 'Yes' : 'No — switched off in Settings'),
            row('Today', data.hours.schedule.closed ? `Closed (${data.hours.schedule.sourceName})` : `${fmt.time(data.hours.schedule.open)} – ${fmt.time(data.hours.schedule.close)}`),
            data.hours.override
              ? row('Override', `until ${fmt.time(data.hours.override.expiresAt)} — ${data.hours.override.reason}`)
              : null,
          ]),
        }),
      ]),

      card({
        title: 'Signed in now',
        body: table({
          dense: true,
          columns: [
            { key: 'userName', label: 'User' },
            { key: 'roleKey', label: 'Role', render: (row) => fmt.humanise(row.roleKey) },
            { key: 'ip', label: 'From' },
            { key: 'lastSeenAt', label: 'Last activity', render: (row) => fmt.ago(row.lastSeenAt) },
          ],
          rows: data.sessions.online,
          emptyMessage: 'Nobody is signed in.',
        }),
      }),

      data.journal.length
        ? card({
            title: 'Write journal',
            subtitle:
              'A folder appears here only if a write failed part-way through. They are left on disk deliberately so they can be inspected rather than silently discarded.',
            body: table({
              dense: true,
              columns: [
                { key: 'token', label: 'Snapshot' },
                { key: 'at', label: 'When', type: 'dateTime' },
                { key: 'files', label: 'Files', type: 'num' },
                {
                  key: 'restored',
                  label: 'Outcome',
                  render: (row) => (row.restored ? chip('Rolled back', 'warn') : chip('Left over', 'bad')),
                },
              ],
              rows: [...pending, ...restored],
            }),
          })
        : null,
    ]),
  });
}

function row(label, value) {
  if (!value) return null;
  return el('div', { class: 'flex flex-wrap justify-between gap-3' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('span', { class: 'font-medium', text: value }),
  ]);
}

function uptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

void empty;
