/**
 * Backup and restore (SPEC §16, T10).
 *
 * "An untested backup is not a backup" — the restore button here runs the same code
 * path as any real recovery, so testing it tests the real thing. It re-authenticates
 * and takes a safety copy first.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, stat, grid, modal, toast, icon, confirm } from '../ui.js';
import { guardedSave } from './_common.js';
import { can, state } from '../state.js';

export async function render(container) {
  container.replaceChildren(spinner());

  async function load() {
    const data = await api.get('/api/backup');
    container.replaceChildren(build(data, load));
  }

  await load();
}

function build(data, reload) {
  const status = data.status;

  return page({
    title: 'Backup and restore',
    subtitle:
      'The whole data folder and every uploaded document, zipped while all files are locked so the copy is consistent.',
    wide: true,
    actions: [
      button('Back up now', {
        variant: 'primary',
        iconName: 'backup',
        onClick: async () => {
          const busy = toast('Backing up — this locks the data for a few seconds…', 'info', 30000);
          try {
            const result = await api.post('/api/backup/run');
            busy.remove();
            toast(`Backup complete — ${fmt.bytes(result.sizeBytes)} in ${(result.durationMs / 1000).toFixed(1)}s`, 'good');
            reload();
          } catch (err) {
            busy.remove();
            toast(err.message, 'bad', 9000);
          }
        },
      }),
    ],
    children: el('div', { class: 'space-y-4' }, [
      status.message
        ? el('div', { class: `${status.severity === 'critical' ? 'banner-bad' : 'banner-warn'} rounded-lg` }, [
            icon(status.severity === 'critical' ? 'error' : 'warning'),
            el('span', { class: 'flex-1', text: status.message }),
          ])
        : el('div', { class: 'banner-info rounded-lg' }, [
            icon('check_circle'),
            el('span', { text: `Last successful backup ${fmt.ago(status.lastSuccess.at)}.` }),
          ]),

      grid(4, [
        stat({
          label: 'Last successful',
          value: status.lastSuccess ? fmt.ago(status.lastSuccess.at) : 'never',
          sub: status.lastSuccess ? fmt.bytes(status.lastSuccess.sizeBytes) : 'Run one now',
          tone: status.severity === 'none' ? 'good' : status.severity === 'critical' ? 'bad' : 'warn',
        }),
        stat({ label: 'Copies on disk', value: fmt.number(data.files.length) }),
        stat({ label: 'Daily kept', value: String(data.settings['backup.retainDaily']) }),
        stat({ label: 'Monthly kept', value: String(data.settings['backup.retainMonthly']) }),
      ]),

      card({
        title: 'How this is set up',
        body: el('div', { class: 'space-y-1 text-sm' }, [
          row('Automatic daily backup', `at ${String(data.settings['backup.dailyHour']).padStart(2, '0')}:00, plus one on shutdown`),
          row(
            'Second copy',
            data.settings['backup.secondaryPath']
              ? `copied to ${data.settings['backup.secondaryPath']}`
              : 'not set — add a second drive or USB path in Settings'
          ),
          el('p', {
            class: 'pt-2 text-xs text-ink-500',
            text:
              'Off-site copy is a manual step by design: a weekly zip onto a rotated USB stick the Principal takes home. A backup that only exists on this PC does not survive a fire or a theft.',
          }),
        ]),
      }),

      card({
        title: 'Backup history',
        body: table({
          columns: [
            { key: 'at', label: 'When', type: 'dateTime', width: '14rem' },
            { key: 'kind', label: 'Kind', width: '8rem', render: (row) => chip(fmt.humanise(row.kind), 'neutral') },
            { key: 'status', label: 'Result', type: 'status', width: '8rem' },
            { key: 'sizeBytes', label: 'Size', render: (row) => fmt.bytes(row.sizeBytes) },
            {
              key: 'durationMs',
              label: 'Took',
              render: (row) => (row.durationMs ? `${(row.durationMs / 1000).toFixed(1)}s` : '—'),
            },
            {
              key: 'checksum',
              label: 'Checksum',
              render: (row) =>
                row.checksum
                  ? el('span', { class: 'font-mono text-[11px] text-ink-500', text: row.checksum.slice(0, 12) })
                  : '—',
            },
            { key: 'error', label: 'Error' },
          ],
          rows: data.history,
          emptyMessage: 'No backups have run yet.',
        }),
      }),

      can('backup.restore')
        ? card({
            title: 'Restore',
            subtitle:
              'Replaces all current data with a backup. A safety copy of the present state is taken first, so a mistaken restore is itself undoable.',
            body: el('div', { class: 'space-y-3' }, [
              el('div', { class: 'rounded-lg bg-rose-50 p-3 text-sm text-rose-900' }, [
                el('p', { class: 'font-medium', text: 'Read this before you restore.' }),
                el('ul', { class: 'mt-1 list-disc space-y-0.5 pl-5' }, [
                  el('li', { text: 'Everything entered since that backup is lost.' }),
                  el('li', { text: 'Everyone else is signed out and must sign in again.' }),
                  el('li', { text: 'Users and permissions revert to what they were in that backup.' }),
                  el('li', { text: 'Test this once per term so you know it works before you ever need it.' }),
                ]),
              ]),
              table({
                columns: [
                  { key: 'name', label: 'File' },
                  { key: 'at', label: 'Created', type: 'dateTime', width: '14rem' },
                  { key: 'sizeBytes', label: 'Size', render: (row) => fmt.bytes(row.sizeBytes) },
                  {
                    key: 'actions',
                    label: '',
                    render: (row) =>
                      button('Restore this', {
                        size: 'sm',
                        variant: 'danger',
                        onClick: () => restoreFlow(row, reload),
                      }),
                  },
                ],
                rows: data.files,
                emptyMessage: 'No backup files on disk.',
              }),
            ]),
          })
        : null,
    ]),
  });
}

function row(label, value) {
  return el('div', { class: 'flex flex-wrap justify-between gap-3' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('span', { class: 'font-medium', text: value }),
  ]);
}

async function restoreFlow(file, reload) {
  const proceed = await confirm({
    title: 'Restore this backup?',
    message: `All current data will be replaced with the contents of ${file.name} from ${fmt.dateTime(file.at)}.`,
    detail: 'Anything entered since then is lost. A safety copy of the present state is taken first.',
    confirmLabel: 'I understand, continue',
    danger: true,
    confirmText: 'RESTORE',
  });
  if (!proceed) return;

  const passwordInput = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const confirmInput = el('input', { class: 'input', placeholder: 'RESTORE' });
  const errorNode = el('p', { class: 'field-error hidden' });

  modal({
    title: 'Confirm with your password',
    size: 'sm',
    closeOnBackdrop: false,
    body: el('div', { class: 'space-y-3' }, [
      el('p', {
        class: 'text-sm text-ink-700',
        text: `Signed in as ${state.user?.name}. Enter your password to authorise the restore.`,
      }),
      el('div', {}, [el('label', { class: 'label', text: 'Your password' }), passwordInput]),
      el('div', {}, [el('label', { class: 'label', text: 'Type RESTORE' }), confirmInput]),
      errorNode,
    ]),
    actions: (close) => [
      button('Cancel', { onClick: close }),
      button('Restore now', {
        variant: 'danger',
        onClick: async (event) => {
          const btn = event.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Restoring…';
          try {
            const result = await api.post('/api/backup/restore', {
              file: file.name,
              password: passwordInput.value,
              confirm: confirmInput.value.trim(),
            });
            close();
            toast(
              `Restored from ${result.restored}. Safety copy saved as ${result.safetyBackup}.`,
              'good',
              12000
            );
            reload();
          } catch (err) {
            errorNode.textContent = err.message;
            errorNode.classList.remove('hidden');
            btn.disabled = false;
            btn.textContent = 'Restore now';
          }
        },
      }),
    ],
  });
}

void guardedSave;
