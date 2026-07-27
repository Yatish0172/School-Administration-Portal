/**
 * Attendance reports (SPEC §9, T19): daily register, absent list for parent calls,
 * monthly percentage, defaulters and class comparison.
 */

import { api } from '../api.js';
import { el, page, card, table, fmt, spinner, tabs, chip, totalsRow, printNode, filterInput, button } from '../ui.js';
import { lookups, mySectionOptions, dateFilter, monthFilter, dateRangeFilters, exportButton, printHeader, printFooter, sectionLabel } from './_common.js';
import { state } from '../state.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  let activeTab = context.query?.tab || 'register';
  const view = {
    date: fmt.today(),
    month: fmt.thisMonth(),
    sectionId: mySectionOptions()[0]?.value || null,
    from: `${fmt.thisMonth()}-01`,
    to: fmt.today(),
    threshold: null,
  };

  const host = el('div');

  function paint() {
    host.replaceChildren(
      tabs(
        [
          { key: 'register', label: 'Daily register' },
          { key: 'absent', label: 'Absent list' },
          { key: 'monthly', label: 'Monthly percentage' },
          { key: 'defaulters', label: 'Defaulters' },
          { key: 'comparison', label: 'Class comparison' },
        ],
        activeTab,
        (key) => {
          activeTab = key;
          paint();
        }
      ),
      el('div', { id: 'att-report-body' })
    );
    const body = host.querySelector('#att-report-body');
    if (activeTab === 'register') register(body, view, paint);
    if (activeTab === 'absent') absent(body, view, paint);
    if (activeTab === 'monthly') monthly(body, view, paint);
    if (activeTab === 'defaulters') defaulters(body, view, paint);
    if (activeTab === 'comparison') comparison(body, view, paint);
  }

  container.replaceChildren(
    page({
      title: 'Attendance reports',
      subtitle: 'Every export carries the name of whoever generated it and when.',
      wide: true,
      children: host,
    })
  );

  paint();
}

