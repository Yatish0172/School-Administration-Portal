/**
 * Staff attendance (SPEC §9): daily in and out, leave types, and the monthly
 * summary that feeds payroll.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, tabs, toast } from '../ui.js';
import { guardedSave, readOnlyNotice, dateFilter, monthFilter } from './_common.js';
import { can } from '../state.js';

export async function render(container, context = {}) {
  let activeTab = context.query?.tab || 'daily';
  const view = { date: fmt.today(), month: fmt.thisMonth() };
  const host = el('div');

  function paint() {
    host.replaceChildren(
      tabs(
        [
          { key: 'daily', label: 'Mark today' },
          { key: 'monthly', label: 'Monthly summary' },
        ],
        activeTab,
        (key) => {
          activeTab = key;
          paint();
        }
      ),
      el('div', { id: 'sa-body' })
    );
    const body = host.querySelector('#sa-body');
    if (activeTab === 'daily') daily(body, view, paint);
    else monthly(body, view, paint);
  }

  container.replaceChildren(
    page({
      title: 'Staff attendance',
      subtitle: 'The monthly summary is what payroll pro-rates against.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  paint();
}

async function daily(host, view, repaint) {
  host.replaceChildren(
    el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
      dateFilter({
        value: view.date,
        onChange: (value) => {
          view.date = value;
          repaint();
        },
      }),
    ]),
    spinner()
  );

  try {
    const data = await api.get('/api/staff-attendance/roster', { date: view.date });
    const rows = data.rows.map((row) => ({ ...row, status: row.status || 'Present' }));
    let dirty = false;

    const summaryNode = el('div', { class: 'flex flex-wrap gap-2' });

    function refreshSummary() {
      const counts = {};
      for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
      summaryNode.replaceChildren(
        ...Object.entries(counts).map(([status, count]) =>
          chip(`${status}: ${count}`, status === 'Present' ? 'good' : status === 'Absent' ? 'bad' : 'warn')
        )
      );
    }

    refreshSummary();

    const tableNode = table({
      columns: [
        { key: 'staffCode', label: 'Code', width: '7rem' },
        { key: 'name', label: 'Name' },
        { key: 'designation', label: 'Designation' },
        {
          key: 'status',
          label: 'Status',
          width: '11rem',
          render: (row) => {
            const select = el(
              'select',
              { class: 'input', disabled: !can('staffattendance.mark') },
              data.statuses.map((status) =>
                el('option', { value: status, text: status, selected: row.status === status })
              )
            );
            select.addEventListener('change', () => {
              row.status = select.value;
              dirty = true;
              refreshSummary();
            });
            return select;
          },
        },
        {
          key: 'leaveType',
          label: 'Leave type',
          width: '8rem',
          render: (row) => {
            const select = el(
              'select',
              { class: 'input', disabled: !can('staffattendance.mark') },
              [
                el('option', { value: '', text: '—' }),
                ...data.leaveTypes.map((type) =>
                  el('option', { value: type, text: type, selected: row.leaveType === type })
                ),
              ]
            );
            select.addEventListener('change', () => {
              row.leaveType = select.value || null;
              dirty = true;
            });
            return select;
          },
        },
        { key: 'inTime', label: 'In', width: '7rem', render: (row) => timeInput(row, 'inTime', () => (dirty = true)) },
        { key: 'outTime', label: 'Out', width: '7rem', render: (row) => timeInput(row, 'outTime', () => (dirty = true)) },
        {
          key: 'remarks',
          label: 'Remarks',
          render: (row) => {
            const input = el('input', {
              class: 'input',
              value: row.remarks ?? '',
              disabled: !can('staffattendance.mark'),
            });
            input.addEventListener('input', () => {
              row.remarks = input.value || null;
              dirty = true;
            });
            return input;
          },
        },
      ],
      rows,
      emptyMessage: 'No active staff records.',
    });

    host.lastChild.replaceWith(
      card({
        title: `Staff on ${fmt.date(view.date)}`,
        actions: can('staffattendance.mark')
          ? [
              button('Mark all present', {
                onClick: () => {
                  rows.forEach((row) => {
                    row.status = 'Present';
                  });
                  dirty = true;
                  repaint();
                },
              }),
              button('Save', {
                variant: 'primary',
                iconName: 'save',
                onClick: async () => {
                  if (!dirty && data.rows.some((row) => row.status)) {
                    toast('Nothing has changed.', 'info', 3000);
                  }
                  await guardedSave(
                    () =>
                      api.post('/api/staff-attendance/mark', {
                        date: view.date,
                        entries: rows.map(({ staffId, status, inTime, outTime, leaveType, remarks }) => ({
                          staffId,
                          status,
                          inTime,
                          outTime,
                          leaveType,
                          remarks,
                        })),
                      }),
                    { successMessage: 'Staff attendance saved.', onDone: repaint }
                  ).catch(() => {});
                },
              }),
            ]
          : null,
        body: el('div', { class: 'space-y-3' }, [summaryNode, tableNode]),
      })
    );
  } catch (err) {
    host.lastChild.replaceWith(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

function timeInput(row, key, onChange) {
  const input = el('input', {
    class: 'input',
    type: 'time',
    value: row[key] ?? '',
    disabled: !can('staffattendance.mark'),
  });
  input.addEventListener('input', () => {
    row[key] = input.value || null;
    onChange();
  });
  return input;
}

async function monthly(host, view, repaint) {
  host.replaceChildren(
    el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
      monthFilter({
        value: view.month,
        onChange: (value) => {
          view.month = value;
          repaint();
        },
      }),
    ]),
    spinner()
  );

  try {
    const data = await api.get('/api/staff-attendance/monthly', { month: view.month });
    host.lastChild.replaceWith(
      card({
        title: `${view.month} — ${data.workingDays} working day(s) recorded`,
        subtitle: 'Payable days are present days plus approved leave. Payroll pro-rates on this.',
        body: table({
          columns: [
            { key: 'staffCode', label: 'Code', width: '7rem' },
            { key: 'name', label: 'Name' },
            { key: 'present', label: 'Present', type: 'num' },
            { key: 'absent', label: 'Absent', type: 'num' },
            { key: 'late', label: 'Late', type: 'num' },
            { key: 'halfDay', label: 'Half day', type: 'num' },
            { key: 'leave', label: 'Leave', type: 'num' },
            { key: 'payableDays', label: 'Payable', type: 'num' },
            {
              key: 'percent',
              label: 'Percent',
              render: (row) =>
                row.percent === null
                  ? '—'
                  : chip(fmt.percent(row.percent), row.percent >= 90 ? 'good' : row.percent >= 75 ? 'warn' : 'bad'),
            },
          ],
          rows: data.rows,
          emptyMessage: 'No staff attendance recorded this month.',
        }),
      })
    );
  } catch (err) {
    host.lastChild.replaceWith(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}
