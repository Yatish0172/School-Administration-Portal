/**
 * Academic structure (SPEC §8, T13): years, classes, sections, subjects and teacher
 * assignments.
 *
 * Enrollments hang off the year, so closing a year freezes it for writing while
 * keeping it readable for ever.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, statusChip, tabs, formModal, toast, confirm, icon, filterSelect, empty } from '../ui.js';
import { lookups, invalidateLookups, classOptions, sectionOptions, subjectOptions, teacherOptions, guardedSave, readOnlyNotice } from './_common.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups({ force: true });

  let activeTab = context.query?.tab || 'years';
  const view = { classId: null };
  const host = el('div');

  function paint() {
    host.replaceChildren(
      tabs(
        [
          { key: 'years', label: 'Academic years' },
          { key: 'classes', label: 'Classes' },
          { key: 'sections', label: 'Sections' },
          { key: 'subjects', label: 'Subjects' },
          { key: 'assignments', label: 'Teacher assignments' },
        ],
        activeTab,
        (key) => {
          activeTab = key;
          paint();
        }
      ),
      el('div', { id: 'ac-body' })
    );
    const body = host.querySelector('#ac-body');
    if (activeTab === 'years') years(body, paint);
    if (activeTab === 'classes') classes(body, paint);
    if (activeTab === 'sections') sections(body, view, paint);
    if (activeTab === 'subjects') subjects(body, view, paint);
    if (activeTab === 'assignments') assignments(body, paint);
  }

  container.replaceChildren(
    page({
      title: 'Academic structure',
      subtitle:
        'Set this up before admitting anyone — every academic record hangs off a class, a section and a year.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  paint();
}

const reloadAll = (repaint) => async () => {
  invalidateLookups();
  await lookups();
  repaint();
};

/* -------------------------------------------------------------------- years */

