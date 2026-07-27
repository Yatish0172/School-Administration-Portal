/**
 * Admissions and enquiries (SPEC §7): capture, follow-up log with next-action
 * dates, conversion to admission, the waiting list against real section capacity,
 * and the enquiry funnel by source and month.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, tabs, formModal, modal, toast, filterSelect, searchBox, empty, stat, grid, pager } from '../ui.js';
import { lookups, classOptions, sectionOptions, guardedSave, readOnlyNotice } from './_common.js';
import { can } from '../state.js';
import { navigate } from '../router.js';

const SOURCES = ['Walk-in', 'Referral', 'Newspaper', 'Hoarding', 'Social media', 'Website', 'Other'];
const OUTCOMES = [
  { value: 'following up', label: 'Following up' },
  { value: 'visited', label: 'Visited the school' },
  { value: 'waiting', label: 'On the waiting list' },
  { value: 'lost', label: 'Not interested' },
];

export async function render(container, context = {}) {
  container.replaceChildren(spinner());
  await lookups();

  let activeTab = context.query?.tab || 'enquiries';
  const view = { search: '', status: null, source: null, page: 1 };
  const host = el('div');

  function paint() {
    host.replaceChildren(
      tabs(
        [
          { key: 'enquiries', label: 'Enquiries' },
          { key: 'waiting', label: 'Waiting list' },
          { key: 'funnel', label: 'Funnel' },
        ],
        activeTab,
        (key) => {
          activeTab = key;
          paint();
        }
      ),
      el('div', { id: 'adm-body' })
    );
    const body = host.querySelector('#adm-body');
    if (activeTab === 'enquiries') enquiries(body, view, paint);
    if (activeTab === 'waiting') waiting(body, paint);
    if (activeTab === 'funnel') funnel(body);
  }

  container.replaceChildren(
    page({
      title: 'Admissions',
      subtitle: 'Enquiries, follow-up calls and conversion into an admission.',
      wide: true,
      actions: [
        can('enquiry.create')
          ? button('Record an enquiry', { variant: 'primary', iconName: 'add', onClick: () => enquiryForm(null, paint) })
          : null,
      ],
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  paint();

  if (context.query?.enquiry) openEnquiry(context.query.enquiry, paint);
}

/* ------------------------------------------------------------------ enquiries */

