/**
 * Notices (SPEC §12, T21): create, target by role or class, publish window, read
 * tracking and print.
 *
 * Nothing is sent from here — SMS and WhatsApp are explicitly out of scope. The
 * supported hand-off is the parent-contact CSV export on the Students screen.
 */

import { api } from '../api.js';
import { el, page, card, button, table, fmt, spinner, chip, formModal, modal, filterSelect, printNode, empty, confirm } from '../ui.js';
import { guardedSave, readOnlyNotice, printHeader, printFooter } from './_common.js';
import { can, state } from '../state.js';

export async function render(container, context = {}) {
  const view = { status: context.query?.status || null };
  const host = el('div');

  async function load() {
    host.replaceChildren(spinner());
    try {
      const [data, mine] = await Promise.all([
        can('notice.view') ? api.get('/api/notices', { status: view.status }) : Promise.resolve(null),
        api.get('/api/notices/mine'),
      ]);
      host.replaceChildren(build(data, mine, view, load));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  container.replaceChildren(
    page({
      title: 'Notices',
      subtitle: 'Published notices appear on the dashboard of everyone they target.',
      wide: true,
      actions: [
        can('notice.create')
          ? button('Draft a notice', { variant: 'primary', iconName: 'add', onClick: () => noticeForm(null, load) })
          : null,
      ],
      children: el('div', {}, [readOnlyNotice(), host]),
    })
  );

  await load();
}

function build(data, mine, view, reload) {
  return el('div', { class: 'space-y-4' }, [
    card({
      title: 'For you',
      subtitle: 'Opening a notice marks it as read.',
      body: mine.rows.length
        ? el(
            'ul',
            { class: 'divide-y divide-ink-100' },
            mine.rows.map((notice) =>
              el('li', { class: 'flex items-start justify-between gap-3 py-2' }, [
                el('div', { class: 'min-w-0 flex-1' }, [
                  el('div', { class: 'flex items-center gap-2' }, [
                    el('p', { class: 'text-sm font-medium text-ink-900', text: notice.title }),
                    notice.priority !== 'normal'
                      ? chip(fmt.humanise(notice.priority), notice.priority === 'urgent' ? 'bad' : 'warn')
                      : null,
                    notice.read ? null : chip('New', 'info'),
                  ]),
                  el('p', { class: 'mt-0.5 line-clamp-2 text-xs text-ink-600', text: notice.body }),
                  el('p', { class: 'mt-1 text-[11px] text-ink-400', text: fmt.ago(notice.publishedAt) }),
                ]),
                button('Read', {
                  size: 'sm',
                  onClick: async () => {
                    await api.post(`/api/notices/${notice.id}/read`).catch(() => {});
                    showNotice(notice);
                    reload();
                  },
                }),
              ])
            )
          )
        : empty('No notices for you right now.'),
    }),

    data
      ? el('div', {}, [
          el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, [
            filterSelect({
              label: 'Status',
              options: ['draft', 'published', 'archived'],
              value: view.status,
              placeholder: 'All',
              onChange: (value) => {
                view.status = value;
                reload();
              },
            }),
          ]),
          card({
            title: 'All notices',
            body: table({
              columns: [
                { key: 'title', label: 'Title' },
                {
                  key: 'audience',
                  label: 'Audience',
                  width: '12rem',
                  render: (row) => describeAudience(row, data),
                },
                { key: 'publishFrom', label: 'From', type: 'date', width: '8rem' },
                { key: 'publishTo', label: 'Until', type: 'date', width: '8rem' },
                {
                  key: 'priority',
                  label: 'Priority',
                  width: '7rem',
                  render: (row) =>
                    chip(fmt.humanise(row.priority), row.priority === 'urgent' ? 'bad' : row.priority === 'important' ? 'warn' : 'neutral'),
                },
                { key: 'status', label: 'Status', type: 'status', width: '8rem' },
                {
                  key: 'actions',
                  label: '',
                  render: (row) =>
                    el('div', { class: 'flex flex-wrap gap-1' }, [
                      button('View', { size: 'sm', onClick: () => showNotice(row, true) }),
                      can('notice.create') && row.status === 'draft'
                        ? button('Edit', { size: 'sm', onClick: () => noticeForm(row, reload) })
                        : null,
                      can('notice.publish') && row.status === 'draft'
                        ? button('Publish', {
                            size: 'sm',
                            variant: 'primary',
                            onClick: async () => {
                              const proceed = await confirm({
                                title: `Publish "${row.title}"?`,
                                message: 'It appears immediately on the dashboard of everyone it targets.',
                                confirmLabel: 'Publish',
                              });
                              if (!proceed) return;
                              await guardedSave(() => api.post(`/api/notices/${row.id}/publish`), {
                                successMessage: 'Notice published.',
                                onDone: reload,
                              }).catch(() => {});
                            },
                          })
                        : null,
                      can('notice.publish') && row.status === 'published'
                        ? button('Archive', {
                            size: 'sm',
                            onClick: async () => {
                              await guardedSave(() => api.post(`/api/notices/${row.id}/archive`), {
                                successMessage: 'Notice archived.',
                                onDone: reload,
                              }).catch(() => {});
                            },
                          })
                        : null,
                    ]),
                },
              ],
              rows: data.rows,
              emptyMessage: 'No notices yet.',
            }),
          }),
        ])
      : null,
  ]);
}

function describeAudience(notice, data) {
  if (notice.audience === 'all') return chip('Everyone', 'neutral');
  if (notice.audience === 'role') {
    const roles = Array.isArray(notice.targetRoles) ? notice.targetRoles : [];
    return el('span', { class: 'text-xs', text: roles.map(fmt.humanise).join(', ') || '—' });
  }
  const classes = Array.isArray(notice.targetClassIds) ? notice.targetClassIds : [];
  const names = classes
    .map((id) => data.classes.find((klass) => klass.id === id)?.name)
    .filter(Boolean);
  return el('span', { class: 'text-xs', text: names.join(', ') || '—' });
}

async function showNotice(notice, withReads = false) {
  let reads = null;
  if (withReads && can('notice.view')) {
    try {
      const detail = await api.get(`/api/notices/${notice.id}`);
      reads = detail.reads;
    } catch (err) {
      reads = null;
    }
  }

  modal({
    title: notice.title,
    size: 'lg',
    body: el('div', { class: 'space-y-3' }, [
      el('p', { class: 'whitespace-pre-wrap text-sm text-ink-800', text: notice.body }),
      el('p', {
        class: 'text-xs text-ink-500',
        text: `${notice.publishedAt ? `Published ${fmt.dateTime(notice.publishedAt)}` : 'Not published yet'}${
          notice.publishTo ? ` • until ${fmt.date(notice.publishTo)}` : ''
        }`,
      }),
      reads
        ? el('div', {}, [
            el('h3', { class: 'mb-1 text-sm font-semibold', text: `Read by ${reads.total}` }),
            reads.total
              ? el(
                  'ul',
                  { class: 'text-xs text-ink-600' },
                  reads.readers.map((reader) =>
                    el('li', { text: `${reader.name} — ${fmt.ago(reader.readAt)}` })
                  )
                )
              : el('p', { class: 'text-xs text-ink-500', text: 'Nobody has opened it yet.' }),
          ])
        : null,
    ]),
    actions: (close) => [
      button('Close', { onClick: close }),
      button('Print', {
        iconName: 'print',
        onClick: () =>
          printNode(
            el('div', { class: 'print-page bg-white p-8' }, [
              printHeader(state.school, 'Notice', notice.publishedAt ? fmt.date(notice.publishedAt) : ''),
              el('h2', { class: 'mb-3 text-lg font-semibold', text: notice.title }),
              el('p', { class: 'whitespace-pre-wrap text-sm', text: notice.body }),
              printFooter(state.user?.name, new Date().toISOString()),
            ]),
            { title: notice.title }
          ),
      }),
    ],
  });
}

function noticeForm(existing, reload) {
  api.get('/api/notices').then((data) => {
    let audience = existing?.audience || 'all';
    const { formApi } = formModal({
      title: existing ? `Edit "${existing.title}"` : 'Draft a notice',
      submitLabel: existing ? 'Save draft' : 'Save draft',
      size: 'lg',
      note: 'A draft is not visible to anyone until it is published.',
      values: existing || { audience: 'all', priority: 'normal', publishFrom: fmt.today() },
      fields: [
        { name: 'title', label: 'Title', required: true, colSpan: 'full' },
        { name: 'body', label: 'Notice', type: 'textarea', rows: 6, required: true, colSpan: 'full' },
        {
          name: 'audience',
          label: 'Who should see this',
          type: 'select',
          required: true,
          options: [
            { value: 'all', label: 'Everyone' },
            { value: 'role', label: 'Specific roles' },
            { value: 'class', label: 'Specific classes' },
          ],
        },
        {
          name: 'priority',
          label: 'Priority',
          type: 'select',
          options: [
            { value: 'normal', label: 'Normal' },
            { value: 'important', label: 'Important' },
            { value: 'urgent', label: 'Urgent' },
          ],
        },
        {
          name: 'targetRoles',
          label: 'Roles',
          type: 'multiselect',
          options: data.roles.map((role) => ({ value: role.key, label: role.name })),
          when: (values) => values.audience === 'role',
          colSpan: 'full',
        },
        {
          name: 'targetClassIds',
          label: 'Classes',
          type: 'multiselect',
          options: data.classes.map((klass) => ({ value: klass.id, label: klass.name })),
          when: (values) => values.audience === 'class',
          colSpan: 'full',
        },
        { name: 'publishFrom', label: 'Show from', type: 'date' },
        { name: 'publishTo', label: 'Show until', type: 'date', hint: 'Leave blank to keep it up.' },
      ],
      onSubmit: async (values, helpers) => {
        await guardedSave(
          () =>
            existing
              ? api.put(`/api/notices/${existing.id}`, { ...values, _rev: existing._rev })
              : api.post('/api/notices', values),
          {
            successMessage: 'Notice saved as a draft.',
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

    // The role and class pickers only make sense for their audience, so the form is
    // rebuilt when the audience changes.
    const audienceControl = formApi.control('audience');
    audienceControl.addEventListener('change', () => {
      const values = formApi.values();
      if (values.audience === audience) return;
      audience = values.audience;
      document.querySelector('#overlays > div:last-child')?.remove();
      noticeForm({ ...(existing || {}), ...values }, reload);
    });
  });
}
