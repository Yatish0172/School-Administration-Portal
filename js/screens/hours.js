/**
 * Access hours (SPEC §3, T09): weekly grid, holidays, special days, per-role
 * behaviour outside hours, and the emergency override.
 *
 * Administrator and Principal are always allowed in. That is deliberately not
 * configurable — if the hours are set wrong at 9pm, somebody has to be able to fix
 * them.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, tabs, formModal, toast, icon, confirm, modal, empty } from '../ui.js';
import { guardedSave, readOnlyNotice } from './_common.js';
import { refresh as refreshHours } from '../hours.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const BEHAVIOURS = [
  { value: 'full', label: 'Full access' },
  { value: 'extended', label: 'Extended window, then read-only' },
  { value: 'readonly', label: 'Read-only' },
  { value: 'blocked', label: 'Cannot sign in' },
];

export async function render(container, context = {}) {
  let activeTab = context.query?.tab || 'week';
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/hours/config');
      host.replaceChildren(
        tabs(
          [
            { key: 'week', label: 'Weekly hours' },
            { key: 'roles', label: 'Outside hours' },
            { key: 'calendar', label: 'Holidays and special days' },
            { key: 'override', label: 'Emergency override' },
          ],
          activeTab,
          (key) => {
            activeTab = key;
            load();
          }
        ),
        activeTab === 'week' ? weekCard(data, load) : null,
        activeTab === 'roles' ? rolesCard(data, load) : null,
        activeTab === 'calendar' ? calendarCards(data, load) : null,
        activeTab === 'override' ? overrideCard(data, load) : null
      );
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Access hours',
      subtitle:
        'Enforced on the server clock, in Asia/Kolkata. This is an operational control, not a security boundary — anyone with the server PC can change its clock.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  await load();
}

/* -------------------------------------------------------------- weekly grid */

function weekCard(data, reload) {
  const week = data.week.map((day) => ({ ...day }));

  const rows = week.map((day) =>
    el('tr', {}, [
      el('td', { class: 'font-medium', text: DAYS[day.day] }),
      el('td', {}, [
        (() => {
          const box = el('input', {
            type: 'checkbox',
            class: 'h-4 w-4 rounded border-ink-300 text-brand-600',
            checked: !!day.closed,
          });
          box.addEventListener('change', () => {
            day.closed = box.checked;
          });
          return box;
        })(),
      ]),
      el('td', {}, [timeInput(day, 'open')]),
      el('td', {}, [timeInput(day, 'close')]),
    ])
  );

  return el('div', { class: 'space-y-4' }, [
    card({
      title: 'Weekly opening hours',
      subtitle: 'Staff outside these hours are handled by the rules on the "Outside hours" tab.',
      actions: [
        button('Save hours', {
          variant: 'primary',
          iconName: 'save',
          onClick: async () => {
            await guardedSave(() => api.put('/api/hours/week', { days: week }), {
              successMessage: 'Opening hours saved.',
              onDone: async () => {
                await refreshHours();
                reload();
              },
            }).catch(() => {});
          },
        }),
      ],
      body: el('div', { class: 'overflow-x-auto' }, [
        el('table', { class: 'table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Day' }),
              el('th', { text: 'Closed all day', style: { width: '9rem' } }),
              el('th', { text: 'Opens', style: { width: '9rem' } }),
              el('th', { text: 'Closes', style: { width: '9rem' } }),
            ]),
          ]),
          el('tbody', {}, rows),
        ]),
      ]),
    }),
    card({
      title: 'The closing sequence',
      subtitle: 'What staff see as closing time approaches. These are the current settings.',
      body: el('div', { class: 'space-y-2 text-sm' }, [
        step(`Closing − ${data.settings['hours.warningLeadMinutes']} min`, 'A yellow banner appears.'),
        step('Closing − 5 min and − 1 min', 'A dismissible reminder pops up.'),
        step('Closing time', `Saves still accepted for ${data.settings['hours.graceMinutes']} minutes. Nothing new should be started.`),
        step('After the grace period', 'Read-only. Half-typed forms are kept on the staff member’s own device.'),
        step(
          `${data.settings['hours.sessionEndMinutesAfterGrace']} min later`,
          'The session ends. Nobody is ever cut off mid-save.'
        ),
        el('p', {
          class: 'pt-2 text-xs text-ink-500',
          text: 'Exports and printing keep working throughout, including in read-only mode.',
        }),
      ]),
    }),
  ]);
}

