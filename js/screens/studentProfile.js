/**
 * Student profile: details, guardians, enrollment history, documents, fee ledger,
 * attendance summary, plus the TC and ID card actions.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, details, statusChip, toast, spinner, tabs, icon, chip, confirm, askReason, modal, printNode, empty } from '../ui.js';
import { lookups, guardedSave, printHeader, printFooter, sectionHeading } from './_common.js';
import { can, state } from '../state.js';
import { navigate } from '../router.js';
import { qrSvg } from '../qr.js';

export async function render(container, context) {
  const studentId = context.params.id;
  container.replaceChildren(spinner());
  await lookups();

  const data = await api.get(`/api/students/${studentId}`);

  if (data.view === 'lookup') {
    container.replaceChildren(limitedView(data.student));
    return;
  }

  const student = data.student;
  let activeTab = context.query?.tab || 'overview';
  const tabHost = el('div');

  const tabItems = [
    { key: 'overview', label: 'Overview' },
    { key: 'documents', label: 'Documents' },
    can('fees.view') ? { key: 'fees', label: 'Fees' } : null,
    can('attendance.view') ? { key: 'attendance', label: 'Attendance' } : null,
  ].filter(Boolean);

  function paintTabs() {
    tabHost.replaceChildren(
      tabs(tabItems, activeTab, (key) => {
        activeTab = key;
        paintTabs();
      }),
      tabBody()
    );
  }

  function tabBody() {
    const host = el('div');
    if (activeTab === 'overview') host.appendChild(overview(data));
    if (activeTab === 'documents') loadDocuments(host, studentId);
    if (activeTab === 'fees') loadFees(host, studentId);
    if (activeTab === 'attendance') loadAttendance(host, studentId);
    return host;
  }

  paintTabs();

  container.replaceChildren(
    page({
      title: student.fullName,
      subtitle: `${student.admissionNo} • ${
        data.currentEnrollment
          ? `${className(data, data.currentEnrollment.classId)} ${sectionName(data, data.currentEnrollment.sectionId)} • Roll ${fmt.text(data.currentEnrollment.rollNo)}`
          : 'Not enrolled this year'
      }`,
      wide: true,
      actions: [
        statusChip(student.status),
        can('student.idcard')
          ? button('ID card', { iconName: 'badge', onClick: () => printIdCard(studentId) })
          : null,
        can('student.tc')
          ? button('Transfer certificate', { iconName: 'description', onClick: () => tcFlow(studentId, student) })
          : null,
        can('student.status')
          ? button('Change status', { iconName: 'swap_horiz', onClick: () => statusFlow(studentId, student) })
          : null,
        can('student.edit')
          ? button('Edit', { variant: 'primary', iconName: 'edit', onClick: () => navigate(`/students/${studentId}/edit`) })
          : null,
      ],
      children: el('div', { class: 'space-y-4' }, [tabHost]),
    })
  );
}

function limitedView(student) {
  return page({
    title: student.firstName ? `${student.firstName} ${student.lastName || ''}`.trim() : 'Student',
    subtitle: 'Your role can look up a name and class only.',
    children: card({
      body: details([
        { label: 'Admission number', value: student.admissionNo },
        { label: 'Status', node: statusChip(student.status) },
        student.permanentAddress ? { label: 'Address', value: student.permanentAddress, colSpan: 'full' } : null,
        student.city ? { label: 'City', value: student.city } : null,
      ]),
    }),
  });
}

function className(data, classId) {
  const klass = (state.lookups?.classes || []).find((row) => row.id === classId);
  return klass ? klass.name : '';
}

function sectionName(data, sectionId) {
  const section = (state.lookups?.sections || []).find((row) => row.id === sectionId);
  return section ? section.name : '';
}

function overview(data) {
  const student = data.student;
  return el('div', { class: 'grid grid-cols-1 gap-4 lg:grid-cols-3' }, [
    el('div', { class: 'space-y-4 lg:col-span-2' }, [
      card({
        title: 'Student details',
        body: details([
          { label: 'Full name', value: student.fullName },
          { label: 'Admission number', value: student.admissionNo },
          { label: 'Date of birth', value: student.dob ? fmt.date(student.dob) : null },
          { label: 'Gender', value: student.gender },
          { label: 'Blood group', value: student.bloodGroup },
          { label: 'Category', value: student.category },
          { label: 'Religion', value: student.religion },
          { label: 'Mother tongue', value: student.motherTongue },
          { label: 'Aadhaar', value: student.aadhaar },
          { label: 'Admission date', value: student.admissionDate ? fmt.date(student.admissionDate) : null },
          { label: 'Previous school', value: student.previousSchool },
          { label: 'Permanent address', value: student.permanentAddress, colSpan: 'full' },
          student.correspondenceAddress
            ? { label: 'Correspondence address', value: student.correspondenceAddress, colSpan: 'full' }
            : null,
          { label: 'City', value: student.city },
          { label: 'State', value: student.state },
          { label: 'PIN code', value: student.pincode },
          student.tcNumber ? { label: 'TC number', value: student.tcNumber } : null,
          student.tcDate ? { label: 'TC date', value: fmt.date(student.tcDate) } : null,
          student.remarks ? { label: 'Remarks', value: student.remarks, colSpan: 'full' } : null,
        ]),
      }),
      card({
        title: 'Enrollment history',
        subtitle: 'Academic records hang off these, not off the student record.',
        body: table({
          columns: [
            { key: 'academicYearId', label: 'Year', render: (row) => yearName(row.academicYearId) },
            { key: 'className', label: 'Class' },
            { key: 'sectionName', label: 'Section' },
            { key: 'rollNo', label: 'Roll' },
            { key: 'status', label: 'Status', type: 'status' },
            { key: 'enrolledAt', label: 'Enrolled', type: 'date' },
          ],
          rows: data.enrollments,
          emptyMessage: 'Not enrolled in any year yet.',
        }),
      }),
    ]),
    el('div', { class: 'space-y-4' }, [
      photoCard(student),
      card({
        title: 'Guardians',
        body:
          data.guardians.length
            ? el(
                'div',
                { class: 'space-y-3' },
                data.guardians.map((guardian) =>
                  el('div', { class: 'rounded-lg bg-ink-50 p-3' }, [
                    el('div', { class: 'flex items-center justify-between gap-2' }, [
                      el('p', { class: 'text-sm font-medium text-ink-900', text: guardian.name }),
                      guardian.isPrimary ? chip('Primary', 'good') : null,
                    ]),
                    el('p', { class: 'text-xs uppercase tracking-wide text-ink-500', text: guardian.relation }),
                    guardian.phone
                      ? el('p', { class: 'mt-1 flex items-center gap-1 text-sm' }, [icon('call', 'text-base text-ink-400'), guardian.phone])
                      : null,
                    guardian.email
                      ? el('p', { class: 'flex items-center gap-1 text-sm' }, [icon('mail', 'text-base text-ink-400'), guardian.email])
                      : null,
                    guardian.occupation
                      ? el('p', { class: 'text-xs text-ink-500', text: guardian.occupation })
                      : null,
                  ])
                )
              )
            : empty('No guardians recorded.'),
      }),
    ]),
  ]);
}

function yearName(yearId) {
  const year = (state.lookups?.years || []).find((row) => row.id === yearId);
  return year ? year.name : '—';
}

function photoCard(student) {
  const host = el('div', { class: 'flex flex-col items-center gap-3' });
  if (student.photoFile) {
    host.appendChild(
      el('img', {
        class: 'h-40 w-32 rounded-lg object-cover ring-1 ring-ink-200',
        src: `/api/students/${student.id}/photo`,
        alt: `Photo of ${student.fullName}`,
      })
    );
  } else {
    host.appendChild(
      el('div', { class: 'flex h-40 w-32 items-center justify-center rounded-lg bg-ink-100 text-ink-400' }, [
        icon('person', 'text-4xl'),
      ])
    );
  }

  if (can('student.edit')) {
    const input = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    input.addEventListener('change', async () => {
      if (!input.files?.length) return;
      const body = new FormData();
      body.append('file', input.files[0]);
      try {
        await api.upload(`/api/students/${student.id}/photo`, body);
        toast('Photo updated.', 'good');
        window.location.reload();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
    host.appendChild(input);
    host.appendChild(button(student.photoFile ? 'Replace photo' : 'Upload photo', { size: 'sm', onClick: () => input.click() }));
  }

  return card({ title: 'Photo', body: host });
}

/* --------------------------------------------------------------- documents */

