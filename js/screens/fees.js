/**
 * Fee collection entry point: find the student, see what they owe, go and collect.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, searchBox, spinner, chip, empty, toast } from '../ui.js';
import { lookups, classSectionFilters, exportButton } from './_common.js';
import { can } from '../state.js';
import { navigate } from '../router.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  const view = {
    search: context.query?.search || '',
    classId: null,
    sectionId: null,
  };

  const listHost = el('div');
  const filterHost = el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' });

  function paintFilters() {
    filterHost.replaceChildren(
      searchBox('Search by name, admission number or guardian…', (value) => {
        view.search = value;
        load();
      }, view.search),
      ...classSectionFilters({
        classId: view.classId,
        sectionId: view.sectionId,
        onChange: ({ classId, sectionId }) => {
          view.classId = classId;
          view.sectionId = sectionId;
          paintFilters();
          load();
        },
      })
    );
  }

  async function load() {
    listHost.replaceChildren(spinner());
    try {
      const [students, dues] = await Promise.all([
        api.get('/api/students', {
          search: view.search,
          status: 'Active',
          classId: view.classId,
          sectionId: view.sectionId,
          pageSize: 100,
        }),
        can('fees.report')
          ? api.get('/api/fees/reports/dues', { classId: view.classId, sectionId: view.sectionId })
          : Promise.resolve({ rows: [], totals: { outstanding: 0, students: 0 } }),
      ]);

      const balanceByStudent = new Map(dues.rows.map((row) => [row.studentId, row.total]));

      listHost.replaceChildren(
        el('div', { class: 'space-y-4' }, [
          can('fees.report')
            ? card({
                title: 'Outstanding overall',
                actions: [exportButton('/api/fees/export/dues', { classId: view.classId, sectionId: view.sectionId }, 'Dues')],
                body: el('div', { class: 'flex flex-wrap items-center gap-4 text-sm' }, [
                  el('p', {}, [
                    el('span', { class: 'text-ink-500', text: 'Total due ' }),
                    el('span', { class: 'text-lg font-semibold tabular-nums', text: fmt.money(dues.totals.outstanding) }),
                  ]),
                  el('p', {}, [
                    el('span', { class: 'text-ink-500', text: 'Students with a balance ' }),
                    el('span', { class: 'font-semibold tabular-nums', text: fmt.number(dues.totals.students) }),
                  ]),
                ]),
              })
            : null,
          card({
            title: 'Students',
            subtitle: 'Pick a student to see their ledger and take a payment.',
            body: students.rows.length
              ? table({
                  columns: [
                    { key: 'admissionNo', label: 'Admission No', width: '9rem' },
                    { key: 'fullName', label: 'Student' },
                    {
                      key: 'balance',
                      label: 'Balance',
                      type: 'money',
                      render: (row) => {
                        const balance = balanceByStudent.get(row.id);
                        if (!balance) return el('span', { class: 'text-emerald-700', text: 'Clear' });
                        return el('span', { class: 'font-semibold text-rose-700', text: fmt.money(balance) });
                      },
                    },
                    {
                      key: 'action',
                      label: '',
                      render: (row) =>
                        can('fees.collect')
                          ? button('Collect', {
                              size: 'sm',
                              variant: 'primary',
                              onClick: () => navigate(`/fees/collect/${row.id}`),
                            })
                          : button('Ledger', { size: 'sm', onClick: () => navigate(`/students/${row.id}?tab=fees`) }),
                    },
                  ],
                  rows: students.rows,
                  onRowClick: (row) => navigate(`/students/${row.id}?tab=fees`),
                })
              : empty('No students match that search.'),
          }),
        ])
      );
    } catch (err) {
      listHost.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
      toast(err.message, 'bad');
    }
  }

  paintFilters();

  container.replaceChildren(
    page({
      title: 'Fee collection',
      subtitle: 'A wrong receipt is cancelled by a reversal, never deleted.',
      wide: true,
      actions: [
        can('fees.invoice') ? button('Generate invoices', { iconName: 'receipt_long', onClick: () => navigate('/fees/invoices') }) : null,
        can('fees.report') ? button('Reports', { iconName: 'query_stats', onClick: () => navigate('/fees/reports') }) : null,
      ],
      children: el('div', {}, [filterHost, listHost]),
    })
  );

  await load();
  void chip;
}
