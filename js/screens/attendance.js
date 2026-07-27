/**
 * Daily attendance marking (SPEC §9, T18).
 *
 * This is the screen 25 teachers hit between 8:00 and 8:30, so it is built around
 * the workflow they actually use: everyone is present by default, you tap the few
 * who are not, and you save once. No per-student round trips.
 *
 * Keyboard: P/A/L/H/V set the highlighted row, arrows and Enter move down,
 * Ctrl+S saves. A teacher can mark a class of 40 without touching the mouse.
 */

import { api } from '../api.js';
import { el, page, card, button, chip, fmt, toast, icon, spinner, empty, filterSelect, askReason, modal } from '../ui.js';
import { lookups, mySectionOptions, sectionLabel, guardedSave, readOnlyNotice, dateFilter, exportButton } from './_common.js';
import { can } from '../state.js';
import * as drafts from '../drafts.js';

const STATUS_KEYS = {
  p: 'Present',
  a: 'Absent',
  l: 'Late',
  h: 'Half Day',
  v: 'Leave',
};

const TONE = {
  Present: 'good',
  Absent: 'bad',
  Late: 'warn',
  'Half Day': 'warn',
  Leave: 'info',
};

/**
 * The marking sheet binds document-level keys. Only one sheet is ever live, so the
 * previous binding is torn down whenever the screen or the section reloads rather
 * than being left to leak.
 */
let releaseKeys = null;

function bindKeys(handler) {
  if (releaseKeys) releaseKeys();
  document.addEventListener('keydown', handler);
  releaseKeys = () => {
    document.removeEventListener('keydown', handler);
    releaseKeys = null;
  };
}

export async function render(container, context = {}) {
  if (releaseKeys) releaseKeys();
  container.replaceChildren(spinner());
  await lookups();

  const sections = mySectionOptions();
  const view = {
    sectionId: context.query?.sectionId || sections[0]?.value || null,
    date: context.query?.date || fmt.today(),
    periodNo: null,
  };

  const host = el('div');
  container.replaceChildren(
    page({
      title: 'Attendance',
      subtitle: 'Mark everyone present, then flag the absentees. One save per section.',
      actions: [
        can('attendance.report')
          ? button('Reports', { iconName: 'summarize', onClick: () => (window.location.hash = '#/attendance/reports') })
          : null,
      ],
      children: el('div', {}, [readOnlyNotice(), controls(view, () => loadSection(host, view)), host]),
    })
  );

  if (!sections.length) {
    host.replaceChildren(
      empty(
        'No sections are assigned to you yet. Ask the office to assign you as a class teacher under Settings → Academic structure.'
      )
    );
    return;
  }

  await loadSection(host, view);
}

function controls(view, reload) {
  const sections = mySectionOptions();
  return el('div', { class: 'mb-4 flex flex-wrap items-end gap-2 no-print' }, [
    filterSelect({
      label: 'Section',
      options: sections,
      value: view.sectionId,
      placeholder: sections.length ? 'Choose a section' : 'None assigned',
      width: '14rem',
      onChange: (value) => {
        view.sectionId = value;
        reload();
      },
    }),
    dateFilter({
      value: view.date,
      max: fmt.today(),
      onChange: (value) => {
        view.date = value || fmt.today();
        reload();
      },
    }),
  ]);
}

async function loadSection(host, view) {
  if (releaseKeys) releaseKeys();
  if (!view.sectionId) {
    host.replaceChildren(empty('Choose a section to start marking.'));
    return;
  }

  host.replaceChildren(spinner('Loading the class list…'));
  let data;
  try {
    data = await api.get('/api/attendance/roster', {
      sectionId: view.sectionId,
      date: view.date,
    });
  } catch (err) {
    host.replaceChildren(
      el('div', { class: 'card p-4 text-sm text-rose-700' }, [el('p', { text: err.message })])
    );
    return;
  }

  host.replaceChildren(sheet(host, view, data));
}

