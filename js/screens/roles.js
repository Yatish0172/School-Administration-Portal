/**
 * Roles and permissions (SPEC §4, T05).
 *
 * Routes check atomic permissions, never role names, so a school that reorganises
 * its departments changes rows here rather than code. The Administrator role always
 * holds everything — that is the recovery path from a mistake on this screen.
 */

import { api } from '../api.js';
import { el, page, card, button, fmt, spinner, chip, toast, confirm, icon, searchBox } from '../ui.js';
import { guardedSave, readOnlyNotice } from './_common.js';

export async function render(container) {
  container.replaceChildren(spinner());

  async function load() {
    const data = await api.get('/api/roles');
    container.replaceChildren(build(data, load));
  }

  await load();
}

function build(data, reload) {
  let activeRole = data.roles.find((role) => role.key !== 'admin')?.key || data.roles[0]?.key;
  let search = '';
  const bodyHost = el('div');

  const modules = [...new Set(data.permissions.map((permission) => permission.module))];

  function paint() {
    const role = data.roles.find((r) => r.key === activeRole);
    const held = new Set(data.byRole[activeRole] || []);
    const isAdmin = activeRole === 'admin';
    const changed = new Set(held);
    const term = search.trim().toLowerCase();

    const moduleBlocks = modules
      .map((module) => {
        const permissions = data.permissions.filter(
          (permission) =>
            permission.module === module &&
            (!term ||
              permission.key.toLowerCase().includes(term) ||
              permission.description.toLowerCase().includes(term))
        );
        if (!permissions.length) return null;

        return el('div', { class: 'rounded-lg bg-ink-50 p-3' }, [
          el('div', { class: 'mb-2 flex items-center justify-between gap-2' }, [
            el('p', { class: 'text-sm font-semibold text-ink-800', text: module }),
            isAdmin
              ? null
              : el('div', { class: 'flex gap-1' }, [
                  button('All', {
                    size: 'sm',
                    onClick: () => {
                      permissions.forEach((permission) => changed.add(permission.key));
                      paintChecks();
                    },
                  }),
                  button('None', {
                    size: 'sm',
                    onClick: () => {
                      permissions.forEach((permission) => changed.delete(permission.key));
                      paintChecks();
                    },
                  }),
                ]),
          ]),
          el(
            'div',
            { class: 'grid grid-cols-1 gap-1.5 md:grid-cols-2' },
            permissions.map((permission) => {
              const box = el('input', {
                type: 'checkbox',
                class: 'mt-0.5 h-4 w-4 flex-none rounded border-ink-300 text-brand-600',
                checked: isAdmin || changed.has(permission.key),
                disabled: isAdmin,
                dataset: { permission: permission.key },
              });
              box.addEventListener('change', () => {
                if (box.checked) changed.add(permission.key);
                else changed.delete(permission.key);
              });
              return el('label', { class: 'flex items-start gap-2 text-sm' }, [
                box,
                el('span', {}, [
                  el('span', { class: 'text-ink-800', text: permission.description }),
                  el('span', { class: 'ml-1 font-mono text-[11px] text-ink-400', text: permission.key }),
                ]),
              ]);
            })
          ),
        ]);
      })
      .filter(Boolean);

    function paintChecks() {
      for (const box of bodyHost.querySelectorAll('input[data-permission]')) {
        box.checked = isAdmin || changed.has(box.dataset.permission);
      }
    }

    bodyHost.replaceChildren(
      card({
        title: role ? role.name : 'Role',
        subtitle: role?.description,
        actions: [
          chip(`${isAdmin ? data.permissions.length : changed.size} of ${data.permissions.length}`, 'neutral'),
          isAdmin
            ? chip('Always has everything', 'good')
            : button('Save permissions', {
                variant: 'primary',
                iconName: 'save',
                onClick: async () => {
                  const proceed = await confirm({
                    title: `Save permissions for ${role.name}?`,
                    message: `Everyone with the ${role.name} role is signed out so they pick up the new set immediately.`,
                    confirmLabel: 'Save',
                  });
                  if (!proceed) return;
                  await guardedSave(
                    () => api.put(`/api/roles/${activeRole}/permissions`, { permissions: [...changed] }),
                    {
                      successMessage: null,
                      onDone: (result) => {
                        toast(
                          `Permissions saved. ${result.sessionsEnded} user(s) signed out to pick them up.`,
                          'good'
                        );
                        reload();
                      },
                    }
                  ).catch(() => {});
                },
              }),
        ],
        body: el('div', { class: 'space-y-3' }, [
          isAdmin
            ? el('div', { class: 'banner-info rounded-lg' }, [
                icon('info'),
                el('span', {
                  text: 'The Administrator role cannot be limited. If it could, one wrong click here would lock everyone out of their own portal.',
                }),
              ])
            : null,
          searchBox('Filter permissions…', (value) => {
            search = value;
            paint();
          }, search),
          ...moduleBlocks,
        ]),
      })
    );
  }

  const roleList = el(
    'div',
    { class: 'flex flex-wrap gap-1 no-print' },
    data.roles.map((role) =>
      el('button', {
        class: `rounded-lg px-3 py-1.5 text-sm font-medium ${
          role.key === activeRole ? 'bg-brand-600 text-white' : 'bg-white text-ink-700 ring-1 ring-inset ring-ink-300'
        }`,
        text: role.name,
        on: {
          click: () => {
            activeRole = role.key;
            search = '';
            paint();
            for (const node of roleList.children) {
              const isActive = node.textContent === role.name;
              node.className = `rounded-lg px-3 py-1.5 text-sm font-medium ${
                isActive ? 'bg-brand-600 text-white' : 'bg-white text-ink-700 ring-1 ring-inset ring-ink-300'
              }`;
            }
          },
        },
      })
    )
  );

  paint();

  return page({
    title: 'Roles and permissions',
    subtitle: `${data.permissions.length} atomic permissions across ${modules.length} modules. Menus follow these too, but the server checks every request regardless.`,
    wide: true,
    children: el('div', { class: 'space-y-4' }, [readOnlyNotice(), roleList, bodyHost]),
  });
}

void fmt;
