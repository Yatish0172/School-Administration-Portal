/**
 * Marks entry grid (SPEC §10, T24).
 *
 * Keyboard-navigable and saves incrementally: Enter moves down, the grid
 * auto-saves as the teacher works, and a blank stays blank rather than becoming a
 * zero. Absent is a flag, not a mark of nought.
 */

import { api } from '../api.js';
import { el, page, card, button, fmt, toast, spinner, chip, empty, filterSelect, icon } from '../ui.js';
import { lookups, mySectionOptions, guardedSave, readOnlyNotice, exportButton } from './_common.js';
import * as drafts from '../drafts.js';

let releaseKeys = null;

export async function render(container, context = {}) {
  if (releaseKeys) releaseKeys();
  container.replaceChildren(spinner());
  await lookups();

  const view = {
    examId: context.query?.examId || null,
    examSubjectId: null,
    sectionId: null,
  };

  const pickerHost = el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' });
  const gridHost = el('div');

  const exams = await api.get('/api/exams');

  async function paintPicker() {
    const subjectOptions = view.examId
      ? (await api.get(`/api/exams/${view.examId}`)).examSubjects.map((row) => ({
          value: row.id,
          label: `${row.subjectName} (max ${row.maxMarks})`,
        }))
      : [];

    pickerHost.replaceChildren(
      filterSelect({
        label: 'Exam',
        width: '16rem',
        options: exams.rows.map((row) => ({
          value: row.id,
          label: `${row.className} — ${row.name}${row.status === 'published' ? ' (published)' : ''}`,
        })),
        value: view.examId,
        placeholder: 'Choose an exam',
        onChange: async (value) => {
          view.examId = value;
          view.examSubjectId = null;
          await paintPicker();
          gridHost.replaceChildren(empty('Now choose a subject and section.'));
        },
      }),
      filterSelect({
        label: 'Subject',
        width: '16rem',
        options: subjectOptions,
        value: view.examSubjectId,
        placeholder: subjectOptions.length ? 'Choose a subject' : 'Set the date sheet first',
        onChange: (value) => {
          view.examSubjectId = value;
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
    if (releaseKeys) releaseKeys();
    if (!view.examId || !view.examSubjectId || !view.sectionId) {
      gridHost.replaceChildren(empty('Choose an exam, subject and section to start.'));
      return;
    }
    gridHost.replaceChildren(spinner('Loading the marks grid…'));
    try {
      const data = await api.get('/api/marks/grid', {
        examId: view.examId,
        examSubjectId: view.examSubjectId,
        sectionId: view.sectionId,
      });
      gridHost.replaceChildren(gridCard(view, data, load));
    } catch (err) {
      gridHost.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  await paintPicker();

  container.replaceChildren(
    page({
      title: 'Marks entry',
      subtitle: 'Enter moves down the list. Blank means no mark yet — use the absent box for absentees.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), pickerHost, gridHost]),
    })
  );

  if (view.examId) await load();
}

function gridCard(view, data, reload) {
  const maxMarks = Number(data.examSubject.maxMarks);
  const passMarks = Number(data.examSubject.passMarks);
  const locked = data.locked;
  const rows = data.rows.map((row) => ({ ...row }));
  const draftId = `marks.${view.examSubjectId}.${view.sectionId}`;
  const restored = drafts.load(draftId);

  if (restored?.payload?.entries && !locked) {
    const byStudent = new Map(restored.payload.entries.map((entry) => [entry.studentId, entry]));
    for (const row of rows) {
      const entry = byStudent.get(row.studentId);
      if (entry) {
        row.marksObtained = entry.marksObtained;
        row.isAbsent = entry.isAbsent;
      }
    }
    toast('Restored the marks you had not saved.', 'info', 6000);
  }

  let dirty = !!restored;
  const inputs = [];
  const summaryNode = el('div', { class: 'flex flex-wrap items-center gap-2 text-sm' });
  const saveNote = el('p', { class: 'text-xs text-ink-500' });

  const unregister = drafts.register(
    draftId,
    () =>
      dirty
        ? { entries: rows.map(({ studentId, marksObtained, isAbsent }) => ({ studentId, marksObtained, isAbsent })) }
        : null,
    {
      label: `Marks — ${data.examSubject.subjectName || 'subject'} for ${data.exam.name}`,
      route: `#/marks?examId=${view.examId}`,
    }
  );

  function refreshSummary() {
    const entered = rows.filter((row) => row.marksObtained !== null && row.marksObtained !== '' && !row.isAbsent);
    const absent = rows.filter((row) => row.isAbsent);
    const failing = entered.filter((row) => Number(row.marksObtained) < passMarks);
    const values = entered.map((row) => Number(row.marksObtained));
    const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

    summaryNode.replaceChildren(
      chip(`${entered.length} of ${rows.length} entered`, entered.length === rows.length ? 'good' : 'warn'),
      absent.length ? chip(`${absent.length} absent`, 'info') : null,
      failing.length ? chip(`${failing.length} below pass`, 'bad') : null,
      average !== null ? chip(`Average ${average.toFixed(1)}`, 'neutral') : null
    );
    saveNote.textContent = dirty ? 'Unsaved changes — kept on this device if you are interrupted.' : 'Saved.';
  }

  async function save({ quiet = false } = {}) {
    if (!dirty) return;
    try {
      await guardedSave(
        () =>
          api.post('/api/marks', {
            examId: view.examId,
            examSubjectId: view.examSubjectId,
            sectionId: view.sectionId,
            entries: rows.map((row) => ({
              studentId: row.studentId,
              enrollmentId: row.enrollmentId,
              marksObtained: row.isAbsent ? null : row.marksObtained,
              isAbsent: row.isAbsent,
            })),
          }),
        {
          successMessage: quiet ? null : 'Marks saved.',
          onDone: () => {
            dirty = false;
            drafts.clear(draftId);
            refreshSummary();
          },
        }
      );
    } catch (err) {
      // guardedSave has reported it; the draft stays so nothing is lost.
    }
  }

  // Incremental save while the teacher works, so a browser crash costs seconds.
  let autoSaveTimer = null;
  function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => save({ quiet: true }), 4000);
  }

  function onKeyDown(event) {
    if (event.ctrlKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  }
  document.addEventListener('keydown', onKeyDown);
  releaseKeys = () => {
    document.removeEventListener('keydown', onKeyDown);
    clearTimeout(autoSaveTimer);
    unregister();
    releaseKeys = null;
  };

  const tableNode = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Roll', style: { width: '5rem' } }),
        el('th', { text: 'Student' }),
        el('th', { text: `Marks (max ${maxMarks})`, style: { width: '10rem' } }),
        el('th', { text: 'Absent', style: { width: '6rem' } }),
        el('th', { text: 'Result', style: { width: '7rem' } }),
      ]),
    ]),
  ]);

  const tbody = el('tbody', {});
  rows.forEach((row, index) => {
    const resultCell = el('td', {});

    const markInput = el('input', {
      class: 'input w-24 text-right tabular-nums',
      type: 'number',
      min: '0',
      max: String(maxMarks),
      step: '0.5',
      value: row.marksObtained ?? '',
      disabled: locked || row.isAbsent,
      inputMode: 'decimal',
    });

    const absentBox = el('input', {
      type: 'checkbox',
      class: 'h-4 w-4 rounded border-ink-300 text-brand-600',
      checked: !!row.isAbsent,
      disabled: locked,
    });

    function paintResult() {
      resultCell.replaceChildren();
      if (row.isAbsent) {
        resultCell.appendChild(chip('Absent', 'info'));
        return;
      }
      if (row.marksObtained === null || row.marksObtained === '') return;
      const value = Number(row.marksObtained);
      const percent = (value / maxMarks) * 100;
      resultCell.appendChild(
        chip(`${percent.toFixed(0)}%`, value >= passMarks ? 'good' : 'bad')
      );
    }

    markInput.addEventListener('input', () => {
      let value = markInput.value === '' ? null : Number(markInput.value);
      if (value !== null && value > maxMarks) {
        value = maxMarks;
        markInput.value = String(maxMarks);
        toast(`The maximum for this subject is ${maxMarks}.`, 'warn', 3000);
      }
      row.marksObtained = value;
      dirty = true;
      paintResult();
      refreshSummary();
      scheduleAutoSave();
    });

    markInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === 'ArrowDown') {
        event.preventDefault();
        inputs[index + 1]?.focus();
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        inputs[index - 1]?.focus();
      }
    });

    absentBox.addEventListener('change', () => {
      row.isAbsent = absentBox.checked;
      if (row.isAbsent) row.marksObtained = null;
      markInput.disabled = locked || row.isAbsent;
      markInput.value = row.marksObtained ?? '';
      dirty = true;
      paintResult();
      refreshSummary();
      scheduleAutoSave();
    });

    inputs.push(markInput);
    paintResult();

    tbody.appendChild(
      el('tr', {}, [
        el('td', { class: 'tabular-nums text-ink-500', text: fmt.text(row.rollNo) }),
        el('td', {}, [
          el('p', { class: 'font-medium text-ink-900', text: row.name }),
          el('p', { class: 'text-xs text-ink-500', text: row.admissionNo }),
        ]),
        el('td', {}, [markInput]),
        el('td', {}, [absentBox]),
        resultCell,
      ])
    );
  });
  tableNode.appendChild(tbody);

  refreshSummary();

  return card({
    title: `${data.exam.name} — ${data.examSubject.subjectName || 'subject'}`,
    subtitle: `Maximum ${maxMarks}, pass ${passMarks}. Saves automatically as you type; Ctrl+S saves now.`,
    actions: [
      locked ? chip('Published — read only', 'good') : null,
      exportButton(`/api/exams/${view.examId}/export/analytics`, { sectionId: view.sectionId }, 'Analytics'),
      locked ? null : button('Save now', { variant: 'primary', iconName: 'save', onClick: () => save() }),
    ],
    body: el('div', { class: 'space-y-3' }, [
      locked
        ? el('div', { class: 'banner-info rounded-lg' }, [
            icon('lock'),
            el('span', { text: 'These results are published. Reopen the exam to make a correction.' }),
          ])
        : null,
      summaryNode,
      el('div', { class: 'overflow-x-auto' }, [tableNode]),
      saveNote,
    ]),
  });
}