async function register(host, view, repaint) {
  host.replaceChildren(
    filters([
      dateFilter({ value: view.date, onChange: (value) => { view.date = value; repaint(); } }),
      exportButton('/api/attendance/export/register', { date: view.date }),
    ]),
    spinner()
  );
  try {
    const data = await api.get('/api/attendance/reports/register', { date: view.date });
    const columns = [
      { key: 'className', label: 'Class' },
      { key: 'sectionName', label: 'Section' },
      { key: 'strength', label: 'Strength', type: 'num' },
      { key: 'Present', label: 'Present', type: 'num' },
      { key: 'Absent', label: 'Absent', type: 'num' },
      { key: 'Late', label: 'Late', type: 'num' },
      { key: 'Half Day', label: 'Half day', type: 'num' },
      { key: 'Leave', label: 'Leave', type: 'num' },
      { key: 'percent', label: 'Percent', type: 'percent' },
      {
        key: 'marked',
        label: 'Marked',
        render: (row) =>
          row.marked ? chip(fmt.ago(row.markedAt), 'good') : chip('Not marked', 'bad'),
      },
    ];
    const unmarked = data.rows.filter((row) => !row.marked && row.strength > 0);

    host.lastChild.replaceWith(
      el('div', { class: 'space-y-4' }, [
        unmarked.length
          ? el('div', { class: 'banner-warn rounded-lg' }, [
              el('span', {
                text: `${unmarked.length} section(s) with students have not been marked: ${unmarked
                  .map((row) => `${row.className} ${row.sectionName}`)
                  .join(', ')}`,
              }),
            ])
          : null,
        card({
          title: `Register — ${fmt.date(data.date)}`,
          actions: [
            button('Print', {
              iconName: 'print',
              onClick: () => printTable('Daily Attendance Register', fmt.date(data.date), columns, data.rows),
            }),
          ],
          body: table({
            columns,
            rows: data.rows,
            footer: data.rows.length
              ? totalsRow(columns, {
                  strength: sum(data.rows, 'strength'),
                  Present: sum(data.rows, 'Present'),
                  Absent: sum(data.rows, 'Absent'),
                  Late: sum(data.rows, 'Late'),
                })
              : null,
            emptyMessage: 'No sections set up yet.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.lastChild.replaceWith(errorCard(err));
  }
}

async function absent(host, view, repaint) {
  host.replaceChildren(
    filters([
      dateFilter({ value: view.date, onChange: (value) => { view.date = value; repaint(); } }),
      exportButton('/api/attendance/export/absent', { date: view.date }),
    ]),
    spinner()
  );
  try {
    const data = await api.get('/api/attendance/reports/absent', { date: view.date });
    const columns = [
      { key: 'admissionNo', label: 'Admission No', width: '9rem' },
      { key: 'name', label: 'Student' },
      { key: 'className', label: 'Class', width: '7rem' },
      { key: 'sectionName', label: 'Section', width: '6rem' },
      { key: 'status', label: 'Status', type: 'status', width: '7rem' },
      { key: 'reason', label: 'Reason' },
      { key: 'guardianName', label: 'Guardian' },
      { key: 'guardianPhone', label: 'Phone', width: '9rem' },
    ];
    host.lastChild.replaceWith(
      card({
        title: `${data.rows.length} away on ${fmt.date(data.date)}`,
        subtitle: 'The office calls down this list. Phone numbers come from the primary guardian.',
        actions: [
          button('Print call list', {
            iconName: 'print',
            onClick: () => printTable('Absent List', fmt.date(data.date), columns, data.rows),
          }),
        ],
        body: table({ columns, rows: data.rows, emptyMessage: 'Everyone marked is present.' }),
      })
    );
  } catch (err) {
    host.lastChild.replaceWith(errorCard(err));
  }
}

async function monthly(host, view, repaint) {
  host.replaceChildren(
    filters([
      monthFilter({ value: view.month, onChange: (value) => { view.month = value; repaint(); } }),
      sectionPicker(view, repaint),
      exportButton('/api/attendance/export/monthly', { month: view.month, sectionId: view.sectionId }),
    ]),
    spinner()
  );
  if (!view.sectionId) {
    host.lastChild.replaceWith(errorCard({ message: 'Choose a section.' }));
    return;
  }
  try {
    const data = await api.get('/api/attendance/reports/monthly', {
      month: view.month,
      sectionId: view.sectionId,
    });
    const columns = [
      { key: 'rollNo', label: 'Roll', width: '5rem' },
      { key: 'admissionNo', label: 'Admission No', width: '9rem' },
      { key: 'name', label: 'Student' },
      { key: 'workingDays', label: 'Days', type: 'num' },
      { key: 'Present', label: 'Present', type: 'num' },
      { key: 'Absent', label: 'Absent', type: 'num' },
      { key: 'Late', label: 'Late', type: 'num' },
      { key: 'Leave', label: 'Leave', type: 'num' },
      {
        key: 'percent',
        label: 'Percent',
        render: (row) =>
          row.percent === null
            ? '—'
            : chip(fmt.percent(row.percent), row.percent >= 90 ? 'good' : row.percent >= 75 ? 'warn' : 'bad'),
      },
    ];
    host.lastChild.replaceWith(
      card({
        title: `${sectionLabel(view.sectionId)} — ${view.month}`,
        subtitle: `${data.workingDays.length} day(s) with attendance recorded`,
        actions: [
          button('Print', {
            iconName: 'print',
            onClick: () =>
              printTable(
                'Monthly Attendance',
                `${sectionLabel(view.sectionId)} — ${view.month}`,
                columns,
                data.rows
              ),
          }),
        ],
        body: table({ columns, rows: data.rows, emptyMessage: 'No attendance recorded this month.' }),
      })
    );
  } catch (err) {
    host.lastChild.replaceWith(errorCard(err));
  }
}

async function defaulters(host, view, repaint) {
  host.replaceChildren(
    filters([
      ...dateRangeFilters({
        from: view.from,
        to: view.to,
        onChange: ({ from, to }) => {
          view.from = from;
          view.to = to;
          repaint();
        },
      }),
      filterInput({
        label: 'Below %',
        type: 'number',
        value: view.threshold,
        width: '7rem',
        onChange: (value) => {
          view.threshold = value;
          repaint();
        },
      }),
      exportButton('/api/attendance/export/defaulters', {
        from: view.from,
        to: view.to,
        threshold: view.threshold,
      }),
    ]),
    spinner()
  );
  try {
    const data = await api.get('/api/attendance/reports/defaulters', {
      from: view.from,
      to: view.to,
      threshold: view.threshold,
    });
    const columns = [
      { key: 'admissionNo', label: 'Admission No', width: '9rem' },
      { key: 'name', label: 'Student' },
      { key: 'className', label: 'Class', width: '7rem' },
      { key: 'sectionName', label: 'Section', width: '6rem' },
      { key: 'workingDays', label: 'Days', type: 'num' },
      { key: 'present', label: 'Present', type: 'num' },
      { key: 'percent', label: 'Percent', type: 'percent' },
      { key: 'guardianName', label: 'Guardian' },
      { key: 'guardianPhone', label: 'Phone', width: '9rem' },
    ];
    host.lastChild.replaceWith(
      card({
        title: `${data.rows.length} below ${data.threshold}%`,
        subtitle: `${fmt.date(data.from)} to ${fmt.date(data.to)}`,
        actions: [
          button('Print', {
            iconName: 'print',
            onClick: () =>
              printTable('Attendance Defaulters', `Below ${data.threshold}%`, columns, data.rows),
          }),
        ],
        body: table({ columns, rows: data.rows, emptyMessage: 'Nobody is below the threshold.' }),
      })
    );
  } catch (err) {
    host.lastChild.replaceWith(errorCard(err));
  }
}

async function comparison(host, view, repaint) {
  host.replaceChildren(
    filters([
      ...dateRangeFilters({
        from: view.from,
        to: view.to,
        onChange: ({ from, to }) => {
          view.from = from;
          view.to = to;
          repaint();
        },
      }),
    ]),
    spinner()
  );
  try {
    const data = await api.get('/api/attendance/reports/comparison', { from: view.from, to: view.to });
    host.lastChild.replaceWith(
      card({
        title: 'Class comparison',
        subtitle: `${fmt.date(view.from)} to ${fmt.date(view.to)}`,
        body: table({
          columns: [
            { key: 'className', label: 'Class' },
            { key: 'records', label: 'Records', type: 'num' },
            { key: 'Present', label: 'Present', type: 'num' },
            { key: 'Absent', label: 'Absent', type: 'num' },
            {
              key: 'percent',
              label: 'Percent',
              render: (row) =>
                chip(fmt.percent(row.percent), row.percent >= 90 ? 'good' : row.percent >= 75 ? 'warn' : 'bad'),
            },
          ],
          rows: data.rows,
          emptyMessage: 'No attendance in this period.',
        }),
      })
    );
  } catch (err) {
    host.lastChild.replaceWith(errorCard(err));
  }
}

/* ----------------------------------------------------------------- helpers */

function filters(children) {
  return el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, children);
}

function sectionPicker(view, repaint) {
  const { filterSelect } = { filterSelect: null };
  void filterSelect;
  const select = el('select', {
    class: 'input',
    style: { width: '12rem' },
    on: {
      change: (event) => {
        view.sectionId = event.target.value || null;
        repaint();
      },
    },
  });
  select.appendChild(el('option', { value: '', text: 'Choose a section' }));
  for (const option of mySectionOptions()) {
    select.appendChild(el('option', { value: option.value, text: option.label }));
  }
  select.value = view.sectionId ?? '';
  return el('div', {}, [el('label', { class: 'label', text: 'Section' }), select]);
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function errorCard(err) {
  return el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message });
}

function printTable(title, subtitle, columns, rows) {
  const printable = columns.filter((column) => column.key !== 'actions');
  printNode(
    el('div', { class: 'print-page bg-white p-6 text-xs' }, [
      printHeader(state.school, title, subtitle),
      el('table', { class: 'w-full border-collapse' }, [
        el('thead', {}, [
          el(
            'tr',
            { class: 'bg-ink-100' },
            printable.map((column) =>
              el('th', { class: 'border border-ink-300 px-1.5 py-1 text-left', text: column.label })
            )
          ),
        ]),
        el(
          'tbody',
          {},
          rows.map((row) =>
            el(
              'tr',
              {},
              printable.map((column) =>
                el('td', {
                  class: 'border border-ink-300 px-1.5 py-0.5',
                  text: printableValue(row, column),
                })
              )
            )
          )
        ),
      ]),
      printFooter(state.user?.name, new Date().toISOString()),
    ]),
    { title }
  );
}

function printableValue(row, column) {
  const value = row[column.key];
  if (column.type === 'percent') return value === null || value === undefined ? '' : `${value}%`;
  if (column.type === 'money') return fmt.money(value);
  if (column.type === 'date') return value ? fmt.date(value) : '';
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
