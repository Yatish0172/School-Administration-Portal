/**
 * Users (SPEC §4, T04/T05). Accounts are disabled, never deleted, so the audit
 * history keeps pointing at a real person.
 *
 * A reset credential is shown exactly once, for the admin to read out.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, statusChip, formModal, modal, toast, searchBox, filterSelect, confirm, pager } from '../ui.js';
import { guardedSave, readOnlyNotice } from './_common.js';
import { state } from '../state.js';

export async function render(container, context = {}) {
  const view = { search: context.query?.search || '', status: null, page: 1 };
  const host = el('div');
  const filterHost = el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' });

  function paintFilters(roles) {
    filterHost.replaceChildren(
      searchBox('Search name, username or role…', (value) => {
        view.search = value;
        view.page = 1;
        load();
      }, view.search),
      filterSelect({
        label: 'Status',
        options: ['active', 'disabled'],
        value: view.status,
        placeholder: 'All',
        onChange: (value) => {
          view.status = value;
          load();
        },
      }),
      button('Add a user', {
        variant: 'primary',
        iconName: 'person_add',
        onClick: () => userForm(null, roles, load),
      })
    );
  }

  async function load() {
    host.replaceChildren(spinner());
    try {
      const data = await api.get('/api/users', {
        search: view.search,
        status: view.status,
        page: view.page,
        pageSize: 50,
      });
      paintFilters(data.roles);
      host.replaceChildren(listCard(data, view, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Users',
      subtitle:
        'Shared accounts are prohibited — every person gets their own, so the audit log means something.',
      wide: true,
      children: el('div', {}, [readOnlyNotice(), filterHost, host]),
    })
  );

  await load();
}

function listCard(data, view, reload) {
  return card({
    title: `${fmt.number(data.total)} user${data.total === 1 ? '' : 's'}`,
    body: el('div', {}, [
      table({
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'username', label: 'Username', width: '10rem' },
          {
            key: 'roleKey',
            label: 'Role',
            width: '12rem',
            render: (row) => data.roles.find((role) => role.key === row.roleKey)?.name || row.roleKey,
          },
          {
            key: 'credentialType',
            label: 'Signs in with',
            width: '8rem',
            render: (row) => chip(row.credentialType === 'pin' ? 'PIN' : 'Password', 'neutral'),
          },
          {
            key: 'lastLoginAt',
            label: 'Last signed in',
            width: '10rem',
            render: (row) => (row.lastLoginAt ? fmt.ago(row.lastLoginAt) : 'never'),
          },
          {
            key: 'status',
            label: 'Status',
            width: '9rem',
            render: (row) =>
              row.locked
                ? chip(`Locked ${row.lockedMinutes}m`, 'bad')
                : row.mustChangePassword
                  ? chip('Must change', 'warn')
                  : statusChip(row.status),
          },
          {
            key: 'actions',
            label: '',
            render: (row) =>
              el('div', { class: 'flex flex-wrap gap-1' }, [
                button('Edit', { size: 'sm', onClick: () => userForm(row, data.roles, reload) }),
                button('Reset', {
                  size: 'sm',
                  onClick: () => resetFlow(row, reload),
                }),
                row.locked
                  ? button('Unlock', {
                      size: 'sm',
                      onClick: async () => {
                        await guardedSave(() => api.post(`/api/users/${row.id}/unlock`), {
                          successMessage: 'Account unlocked.',
                          onDone: reload,
                        }).catch(() => {});
                      },
                    })
                  : null,
                row.id === state.user?.id
                  ? null
                  : button(row.status === 'active' ? 'Disable' : 'Enable', {
                      size: 'sm',
                      onClick: () => statusFlow(row, reload),
                    }),
              ]),
          },
        ],
        rows: data.rows,
        emptyMessage: 'No users match.',
      }),
      pager({
        page: data.page,
        pages: data.pages,
        total: data.total,
        onChange: (next) => {
          view.page = next;
          reload();
        },
      }),
    ]),
  });
}

function userForm(existing, roles, reload) {
  const passwordRoles = new Set(['admin', 'principal', 'accounts', 'exam']);

  formModal({
    title: existing ? `Edit ${existing.name}` : 'Add a user',
    submitLabel: existing ? 'Save' : 'Create user',
    size: 'lg',
    note: existing
      ? 'To change their password, use Reset — it produces a one-time credential they must change at next sign-in.'
      : 'Roles that touch money or marks must use a password. Teachers, library, transport and attendance staff may use a 6-digit PIN, which is only safe because of the lockout.',
    values: existing || { credentialType: 'password', mustChangePassword: true, deviceCap: 2 },
    fields: [
      { name: 'name', label: 'Full name', required: true },
      {
        name: 'username',
        label: 'Username',
        required: true,
        disabled: !!existing,
        hint: existing ? 'Usernames cannot be changed.' : 'Letters, numbers, dot, dash and underscore.',
      },
      {
        name: 'roleKey',
        label: 'Role',
        type: 'select',
        required: true,
        options: roles.map((role) => ({ value: role.key, label: role.name })),
      },
      { name: 'department', label: 'Department' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      {
        name: 'credentialType',
        label: 'Signs in with',
        type: 'select',
        required: true,
        options: [
          { value: 'password', label: 'Password (at least 8 characters)' },
          { value: 'pin', label: '6-digit PIN' },
        ],
        hint: 'A PIN is refused for roles that handle money or marks.',
      },
      {
        name: 'secret',
        label: 'Initial password or PIN',
        type: 'password',
        required: !existing,
        when: () => !existing,
        hint: 'They will be asked to change this the first time they sign in.',
      },
      {
        name: 'deviceCap',
        label: 'Devices allowed',
        type: 'number',
        min: 1,
        max: 20,
        hint: 'How many of their own devices they may enroll.',
      },
      {
        name: 'mustChangePassword',
        label: 'Force a password change at first sign-in',
        type: 'checkbox',
        when: () => !existing,
      },
    ],
    onSubmit: async (values, helpers) => {
      if (!existing && values.credentialType === 'pin' && passwordRoles.has(values.roleKey)) {
        helpers.setErrors(
          { credentialType: 'This role handles sensitive data and needs a password.' },
          'A PIN is not allowed for this role.'
        );
        return;
      }
      await guardedSave(
        () =>
          existing
            ? api.put(`/api/users/${existing.id}`, { ...values, _rev: existing._rev })
            : api.post('/api/users', values),
        {
          successMessage: existing ? 'User saved.' : 'User created.',
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

async function resetFlow(row, reload) {
  const proceed = await confirm({
    title: `Reset the credential for ${row.name}?`,
    message:
      'A new one-time password or PIN is generated and shown once. Their current one stops working immediately and every session of theirs ends.',
    confirmLabel: 'Reset',
    danger: true,
  });
  if (!proceed) return;

  try {
    const result = await api.post(`/api/users/${row.id}/reset-credential`);
    modal({
      title: `New ${result.credentialType} for ${row.name}`,
      size: 'sm',
      closeOnBackdrop: false,
      body: el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-sm text-ink-700', text: result.note }),
        el('p', {
          class: 'select-all rounded-lg bg-ink-900 px-4 py-3 text-center font-mono text-xl font-bold text-white',
          text: result.secret,
        }),
        el('p', {
          class: 'text-xs text-ink-500',
          text: 'They must change it the first time they sign in. It is not stored anywhere and cannot be shown again.',
        }),
      ]),
      actions: (close) => [
        button('I have passed it on', {
          variant: 'primary',
          onClick: () => {
            close();
            reload();
          },
        }),
      ],
    });
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function statusFlow(row, reload) {
  const disabling = row.status === 'active';
  const proceed = await confirm({
    title: `${disabling ? 'Disable' : 'Re-enable'} ${row.name}?`,
    message: disabling
      ? 'They are signed out immediately and cannot sign in again. The record and all their history stay.'
      : 'They will be able to sign in again with their existing credential.',
    confirmLabel: disabling ? 'Disable' : 'Enable',
    danger: disabling,
  });
  if (!proceed) return;
  await guardedSave(
    () => api.post(`/api/users/${row.id}/status`, { status: disabling ? 'disabled' : 'active' }),
    { successMessage: disabling ? 'User disabled.' : 'User enabled.', onDone: reload }
  ).catch(() => {});
}
