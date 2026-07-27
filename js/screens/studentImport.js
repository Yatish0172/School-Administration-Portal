/**
 * Excel import for students (SPEC §15, T17).
 *
 * Validate, then commit. Nothing reaches the student data until the office has seen
 * the row-level errors and pressed Import — because schools hand over spreadsheets
 * with merged cells, dates stored as text and three students sharing an admission
 * number.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, toast, icon, stat, grid, confirm, empty } from '../ui.js';
import { lookups, yearOptions, guardedSave, readOnlyNotice } from './_common.js';
import { navigate } from '../router.js';

export async function render(container) {
  container.replaceChildren(spinner());
  await lookups();

  const host = el('div');
  const fileInput = el('input', { type: 'file', accept: '.xlsx', class: 'hidden' });
  const yearSelect = el(
    'select',
    { class: 'input', style: { width: '14rem' } },
    yearOptions().map((option) => el('option', { value: option.value, text: option.label }))
  );

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files?.length) return;
    host.replaceChildren(spinner('Checking every row…'));
    const body = new FormData();
    body.append('file', fileInput.files[0]);
    body.append('academicYearId', yearSelect.value);
    try {
      const result = await api.upload('/api/imports/validate', body);
      host.replaceChildren(validationResult(result, host));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
    fileInput.value = '';
  });

  container.replaceChildren(
    page({
      title: 'Import students from Excel',
      subtitle: 'Nothing is saved until you have seen the errors and pressed Import.',
      wide: true,
      actions: [
        button('Back to students', { onClick: () => navigate('/students') }),
        button('Download the template', {
          iconName: 'download',
          onClick: async () => {
            try {
              await api.download('/api/imports/template', null, 'student-import-template.xlsx');
              toast('Template downloaded. Fill it in and upload it back.', 'good');
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        }),
      ],
      children: el('div', { class: 'space-y-4' }, [
        readOnlyNotice(),
        card({
          title: 'How this works',
          body: el('div', { class: 'space-y-2 text-sm text-ink-700' }, [
            step(1, 'Download the versioned template. Do not rename or reorder its columns.'),
            step(2, 'Fill it in. Classes and sections must already exist for the year you are importing into.'),
            step(3, 'Upload it here. Every row is checked and you get a report — nothing is saved yet.'),
            step(4, 'Fix anything flagged, or import just the good rows and deal with the rest by hand.'),
            step(5, 'Press Import. It runs as one operation that rolls back if anything goes wrong.'),
          ]),
        }),
        card({
          title: 'Upload a filled-in template',
          body: el('div', { class: 'flex flex-wrap items-end gap-3' }, [
            el('div', {}, [el('label', { class: 'label', text: 'Import into' }), yearSelect]),
            button('Choose the file', { variant: 'primary', iconName: 'upload_file', onClick: () => fileInput.click() }),
            fileInput,
          ]),
        }),
        host,
        historyCard(),
      ]),
    })
  );
}

function step(number, text) {
  return el('div', { class: 'flex gap-2' }, [
    el('span', {
      class: 'flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand-600 text-[11px] font-bold text-white',
      text: String(number),
    }),
    el('span', { class: 'flex-1', text }),
  ]);
}

function validationResult(result, host) {
  const errors = result.problems.filter((problem) => problem.severity === 'error');
  const warnings = result.problems.filter((problem) => problem.severity === 'warning');

  return el('div', { class: 'space-y-4' }, [
    grid(3, [
      stat({ label: 'Rows in the file', value: fmt.number(result.totalRows) }),
      stat({
        label: 'Ready to import',
        value: fmt.number(result.validRows),
        tone: result.validRows ? 'good' : 'bad',
      }),
      stat({
        label: 'Rows with errors',
        value: fmt.number(result.errorRows),
        tone: result.errorRows ? 'warn' : 'good',
      }),
    ]),

    result.unknownColumns.length
      ? el('div', { class: 'banner-warn rounded-lg' }, [
          icon('warning'),
          el('span', {
            text: `These columns were ignored because they are not in the template: ${result.unknownColumns.join(', ')}`,
          }),
        ])
      : null,

    card({
      title: result.validRows ? `Import ${result.validRows} student(s)?` : 'Nothing can be imported yet',
      subtitle: result.errorRows
        ? `${result.errorRows} row(s) will be skipped. Fix them in the spreadsheet and upload again, or import the good rows now and handle the rest by hand.`
        : 'Every row passed validation.',
      actions: [
        button('Discard', {
          onClick: async () => {
            await api.post(`/api/imports/${result.batch.id}/discard`).catch(() => {});
            toast('Import discarded.', 'info');
            host.replaceChildren();
          },
        }),
        result.validRows
          ? button(`Import ${result.validRows} student(s)`, {
              variant: 'primary',
              iconName: 'check',
              onClick: async () => {
                const proceed = await confirm({
                  title: `Import ${result.validRows} student(s)?`,
                  message: 'Each one gets an admission number, their guardians and an enrollment.',
                  detail: 'This runs as one operation. If anything fails part-way, the whole import rolls back.',
                  confirmLabel: 'Import now',
                });
                if (!proceed) return;
                await guardedSave(() => api.post(`/api/imports/${result.batch.id}/commit`), {
                  successMessage: null,
                  onDone: (committed) => {
                    toast(
                      committed.failures.length
                        ? `Imported ${committed.imported}. ${committed.failures.length} row(s) failed — see the history below.`
                        : `Imported ${committed.imported} students.`,
                      committed.failures.length ? 'warn' : 'good',
                      9000
                    );
                    host.replaceChildren();
                    navigate('/students');
                  },
                }).catch(() => {});
              },
            })
          : null,
      ],
      body: el('div', { class: 'space-y-4' }, [
        result.preview.length
          ? el('div', {}, [
              el('p', { class: 'mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500', text: 'First few rows that will import' }),
              table({
                dense: true,
                columns: [
                  { key: 'rowNumber', label: 'Row', width: '4rem', type: 'num' },
                  { key: 'name', label: 'Student', render: (row) => `${row.student.firstName} ${row.student.lastName || ''}` },
                  { key: 'admissionNo', label: 'Admission No', render: (row) => row.student.admissionNo || 'auto' },
                  { key: 'dob', label: 'Date of birth', render: (row) => (row.student.dob ? fmt.date(row.student.dob) : '—') },
                  {
                    key: 'guardians',
                    label: 'Guardians',
                    render: (row) => row.guardians.map((guardian) => guardian.name).join(', '),
                  },
                  { key: 'rollNo', label: 'Roll', render: (row) => row.enrollment.rollNo || 'next free' },
                ],
                rows: result.preview,
              }),
            ])
          : null,

        errors.length
          ? el('div', {}, [
              el('p', { class: 'mb-1 text-xs font-semibold uppercase tracking-wide text-rose-600', text: `${errors.length} problem(s) that stop a row` }),
              table({
                dense: true,
                columns: [
                  { key: 'rowNumber', label: 'Row', width: '4rem', type: 'num' },
                  { key: 'column', label: 'Column', width: '12rem' },
                  { key: 'value', label: 'What was there', width: '12rem' },
                  { key: 'message', label: 'Problem' },
                ],
                rows: errors,
              }),
            ])
          : null,

        warnings.length
          ? el('div', {}, [
              el('p', { class: 'mb-1 text-xs font-semibold uppercase tracking-wide text-amber-600', text: `${warnings.length} thing(s) that were cleaned up` }),
              table({
                dense: true,
                columns: [
                  { key: 'rowNumber', label: 'Row', width: '4rem', type: 'num' },
                  { key: 'column', label: 'Column', width: '12rem' },
                  { key: 'value', label: 'What was there', width: '12rem' },
                  { key: 'message', label: 'What happened' },
                ],
                rows: warnings,
              }),
            ])
          : null,
      ]),
    }),
  ]);
}

function historyCard() {
  const host = el('div', {}, [spinner()]);
  api
    .get('/api/imports')
    .then((data) => {
      host.replaceChildren(
        card({
          title: 'Import history',
          body: table({
            dense: true,
            columns: [
              { key: 'uploadedAt', label: 'When', type: 'dateTime', width: '13rem' },
              { key: 'fileName', label: 'File' },
              { key: 'totalRows', label: 'Rows', type: 'num' },
              { key: 'validRows', label: 'Valid', type: 'num' },
              { key: 'errorRows', label: 'Errors', type: 'num' },
              { key: 'importedRows', label: 'Imported', type: 'num' },
              { key: 'status', label: 'Status', type: 'status', width: '9rem' },
              { key: 'error', label: 'Note' },
            ],
            rows: data.rows,
            emptyMessage: 'No imports have been run yet.',
          }),
        })
      );
    })
    .catch((err) => {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    });
  return host;
}

void chip;
void empty;
