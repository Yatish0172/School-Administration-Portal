/**
 * Device enrollment (SPEC §2, T08).
 *
 * An unenrolled device reaches the sign-in page but is refused even with the right
 * password. The QR here carries a one-time code so nobody has to type it, and
 * revoking a device ends its sessions immediately.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, statusChip, modal, toast, confirm, filterSelect, icon, printNode } from '../ui.js';
import { guardedSave, readOnlyNotice } from './_common.js';
import { qrSvg, isAvailable } from '../qr.js';
import { state } from '../state.js';

export async function render(container, context = {}) {
  const view = { userId: context.query?.userId || null, status: null };
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/devices', { userId: view.userId, status: view.status });
      host.replaceChildren(build(data, view, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Devices',
      subtitle:
        'The QR only tells a device where the server is. It grants nothing — enrollment and a password are what protect the data.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  await load();
}

function build(data, view, reload) {
  const active = data.rows.filter((row) => row.status === 'active');

  return el('div', { class: 'space-y-4' }, [
    data.settings['devices.enforce'] === false
      ? el('div', { class: 'banner-warn rounded-lg' }, [
          icon('info'),
          el('div', {}, [
            el('p', {
              class: 'font-medium',
              text: 'Device enrollment is switched off, so a password is all that is needed to sign in.',
            }),
            el('p', {
              class: 'mt-0.5 text-sm',
              text:
                'That applies to anyone on the school Wi-Fi, and to anyone holding the remote link while it is open. Nothing below has any effect until enrollment is switched back on in Settings.',
            }),
            el('p', {
              class: 'mt-0.5 text-sm',
              text:
                'It is off because the remote link changes every day, and a new link cannot recognise a device enrolled against the old one.',
            }),
          ]),
        ])
      : null,

    card({
      title: 'Enroll a new device',
      subtitle: `A code is valid for ${data.settings['devices.codeValidMinutes']} minutes and works once. Each user may have ${data.settings['devices.capPerUser']} device(s) by default.`,
      body: el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-sm text-ink-600', text: 'Pick the staff member, then let them scan the code on their own phone.' }),
        el('div', { class: 'flex flex-wrap items-end gap-2' }, [
          filterSelect({
            label: 'Staff member',
            width: '18rem',
            options: data.users.map((user) => ({ value: user.id, label: `${user.name} (${user.username})` })),
            value: null,
            placeholder: 'Choose a staff member',
            onChange: (value) => {
              if (value) issueCode(value, reload);
            },
          }),
        ]),
        data.codes.length
          ? el('div', { class: 'rounded-lg bg-amber-50 p-3 text-sm text-amber-900' }, [
              el('p', { class: 'font-medium', text: `${data.codes.length} code(s) currently outstanding` }),
              el(
                'ul',
                { class: 'mt-1 text-xs' },
                data.codes.map((code) =>
                  el('li', {
                    text: `${code.code} — expires ${fmt.time(code.expiresAt)}`,
                  })
                )
              ),
            ])
          : null,
      ]),
    }),

    el('div', { class: 'flex flex-wrap items-end gap-2 no-print' }, [
      filterSelect({
        label: 'User',
        width: '16rem',
        options: data.users.map((user) => ({ value: user.id, label: user.name })),
        value: view.userId,
        placeholder: 'All users',
        onChange: (value) => {
          view.userId = value;
          reload();
        },
      }),
      filterSelect({
        label: 'Status',
        options: ['active', 'revoked'],
        value: view.status,
        placeholder: 'All',
        onChange: (value) => {
          view.status = value;
          reload();
        },
      }),
    ]),

    card({
      title: `${active.length} active device${active.length === 1 ? '' : 's'}`,
      subtitle: 'The server PC itself is always trusted and never needs enrolling.',
      body: table({
        columns: [
          { key: 'name', label: 'Device' },
          { key: 'userName', label: 'Staff member' },
          {
            key: 'platform',
            label: 'Browser and OS',
            render: (row) => `${fmt.text(row.browser, '?')} on ${fmt.text(row.os, '?')}`,
          },
          { key: 'ip', label: 'Last address', width: '10rem' },
          {
            key: 'lastSeenAt',
            label: 'Last seen',
            width: '9rem',
            render: (row) => (row.lastSeenAt ? fmt.ago(row.lastSeenAt) : 'never'),
          },
          { key: 'enrolledAt', label: 'Enrolled', type: 'date', width: '9rem' },
          { key: 'status', label: 'Status', width: '8rem', render: (row) => statusChip(row.status) },
          {
            key: 'actions',
            label: '',
            render: (row) =>
              el('div', { class: 'flex gap-1' }, [
                button('Rename', { size: 'sm', onClick: () => renameFlow(row, reload) }),
                row.status === 'active'
                  ? button('Revoke', { size: 'sm', variant: 'danger', onClick: () => revokeFlow(row, reload) })
                  : null,
              ]),
          },
        ],
        rows: data.rows,
        emptyMessage: 'No devices enrolled yet. Staff on the server PC can still sign in.',
      }),
    }),
  ]);
}

async function issueCode(userId, reload) {
  try {
    const result = await api.post('/api/devices/codes', { userId });
    const qrOk = isAvailable();

    modal({
      title: `Enrollment code for ${result.user.name}`,
      size: 'md',
      body: el('div', { class: 'space-y-4' }, [
        el('div', { class: 'flex flex-col items-center gap-3 sm:flex-row sm:items-start' }, [
          qrOk
            ? qrSvg(result.url, { size: 200, title: 'Device enrollment QR code' })
            : el('div', { class: 'flex h-[200px] w-[200px] items-center justify-center rounded bg-ink-100 text-center text-xs text-ink-500', text: 'QR unavailable — read the code out instead.' }),
          el('div', { class: 'flex-1 space-y-2' }, [
            el('p', { class: 'text-xs uppercase tracking-wide text-ink-500', text: 'Code' }),
            el('p', {
              class: 'select-all rounded-lg bg-ink-900 px-4 py-2 text-center font-mono text-2xl font-bold tracking-widest text-white',
              text: result.code,
            }),
            el('p', {
              class: 'text-sm text-ink-600',
              text: `Valid until ${fmt.time(result.expiresAt)} — about ${result.minutes} minutes. It works once.`,
            }),
            el('ol', { class: 'list-decimal space-y-1 pl-4 text-sm text-ink-700' }, [
              el('li', { text: 'Connect their phone to the school Wi-Fi.' }),
              el('li', { text: 'Scan this code, or open the portal address and choose "I have a device enrollment code".' }),
              el('li', { text: 'They enter the code with their own username and password.' }),
              el('li', { text: 'The device is registered and they will not need a code again.' }),
            ]),
            // Someone enrolling from home cannot reach the LAN address at all, so
            // the tunnel link is offered whenever remote access is open.
            result.remoteUrl
              ? el('div', { class: 'rounded-lg bg-ink-50 p-2' }, [
                  el('p', { class: 'text-xs font-semibold uppercase tracking-wide text-ink-500', text: 'Enrolling from outside the school' }),
                  el('p', { class: 'mt-0.5 break-all font-mono text-xs text-ink-700', text: result.remoteUrl }),
                  el('div', { class: 'mt-1 flex gap-2' }, [
                    button('Copy remote link', {
                      size: 'sm',
                      onClick: async () => {
                        try {
                          await navigator.clipboard.writeText(result.remoteUrl);
                          toast('Remote link copied.', 'good', 2000);
                        } catch (err) {
                          toast('Select the text and copy it manually.', 'warn');
                        }
                      },
                    }),
                  ]),
                ])
              : null,
          ]),
        ]),
      ]),
      actions: (close) => [
        button('Print', {
          iconName: 'print',
          onClick: () =>
            printNode(
              el('div', { class: 'print-page bg-white p-8 text-center' }, [
                el('h1', { class: 'font-display text-xl font-bold', text: state.school?.name || 'School' }),
                el('h2', { class: 'mb-4 text-base', text: `Device enrollment for ${result.user.name}` }),
                qrOk ? qrSvg(result.url, { size: 240 }) : null,
                el('p', { class: 'mt-3 font-mono text-2xl font-bold tracking-widest', text: result.code }),
                el('p', { class: 'mt-2 text-sm', text: `Expires ${fmt.dateTime(result.expiresAt)}. Works once.` }),
                el('p', { class: 'mt-4 text-xs', text: 'Connect to the school Wi-Fi, scan the code, then sign in with your own password.' }),
              ]),
              { title: 'Enrollment code' }
            ),
        }),
        button('Done', {
          variant: 'primary',
          onClick: () => {
            close();
            reload();
          },
        }),
      ],
    });
  } catch (err) {
    toast(err.message, 'bad', 8000);
  }
}

function renameFlow(row, reload) {
  const input = el('input', { class: 'input', value: row.name || '', placeholder: "e.g. Rekha's phone" });
  modal({
    title: 'Rename this device',
    size: 'sm',
    body: el('div', { class: 'space-y-2' }, [
      el('p', { class: 'text-sm text-ink-600', text: 'Give it a name the office will recognise in this list.' }),
      input,
    ]),
    actions: (close) => [
      button('Cancel', { onClick: close }),
      button('Save', {
        variant: 'primary',
        onClick: async () => {
          await guardedSave(() => api.put(`/api/devices/${row.id}`, { name: input.value, _rev: row._rev }), {
            successMessage: 'Device renamed.',
            onDone: () => {
              close();
              reload();
            },
          }).catch(() => {});
        },
      }),
    ],
  });
}

async function revokeFlow(row, reload) {
  const proceed = await confirm({
    title: `Revoke "${row.name}"?`,
    message: `${row.userName} is signed out of that device immediately and cannot sign in from it again without a new enrollment code.`,
    detail: 'Use this the moment a phone is lost or a staff member leaves.',
    confirmLabel: 'Revoke device',
    danger: true,
  });
  if (!proceed) return;
  await guardedSave(() => api.post(`/api/devices/${row.id}/revoke`), {
    successMessage: null,
    onDone: (result) => {
      toast(`Device revoked. ${result.sessionsEnded} session(s) ended.`, 'good');
      reload();
    },
  }).catch(() => {});
}

void chip;
