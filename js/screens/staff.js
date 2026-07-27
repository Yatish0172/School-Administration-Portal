/**
 * Staff directory (SPEC §12). HR sees no student data at all — that limit is in the
 * role's permission set, not in this screen.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, statusChip, searchBox, filterSelect, formModal, pager } from '../ui.js';
import { guardedSave, readOnlyNotice } from './_common.js';
import { can } from '../state.js';
import { navigate } from '../router.js';

export async function render(container, context = {}) {
  const view = { search: context.query?.search || '', status: 'active', page: 1 };
  const host = el('div');
  const filterHost = el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' });

  function paintFilters() {
    filterHost.replaceChildren(
      searchBox('Search name, code, designation or phone…', (value) => {
        view.search = value;
        view.page = 1;
        load();
      }, view.search),
      filterSelect({
        label: 'Status',
        options: ['active', 'inactive', 'left'],
        value: view.status,
        placeholder: 'All',
        onChange: (value) => {
          view.status = value;
          view.page = 1;
          load();
        },
      })
    );
  }

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/staff', {
        search: view.search,
        status: view.status,
        page: view.page,
        pageSize: 50,
      });
      host.replaceChildren(
        card({
          title: `${fmt.number(data.total)} staff member${data.total === 1 ? '' : 's'}`,
          body: el('div', {}, [
            table({
              columns: [
                { key: 'staffCode', label: 'Code', width: '7rem' },
                { key: 'name', label: 'Name' },
                { key: 'designation', label: 'Designation' },
                { key: 'department', label: 'Department' },
                { key: 'phone', label: 'Phone', width: '9rem' },
                { key: 'joiningDate', label: 'Joined', type: 'date', width: '8rem' },
                { key: 'status', label: 'Status', width: '7rem', render: (row) => statusChip(row.status) },
              ],
              rows: data.rows,
              onRowClick: (row) => navigate(`/staff/${row.id}`),
              emptyMessage: 'No staff records yet.',
            }),
            pager({
              page: data.page,
              pages: data.pages,
              total: data.total,
              onChange: (next) => {
                view.page = next;
                load();
              },
            }),
          ]),
        })
      );
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  paintFilters();

  container.replaceChildren(
    page({
      title: 'Staff',
      subtitle: 'Records are never deleted — someone who leaves gets a status change.',
      wide: true,
      actions: [
        can('staff.manage')
          ? button('Add staff member', { variant: 'primary', iconName: 'person_add', onClick: () => staffForm(null, load) })
          : null,
      ],
      children: el('div', {}, [readOnlyNotice(), filterHost, host]),
    })
  );

  await load();
}

export function staffForm(existing, reload) {
  formModal({
    title: existing ? `Edit ${existing.name}` : 'Add a staff member',
    submitLabel: existing ? 'Save' : 'Add',
    size: 'lg',
    values: existing || { joiningDate: fmt.today(), employmentType: 'Permanent' },
    fields: [
      { name: 'name', label: 'Full name', required: true },
      { name: 'designation', label: 'Designation', required: true },
      { name: 'department', label: 'Department' },
      { name: 'employmentType', label: 'Employment type', type: 'select', options: ['Permanent', 'Contract', 'Part time', 'Visiting'] },
      { name: 'qualification', label: 'Qualification' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'dob', label: 'Date of birth', type: 'date', max: fmt.today() },
      { name: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'] },
      { name: 'bloodGroup', label: 'Blood group' },
      { name: 'joiningDate', label: 'Joining date', type: 'date' },
      { name: 'aadhaar', label: 'Aadhaar', maxLength: 12 },
      { name: 'panNo', label: 'PAN', maxLength: 10 },
      { name: 'bankAccount', label: 'Bank account' },
      { name: 'ifsc', label: 'IFSC' },
      { name: 'address', label: 'Address', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/staff/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/staff', values),
        {
          successMessage: existing ? 'Staff record saved.' : 'Staff member added.',
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
}