async function loadDocuments(host, studentId) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get(`/api/students/${studentId}/documents`);
    host.replaceChildren(documentsCard(host, studentId, data));
  } catch (err) {
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

function documentsCard(host, studentId, data) {
  const fileInput = el('input', { type: 'file', class: 'hidden' });
  const typeSelect = el(
    'select',
    { class: 'input', style: { width: '12rem' } },
    data.docTypes.map((type) => el('option', { value: type, text: type }))
  );

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files?.length) return;
    const body = new FormData();
    body.append('file', fileInput.files[0]);
    body.append('docType', typeSelect.value);
    try {
      await api.upload(`/api/students/${studentId}/documents`, body);
      toast('Document uploaded.', 'good');
      loadDocuments(host, studentId);
    } catch (err) {
      toast(err.message, 'bad');
    }
    fileInput.value = '';
  });

  return card({
    title: 'Documents',
    subtitle: `Allowed: PDF, JPG, PNG, WEBP, XLSX, DOCX. Up to ${data.maxSizeMb} MB. Downloads go through an authorising route — file paths are never exposed.`,
    actions: can('document.upload')
      ? [typeSelect, button('Upload', { iconName: 'upload', variant: 'primary', onClick: () => fileInput.click() }), fileInput]
      : null,
    body: table({
      columns: [
        { key: 'docType', label: 'Type', width: '12rem' },
        { key: 'originalName', label: 'File' },
        { key: 'sizeBytes', label: 'Size', render: (row) => fmt.bytes(row.sizeBytes) },
        { key: 'uploadedAt', label: 'Uploaded', type: 'dateTime' },
        {
          key: 'actions',
          label: '',
          render: (row) =>
            can('document.download')
              ? button('Download', {
                  size: 'sm',
                  onClick: async () => {
                    try {
                      await api.download(`/api/documents/${row.id}/download`, null, row.originalName);
                    } catch (err) {
                      toast(err.message, 'bad');
                    }
                  },
                })
              : null,
        },
      ],
      rows: data.rows,
      emptyMessage: 'No documents uploaded yet.',
    }),
  });
}

