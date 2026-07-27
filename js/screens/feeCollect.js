/**
 * Fee collection (SPEC §11, T31).
 *
 * The idempotency key is generated once when this screen opens and reused for
 * every retry of the same payment. A dropped Wi-Fi connection plus a re-click
 * cannot charge a parent twice — the server returns the original receipt instead.
 *
 * A fresh key is only minted after a receipt has actually been issued.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, toast, spinner, chip, icon, modal, printNode, confirm, empty } from '../ui.js';
import { lookups, guardedSave, readOnlyNotice, printHeader, printFooter } from './_common.js';
import { state, can } from '../state.js';
import { navigate } from '../router.js';

const MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank transfer', label: 'Bank transfer' },
  { value: 'card', label: 'Card' },
  { value: 'dd', label: 'Demand draft' },
];

const NEEDS_REFERENCE = new Set(['cheque', 'upi', 'bank transfer', 'card', 'dd']);

function newIdempotencyKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function render(container, context) {
  const studentId = context.params.studentId;
  container.replaceChildren(spinner());
  await lookups();

  let idempotencyKey = newIdempotencyKey();
  let data = await api.get(`/api/fees/students/${studentId}`);

  const allocations = new Map(); // studentChargeId -> amount
  const amountInput = el('input', { class: 'input text-right tabular-nums font-semibold', type: 'number', min: '0', step: '0.01', value: '' });
  const modeSelect = el('select', { class: 'input' }, MODES.map((mode) => el('option', { value: mode.value, text: mode.label })));
  const referenceInput = el('input', { class: 'input', placeholder: 'Cheque / UPI / transaction number' });
  const referenceWrap = el('div', { class: 'hidden' }, [
    el('label', { class: 'label', text: 'Reference number' }),
    referenceInput,
  ]);
  const instrumentDate = el('input', { class: 'input', type: 'date', value: fmt.today() });
  const instrumentDateWrap = el('div', { class: 'hidden' }, [
    el('label', { class: 'label', text: 'Instrument date' }),
    instrumentDate,
  ]);
  const bankInput = el('input', { class: 'input', placeholder: 'Bank name' });
  const bankWrap = el('div', { class: 'hidden' }, [el('label', { class: 'label', text: 'Bank' }), bankInput]);
  const remarksInput = el('input', { class: 'input', placeholder: 'Optional note on the receipt' });
  const allocationNote = el('p', { class: 'text-xs text-ink-500' });
  const collectButton = button('Take payment', { variant: 'primary', iconName: 'payments', onClick: () => submit() });

  modeSelect.addEventListener('change', () => {
    const needs = NEEDS_REFERENCE.has(modeSelect.value);
    referenceWrap.classList.toggle('hidden', !needs);
    instrumentDateWrap.classList.toggle('hidden', modeSelect.value !== 'cheque' && modeSelect.value !== 'dd');
    bankWrap.classList.toggle('hidden', modeSelect.value !== 'cheque' && modeSelect.value !== 'dd' && modeSelect.value !== 'bank transfer');
  });

  const ledgerHost = el('div');

  function allocationTotal() {
    let total = 0;
    for (const amount of allocations.values()) total += Number(amount) || 0;
    return Math.round(total * 100) / 100;
  }

  function refreshNote() {
    const total = allocationTotal();
    const typed = Number(amountInput.value || 0);
    const matches = Math.abs(total - typed) < 0.005;
    allocationNote.textContent = total
      ? `Allocated ${fmt.money(total)}${matches ? '' : ` — the payment amount is ${fmt.money(typed)}. These must match.`}`
      : 'Enter an amount against the fees this payment covers.';
    allocationNote.className = total && !matches ? 'text-xs text-rose-600' : 'text-xs text-ink-500';
    collectButton.disabled = !total;
  }

  /** Spreads a lump sum across the oldest dues first, which is what the counter does. */
  function autoAllocate(amount) {
    let remaining = Math.round(Number(amount || 0) * 100) / 100;
    allocations.clear();
    for (const charge of data.outstanding) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(charge.balance));
      if (take <= 0) continue;
      allocations.set(charge.id, Math.round(take * 100) / 100);
      remaining = Math.round((remaining - take) * 100) / 100;
    }
    paintLedger();
    if (remaining > 0) {
      toast(`${fmt.money(remaining)} is more than the total outstanding. Reduce the amount.`, 'warn');
    }
  }

  amountInput.addEventListener('change', () => autoAllocate(amountInput.value));

  function paintLedger() {
    ledgerHost.replaceChildren(
      data.outstanding.length
        ? table({
            columns: [
              { key: 'period', label: 'Period', width: '7rem' },
              { key: 'feeHeadName', label: 'Fee head' },
              { key: 'dueDate', label: 'Due', type: 'date', width: '8rem' },
              { key: 'netAmount', label: 'Billed', type: 'money' },
              { key: 'paidAmount', label: 'Paid', type: 'money' },
              { key: 'balance', label: 'Balance', type: 'money' },
              {
                key: 'allocate',
                label: 'Paying now',
                render: (row) => {
                  const input = el('input', {
                    class: 'input w-28 text-right tabular-nums',
                    type: 'number',
                    min: '0',
                    max: String(row.balance),
                    step: '0.01',
                    value: allocations.has(row.id) ? String(allocations.get(row.id)) : '',
                  });
                  input.addEventListener('input', () => {
                    const value = Number(input.value || 0);
                    if (value > Number(row.balance)) {
                      input.value = String(row.balance);
                    }
                    if (Number(input.value) > 0) allocations.set(row.id, Number(input.value));
                    else allocations.delete(row.id);
                    amountInput.value = String(allocationTotal());
                    refreshNote();
                  });
                  return input;
                },
              },
            ],
            rows: data.outstanding,
          })
        : empty('Nothing outstanding for this student.')
    );
    refreshNote();
  }

  async function submit() {
    const total = allocationTotal();
    const typed = Number(amountInput.value || 0);
    if (Math.abs(total - typed) > 0.005) {
      toast('The payment amount and the allocations must match.', 'warn');
      return;
    }
    if (NEEDS_REFERENCE.has(modeSelect.value) && !referenceInput.value.trim()) {
      toast('Record the cheque, UPI or transaction reference.', 'warn');
      referenceInput.focus();
      return;
    }

    const proceed = await confirm({
      title: 'Take this payment?',
      message: `${fmt.money(total)} from ${data.student.fullName} by ${modeSelect.value}.`,
      detail: 'A receipt number is allocated immediately and cannot be reused. Corrections are made by reversal.',
      confirmLabel: 'Take payment',
    });
    if (!proceed) return;

    collectButton.disabled = true;
    try {
      const result = await guardedSave(
        () =>
          api.post('/api/fees/payments', {
            idempotencyKey,
            studentId,
            enrollmentId: data.enrollmentId,
            mode: modeSelect.value,
            amount: total,
            instrumentNo: referenceInput.value.trim() || null,
            instrumentDate: instrumentDate.value || null,
            bankName: bankInput.value.trim() || null,
            remarks: remarksInput.value.trim() || null,
            allocations: [...allocations.entries()].map(([studentChargeId, amount]) => ({
              studentChargeId,
              amount,
            })),
          }),
        {}
      );

      if (result.duplicate) {
        toast(`That payment was already recorded as receipt ${result.receiptNo}.`, 'warn', 9000);
      } else {
        toast(`Receipt ${result.receiptNo} issued.`, 'good');
      }

      // Only now is the key spent; a fresh one is minted for the next payment.
      idempotencyKey = newIdempotencyKey();
      allocations.clear();
      amountInput.value = '';
      referenceInput.value = '';
      remarksInput.value = '';

      data = await api.get(`/api/fees/students/${studentId}`);
      paintLedger();
      await showReceipt(result.receiptNo);
    } catch (err) {
      // guardedSave has already told the user; keep the same key so a retry is safe.
    } finally {
      collectButton.disabled = false;
    }
  }

  const paymentPanel = card({
    title: 'Take a payment',
    subtitle: 'Type the amount and it is spread across the oldest dues first. Adjust any line if needed.',
    body: el('div', { class: 'space-y-3' }, [
      el('div', { class: 'grid grid-cols-1 gap-3 sm:grid-cols-2' }, [
        el('div', {}, [el('label', { class: 'label', text: 'Amount received' }), amountInput]),
        el('div', {}, [el('label', { class: 'label', text: 'Mode' }), modeSelect]),
        referenceWrap,
        instrumentDateWrap,
        bankWrap,
        el('div', {}, [el('label', { class: 'label', text: 'Remarks' }), remarksInput]),
      ]),
      allocationNote,
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        collectButton,
        button('Clear', {
          onClick: () => {
            allocations.clear();
            amountInput.value = '';
            paintLedger();
          },
        }),
      ]),
      el('p', { class: 'flex items-start gap-1.5 text-xs text-ink-500' }, [
        icon('lock', 'text-sm'),
        'This payment carries a one-time safety key, so pressing the button twice cannot charge twice.',
      ]),
    ]),
  });

  paintLedger();

  container.replaceChildren(
    page({
      title: `Collect fees — ${data.student.fullName}`,
      subtitle: `${data.student.admissionNo} • ${data.className} ${data.sectionName} • Balance ${fmt.money(data.totals.balance)}`,
      wide: true,
      actions: [
        button('Student profile', { onClick: () => navigate(`/students/${studentId}`) }),
        chip(`Balance ${fmt.money(data.totals.balance)}`, data.totals.balance > 0 ? 'warn' : 'good'),
      ],
      children: el('div', { class: 'space-y-4' }, [
        readOnlyNotice(),
        can('fees.collect') ? paymentPanel : null,
        card({ title: 'Outstanding fees', body: ledgerHost }),
        card({
          title: 'Payment history',
          body: table({
            columns: [
              { key: 'receiptNo', label: 'Receipt' },
              { key: 'paidAt', label: 'Date', type: 'dateTime' },
              { key: 'mode', label: 'Mode' },
              { key: 'amount', label: 'Amount', type: 'money' },
              { key: 'status', label: 'Status', type: 'status' },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  el('div', { class: 'flex gap-1' }, [
                    button('Receipt', { size: 'sm', onClick: () => showReceipt(row.receiptNo) }),
                    can('fees.reverse') && row.status !== 'reversed'
                      ? button('Reverse', { size: 'sm', onClick: () => reverseFlow(row, () => render(container, context)) })
                      : null,
                  ]),
              },
            ],
            rows: [...data.payments, ...data.reversed],
            emptyMessage: 'No payments yet.',
          }),
        }),
      ]),
    })
  );
}

