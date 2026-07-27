/**
 * Fee reports (SPEC §11, T34): day book, collection summary, dues with ageing, and
 * the reconciliation check.
 *
 * The reconciliation tab is the one to look at first if a total ever looks wrong —
 * it proves payments, allocations, fee lines and invoices all agree.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, tabs, chip, totalsRow, icon, printNode, empty } from '../ui.js';
import { lookups, classSectionFilters, dateFilter, dateRangeFilters, exportButton, printHeader, printFooter } from './_common.js';
import { state } from '../state.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  let activeTab = context.query?.tab || 'daybook';
  const host = el('div');

  const view = {
    date: fmt.today(),
    from: fmt.thisMonth() + '-01',
    to: fmt.today(),
    classId: null,
    sectionId: null,
  };

  function paint() {
    host.replaceChildren(
      tabs(
        [
          { key: 'daybook', label: 'Day book' },
          { key: 'collection', label: 'Collection summary' },
          { key: 'dues', label: 'Dues and ageing' },
          { key: 'reconciliation', label: 'Reconciliation' },
        ],
        activeTab,
        (key) => {
          activeTab = key;
          paint();
        }
      ),
      el('div', { id: 'fee-report-body' })
    );
    const body = host.querySelector('#fee-report-body');
    if (activeTab === 'daybook') dayBook(body, view, paint);
    if (activeTab === 'collection') collection(body, view, paint);
    if (activeTab === 'dues') dues(body, view, paint);
    if (activeTab === 'reconciliation') reconciliation(body);
  }

  container.replaceChildren(
    page({
      title: 'Fee reports',
      subtitle: 'Every export is stamped with your name and the time it was generated.',
      wide: true,
      children: host,
    })
  );

  paint();
}

/* ---------------------------------------------------------------- day book */

