/**
 * Transport (SPEC §12): routes, stops in order, vehicles, drivers with licence
 * expiry alerts, student assignments and the printable route list.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, tabs, formModal, toast, empty, printNode, filterSelect, modal } from '../ui.js';
import { lookups, guardedSave, readOnlyNotice, exportButton, printHeader, printFooter } from './_common.js';
import { can, state } from '../state.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  let activeTab = context.query?.tab || 'routes';
  const view = { routeId: null };
  const host = el('div');

  function paint() {
    host.replaceChildren(
      tabs(
        [
          { key: 'routes', label: 'Routes' },
          { key: 'vehicles', label: 'Vehicles and drivers' },
          { key: 'assignments', label: 'Student assignments' },
        ],
        activeTab,
        (key) => {
          activeTab = key;
          paint();
        }
      ),
      el('div', { id: 'tr-body' })
    );
    const body = host.querySelector('#tr-body');
    if (activeTab === 'routes') routes(body, paint);
    if (activeTab === 'vehicles') fleet(body, paint);
    if (activeTab === 'assignments') assignments(body, view, paint);
  }

  container.replaceChildren(
    page({
      title: 'Transport',
      subtitle: 'Routes and stops, plus expiry alerts for insurance, fitness, PUC and licences.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  paint();
}

/* ------------------------------------------------------------------ routes */

async function routes(host, reload) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/transport/routes');
    const expired = data.alerts.filter((alert) => alert.expired);

    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        expired.length
          ? el('div', { class: 'banner-bad rounded-lg' }, [
              el('span', {
                text: `${expired.length} document(s) have expired: ${expired
                  .map((alert) => `${alert.name} ${alert.field.replace('Expiry', '')}`)
                  .join(', ')}. A vehicle on the road with these expired is a legal problem.`,
              }),
            ])
          : null,
        card({
          title: `${data.rows.length} route${data.rows.length === 1 ? '' : 's'}`,
          actions: can('transport.manage')
            ? [button('Add a route', { variant: 'primary', iconName: 'add', onClick: () => routeForm(null, data, reload) })]
            : null,
          body: table({
            columns: [
              { key: 'name', label: 'Route' },
              { key: 'code', label: 'Code', width: '7rem' },
              { key: 'vehicleRegNo', label: 'Vehicle', width: '10rem' },
              { key: 'driverName', label: 'Driver' },
              {
                key: 'assigned',
                label: 'Students',
                width: '8rem',
                render: (row) =>
                  chip(
                    row.capacity ? `${row.assigned} / ${row.capacity}` : String(row.assigned),
                    row.capacity && row.assigned >= row.capacity ? 'bad' : 'neutral'
                  ),
              },
              { key: 'fare', label: 'Fare', type: 'money' },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  el('div', { class: 'flex gap-1' }, [
                    button('Stops', { size: 'sm', onClick: () => stopsModal(row, reload) }),
                    button('List', { size: 'sm', onClick: () => printRouteList(row.id) }),
                    can('transport.manage')
                      ? button('Edit', { size: 'sm', onClick: () => routeForm(row, data, reload) })
                      : null,
                  ]),
              },
            ],
            rows: data.rows,
            emptyMessage: 'No routes set up yet.',
          }),
        }),
        data.alerts.length
          ? card({
              title: 'Expiring soon',
              subtitle: 'Anything due in the next 45 days.',
              body: table({
                dense: true,
                columns: [
                  { key: 'kind', label: 'Type', width: '7rem' },
                  { key: 'name', label: 'Vehicle / driver' },
                  { key: 'field', label: 'Document', render: (row) => fmt.humanise(row.field.replace('Expiry', '')) },
                  { key: 'expiresOn', label: 'Expires', type: 'date' },
                  {
                    key: 'daysLeft',
                    label: 'Days left',
                    render: (row) =>
                      row.expired ? chip('Expired', 'bad') : chip(`${row.daysLeft} d`, row.daysLeft < 15 ? 'warn' : 'neutral'),
                  },
                ],
                rows: data.alerts,
              }),
            })
          : null,
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