async function enquiries(host, view, repaint) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/enquiries', {
      search: view.search,
      status: view.status,
      source: view.source,
      page: view.page,
      pageSize: 50,
    });

    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        data.due.length
          ? card({
              title: `Follow-up calls due (${data.due.length})`,
              subtitle: 'These are on or past their next-action date.',
              body: table({
                dense: true,
                columns: [
                  { key: 'enquiryNo', label: 'Enquiry', width: '8rem' },
                  { key: 'childName', label: 'Child' },
                  { key: 'classSought', label: 'Class sought' },
                  { key: 'parentName', label: 'Parent' },
                  { key: 'phone', label: 'Phone' },
                  { key: 'followUpDate', label: 'Due', type: 'date' },
                  {
                    key: 'actions',
                    label: '',
                    render: (row) =>
                      button('Log a call', { size: 'sm', onClick: () => openEnquiry(row.id, repaint) }),
                  },
                ],
                rows: data.due,
              }),
            })
          : null,
        el('div', { class: 'flex flex-wrap items-end gap-2 no-print' }, [
          searchBox('Search child, parent or phone…', (value) => {
            view.search = value;
            view.page = 1;
            repaint();
          }, view.search),
          filterSelect({
            label: 'Status',
            options: data.statuses,
            value: view.status,
            placeholder: 'All',
            onChange: (value) => {
              view.status = value;
              view.page = 1;
              repaint();
            },
          }),
          filterSelect({
            label: 'Source',
            options: data.sources,
            value: view.source,
            placeholder: 'All',
            width: '11rem',
            onChange: (value) => {
              view.source = value;
              view.page = 1;
              repaint();
            },
          }),
        ]),
        card({
          title: `${fmt.number(data.total)} enquir${data.total === 1 ? 'y' : 'ies'}`,
          body: el('div', {}, [
            table({
              columns: [
                { key: 'enquiryNo', label: 'Enquiry', width: '8rem' },
                { key: 'childName', label: 'Child' },
                { key: 'classSought', label: 'Class sought', width: '9rem' },
                { key: 'parentName', label: 'Parent' },
                { key: 'phone', label: 'Phone', width: '9rem' },
                { key: 'source', label: 'Source', width: '9rem' },
                { key: 'followUpDate', label: 'Next action', type: 'date', width: '9rem' },
                { key: 'status', label: 'Status', type: 'status', width: '9rem' },
              ],
              rows: data.rows,
              onRowClick: (row) => openEnquiry(row.id, repaint),
              emptyMessage: 'No enquiries recorded yet.',
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
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

async function openEnquiry(enquiryId, reload) {
  const data = await api.get(`/api/enquiries/${enquiryId}`);
  const enquiry = data.enquiry;

  modal({
    title: `${enquiry.enquiryNo} — ${enquiry.childName}`,
    size: 'lg',
    body: el('div', { class: 'space-y-4' }, [
      el('div', { class: 'grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3' }, [
        pair('Class sought', enquiry.classSought),
        pair('Parent', enquiry.parentName),
        pair('Phone', enquiry.phone),
        pair('Email', enquiry.email),
        pair('Source', enquiry.source),
        pair('Status', enquiry.status),
        pair('Next action', enquiry.followUpDate ? fmt.date(enquiry.followUpDate) : '—'),
        pair('Date of birth', enquiry.dob ? fmt.date(enquiry.dob) : '—'),
      ]),
      enquiry.notes ? el('p', { class: 'rounded bg-ink-50 p-2 text-sm', text: enquiry.notes }) : null,
      el('div', {}, [
        el('h3', { class: 'mb-2 text-sm font-semibold', text: 'Follow-up log' }),
        table({
          dense: true,
          columns: [
            { key: 'at', label: 'When', type: 'dateTime' },
            { key: 'notes', label: 'What happened' },
            { key: 'outcome', label: 'Outcome' },
            { key: 'nextActionDate', label: 'Next action', type: 'date' },
          ],
          rows: data.followUps,
          emptyMessage: 'No calls logged yet.',
        }),
      ]),
    ]),
    actions: (close) => [
      can('enquiry.edit')
        ? button('Log a call', {
            onClick: () => {
              close();
              followUpForm(enquiry, reload);
            },
          })
        : null,
      can('enquiry.edit') && enquiry.status !== 'converted'
        ? button('Edit', {
            onClick: () => {
              close();
              enquiryForm(enquiry, reload);
            },
          })
        : null,
      can('enquiry.convert') && enquiry.status !== 'converted'
        ? button('Convert to admission', {
            variant: 'primary',
            onClick: () => {
              close();
              convertForm(enquiry, reload);
            },
          })
        : null,
      enquiry.convertedStudentId
        ? button('Open student', {
            variant: 'primary',
            onClick: () => {
              close();
              navigate(`/students/${enquiry.convertedStudentId}`);
            },
          })
        : null,
    ],
  });
}

function pair(label, value) {
  return el('div', {}, [
    el('p', { class: 'text-xs uppercase tracking-wide text-ink-500', text: label }),
    el('p', { class: 'font-medium', text: fmt.text(value) }),
  ]);
}

function enquiryForm(existing, reload) {
  formModal({
    title: existing ? `Edit ${existing.enquiryNo}` : 'Record an enquiry',
    submitLabel: existing ? 'Save' : 'Record enquiry',
    values: existing || { source: 'Walk-in' },
    fields: [
      { name: 'childName', label: "Child's name", required: true },
      { name: 'dob', label: 'Date of birth', type: 'date', max: fmt.today() },
      { name: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'] },
      { name: 'classSought', label: 'Class sought', required: true, placeholder: 'e.g. Grade 5' },
      { name: 'parentName', label: "Parent's name", required: true },
      { name: 'relation', label: 'Relation', type: 'select', options: ['father', 'mother', 'guardian'] },
      { name: 'phone', label: 'Phone', required: true, type: 'tel' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'source', label: 'How did they hear about us', type: 'select', options: SOURCES },
      { name: 'followUpDate', label: 'Next action date', type: 'date' },
      { name: 'address', label: 'Address', type: 'textarea', rows: 2, colSpan: 'full' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/enquiries/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/enquiries', values),
        {
          successMessage: existing ? 'Enquiry updated.' : 'Enquiry recorded.',
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

function followUpForm(enquiry, reload) {
  formModal({
    title: `Log a call — ${enquiry.childName}`,
    submitLabel: 'Save',
    columns: 1,
    values: {},
    fields: [
      { name: 'notes', label: 'What happened', type: 'textarea', rows: 3, required: true, colSpan: 'full' },
      { name: 'outcome', label: 'Outcome', type: 'select', options: OUTCOMES, placeholder: 'No change' },
      { name: 'nextActionDate', label: 'Next action date', type: 'date' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(() => api.post(`/api/enquiries/${enquiry.id}/follow-ups`, values), {
        successMessage: 'Call logged.',
        onDone: () => {
          helpers.close();
          reload();
        },
      }).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });
}

function convertForm(enquiry, reload) {
  let selectedClassId = null;
  const { formApi } = formModal({
    title: `Admit ${enquiry.childName}`,
    submitLabel: 'Admit student',
    note:
      'This creates the student, their guardian from the enquiry, and the enrollment — the same path as a normal admission.',
    values: {
      firstName: enquiry.childName.split(' ')[0],
      lastName: enquiry.childName.split(' ').slice(1).join(' '),
      dob: enquiry.dob,
      gender: enquiry.gender,
      permanentAddress: enquiry.address,
    },
    fields: [
      { name: 'firstName', label: 'First name', required: true },
      { name: 'lastName', label: 'Last name', required: true },
      { name: 'dob', label: 'Date of birth', type: 'date' },
      { name: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'] },
      { name: 'classId', label: 'Class', type: 'select', required: true, options: classOptions() },
      { name: 'sectionId', label: 'Section', type: 'select', required: true, options: () => sectionOptions(selectedClassId) },
      { name: 'permanentAddress', label: 'Address', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    onSubmit: async (values, helpers) => {
      await guardedSave(
        () =>
          api.post(`/api/enquiries/${enquiry.id}/convert`, {
            student: {
              firstName: values.firstName,
              lastName: values.lastName,
              dob: values.dob,
              gender: values.gender,
              permanentAddress: values.permanentAddress,
            },
            enrollment: { classId: values.classId, sectionId: values.sectionId },
          }),
        {
          successMessage: 'Student admitted.',
          onDone: (result) => {
            helpers.close();
            toast(`Admission number ${result.student.admissionNo}`, 'good');
            navigate(`/students/${result.student.id}`);
            reload();
          },
        }
      ).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
  });

  const classControl = formApi.control('classId');
  classControl.addEventListener('change', () => {
    selectedClassId = classControl.value || null;
    const sectionControl = formApi.control('sectionId');
    sectionControl.replaceChildren(el('option', { value: '', text: '— none —' }));
    for (const option of sectionOptions(selectedClassId)) {
      sectionControl.appendChild(el('option', { value: option.value, text: option.label }));
    }
  });
}

/* --------------------------------------------------------------- waiting list */

async function waiting(host, reload) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/enquiries/waiting/list');
    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        card({
          title: 'Section capacity',
          subtitle: 'The waiting list only makes sense against real seats. This is where they are.',
          body: table({
            columns: [
              { key: 'className', label: 'Class' },
              { key: 'sectionName', label: 'Section' },
              { key: 'enrolled', label: 'Enrolled', type: 'num' },
              { key: 'capacity', label: 'Capacity', type: 'num' },
              {
                key: 'free',
                label: 'Free',
                render: (row) =>
                  row.capacity === null
                    ? chip('No limit set', 'neutral')
                    : chip(String(row.free), row.free > 0 ? 'good' : 'bad'),
              },
            ],
            rows: data.capacity,
            emptyMessage: 'No sections set up yet.',
          }),
        }),
        card({
          title: `Waiting list (${data.rows.length})`,
          body: table({
            columns: [
              { key: 'position', label: '#', type: 'num', width: '4rem' },
              { key: 'enquiryId', label: 'Enquiry' },
              { key: 'notes', label: 'Notes' },
              { key: 'createdAt', label: 'Added', type: 'date' },
            ],
            rows: data.rows,
            emptyMessage: 'Nobody is waiting.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
  void reload;
}

/* -------------------------------------------------------------------- funnel */

async function funnel(host) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get('/api/enquiries/reports/funnel');
    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        grid(3, [
          stat({ label: 'Total enquiries', value: fmt.number(data.total) }),
          stat({ label: 'Converted', value: fmt.number(data.converted), tone: 'good' }),
          stat({
            label: 'Conversion rate',
            value: data.total ? fmt.percent((data.converted / data.total) * 100) : '—',
          }),
        ]),
        card({
          title: 'By source',
          body: table({
            columns: [
              { key: 'source', label: 'Source' },
              { key: 'total', label: 'Enquiries', type: 'num' },
              { key: 'converted', label: 'Converted', type: 'num' },
              { key: 'conversionPercent', label: 'Rate', type: 'percent' },
            ],
            rows: data.bySource,
            emptyMessage: 'No enquiries yet.',
          }),
        }),
        card({
          title: 'By month',
          body: table({
            columns: [
              { key: 'month', label: 'Month' },
              { key: 'total', label: 'Enquiries', type: 'num' },
              { key: 'converted', label: 'Converted', type: 'num' },
              { key: 'conversionPercent', label: 'Rate', type: 'percent' },
            ],
            rows: data.byMonth,
            emptyMessage: '',
          }),
        }),
        card({
          title: 'Where they are now',
          body: el(
            'div',
            { class: 'flex flex-wrap gap-2' },
            Object.entries(data.byStatus)
              .filter(([, count]) => count > 0)
              .map(([status, count]) => chip(`${fmt.humanise(status)}: ${count}`, 'neutral'))
          ),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
  void empty;
}
