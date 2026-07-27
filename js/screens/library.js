/**
 * Library (SPEC §12): catalogue, copies with accession numbers, issue and return,
 * renewals, fines and the overdue list.
 *
 * The Library role sees student names and classes only — the server trims the
 * payload, so nothing sensitive reaches this screen to begin with.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, tabs, formModal, toast, searchBox, filterSelect, empty, askReason, grid, stat, modal, pager } from '../ui.js';
import { guardedSave, readOnlyNotice, exportButton } from './_common.js';
import { can } from '../state.js';

export async function render(container, context = {}) {
  let activeTab = context.query?.tab || 'catalogue';
  const view = { search: '', page: 1, fineStatus: 'pending' };
  const host = el('div');

  function paint() {
    host.replaceChildren(
      tabs(
        [
          { key: 'catalogue', label: 'Catalogue' },
          { key: 'issue', label: 'Issue and return' },
          { key: 'overdue', label: 'Overdue' },
          { key: 'fines', label: 'Fines' },
          { key: 'stock', label: 'Stock' },
        ],
        activeTab,
        (key) => {
          activeTab = key;
          paint();
        }
      ),
      el('div', { id: 'lib-body' })
    );
    const body = host.querySelector('#lib-body');
    if (activeTab === 'catalogue') catalogue(body, view, paint);
    if (activeTab === 'issue') issueDesk(body, paint);
    if (activeTab === 'overdue') overdue(body);
    if (activeTab === 'fines') fines(body, view, paint);
    if (activeTab === 'stock') stock(body);
  }

  container.replaceChildren(
    page({
      title: 'Library',
      subtitle: 'Accession numbers come from the counter, so a lost copy never causes a reused number.',
      wide: true,
      actions: [
        can('library.manage')
          ? button('Add a title', { variant: 'primary', iconName: 'add', onClick: () => titleForm(null, paint) })
          : null,
      ],
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  paint();
}

/* ---------------------------------------------------------------- catalogue */