function step(label, text) {
  return el('div', { class: 'flex gap-3' }, [
    el('span', { class: 'w-44 flex-none font-medium text-ink-700', text: label }),
    el('span', { class: 'text-ink-600', text }),
  ]);
}

function timeInput(day, key) {
  const input = el('input', {
    class: 'input',
    type: 'time',
    value: day[key] || '',
    style: { width: '8rem' },
  });
  input.addEventListener('input', () => {
    day[key] = input.value;
  });
  return input;
}

/* ------------------------------------------------------------- role config */

function rolesCard(data, reload) {
  return card({
    title: 'What each role can do outside hours',
    subtitle:
      'Administrator and Principal always have full access. This is hard-coded so a bad schedule can always be fixed.',
    body: table({
      columns: [
        { key: 'roleName', label: 'Role' },
        {
          key: 'behaviour',
          label: 'Outside hours',
          render: (row) => {
            if (row.locked) return chip('Always full access', 'good');
            const select = el(
              'select',
              { class: 'input', style: { width: '17rem' } },
              BEHAVIOURS.map((option) =>
                el('option', { value: option.value, text: option.label, selected: option.value === row.behaviour })
              )
            );
            select.addEventListener('change', async () => {
              const extendedUntil =
                select.value === 'extended'
                  ? window.prompt('Extended window ends at (HH:MM, 24-hour)', row.extendedUntil || '19:00')
                  : '';
              if (select.value === 'extended' && !extendedUntil) {
                select.value = row.behaviour;
                return;
              }
              await guardedSave(
                () =>
                  api.put(`/api/hours/roles/${row.roleKey}`, {
                    behaviour: select.value,
                    extendedUntil,
                  }),
                { successMessage: `Updated ${row.roleName}.`, onDone: reload }
              ).catch(() => {
                select.value = row.behaviour;
              });
            });
            return select;
          },
        },
        {
          key: 'extendedUntil',
          label: 'Window ends',
          width: '9rem',
          render: (row) => (row.extendedUntil ? fmt.time(row.extendedUntil) : '—'),
        },
      ],
      rows: data.roles,
    }),
  });
}

/* ----------------------------------------------------------------- calendar */

function calendarCards(data, reload) {
  return el('div', { class: 'space-y-4' }, [
    card({
      title: 'Holidays',
      subtitle: 'Named closed dates. A holiday beats the weekly schedule.',
      actions: [
        button('Add a holiday', {
          iconName: 'add',
          onClick: () =>
            formModal({
              title: 'Add a holiday',
              submitLabel: 'Add',
              values: { fromDate: fmt.today() },
              fields: [
                { name: 'name', label: 'Name', required: true, colSpan: 'full' },
                { name: 'fromDate', label: 'From', type: 'date', required: true },
                { name: 'toDate', label: 'To', type: 'date', hint: 'Leave blank for a single day.' },
                { name: 'description', label: 'Note', colSpan: 'full' },
              ],
              onSubmit: async (values, helpers) => {
                await guardedSave(() => api.post('/api/hours/holidays', values), {
                  successMessage: 'Holiday added.',
                  onDone: () => {
                    helpers.close();
                    reload();
                  },
                }).catch((err) => {
                  if (err.fields) helpers.setErrors(err.fields, err.message);
                });
              },
            }),
        }),
      ],
      body: table({
        columns: [
          { key: 'name', label: 'Holiday' },
          { key: 'fromDate', label: 'From', type: 'date', width: '10rem' },
          { key: 'toDate', label: 'To', type: 'date', width: '10rem' },
          { key: 'description', label: 'Note' },
          {
            key: 'actions',
            label: '',
            render: (row) =>
              button('Remove', {
                size: 'sm',
                onClick: async () => {
                  const proceed = await confirm({
                    title: `Remove ${row.name}?`,
                    message: 'The portal will follow the normal weekly schedule on those dates again.',
                    confirmLabel: 'Remove',
                  });
                  if (!proceed) return;
                  await guardedSave(() => api.del(`/api/hours/holidays/${row.id}`), {
                    successMessage: 'Holiday removed.',
                    onDone: reload,
                  }).catch(() => {});
                },
              }),
          },
        ],
        rows: data.holidays,
        emptyMessage: 'No holidays entered. Add the year’s calendar so the portal is closed on the right days.',
      }),
    }),
    card({
      title: 'Special days',
      subtitle:
        'Different hours for one date — a PTM running to 7pm, an exam day starting at 6:30. A special day beats both a holiday and the weekly schedule.',
      actions: [
        button('Add a special day', {
          iconName: 'add',
          onClick: () =>
            formModal({
              title: 'Special hours for one day',
              submitLabel: 'Save',
              values: { date: fmt.today(), open: '07:30', close: '19:00' },
              fields: [
                { name: 'date', label: 'Date', type: 'date', required: true },
                { name: 'name', label: 'What is happening', required: true },
                { name: 'closed', label: 'Closed all day', type: 'checkbox' },
                { name: 'open', label: 'Opens', type: 'time', when: (values) => !values.closed },
                { name: 'close', label: 'Closes', type: 'time', when: (values) => !values.closed },
                { name: 'reason', label: 'Note', colSpan: 'full' },
              ],
              onSubmit: async (values, helpers) => {
                await guardedSave(() => api.post('/api/hours/special-days', values), {
                  successMessage: 'Special day saved.',
                  onDone: () => {
                    helpers.close();
                    reload();
                  },
                }).catch((err) => {
                  if (err.fields) helpers.setErrors(err.fields, err.message);
                });
              },
            }),
        }),
      ],
      body: table({
        columns: [
          { key: 'date', label: 'Date', type: 'date', width: '10rem' },
          { key: 'name', label: 'What' },
          {
            key: 'hours',
            label: 'Hours',
            render: (row) => (row.closed ? chip('Closed', 'bad') : `${fmt.time(row.open)} – ${fmt.time(row.close)}`),
          },
          { key: 'reason', label: 'Note' },
          {
            key: 'actions',
            label: '',
            render: (row) =>
              button('Remove', {
                size: 'sm',
                onClick: async () => {
                  await guardedSave(() => api.del(`/api/hours/special-days/${row.id}`), {
                    successMessage: 'Special day removed.',
                    onDone: reload,
                  }).catch(() => {});
                },
              }),
          },
        ],
        rows: data.specialDays,
        emptyMessage: 'No special days set.',
      }),
    }),
  ]);
}

