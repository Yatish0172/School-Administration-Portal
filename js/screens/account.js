/**
 * My account: change your own password, see your permissions and your devices.
 */

import { api } from '../api.js';
import { el, page, card, button, form, fmt, spinner, chip, toast, details, table } from '../ui.js';
import { state } from '../state.js';

export async function render(container) {
  container.replaceChildren(spinner());

  let hours = null;
  try {
    hours = await api.get('/api/hours/state');
  } catch (err) {
    hours = null;
  }

  const user = state.user;

  const passwordForm = form({
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
          user?.credentialType === 'pin'
            ? 'A 6-digit PIN.'
            : 'At least 8 characters. Long is better than complicated.',
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
    submitLabel: 'Change my password',
    onSubmit: async (values, helpers) => {
      if (values.newPassword !== values.confirmPassword) {
        helpers.setErrors({ confirmPassword: 'These do not match.' });
        return;
      }
      try {
        await api.post('/api/me/password', values);
        toast('Password changed. Sign in again with the new one.', 'good', 8000);
        setTimeout(() => window.location.reload(), 1500);
      } catch (err) {
        helpers.setErrors(err.fields || {}, err.message);
      }
    },
  });

  const byModule = new Map();
  for (const permission of user?.permissions || []) {
    const module = permission.split('.')[0];
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module).push(permission);
  }

  container.replaceChildren(
    page({
      title: 'My account',
      subtitle: 'Your own sign-in details and what your role allows.',
      children: el('div', { class: 'grid grid-cols-1 gap-4 lg:grid-cols-2' }, [
        el('div', { class: 'space-y-4' }, [
          card({
            title: 'Who you are signed in as',
            body: details([
              { label: 'Name', value: user?.name },
              { label: 'Username', value: user?.username },
              { label: 'Role', value: fmt.humanise(user?.roleKey) },
              { label: 'Department', value: user?.department },
              { label: 'Signs in with', value: user?.credentialType === 'pin' ? '6-digit PIN' : 'Password' },
              { label: 'Last signed in', value: user?.lastLoginAt ? fmt.dateTime(user.lastLoginAt) : 'this is your first time' },
              {
                label: 'Devices allowed',
                value: user?.deviceCap ? String(user.deviceCap) : 'as per school setting',
              },
            ]),
          }),
          card({
            title: 'Change your password',
            subtitle: 'Every other session of yours ends when you change it.',
            body: passwordForm.node,
          }),
        ]),
        el('div', { class: 'space-y-4' }, [
          hours
            ? card({
                title: 'Your access right now',
                body: el('div', { class: 'space-y-2 text-sm' }, [
                  el('div', { class: 'flex items-center gap-2' }, [
                    chip(
                      hours.access === 'full' ? 'Full access' : hours.access === 'readOnly' ? 'Read only' : 'Blocked',
                      hours.access === 'full' ? 'good' : hours.access === 'readOnly' ? 'warn' : 'bad'
                    ),
                    el('span', { class: 'text-ink-500', text: `Server time ${fmt.time(hours.serverTime)}` }),
                  ]),
                  hours.message ? el('p', { class: 'text-ink-600', text: hours.message }) : null,
                  hours.closeTimeLabel
                    ? el('p', { class: 'text-ink-600', text: `The portal closes at ${hours.closeTimeLabel} today.` })
                    : null,
                  hours.nextOpening && !hours.open
                    ? el('p', {
                        class: 'text-ink-600',
                        text: `Next opens ${
                          hours.nextOpening.offset === 0
                            ? 'today'
                            : hours.nextOpening.offset === 1
                              ? 'tomorrow'
                              : hours.nextOpening.dayName
                        } at ${fmt.time(hours.nextOpening.open)}.`,
                      })
                    : null,
                ]),
              })
            : null,
          user?.scopeSectionIds
            ? card({
                title: 'Sections assigned to you',
                subtitle: 'You can only mark attendance and enter marks for these.',
                body: user.scopeSectionIds.length
                  ? el(
                      'div',
                      { class: 'flex flex-wrap gap-1' },
                      user.scopeSectionIds.map((id) => {
                        const section = (state.lookups?.sections || []).find((row) => row.id === id);
                        return chip(section ? section.name : id.slice(0, 8), 'neutral');
                      })
                    )
                  : el('p', {
                      class: 'text-sm text-amber-700',
                      text: 'None yet. Ask the office to assign you under Settings → Academic structure, or your screens will be empty.',
                    }),
              })
            : null,
          card({
            title: `What your role allows (${user?.permissions?.length || 0})`,
            body: table({
              dense: true,
              columns: [
                { key: 'module', label: 'Area', width: '10rem', render: (row) => fmt.humanise(row.module) },
                { key: 'count', label: 'Permissions', type: 'num', width: '7rem' },
                {
                  key: 'keys',
                  label: 'Detail',
                  render: (row) =>
                    el('span', { class: 'font-mono text-[11px] text-ink-500', text: row.keys.join(', ') }),
                },
              ],
              rows: [...byModule.entries()].map(([module, keys]) => ({ module, keys, count: keys.length })),
              emptyMessage: 'No permissions — that is unusual, tell the administrator.',
            }),
          }),
        ]),
      ]),
    })
  );
}
