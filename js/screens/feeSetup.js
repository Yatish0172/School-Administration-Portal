/**
 * Fee heads and per-class structures (SPEC §11, T28).
 *
 * Structures are effective-dated: saving a new amount closes the previous one off
 * rather than editing it, so a mid-year revision cannot corrupt invoices already
 * issued.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, formModal, toast, spinner, tabs, statusChip, chip } from '../ui.js';
import { lookups, classOptions, guardedSave, readOnlyNotice } from './_common.js';
import { can } from '../state.js';

const KINDS = ['tuition', 'transport', 'exam', 'admission', 'lab', 'latefee', 'other'];
const FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'term', label: 'Per term' },
  { value: 'annual', label: 'Annual' },
  { value: 'onetime', label: 'One time' },
];

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  let activeTab = context.query?.tab || 'heads';
  const host = el('div');

  function paint() {
    host.replaceChildren(
      tabs(
        [
          { key: 'heads', label: 'Fee heads' },
          { key: 'structures', label: 'Amounts per class' },
        ],
        activeTab,
        (key) => {
          activeTab = key;
          paint();
        }
      ),
      el('div', { id: 'fee-setup-body' })
    );
    const body = host.querySelector('#fee-setup-body');
    if (activeTab === 'heads') loadHeads(body);
    else loadStructures(body);
  }

  container.replaceChildren(
    page({
      title: 'Fee setup',
      subtitle: 'Define what the school charges, then the amount per class.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  paint();
}

/* ----------------------------------------------------------------- fee heads */

async function loadHeads(host) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/fees/heads', { includeInactive: true });
    host.replaceChildren(
      card({
        title: 'Fee heads',
        subtitle: 'A head is one thing the school charges for. Retire a head instead of deleting it.',
        actions: can('fees.structure')
          ? [button('Add fee head', { variant: 'primary', iconName: 'add', onClick: () => headForm(null, () => loadHeads(host)) })]
          : null,
        body: table({
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'code', label: 'Code', width: '6rem' },
            { key: 'kind', label: 'Kind', render: (row) => chip(fmt.humanise(row.kind), 'neutral') },
            { key: 'refundable', label: 'Refundable', render: (row) => (row.refundable ? 'Yes' : 'No') },
            { key: 'sortOrder', label: 'Order', type: 'num', width: '5rem' },
            { key: 'status', label: 'Status', type: 'status', width: '7rem' },
            {
              key: 'actions',
              label: '',
              render: (row) =>
                can('fees.structure')
                  ? el('div', { class: 'flex gap-1' }, [
                      button('Edit', { size: 'sm', onClick: () => headForm(row, () => loadHeads(host)) }),
                      button(row.status === 'inactive' ? 'Restore' : 'Retire', {
                        size: 'sm',
                        onClick: async () => {
                          await guardedSave(
                            () =>
                              api.put(`/api/fees/heads/${row.id}`, {
                                status: row.status === 'inactive' ? 'active' : 'inactive',
                                _rev: row._rev,
                              }),
                            { successMessage: 'Fee head updated.', onDone: () => loadHeads(host) }
                          ).catch(() => {});
                        },
                      }),
                    ])
                  : null,
            },
          ],
          rows: data.rows,
          emptyMessage: 'No fee heads yet.',
        }),
      })
    );
  } catch (err) {
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

function headForm(existing, reload) {
  formModal({
    title: existing ? `Edit ${existing.name}` : 'New fee head',
    submitLabel: existing ? 'Save' : 'Create',
    values: existing || { kind: 'other', sortOrder: 0 },
    fields: [
      { name: 'name', label: 'Name', required: true, colSpan: 'full' },
      { name: 'code', label: 'Short code', maxLength: 12, hint: 'Appears on reports.' },
      { name: 'kind', label: 'Kind', type: 'select', required: true, options: KINDS },
      { name: 'sortOrder', label: 'Display order', type: 'number', min: 0 },
      { name: 'refundable', label: 'Refundable', type: 'checkbox' },
      { name: 'description', label: 'Description', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/fees/heads/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/fees/heads', values),
        {
          successMessage: existing ? 'Fee head saved.' : 'Fee head created.',
          onDone: () => {
            helpers.close();
            reload();
          },
        }
      ).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });
}

/* ---------------------------------------------------------------- structures */

async function loadStructures(host) {
  host.replaceChildren(spinner());
  try {
    const [structures, heads] = await Promise.all([
      api.get('/api/fees/structures'),
      api.get('/api/fees/heads'),
    ]);

    host.replaceChildren(
      card({
        title: 'Amounts per class',
        subtitle:
          'Saving a new amount closes the previous one off with an end date, so invoices already issued keep their original figures.',
        actions: can('fees.structure')
          ? [
              button('Set an amount', {
                variant: 'primary',
                iconName: 'add',
                onClick: () => structureForm(heads.rows, () => loadStructures(host)),
              }),
            ]
          : null,
        body: table({
          columns: [
            { key: 'className', label: 'Class' },
            { key: 'feeHeadName', label: 'Fee head' },
            { key: 'frequency', label: 'Frequency', render: (row) => fmt.humanise(row.frequency) },
            { key: 'amount', label: 'Amount', type: 'money' },
            { key: 'effectiveFrom', label: 'From', type: 'date' },
            {
              key: 'effectiveTo',
              label: 'To',
              render: (row) => (row.effectiveTo ? fmt.date(row.effectiveTo) : chip('Current', 'good')),
            },
          ],
          rows: structures.rows.sort(
            (a, b) =>
              String(a.className).localeCompare(String(b.className)) ||
              String(a.feeHeadName).localeCompare(String(b.feeHeadName)) ||
              String(b.effectiveFrom).localeCompare(String(a.effectiveFrom))
          ),
          emptyMessage: 'No amounts set yet. Invoices cannot be generated until at least one is.',
        }),
      })
    );
  } catch (err) {
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

function structureForm(heads, reload) {
  formModal({
    title: 'Set a fee amount',
    submitLabel: 'Save amount',
    values: { frequency: 'monthly', effectiveFrom: fmt.today() },
    note:
      'Any existing amount for this class, head and frequency is closed off the day before this one starts.',
    fields: [
      { name: 'classId', label: 'Class', type: 'select', required: true, options: classOptions() },
      {
        name: 'feeHeadId',
        label: 'Fee head',
        type: 'select',
        required: true,
        options: heads.map((head) => ({ value: head.id, label: head.name })),
      },
      { name: 'frequency', label: 'Frequency', type: 'select', required: true, options: FREQUENCIES },
      { name: 'amount', label: 'Amount', type: 'number', required: true, min: 0, step: 0.01 },
      { name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true },
      { name: 'effectiveTo', label: 'Effective to', type: 'date', hint: 'Leave blank for open-ended.' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(() => api.post('/api/fees/structures', values), {
        successMessage: 'Amount saved.',
        onDone: () => {
          helpers.close();
          reload();
        },
      }).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });
}

void toast;
void statusChip;
