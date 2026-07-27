/**
 * Payroll (T39). Deliberately basic: salary structure, attendance-based pro-rating,
 * payslip. Full statutory payroll is a product of its own and SPEC §12 flags it as
 * Phase 4 or drop — this is the useful minimum, not a claim to be more.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, confirm, printNode } from '../ui.js';
import { guardedSave, readOnlyNotice, monthFilter, printHeader, printFooter } from './_common.js';
import { can, state } from '../state.js';

export async function render(container, context = {}) {
  const view = { month: context.query?.month || fmt.thisMonth() };
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const [payslips, summary] = await Promise.all([
        api.get('/api/payroll/payslips', { month: view.month }),
        api.get('/api/staff-attendance/monthly', { month: view.month }).catch(() => null),
      ]);
      host.replaceChildren(build(payslips, summary, view, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Payroll',
      subtitle:
        'Payslips are pro-rated on payable days from staff attendance. Statutory filings are out of scope.',
      wide: true,
      children: el('div', {}, [
        readOnlyNotice(),
        el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
          monthFilter({
            value: view.month,
            onChange: (value) => {
              view.month = value;
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

function build(payslips, summary, view, reload) {
  const total = payslips.rows.reduce((sum, row) => sum + Number(row.netAmount || 0), 0);

  return el('div', { class: 'space-y-4' }, [
    card({
      title: `Payslips for ${view.month}`,
      subtitle: summary
        ? `${summary.workingDays} working day(s) recorded in staff attendance`
        : 'No staff attendance recorded for this month yet.',
      actions: [
        chip(`${payslips.rows.length} payslip(s)`, 'neutral'),
        chip(fmt.money(total), 'good'),
        payslips.rows.length
          ? button('Print all', {
              iconName: 'print',
              onClick: () =>
                printNode(
                  el('div', {}, payslips.rows.map((row) => payslipNode(row, view.month))),
                  { title: `Payslips ${view.month}` }
                ),
            })
          : null,
        can('payroll.manage')
          ? button('Generate payslips', {
              variant: 'primary',
              iconName: 'sync',
              onClick: async () => {
                const proceed = await confirm({
                  title: `Generate payslips for ${view.month}?`,
                  message:
                    'Payslips are created for every staff member with an active salary structure who does not already have one this month.',
                  detail: 'Existing payslips are left alone.',
                  confirmLabel: 'Generate',
                });
                if (!proceed) return;
                await guardedSave(() => api.post('/api/payroll/generate', { month: view.month }), {
                  successMessage: 'Payslips generated.',
                  onDone: reload,
                }).catch(() => {});
              },
            })
          : null,
      ],
      body: table({
        columns: [
          { key: 'staffCode', label: 'Code', width: '7rem' },
          { key: 'staffName', label: 'Name' },
          { key: 'daysPresent', label: 'Present', type: 'num' },
          { key: 'daysPayable', label: 'Payable', type: 'num' },
          { key: 'grossAmount', label: 'Gross', type: 'money' },
          { key: 'deductions', label: 'Deductions', type: 'money' },
          { key: 'netAmount', label: 'Net', type: 'money' },
          { key: 'status', label: 'Status', type: 'status', width: '8rem' },
          {
            key: 'actions',
            label: '',
            render: (row) =>
              button('Payslip', {
                size: 'sm',
                onClick: () => printNode(payslipNode(row, view.month), { title: `Payslip ${row.staffCode}` }),
              }),
          },
        ],
        rows: payslips.rows,
        emptyMessage: can('payroll.manage')
          ? 'No payslips for this month yet. Set salary structures on each staff record, then generate.'
          : 'No payslips for this month.',
      }),
    }),
  ]);
}

function payslipNode(row, month) {
  return el('div', { class: 'print-page mx-auto max-w-2xl bg-white p-6 text-xs' }, [
    printHeader(state.school, 'Salary Slip', `For ${month}`),
    el('div', { class: 'mb-3 grid grid-cols-2 gap-x-6 gap-y-1' }, [
      pair('Staff', row.staffName),
      pair('Code', row.staffCode),
      pair('Month', month),
      pair('Days payable', `${row.daysPayable} of ${row.daysPresent + (row.daysPayable - row.daysPresent)}`),
    ]),
    el('table', { class: 'w-full border-collapse' }, [
      el('tbody', {}, [
        moneyRow('Gross earnings (pro-rated)', row.grossAmount),
        moneyRow('Total deductions', row.deductions),
        el('tr', { class: 'font-semibold' }, [
          el('td', { class: 'border border-ink-400 px-2 py-1', text: 'Net payable' }),
          el('td', { class: 'border border-ink-400 px-2 py-1 text-right tabular-nums', text: fmt.money(row.netAmount) }),
        ]),
      ]),
    ]),
    el('p', {
      class: 'mt-3 text-[10px] text-ink-500',
      text: 'This slip is computer-generated from the salary structure on record and attendance for the month.',
    }),
    el('div', { class: 'mt-10 flex justify-between' }, [
      signature('Employee'),
      signature('Accounts'),
      signature(state.school?.principalName || 'Principal'),
    ]),
    printFooter(state.user?.name, row.generatedAt),
  ]);
}

function moneyRow(label, value) {
  return el('tr', {}, [
    el('td', { class: 'border border-ink-400 px-2 py-1', text: label }),
    el('td', { class: 'border border-ink-400 px-2 py-1 text-right tabular-nums', text: fmt.money(value) }),
  ]);
}

function pair(label, value) {
  return el('div', { class: 'flex gap-1' }, [
    el('span', { class: 'text-ink-500', text: `${label}:` }),
    el('span', { class: 'font-medium', text: fmt.text(value) }),
  ]);
}

function signature(label) {
  return el('div', { class: 'text-center' }, [
    el('div', { class: 'mb-1 h-8 border-b border-ink-400', style: { width: '8rem' } }),
    el('span', { class: 'text-[10px]', text: label }),
  ]);
}
