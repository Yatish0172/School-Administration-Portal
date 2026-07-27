/**
 * Admission and student edit (SPEC §6).
 *
 * Admission writes the student, their guardians and the enrollment in one
 * transaction — a student with no enrollment is not a usable record, and the
 * admission number would be burnt for nothing.
 */

import { api } from '../api.js';
import { el, page, card, button, form, fmt, toast, spinner, icon } from '../ui.js';
import { lookups, classOptions, sectionOptions, guardedSave, readOnlyNotice } from './_common.js';
import { navigate } from '../router.js';

const GENDERS = ['Male', 'Female', 'Other'];
const CATEGORIES = ['General', 'OBC', 'SC', 'ST', 'EWS', 'Other'];
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
const RELATIONS = [
  { value: 'father', label: 'Father' },
  { value: 'mother', label: 'Mother' },
  { value: 'guardian', label: 'Local guardian' },
];

export async function render(container, context = {}) {
  const studentId = context.params?.id || null;
  const editing = !!studentId;

  container.replaceChildren(spinner());
  await lookups();

  let existing = null;
  if (editing) {
    existing = await api.get(`/api/students/${studentId}`);
  }

  const guardianHost = el('div', { class: 'space-y-3' });
  const guardians = editing && existing.guardians?.length
    ? existing.guardians.map((guardian) => ({ ...guardian }))
    : [{ relation: 'father', isPrimary: true }];

  let selectedClassId = existing?.currentEnrollment?.classId || null;

  const profileForm = form({
    fields: [
      { name: 'firstName', label: 'First name', required: true },
      { name: 'middleName', label: 'Middle name' },
      { name: 'lastName', label: 'Last name', required: true },
      { name: 'dob', label: 'Date of birth', type: 'date', max: fmt.today() },
      { name: 'gender', label: 'Gender', type: 'select', options: GENDERS },
      { name: 'bloodGroup', label: 'Blood group', type: 'select', options: BLOOD_GROUPS },
      { name: 'category', label: 'Category', type: 'select', options: CATEGORIES },
      { name: 'religion', label: 'Religion' },
      { name: 'motherTongue', label: 'Mother tongue' },
      { name: 'nationality', label: 'Nationality' },
      { name: 'aadhaar', label: 'Aadhaar number', maxLength: 12, inputMode: 'numeric', hint: '12 digits, or leave blank.' },
      {
        name: 'admissionNo',
        label: 'Admission number',
        hint: editing ? 'Changing this affects printed records.' : 'Leave blank to generate the next one automatically.',
      },
      { name: 'admissionDate', label: 'Admission date', type: 'date' },
      { name: 'previousSchool', label: 'Previous school', colSpan: 'full' },
      { name: 'permanentAddress', label: 'Permanent address', type: 'textarea', rows: 2, colSpan: 'full' },
      { name: 'correspondenceAddress', label: 'Correspondence address', type: 'textarea', rows: 2, colSpan: 'full', hint: 'Leave blank if it is the same as above.' },
      { name: 'city', label: 'City' },
      { name: 'state', label: 'State' },
      { name: 'pincode', label: 'PIN code', maxLength: 6, inputMode: 'numeric' },
      { name: 'remarks', label: 'Remarks', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    values: existing?.student || { nationality: 'Indian', admissionDate: fmt.today() },
    submitLabel: editing ? 'Save changes' : 'Admit student',
    onSubmit: async (values, helpers) => {
      const guardianPayload = readGuardians(guardianHost, guardians);
      if (!guardianPayload.length) {
        toast('Add at least one guardian with a phone number.', 'warn');
        return;
      }

      if (editing) {
        await guardedSave(
          async () => {
            await api.put(`/api/students/${studentId}`, { ...values, _rev: existing.student._rev });
            await api.put(`/api/students/${studentId}/guardians`, { guardians: guardianPayload });
          },
          {
            successMessage: 'Student updated.',
            onDone: () => navigate(`/students/${studentId}`),
          }
        ).catch((err) => {
          if (err.fields) helpers.setErrors(err.fields, err.message);
        });
        return;
      }

      const enrollmentValues = enrollmentForm.values();
      if (!enrollmentValues.classId || !enrollmentValues.sectionId) {
        toast('Choose the class and section for this admission.', 'warn');
        enrollmentForm.setErrors({
          classId: !enrollmentValues.classId ? 'Required.' : undefined,
          sectionId: !enrollmentValues.sectionId ? 'Required.' : undefined,
        });
        return;
      }

      await guardedSave(
        () =>
          api.post('/api/students', {
            student: values,
            guardians: guardianPayload,
            enrollment: enrollmentValues,
          }),
        {
          successMessage: 'Student admitted.',
          onDone: (result) => navigate(`/students/${result.student.id}`),
        }
      ).catch((err) => {
        if (err.fields) helpers.setErrors(err.fields, err.message);
      });
    },
    onCancel: () => navigate(editing ? `/students/${studentId}` : '/students'),
  });

  const enrollmentForm = form({
    fields: [
      {
        name: 'classId',
        label: 'Class',
        type: 'select',
        required: true,
        options: classOptions(),
        placeholder: 'Choose a class',
      },
      {
        name: 'sectionId',
        label: 'Section',
        type: 'select',
        required: true,
        options: () => sectionOptions(selectedClassId),
        placeholder: 'Choose a section',
      },
      { name: 'rollNo', label: 'Roll number', hint: 'Leave blank for the next free number.' },
    ],
    columns: 3,
    values: {},
    submitLabel: 'unused',
    onSubmit: () => {},
  });
  // The enrollment block is part of the admission form, not its own submission.
  enrollmentForm.node.querySelector('button[type="submit"]').remove();
  enrollmentForm.node.addEventListener('submit', (event) => event.preventDefault());

  const classControl = enrollmentForm.control('classId');
  classControl.addEventListener('change', async () => {
    selectedClassId = classControl.value || null;
    const sectionControl = enrollmentForm.control('sectionId');
    sectionControl.replaceChildren(el('option', { value: '', text: 'Choose a section' }));
    for (const option of sectionOptions(selectedClassId)) {
      sectionControl.appendChild(el('option', { value: option.value, text: option.label }));
    }
  });

  paintGuardians(guardianHost, guardians);

  container.replaceChildren(
    page({
      title: editing ? `Edit ${existing.student.fullName}` : 'New admission',
      subtitle: editing
        ? `Admission number ${existing.student.admissionNo}`
        : 'The admission number is generated automatically when you save.',
      children: el('div', { class: 'space-y-4' }, [
        readOnlyNotice(),
        card({ title: 'Student details', body: profileForm.node }),
        card({
          title: 'Guardians',
          subtitle: 'At least one guardian needs a phone number the office can call.',
          actions: [
            button('Add guardian', {
              iconName: 'person_add',
              size: 'sm',
              onClick: () => {
                guardians.push({ relation: 'guardian', isPrimary: false });
                paintGuardians(guardianHost, guardians);
              },
            }),
          ],
          body: guardianHost,
        }),
        editing
          ? null
          : card({
              title: 'Enrollment',
              subtitle:
                'Everything academic hangs off the enrollment, not the student record, so this is set at admission.',
              body: enrollmentForm.node,
            }),
      ]),
    })
  );

  // The submit button lives in the profile form, so move it visually to the end.
  profileForm.focus('firstName');
}

function paintGuardians(host, guardians) {
  host.replaceChildren(
    ...guardians.map((guardian, index) =>
      el('div', { class: 'rounded-lg bg-ink-50 p-3', dataset: { guardianIndex: index } }, [
        el('div', { class: 'mb-2 flex items-center justify-between' }, [
          el('p', { class: 'text-xs font-semibold uppercase tracking-wide text-ink-500', text: `Guardian ${index + 1}` }),
          guardians.length > 1
            ? el('button', {
                type: 'button',
                class: 'btn-ghost btn-sm',
                title: 'Remove',
                on: {
                  click: () => {
                    guardians.splice(index, 1);
                    paintGuardians(host, guardians);
                  },
                },
              }, [icon('delete', 'text-base')])
            : null,
        ]),
        el('div', { class: 'grid grid-cols-1 gap-3 sm:grid-cols-3' }, [
          field('relation', 'Relation', guardian.relation, index, 'select'),
          field('name', 'Name', guardian.name, index),
          field('phone', 'Phone', guardian.phone, index, 'tel'),
          field('email', 'Email', guardian.email, index, 'email'),
          field('occupation', 'Occupation', guardian.occupation, index),
          field('annualIncome', 'Annual income', guardian.annualIncome, index, 'number'),
        ]),
        el('label', { class: 'mt-2 flex items-center gap-2 text-sm' }, [
          el('input', {
            type: 'radio',
            name: 'primaryGuardian',
            value: String(index),
            checked: !!guardian.isPrimary,
            class: 'h-4 w-4 border-ink-300 text-brand-600',
          }),
          'Primary contact',
        ]),
      ])
    )
  );
}

function field(name, label, value, index, type = 'text') {
  if (type === 'select') {
    const select = el(
      'select',
      { class: 'input', dataset: { field: name } },
      RELATIONS.map((option) =>
        el('option', { value: option.value, text: option.label, selected: option.value === value })
      )
    );
    return el('div', {}, [el('label', { class: 'label', text: label }), select]);
  }
  return el('div', {}, [
    el('label', { class: 'label', text: label }),
    el('input', {
      class: 'input',
      type,
      value: value ?? '',
      dataset: { field: name },
      autocomplete: 'off',
    }),
  ]);
}

function readGuardians(host, guardians) {
  const out = [];
  host.querySelectorAll('[data-guardian-index]').forEach((block, index) => {
    const record = { ...guardians[index] };
    block.querySelectorAll('[data-field]').forEach((control) => {
      const key = control.dataset.field;
      record[key] = control.value === '' ? null : control.value;
    });
    const primary = block.querySelector('input[name="primaryGuardian"]');
    record.isPrimary = !!primary?.checked;
    if (record.name) out.push(record);
  });
  // Nobody ticked primary — the first guardian is the sensible default.
  if (out.length && !out.some((guardian) => guardian.isPrimary)) out[0].isPrimary = true;
  return out;
}
