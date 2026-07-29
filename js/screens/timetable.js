/**
 * Timetable (SPEC §8, T22): period grid per section, teacher-clash detection,
 * substitutions, and printing per class or per teacher.
 *
 * The clash check runs on the server inside the same lock as the write, so two
 * people editing at once cannot both put one teacher in two rooms.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, tabs, formModal, toast, filterSelect, printNode, empty, modal } from '../ui.js';
import { lookups, mySectionOptions, teacherOptions, subjectOptions, sectionById, sectionLabel, guardedSave, readOnlyNotice, printHeader, printFooter, isSectionBound } from './_common.js';
import { can, state } from '../state.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WORKING_DAYS = [1, 2, 3, 4, 5, 6];

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  let activeTab = context.query?.tab || 'section';
  const view = {
    sectionId: context.query?.sectionId || mySectionOptions()[0]?.value || null,
    teacherUserId: state.user?.id || null,
    date: fmt.today(),
  };

  const host = el('div');

  function paint() {
    host.replaceChildren(
      tabs(
        [
          { key: 'section', label: 'By section' },
          { key: 'teacher', label: 'By teacher' },
          { key: 'periods', label: 'Period times' },
        ],
        activeTab,
        (key) => {
          activeTab = key;
          paint();
        }
      ),
      el('div', { id: 'tt-body' })
    );
    const body = host.querySelector('#tt-body');
    if (activeTab === 'section') bySection(body, view, paint);
    if (activeTab === 'teacher') byTeacher(body, view, paint);
    if (activeTab === 'periods') periodTimes(body, paint);
  }

  container.replaceChildren(
    page({
      title: 'Timetable',
      subtitle: 'A teacher cannot be put in two sections in the same period — the server refuses it.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  paint();
}

/* ------------------------------------------------------------- by section */

