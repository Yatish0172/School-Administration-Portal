/**
 * Settings: school profile and every configurable knob, grouped by category, plus
 * the number formats for admission numbers, receipts and invoices.
 *
 * `current` on a counter is deliberately not editable — moving it backwards would
 * reissue receipt numbers that already exist on paper.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, toast, tabs, icon } from '../ui.js';
import { guardedSave, readOnlyNotice } from './_common.js';
import { setSchool } from '../state.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());

  let activeTab = context.query?.tab || 'School';
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/settings');
      const categories = [...new Set(data.definitions.map((definition) => definition.category))];
      if (!categories.includes(activeTab)) activeTab = categories[0];

      host.replaceChildren(
        tabs(
          [...categories.map((category) => ({ key: category, label: category })), { key: '__counters', label: 'Number formats' }],
          activeTab,
          (key) => {
            activeTab = key;
            load();
          }
        ),
        activeTab === '__counters' ? countersCard(data, load) : categoryCard(data, activeTab, load)
      );
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Settings',
      subtitle: 'Changes are recorded in the audit log with the old and new value.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  await load();
}

function categoryCard(data, category, reload) {
  const definitions = data.definitions.filter((definition) => definition.category === category);
  const draft = {};

  const fields = definitions.map((definition) => {
    const value = data.values[definition.key];

    if (definition.type === 'bool') {
      const box = el('input', {
        type: 'checkbox',
        class: 'h-4 w-4 rounded border-ink-300 text-brand-600',
        checked: !!value,
        disabled: !!definition.readOnly,
      });
      box.addEventListener('change', () => {
        draft[definition.key] = box.checked;
      });
      return el('label', { class: 'flex items-start gap-2 sm:col-span-2' }, [
        box,
        el('div', {}, [
          el('span', { class: 'text-sm text-ink-800', text: definition.label }),
          el('p', { class: 'text-xs text-ink-500', text: definition.key }),
        ]),
      ]);
    }

    const input = el('input', {
      class: 'input',
      type: definition.type === 'num' ? 'number' : 'text',
      value: value ?? '',
      disabled: !!definition.readOnly,
      step: definition.type === 'num' ? 'any' : null,
    });
    input.addEventListener('input', () => {
      draft[definition.key] = definition.type === 'num' ? Number(input.value) : input.value;
    });

    return el('div', {}, [
      el('label', { class: 'label', text: definition.label }),
      input,
      el('p', { class: 'hint', text: definition.readOnly ? 'Fixed — cannot be changed.' : definition.key }),
    ]);
  });

  return card({
    title: category,
    subtitle: describeCategory(category),
    actions: [
      button('Save changes', {
        variant: 'primary',
        iconName: 'save',
        onClick: async () => {
          if (!Object.keys(draft).length) {
            toast('Nothing has changed.', 'info', 3000);
            return;
          }
          await guardedSave(() => api.put('/api/settings', { values: draft }), {
            successMessage: null,
            onDone: async (result) => {
              const count = Object.keys(result.changed).length;
              toast(count ? `${count} setting(s) saved.` : 'Nothing changed.', 'good');
              // The shell shows the school name, so refresh what it reads from.
              try {
                setSchool(await api.get('/api/settings/public'));
              } catch (err) {
                // Not important enough to interrupt the save.
              }
              reload();
            },
          }).catch(() => {});
        },
      }),
    ],
    body: el('div', { class: 'grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2' }, fields),
  });
}

function describeCategory(category) {
  const notes = {
    School: 'Appears on every printed receipt, report card and transfer certificate.',
    Hours: 'The weekly grid, holidays and per-role rules live on the Access hours screen.',
    Security: 'A PIN is only safe because of the lockout. Do not raise the threshold much.',
    Devices: 'Turning enforcement off means any device on the school Wi-Fi can sign in with a password.',
    Attendance: 'The lock window is how long a teacher has to fix their own mistake without needing permission.',
    Fees: 'Reversal approval should stay on unless one person genuinely does both jobs.',
    Library: 'Loan period, fines and per-student limits.',
    Uploads: 'Applies to student and staff documents and photos.',
    Backup: 'A second copy path can be a USB stick or a second drive on this PC.',
  };
  return notes[category] || null;
}

function countersCard(data, reload) {
  const draft = new Map();

  return card({
    title: 'Number formats',
    subtitle:
      'Prefix and padding for the numbers this portal generates. The running count cannot be edited — moving it backwards would reissue numbers that are already on printed paper.',
    body: el('div', { class: 'space-y-3' }, [
      table({
        columns: [
          { key: 'name', label: 'Used for', render: (row) => fmt.humanise(row.name) },
          {
            key: 'prefix',
            label: 'Prefix',
            render: (row) => {
              const input = el('input', { class: 'input', value: row.prefix ?? '', style: { width: '7rem' }, maxLength: 12 });
              input.addEventListener('input', () => {
                draft.set(row.name, { ...(draft.get(row.name) || {}), prefix: input.value });
              });
              return input;
            },
          },
          {
            key: 'padding',
            label: 'Digits',
            render: (row) => {
              const input = el('input', {
                class: 'input',
                type: 'number',
                min: '0',
                max: '12',
                value: row.padding ?? 0,
                style: { width: '5rem' },
              });
              input.addEventListener('input', () => {
                draft.set(row.name, { ...(draft.get(row.name) || {}), padding: Number(input.value) });
              });
              return input;
            },
          },
          { key: 'current', label: 'Issued so far', type: 'num' },
          {
            key: 'nextFormatted',
            label: 'Next will be',
            render: (row) => chip(row.nextFormatted, 'neutral'),
          },
          {
            key: 'save',
            label: '',
            render: (row) =>
              button('Save', {
                size: 'sm',
                onClick: async () => {
                  const change = draft.get(row.name);
                  if (!change) {
                    toast('Nothing changed for that number.', 'info', 3000);
                    return;
                  }
                  await guardedSave(
                    () =>
                      api.put(`/api/settings/counters/${row.name}`, {
                        prefix: change.prefix ?? row.prefix,
                        padding: change.padding ?? row.padding,
                      }),
                    { successMessage: 'Number format saved.', onDone: reload }
                  ).catch(() => {});
                },
              }),
          },
        ],
        rows: data.counters,
        emptyMessage: 'No counters yet.',
      }),
      el('div', { class: 'flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900' }, [
        icon('warning'),
        el('span', {
          text:
            'Changing a prefix mid-year means two formats exist in the same year’s records. That is allowed, but do it at a year boundary if you can.',
        }),
      ]),
    ]),
  });
}