function routeForm(existing, data, reload) {
  formModal({
    title: existing ? `Edit ${existing.name}` : 'Add a route',
    submitLabel: existing ? 'Save' : 'Add route',
    values: existing || {},
    fields: [
      { name: 'name', label: 'Route name', required: true },
      { name: 'code', label: 'Code' },
      {
        name: 'vehicleId',
        label: 'Vehicle',
        type: 'select',
        options: data.vehicles.map((row) => ({ value: row.id, label: `${row.regNo} (${row.capacity || '?'} seats)` })),
        placeholder: 'Not assigned',
      },
      {
        name: 'driverId',
        label: 'Driver',
        type: 'select',
        options: data.drivers.map((row) => ({ value: row.id, label: row.name })),
        placeholder: 'Not assigned',
      },
      { name: 'fare', label: 'Default fare', type: 'number', min: 0, step: 0.01 },
      { name: 'description', label: 'Description', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/transport/routes/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/transport/routes', values),
        {
          successMessage: existing ? 'Route saved.' : 'Route added. Now add its stops.',
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

async function stopsModal(route, reload) {
  const data = await api.get(`/api/transport/routes/${route.id}/stops`);
  const stops = data.rows.map((row) => ({ ...row }));
  const tableHost = el('div');

  function paint() {
    tableHost.replaceChildren(
      stops.length
        ? table({
            dense: true,
            columns: [
              { key: 'sequence', label: '#', width: '3rem', render: (row) => String(stops.indexOf(row) + 1) },
              { key: 'name', label: 'Stop', render: (row) => input(row, 'name', 'text', '12rem') },
              { key: 'arrivalTime', label: 'Pick up', render: (row) => input(row, 'arrivalTime', 'time', '7rem') },
              { key: 'departureTime', label: 'Drop', render: (row) => input(row, 'departureTime', 'time', '7rem') },
              { key: 'landmark', label: 'Landmark', render: (row) => input(row, 'landmark', 'text', '12rem') },
              { key: 'fare', label: 'Fare', render: (row) => input(row, 'fare', 'number', '6rem') },
              {
                key: 'move',
                label: '',
                render: (row) =>
                  el('div', { class: 'flex gap-1' }, [
                    button('↑', {
                      size: 'sm',
                      onClick: () => {
                        const index = stops.indexOf(row);
                        if (index > 0) {
                          stops.splice(index - 1, 0, stops.splice(index, 1)[0]);
                          paint();
                        }
                      },
                    }),
                    button('↓', {
                      size: 'sm',
                      onClick: () => {
                        const index = stops.indexOf(row);
                        if (index < stops.length - 1) {
                          stops.splice(index + 1, 0, stops.splice(index, 1)[0]);
                          paint();
                        }
                      },
                    }),
                    button('✕', {
                      size: 'sm',
                      onClick: () => {
                        stops.splice(stops.indexOf(row), 1);
                        paint();
                      },
                    }),
                  ]),
              },
            ],
            rows: stops,
          })
        : empty('No stops yet.')
    );
  }

  paint();

  modal({
    title: `Stops on ${route.name}`,
    size: 'xl',
    body: el('div', { class: 'space-y-3' }, [
      el('p', {
        class: 'text-sm text-ink-600',
        text: 'Stops are saved in this order, which is the order the driver drives them and the order they print in.',
      }),
      tableHost,
      button('Add a stop', {
        iconName: 'add',
        onClick: () => {
          stops.push({ name: '', arrivalTime: null, departureTime: null, landmark: '', fare: null });
          paint();
        },
      }),
    ]),
    actions: (close) =>
      can('transport.manage')
        ? [
            button('Cancel', { onClick: close }),
            button('Save stops', {
              variant: 'primary',
              onClick: async () => {
                const cleaned = stops.filter((stop) => String(stop.name || '').trim());
                await guardedSave(
                  () => api.put(`/api/transport/routes/${route.id}/stops`, { stops: cleaned }),
                  {
                    successMessage: 'Stops saved.',
                    onDone: () => {
                      close();
                      reload();
                    },
                  }
                ).catch(() => {});
              },
            }),
          ]
        : [button('Close', { onClick: close })],
  });
}

/* ----------------------------------------------------------------- vehicles */

async function fleet(host, reload) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/transport/routes');
    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        card({
          title: `Vehicles (${data.vehicles.length})`,
          actions: can('transport.manage')
            ? [button('Add a vehicle', { iconName: 'add', onClick: () => vehicleForm(null, reload) })]
            : null,
          body: table({
            columns: [
              { key: 'regNo', label: 'Registration' },
              { key: 'model', label: 'Model' },
              { key: 'capacity', label: 'Seats', type: 'num', width: '6rem' },
              { key: 'insuranceExpiry', label: 'Insurance', render: (row) => expiryCell(row.insuranceExpiry) },
              { key: 'fitnessExpiry', label: 'Fitness', render: (row) => expiryCell(row.fitnessExpiry) },
              { key: 'pucExpiry', label: 'PUC', render: (row) => expiryCell(row.pucExpiry) },
              { key: 'permitExpiry', label: 'Permit', render: (row) => expiryCell(row.permitExpiry) },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  can('transport.manage') ? button('Edit', { size: 'sm', onClick: () => vehicleForm(row, reload) }) : null,
              },
            ],
            rows: data.vehicles,
            emptyMessage: 'No vehicles recorded.',
          }),
        }),
        card({
          title: `Drivers (${data.drivers.length})`,
          actions: can('transport.manage')
            ? [button('Add a driver', { iconName: 'add', onClick: () => driverForm(null, reload) })]
            : null,
          body: table({
            columns: [
              { key: 'name', label: 'Name' },
              { key: 'phone', label: 'Phone', width: '9rem' },
              { key: 'licenceNo', label: 'Licence' },
              { key: 'licenceExpiry', label: 'Expires', render: (row) => expiryCell(row.licenceExpiry) },
              { key: 'bloodGroup', label: 'Blood', width: '6rem' },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  can('transport.manage') ? button('Edit', { size: 'sm', onClick: () => driverForm(row, reload) }) : null,
              },
            ],
            rows: data.drivers,
            emptyMessage: 'No drivers recorded.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

function expiryCell(value) {
  if (!value) return el('span', { class: 'text-ink-400', text: '—' });
  const days = Math.ceil((Date.parse(value) - Date.now()) / 86400000);
  if (days < 0) return chip(`Expired ${fmt.date(value)}`, 'bad');
  if (days < 45) return chip(`${fmt.date(value)} (${days} d)`, 'warn');
  return el('span', { text: fmt.date(value) });
}

function vehicleForm(existing, reload) {
  formModal({
    title: existing ? `Edit ${existing.regNo}` : 'Add a vehicle',
    submitLabel: existing ? 'Save' : 'Add vehicle',
    values: existing || {},
    fields: [
      { name: 'regNo', label: 'Registration number', required: true },
      { name: 'model', label: 'Model' },
      { name: 'capacity', label: 'Seats', type: 'number', min: 1, max: 100 },
      { name: 'insuranceExpiry', label: 'Insurance expires', type: 'date' },
      { name: 'fitnessExpiry', label: 'Fitness expires', type: 'date' },
      { name: 'pucExpiry', label: 'PUC expires', type: 'date' },
      { name: 'permitExpiry', label: 'Permit expires', type: 'date' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/transport/vehicles/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/transport/vehicles', values),
        {
          successMessage: 'Vehicle saved.',
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

function driverForm(existing, reload) {
  formModal({
    title: existing ? `Edit ${existing.name}` : 'Add a driver',
    submitLabel: existing ? 'Save' : 'Add driver',
    values: existing || {},
    fields: [
      { name: 'name', label: 'Name', required: true },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'licenceNo', label: 'Licence number', required: true },
      { name: 'licenceExpiry', label: 'Licence expires', type: 'date' },
      { name: 'bloodGroup', label: 'Blood group' },
      { name: 'address', label: 'Address', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/transport/drivers/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/transport/drivers', values),
        {
          successMessage: 'Driver saved.',
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

/* -------------------------------------------------------------- assignments */

async function assignments(host, view, reload) {
  host.replaceChildren(spinner());
  try {
    const [routes2, data] = await Promise.all([
      api.get('/api/transport/routes'),
      api.get('/api/transport/assignments', { routeId: view.routeId }),
    ]);

    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        el('div', { class: 'flex flex-wrap items-end gap-2 no-print' }, [
          filterSelect({
            label: 'Route',
            width: '14rem',
            options: routes2.rows.map((row) => ({ value: row.id, label: row.name })),
            value: view.routeId,
            placeholder: 'All routes',
            onChange: (value) => {
              view.routeId = value;
              reload();
            },
          }),
          can('transport.manage')
            ? button('Assign a student', {
                variant: 'primary',
                iconName: 'person_add',
                onClick: () => assignForm(routes2.rows, reload),
              })
            : null,
          view.routeId ? exportButton(`/api/transport/export/route/${view.routeId}`, {}, 'Export route list') : null,
        ]),
        card({
          title: `${data.rows.length} student${data.rows.length === 1 ? '' : 's'} assigned`,
          body: table({
            columns: [
              { key: 'admissionNo', label: 'Admission No', width: '9rem' },
              { key: 'studentName', label: 'Student' },
              { key: 'direction', label: 'Direction', width: '8rem', render: (row) => fmt.humanise(row.direction) },
              { key: 'fare', label: 'Fare', type: 'money' },
              { key: 'fromDate', label: 'From', type: 'date', width: '8rem' },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  can('transport.manage')
                    ? button('End', {
                        size: 'sm',
                        onClick: async () => {
                          await guardedSave(
                            () => api.post(`/api/transport/assignments/${row.id}/end`, { toDate: fmt.today() }),
                            { successMessage: 'Assignment ended.', onDone: reload }
                          ).catch(() => {});
                        },
                      })
                    : null,
              },
            ],
            rows: data.rows,
            emptyMessage: 'Nobody is assigned to transport yet.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(errorCard(err));
  }
}

function assignForm(routes2, reload) {
  let selectedRouteId = null;
  const searchInput = el('input', { class: 'input', placeholder: 'Search student by name' });
  const studentSelect = el('select', { class: 'input' }, [el('option', { value: '', text: 'Search above' })]);

  searchInput.addEventListener('input', debounce(async () => {
    const term = searchInput.value.trim();
    if (term.length < 2) return;
    const data = await api.get('/api/students', { search: term, status: 'Active', pageSize: 25 });
    studentSelect.replaceChildren(
      el('option', { value: '', text: data.rows.length ? 'Choose a student' : 'No matches' }),
      ...data.rows.map((row) =>
        el('option', { value: row.id, text: `${row.fullName || row.firstName} (${row.admissionNo})` })
      )
    );
  }, 300));

  const { formApi, dialog } = formModal({
    title: 'Assign a student to a route',
    submitLabel: 'Assign',
    values: { direction: 'both', fromDate: fmt.today() },
    fields: [
      {
        name: 'routeId',
        label: 'Route',
        type: 'select',
        required: true,
        options: routes2.map((row) => ({ value: row.id, label: row.name })),
      },
      { name: 'stopId', label: 'Stop', type: 'select', required: true, options: [] },
      {
        name: 'direction',
        label: 'Direction',
        type: 'select',
        options: [
          { value: 'both', label: 'Pick up and drop' },
          { value: 'pickup', label: 'Pick up only' },
          { value: 'drop', label: 'Drop only' },
        ],
      },
      { name: 'fare', label: 'Fare', type: 'number', min: 0, step: 0.01, hint: 'Leave blank to use the stop or route fare.' },
      { name: 'fromDate', label: 'From', type: 'date' },
    ],
    onSubmit: async (values, helpers) => {
      if (!studentSelect.value) {
        helpers.setErrors({}, 'Choose the student.');
        return;
      }
      await guardedSave(
        () => api.post('/api/transport/assignments', { ...values, studentId: studentSelect.value }),
        {
          successMessage: 'Student assigned.',
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

  const routeControl = formApi.control('routeId');
  routeControl.addEventListener('change', async () => {
    selectedRouteId = routeControl.value || null;
    const stopControl = formApi.control('stopId');
    stopControl.replaceChildren(el('option', { value: '', text: 'Loading…' }));
    if (!selectedRouteId) return;
    const stops = await api.get(`/api/transport/routes/${selectedRouteId}/stops`);
    stopControl.replaceChildren(
      el('option', { value: '', text: stops.rows.length ? 'Choose a stop' : 'No stops on this route' }),
      ...stops.rows.map((stop) =>
        el('option', { value: stop.id, text: `${stop.sequence}. ${stop.name}` })
      )
    );
  });

  dialog.body.insertBefore(
    el('div', { class: 'mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2' }, [
      el('div', {}, [el('label', { class: 'label', text: 'Find the student' }), searchInput]),
      el('div', {}, [el('label', { class: 'label', text: 'Student' }), studentSelect]),
    ]),
    formApi.node
  );
}

/* ----------------------------------------------------------- printable list */

async function printRouteList(routeId) {
  const data = await api.get(`/api/transport/routes/${routeId}/list`);
  printNode(
    el('div', { class: 'print-page bg-white p-6 text-xs' }, [
      printHeader(
        state.school,
        `Route List — ${data.route.name}`,
        [
          data.vehicle ? `Vehicle ${data.vehicle.regNo}` : null,
          data.driver ? `Driver ${data.driver.name} ${data.driver.phone || ''}` : null,
          `${data.total} students`,
        ]
          .filter(Boolean)
          .join(' • ')
      ),
      el('table', { class: 'w-full border-collapse' }, [
        el('thead', {}, [
          el(
            'tr',
            { class: 'bg-ink-100' },
            ['#', 'Stop', 'Time', 'Student', 'Class', 'Guardian', 'Phone'].map((label) =>
              el('th', { class: 'border border-ink-300 px-1.5 py-1 text-left', text: label })
            )
          ),
        ]),
        el(
          'tbody',
          {},
          data.rows.map((row) =>
            el('tr', {}, [
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: String(row.stopSequence) }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: row.stopName }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: row.arrivalTime || '' }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: row.name }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: `${row.className} ${row.sectionName}` }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: row.guardianName }),
              el('td', { class: 'border border-ink-300 px-1.5 py-0.5', text: row.guardianPhone }),
            ])
          )
        ),
      ]),
      printFooter(state.user?.name, new Date().toISOString()),
    ]),
    { title: `Route ${data.route.name}` }
  );
}

function errorCard(err) {
  return el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message });
}

function input(row, key, type, width) {
  const node = el('input', { class: 'input', type, value: row[key] ?? '', style: { width } });
  node.addEventListener('input', () => {
    row[key] = node.value === '' ? null : type === 'number' ? Number(node.value) : node.value;
  });
  return node;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

void toast;
