/**
 * Result analytics (SPEC §10, T27): subject averages, pass percentage, toppers,
 * the failure list, and term comparison.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, tabs, filterSelect, empty, stat, grid } from '../ui.js';
import { lookups, classOptions, sectionOptions, exportButton } from './_common.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  const exams = await api.get('/api/exams');
  const view = {
    examId: context.query?.examId || exams.rows.find((row) => row.status === 'published')?.id || exams.rows[0]?.id || null,
    sectionId: null,
    classId: null,
    tab: 'exam',
  };

  const host = el('div');
  const pickerHost = el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' });

  function paintPicker() {
    if (view.tab === 'exam') {
      pickerHost.replaceChildren(
        filterSelect({
          label: 'Exam',
          width: '18rem',
          options: exams.rows.map((row) => ({ value: row.id, label: `${row.className} — ${row.name}` })),
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
          options: sectionOptions(exams.rows.find((row) => row.id === view.examId)?.classId),
          value: view.sectionId,
          placeholder: 'Whole class',
          onChange: (value) => {
            view.sectionId = value;
            load();
          },
        }),
        view.examId
          ? exportButton(`/api/exams/${view.examId}/export/analytics`, { sectionId: view.sectionId })
          : null
      );
    } else {
      pickerHost.replaceChildren(
        filterSelect({
          label: 'Class',
          options: classOptions(),
          value: view.classId,
          placeholder: 'Choose a class',
          onChange: (value) => {
            view.classId = value;
            view.sectionId = null;
            paintPicker();
            load();
          },
        }),
        filterSelect({
          label: 'Section',
          width: '12rem',
          options: sectionOptions(view.classId),
          value: view.sectionId,
          placeholder: 'Whole class',
          onChange: (value) => {
            view.sectionId = value;
            load();
          },
        })
      );
    }
  }

  async function load() {
    host.replaceChildren(spinner());
    try {
      if (view.tab === 'exam') {
        if (!view.examId) {
          host.replaceChildren(empty('Choose an exam.'));
          return;
        }
        const data = await api.get(`/api/exams/${view.examId}/analytics`, { sectionId: view.sectionId });
        host.replaceChildren(examView(data));
      } else {
        if (!view.classId) {
          host.replaceChildren(empty('Choose a class to compare its terms.'));
          return;
        }
        const data = await api.get('/api/exams/analytics/comparison', {
          classId: view.classId,
          sectionId: view.sectionId,
        });
        host.replaceChildren(comparisonView(data));
      }
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Result analytics',
      wide: true,
      children: el('div', {}, [
        tabs(
          [
            { key: 'exam', label: 'One exam' },
            { key: 'comparison', label: 'Term comparison' },
          ],
          view.tab,
          (key) => {
            view.tab = key;
            paintPicker();
            load();
          }
        ),
        pickerHost,
        host,
      ]),
    })
  );

  paintPicker();
  await load();
}

function examView(data) {
  const summary = data.summary;
  return el('div', { class: 'space-y-4' }, [
    grid(4, [
      stat({ label: 'Appeared', value: fmt.number(summary.appeared) }),
      stat({
        label: 'Passed',
        value: fmt.number(summary.passed),
        sub: fmt.percent(summary.passPercent),
        tone: summary.passPercent >= 90 ? 'good' : summary.passPercent >= 70 ? 'warn' : 'bad',
      }),
      stat({ label: 'Class average', value: fmt.percent(summary.classAverage) }),
      stat({
        label: 'Needing attention',
        value: fmt.number(data.failures.length),
        tone: data.failures.length ? 'warn' : 'good',
      }),
    ]),
    card({
      title: 'By subject',
      body: table({
        columns: [
          { key: 'subjectName', label: 'Subject' },
          { key: 'maxMarks', label: 'Max', type: 'num' },
          { key: 'entered', label: 'Appeared', type: 'num' },
          { key: 'absent', label: 'Absent', type: 'num' },
          { key: 'average', label: 'Average', type: 'num' },
          { key: 'highest', label: 'Highest', type: 'num' },
          { key: 'lowest', label: 'Lowest', type: 'num' },
          {
            key: 'passPercent',
            label: 'Pass %',
            render: (row) =>
              row.passPercent === null
                ? '—'
                : chip(fmt.percent(row.passPercent), row.passPercent >= 90 ? 'good' : row.passPercent >= 70 ? 'warn' : 'bad'),
          },
        ],
        rows: data.bySubject,
        emptyMessage: 'No marks entered yet.',
      }),
    }),
    el('div', { class: 'grid grid-cols-1 gap-4 lg:grid-cols-2' }, [
      card({
        title: 'Toppers',
        body: table({
          dense: true,
          columns: [
            { key: 'rank', label: '#', width: '3rem', type: 'num' },
            { key: 'name', label: 'Student' },
            { key: 'obtained', label: 'Marks', render: (row) => `${row.obtained} / ${row.max}` },
            { key: 'percent', label: 'Percent', type: 'percent' },
          ],
          rows: data.toppers,
          emptyMessage: 'No results yet.',
        }),
      }),
      card({
        title: `Needing attention (${data.failures.length})`,
        body: table({
          dense: true,
          columns: [
            { key: 'name', label: 'Student' },
            { key: 'percent', label: 'Percent', type: 'percent' },
            { key: 'failedSubjects', label: 'Below pass', type: 'num' },
            { key: 'absentSubjects', label: 'Absent', type: 'num' },
          ],
          rows: data.failures,
          emptyMessage: 'Everyone passed every subject.',
        }),
      }),
    ]),
    card({
      title: 'Full ranking',
      body: table({
        dense: true,
        columns: [
          { key: 'rank', label: '#', width: '3rem', type: 'num' },
          { key: 'admissionNo', label: 'Admission No' },
          { key: 'name', label: 'Student' },
          { key: 'obtained', label: 'Obtained', type: 'num' },
          { key: 'max', label: 'Total', type: 'num' },
          { key: 'percent', label: 'Percent', type: 'percent' },
          { key: 'failedSubjects', label: 'Below pass', type: 'num' },
        ],
        rows: data.ranked,
        emptyMessage: 'No results yet.',
      }),
    }),
  ]);
}

function comparisonView(data) {
  if (!data.exams.length) {
    return empty('No published exams to compare yet.');
  }
  const columns = [
    { key: 'rollNo', label: 'Roll', width: '5rem' },
    { key: 'name', label: 'Student' },
    ...data.exams.map((exam) => ({
      key: exam.id,
      label: exam.name,
      type: 'percent',
      render: (row) => (row.terms[exam.id] === null ? '—' : fmt.percent(row.terms[exam.id])),
    })),
    {
      key: 'trend',
      label: 'Trend',
      render: (row) => {
        const values = data.exams.map((exam) => row.terms[exam.id]).filter((value) => value !== null);
        if (values.length < 2) return '—';
        const change = values[values.length - 1] - values[0];
        return chip(
          `${change > 0 ? '+' : ''}${change.toFixed(1)}%`,
          change > 1 ? 'good' : change < -1 ? 'bad' : 'neutral'
        );
      },
    },
  ];

  return card({
    title: 'Term comparison',
    subtitle: 'Percentage per published exam, so a slipping student is visible early.',
    body: table({ columns, rows: data.rows, emptyMessage: 'No students in this class.' }),
  });
}

void button;