async function catalogue(host, view, repaint) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/library/titles', { search: view.search, page: view.page, pageSize: 50 });
    host.replaceChildren(
      el('div', {}, [
        el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
          searchBox('Search title, author, ISBN or category…', (value) => {
            view.search = value;
            view.page = 1;
            repaint();
          }, view.search),
        ]),
        card({
          title: `${fmt.number(data.total)} title${data.total === 1 ? '' : 's'}`,
          body: el('div', {}, [
            table({
              columns: [
                { key: 'title', label: 'Title' },
                { key: 'author', label: 'Author' },
                { key: 'category', label: 'Category', width: '10rem' },
                { key: 'shelf', label: 'Shelf', width: '7rem' },
                { key: 'copies', label: 'Copies', type: 'num', width: '6rem' },
                {
                  key: 'available',
                  label: 'Available',
                  width: '7rem',
                  render: (row) => chip(String(row.available), row.available > 0 ? 'good' : 'bad'),
                },
                {
                  key: 'actions',
                  label: '',
                  render: (row) =>
                    el('div', { class: 'flex gap-1' }, [
                      button('Copies', { size: 'sm', onClick: () => copiesModal(row, repaint) }),
                      can('library.manage')
                        ? button('Edit', { size: 'sm', onClick: () => titleForm(row, repaint) })
                        : null,
                    ]),
                },
              ],
              rows: data.rows,
              emptyMessage: 'No titles catalogued yet.',
            }),
            pager({
              page: data.page,
              pages: data.pages,
              total: data.total,
              onChange: (next) => {
                view.page = next;
                repaint();
              },
            }),
          ]),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

function titleForm(existing, reload) {
  formModal({
    title: existing ? `Edit ${existing.title}` : 'Add a title',
    submitLabel: existing ? 'Save' : 'Add title',
    values: existing || {},
    fields: [
      { name: 'title', label: 'Title', required: true, colSpan: 'full' },
      { name: 'author', label: 'Author', required: true },
      { name: 'publisher', label: 'Publisher' },
      { name: 'isbn', label: 'ISBN' },
      { name: 'category', label: 'Category' },
      { name: 'edition', label: 'Edition' },
      { name: 'language', label: 'Language' },
      { name: 'price', label: 'Price', type: 'number', min: 0, step: 0.01 },
      { name: 'shelf', label: 'Shelf', hint: 'Where it physically lives.' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/library/titles/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/library/titles', values),
        {
          successMessage: existing ? 'Title saved.' : 'Title added. Now add its copies.',
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

async function copiesModal(title, reload) {
  const data = await api.get(`/api/library/titles/${title.id}/copies`);
  modal({
    title: `Copies of ${title.title}`,
    size: 'lg',
    body: el('div', { class: 'space-y-3' }, [
      table({
        dense: true,
        columns: [
          { key: 'accessionNo', label: 'Accession No', width: '10rem' },
          { key: 'status', label: 'Status', type: 'status', width: '9rem' },
          { key: 'purchaseDate', label: 'Purchased', type: 'date' },
          { key: 'price', label: 'Price', type: 'money' },
          { key: 'condition', label: 'Condition' },
          {
            key: 'actions',
            label: '',
            render: (row) =>
              can('library.manage') && row.status !== 'issued'
                ? filterSelect({
                    options: data.statuses.filter((status) => status !== 'issued'),
                    value: row.status,
                    placeholder: '',
                    width: '9rem',
                    onChange: async (status) => {
                      if (!status) return;
                      await guardedSave(
                        () => api.post(`/api/library/copies/${row.id}/status`, { status }),
                        { successMessage: 'Copy updated.' }
                      ).catch(() => {});
                    },
                  })
                : null,
          },
        ],
        rows: data.rows,
        emptyMessage: 'No copies yet.',
      }),
    ]),
    actions: (close) =>
      can('library.manage')
        ? [
            button('Close', { onClick: close }),
            button('Add copies', {
              variant: 'primary',
              onClick: () => {
                close();
                addCopiesForm(title, reload);
              },
            }),
          ]
        : [button('Close', { onClick: close })],
  });
}

function addCopiesForm(title, reload) {
  formModal({
    title: `Add copies of ${title.title}`,
    submitLabel: 'Add copies',
    values: { count: 1, purchaseDate: fmt.today() },
    fields: [
      { name: 'count', label: 'How many copies', type: 'number', required: true, min: 1, max: 200 },
      { name: 'price', label: 'Price per copy', type: 'number', min: 0, step: 0.01 },
      { name: 'purchaseDate', label: 'Purchase date', type: 'date' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(() => api.post(`/api/library/titles/${title.id}/copies`, values), {
        successMessage: null,
        onDone: (result) => {
          helpers.close();
          toast(`Added ${result.created} copies: ${result.accessionNumbers.join(', ')}`, 'good', 9000);
          reload();
        },
      }).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });
}

/* --------------------------------------------------------------- issue desk */

async function issueDesk(host, reload) {
  host.replaceChildren(spinner());
  try {
    const issues = await api.get('/api/library/issues');

    const accessionInput = el('input', { class: 'input', placeholder: 'Scan or type the accession number' });
    const typeSelect = el('select', { class: 'input' }, [
      el('option', { value: 'student', text: 'Student' }),
      el('option', { value: 'staff', text: 'Staff' }),
    ]);
    const borrowerSearch = el('input', { class: 'input', placeholder: 'Search by name' });
    const borrowerSelect = el('select', { class: 'input' }, [el('option', { value: '', text: 'Search above' })]);

    borrowerSearch.addEventListener('input', debounce(async () => {
      const term = borrowerSearch.value.trim();
      if (term.length < 2) return;
      if (typeSelect.value === 'student') {
        const data = await api.get('/api/students', { search: term, status: 'Active', pageSize: 25 });
        borrowerSelect.replaceChildren(
          el('option', { value: '', text: data.rows.length ? 'Choose' : 'No matches' }),
          ...data.rows.map((row) =>
            el('option', {
              value: row.id,
              text: `${row.fullName || `${row.firstName} ${row.lastName || ''}`} (${row.admissionNo})`,
            })
          )
        );
      } else {
        const data = await api.get('/api/staff', { search: term, pageSize: 25 });
        borrowerSelect.replaceChildren(
          el('option', { value: '', text: data.rows.length ? 'Choose' : 'No matches' }),
          ...data.rows.map((row) => el('option', { value: row.id, text: `${row.name} (${row.staffCode})` }))
        );
      }
    }, 300));

    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        can('library.issue')
          ? card({
              title: 'Issue a book',
              subtitle: 'The loan period and the per-student limit come from Settings.',
              body: el('div', {}, [
                el('div', { class: 'grid grid-cols-1 gap-3 sm:grid-cols-4' }, [
                  labelled('Accession number', accessionInput),
                  labelled('Borrower type', typeSelect),
                  labelled('Find borrower', borrowerSearch),
                  labelled('Borrower', borrowerSelect),
                ]),
                el('div', { class: 'mt-3' }, [
                  button('Issue', {
                    variant: 'primary',
                    iconName: 'book',
                    onClick: async () => {
                      if (!accessionInput.value.trim()) {
                        toast('Enter the accession number from the book.', 'warn');
                        return;
                      }
                      if (!borrowerSelect.value) {
                        toast('Choose the borrower.', 'warn');
                        return;
                      }
                      await guardedSave(
                        () =>
                          api.post('/api/library/issues', {
                            accessionNo: accessionInput.value.trim(),
                            borrowerType: typeSelect.value,
                            studentId: typeSelect.value === 'student' ? borrowerSelect.value : null,
                            staffId: typeSelect.value === 'staff' ? borrowerSelect.value : null,
                          }),
                        {
                          successMessage: null,
                          onDone: (row) => {
                            toast(`Issued. Due back ${fmt.date(row.dueDate)}.`, 'good');
                            accessionInput.value = '';
                            reload();
                          },
                        }
                      ).catch(() => {});
                    },
                  }),
                ]),
              ]),
            })
          : null,
        card({
          title: `Out on loan (${issues.rows.length})`,
          body: table({
            columns: [
              { key: 'accessionNo', label: 'Accession', width: '10rem' },
              { key: 'title', label: 'Title' },
              { key: 'borrower', label: 'Borrower' },
              { key: 'issuedAt', label: 'Issued', type: 'date', width: '8rem' },
              { key: 'dueDate', label: 'Due', type: 'date', width: '8rem' },
              {
                key: 'daysOverdue',
                label: 'Overdue',
                width: '7rem',
                render: (row) =>
                  row.daysOverdue > 0 ? chip(`${row.daysOverdue} d`, 'bad') : chip('On time', 'good'),
              },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  can('library.issue')
                    ? el('div', { class: 'flex gap-1' }, [
                        button('Return', {
                          size: 'sm',
                          variant: 'primary',
                          onClick: () => returnFlow(row, reload),
                        }),
                        row.daysOverdue > 0
                          ? null
                          : button('Renew', {
                              size: 'sm',
                              onClick: async () => {
                                await guardedSave(() => api.post(`/api/library/issues/${row.id}/renew`), {
                                  successMessage: 'Renewed.',
                                  onDone: reload,
                                }).catch(() => {});
                              },
                            }),
                      ])
                    : null,
              },
            ],
            rows: issues.rows,
            emptyMessage: 'Nothing is out on loan.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

async function returnFlow(row, reload) {
  const conditionSelect = el('select', { class: 'input' }, [
    el('option', { value: 'good', text: 'Good' }),
    el('option', { value: 'damaged', text: 'Damaged' }),
  ]);
  modal({
    title: `Return ${row.accessionNo}`,
    size: 'sm',
    body: el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-sm text-ink-700', text: `${row.title} from ${row.borrower}.` }),
      row.daysOverdue > 0
        ? el('p', { class: 'rounded bg-amber-50 p-2 text-sm text-amber-900', text: `${row.daysOverdue} days overdue — a fine will be raised.` })
        : null,
      el('div', {}, [el('label', { class: 'label', text: 'Condition' }), conditionSelect]),
    ]),
    actions: (close) => [
      button('Cancel', { onClick: close }),
      button('Take return', {
        variant: 'primary',
        onClick: async () => {
          await guardedSave(
            () => api.post(`/api/library/issues/${row.id}/return`, { condition: conditionSelect.value }),
            {
              successMessage: null,
              onDone: (result) => {
                close();
                toast(
                  result.fineAmount
                    ? `Returned. Fine of ${fmt.money(result.fineAmount)} raised.`
                    : 'Returned, no fine.',
                  'good'
                );
                reload();
              },
            }
          ).catch(() => {});
        },
      }),
    ],
  });
}

/* ------------------------------------------------------------------ overdue */

async function overdue(host) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/library/reports/overdue');
    host.replaceChildren(
      card({
        title: `${data.rows.length} overdue`,
        actions: [exportButton('/api/library/export/overdue', {}, 'Export')],
        body: table({
          columns: [
            { key: 'accessionNo', label: 'Accession', width: '10rem' },
            { key: 'title', label: 'Title' },
            { key: 'borrower', label: 'Borrower' },
            { key: 'contact', label: 'Contact', width: '9rem' },
            { key: 'dueDate', label: 'Due', type: 'date', width: '8rem' },
            { key: 'daysOverdue', label: 'Days', type: 'num', width: '6rem' },
            { key: 'estimatedFine', label: 'Fine so far', type: 'money' },
          ],
          rows: data.rows,
          emptyMessage: 'Nothing is overdue.',
        }),
      })
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

/* -------------------------------------------------------------------- fines */

async function fines(host, view, repaint) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/library/fines', { status: view.fineStatus });
    host.replaceChildren(
      el('div', {}, [
        el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
          filterSelect({
            label: 'Status',
            options: ['pending', 'paid', 'waived'],
            value: view.fineStatus,
            placeholder: 'All',
            onChange: (value) => {
              view.fineStatus = value;
              repaint();
            },
          }),
        ]),
        card({
          title: 'Fines',
          body: table({
            columns: [
              { key: 'borrower', label: 'Borrower' },
              { key: 'reason', label: 'Reason' },
              { key: 'daysOverdue', label: 'Days', type: 'num', width: '6rem' },
              { key: 'amount', label: 'Amount', type: 'money' },
              { key: 'status', label: 'Status', type: 'status', width: '8rem' },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  can('library.fine') && row.status === 'pending'
                    ? el('div', { class: 'flex gap-1' }, [
                        button('Collect', {
                          size: 'sm',
                          variant: 'primary',
                          onClick: async () => {
                            await guardedSave(
                              () => api.post(`/api/library/fines/${row.id}/settle`, { waive: false }),
                              { successMessage: 'Fine collected.', onDone: repaint }
                            ).catch(() => {});
                          },
                        }),
                        button('Waive', {
                          size: 'sm',
                          onClick: async () => {
                            const reason = await askReason({
                              title: 'Waive this fine',
                              label: 'Reason',
                              confirmLabel: 'Waive',
                              minLength: 3,
                            });
                            if (reason === null) return;
                            await guardedSave(
                              () => api.post(`/api/library/fines/${row.id}/settle`, { waive: true, reason }),
                              { successMessage: 'Fine waived.', onDone: repaint }
                            ).catch(() => {});
                          },
                        }),
                      ])
                    : null,
              },
            ],
            rows: data.rows,
            emptyMessage: 'No fines.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

/* -------------------------------------------------------------------- stock */

async function stock(host) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/library/reports/stock');
    const totals = data.rows.reduce(
      (acc, row) => ({
        total: acc.total + row.total,
        available: acc.available + row.available,
        issued: acc.issued + row.issued,
        lost: acc.lost + row.lost,
      }),
      { total: 0, available: 0, issued: 0, lost: 0 }
    );
    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        grid(4, [
          stat({ label: 'Copies', value: fmt.number(totals.total) }),
          stat({ label: 'Available', value: fmt.number(totals.available), tone: 'good' }),
          stat({ label: 'Issued', value: fmt.number(totals.issued) }),
          stat({ label: 'Lost', value: fmt.number(totals.lost), tone: totals.lost ? 'warn' : 'neutral' }),
        ]),
        card({
          title: 'Stock by title',
          actions: [exportButton('/api/library/export/stock', {}, 'Export')],
          body: table({
            columns: [
              { key: 'title', label: 'Title' },
              { key: 'author', label: 'Author' },
              { key: 'category', label: 'Category' },
              { key: 'total', label: 'Copies', type: 'num' },
              { key: 'available', label: 'Available', type: 'num' },
              { key: 'issued', label: 'Issued', type: 'num' },
              { key: 'lost', label: 'Lost', type: 'num' },
              { key: 'damaged', label: 'Damaged', type: 'num' },
            ],
            rows: data.rows,
            emptyMessage: 'Nothing catalogued yet.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
  void empty;
}

/* ----------------------------------------------------------------- helpers */

function labelled(label, control) {
  return el('div', {}, [el('label', { class: 'label', text: label }), control]);
}

function errorCard(err) {
  return el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message });
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