function sheet(host, view, data) {
  const draftId = `attendance.${view.sectionId}.${view.date}`;
  const restored = drafts.load(draftId);

  // Working copy. Everyone starts Present unless already marked or a draft exists.
  const rows = data.rows.map((row) => ({
    ...row,
    status: row.status || 'Present',
    reason: row.reason || null,
  }));

  if (restored?.payload?.entries) {
    const byStudent = new Map(restored.payload.entries.map((entry) => [entry.studentId, entry]));
    for (const row of rows) {
      const entry = byStudent.get(row.studentId);
      if (entry) {
        row.status = entry.status;
        row.reason = entry.reason;
      }
    }
  }

  let focusIndex = 0;
  let dirty = !!restored;
  const rowNodes = [];

  const summaryNode = el('div', { class: 'flex flex-wrap items-center gap-2 text-sm' });
  const saveButton = button('Save attendance', {
    variant: 'primary',
    iconName: 'save',
    onClick: () => save(),
  });
  const statusNote = el('p', { class: 'text-xs text-ink-500' });

  const unregister = drafts.register(
    draftId,
    () => (dirty ? { entries: rows.map(({ studentId, status, reason }) => ({ studentId, status, reason })) } : null),
    { label: `Attendance — ${sectionLabel(view.sectionId)} on ${fmt.date(view.date)}`, route: `#/attendance?sectionId=${view.sectionId}&date=${view.date}` }
  );

  function refreshSummary() {
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
    summaryNode.replaceChildren(
      ...Object.keys(TONE)
        .filter((status) => counts[status])
        .map((status) => chip(`${status}: ${counts[status]}`, TONE[status])),
      el('span', { class: 'text-xs text-ink-500', text: `${rows.length} students` })
    );
    statusNote.textContent = dirty
      ? 'Unsaved changes — they are kept on this device if you are interrupted.'
      : data.marked
        ? `Saved. Last marked by ${fmt.text(data.rows.find((r) => r.markedBy)?.markedBy, 'someone')} ${fmt.ago(
            data.rows.find((r) => r.markedAt)?.markedAt
          )}.`
        : 'Nothing saved yet for this date.';
  }

  function setStatus(index, status, { reason = undefined } = {}) {
    const row = rows[index];
    if (!row) return;
    if (row.status === status && reason === undefined) return;
    row.status = status;
    if (reason !== undefined) row.reason = reason;
    if (status !== 'Leave' && status !== 'Absent') row.reason = null;
    dirty = true;
    paintRow(index);
    refreshSummary();
  }

  function paintRow(index) {
    const node = rowNodes[index];
    if (!node) return;
    const row = rows[index];
    node.classList.toggle('bg-brand-50/60', index === focusIndex);
    node.dataset.status = row.status;
    for (const [status, cell] of Object.entries(node.statusButtons)) {
      const active = row.status === status;
      cell.className = active
        ? `btn btn-sm ${activeClass(status)}`
        : 'btn btn-sm bg-white text-ink-500 ring-1 ring-inset ring-ink-200 hover:bg-ink-50';
    }
    node.reasonCell.textContent = row.reason || '';
  }

  function activeClass(status) {
    return {
      Present: 'bg-emerald-600 text-white',
      Absent: 'bg-rose-600 text-white',
      Late: 'bg-amber-500 text-white',
      'Half Day': 'bg-amber-600 text-white',
      Leave: 'bg-sky-600 text-white',
    }[status];
  }

  function moveFocus(delta) {
    const next = Math.min(rows.length - 1, Math.max(0, focusIndex + delta));
    const previous = focusIndex;
    focusIndex = next;
    paintRow(previous);
    paintRow(next);
    rowNodes[next]?.scrollIntoView({ block: 'nearest' });
  }

  async function save() {
    await guardedSave(
      async () => {
        const result = await api.post('/api/attendance/mark', {
          sectionId: view.sectionId,
          date: view.date,
          entries: rows.map(({ studentId, status, reason }) => ({ studentId, status, reason })),
        });
        return result;
      },
      {
        successMessage: 'Attendance saved.',
        onDone: () => {
          dirty = false;
          drafts.clear(draftId);
          unregister();
          loadSection(host, view);
        },
      }
    ).catch(() => {});
  }

  function onKeyDown(event) {
    if (event.ctrlKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
      return;
    }
    if (event.target.matches('input, textarea, select')) return;

    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault();
      moveFocus(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
      return;
    }
    const status = STATUS_KEYS[event.key.toLowerCase()];
    if (status) {
      event.preventDefault();
      setStatus(focusIndex, status);
      if (status !== 'Absent' && status !== 'Leave') moveFocus(1);
    }
  }

  bindKeys(onKeyDown);
  const wrapper = el('div', { class: 'space-y-4' });

  /* ------------------------------------------------------------------ build */

  const lockNotice = data.lock?.locked
    ? el('div', { class: 'banner-warn rounded-lg' }, [
        icon('lock'),
        el('span', { class: 'flex-1', text: data.lock.message }),
        data.canCorrect
          ? button('Correct a record', {
              size: 'sm',
              onClick: () => openCorrection(view, rows, () => loadSection(host, view)),
            })
          : null,
      ])
    : null;

  const bulkBar = el('div', { class: 'flex flex-wrap items-center gap-2 no-print' }, [
    button('Mark all present', {
      iconName: 'done_all',
      onClick: () => {
        rows.forEach((_, index) => setStatus(index, 'Present'));
        toast('Everyone set to present. Now flag the absentees.', 'info', 3000);
      },
    }),
    button('Clear to absent', {
      onClick: () => rows.forEach((_, index) => setStatus(index, 'Absent')),
    }),
    el('span', { class: 'flex-1' }),
    saveButton,
  ]);

  const listNode = el('div', { class: 'overflow-x-auto' });
  const tableNode = el('table', { class: 'table' });
  tableNode.appendChild(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Roll', style: { width: '4rem' } }),
        el('th', { text: 'Student' }),
        el('th', { text: 'Status', style: { width: '22rem' } }),
        el('th', { text: 'Reason' }),
      ]),
    ])
  );

  const tbody = el('tbody', {});
  rows.forEach((row, index) => {
    const statusButtons = {};
    const statusCell = el(
      'td',
      { class: 'py-1' },
      el(
        'div',
        { class: 'flex flex-wrap gap-1' },
        Object.keys(TONE).map((status) => {
          const btn = el('button', {
            type: 'button',
            class: 'btn btn-sm',
            text: shortLabel(status),
            title: status,
            on: {
              click: async () => {
                focusIndex = index;
                if (status === 'Leave' || status === 'Absent') {
                  setStatus(index, status);
                  return;
                }
                setStatus(index, status);
              },
            },
          });
          statusButtons[status] = btn;
          return btn;
        })
      )
    );

    const reasonCell = el('td', { class: 'text-xs text-ink-600' });
    const reasonButton = el('button', {
      type: 'button',
      class: 'text-xs text-brand-700 hover:underline',
      text: 'note',
      on: {
        click: async () => {
          const reason = await askReason({
            title: `Reason for ${row.name}`,
            label: 'Reason',
            message: 'Recorded against this record so the office can see why.',
            minLength: 2,
            confirmLabel: 'Save note',
          });
          if (reason !== null) setStatus(index, rows[index].status, { reason });
        },
      },
    });

    const tr = el('tr', { dataset: { studentId: row.studentId } }, [
      el('td', { class: 'tabular-nums text-ink-500', text: fmt.text(row.rollNo) }),
      el('td', {}, [
        el('p', { class: 'font-medium text-ink-900', text: row.name }),
        el('p', { class: 'text-xs text-ink-500', text: row.admissionNo }),
      ]),
      statusCell,
      el('td', {}, [reasonCell, el('div', {}, [reasonButton])]),
    ]);
    tr.statusButtons = statusButtons;
    tr.reasonCell = reasonCell;
    tr.addEventListener('click', () => {
      const previous = focusIndex;
      focusIndex = index;
      paintRow(previous);
      paintRow(index);
    });
    rowNodes.push(tr);
    tbody.appendChild(tr);
  });
  tableNode.appendChild(tbody);
  listNode.appendChild(tableNode);

  wrapper.appendChild(
    el('div', {}, [
      lockNotice,
      card({
        title: `${sectionLabel(view.sectionId)} — ${fmt.date(view.date)}`,
        subtitle: 'Keyboard: P present, A absent, L late, H half day, V leave. Enter moves down. Ctrl+S saves.',
        actions: [
          data.marked ? chip('Already marked', 'good') : chip('Not marked yet', 'warn'),
          can('report.export')
            ? exportButton('/api/attendance/export/register', { date: view.date }, 'Export register')
            : null,
        ],
        body: el('div', { class: 'space-y-3' }, [summaryNode, bulkBar, listNode, statusNote]),
      }),
    ])
  );

  rows.forEach((_, index) => paintRow(index));
  refreshSummary();

  if (restored) {
    toast('Restored the attendance you had not saved.', 'info', 6000);
  }

  return wrapper;
}

