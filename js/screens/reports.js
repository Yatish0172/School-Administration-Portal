/**
 * Reports centre (SPEC §12). One catalogue so nobody has to remember which module
 * a report lives under. The list is filtered server-side by permission.
 */

import { api } from '../api.js';
import { el, page, card, button, fmt, spinner, chip, icon, searchBox, empty, toast } from '../ui.js';
import { renderAsync } from './_common.js';
import { navigate } from '../router.js';

export async function render(container) {
  await renderAsync(container, () => api.get('/api/reports'), build);
}

function build(data) {
  let search = '';
  const listHost = el('div', { class: 'space-y-5' });

  function paint() {
    const term = search.trim().toLowerCase();
    const matching = data.rows.filter(
      (row) =>
        !term ||
        row.title.toLowerCase().includes(term) ||
        row.description.toLowerCase().includes(term) ||
        row.module.toLowerCase().includes(term)
    );

    listHost.replaceChildren(
      ...(matching.length
        ? data.modules
            .map((module) => {
              const rows = matching.filter((row) => row.module === module);
              if (!rows.length) return null;
              return el('section', {}, [
                el('h2', { class: 'mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500', text: module }),
                el(
                  'div',
                  { class: 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3' },
                  rows.map(reportCard)
                ),
              ]);
            })
            .filter(Boolean)
        : [empty('No reports match that search.')])
    );
  }

  function reportCard(row) {
    return el('div', { class: 'card flex flex-col p-4' }, [
      el('div', { class: 'mb-2 flex items-start justify-between gap-2' }, [
        el('h3', { class: 'text-sm font-semibold text-ink-900', text: row.title }),
        row.format === 'csv' ? chip('CSV', 'neutral') : null,
      ]),
      el('p', { class: 'flex-1 text-xs text-ink-600', text: row.description }),
      row.filters.length
        ? el(
            'div',
            { class: 'mt-2 flex flex-wrap gap-1' },
            row.filters.map((filter) =>
              el('span', { class: 'rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600', text: fmt.humanise(filter) })
            )
          )
        : null,
      el('div', { class: 'mt-3 flex flex-wrap gap-2' }, [
        button('Open', {
          size: 'sm',
          variant: 'primary',
          onClick: () => navigate(row.route.replace(/^#/, '')),
        }),
        row.canExport && !row.exportPath.includes(':')
          ? button('Download', {
              size: 'sm',
              iconName: 'download',
              onClick: async () => {
                try {
                  const name = await api.download(row.exportPath, {});
                  toast(`Downloaded ${name}`, 'good');
                } catch (err) {
                  toast(err.message, 'bad');
                }
              },
            })
          : null,
      ]),
    ]);
  }

  paint();

  return page({
    title: 'Reports',
    subtitle: data.note,
    wide: true,
    children: el('div', {}, [
      el('div', { class: 'mb-4 flex flex-wrap items-end gap-2 no-print' }, [
        searchBox('Search reports…', (value) => {
          search = value;
          paint();
        }),
        data.academicYear
          ? el('p', { class: 'text-xs text-ink-500', text: `Academic year ${data.academicYear.name}` })
          : null,
      ]),
      listHost,
      card({
        title: 'A note on exports',
        body: el('div', { class: 'space-y-2 text-sm text-ink-600' }, [
          el('p', {}, [
            icon('info', 'mr-1 text-base align-text-bottom'),
            'Every Excel export carries the school name, the report title, who generated it and when, on the sheet itself.',
          ]),
          el('p', {}, [
            icon('lock_open', 'mr-1 text-base align-text-bottom'),
            'Exports keep working when the portal is read-only and even if the licence lapses. You can always get your data out.',
          ]),
          el('p', {}, [
            icon('print', 'mr-1 text-base align-text-bottom'),
            'Printable documents — receipts, report cards, registers, route lists — print through the browser, so you get the printer dialogue you already use.',
          ]),
        ]),
      }),
    ]),
  });
}

void spinner;