/* ----------------------------------------------------------------- override */

function overrideCard(data, reload) {
  const active = data.activeOverride;

  return el('div', { class: 'space-y-4' }, [
    active
      ? card({
          title: 'An override is active',
          body: el('div', { class: 'space-y-2' }, [
            el('p', { class: 'text-sm' }, [
              icon('lock_open', 'mr-1 align-text-bottom text-emerald-600'),
              `Everyone has full access until ${fmt.dateTime(active.expiresAt)}.`,
            ]),
            el('p', { class: 'text-sm text-ink-600', text: `Reason: ${active.reason}` }),
            button('End it now', {
              variant: 'danger',
              onClick: async () => {
                await guardedSave(() => api.del('/api/hours/override'), {
                  successMessage: 'Override ended.',
                  onDone: async () => {
                    await refreshHours();
                    reload();
                  },
                }).catch(() => {});
              },
            }),
          ]),
        })
      : card({
          title: 'Extend today',
          subtitle:
            'Gives every role full access for a while. A reason is required and everything is recorded. It expires on its own.',
          body: el('div', { class: 'flex flex-wrap gap-2' }, [
            ...[1, 2, 4].map((hours) =>
              button(`${hours} hour${hours === 1 ? '' : 's'}`, {
                onClick: () => grant(hours, reload),
              })
            ),
            button('Until midnight', { onClick: () => grant('midnight', reload) }),
          ]),
        }),
    card({
      title: 'Override history',
      body: table({
        columns: [
          { key: 'startedAt', label: 'Granted', type: 'dateTime' },
          { key: 'expiresAt', label: 'Expired', type: 'dateTime' },
          { key: 'reason', label: 'Reason' },
          { key: 'status', label: 'Status', type: 'status', width: '9rem' },
        ],
        rows: data.overrides,
        emptyMessage: 'No overrides have ever been granted.',
      }),
    }),
  ]);
}

async function grant(hours, reload) {
  const { askReason } = await import('../ui.js');
  const reason = await askReason({
    title: hours === 'midnight' ? 'Extend until midnight' : `Extend by ${hours} hour(s)`,
    label: 'Why is this needed?',
    message: 'Everyone sees a banner while the override is active, and this reason is recorded against your name.',
    confirmLabel: 'Grant override',
    minLength: 5,
  });
  if (reason === null) return;
  await guardedSave(() => api.post('/api/hours/override', { hours, reason }), {
    successMessage: 'Override granted.',
    onDone: async () => {
      await refreshHours();
      reload();
    },
  }).catch(() => {});
}

void toast;
void modal;
void empty;
