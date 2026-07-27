/**
 * Student list (SPEC §6). Paginated search by name, admission number, class,
 * section, phone or guardian name.
 *
 * Library and Transport roles get a trimmed payload from the server (name and
 * class only), so this screen renders whichever shape it is handed.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, statusChip, pager, searchBox, filterSelect, spinner, chip } from '../ui.js';
import { lookups, classSectionFilters, exportButton, invalidateLookups } from './_common.js';
import { can } from '../state.js';
import { navigate } from '../router.js';

const STATUSES = ['Active', 'TC Issued', 'Left', 'Alumni'];

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  const view = {
    search: context.query?.search || '',
    status: context.query?.status || 'Active',
    classId: context.query?.classId || null,
    sectionId: context.query?.sectionId || null,
    page: 1,
    pageSize: 50,
  };

  const listHost = el('div');
  const filterHost = el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' });

  function paintFilters() {
    filterHost.replaceChildren(
      searchBox('Search name, admission number, phone or guardian…', (value) => {
        view.search = value;
        view.page = 1;
        load();
      }, view.search),
      ...classSectionFilters({
        classId: view.classId,
        sectionId: view.sectionId,
        onChange: ({ classId, sectionId }) => {
          view.classId = classId;
          view.sectionId = sectionId;
          view.page = 1;
          paintFilters();
          load();
        },
      }),
      filterSelect({
        label: 'Status',
        options: STATUSES,
        value: view.status,
        placeholder: 'All statuses',
        onChange: (value) => {
          view.status = value;
          view.page = 1;
          load();
        },
      })
    );
  }

  async function load() {
    listHost.replaceChildren(spinner());
    try {
      const data = await api.get('/api/students', {
        search: view.search,
        status: view.status,
        classId: view.classId,
        sectionId: view.sectionId,
        page: view.page,
        pageSize: view.pageSize,
      });
      listHost.replaceChildren(listCard(data, view, load));
    } catch (err) {
      listHost.replaceChildren(
        el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message })
      );
    }
  }

  paintFilters();

  container.replaceChildren(
    page({
      title: 'Students',
      subtitle: 'Nothing is ever deleted here — a student who leaves gets a status change.',
      wide: true,
      actions: [
        can('student.import')
          ? button('Import from Excel', { iconName: 'upload_file', onClick: () => navigate('/students/import') })
          : null,
        can('student.promote')
          ? button('Promote year', { iconName: 'trending_up', onClick: () => navigate('/students/promote') })
          : null,
        can('report.export')
          ? exportButton('/api/students/export/list', {
              status: view.status,
              classId: view.classId,
              sectionId: view.sectionId,
              search: view.search,
            })
          : null,
        can('student.create')
          ? button('New admission', {
              variant: 'primary',
              iconName: 'person_add',
              onClick: () => navigate('/students/new'),
            })
          : null,
      ],
      children: el('div', {}, [filterHost, listHost]),
    })
  );

  await load();
  invalidateLookupsIfStale();
}

function listCard(data, view, reload) {
  const lookupOnly = data.view === 'lookup';

  const columns = [
    { key: 'admissionNo', label: 'Admission No', width: '9rem' },
    {
      key: 'name',
      label: 'Student',
      render: (row) =>
        el('div', {}, [
          el('p', { class: 'font-medium text-ink-900', text: fullName(row) }),
          !lookupOnly && row.dob
            ? el('p', { class: 'text-xs text-ink-500', text: `Born ${fmt.date(row.dob)}` })
            : null,
        ]),
    },
  ];

  if (!lookupOnly) {
    columns.push(
      { key: 'gender', label: 'Gender', width: '6rem' },
      { key: 'category', label: 'Category', width: '7rem' },
      { key: 'city', label: 'City' }
    );
  }

  columns.push({
    key: 'status',
    label: 'Status',
    width: '8rem',
    render: (row) => statusChip(row.status),
  });

  return el('div', {}, [
    card({
      title: `${fmt.number(data.total)} student${data.total === 1 ? '' : 's'}`,
      subtitle: lookupOnly ? 'Your role sees names and classes only.' : null,
      actions: lookupOnly ? [chip('Limited view', 'info')] : null,
      body: el('div', {}, [
        table({
          columns,
          rows: data.rows,
          onRowClick: (row) => navigate(`/students/${row.id}`),
          emptyMessage:
            view.search || view.classId || view.sectionId
              ? 'No students match those filters.'
              : 'No students yet. Use New admission, or import a spreadsheet.',
        }),
        pager({
          page: data.page,
          pages: data.pages,
          total: data.total,
          onChange: (next) => {
            view.page = next;
            reload();
          },
        }),
      ]),
    }),
  ]);
}

function fullName(row) {
  return (
    row.fullName ||
    [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' ') ||
    '—'
  );
}

/** Class and section lists change on the Academic structure screen; keep them fresh. */
function invalidateLookupsIfStale() {
  window.addEventListener(
    'hashchange',
    () => {
      if (window.location.hash.includes('/settings/academics')) invalidateLookups();
    },
    { once: true }
  );
}