/* -------------------------------------------------------------------- fees */

async function loadFees(host, studentId) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get(`/api/fees/students/${studentId}`);
    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        card({
          title: 'Fee summary',
          actions: can('fees.collect')
            ? [
                button('Collect payment', {
                  variant: 'primary',
                  iconName: 'payments',
                  onClick: () => navigate(`/fees/collect/${studentId}`),
                }),
              ]
            : null,
          body: el('div', { class: 'grid grid-cols-2 gap-3 sm:grid-cols-4' }, [
            miniStat('Billed', fmt.money(data.totals.billed)),
            miniStat('Concession', fmt.money(data.totals.concession)),
            miniStat('Paid', fmt.money(data.totals.paid)),
            miniStat('Balance', fmt.money(data.totals.balance), data.totals.balance > 0 ? 'text-rose-700' : 'text-emerald-700'),
          ]),
        }),
        card({
          title: 'Outstanding',
          body: table({
            columns: [
              { key: 'period', label: 'Period' },
              { key: 'feeHeadName', label: 'Fee head' },
              { key: 'dueDate', label: 'Due', type: 'date' },
              { key: 'netAmount', label: 'Amount', type: 'money' },
              { key: 'paidAmount', label: 'Paid', type: 'money' },
              { key: 'balance', label: 'Balance', type: 'money' },
            ],
            rows: data.outstanding,
            emptyMessage: 'Nothing outstanding.',
          }),
        }),
        card({
          title: 'Payments',
          body: table({
            columns: [
              { key: 'receiptNo', label: 'Receipt' },
              { key: 'paidAt', label: 'Date', type: 'dateTime' },
              { key: 'mode', label: 'Mode' },
              { key: 'amount', label: 'Amount', type: 'money' },
              { key: 'status', label: 'Status', type: 'status' },
            ],
            rows: [...data.payments, ...data.reversed],
            emptyMessage: 'No payments recorded.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

function miniStat(label, value, tone = '') {
  return el('div', { class: 'rounded-lg bg-ink-50 p-3' }, [
    el('p', { class: 'text-xs uppercase tracking-wide text-ink-500', text: label }),
    el('p', { class: `mt-0.5 text-lg font-semibold tabular-nums ${tone}`, text: value }),
  ]);
}

/* -------------------------------------------------------------- attendance */

async function loadAttendance(host, studentId) {
  host.replaceChildren(spinner());
  try {
    const data = await api.get(`/api/attendance/student/${studentId}`);
    host.replaceChildren(
      el('div', { class: 'space-y-4' }, [
        card({
          title: 'Attendance this year',
          body: el('div', { class: 'grid grid-cols-2 gap-3 sm:grid-cols-5' }, [
            miniStat('Days recorded', fmt.number(data.summary.total)),
            miniStat('Present', fmt.number(data.summary.Present)),
            miniStat('Absent', fmt.number(data.summary.Absent)),
            miniStat('Late', fmt.number(data.summary.Late)),
            miniStat('Percentage', fmt.percent(data.summary.percent)),
          ]),
        }),
        card({
          title: 'Days not present',
          body: table({
            dense: true,
            columns: [
              { key: 'date', label: 'Date', type: 'date' },
              { key: 'status', label: 'Status', type: 'status' },
              { key: 'reason', label: 'Reason' },
            ],
            rows: data.rows.filter((row) => row.status !== 'Present'),
            emptyMessage: 'Present every recorded day.',
          }),
        }),
      ])
    );
  } catch (err) {
    host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
  }
}

/* ------------------------------------------------------------------ actions */

async function statusFlow(studentId, student) {
  const select = el(
    'select',
    { class: 'input' },
    ['Active', 'TC Issued', 'Left', 'Alumni'].map((status) =>
      el('option', { value: status, text: status, selected: status === student.status })
    )
  );
  const reason = el('textarea', { class: 'input', rows: 2, placeholder: 'Why is this changing?' });
  const date = el('input', { class: 'input', type: 'date', value: fmt.today() });

  modal({
    title: `Change status for ${student.fullName}`,
    size: 'sm',
    body: el('div', { class: 'space-y-3' }, [
      el('p', {
        class: 'text-sm text-ink-600',
        text: 'Students are never deleted. A status change keeps their fee, marks and attendance history intact.',
      }),
      el('div', {}, [el('label', { class: 'label', text: 'New status' }), select]),
      el('div', {}, [el('label', { class: 'label', text: 'Effective date' }), date]),
      el('div', {}, [el('label', { class: 'label', text: 'Reason' }), reason]),
    ]),
    actions: (close) => [
      button('Cancel', { onClick: close }),
      button('Save', {
        variant: 'primary',
        onClick: async () => {
          await guardedSave(
            () =>
              api.post(`/api/students/${studentId}/status`, {
                status: select.value,
                reason: reason.value || null,
                date: date.value || null,
              }),
            {
              successMessage: 'Status updated.',
              onDone: () => {
                close();
                window.location.reload();
              },
            }
          ).catch(() => {});
        },
      }),
    ],
  });
}

async function tcFlow(studentId, student) {
  if (student.status === 'TC Issued') {
    await printTc(studentId);
    return;
  }
  const proceed = await confirm({
    title: 'Issue a transfer certificate',
    message: `This allocates a TC number, marks ${student.fullName} as TC Issued and closes their enrollment.`,
    detail: 'The record stays in the portal permanently. This is recorded in the audit log.',
    confirmLabel: 'Issue certificate',
    danger: true,
  });
  if (!proceed) return;

  const reason = await askReason({
    title: 'Reason for the transfer',
    label: 'Reason',
    confirmLabel: 'Issue',
    minLength: 3,
  });
  if (reason === null) return;

  await guardedSave(
    () => api.post(`/api/students/${studentId}/transfer-certificate`, { reason, date: fmt.today() }),
    {
      successMessage: 'Transfer certificate issued.',
      onDone: async (result) => {
        toast(`TC number ${result.tcNumber}`, 'good');
        await printTc(studentId);
      },
    }
  ).catch(() => {});
}

async function printTc(studentId) {
  const data = await api.get(`/api/students/${studentId}/transfer-certificate`);
  const student = data.student;
  const guardian = data.guardians.find((g) => g.isPrimary) || data.guardians[0] || {};

  const node = el('div', { class: 'print-page mx-auto max-w-3xl bg-white p-8 text-sm' }, [
    printHeader(data.school, 'Transfer Certificate', student.tcNumber ? `Certificate No. ${student.tcNumber}` : null),
    el('div', { class: 'space-y-2' }, [
      line('Name of the student', student.fullName),
      line("Father's / Guardian's name", guardian.name),
      line('Admission number', student.admissionNo),
      line('Date of birth', student.dob ? fmt.date(student.dob) : '—'),
      line('Class last attended', `${data.className} ${data.sectionName}`.trim()),
      line('Date of admission', student.admissionDate ? fmt.date(student.admissionDate) : '—'),
      line('Date of leaving', student.leftDate ? fmt.date(student.leftDate) : '—'),
      line('Category', student.category),
      line('Address', student.permanentAddress),
      line('Character and conduct', 'Satisfactory'),
      line('Reason for leaving', student.remarks ? String(student.remarks).split('\n').pop() : '—'),
    ]),
    el('div', { class: 'mt-12 flex justify-between text-xs' }, [
      el('div', { class: 'text-center' }, [
        el('div', { class: 'mb-1 h-10 border-b border-ink-400', style: { width: '10rem' } }),
        'Class Teacher',
      ]),
      el('div', { class: 'text-center' }, [
        el('div', { class: 'mb-1 h-10 border-b border-ink-400', style: { width: '10rem' } }),
        'Office',
      ]),
      el('div', { class: 'text-center' }, [
        el('div', { class: 'mb-1 h-10 border-b border-ink-400', style: { width: '10rem' } }),
        data.school?.principalName || 'Principal',
      ]),
    ]),
    printFooter(data.generatedBy, data.generatedAt),
  ]);

  printNode(node, { title: `TC ${student.admissionNo}` });
}

function line(label, value) {
  return el('div', { class: 'flex gap-2 border-b border-dotted border-ink-300 py-1' }, [
    el('span', { class: 'w-56 flex-none text-ink-600', text: label }),
    el('span', { class: 'font-medium', text: fmt.text(value) }),
  ]);
}

async function printIdCard(studentId) {
  const data = await api.get(`/api/students/${studentId}/id-card`);
  printNode(idCardNode(data), { title: `ID card ${data.student.admissionNo}` });
}

export function idCardNode(data) {
  const student = data.student;
  return el(
    'div',
    {
      class: 'print-page inline-block overflow-hidden rounded-xl bg-white ring-1 ring-ink-300',
      style: { width: '54mm', height: '86mm' },
    },
    [
      el('div', { class: 'bg-brand-700 px-2 py-1.5 text-center text-white' }, [
        el('p', { class: 'truncate text-[9px] font-bold uppercase tracking-wide', text: data.school?.name || 'School' }),
        data.academicYear ? el('p', { class: 'text-[7px] opacity-80', text: data.academicYear }) : null,
      ]),
      el('div', { class: 'flex flex-col items-center gap-1 px-2 py-2' }, [
        student.photoFile
          ? el('img', {
              class: 'h-[22mm] w-[18mm] rounded object-cover ring-1 ring-ink-200',
              src: `/api/students/${student.id}/photo`,
              alt: '',
            })
          : el('div', { class: 'flex h-[22mm] w-[18mm] items-center justify-center rounded bg-ink-100' }, [
              icon('person', 'text-2xl text-ink-400'),
            ]),
        el('p', { class: 'text-center text-[10px] font-bold leading-tight', text: student.fullName }),
        el('p', { class: 'text-[8px] text-ink-600', text: `${data.className} ${data.sectionName} • Roll ${fmt.text(data.rollNo)}` }),
        el('div', { class: 'w-full space-y-0.5 text-[7px] text-ink-700' }, [
          idLine('Adm No', student.admissionNo),
          idLine('DOB', student.dob ? fmt.date(student.dob) : '—'),
          idLine('Blood', student.bloodGroup || '—'),
          idLine('Guardian', data.guardianName || '—'),
          idLine('Phone', data.guardianPhone || '—'),
        ]),
        qrSvg(data.qrPayload, { size: 60, margin: 2 }),
      ]),
    ]
  );
}

function idLine(label, value) {
  return el('div', { class: 'flex justify-between gap-1' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('span', { class: 'truncate font-medium', text: value }),
  ]);
}
