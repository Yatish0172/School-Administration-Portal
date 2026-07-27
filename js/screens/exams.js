/**
 * Exam list and setup (SPEC §10, T23).
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, formModal, spinner, chip, statusChip, filterSelect } from '../ui.js';
import { lookups, classOptions, guardedSave, readOnlyNotice } from './_common.js';
import { can } from '../state.js';
import { navigate } from '../router.js';

const TERMS = ['Unit Test 1', 'Half Yearly', 'Unit Test 2', 'Annual'];

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  const view = { classId: context.query?.classId || null, status: null };
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/exams', { classId: view.classId, status: view.status });
      host.replaceChildren(listCard(data, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Exams',
      subtitle: 'Terms, subjects, maximum and pass marks, and the date sheet.',
      wide: true,
      actions: [
        can('grade.manage') ? button('Grade bands', { iconName: 'grade', onClick: () => navigate('/grades') }) : null,
        can('exam.setup')
          ? button('New exam', { variant: 'primary', iconName: 'add', onClick: () => examForm(null, load) })
          : null,
      ],
      children: el('div', {}, [
        readOnlyNotice(),
        el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
          filterSelect({
            label: 'Class',
            options: classOptions(),
            value: view.classId,
            placeholder: 'All classes',
            onChange: (value) => {
              view.classId = value;
              load();
            },
          }),
          filterSelect({
            label: 'Status',
            options: [
              { value: 'setup', label: 'Being set up' },
              { value: 'marks', label: 'Marks entry' },
              { value: 'published', label: 'Published' },
            ],
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

function listCard(data, reload) {
  return card({
    title: `${data.rows.length} exam${data.rows.length === 1 ? '' : 's'}`,
    body: table({
      columns: [
        { key: 'name', label: 'Exam' },
        { key: 'className', label: 'Class', width: '8rem' },
        { key: 'term', label: 'Term' },
        { key: 'startDate', label: 'Starts', type: 'date', width: '8rem' },
        { key: 'endDate', label: 'Ends', type: 'date', width: '8rem' },
        { key: 'weightage', label: 'Weight', type: 'num', width: '6rem' },
        {
          key: 'status',
          label: 'Status',
          width: '9rem',
          render: (row) =>
            row.status === 'published'
              ? chip('Published', 'good')
              : row.status === 'marks'
                ? chip('Marks entry', 'warn')
                : chip('Being set up', 'neutral'),
        },
        {
          key: 'actions',
          label: '',
          render: (row) =>
            el('div', { class: 'flex gap-1' }, [
              button('Open', { size: 'sm', onClick: () => navigate(`/exams/${row.id}`) }),
              can('exam.setup') && row.status !== 'published'
                ? button('Edit', { size: 'sm', onClick: () => examForm(row, reload) })
                : null,
            ]),
        },
      ],
      rows: data.rows,
      onRowClick: (row) => navigate(`/exams/${row.id}`),
      emptyMessage: 'No exams set up yet.',
    }),
  });
}

function examForm(existing, reload) {
  formModal({
    title: existing ? `Edit ${existing.name}` : 'New exam',
    submitLabel: existing ? 'Save' : 'Create exam',
    values: existing || { weightage: 100 },
    fields: [
      { name: 'name', label: 'Exam name', required: true, colSpan: 'full', placeholder: 'Unit Test 1' },
      {
        name: 'classId',
        label: 'Class',
        type: 'select',
        required: true,
        options: classOptions(),
        disabled: !!existing,
        hint: existing ? 'The class cannot be changed once marks exist.' : null,
      },
      { name: 'term', label: 'Term', type: 'select', options: TERMS, placeholder: 'Same as the name' },
      { name: 'startDate', label: 'Starts', type: 'date' },
      { name: 'endDate', label: 'Ends', type: 'date' },
      {
        name: 'weightage',
        label: 'Weight towards the year (%)',
        type: 'number',
        min: 0,
        max: 100,
        hint: 'Used when comparing terms.',
      },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () => (existing ? api.put(`/api/exams/${existing.id}`, { ...values, _rev: existing._rev }) : api.post('/api/exams', values)),
        {
          successMessage: existing ? 'Exam saved.' : 'Exam created. Now set the subjects and date sheet.',
          onDone: (result) => {
            helpers.close();
            if (!existing && result?.id) navigate(`/exams/${result.id}`);
            else reload();
          },
        }
      ).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });
  void statusChip;
}
