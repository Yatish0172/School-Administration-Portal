/**
 * Login and the forced first-sign-in password change.
 *
 * The login form also carries the device enrollment code, because SPEC §2 has the
 * staff member prove the code and their credentials in one step: "opens the link,
 * enters the code, logs in once".
 */

import { api } from './api.js';
import { setSession, state } from './state.js';
import { el, clear, icon, form, toast, fmt, button, modal } from './ui.js';

export function renderLogin(container, onSignedIn) {
  clear(container);

  // An enrollment link looks like #/login?code=ABCD-EFGH&user=rekha
  const params = new URLSearchParams((window.location.hash.split('?')[1] || ''));
  const prefilledCode = params.get('code') || '';
  const prefilledUser = params.get('user') || '';

  let schoolName = 'School Admin Portal';
  const heading = el('h1', { class: 'font-display text-2xl font-semibold text-ink-900', text: schoolName });
  const subheading = el('p', { class: 'mt-1 text-sm text-ink-500', text: 'Sign in to continue' });
  const clockNote = el('p', { class: 'mt-4 text-center text-xs text-ink-400', text: '' });

  const showCodeField = !!prefilledCode;
  const codeToggle = el('button', {
    type: 'button',
    class: 'text-xs font-medium text-brand-700 hover:underline',
    text: 'I have a device enrollment code',
  });

  const fields = [
    {
      name: 'username',
      label: 'Username',
      required: true,
      colSpan: 'full',
      autocomplete: 'username',
      value: prefilledUser,
      placeholder: 'As given by the office',
    },
    {
      name: 'secret',
      label: 'Password or PIN',
      type: 'password',
      required: true,
      colSpan: 'full',
      autocomplete: 'current-password',
    },
  ];

  if (showCodeField) {
    fields.push(codeField(prefilledCode), deviceNameField());
  }

  const formApi = form({
    fields,
    values: { username: prefilledUser, enrollmentCode: prefilledCode },
    columns: 1,
    submitLabel: 'Sign in',
    onSubmit: async (values, helpers) => {
      helpers.setBusy(true, 'Signing in…');
      try {
        const session = await api.post('/api/login', {
          username: values.username,
          secret: values.secret,
          enrollmentCode: values.enrollmentCode || undefined,
          deviceName: values.deviceName || undefined,
        });
        setSession(session);
        // Clear the code out of the URL so it is not re-used or bookmarked.
        window.history.replaceState(null, '', window.location.pathname);
        await onSignedIn();
      } catch (err) {
        helpers.setBusy(false);
        if (err.code === 'FORBIDDEN' && /not registered/i.test(err.message)) {
          showEnrollmentHelp(formApi, err.message);
          return;
        }
        helpers.setErrors(err.fields || {}, err.message);
      }
    },
  });

  const card = el('div', { class: 'card w-full max-w-sm p-6' }, [
    el('div', { class: 'mb-5 text-center' }, [
      el('div', { class: 'mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white' }, [
        icon('school', 'text-2xl'),
      ]),
      heading,
      subheading,
    ]),
    formApi.node,
    showCodeField
      ? null
      : el('div', { class: 'mt-4 text-center' }, [codeToggle]),
    clockNote,
  ]);

  codeToggle.addEventListener('click', () => {
    codeToggle.remove();
    renderLoginWithCode(container, onSignedIn, formApi.values());
  });

  container.appendChild(
    el('div', { class: 'flex min-h-screen items-center justify-center bg-ink-100 p-4' }, [card])
  );

  formApi.focus(prefilledUser ? 'secret' : 'username');

  // Server time on the sign-in screen makes a wrong clock obvious immediately, and
  // tells staff whether the portal is open before they even try.
  api
    .get('/api/health')
    .then((health) => {
      clockNote.textContent = `Server time ${fmt.time(health.serverTime || health.time)} • ${
        health.open ? 'portal is open' : 'portal is closed'
      }`;
    })
    .catch(() => {
      clockNote.textContent = 'Cannot reach the school server.';
    });
}

function codeField(value = '') {
  return {
    name: 'enrollmentCode',
    label: 'Device enrollment code',
    colSpan: 'full',
    value,
    placeholder: 'ABCD-EFGH',
    maxLength: 12,
    hint: 'From the office. Valid for 10 minutes and works once.',
  };
}

function deviceNameField() {
  return {
    name: 'deviceName',
    label: 'Name this device',
    colSpan: 'full',
    placeholder: "e.g. Rekha's phone",
    hint: 'So the office can recognise it in the device list.',
  };
}

function renderLoginWithCode(container, onSignedIn, previous) {
  // Re-render with the code fields visible, keeping whatever was typed.
  const hash = window.location.hash.split('?')[0];
  const query = new URLSearchParams();
  query.set('code', '');
  if (previous.username) query.set('user', previous.username);
  window.history.replaceState(null, '', `${window.location.pathname}${hash}?${query}`);
  renderLogin(container, onSignedIn);
}

function showEnrollmentHelp(formApi, message) {
  modal({
    title: 'This device is not registered',
    size: 'sm',
    body: [
      el('p', { class: 'text-sm text-ink-700', text: message }),
      el('p', {
        class: 'mt-3 text-sm text-ink-700',
        text:
          'Ask the office to open Settings → Devices and issue you an enrollment code. ' +
          'Enter it below along with your password and this device will be registered.',
      }),
    ],
    actions: (close) => [
      button('Enter a code', {
        variant: 'primary',
        onClick: () => {
          close();
          const codeControl = formApi.control('enrollmentCode');
          if (codeControl) codeControl.focus();
          else window.location.reload();
        },
      }),
    ],
  });
}

/**
 * Forced change on first sign-in, and after an admin reset. Nothing else in the app
 * is reachable until this is done — the server enforces that too.
 */
export function renderForcedChange(container, onDone) {
  clear(container);

  const formApi = form({
    fields: [
      {
        name: 'currentPassword',
        label: 'Current password or PIN',
        type: 'password',
        required: true,
        colSpan: 'full',
        autocomplete: 'current-password',
      },
      {
        name: 'newPassword',
        label: 'New password',
        type: 'password',
        required: true,
        colSpan: 'full',
        autocomplete: 'new-password',
        hint:
          state.user?.credentialType === 'pin'
            ? 'A 6-digit PIN.'
            : 'At least 8 characters. Use something you will not need to write down.',
      },
      {
        name: 'confirmPassword',
        label: 'Repeat the new password',
        type: 'password',
        required: true,
        colSpan: 'full',
        autocomplete: 'new-password',
      },
    ],
    columns: 1,
    submitLabel: 'Set my password',
    onSubmit: async (values, helpers) => {
      if (values.newPassword !== values.confirmPassword) {
        helpers.setErrors({ confirmPassword: 'These do not match.' });
        return;
      }
      try {
        await api.post('/api/me/password', values);
        toast('Password changed. Sign in with your new password.', 'good');
        onDone();
      } catch (err) {
        helpers.setErrors(err.fields || {}, err.message);
      }
    },
  });

  container.appendChild(
    el('div', { class: 'flex min-h-screen items-center justify-center bg-ink-100 p-4' }, [
      el('div', { class: 'card w-full max-w-sm p-6' }, [
        el('div', { class: 'mb-5' }, [
          el('h1', { class: 'font-display text-xl font-semibold', text: 'Choose your password' }),
          el('p', {
            class: 'mt-1 text-sm text-ink-500',
            text: `Welcome ${state.user?.name || ''}. Set your own password before you carry on — the one you were given cannot be used again.`,
          }),
        ]),
        formApi.node,
      ]),
    ])
  );

  formApi.focus('currentPassword');
}
