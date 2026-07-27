/**
 * Report cards (SPEC §10, T26).
 *
 * Printed through the browser rather than a PDF library, so the office gets the
 * printer dialogue they already know and the app stays dependency-free.
 *
 * The layout below is a sensible CBSE-style default. SPEC §10 is explicit that the
 * real format must come from a scan of the school's current card — this is built to
 * be edited in one place when that arrives.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, toast, filterSelect, printNode, empty, icon } from '../ui.js';
import { lookups, mySectionOptions, printHeader, printFooter, guardedSave } from './_common.js';
import { state } from '../state.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  const view = { examId: context.query?.examId || null, sectionId: null };
  const exams = await api.get('/api/exams', { status: 'published' });
  const allExams = await api.get('/api/exams');

  const host = el('div');
  const pickerHost = el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' });

  function paintPicker() {
    pickerHost.replaceChildren(
      filterSelect({
        label: 'Exam',
        width: '18rem',
        options: allExams.rows.map((row) => ({
          value: row.id,
          label: `${row.className} — ${row.name}${row.status === 'published' ? '' : ' (not published)'}`,
        })),
        value: view.examId,
        placeholder: 'Choose an exam',
        onChange: (value) => {
          view.examId = value;
          load();
        },
      }),
      filterSelect({
        label: 'Section',
        width: '12rem',
        options: mySectionOptions(),
        value: view.sectionId,
        placeholder: 'Choose a section',
        onChange: (value) => {
          view.sectionId = value;
          load();
        },
      })
    );
  }

  async function load() {
    if (!view.examId || !view.sectionId) {
      host.replaceChildren(empty('Choose an exam and a section to build the report cards.'));
      return;
    }
    host.replaceChildren(spinner('Building report cards…'));
    try {
      const data = await api.get(`/api/report-cards/${view.examId}/print`, { sectionId: view.sectionId });
      host.replaceChildren(listCard(data, view));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  paintPicker();

  container.replaceChildren(
    page({
      title: 'Report cards',
      subtitle:
        'Print one student or a whole section. Get the school’s existing card scanned before go-live — the layout is meant to match it.',
      wide: true,
      children: el('div', {}, [pickerHost, host]),
    })
  );

  if (view.examId && view.sectionId) await load();
  void exams;
}

function listCard(data, view) {
  const unpublished = data.cards.some((entry) => !entry.published);

  return el('div', { class: 'space-y-4' }, [
    unpublished
      ? el('div', { class: 'banner-warn rounded-lg' }, [
          icon('warning'),
          el('span', {
            text: 'These results are not published yet. Cards printed now are provisional and should not go to parents.',
          }),
        ])
      : null,
    card({
      title: `${data.cards.length} report card${data.cards.length === 1 ? '' : 's'} — ${data.className} ${data.sectionName}`,
      actions: [
        button('Print all', {
          variant: 'primary',
          iconName: 'print',
          onClick: () =>
            printNode(
              el('div', {}, data.cards.map((entry) => cardNode(entry, data))),
              { title: `Report cards ${data.className} ${data.sectionName}` }
            ),
        }),
      ],
      body: table({
        columns: [
          { key: 'rollNo', label: 'Roll', width: '5rem', render: (row) => fmt.text(row.enrollment?.rollNo) },
          { key: 'name', label: 'Student', render: (row) => row.student.fullName },
          { key: 'obtained', label: 'Total', render: (row) => `${row.totals.totalObtained} / ${row.totals.totalMax}` },
          { key: 'percent', label: 'Percent', render: (row) => fmt.percent(row.totals.percent) },
          { key: 'grade', label: 'Grade', render: (row) => (row.totals.grade ? chip(row.totals.grade, 'info') : '—') },
          {
            key: 'result',
            label: 'Result',
            render: (row) =>
              chip(row.totals.result, row.totals.failedSubjects ? 'bad' : row.totals.percent === null ? 'neutral' : 'good'),
          },
          {
            key: 'attendance',
            label: 'Attendance',
            render: (row) => fmt.percent(row.attendance?.percent),
          },
          {
            key: 'actions',
            label: '',
            render: (row) =>
              el('div', { class: 'flex gap-1' }, [
                button('Print', {
                  size: 'sm',
                  onClick: () => printNode(cardNode(row, data), { title: `Report card ${row.student.admissionNo}` }),
                }),
                button('Remarks', {
                  size: 'sm',
                  onClick: () => remarksFlow(view.examId, row),
                }),
              ]),
          },
        ],
        rows: data.cards,
        emptyMessage: 'No active students in this section.',
      }),
    }),
  ]);
}

/** One printable card. Kept as a single function so the layout is easy to replace. */
function cardNode(entry, context) {
  const { student, lines, totals, attendance, exam } = entry;

  return el('div', { class: 'print-page mx-auto max-w-3xl bg-white p-6 text-xs' }, [
    printHeader(
      context.school,
      'Report Card',
      `${exam.name} • ${context.academicYear} • Class ${context.className} ${context.sectionName}`
    ),

    el('div', { class: 'mb-3 grid grid-cols-3 gap-x-4 gap-y-1' }, [
      pair('Student', student.fullName),
      pair('Admission No', student.admissionNo),
      pair('Roll No', entry.enrollment?.rollNo),
      pair('Date of birth', student.dob ? fmt.date(student.dob) : '—'),
      pair('Class', `${context.className} ${context.sectionName}`),
      pair('Attendance', attendance ? fmt.percent(attendance.percent) : '—'),
    ]),

    el('table', { class: 'w-full border-collapse' }, [
      el('thead', {}, [
        el('tr', { class: 'bg-ink-100' }, [
          el('th', { class: 'border border-ink-400 px-2 py-1 text-left', text: 'Subject' }),
          el('th', { class: 'border border-ink-400 px-2 py-1 text-right', text: 'Max' }),
          el('th', { class: 'border border-ink-400 px-2 py-1 text-right', text: 'Obtained' }),
          el('th', { class: 'border border-ink-400 px-2 py-1 text-right', text: '%' }),
          el('th', { class: 'border border-ink-400 px-2 py-1 text-center', text: 'Grade' }),
          el('th', { class: 'border border-ink-400 px-2 py-1 text-center', text: 'Result' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        lines.map((line) =>
          el('tr', {}, [
            el('td', { class: 'border border-ink-400 px-2 py-1', text: line.subjectName }),
            el('td', { class: 'border border-ink-400 px-2 py-1 text-right tabular-nums', text: String(line.maxMarks) }),
            el('td', {
              class: 'border border-ink-400 px-2 py-1 text-right tabular-nums',
              text: line.isAbsent ? 'AB' : line.marksObtained === null ? '—' : String(line.marksObtained),
            }),
            el('td', {
              class: 'border border-ink-400 px-2 py-1 text-right tabular-nums',
              text: line.percent === null ? '—' : line.percent.toFixed(1),
            }),
            el('td', { class: 'border border-ink-400 px-2 py-1 text-center', text: line.grade || '—' }),
            el('td', {
              class: 'border border-ink-400 px-2 py-1 text-center',
              text: line.passed === null ? '—' : line.passed ? 'Pass' : 'Fail',
            }),
          ])
        )
      ),
      el('tfoot', {}, [
        el('tr', { class: 'bg-ink-50 font-semibold' }, [
          el('td', { class: 'border border-ink-400 px-2 py-1', text: 'Total' }),
          el('td', { class: 'border border-ink-400 px-2 py-1 text-right tabular-nums', text: String(totals.totalMax) }),
          el('td', { class: 'border border-ink-400 px-2 py-1 text-right tabular-nums', text: String(totals.totalObtained) }),
          el('td', {
            class: 'border border-ink-400 px-2 py-1 text-right tabular-nums',
            text: totals.percent === null ? '—' : totals.percent.toFixed(1),
          }),
          el('td', { class: 'border border-ink-400 px-2 py-1 text-center', text: totals.grade || '—' }),
          el('td', { class: 'border border-ink-400 px-2 py-1 text-center', text: totals.result }),
        ]),
      ]),
    ]),

    el('div', { class: 'mt-3 grid grid-cols-2 gap-4' }, [
      el('div', { class: 'rounded border border-ink-300 p-2' }, [
        el('p', { class: 'mb-1 font-semibold', text: 'Attendance' }),
        attendance
          ? el('div', { class: 'space-y-0.5' }, [
              pair('Days recorded', String(attendance.total)),
              pair('Present', String(attendance.Present + attendance.Late)),
              pair('Absent', String(attendance.Absent)),
              pair('Percentage', fmt.percent(attendance.percent)),
            ])
          : el('p', { text: 'No attendance recorded.' }),
      ]),
      el('div', { class: 'rounded border border-ink-300 p-2' }, [
        el('p', { class: 'mb-1 font-semibold', text: 'Remarks' }),
        el('p', { class: 'min-h-[3rem]', text: entry.remarks || '' }),
        entry.conduct ? el('p', { class: 'mt-1 text-ink-600', text: `Conduct: ${entry.conduct}` }) : null,
      ]),
    ]),

    el('div', { class: 'mt-10 flex justify-between' }, [
      signature('Class Teacher'),
      signature('Examination Cell'),
      signature(context.school?.principalName || 'Principal'),
      signature('Parent / Guardian'),
    ]),

    printFooter(context.generatedBy || state.user?.name, context.generatedAt),
  ]);
}

function signature(label) {
  return el('div', { class: 'text-center' }, [
    el('div', { class: 'mb-1 h-8 border-b border-ink-400', style: { width: '8rem' } }),
    el('span', { class: 'text-[10px]', text: label }),
  ]);
}

function pair(label, value) {
  return el('div', { class: 'flex gap-1' }, [
    el('span', { class: 'text-ink-500', text: `${label}:` }),
    el('span', { class: 'font-medium', text: fmt.text(value) }),
  ]);
}

async function remarksFlow(examId, entry) {
  const { formModal } = await import('../ui.js');
  formModal({
    title: `Remarks for ${entry.student.fullName}`,
    submitLabel: 'Save remarks',
    values: { remarks: entry.remarks, conduct: entry.conduct },
    columns: 1,
    fields: [
      { name: 'remarks', label: 'Remarks on the report card', type: 'textarea', rows: 3, colSpan: 'full' },
      { name: 'conduct', label: 'Conduct', placeholder: 'Excellent, Good, Satisfactory…' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () => api.put(`/api/report-cards/${examId}/student/${entry.student.id}/remarks`, values),
        {
          successMessage: 'Remarks saved.',
          onDone: () => {
            helpers.close();
            toast('Reload the list to see it on the card.', 'info', 4000);
          },
        }
      ).catch(() => {});
    },
  });
}
