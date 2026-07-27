/**
 * Licence (SPEC §18). Three deliberate differences from a hard cliff:
 * a 14-day grace period with escalating warnings, exports that always work, and a
 * documented emergency re-issue process on this very screen.
 */

import { api } from '../api.js';
import { el, page, card, button, fmt, spinner, chip, stat, grid, toast, icon, formModal } from '../ui.js';
import { guardedSave } from './_common.js';

export async function render(container) {
  container.replaceChildren(spinner());

  async function load() {
    const data = await api.get('/api/license');
    container.replaceChildren(build(data, load));
  }

  await load();
}

function build(data, reload) {
  const tone =
    data.status === 'active' ? 'good' : data.status === 'trial' ? 'info' : data.status === 'grace' ? 'warn' : 'bad';

  return page({
    title: 'Licence',
    subtitle: 'This copy is locked to this PC. Your data is never locked — export always works.',
    wide: true,
    actions: data.canManage
      ? [button('Enter a product key', { variant: 'primary', iconName: 'key', onClick: () => activateForm(reload) })]
      : null,
    children: el('div', { class: 'space-y-4' }, [
      data.message
        ? el('div', {
            class: `${data.severity === 'critical' ? 'banner-bad' : data.severity === 'warning' ? 'banner-warn' : 'banner-info'} rounded-lg`,
          }, [
            icon(data.severity === 'critical' ? 'error' : data.severity === 'warning' ? 'warning' : 'info'),
            el('span', { class: 'flex-1', text: data.message }),
          ])
        : null,

      grid(3, [
        stat({
          label: 'Status',
          value: fmt.humanise(data.status),
          sub: data.licensedTo ? `Licensed to ${data.licensedTo}` : 'Not activated',
          tone,
        }),
        stat({
          label: data.status === 'trial' ? 'Trial ends' : 'Expires',
          value: data.expiresAt ? fmt.date(data.expiresAt) : 'Never',
          sub: data.daysLeft === null ? 'Perpetual licence' : `${data.daysLeft} day(s) left`,
        }),
        stat({
          label: 'Writing allowed',
          value: data.canWrite ? 'Yes' : 'No',
          sub: data.canWrite ? 'Everything works normally' : 'Read, print and export only',
          tone: data.canWrite ? 'good' : 'bad',
        }),
      ]),

      card({
        title: 'This PC',
        subtitle: 'Support needs this machine ID to issue a key. It is derived from this computer’s hardware.',
        actions: [
          button('Copy machine ID', {
            iconName: 'content_copy',
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(data.machineId);
                toast('Machine ID copied.', 'good', 2000);
              } catch (err) {
                toast('Select the text and copy it manually.', 'warn');
              }
            },
          }),
        ],
        body: el('p', {
          class: 'select-all break-all rounded-lg bg-ink-900 px-3 py-2 font-mono text-sm text-ink-100',
          text: data.machineId,
        }),
      }),

      card({
        title: 'How expiry works here',
        body: el('div', { class: 'space-y-2 text-sm text-ink-700' }, [
          bullet('lock_open', `A ${data.trialDays}-day trial with full access, so the school can evaluate it properly.`),
          bullet(
            'schedule',
            `After expiry there is a ${data.graceDays}-day grace period with full access and escalating warnings — not a sudden stop mid-term.`
          ),
          bullet('visibility', 'Once the grace period ends the portal becomes read-only. Nothing is hidden or deleted.'),
          bullet('download', 'Export to Excel keeps working in every state, including expired. Your data is yours.'),
        ]),
      }),

      data.emergencyProcess
        ? card({
            title: 'If this PC dies',
            subtitle: 'Print this and keep it with the school’s records.',
            body: el(
              'ol',
              { class: 'list-decimal space-y-1 pl-5 text-sm text-ink-700' },
              data.emergencyProcess.map((step) => el('li', { text: step }))
            ),
          })
        : null,
    ]),
  });
}

function bullet(iconName, text) {
  return el('div', { class: 'flex gap-2' }, [icon(iconName, 'text-ink-400'), el('span', { class: 'flex-1', text })]);
}

function activateForm(reload) {
  formModal({
    title: 'Enter your product key',
    submitLabel: 'Activate',
    columns: 1,
    note: 'Paste the whole key exactly as it was sent, including any dots.',
    values: {},
    fields: [
      {
        name: 'key',
        label: 'Product key',
        type: 'textarea',
        rows: 4,
        required: true,
        colSpan: 'full',
        placeholder: 'eyJ2Ijox…',
      },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(() => api.post('/api/license/activate', { key: values.key }), {
        successMessage: null,
        onDone: (state) => {
          helpers.close();
          toast(
            state.expiresAt
              ? `Activated for ${state.licensedTo}. Valid until ${fmt.date(state.expiresAt)}.`
              : `Activated for ${state.licensedTo}. Perpetual licence.`,
            'good',
            9000
          );
          reload();
        },
      }).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });
}

void chip;
