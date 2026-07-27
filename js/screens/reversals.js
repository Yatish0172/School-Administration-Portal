/**
 * Payment reversals (SPEC §11, T33).
 *
 * A wrong receipt is cancelled by a reversal row; both records stay visible for
 * ever. Nothing on this screen deletes anything.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, askReason, filterSelect, toast } from '../ui.js';
import { guardedSave, readOnlyNotice } from './_common.js';
import { can } from '../state.js';

export async function render(container, context = {}) {
  const view = { status: context.query?.status || null };
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/fees/reversals', { status: view.status });
      host.replaceChildren(listCards(data, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Payment reversals',
      subtitle:
        'The original payment stays on the record with a reversed status. The reversal is its permanent counterpart.',
      wide: true,
      actions: [
        can('fees.reverse')
          ? button('Reverse a receipt', { variant: 'primary', iconName: 'undo', onClick: () => startReversal(load) })
          : null,
      ],
      children: el('div', {}, [
        readOnlyNotice(),
        el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
          filterSelect({
            label: 'Status',
            options: ['pending', 'applied', 'rejected'],
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

function listCards(data, reload) {
  const pending = data.rows.filter((row) => row.status === 'pending');

  return el('div', { class: 'space-y-4' }, [
    data.needsApproval === false
      ? el('div', { class: 'banner-warn rounded-lg' }, [
          el('span', {
            text:
              'Reversals are set to apply without approval. That is unusual for a fee module — consider turning approval back on in Settings.',
          }),
        ])
      : null,
    pending.length && can('fees.reverse.approve')
      ? card({
          title: `Awaiting approval (${pending.length})`,
          subtitle: 'Approving this reverses the money immediately and restores the balance on the student ledger.',
          body: table({
            columns: [
              { key: 'receiptNo', label: 'Receipt' },
              { key: 'amount', label: 'Amount', type: 'money' },
              { key: 'reason', label: 'Reason' },
              { key: 'requestedBy', label: 'Requested', render: (row) => fmt.ago(row.requestedAt) },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  el('div', { class: 'flex gap-1' }, [
                    button('Approve', {
                      size: 'sm',
                      variant: 'danger',
                      onClick: async () => {
                        await guardedSave(
                          () => api.post(`/api/fees/reversals/${row.id}/approve`),
                          { successMessage: `Receipt ${row.receiptNo} reversed.`, onDone: reload }
                        ).catch(() => {});
                      },
                    }),
                    button('Reject', {
                      size: 'sm',
                      onClick: async () => {
                        const reason = await askReason({
                          title: 'Reject this reversal request',
                          label: 'Reason',
                          confirmLabel: 'Reject',
                          minLength: 3,
                        });
                        if (reason === null) return;
                        await guardedSave(
                          () => api.post(`/api/fees/reversals/${row.id}/reject`, { rejectionReason: reason }),
                          { successMessage: 'Reversal rejected.', onDone: reload }
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
      title: 'All reversals',
      body: table({
        columns: [
          { key: 'receiptNo', label: 'Receipt' },
          { key: 'amount', label: 'Amount', type: 'money' },
          { key: 'reason', label: 'Reason' },
          { key: 'requestedAt', label: 'Requested', type: 'dateTime' },
          { key: 'status', label: 'Status', type: 'status' },
          {
            key: 'approvedAt',
            label: 'Decided',
            render: (row) => (row.approvedAt ? fmt.dateTime(row.approvedAt) : '—'),
          },
          {
            key: 'rejectionReason',
            label: 'Note',
            render: (row) => row.rejectionReason || '',
          },
        ],
        rows: data.rows,
        emptyMessage: 'No reversals have ever been requested.',
      }),
    }),
  ]);
}

async function startReversal(reload) {
  const receiptNo = window.prompt('Which receipt number should be reversed?');
  if (!receiptNo) return;
  try {
    await api.get(`/api/fees/receipts/${receiptNo.trim()}`);
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }
  const reason = await askReason({
    title: `Reverse receipt ${receiptNo.trim()}`,
    label: 'Reason for the reversal',
    message: 'Both the payment and this reversal stay visible on the student ledger for ever.',
    confirmLabel: 'Request reversal',
    minLength: 5,
  });
  if (reason === null) return;
  await guardedSave(
    () => api.post('/api/fees/reversals', { receiptNo: receiptNo.trim(), reason }),
    { successMessage: 'Reversal requested.', onDone: reload }
  ).catch(() => {});
  void chip;
}
