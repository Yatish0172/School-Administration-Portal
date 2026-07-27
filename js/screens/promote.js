/**
 * Bulk promotion at year rollover (SPEC §6, T15).
 *
 * Every section is mapped to the section its students move into, with named
 * exceptions for anyone held back. This is deliberately not a single button —
 * getting it wrong moves the whole school into the wrong year.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, toast, icon, confirm, empty } from '../ui.js';
import { lookups, yearOptions, sectionLabel, guardedSave, readOnlyNotice } from './_common.js';
import { state } from '../state.js';
import { navigate } from '../router.js';

export async function render(container) {
  container.replaceChildren(spinner());
  await lookups({ force: true });

  const years = state.lookups?.years || [];
  const current = years.find((year) => year.isCurrent);
  const view = {
    fromYearId: current?.id || years[0]?.id || null,
    toYearId: years.find((year) => year.id !== current?.id && year.status !== 'closed')?.id || null,
  };

  const host = el('div');

  async function load() {
    if (!view.fromYearId || !view.toYearId) {
      host.replaceChildren(
        empty('You need two academic years to promote between. Create next year under Settings → Academic structure.')
      );
      return;
    }
    if (view.fromYearId === view.toYearId) {
      host.replaceChildren(empty('Choose two different years.'));
      return;
    }

    host.replaceChildren(spinner('Loading class lists…'));
    try {
      const [fromSections, toSections, enrollments] = await Promise.all([
        api.get('/api/sections', { academicYearId: view.fromYearId }),
        api.get('/api/sections', { academicYearId: view.toYearId }),
        api.get('/api/enrollments', { academicYearId: view.fromYearId }),
      ]);
      host.replaceChildren(planner(fromSections, toSections, enrollments, view));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  const yearPicker = el('div', { class: 'mb-4 flex flex-wrap items-end gap-2 no-print' }, [
    picker('Promote from', view.fromYearId, (value) => {
      view.fromYearId = value;
      load();
    }),
    el('span', { class: 'pb-2' }, [icon('arrow_forward', 'text-ink-400')]),
    picker('Into', view.toYearId, (value) => {
      view.toYearId = value;
      load();
    }),
  ]);

  container.replaceChildren(
    page({
      title: 'Promote students',
      subtitle: 'Map each section to where its students go next. Anyone held back is listed as an exception.',
      wide: true,
      actions: [button('Back to students', { onClick: () => navigate('/students') })],
      children: el('div', {}, [readOnlyNotice(), yearPicker, host]),
    })
  );

  await load();
}

function picker(label, value, onChange) {
  const select = el(
    'select',
    { class: 'input', style: { width: '14rem' }, on: { change: (event) => onChange(event.target.value) } },
    yearOptions().map((option) => el('option', { value: option.value, text: option.label }))
  );
  select.value = value ?? '';
  return el('div', {}, [el('label', { class: 'label', text: label }), select]);
}

function planner(fromSections, toSections, enrollments, view) {
  const mapping = new Map();
  const exceptions = new Set();

  const byFromSection = new Map();
  for (const enrollment of enrollments.rows) {
    if (!byFromSection.has(enrollment.sectionId)) byFromSection.set(enrollment.sectionId, []);
    byFromSection.get(enrollment.sectionId).push(enrollment);
  }

  const targetOptions = toSections.rows.map((section) => ({
    value: section.id,
    label: `${section.className || ''} ${section.name}`.trim(),
    classId: section.classId,
  }));

  const summaryNode = el('p', { class: 'text-sm text-ink-600' });

  function refreshSummary() {
    const mapped = [...mapping.entries()].filter(([, target]) => target);
    const total = mapped.reduce(
      (sum, [fromId]) => sum + (byFromSection.get(fromId)?.length || 0),
      0
    );
    summaryNode.textContent = `${mapped.length} section(s) mapped, about ${total - exceptions.size} student(s) will move, ${exceptions.size} held back.`;
  }

  const mappingTable = table({
    columns: [
      {
        key: 'from',
        label: 'Current section',
        render: (row) => {
          const count = byFromSection.get(row.id)?.length || 0;
          return el('div', {}, [
            el('p', { class: 'font-medium', text: `${row.className || ''} ${row.name}`.trim() }),
            el('p', { class: 'text-xs text-ink-500', text: `${count} student(s)` }),
          ]);
        },
      },
      {
        key: 'to',
        label: 'Moves into',
        render: (row) => {
          const select = el('select', { class: 'input', style: { width: '14rem' } }, [
            el('option', { value: '', text: 'Do not promote' }),
            ...targetOptions.map((option) => el('option', { value: option.value, text: option.label })),
          ]);
          select.addEventListener('change', () => {
            const target = targetOptions.find((option) => option.value === select.value);
            mapping.set(row.id, target ? { toSectionId: target.value, toClassId: target.classId } : null);
            refreshSummary();
          });
          return select;
        },
      },
      {
        key: 'students',
        label: 'Hold anyone back?',
        render: (row) => {
          const students = byFromSection.get(row.id) || [];
          if (!students.length) return el('span', { class: 'text-xs text-ink-400', text: 'No students' });
          return button(`Choose from ${students.length}`, {
            size: 'sm',
            onClick: () => exceptionPicker(row, students, exceptions, refreshSummary),
          });
        },
      },
    ],
    rows: fromSections.rows,
    emptyMessage: 'No sections in the year you are promoting from.',
  });

  refreshSummary();

  return el('div', { class: 'space-y-4' }, [
    el('div', { class: 'banner-info rounded-lg' }, [
      icon('info'),
      el('span', {
        text:
          'Promotion creates a new enrollment in the target year and marks the old one as promoted. Nothing is deleted, and roll numbers are allocated in sequence in the new section.',
      }),
    ]),
    card({
      title: 'Mapping',
      subtitle: 'Leave a section unmapped to skip it entirely.',
      actions: [
        button('Run promotion', {
          variant: 'primary',
          iconName: 'trending_up',
          onClick: async () => {
            const rules = [...mapping.entries()]
              .filter(([, target]) => target)
              .map(([fromSectionId, target]) => ({ fromSectionId, ...target }));

            if (!rules.length) {
              toast('Map at least one section first.', 'warn');
              return;
            }

            const proceed = await confirm({
              title: 'Run the promotion?',
              message: summaryNode.textContent,
              detail:
                'This is a large change. Take a backup first if you have not today. Held-back students keep their current enrollment and can be enrolled manually.',
              confirmLabel: 'Promote',
              confirmText: 'PROMOTE',
            });
            if (!proceed) return;

            await guardedSave(
              () =>
                api.post('/api/enrollments/promote', {
                  fromYearId: view.fromYearId,
                  toYearId: view.toYearId,
                  mapping: rules,
                  exceptions: [...exceptions],
                }),
              {
                successMessage: null,
                onDone: (result) => {
                  toast(
                    `Promoted ${result.promoted} student(s). ${result.heldBack} held back, ${result.skipped.length} skipped.`,
                    'good',
                    12000
                  );
                  navigate('/students');
                },
              }
            ).catch(() => {});
          },
        }),
      ],
      body: el('div', { class: 'space-y-3' }, [summaryNode, mappingTable]),
    }),
  ]);
}

function exceptionPicker(section, students, exceptions, refreshSummary) {
  const { modal } = window.__ui || {};
  void modal;
  import('../ui.js').then(({ modal: openModal }) => {
    const list = el(
      'ul',
      { class: 'max-h-80 space-y-1 overflow-y-auto' },
      students.map((student) => {
        const box = el('input', {
          type: 'checkbox',
          class: 'h-4 w-4 rounded border-ink-300 text-brand-600',
          checked: exceptions.has(student.studentId),
        });
        box.addEventListener('change', () => {
          if (box.checked) exceptions.add(student.studentId);
          else exceptions.delete(student.studentId);
          refreshSummary();
        });
        return el('li', { class: 'flex items-center gap-2 text-sm' }, [
          box,
          el('span', { class: 'tabular-nums text-ink-500', text: fmt.text(student.rollNo) }),
          el('span', { text: student.studentName }),
          el('span', { class: 'text-xs text-ink-400', text: student.admissionNo }),
        ]);
      })
    );

    openModal({
      title: `Hold back from ${sectionLabel(section.id)}`,
      size: 'sm',
      body: el('div', { class: 'space-y-2' }, [
        el('p', {
          class: 'text-sm text-ink-600',
          text: 'Tick anyone who should not move up. They keep their current enrollment and can be handled individually.',
        }),
        list,
      ]),
      actions: (close) => [button('Done', { variant: 'primary', onClick: close })],
    });
  });
}

void chip;
