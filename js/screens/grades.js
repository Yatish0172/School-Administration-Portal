/**
 * Grade bands (SPEC §10, T25). Mark ranges map to grades, optionally per class.
 * Overlapping bands are refused server-side, so a mark can never resolve to two
 * grades.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, toast, filterSelect, chip } from '../ui.js';
import { lookups, classOptions, guardedSave, readOnlyNotice } from './_common.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  const view = { classId: context.query?.classId || null };
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/grades', { classId: view.classId });
      host.replaceChildren(editor(data.rows, view, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Grade bands',
      subtitle: 'Mark ranges become grades on report cards. Leave the class blank for a school-wide set.',
      children: el('div', {}, [
        readOnlyNotice(),
        el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
          filterSelect({
            label: 'Applies to',
            options: classOptions(),
            value: view.classId,
            placeholder: 'All classes',
            width: '14rem',
            onChange: (value) => {
              view.classId = value;
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

function editor(existing, view, reload) {
  const rows = existing.length
    ? existing.map((row) => ({ ...row }))
    : [{ grade: '', minPercent: 0, maxPercent: 100, points: null, description: '' }];

  const tableHost = el('div');

  function paint() {
    tableHost.replaceChildren(
      table({
        columns: [
          { key: 'grade', label: 'Grade', render: (row) => input(row, 'grade', 'text', '6rem') },
          { key: 'minPercent', label: 'From %', render: (row) => input(row, 'minPercent', 'number', '6rem') },
          { key: 'maxPercent', label: 'To %', render: (row) => input(row, 'maxPercent', 'number', '6rem') },
          { key: 'points', label: 'Grade points', render: (row) => input(row, 'points', 'number', '7rem') },
          { key: 'description', label: 'Description', render: (row) => input(row, 'description', 'text', '14rem') },
          {
            key: 'remove',
            label: '',
            render: (row) =>
              button('Remove', {
                size: 'sm',
                onClick: () => {
                  const index = rows.indexOf(row);
                  if (index >= 0) rows.splice(index, 1);
                  paint();
                },
              }),
          },
        ],
        rows,
      })
    );
  }

  paint();

  return card({
    title: view.classId ? 'Bands for this class' : 'School-wide bands',
    subtitle: 'Ranges must not overlap. A mark falling in no band shows no grade.',
    actions: [
      chip(`${rows.length} band(s)`, 'neutral'),
      button('Add band', {
        iconName: 'add',
        onClick: () => {
          rows.push({ grade: '', minPercent: 0, maxPercent: 0, points: null, description: '' });
          paint();
        },
      }),
      button('Save bands', {
        variant: 'primary',
        iconName: 'save',
        onClick: async () => {
          const cleaned = rows.filter((row) => String(row.grade || '').trim());
          if (!cleaned.length) {
            toast('Add at least one band with a grade letter.', 'warn');
            return;
          }
          await guardedSave(
            () =>
              api.put('/api/grades', {
                classId: view.classId,
                rules: cleaned.map((row) => ({
                  grade: String(row.grade).trim(),
                  minPercent: Number(row.minPercent) || 0,
                  maxPercent: Number(row.maxPercent) || 0,
                  points: row.points === '' || row.points === null ? null : Number(row.points),
                  description: row.description || null,
                })),
              }),
            { successMessage: 'Grade bands saved.', onDone: reload }
          ).catch(() => {});
        },
      }),
    ],
    body: el('div', { class: 'space-y-3' }, [
      tableHost,
      el('p', {
        class: 'text-xs text-ink-500',
        text: 'Grades are recalculated the next time marks are saved. Already-published results keep the grade they were published with until reopened.',
      }),
    ]),
  });
}

function input(row, key, type, width) {
  const node = el('input', {
    class: 'input',
    type,
    value: row[key] ?? '',
    style: { width },
    min: type === 'number' ? '0' : null,
    max: type === 'number' && key.includes('Percent') ? '100' : null,
  });
  node.addEventListener('input', () => {
    row[key] = node.value === '' ? null : type === 'number' ? Number(node.value) : node.value;
  });
  return node;
}

void fmt;
