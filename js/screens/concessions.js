/**
 * Concessions (SPEC §11, T29). Requested by Accounts, approved by the Principal.
 * A pending concession does not affect an invoice — only an approved one does.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, formModal, spinner, chip, askReason, filterSelect } from '../ui.js';
import { lookups, guardedSave, readOnlyNotice } from './_common.js';
import { can } from '../state.js';

const KINDS = [
  { value: 'sibling', label: 'Sibling' },
  { value: 'staff ward', label: 'Staff ward' },
  { value: 'merit', label: 'Merit' },
  { value: 'rte', label: 'RTE' },
  { value: 'other', label: 'Other' },
];

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  const view = { status: context.query?.status || null };
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const [data, heads] = await Promise.all([
        api.get('/api/fees/concessions', { status: view.status }),
        api.get('/api/fees/heads'),
      ]);
      host.replaceChildren(listCard(data, heads.rows, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Concessions',
      subtitle: 'Sibling, staff ward, merit and RTE discounts. Approval is required before any invoice is affected.',
      wide: true,
      actions: [
        can('fees.concession')
          ? button('Request a concession', {
              variant: 'primary',
              iconName: 'add',
              onClick: async () => {
                const heads = await api.get('/api/fees/heads');
                requestForm(heads.rows, load);
              },
            })
          : null,
      ],
      children: el('div', {}, [
        readOnlyNotice(),
        el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
          filterSelect({
            label: 'Status',
            options: ['pending', 'approved', 'rejected'],
            value: view.status,
            placeholder: 'All',
            onChange: (value) => {
              view.status = value;
              load();
            },
          }),
        ]),
        host,
      ]),
    })
  );

  await load();
}

function listCard(data, heads, reload) {
  const pending = data.rows.filter((row) => row.status === 'pending');

  return el('div', { class: 'space-y-4' }, [
    pending.length && can('fees.concession.approve')
      ? card({
          title: `Awaiting your approval (${pending.length})`,
          body: table({
            columns: [
              { key: 'name', label: 'Student', render: (row) => `${row.studentName} (${row.admissionNo})` },
              { key: 'feeHeadName', label: 'Applies to' },
              { key: 'kind', label: 'Kind', render: (row) => chip(fmt.humanise(row.kind), 'info') },
              {
                key: 'value',
                label: 'Value',
                render: (row) => (row.mode === 'percent' ? `${row.value}%` : fmt.money(row.value)),
              },
              { key: 'reason', label: 'Reason' },
              { key: 'requestedBy', label: 'Requested', render: (row) => fmt.ago(row.createdAt) },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  el('div', { class: 'flex gap-1' }, [
                    button('Approve', {
                      size: 'sm',
                      variant: 'primary',
                      onClick: () => decide(row, true, reload),
                    }),
                    button('Reject', { size: 'sm', onClick: () => decide(row, false, reload) }),
                  ]),
              },
            ],
            rows: pending,
          }),
        })
      : null,
    card({
      title: 'All concessions',
      body: table({
        columns: [
          { key: 'name', label: 'Student', render: (row) => `${row.studentName} (${row.admissionNo})` },
          { key: 'feeHeadName', label: 'Applies to' },
          { key: 'kind', label: 'Kind', render: (row) => fmt.humanise(row.kind) },
          {
            key: 'value',
            label: 'Value',
            render: (row) => (row.mode === 'percent' ? `${row.value}%` : fmt.money(row.value)),
          },
          { key: 'effectiveFrom', label: 'From', type: 'date' },
          { key: 'status', label: 'Status', type: 'status' },
          {
            key: 'decidedBy',
            label: 'Decided',
            render: (row) => (row.approvedAt ? fmt.date(row.approvedAt) : '—'),
          },
        ],
        rows: data.rows,
        emptyMessage: 'No concessions recorded.',
      }),
    }),
  ]);
}

async function decide(row, approve, reload) {
  if (approve) {
    await guardedSave(
      () => api.post(`/api/fees/concessions/${row.id}/decide`, { approve: true }),
      { successMessage: 'Concession approved.', onDone: reload }
    ).catch(() => {});
    return;
  }
  const reason = await askReason({
    title: 'Reject this concession',
    label: 'Reason for rejecting',
    confirmLabel: 'Reject',
    minLength: 3,
  });
  if (reason === null) return;
  await guardedSave(
    () => api.post(`/api/fees/concessions/${row.id}/decide`, { approve: false, rejectionReason: reason }),
    { successMessage: 'Concession rejected.', onDone: reload }
  ).catch(() => {});
}

function requestForm(heads, reload) {
  let studentResults = [];
  const searchInput = el('input', { class: 'input', placeholder: 'Type a name or admission number' });
  const studentSelect = el('select', { class: 'input' }, [el('option', { value: '', text: 'Search above first' })]);

  searchInput.addEventListener('input', debounce(async () => {
    const term = searchInput.value.trim();
    if (term.length < 2) return;
    const data = await api.get('/api/students', { search: term, status: 'Active', pageSize: 25 });
    studentResults = data.rows;
    studentSelect.replaceChildren(
      el('option', { value: '', text: studentResults.length ? 'Choose a student' : 'No matches' }),
      ...studentResults.map((row) =>
        el('option', { value: row.id, text: `${row.fullName} (${row.admissionNo})` })
      )
    );
  }, 300));

  const { formApi, dialog } = formModal({
    title: 'Request a concession',
    submitLabel: 'Send for approval',
    values: { mode: 'percent', effectiveFrom: fmt.today() },
    note: 'Concessions only reduce a bill once approved.',
    fields: [
      { name: 'kind', label: 'Kind', type: 'select', required: true, options: KINDS },
      {
        name: 'feeHeadId',
        label: 'Applies to',
        type: 'select',
        options: heads.map((head) => ({ value: head.id, label: head.name })),
        placeholder: 'All fee heads',
      },
      {
        name: 'mode',
        label: 'Discount type',
        type: 'select',
        required: true,
        options: [
          { value: 'percent', label: 'Percentage' },
          { value: 'fixed', label: 'Fixed amount' },
        ],
      },
      { name: 'value', label: 'Value', type: 'number', required: true, min: 0, step: 0.01 },
      { name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true },
      { name: 'effectiveTo', label: 'Effective to', type: 'date' },
      { name: 'reason', label: 'Reason', type: 'textarea', rows: 2, required: true, colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      if (!studentSelect.value) {
        helpers.setErrors({}, 'Choose the student this concession is for.');
        return;
      }
      await guardedSave(
        () => api.post('/api/fees/concessions', { ...values, studentId: studentSelect.value }),
        {
          successMessage: 'Concession sent for approval.',
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

  // The student picker is bespoke, so it is inserted above the generated form.
  dialog.body.insertBefore(
    el('div', { class: 'mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2' }, [
      el('div', {}, [el('label', { class: 'label', text: 'Find the student' }), searchInput]),
      el('div', {}, [el('label', { class: 'label', text: 'Student' }), studentSelect]),
    ]),
    formApi.node
  );
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