async function dayBook(host, view, repaint) {
  host.replaceChildren(
    el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
      dateFilter({
        value: view.date,
        onChange: (value) => {
          view.date = value;
          repaint();
        },
      }),
      exportButton('/api/fees/export/day-book', { date: view.date }, 'Export day book'),
    ]),
    spinner()
  );

  try {
    const data = await api.get('/api/fees/reports/day-book', { date: view.date });
    const columns = [
      { key: 'receiptNo', label: 'Receipt', width: '9rem' },
      { key: 'paidAt', label: 'Time', render: (row) => fmt.time(row.paidAt) },
      { key: 'studentName', label: 'Student' },
      { key: 'admissionNo', label: 'Admission No' },
      { key: 'mode', label: 'Mode', render: (row) => fmt.humanise(row.mode) },
      { key: 'instrumentNo', label: 'Reference' },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'status', label: 'Status', type: 'status', width: '7rem' },
      { key: 'collectedBy', label: 'By' },
    ];

    const body = host.lastChild;
    body.replaceWith(
      el('div', { class: 'space-y-4' }, [
        card({
          title: `Day book — ${fmt.date(view.date)}`,
          subtitle: 'What should be in the cash box at the end of the day.',
          actions: [
            chip(`${data.totals.count} receipts`, 'neutral'),
            chip(fmt.money(data.totals.collected), 'good'),
            data.totals.reversed ? chip(`${fmt.money(data.totals.reversed)} reversed`, 'bad') : null,
            button('Print', {
              iconName: 'print',
              onClick: () => printDayBook(data),
            }),
          ],
          body: table({
            columns,
            rows: data.rows,
            footer: data.rows.length ? totalsRow(columns, { amount: data.totals.collected }, 'Collected') : null,
            emptyMessage: 'No payments taken on this date.',
          }),
        }),
        card({
          title: 'By payment mode',
          body: table({
            columns: [
              { key: 'mode', label: 'Mode', render: (row) => fmt.humanise(row.mode) },
              { key: 'amount', label: 'Amount', type: 'money' },
            ],
            rows: Object.entries(data.totals.byMode)
              .filter(([, amount]) => amount > 0)
              .map(([mode, amount]) => ({ mode, amount })),
            emptyMessage: 'Nothing collected.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.lastChild.replaceWith(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

function printDayBook(data) {
  printNode(
    el('div', { class: 'print-page bg-white p-6 text-xs' }, [
      printHeader(state.school, 'Fee Day Book', fmt.date(data.date)),
      el('table', { class: 'w-full border-collapse' }, [
        el('thead', {}, [
          el('tr', { class: 'bg-ink-100' }, [
            ...['Receipt', 'Time', 'Student', 'Mode', 'Reference', 'Amount', 'Status'].map((label) =>
              el('th', { class: 'border border-ink-300 px-1.5 py-1 text-left', text: label })
            ),
          ]),
        ]),
        el(
          'tbody',
          {},
          data.rows.map((row) =>
            el('tr', {}, [
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: row.receiptNo }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: fmt.time(row.paidAt) }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: row.studentName }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: row.mode }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: fmt.text(row.instrumentNo, '') }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5 text-right tabular-nums', text: fmt.money(row.amount) }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: row.status }),
            ])
          )
        ),
        el('tfoot', {}, [
          el('tr', { class: 'font-semibold' }, [
            el('td', { class: 'border border-ink-300 px-1.5 py-1 text-right', colSpan: 5, text: 'Total collected' }),
            el('td', { class: 'border border-ink-300 px-1.5 py-1 text-right tabular-nums', text: fmt.money(data.totals.collected) }),
            el('td', { class: 'border border-ink-300' }),
          ]),
        ]),
      ]),
      el('div', { class: 'mt-8 flex justify-between' }, [
        el('div', { class: 'text-center' }, [
          el('div', { class: 'mb-1 h-8 border-b border-ink-400', style: { width: '10rem' } }),
          'Cashier',
        ]),
        el('div', { class: 'text-center' }, [
          el('div', { class: 'mb-1 h-8 border-b border-ink-400', style: { width: '10rem' } }),
          'Verified by',
        ]),
      ]),
      printFooter(state.user?.name, new Date().toISOString()),
    ]),
    { title: `Day book ${data.date}` }
  );
}

/* -------------------------------------------------------------- collection */

async function collection(host, view, repaint) {
  host.replaceChildren(
    el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
      ...dateRangeFilters({
        from: view.from,
        to: view.to,
        onChange: ({ from, to }) => {
          view.from = from;
          view.to = to;
          repaint();
        },
      }),
      exportButton('/api/fees/export/collection', { from: view.from, to: view.to }, 'Export summary'),
    ]),
    spinner()
  );

  try {
    const data = await api.get('/api/fees/reports/collection', { from: view.from, to: view.to });
    host.lastChild.replaceWith(
      el('div', { class: 'space-y-4' }, [
        card({
          title: `Collected ${fmt.money(data.total)}`,
          subtitle: `${fmt.date(data.from)} to ${fmt.date(data.to)} across ${fmt.number(data.count)} receipts`,
          body: el('div', { class: 'grid grid-cols-1 gap-4 lg:grid-cols-2' }, [
            table({
              columns: [
                { key: 'feeHeadName', label: 'Fee head' },
                { key: 'amount', label: 'Collected', type: 'money' },
              ],
              rows: data.byHead,
              emptyMessage: 'Nothing collected in this period.',
            }),
            table({
              columns: [
                { key: 'mode', label: 'Mode', render: (row) => fmt.humanise(row.mode) },
                { key: 'amount', label: 'Collected', type: 'money' },
              ],
              rows: data.byMode,
              emptyMessage: '',
            }),
          ]),
        }),
        card({
          title: 'Day by day',
          body: table({
            dense: true,
            columns: [
              { key: 'date', label: 'Date', type: 'date' },
              { key: 'amount', label: 'Collected', type: 'money' },
            ],
            rows: data.byDate,
            emptyMessage: '',
          }),
        }),
      ])
    );
  } catch (err) {
    host.lastChild.replaceWith(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

/* -------------------------------------------------------------------- dues */

async function dues(host, view, repaint) {
  host.replaceChildren(
    el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
      ...classSectionFilters({
        classId: view.classId,
        sectionId: view.sectionId,
        onChange: ({ classId, sectionId }) => {
          view.classId = classId;
          view.sectionId = sectionId;
          repaint();
        },
      }),
      exportButton('/api/fees/export/dues', { classId: view.classId, sectionId: view.sectionId }, 'Export dues'),
    ]),
    spinner()
  );

  try {
    const data = await api.get('/api/fees/reports/dues', {
      classId: view.classId,
      sectionId: view.sectionId,
    });
    const columns = [
      { key: 'admissionNo', label: 'Admission No', width: '9rem' },
      { key: 'name', label: 'Student' },
      { key: 'className', label: 'Class', width: '7rem' },
      { key: 'sectionName', label: 'Section', width: '6rem' },
      { key: 'current', label: 'Not due', type: 'money' },
      { key: '1-30', label: '1–30 d', type: 'money' },
      { key: '31-60', label: '31–60 d', type: 'money' },
      { key: '61-90', label: '61–90 d', type: 'money' },
      { key: '90+', label: '90+ d', type: 'money' },
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'guardianPhone', label: 'Phone', width: '8rem' },
    ];

    host.lastChild.replaceWith(
      el('div', { class: 'space-y-4' }, [
        card({
          title: `Outstanding ${fmt.money(data.totals.outstanding)}`,
          subtitle: `${fmt.number(data.totals.students)} students with a balance as at ${fmt.date(data.asOf)}`,
          body: el('div', { class: 'flex flex-wrap gap-2' }, [
            ...data.totals.byBucket.map((bucket) =>
              chip(
                `${bucket.bucket === 'current' ? 'Not yet due' : `${bucket.bucket} days`}: ${fmt.money(bucket.amount)}`,
                bucket.bucket === 'current' ? 'neutral' : bucket.bucket === '90+' ? 'bad' : 'warn'
              )
            ),
          ]),
        }),
        card({
          title: 'By student',
          body: table({
            columns,
            rows: data.rows,
            footer: data.rows.length ? totalsRow(columns, { total: data.totals.outstanding }) : null,
            emptyMessage: 'Nothing outstanding.',
          }),
        }),
        card({
          title: 'By fee head',
          body: table({
            columns: [
              { key: 'feeHeadName', label: 'Fee head' },
              { key: 'amount', label: 'Outstanding', type: 'money' },
            ],
            rows: data.totals.byHead,
            emptyMessage: '',
          }),
        }),
      ])
    );
  } catch (err) {
    host.lastChild.replaceWith(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

/* --------------------------------------------------------- reconciliation */

async function reconciliation(host) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/fees/reports/reconciliation');
    host.replaceChildren(
      card({
        title: data.ok ? 'The ledger balances' : 'The ledger does not balance',
        subtitle:
          'Each check compares two independent totals. If one fails, something wrote outside the normal path and needs investigating before more money is taken.',
        actions: [chip(data.ok ? 'All checks passed' : 'Attention needed', data.ok ? 'good' : 'bad')],
        body: el('div', { class: 'space-y-3' }, [
          el(
            'ul',
            { class: 'space-y-2' },
            data.checks.map((check) =>
              el('li', { class: `flex items-start gap-2 rounded-lg p-3 ${check.ok ? 'bg-emerald-50' : 'bg-rose-50'}` }, [
                icon(check.ok ? 'check_circle' : 'error', check.ok ? 'text-emerald-600' : 'text-rose-600'),
                el('div', { class: 'flex-1' }, [
                  el('p', { class: 'text-sm font-medium', text: check.name }),
                  el('p', {
                    class: 'text-xs text-ink-600',
                    text: `${fmt.money(check.expected)} versus ${fmt.money(check.actual)}`,
                  }),
                ]),
              ])
            )
          ),
          el('div', { class: 'rounded-lg bg-ink-50 p-3 text-sm' }, [
            el('p', { class: 'mb-1 font-medium', text: 'Totals' }),
            row('Active payments', fmt.money(data.totals.paymentTotal)),
            row('Allocated to fees', fmt.money(data.totals.allocatedTotal)),
            row('Fee lines marked paid', fmt.money(data.totals.chargePaidTotal)),
            row('Invoices marked paid', fmt.money(data.totals.invoicePaidTotal)),
          ]),
        ]),
      })
    );
  } catch (err) {
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
  void empty;
}

function row(label, value) {
  return el('div', { class: 'flex justify-between gap-3' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('span', { class: 'font-medium tabular-nums', text: value }),
  ]);
}