async function bySection(host, view, repaint) {
  host.replaceChildren(
    el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
      filterSelect({
        label: 'Section',
        width: '14rem',
        options: mySectionOptions(),
        value: view.sectionId,
        placeholder: 'Choose a section',
        onChange: (value) => {
          view.sectionId = value;
          repaint();
        },
      }),
    ]),
    spinner()
  );

  if (!view.sectionId) {
    host.lastChild.replaceWith(empty('Choose a section.'));
    return;
  }

  try {
    const data = await api.get('/api/timetable', { sectionId: view.sectionId });
    const section = sectionById(view.sectionId);
    const periods = data.periods.length ? data.periods : defaultPeriods();
    const slots = new Map(data.rows.map((row) => [`${row.day}|${row.period}`, row]));
    const editable = can('timetable.edit');

    const gridNode = el('div', { class: 'overflow-x-auto' }, [
      el('table', { class: 'table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Period', style: { width: '8rem' } }),
            ...WORKING_DAYS.map((day) => el('th', { text: DAYS[day] })),
          ]),
        ]),
        el(
          'tbody',
          {},
          periods.map((period) =>
            el('tr', {}, [
              el('td', {}, [
                el('p', { class: 'font-medium', text: period.label || `Period ${period.period}` }),
                period.startTime
                  ? el('p', { class: 'text-xs text-ink-500', text: `${fmt.time(period.startTime)}–${fmt.time(period.endTime)}` })
                  : null,
              ]),
              ...WORKING_DAYS.map((day) => {
                const slot = slots.get(`${day}|${period.period}`);
                return el('td', { class: 'p-1' }, [
                  el(
                    'button',
                    {
                      class: `w-full rounded-md border px-2 py-1.5 text-left text-xs ${
                        slot ? 'border-brand-200 bg-brand-50' : 'border-dashed border-ink-200 text-ink-400'
                      } ${editable ? 'hover:border-brand-400' : 'cursor-default'}`,
                      disabled: !editable,
                      on: editable
                        ? {
                            click: () =>
                              slotForm({
                                view,
                                section,
                                day,
                                period: period.period,
                                slot,
                                reload: repaint,
                              }),
                          }
                        : {},
                    },
                    slot
                      ? [
                          el('p', { class: 'font-medium text-ink-900', text: slot.subjectName || 'Subject' }),
                          el('p', { class: 'text-ink-600', text: slot.teacherName || 'No teacher' }),
                          slot.roomNo ? el('p', { class: 'text-ink-400', text: `Room ${slot.roomNo}` }) : null,
                        ]
                      : ['— free —']
                  ),
                ]);
              }),
            ])
          )
        ),
      ]),
    ]);

    host.lastChild.replaceWith(
      el('div', { class: 'space-y-4' }, [
        card({
          title: `${sectionLabel(view.sectionId)} timetable`,
          subtitle: editable ? 'Click any slot to set the subject and teacher.' : 'Read only for your role.',
          actions: [
            data.periods.length ? null : chip('Using default period times', 'warn'),
            button('Print', {
              iconName: 'print',
              onClick: () => printGrid(`Timetable — ${sectionLabel(view.sectionId)}`, periods, data.rows),
            }),
          ],
          body: gridNode,
        }),
        substitutionsCard(view, data, repaint),
      ])
    );
  } catch (err) {
    host.lastChild.replaceWith(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

function slotForm({ view, section, day, period, slot, reload }) {
  formModal({
    title: `${DAYS[day]}, period ${period}`,
    submitLabel: 'Save slot',
    note: 'Leave both the subject and teacher blank to clear this slot.',
    values: slot || {},
    fields: [
      {
        name: 'subjectId',
        label: 'Subject',
        type: 'select',
        options: subjectOptions(section?.classId),
        placeholder: '— free period —',
      },
      {
        name: 'teacherUserId',
        label: 'Teacher',
        type: 'select',
        options: teacherOptions(),
        placeholder: 'Not assigned',
      },
      { name: 'roomNo', label: 'Room' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          api.put('/api/timetable/slot', {
            sectionId: view.sectionId,
            classId: section?.classId,
            day,
            period,
            subjectId: values.subjectId,
            teacherUserId: values.teacherUserId,
            roomNo: values.roomNo,
          }),
        {
          successMessage: 'Slot saved.',
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

function substitutionsCard(view, data, reload) {
  return card({
    title: 'Substitutions',
    subtitle: 'A one-day cover for an absent teacher. The permanent timetable is untouched.',
    actions: can('timetable.edit')
      ? [
          button('Record a substitution', {
            size: 'sm',
            iconName: 'swap_horiz',
            onClick: () => substitutionForm(view, data, reload),
          }),
        ]
      : null,
    body: table({
      dense: true,
      columns: [
        { key: 'date', label: 'Date', type: 'date', width: '9rem' },
        { key: 'period', label: 'Period', type: 'num', width: '6rem' },
        { key: 'originalTeacherId', label: 'Instead of', render: (row) => teacherName(row.originalTeacherId) },
        { key: 'substituteTeacherId', label: 'Covered by', render: (row) => teacherName(row.substituteTeacherId) },
        { key: 'reason', label: 'Reason' },
      ],
      rows: data.substitutions || [],
      emptyMessage: 'No substitutions recorded.',
    }),
  });
}

function teacherName(id) {
  return teacherOptions().find((option) => option.value === id)?.label || '—';
}

function substitutionForm(view, data, reload) {
  const slots = data.rows.filter((row) => row.teacherUserId);
  if (!slots.length) {
    toast('There are no slots with a teacher to substitute for.', 'warn');
    return;
  }
  formModal({
    title: 'Record a substitution',
    submitLabel: 'Save',
    values: { date: fmt.today() },
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true },
      {
        name: 'timetableId',
        label: 'Period being covered',
        type: 'select',
        required: true,
        colSpan: 'full',
        options: slots.map((row) => ({
          value: row.id,
          label: `${DAYS[row.day]} period ${row.period} — ${row.subjectName || 'subject'} (${row.teacherName || 'teacher'})`,
        })),
      },
      {
        name: 'substituteTeacherId',
        label: 'Covered by',
        type: 'select',
        required: true,
        options: teacherOptions(),
      },
      { name: 'reason', label: 'Reason', colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(() => api.post('/api/timetable/substitutions', values), {
        successMessage: 'Substitution recorded.',
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

/* ------------------------------------------------------------- by teacher */

async function byTeacher(host, view, repaint) {
  host.replaceChildren(
    el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
      // A class teacher may only see their own load, so offer only themselves
      // rather than a list that would come back refused.
      filterSelect({
        label: 'Teacher',
        width: '14rem',
        options: isSectionBound()
          ? teacherOptions().filter((option) => option.value === state.user?.id)
          : teacherOptions(),
        value: view.teacherUserId,
        placeholder: 'Choose a teacher',
        onChange: (value) => {
          view.teacherUserId = value;
          repaint();
        },
      }),
    ]),
    spinner()
  );

  if (!view.teacherUserId) {
    host.lastChild.replaceWith(empty('Choose a teacher.'));
    return;
  }

  try {
    const data = await api.get('/api/timetable', { teacherUserId: view.teacherUserId });
    const periods = data.periods.length ? data.periods : defaultPeriods();
    const slots = new Map(data.rows.map((row) => [`${row.day}|${row.period}`, row]));

    host.lastChild.replaceWith(
      card({
        title: `${teacherName(view.teacherUserId)} — weekly load`,
        subtitle: `${data.rows.length} period(s) a week`,
        actions: [
          button('Print', {
            iconName: 'print',
            onClick: () => printGrid(`Timetable — ${teacherName(view.teacherUserId)}`, periods, data.rows, true),
          }),
        ],
        body: el('div', { class: 'overflow-x-auto' }, [
          el('table', { class: 'table' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: 'Period', style: { width: '8rem' } }),
                ...WORKING_DAYS.map((day) => el('th', { text: DAYS[day] })),
              ]),
            ]),
            el(
              'tbody',
              {},
              periods.map((period) =>
                el('tr', {}, [
                  el('td', {}, [
                    el('p', { class: 'font-medium', text: period.label || `Period ${period.period}` }),
                    period.startTime
                      ? el('p', { class: 'text-xs text-ink-500', text: `${fmt.time(period.startTime)}–${fmt.time(period.endTime)}` })
                      : null,
                  ]),
                  ...WORKING_DAYS.map((day) => {
                    const slot = slots.get(`${day}|${period.period}`);
                    return el('td', {}, [
                      slot
                        ? el('div', { class: 'text-xs' }, [
                            el('p', { class: 'font-medium', text: `${slot.className} ${slot.sectionName}` }),
                            el('p', { class: 'text-ink-600', text: slot.subjectName || '' }),
                          ])
                        : el('span', { class: 'text-xs text-ink-300', text: '—' }),
                    ]);
                  }),
                ])
              )
            ),
          ]),
        ]),
      })
    );
  } catch (err) {
    host.lastChild.replaceWith(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

/* ------------------------------------------------------------ period times */

async function periodTimes(host, reload) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/periods');
    const periods = data.rows.length ? data.rows.map((row) => ({ ...row })) : defaultPeriods();
    const tableHost = el('div');

    function paint() {
      tableHost.replaceChildren(
        table({
          dense: true,
          columns: [
            { key: 'period', label: '#', width: '4rem', render: (row) => String(periods.indexOf(row) + 1) },
            { key: 'label', label: 'Label', render: (row) => input(row, 'label', 'text', '12rem') },
            { key: 'startTime', label: 'From', render: (row) => input(row, 'startTime', 'time', '7rem') },
            { key: 'endTime', label: 'To', render: (row) => input(row, 'endTime', 'time', '7rem') },
            {
              key: 'isBreak',
              label: 'Break',
              render: (row) => {
                const box = el('input', {
                  type: 'checkbox',
                  class: 'h-4 w-4 rounded border-ink-300 text-brand-600',
                  checked: !!row.isBreak,
                });
                box.addEventListener('change', () => {
                  row.isBreak = box.checked;
                });
                return box;
              },
            },
            {
              key: 'remove',
              label: '',
              render: (row) =>
                button('Remove', {
                  size: 'sm',
                  onClick: () => {
                    periods.splice(periods.indexOf(row), 1);
                    paint();
                  },
                }),
            },
          ],
          rows: periods,
        })
      );
    }

    paint();

    host.replaceChildren(
      card({
        title: 'Period times',
        subtitle: 'Used on printed timetables and on the teacher dashboard.',
        actions: can('timetable.edit')
          ? [
              button('Add period', {
                iconName: 'add',
                onClick: () => {
                  periods.push({ period: periods.length + 1, label: `Period ${periods.length + 1}` });
                  paint();
                },
              }),
              button('Save', {
                variant: 'primary',
                iconName: 'save',
                onClick: async () => {
                  await guardedSave(
                    () =>
                      api.put('/api/periods', {
                        periods: periods.map((row, index) => ({ ...row, period: index + 1 })),
                      }),
                    { successMessage: 'Period times saved.', onDone: reload }
                  ).catch(() => {});
                },
              }),
            ]
          : null,
        body: tableHost,
      })
    );
  } catch (err) {
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

function input(row, key, type, width) {
  const node = el('input', { class: 'input', type, value: row[key] ?? '', style: { width } });
  node.addEventListener('input', () => {
    row[key] = node.value || null;
  });
  return node;
}

function defaultPeriods() {
  return Array.from({ length: 8 }, (_, index) => ({
    period: index + 1,
    label: `Period ${index + 1}`,
    startTime: null,
    endTime: null,
    isBreak: false,
  }));
}

function printGrid(title, periods, rows, byTeacherView = false) {
  const slots = new Map(rows.map((row) => [`${row.day}|${row.period}`, row]));
  printNode(
    el('div', { class: 'print-page bg-white p-6 text-xs' }, [
      printHeader(state.school, title, ''),
      el('table', { class: 'w-full border-collapse' }, [
        el('thead', {}, [
          el('tr', { class: 'bg-ink-100' }, [
            el('th', { class: 'border border-ink-400 px-1.5 py-1 text-left', text: 'Period' }),
            ...WORKING_DAYS.map((day) =>
              el('th', { class: 'border border-ink-400 px-1.5 py-1 text-left', text: DAYS[day].slice(0, 3) })
            ),
          ]),
        ]),
        el(
          'tbody',
          {},
          periods.map((period) =>
            el('tr', {}, [
              el('td', { class: 'border border-ink-400 px-1.5 py-1' }, [
                el('div', { text: period.label || `P${period.period}` }),
                period.startTime ? el('div', { class: 'text-[9px] text-ink-500', text: period.startTime }) : null,
              ]),
              ...WORKING_DAYS.map((day) => {
                const slot = slots.get(`${day}|${period.period}`);
                return el('td', { class: 'border border-ink-400 px-1.5 py-1' }, [
                  slot
                    ? el('div', {}, [
                        el('div', { class: 'font-medium', text: byTeacherView ? `${slot.className} ${slot.sectionName}` : slot.subjectName || '' }),
                        el('div', { class: 'text-[9px] text-ink-600', text: byTeacherView ? slot.subjectName || '' : slot.teacherName || '' }),
                      ])
                    : el('span', { class: 'text-ink-300', text: '—' }),
                ]);
              }),
            ])
          )
        ),
      ]),
      printFooter(state.user?.name, new Date().toISOString()),
    ]),
    { title }
  );
}

void modal;