function shortLabel(status) {
  return { Present: 'P', Absent: 'A', Late: 'L', 'Half Day': 'H', Leave: 'V' }[status] || status;
}

/** Correction path for a locked date: needs the permission and a recorded reason. */
async function openCorrection(view, rows, reload) {
  let dialog;
  const select = el(
    'select',
    { class: 'input' },
    rows.map((row) => el('option', { value: row.studentId, text: `${fmt.text(row.rollNo)} — ${row.name} (${row.status})` }))
  );
  const statusSelect = el(
    'select',
    { class: 'input' },
    Object.keys(TONE).map((status) => el('option', { value: status, text: status }))
  );
  const reasonInput = el('textarea', { class: 'input', rows: 3, placeholder: 'Why is this being changed?' });
  const errorNode = el('p', { class: 'field-error hidden' });

  dialog = modal({
    title: 'Correct a locked record',
    size: 'sm',
    body: el('div', { class: 'space-y-3' }, [
      el('p', {
        class: 'text-sm text-ink-600',
        text: 'The old value, the new value and your reason are all recorded in the audit log.',
      }),
      el('div', {}, [el('label', { class: 'label', text: 'Student' }), select]),
      el('div', {}, [el('label', { class: 'label', text: 'New status' }), statusSelect]),
      el('div', {}, [el('label', { class: 'label', text: 'Reason' }), reasonInput, errorNode]),
    ]),
    actions: (close) => [
      button('Cancel', { onClick: close }),
      button('Save correction', {
        variant: 'primary',
        onClick: async () => {
          const reason = reasonInput.value.trim();
          if (reason.length < 3) {
            errorNode.textContent = 'Write a reason of at least a few words.';
            errorNode.classList.remove('hidden');
            return;
          }
          try {
            await guardedSave(
              () =>
                api.post('/api/attendance/correct', {
                  date: view.date,
                  studentId: select.value,
                  sectionId: view.sectionId,
                  newStatus: statusSelect.value,
                  reason,
                }),
              {
                successMessage: 'Correction recorded.',
                onDone: () => {
                  close();
                  reload();
                },
              }
            );
          } catch (err) {
            errorNode.textContent = err.message;
            errorNode.classList.remove('hidden');
          }
        },
      }),
    ],
  });
  return dialog;
}