async function years(host, repaint) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/years');
    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        !data.rows.length
          ? el('div', { class: 'banner-warn rounded-lg' }, [
              icon('warning'),
              el('span', {
                text: 'No academic year exists yet. Nothing else can be set up until one does — create it first.',
              }),
            ])
          : null,
        card({
          title: 'Academic years',
          subtitle: 'A closed year stays fully readable and printable. It just cannot be written to.',
          actions: [
            button('Add a year', {
              variant: 'primary',
              iconName: 'add',
              onClick: () =>
                formModal({
                  title: 'Add an academic year',
                  submitLabel: 'Create year',
                  note: 'Default fee heads and grade bands are set up automatically for the new year.',
                  values: {},
                  fields: [
                    {
                      name: 'name',
                      label: 'Name',
                      required: true,
                      placeholder: '2026-27',
                      hint: 'Exactly this format.',
                    },
                    { name: 'startDate', label: 'Starts', type: 'date', required: true },
                    { name: 'endDate', label: 'Ends', type: 'date', required: true },
                  ],
                  onSubmit: async (values, helpers) => {
                    await guardedSave(() => api.post('/api/years', values), {
                      successMessage: 'Academic year created.',
                      onDone: () => {
                        helpers.close();
                        reloadAll(repaint)();
                      },
                    }).catch((err) => {
                      if (err.fields) helpers.setErrors(err.fields, err.message);
                    });
                  },
                }),
            }),
          ],
          body: table({
            columns: [
              { key: 'name', label: 'Year', width: '9rem' },
              { key: 'startDate', label: 'Starts', type: 'date', width: '10rem' },
              { key: 'endDate', label: 'Ends', type: 'date', width: '10rem' },
              {
                key: 'isCurrent',
                label: 'Current',
                width: '8rem',
                render: (row) => (row.isCurrent ? chip('Current', 'good') : ''),
              },
              { key: 'status', label: 'Status', width: '8rem', render: (row) => statusChip(row.status) },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  el('div', { class: 'flex flex-wrap gap-1' }, [
                    row.isCurrent || row.status === 'closed'
                      ? null
                      : button('Make current', {
                          size: 'sm',
                          onClick: async () => {
                            await guardedSave(() => api.post(`/api/years/${row.id}/current`), {
                              successMessage: `${row.name} is now the current year.`,
                              onDone: reloadAll(repaint),
                            }).catch(() => {});
                          },
                        }),
                    row.status === 'closed'
                      ? button('Reopen', {
                          size: 'sm',
                          onClick: async () => {
                            await guardedSave(() => api.post(`/api/years/${row.id}/reopen`), {
                              successMessage: 'Year reopened.',
                              onDone: reloadAll(repaint),
                            }).catch(() => {});
                          },
                        })
                      : button('Close', {
                          size: 'sm',
                          onClick: async () => {
                            const proceed = await confirm({
                              title: `Close ${row.name}?`,
                              message: 'Nothing more can be written to that year — no attendance, marks or fees.',
                              detail: 'It stays fully readable and printable. You can reopen it if you need to.',
                              confirmLabel: 'Close the year',
                              danger: true,
                            });
                            if (!proceed) return;
                            await guardedSave(() => api.post(`/api/years/${row.id}/close`), {
                              successMessage: 'Year closed.',
                              onDone: reloadAll(repaint),
                            }).catch(() => {});
                          },
                        }),
                  ]),
              },
            ],
            rows: data.rows,
            emptyMessage: 'No academic years yet.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

/* ------------------------------------------------------------------ classes */

async function classes(host, repaint) {
  host.replaceChildren(spinner());
  try {
    const rows = await api.get('/api/classes', { includeInactive: true });
    host.replaceChildren(
      card({
        title: 'Classes',
        subtitle: 'Classes persist across years. Sections are created per year.',
        actions: [
          button('Add a class', {
            variant: 'primary',
            iconName: 'add',
            onClick: () => classForm(null, repaint),
          }),
        ],
        body: table({
          columns: [
            { key: 'name', label: 'Class' },
            { key: 'level', label: 'Level', type: 'num', width: '6rem' },
            { key: 'stream', label: 'Stream', width: '9rem' },
            { key: 'sortOrder', label: 'Order', type: 'num', width: '6rem' },
            { key: 'status', label: 'Status', width: '8rem', render: (row) => statusChip(row.status) },
            {
              key: 'actions',
              label: '',
              render: (row) => button('Edit', { size: 'sm', onClick: () => classForm(row, repaint) }),
            },
          ],
          rows,
          emptyMessage: 'No classes yet. Add them in the order they should appear.',
        }),
      })
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

function classForm(existing, repaint) {
  formModal({
    title: existing ? `Edit ${existing.name}` : 'Add a class',
    submitLabel: existing ? 'Save' : 'Add class',
    values: existing || { sortOrder: 0 },
    fields: [
      { name: 'name', label: 'Name', required: true, placeholder: 'Grade 5' },
      { name: 'level', label: 'Level', type: 'number', min: 0, max: 20, hint: 'Numeric level, for ordering and reports.' },
      { name: 'stream', label: 'Stream', hint: 'Science, Commerce — senior classes only.' },
      { name: 'sortOrder', label: 'Display order', type: 'number', min: 0 },
      existing
        ? {
            name: 'status',
            label: 'Status',
            type: 'select',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Retired' },
            ],
          }
        : null,
    ].filter(Boolean),
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/classes/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/classes', values),
        {
          successMessage: 'Class saved.',
          onDone: () => {
            helpers.close();
            reloadAll(repaint)();
          },
        }
      ).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });
}

/* ----------------------------------------------------------------- sections */

async function sections(host, view, repaint) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/sections', { classId: view.classId, includeInactive: true });
    host.replaceChildren(
      el('div', {}, [
        el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
          filterSelect({
            label: 'Class',
            options: classOptions(),
            value: view.classId,
            placeholder: 'All classes',
            onChange: (value) => {
              view.classId = value;
              repaint();
            },
          }),
          button('Add a section', {
            variant: 'primary',
            iconName: 'add',
            onClick: () => sectionForm(null, repaint),
          }),
        ]),
        card({
          title: 'Sections for the current year',
          subtitle: 'Capacity is enforced at admission and when moving a student between sections.',
          body: table({
            columns: [
              {
                key: 'classId',
                label: 'Class',
                render: (row) => classOptions().find((option) => option.value === row.classId)?.label || '—',
              },
              { key: 'name', label: 'Section', width: '7rem' },
              { key: 'enrolled', label: 'Enrolled', type: 'num', width: '7rem' },
              {
                key: 'capacity',
                label: 'Capacity',
                width: '8rem',
                render: (row) =>
                  row.capacity
                    ? chip(`${row.enrolled} / ${row.capacity}`, row.enrolled >= row.capacity ? 'bad' : 'good')
                    : chip('No limit', 'neutral'),
              },
              { key: 'classTeacherName', label: 'Class teacher' },
              { key: 'roomNo', label: 'Room', width: '7rem' },
              { key: 'status', label: 'Status', width: '7rem', render: (row) => statusChip(row.status) },
              {
                key: 'actions',
                label: '',
                render: (row) => button('Edit', { size: 'sm', onClick: () => sectionForm(row, repaint) }),
              },
            ],
            rows: data.rows,
            emptyMessage: 'No sections for this year yet.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

function sectionForm(existing, repaint) {
  formModal({
    title: existing ? `Edit section ${existing.name}` : 'Add a section',
    submitLabel: existing ? 'Save' : 'Add section',
    values: existing || {},
    fields: [
      {
        name: 'classId',
        label: 'Class',
        type: 'select',
        required: true,
        options: classOptions(),
        disabled: !!existing,
      },
      { name: 'name', label: 'Section name', required: true, placeholder: 'A' },
      { name: 'capacity', label: 'Capacity', type: 'number', min: 1, max: 200, hint: 'Leave blank for no limit.' },
      {
        name: 'classTeacherId',
        label: 'Class teacher',
        type: 'select',
        options: teacherOptions(),
        placeholder: 'Not assigned',
        hint: 'The class teacher can mark this section’s attendance.',
      },
      { name: 'roomNo', label: 'Room' },
      existing
        ? {
            name: 'status',
            label: 'Status',
            type: 'select',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Retired' },
            ],
          }
        : null,
    ].filter(Boolean),
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/sections/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/sections', values),
        {
          successMessage: 'Section saved.',
          onDone: () => {
            helpers.close();
            reloadAll(repaint)();
          },
        }
      ).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });
}

/* ----------------------------------------------------------------- subjects */

async function subjects(host, view, repaint) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/subjects', { classId: view.classId, includeInactive: true });
    host.replaceChildren(
      el('div', {}, [
        el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
          filterSelect({
            label: 'Class',
            options: classOptions(),
            value: view.classId,
            placeholder: 'All classes',
            onChange: (value) => {
              view.classId = value;
              repaint();
            },
          }),
          button('Add a subject', {
            variant: 'primary',
            iconName: 'add',
            onClick: () => subjectForm(null, repaint),
          }),
        ]),
        card({
          title: 'Subjects',
          subtitle: 'Maximum and pass marks here are the defaults an exam date sheet starts from.',
          body: table({
            columns: [
              {
                key: 'classId',
                label: 'Class',
                render: (row) => classOptions().find((option) => option.value === row.classId)?.label || '—',
              },
              { key: 'name', label: 'Subject' },
              { key: 'code', label: 'Code', width: '7rem' },
              { key: 'type', label: 'Type', width: '7rem', render: (row) => fmt.humanise(row.type) },
              { key: 'mode', label: 'Mode', width: '8rem', render: (row) => fmt.humanise(row.mode) },
              { key: 'maxMarks', label: 'Max', type: 'num', width: '6rem' },
              { key: 'passMarks', label: 'Pass', type: 'num', width: '6rem' },
              { key: 'status', label: 'Status', width: '7rem', render: (row) => statusChip(row.status) },
              {
                key: 'actions',
                label: '',
                render: (row) => button('Edit', { size: 'sm', onClick: () => subjectForm(row, repaint) }),
              },
            ],
            rows: data.rows,
            emptyMessage: 'No subjects yet.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

function subjectForm(existing, repaint) {
  formModal({
    title: existing ? `Edit ${existing.name}` : 'Add a subject',
    submitLabel: existing ? 'Save' : 'Add subject',
    values: existing || { type: 'core', mode: 'theory', maxMarks: 100, passMarks: 33 },
    fields: [
      { name: 'classId', label: 'Class', type: 'select', required: true, options: classOptions(), disabled: !!existing },
      { name: 'name', label: 'Subject', required: true },
      { name: 'code', label: 'Code' },
      {
        name: 'type',
        label: 'Type',
        type: 'select',
        options: [
          { value: 'core', label: 'Core' },
          { value: 'elective', label: 'Elective' },
        ],
      },
      {
        name: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { value: 'theory', label: 'Theory' },
          { value: 'practical', label: 'Practical' },
          { value: 'both', label: 'Theory and practical' },
        ],
      },
      { name: 'maxMarks', label: 'Maximum marks', type: 'number', min: 1, max: 1000 },
      { name: 'passMarks', label: 'Pass marks', type: 'number', min: 0, max: 1000 },
      { name: 'sortOrder', label: 'Display order', type: 'number', min: 0 },
      existing
        ? {
            name: 'status',
            label: 'Status',
            type: 'select',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Retired' },
            ],
          }
        : null,
    ].filter(Boolean),
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/subjects/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/subjects', values),
        {
          successMessage: 'Subject saved.',
          onDone: () => {
            helpers.close();
            reloadAll(repaint)();
          },
        }
      ).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });
}

/* -------------------------------------------------------------- assignments */

async function assignments(host, repaint) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/assignments');
    host.replaceChildren(
      card({
        title: 'Teacher assignments',
        subtitle:
          'This is what scopes a class teacher. Without an assignment, a teacher sees no sections at all — attendance and marks entry will be empty for them.',
        actions: [
          button('Assign a teacher', {
            variant: 'primary',
            iconName: 'add',
            onClick: () => assignmentForm(repaint),
          }),
        ],
        body: table({
          columns: [
            { key: 'teacherName', label: 'Teacher' },
            { key: 'className', label: 'Class', width: '9rem' },
            { key: 'sectionName', label: 'Section', width: '7rem' },
            { key: 'subjectName', label: 'Subject' },
            {
              key: 'isClassTeacher',
              label: 'Class teacher',
              width: '9rem',
              render: (row) => (row.isClassTeacher ? chip('Yes', 'good') : ''),
            },
            {
              key: 'actions',
              label: '',
              render: (row) =>
                button('Remove', {
                  size: 'sm',
                  onClick: async () => {
                    const proceed = await confirm({
                      title: 'Remove this assignment?',
                      message: `${row.teacherName} will no longer be able to open ${row.className} ${row.sectionName}.`,
                      confirmLabel: 'Remove',
                      danger: true,
                    });
                    if (!proceed) return;
                    await guardedSave(() => api.del(`/api/assignments/${row.id}`), {
                      successMessage: 'Assignment removed.',
                      onDone: repaint,
                    }).catch(() => {});
                  },
                }),
            },
          ],
          rows: data.rows,
          emptyMessage: 'No teachers assigned yet.',
        }),
      })
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

function assignmentForm(repaint) {
  let selectedClassId = null;
  const { formApi } = formModal({
    title: 'Assign a teacher',
    submitLabel: 'Assign',
    note: 'Leave the subject blank for a general class-teacher assignment.',
    values: {},
    fields: [
      { name: 'teacherUserId', label: 'Teacher', type: 'select', required: true, options: teacherOptions() },
      { name: 'classId', label: 'Class', type: 'select', required: true, options: classOptions() },
      { name: 'sectionId', label: 'Section', type: 'select', required: true, options: () => sectionOptions(selectedClassId) },
      { name: 'subjectId', label: 'Subject', type: 'select', options: () => subjectOptions(selectedClassId), placeholder: 'Class teacher only' },
      { name: 'isClassTeacher', label: 'This is their class-teacher section', type: 'checkbox', colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(() => api.post('/api/assignments', values), {
        successMessage: 'Teacher assigned.',
        onDone: () => {
          helpers.close();
          reloadAll(repaint)();
        },
      }).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });

  const classControl = formApi.control('classId');
  classControl.addEventListener('change', () => {
    selectedClassId = classControl.value || null;
    refill(formApi.control('sectionId'), sectionOptions(selectedClassId), 'Choose a section');
    refill(formApi.control('subjectId'), subjectOptions(selectedClassId), 'Class teacher only');
  });
}

function refill(select, options, placeholder) {
  select.replaceChildren(el('option', { value: '', text: placeholder }));
  for (const option of options) {
    select.appendChild(el('option', { value: option.value, text: option.label }));
  }
}

function errorCard(err) {
  return el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message });
}

void toast;
void empty;
