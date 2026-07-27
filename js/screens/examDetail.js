/**
 * One exam: the date sheet, marks progress and the publication lock (SPEC §10).
 *
 * Publishing is refused while marks are missing unless the Exam Cell explicitly
 * overrides it — an incomplete report card reaching a parent is the expensive kind
 * of mistake.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, toast, confirm, askReason, icon, empty } from '../ui.js';
import { lookups, subjectOptions, guardedSave, readOnlyNotice } from './_common.js';
import { can } from '../state.js';
import { navigate } from '../router.js';

export async function render(container, context) {
  const examId = context.params.id;
  container.replaceChildren(spinner());
  await lookups();

  async function load() {
    const data = await api.get(`/api/exams/${examId}`);
    container.replaceChildren(build(data, load));
  }

  await load();
}

function build(data, reload) {
  const exam = data.exam;
  const published = exam.status === 'published';
  const rows = data.examSubjects.map((row) => ({ ...row }));

  return page({
    title: exam.name,
    subtitle: `${data.sections.length} section(s) • ${
      exam.startDate ? `${fmt.date(exam.startDate)} to ${fmt.date(exam.endDate)}` : 'dates not set'
    }`,
    wide: true,
    actions: [
      published ? chip('Published — marks are locked', 'good') : chip(fmt.humanise(exam.status), 'warn'),
      can('result.analytics')
        ? button('Analytics', { iconName: 'insights', onClick: () => navigate(`/exams/analytics?examId=${exam.id}`) })
        : null,
      can('reportcard.generate')
        ? button('Report cards', { iconName: 'description', onClick: () => navigate(`/report-cards?examId=${exam.id}`) })
        : null,
      can('marks.enter') && !published
        ? button('Enter marks', {
            variant: 'primary',
            iconName: 'edit_note',
            onClick: () => navigate(`/marks?examId=${exam.id}`),
          })
        : null,
    ],
    children: el('div', { class: 'space-y-4' }, [
      readOnlyNotice(),
      published
        ? el('div', { class: 'banner-info rounded-lg' }, [
            icon('lock'),
            el('span', { class: 'flex-1', text: `Published ${fmt.dateTime(exam.publishedAt)}. Marks cannot be changed until the exam is reopened.` }),
            can('marks.publish')
              ? button('Reopen', { size: 'sm', onClick: () => unpublish(exam, reload) })
              : null,
          ])
        : null,
      data.missing && data.missing.total > 0
        ? el('div', { class: 'banner-warn rounded-lg' }, [
            icon('warning'),
            el('span', {
              class: 'flex-1',
              text: `${data.missing.total} mark(s) are still blank across ${data.missing.subjects.length} subject(s), for ${data.missing.students} students.`,
            }),
          ])
        : null,
      dateSheetCard(data, rows, reload),
      publishCard(data, reload),
    ]),
  });
}

function dateSheetCard(data, rows, reload) {
  const published = data.exam.status === 'published';
  const available = subjectOptions(data.exam.classId);
  const used = new Set(rows.map((row) => row.subjectId));

  const addSelect = el(
    'select',
    { class: 'input', style: { width: '14rem' } },
    [
      el('option', { value: '', text: 'Add a subject…' }),
      ...available
        .filter((option) => !used.has(option.value))
        .map((option) => el('option', { value: option.value, text: option.label })),
    ]
  );

  addSelect.addEventListener('change', () => {
    if (!addSelect.value) return;
    rows.push({ subjectId: addSelect.value, maxMarks: 100, passMarks: 33, examDate: null, startTime: null, endTime: null, weightage: 100 });
    reloadTable();
    addSelect.value = '';
  });

  const tableHost = el('div');

  function reloadTable() {
    tableHost.replaceChildren(
      rows.length
        ? table({
            columns: [
              {
                key: 'subjectId',
                label: 'Subject',
                render: (row) => available.find((option) => option.value === row.subjectId)?.label || row.subjectName || '—',
              },
              {
                key: 'examDate',
                label: 'Date',
                render: (row) => input(row, 'examDate', 'date', published),
              },
              { key: 'startTime', label: 'From', render: (row) => input(row, 'startTime', 'time', published) },
              { key: 'endTime', label: 'To', render: (row) => input(row, 'endTime', 'time', published) },
              { key: 'maxMarks', label: 'Max', render: (row) => input(row, 'maxMarks', 'number', published, '5rem') },
              { key: 'passMarks', label: 'Pass', render: (row) => input(row, 'passMarks', 'number', published, '5rem') },
              {
                key: 'remove',
                label: '',
                render: (row) =>
                  published
                    ? null
                    : button('Remove', {
                        size: 'sm',
                        onClick: () => {
                          const index = rows.indexOf(row);
                          if (index >= 0) rows.splice(index, 1);
                          reloadTable();
                        },
                      }),
              },
            ],
            rows,
          })
        : empty('No subjects on the date sheet yet. Add them above.')
    );
  }

  reloadTable();

  return card({
    title: 'Subjects and date sheet',
    subtitle: 'Marks entry uses these maximums, so get them right before teachers start.',
    actions: published || !can('exam.setup')
      ? null
      : [
          addSelect,
          button('Save date sheet', {
            variant: 'primary',
            iconName: 'save',
            onClick: async () => {
              await guardedSave(
                () =>
                  api.put(`/api/exams/${data.exam.id}/subjects`, {
                    subjects: rows.map((row) => ({
                      subjectId: row.subjectId,
                      maxMarks: Number(row.maxMarks) || 100,
                      passMarks: Number(row.passMarks) || 0,
                      examDate: row.examDate || null,
                      startTime: row.startTime || null,
                      endTime: row.endTime || null,
                      weightage: Number(row.weightage) || 100,
                    })),
                  }),
                { successMessage: 'Date sheet saved.', onDone: reload }
              ).catch(() => {});
            },
          }),
        ],
    body: tableHost,
  });
}

function input(row, key, type, disabled, width = '9rem') {
  const node = el('input', {
    class: 'input',
    type,
    value: row[key] ?? '',
    disabled,
    style: { width },
    min: type === 'number' ? '0' : null,
  });
  node.addEventListener('input', () => {
    row[key] = node.value === '' ? null : type === 'number' ? Number(node.value) : node.value;
  });
  return node;
}

function publishCard(data, reload) {
  if (!can('marks.publish')) return null;
  const exam = data.exam;
  if (exam.status === 'published') return null;

  return card({
    title: 'Publish results',
    subtitle:
      'Once published, marks become read-only and report cards can be printed. Reopening needs a recorded reason.',
    body: el('div', { class: 'flex flex-wrap items-center gap-2' }, [
      button('Publish results', {
        variant: 'primary',
        iconName: 'publish',
        onClick: async () => {
          const proceed = await confirm({
            title: `Publish ${exam.name}?`,
            message: 'Marks become read-only for everyone, including the Exam Cell.',
            detail: 'Report cards can be printed straight away. Reopening is possible but recorded.',
            confirmLabel: 'Publish',
          });
          if (!proceed) return;

          try {
            await api.post(`/api/exams/${exam.id}/publish`, {});
            toast('Results published.', 'good');
            reload();
          } catch (err) {
            if (/blank/.test(err.message)) {
              const force = await confirm({
                title: 'Some marks are missing',
                message: err.message,
                detail: 'Publishing now leaves those students with no mark for those subjects.',
                confirmLabel: 'Publish anyway',
                danger: true,
              });
              if (!force) return;
              await guardedSave(() => api.post(`/api/exams/${exam.id}/publish`, { force: true }), {
                successMessage: 'Results published with blanks.',
                onDone: reload,
              }).catch(() => {});
            } else {
              toast(err.message, 'bad');
            }
          }
        },
      }),
    ]),
  });
}

async function unpublish(exam, reload) {
  const reason = await askReason({
    title: `Reopen ${exam.name}`,
    label: 'Why are published results being reopened?',
    message: 'This is recorded in the audit log against your name.',
    confirmLabel: 'Reopen',
    minLength: 5,
  });
  if (reason === null) return;
  await guardedSave(() => api.post(`/api/exams/${exam.id}/unpublish`, { reason }), {
    successMessage: 'Exam reopened for corrections.',
    onDone: reload,
  }).catch(() => {});
}
