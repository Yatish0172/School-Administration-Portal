/**
 * Leave requests and balances (SPEC §12). A teacher sees their own; HR and the
 * Principal see everyone's and can approve.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, formModal, askReason, filterSelect, empty, grid, stat } from '../ui.js';
import { guardedSave, readOnlyNotice } from './_common.js';

export async function render(container, context = {}) {
  const view = { status: context.query?.status || null };
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/leave', { status: view.status });
      host.replaceChildren(build(data, view, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Leave',
      subtitle: 'Approved leave counts as a payable day and reduces the balance.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  await load();
}

function build(data, view, reload) {
  const pending = data.rows.filter((row) => row.status === 'pending');

  return el('div', { class: 'space-y-4' }, [
    data.balances.length
      ? card({
          title: 'Your balances',
          body: grid(
            5,
            data.balances.map((balance) =>
              stat({
                label: balance.leaveType,
                value: String(balance.remaining),
                sub: `of ${balance.opening + balance.accrued} • ${balance.used} used`,
                tone: balance.remaining <= 0 ? 'warn' : 'neutral',
              })
            )
          ),
        })
      : null,

    el('div', { class: 'flex flex-wrap items-end gap-2 no-print' }, [
      filterSelect({
        label: 'Status',
        options: ['pending', 'approved', 'rejected'],
        value: view.status,
        placeholder: 'All',
        onChange: (value) => {
          view.status = value;
          reload();
        },
      }),
      data.ownStaffId
        ? button('Apply for leave', {
            variant: 'primary',
            iconName: 'add',
            onClick: () => applyForm(data, reload),
          })
        : null,
      !data.ownStaffId && data.canApprove
        ? el('p', { class: 'text-xs text-ink-500', text: 'Your login is not linked to a staff record, so you cannot apply for leave yourself.' })
        : null,
    ]),

    pending.length && data.canApprove
      ? card({
          title: `Awaiting approval (${pending.length})`,
          body: table({
            columns: [
              { key: 'staffName', label: 'Staff' },
              { key: 'leaveType', label: 'Type', width: '6rem' },
              { key: 'fromDate', label: 'From', type: 'date', width: '8rem' },
              { key: 'toDate', label: 'To', type: 'date', width: '8rem' },
              { key: 'days', label: 'Days', type: 'num', width: '5rem' },
              { key: 'reason', label: 'Reason' },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  el('div', { class: 'flex gap-1' }, [
                    button('Approve', {
                      size: 'sm',
                      variant: 'primary',
                      onClick: async () => {
                        await guardedSave(
                          () => api.post(`/api/leave/${row.id}/decide`, { approve: true }),
                          { successMessage: 'Leave approved.', onDone: reload }
                        ).catch(() => {});
                      },
                    }),
                    button('Reject', {
                      size: 'sm',
                      onClick: async () => {
                        const reason = await askReason({
                          title: 'Reject this leave request',
                          label: 'Reason',
                          confirmLabel: 'Reject',
                          minLength: 3,
                        });
                        if (reason === null) return;
                        await guardedSave(
                          () => api.post(`/api/leave/${row.id}/decide`, { approve: false, rejectionReason: reason }),
                          { successMessage: 'Leave rejected.', onDone: reload }
                        ).catch(() => {});
                      },
                    }),
                  ]),
              },
            ],
            rows: pending,
          }),
        })
      : null,

    card({
      title: 'All requests',
      body: table({
        columns: [
          { key: 'staffName', label: 'Staff' },
          { key: 'leaveType', label: 'Type', width: '6rem' },
          { key: 'fromDate', label: 'From', type: 'date', width: '8rem' },
          { key: 'toDate', label: 'To', type: 'date', width: '8rem' },
          { key: 'days', label: 'Days', type: 'num', width: '5rem' },
          { key: 'reason', label: 'Reason' },
          { key: 'status', label: 'Status', type: 'status', width: '8rem' },
          {
            key: 'note',
            label: 'Note',
            render: (row) => row.rejectionReason || '',
          },
        ],
        rows: data.rows,
        emptyMessage: 'No leave requests.',
      }),
    }),
  ]);
}

function applyForm(data, reload) {
  formModal({
    title: 'Apply for leave',
    submitLabel: 'Submit request',
    values: { fromDate: fmt.today(), toDate: fmt.today() },
    fields: [
      {
        name: 'leaveType',
        label: 'Type',
        type: 'select',
        required: true,
        options: data.leaveTypes.map((type) => ({
          value: type,
          label: `${type}${
            data.balances.find((balance) => balance.leaveType === type)
              ? ` — ${data.balances.find((balance) => balance.leaveType === type).remaining} left`
              : ''
          }`,
        })),
      },
      { name: 'fromDate', label: 'From', type: 'date', required: true },
      { name: 'toDate', label: 'To', type: 'date', required: true },
      { name: 'reason', label: 'Reason', type: 'textarea', rows: 3, required: true, colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(() => api.post('/api/leave', values), {
        successMessage: 'Leave request submitted.',
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

void chip;
void empty;