/* ---------------------------------------------------------------- receipts */

async function showReceipt(receiptNo) {
  const detail = await api.get(`/api/fees/receipts/${receiptNo}`);
  const node = receiptNode(detail, detail.isDuplicate);

  modal({
    title: `Receipt ${receiptNo}`,
    size: 'lg',
    body: el('div', { class: 'max-h-[65vh] overflow-y-auto' }, [node]),
    actions: (close) => [
      button('Close', { onClick: close }),
      button('Print', {
        variant: 'primary',
        iconName: 'print',
        onClick: async () => {
          // The print count is what makes a reprint say DUPLICATE.
          let isDuplicate = detail.isDuplicate;
          try {
            const result = await api.post(`/api/fees/receipts/${receiptNo}/print`);
            isDuplicate = result.isDuplicate;
          } catch (err) {
            toast(err.message, 'warn');
          }
          printNode(receiptNode(detail, isDuplicate), { title: `Receipt ${receiptNo}` });
        },
      }),
    ],
  });
}

export function receiptNode(detail, isDuplicate) {
  const { receipt, payment, allocations, student, school } = detail;
  return el('div', { class: 'print-page relative mx-auto max-w-2xl bg-white p-6 text-sm' }, [
    isDuplicate ? el('div', { class: 'duplicate-stamp', text: 'DUPLICATE' }) : null,
    printHeader(school, 'Fee Receipt', `Receipt No. ${receipt.receiptNo}`),
    el('div', { class: 'mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs' }, [
      pair('Student', student?.fullName),
      pair('Receipt date', fmt.dateTime(receipt.issuedAt)),
      pair('Admission No', student?.admissionNo),
      pair('Class', `${detail.className || ''} ${detail.sectionName || ''}`.trim()),
      pair('Academic year', detail.academicYear),
      pair('Mode', payment?.mode),
      payment?.instrumentNo ? pair('Reference', payment.instrumentNo) : null,
      payment?.bankName ? pair('Bank', payment.bankName) : null,
    ]),
    el('table', { class: 'w-full border-collapse text-xs' }, [
      el('thead', {}, [
        el('tr', { class: 'bg-ink-100' }, [
          el('th', { class: 'border border-ink-300 px-2 py-1 text-left', text: 'Fee head' }),
          el('th', { class: 'border border-ink-300 px-2 py-1 text-right', text: 'Amount' }),
        ]),
      ]),
      el('tbody', {}, [
        ...allocations.map((allocation) =>
          el('tr', {}, [
            el('td', { class: 'border border-ink-300 px-2 py-1', text: allocation.feeHeadName }),
            el('td', { class: 'border border-ink-300 px-2 py-1 text-right tabular-nums', text: fmt.money(allocation.amount) }),
          ])
        ),
        el('tr', { class: 'font-semibold' }, [
          el('td', { class: 'border border-ink-300 px-2 py-1 text-right', text: 'Total' }),
          el('td', { class: 'border border-ink-300 px-2 py-1 text-right tabular-nums', text: fmt.money(receipt.amount) }),
        ]),
      ]),
    ]),
    receipt.status === 'cancelled'
      ? el('p', { class: 'mt-3 rounded bg-rose-50 p-2 text-xs font-semibold text-rose-800', text: 'This receipt has been reversed and is no longer valid.' })
      : null,
    payment?.remarks ? el('p', { class: 'mt-2 text-xs text-ink-600', text: `Note: ${payment.remarks}` }) : null,
    el('div', { class: 'mt-10 flex justify-between text-xs' }, [
      el('div', { class: 'text-center' }, [
        el('div', { class: 'mb-1 h-8 border-b border-ink-400', style: { width: '10rem' } }),
        'Payer',
      ]),
      el('div', { class: 'text-center' }, [
        el('div', { class: 'mb-1 h-8 border-b border-ink-400', style: { width: '10rem' } }),
        'Cashier',
      ]),
    ]),
    detail.footer ? el('p', { class: 'mt-3 text-center text-[10px] text-ink-500', text: detail.footer } ) : null,
    printFooter(state.user?.name, new Date().toISOString()),
  ]);
}

function pair(label, value) {
  return el('div', { class: 'flex gap-2' }, [
    el('span', { class: 'w-28 flex-none text-ink-500', text: label }),
    el('span', { class: 'font-medium', text: fmt.text(value) }),
  ]);
}

/* --------------------------------------------------------------- reversals */

export async function reverseFlow(payment, reload) {
  const { askReason } = await import('../ui.js');
  const reason = await askReason({
    title: `Reverse receipt ${payment.receiptNo}`,
    label: 'Reason for the reversal',
    message:
      'The payment stays visible with a reversed status and a matching reversal record. Nothing is deleted. This needs approval unless the school has turned that off.',
    confirmLabel: 'Request reversal',
    minLength: 5,
  });
  if (reason === null) return;

  try {
    const result = await guardedSave(
      () => api.post('/api/fees/reversals', { receiptNo: payment.receiptNo, reason }),
      {}
    );
    toast(
      result.needsApproval
        ? 'Reversal requested. It takes effect once approved.'
        : 'Payment reversed.',
      'good'
    );
    if (reload) await reload();
  } catch (err) {
    // guardedSave already reported it.
  }
}
