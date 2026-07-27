/**
 * Bulk invoice generation (SPEC §11, T30).
 *
 * Preview writes nothing. The office checks the figures, then commits — and the
 * server re-runs the preview at commit time rather than trusting the amounts the
 * browser sends back.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, toast, spinner, chip, confirm, empty, totalsRow } from '../ui.js';
import { lookups, classOptions, guardedSave, readOnlyNotice } from './_common.js';

const FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'term', label: 'Per term' },
  { value: 'annual', label: 'Annual' },
  { value: 'onetime', label: 'One time' },
];

export async function render(container) {
  container.replaceChildren(spinner());
  await lookups();

  const view = {
    classId: null,
    frequency: 'monthly',
    period: fmt.thisMonth(),
    issueDate: fmt.today(),
    dueDate: null,
  };

  const resultHost = el('div');

  const classSelect = select(classOptions(), view.classId, (value) => {
    view.classId = value;
  }, 'Choose a class');
  const frequencySelect = select(FREQUENCIES, view.frequency, (value) => {
    view.frequency = value;
    periodInput.type = value === 'monthly' ? 'month' : 'text';
    periodInput.value = value === 'monthly' ? fmt.thisMonth() : '';
    periodInput.placeholder = value === 'monthly' ? '' : value === 'term' ? 'Term 1' : 'Annual';
  });
  const periodInput = el('input', { class: 'input', type: 'month', value: view.period });
  const issueInput = el('input', { class: 'input', type: 'date', value: view.issueDate });
  const dueInput = el('input', { class: 'input', type: 'date' });

  async function preview() {
    if (!classSelect.value) {
      toast('Choose a class first.', 'warn');
      return;
    }
    resultHost.replaceChildren(spinner('Working out the invoices…'));
    try {
      const data = await api.post('/api/fees/invoices/preview', {
        classId: classSelect.value,
        frequency: frequencySelect.value,
        period: periodInput.value,
        issueDate: issueInput.value || null,
        dueDate: dueInput.value || null,
      });
      resultHost.replaceChildren(previewCard(data, resultHost));
    } catch (err) {
      resultHost.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  function previewCard(data, host) {
    const columns = [
      { key: 'rollNo', label: 'Roll', width: '5rem' },
      { key: 'admissionNo', label: 'Admission No', width: '9rem' },
      { key: 'name', label: 'Student' },
      { key: 'grossAmount', label: 'Gross', type: 'money' },
      { key: 'concessionAmount', label: 'Concession', type: 'money' },
      { key: 'netAmount', label: 'Payable', type: 'money' },
    ];

    return el('div', { class: 'space-y-4' }, [
      card({
        title: 'Preview',
        subtitle: 'Nothing has been saved yet. Check the figures before committing.',
        actions: [
          chip(`${data.count} invoice${data.count === 1 ? '' : 's'}`, data.count ? 'info' : 'warn'),
          chip(fmt.money(data.totalAmount), 'neutral'),
          data.count
            ? button('Commit invoices', {
                variant: 'primary',
                iconName: 'check',
                onClick: () => commit(data, host),
              })
            : null,
        ],
        body: data.count
          ? table({
              columns,
              rows: data.rows,
              footer: totalsRow(columns, {
                grossAmount: data.rows.reduce((sum, row) => sum + row.grossAmount, 0),
                concessionAmount: data.rows.reduce((sum, row) => sum + row.concessionAmount, 0),
                netAmount: data.totalAmount,
              }),
            })
          : empty('Nothing to invoice — every student in this class already has an invoice for that period.'),
      }),
      data.skipped?.length
        ? card({
            title: `Skipped (${data.skipped.length})`,
            body: el(
              'ul',
              { class: 'space-y-1 text-sm text-ink-600' },
              data.skipped.map((entry) => el('li', { text: `${entry.studentId} — ${entry.reason}` }))
            ),
          })
        : null,
      data.rows.length
        ? card({
            title: 'Breakdown per head',
            body: table({
              columns: [
                { key: 'feeHeadName', label: 'Fee head' },
                { key: 'gross', label: 'Gross', type: 'money' },
                { key: 'concession', label: 'Concession', type: 'money' },
                { key: 'net', label: 'Payable', type: 'money' },
              ],
              rows: byHead(data.rows),
            }),
          })
        : null,
    ]);
  }

  async function commit(data, host) {
    const proceed = await confirm({
      title: 'Commit these invoices?',
      message: `${data.count} invoices totalling ${fmt.money(data.totalAmount)} for ${data.period}.`,
      detail:
        'Invoice numbers are allocated in sequence and cannot be reused. The figures are recalculated on the server as they are written.',
      confirmLabel: 'Commit',
    });
    if (!proceed) return;

    await guardedSave(
      () =>
        api.post('/api/fees/invoices/commit', {
          classId: classSelect.value,
          frequency: frequencySelect.value,
          period: periodInput.value,
          issueDate: issueInput.value || null,
          dueDate: dueInput.value || null,
          expectedCount: data.count,
        }),
      {
        successMessage: 'Invoices generated.',
        onDone: (result) => {
          host.replaceChildren(
            card({
              title: 'Done',
              body: el('div', { class: 'space-y-2 text-sm' }, [
                el('p', { text: `${result.count} invoices generated, totalling ${fmt.money(result.totalAmount)}.` }),
                el('p', { class: 'text-ink-500', text: 'Parents can now be given receipts against these invoices.' }),
                button('Generate another batch', { onClick: () => host.replaceChildren() }),
              ]),
            })
          );
        },
      }
    ).catch(() => {});
  }

  container.replaceChildren(
    page({
      title: 'Generate invoices',
      subtitle: 'One class and one period at a time, previewed before anything is written.',
      wide: true,
      children: el('div', { class: 'space-y-4' }, [
        readOnlyNotice(),
        card({
          title: 'What to generate',
          body: el('div', {}, [
            el('div', { class: 'grid grid-cols-1 gap-3 sm:grid-cols-5' }, [
              labelled('Class', classSelect),
              labelled('Frequency', frequencySelect),
              labelled('Period', periodInput),
              labelled('Issue date', issueInput),
              labelled('Due date', dueInput),
            ]),
            el('div', { class: 'mt-3' }, [
              button('Preview', { variant: 'primary', iconName: 'preview', onClick: preview }),
            ]),
          ]),
        }),
        resultHost,
      ]),
    })
  );
}

function labelled(label, control) {
  return el('div', {}, [el('label', { class: 'label', text: label }), control]);
}

function select(options, value, onChange, placeholder) {
  const node = el('select', { class: 'input', on: { change: (event) => onChange(event.target.value || null) } });
  if (placeholder) node.appendChild(el('option', { value: '', text: placeholder }));
  for (const option of options) {
    node.appendChild(el('option', { value: option.value, text: option.label }));
  }
  node.value = value ?? '';
  return node;
}

function byHead(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const line of row.lines) {
      if (!map.has(line.feeHeadId)) {
        map.set(line.feeHeadId, { feeHeadName: line.feeHeadName, gross: 0, concession: 0, net: 0 });
      }
      const entry = map.get(line.feeHeadId);
      entry.gross += line.grossAmount;
      entry.concession += line.concessionAmount;
      entry.net += line.netAmount;
    }
  }
  return [...map.values()];
}
