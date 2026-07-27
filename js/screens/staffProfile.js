/**
 * One staff member: details, documents, salary structure and leave balances.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, details, statusChip, toast, formModal, modal, chip, empty } from '../ui.js';
import { guardedSave, readOnlyNotice } from './_common.js';
import { can } from '../state.js';
import { staffForm } from './staff.js';

export async function render(container, context) {
  const staffId = context.params.id;
  container.replaceChildren(spinner());

  async function load() {
    const data = await api.get(`/api/staff/${staffId}`);
    container.replaceChildren(build(data, load));
  }

  await load();
}

function build(data, reload) {
  const member = data.staff;

  return page({
    title: member.name,
    subtitle: `${member.staffCode} • ${fmt.text(member.designation)}${
      member.department ? ` • ${member.department}` : ''
    }`,
    wide: true,
    actions: [
      statusChip(member.status),
      can('staff.manage')
        ? button('Change status', { iconName: 'swap_horiz', onClick: () => statusFlow(member, reload) })
        : null,
      can('staff.manage')
        ? button('Edit', { variant: 'primary', iconName: 'edit', onClick: () => staffForm(member, reload) })
        : null,
    ],
    children: el('div', { class: 'space-y-4' }, [
      readOnlyNotice(),
      el('div', { class: 'grid grid-cols-1 gap-4 lg:grid-cols-3' }, [
        el('div', { class: 'space-y-4 lg:col-span-2' }, [
          card({
            title: 'Details',
            body: details([
              { label: 'Staff code', value: member.staffCode },
              { label: 'Designation', value: member.designation },
              { label: 'Department', value: member.department },
              { label: 'Employment type', value: member.employmentType },
              { label: 'Qualification', value: member.qualification },
              { label: 'Phone', value: member.phone },
              { label: 'Email', value: member.email },
              { label: 'Date of birth', value: member.dob ? fmt.date(member.dob) : null },
              { label: 'Gender', value: member.gender },
              { label: 'Blood group', value: member.bloodGroup },
              { label: 'Joined', value: member.joiningDate ? fmt.date(member.joiningDate) : null },
              member.leavingDate ? { label: 'Left', value: fmt.date(member.leavingDate) } : null,
              { label: 'Address', value: member.address, colSpan: 'full' },
            ]),
          }),
          documentsCard(data, reload),
        ]),
        el('div', { class: 'space-y-4' }, [
          salaryCard(data, reload),
          card({
            title: 'Leave balances',
            body: data.leaveBalances.length
              ? el(
                  'div',
                  { class: 'space-y-1 text-sm' },
                  data.leaveBalances.map((balance) =>
                    el('div', { class: 'flex items-baseline justify-between gap-3' }, [
                      el('span', { class: 'text-ink-500', text: balance.leaveType }),
                      el('span', { class: 'font-medium tabular-nums' }, [
                        `${balance.remaining} left`,
                        el('span', { class: 'ml-1 text-xs text-ink-400', text: `of ${balance.opening + balance.accrued}` }),
                      ]),
                    ])
                  )
                )
              : empty('No leave balances set up for this year.'),
          }),
          can('payroll.view') && member.userId
            ? card({
                title: 'Portal access',
                body: el('p', { class: 'text-sm text-ink-600', text: 'This staff member has a login linked to their record.' }),
              })
            : null,
        ]),
      ]),
    ]),
  });
}

function documentsCard(data, reload) {
  const fileInput = el('input', { type: 'file', class: 'hidden' });
  const typeSelect = el(
    'select',
    { class: 'input', style: { width: '11rem' } },
    (data.docTypes || ['Other']).map((type) => el('option', { value: type, text: type }))
  );

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files?.length) return;
    const body = new FormData();
    body.append('file', fileInput.files[0]);
    body.append('docType', typeSelect.value);
    try {
      await api.upload(`/api/staff/${data.staff.id}/documents`, body);
      toast('Document uploaded.', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
    fileInput.value = '';
  });

  return card({
    title: 'Documents',
    actions: can('document.upload')
      ? [typeSelect, button('Upload', { iconName: 'upload', onClick: () => fileInput.click() }), fileInput]
      : null,
    body: table({
      columns: [
        { key: 'docType', label: 'Type', width: '11rem' },
        { key: 'originalName', label: 'File' },
        { key: 'sizeBytes', label: 'Size', render: (row) => fmt.bytes(row.sizeBytes) },
        { key: 'uploadedAt', label: 'Uploaded', type: 'dateTime' },
        {
          key: 'actions',
          label: '',
          render: (row) =>
            can('document.download')
              ? button('Download', {
                  size: 'sm',
                  onClick: async () => {
                    try {
                      await api.download(`/api/staff/documents/${row.id}/download`, null, row.originalName);
                    } catch (err) {
                      toast(err.message, 'bad');
                    }
                  },
                })
              : null,
        },
      ],
      rows: data.documents,
      emptyMessage: 'No documents uploaded.',
    }),
  });
}

function salaryCard(data, reload) {
  if (!can('payroll.view')) return null;
  const salary = data.salary;

  return card({
    title: 'Salary structure',
    actions: can('payroll.manage')
      ? [button(salary ? 'Revise' : 'Set', { size: 'sm', onClick: () => salaryForm(data.staff, salary, reload) })]
      : null,
    body: salary
      ? el('div', { class: 'space-y-1 text-sm' }, [
          row('Basic', fmt.money(salary.basic)),
          row('HRA', fmt.money(salary.hra)),
          row('DA', fmt.money(salary.da)),
          row('Allowances', fmt.money(salary.allowances)),
          el('hr', { class: 'my-1 border-ink-200' }),
          row('PF', fmt.money(salary.pf)),
          row('Professional tax', fmt.money(salary.professionalTax)),
          row('Income tax', fmt.money(salary.incomeTax)),
          row('Other deductions', fmt.money(salary.otherDeductions)),
          el('hr', { class: 'my-1 border-ink-200' }),
          el('div', { class: 'flex justify-between font-semibold' }, [
            el('span', { text: 'Net salary' }),
            el('span', { class: 'tabular-nums', text: fmt.money(salary.netSalary) }),
          ]),
          el('p', { class: 'pt-1 text-xs text-ink-500', text: `Effective ${fmt.date(salary.effectiveFrom)}` }),
        ])
      : empty('No salary structure set.'),
  });
}

function row(label, value) {
  return el('div', { class: 'flex justify-between gap-3' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('span', { class: 'tabular-nums', text: value }),
  ]);
}

function salaryForm(member, existing, reload) {
  formModal({
    title: `Salary for ${member.name}`,
    submitLabel: 'Save structure',
    note:
      'A revision supersedes the previous structure rather than editing it, so payslips already issued still reconcile.',
    values: existing || { effectiveFrom: fmt.today() },
    fields: [
      { name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true },
      { name: 'basic', label: 'Basic', type: 'number', required: true, min: 0, step: 0.01 },
      { name: 'hra', label: 'HRA', type: 'number', min: 0, step: 0.01 },
      { name: 'da', label: 'DA', type: 'number', min: 0, step: 0.01 },
      { name: 'allowances', label: 'Other allowances', type: 'number', min: 0, step: 0.01 },
      { name: 'pf', label: 'PF deduction', type: 'number', min: 0, step: 0.01 },
      { name: 'professionalTax', label: 'Professional tax', type: 'number', min: 0, step: 0.01 },
      { name: 'incomeTax', label: 'Income tax', type: 'number', min: 0, step: 0.01 },
      { name: 'otherDeductions', label: 'Other deductions', type: 'number', min: 0, step: 0.01 },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(() => api.put(`/api/staff/${member.id}/salary`, values), {
        successMessage: 'Salary structure saved.',
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

function statusFlow(member, reload) {
  const select = el(
    'select',
    { class: 'input' },
    ['active', 'inactive', 'left'].map((status) =>
      el('option', { value: status, text: fmt.humanise(status), selected: status === member.status })
    )
  );
  const date = el('input', { class: 'input', type: 'date', value: fmt.today() });

  modal({
    title: `Change status for ${member.name}`,
    size: 'sm',
    body: el('div', { class: 'space-y-3' }, [
      el('p', {
        class: 'text-sm text-ink-600',
        text: 'Staff records are kept so attendance and payroll history stay intact.',
      }),
      el('div', {}, [el('label', { class: 'label', text: 'Status' }), select]),
      el('div', {}, [el('label', { class: 'label', text: 'Leaving date' }), date]),
    ]),
    actions: (close) => [
      button('Cancel', { onClick: close }),
      button('Save', {
        variant: 'primary',
        onClick: async () => {
          await guardedSave(
            () => api.post(`/api/staff/${member.id}/status`, { status: select.value, leavingDate: date.value }),
            {
              successMessage: 'Status updated.',
              onDone: () => {
                close();
                reload();
              },
            }
          ).catch(() => {});
        },
      }),
    ],
  });
}

void chip;
