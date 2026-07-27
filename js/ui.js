/**
 * DOM toolkit. Every screen builds its markup from these helpers, which is what
 * keeps a vanilla-JS front end this size manageable without a framework.
 *
 * Nothing here uses innerHTML with data. Values always go in through textContent
 * or element properties, so a student's name containing an angle bracket cannot
 * break the page.
 */

import { svgIcon as svgIconImpl } from './icons.js';

/* ---------------------------------------------------------------- elements */

/**
 * el('div', { class: 'card' }, [child, 'text'])
 *
 * Props: `class`, `text`, `html` (trusted markup only), `dataset`, `style`,
 * `on` (event map), anything else is set as an attribute or property.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class' || key === 'className') {
      node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = value; // only ever called with markup this file authored
    } else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue === undefined || dataValue === null) continue;
        node.dataset[dataKey] = String(dataValue);
      }
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler);
      }
    } else if (key in node && key !== 'list' && key !== 'form') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
  return parent;
}

export function frag(children) {
  return append(document.createDocumentFragment(), children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export { svgIcon } from './icons.js';

/**
 * Icons are inline SVG, not a ligature font — a missing font file would otherwise
 * render the glyph *name* as visible text next to every menu item.
 */
export function icon(name, extraClass = '') {
  return svgIconImpl(name, extraClass);
}

/* -------------------------------------------------------------- formatting */

const DATE_FORMAT = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const TIME_FORMAT = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const MONEY_FORMAT = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
});
/** School fees are almost always whole rupees, and ".00" on every row is noise. */
const MONEY_WHOLE_FORMAT = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const NUMBER_FORMAT = new Intl.NumberFormat('en-IN');

/**
 * Words `humanise` must not sentence-case: 'upi' has to read as UPI, not "Upi".
 * Everything a school actually types in these fields, nothing speculative.
 */
const ACRONYMS = new Map(
  Object.entries({
    upi: 'UPI',
    dd: 'DD',
    pf: 'PF',
    hra: 'HRA',
    da: 'DA',
    pin: 'PIN',
    tc: 'TC',
    rte: 'RTE',
    sc: 'SC',
    st: 'ST',
    obc: 'OBC',
    ews: 'EWS',
    cl: 'CL',
    sl: 'SL',
    el: 'EL',
    lwp: 'LWP',
    ml: 'ML',
    csv: 'CSV',
    pdf: 'PDF',
    id: 'ID',
    hr: 'HR',
    puc: 'PUC',
    ifsc: 'IFSC',
    pan: 'PAN',
    latefee: 'Late fee',
    onetime: 'One time',
  })
);

export const fmt = {
  date(value) {
    if (!value) return '—';
    const date = value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return DATE_FORMAT.format(date);
  },
  time(value) {
    if (!value) return '—';
    if (/^\d{2}:\d{2}$/.test(value)) {
      const [h, m] = value.split(':').map(Number);
      const suffix = h >= 12 ? 'PM' : 'AM';
      const hour = h % 12 === 0 ? 12 : h % 12;
      return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : TIME_FORMAT.format(date);
  },
  dateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return `${DATE_FORMAT.format(date)}, ${TIME_FORMAT.format(date)}`;
  },
  /** Relative for recent things, absolute beyond a week. */
  ago(value) {
    if (!value) return '—';
    const then = new Date(value).getTime();
    if (Number.isNaN(then)) return String(value);
    const seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`;
    return fmt.date(value);
  },
  money(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    // Paise are shown only when there actually are paise.
    return Number.isInteger(n) ? MONEY_WHOLE_FORMAT.format(n) : MONEY_FORMAT.format(n);
  },
  number(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? NUMBER_FORMAT.format(n) : '—';
  },
  percent(value, digits = 1) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
  },
  bytes(value) {
    const n = Number(value || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  },
  text(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
  },
  /** Turns 'attendance.mark.assigned' into 'Attendance mark assigned', 'upi' into 'UPI'. */
  humanise(value) {
    if (!value) return '—';
    const raw = String(value).trim();
    const direct = ACRONYMS.get(raw.toLowerCase());
    if (direct) return direct;

    const words = raw
      .replace(/[._-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ACRONYMS.get(word.toLowerCase()) || word);

    if (!words.length) return '—';
    const first = words[0];
    const head = ACRONYMS.has(first.toLowerCase())
      ? first
      : first.charAt(0).toUpperCase() + first.slice(1);
    return [head, ...words.slice(1)].join(' ');
  },
  today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  },
  thisMonth() {
    return fmt.today().slice(0, 7);
  },
};

/* --------------------------------------------------------------- structure */

export function page({ title, subtitle, actions, children, wide = false }) {
  return el('div', { class: 'mx-auto w-full px-4 py-5 sm:px-6', style: { maxWidth: wide ? '96rem' : '80rem' } }, [
    el('div', { class: 'mb-5 flex flex-wrap items-start justify-between gap-3' }, [
      el('div', {}, [
        el('h1', { class: 'text-xl font-semibold sm:text-2xl', text: title }),
        subtitle ? el('p', { class: 'mt-1 text-sm text-ink-500', text: subtitle }) : null,
      ]),
      actions ? el('div', { class: 'flex flex-wrap items-center gap-2 no-print' }, actions) : null,
    ]),
    children,
  ]);
}

export function card({ title, subtitle, actions, body, class: cls = '', id }) {
  return el('section', { class: `card ${cls}`, id }, [
    title || actions
      ? el('div', { class: 'card-head' }, [
          el('div', {}, [
            el('h2', { class: 'card-title', text: title || '' }),
            subtitle ? el('p', { class: 'mt-0.5 text-xs text-ink-500', text: subtitle }) : null,
          ]),
          actions ? el('div', { class: 'flex flex-wrap items-center gap-2 no-print' }, actions) : null,
        ])
      : null,
    el('div', { class: 'card-body' }, body),
  ]);
}

export function grid(cols, children, gap = 'gap-4') {
  const map = {
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-2 lg:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
    5: 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
    6: 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6',
  };
  return el('div', { class: `grid grid-cols-1 ${map[cols] || map[3]} ${gap}` }, children);
}

/**
 * Picks a column count that divides the tiles evenly, so a row of six does not
 * render as four-then-a-gap.
 */
export function statGrid(children) {
  const count = children.filter(Boolean).length;
  const cols = count <= 2 ? count : count % 4 === 0 ? 4 : count % 3 === 0 ? 3 : count % 2 === 0 ? 2 : Math.min(4, count);
  return grid(cols, children);
}

export function stat({ label, value, sub, tone = 'neutral', onClick }) {
  const tones = {
    neutral: '',
    good: 'text-emerald-700',
    warn: 'text-amber-700',
    bad: 'text-rose-700',
  };
  // A word like "Not marked" at the numeral size looks like a headline, so text
  // values step down while figures keep the display treatment.
  const isFigure = /^[₹\d]/.test(String(value ?? ''));
  const node = el('div', { class: `stat ${onClick ? 'cursor-pointer hover:shadow-raised' : ''}` }, [
    el('p', { class: 'stat-label', text: label }),
    el('p', {
      class: `stat-value ${isFigure ? '' : 'text-base font-medium'} ${tones[tone] || ''}`,
      text: value,
    }),
    sub ? el('p', { class: 'stat-sub', text: sub }) : null,
  ]);
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

export function chip(text, tone = 'neutral') {
  const map = {
    neutral: 'chip-neutral',
    good: 'chip-good',
    warn: 'chip-warn',
    bad: 'chip-bad',
    info: 'chip-info',
  };
  return el('span', { class: map[tone] || map.neutral, text });
}

/** Consistent tone per status word across every screen. */
export function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (['active', 'paid', 'approved', 'success', 'present', 'available', 'returned', 'published', 'open', 'committed', 'applied', 'issued'].includes(value)) {
    return 'good';
  }
  if (['pending', 'partial', 'partial payment', 'validated', 'draft', 'setup', 'marks', 'late', 'half day', 'waiting', 'following up'].includes(value)) {
    return 'warn';
  }
  if (['disabled', 'revoked', 'cancelled', 'rejected', 'reversed', 'absent', 'failed', 'expired', 'lost', 'left', 'unpaid', 'overdue', 'closed', 'blocked'].includes(value)) {
    return 'bad';
  }
  if (['leave', 'tc issued', 'alumni', 'promoted', 'archived', 'superseded'].includes(value)) {
    return 'info';
  }
  return 'neutral';
}

export function statusChip(status) {
  return chip(fmt.humanise(status), statusTone(status));
}

export function empty(message, action) {
  return el('div', { class: 'empty' }, [
    icon('inbox', 'text-3xl text-ink-300'),
    el('p', { text: message }),
    action || null,
  ]);
}

export function spinner(label = 'Loading…') {
  return el('div', { class: 'flex items-center justify-center gap-3 px-6 py-12 text-sm text-ink-500' }, [
    el('div', { class: 'h-5 w-5 animate-spin rounded-full border-2 border-ink-200 border-t-brand-600' }),
    label,
  ]);
}

export function errorBox(message, retry) {
  return el('div', { class: 'card border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800' }, [
    el('p', { class: 'font-medium', text: 'That did not work' }),
    el('p', { class: 'mt-1', text: message }),
    retry
      ? el('button', { class: 'btn-secondary mt-3', text: 'Try again', on: { click: retry } })
      : null,
  ]);
}

export function banner(message, tone = 'info', actions) {
  const map = { info: 'banner-info', warn: 'banner-warn', bad: 'banner-bad' };
  return el('div', { class: map[tone] || map.info }, [
    icon(tone === 'bad' ? 'error' : tone === 'warn' ? 'warning' : 'info'),
    el('span', { class: 'flex-1', text: message }),
    actions || null,
  ]);
}

export function button(label, { variant = 'secondary', onClick, iconName, disabled, title, type = 'button', size } = {}) {
  return el(
    'button',
    {
      type,
      class: [`btn-${variant}`, size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : ''].join(' '),
      disabled: !!disabled,
      title: title || null,
      on: onClick ? { click: onClick } : {},
    },
    [iconName ? icon(iconName, 'text-base') : null, label]
  );
}

export function tabs(items, activeKey, onChange) {
  return el(
    'div',
    { class: 'mb-4 flex flex-wrap gap-1 border-b border-ink-200 no-print' },
    items.map((item) =>
      el('button', {
        class: [
          'px-3 py-2 text-sm font-medium -mb-px border-b-2',
          item.key === activeKey
            ? 'border-brand-600 text-brand-700'
            : 'border-transparent text-ink-500 hover:text-ink-800',
        ].join(' '),
        text: item.label,
        on: { click: () => onChange(item.key) },
      })
    )
  );
}

/* ------------------------------------------------------------------ tables */

/**
 * columns: [{ key, label, type, width, render(row), align, class }]
 * `type` 'money' | 'num' | 'date' | 'dateTime' | 'percent' | 'status' formats for you.
 */
export function table({ columns, rows, onRowClick, emptyMessage = 'Nothing to show yet.', footer, dense = false, stickyFirst = false }) {
  if (!rows || rows.length === 0) {
    return el('div', {}, [empty(emptyMessage)]);
  }

  const head = el(
    'thead',
    {},
    el(
      'tr',
      {},
      columns.map((column) =>
        el('th', {
          class: [
            column.align === 'right' || ['money', 'num', 'percent'].includes(column.type)
              ? 'text-right'
              : '',
            stickyFirst && column === columns[0] ? 'sticky left-0 z-20 bg-ink-50' : '',
          ].join(' '),
          style: column.width ? { width: column.width } : {},
          text: column.label,
        })
      )
    )
  );

  const body = el(
    'tbody',
    {},
    rows.map((row, index) => {
      const tr = el('tr', {
        dataset: onRowClick ? { clickable: 'true' } : {},
      });
      for (const column of columns) {
        const cell = el('td', {
          class: [
            ['money', 'num', 'percent'].includes(column.type) || column.align === 'right'
              ? 'table-numeric'
              : '',
            dense ? 'py-1' : '',
            column.class || '',
            stickyFirst && column === columns[0] ? 'sticky left-0 bg-white' : '',
          ].join(' '),
        });
        renderCell(cell, column, row, index);
        tr.appendChild(cell);
      }
      if (onRowClick) {
        tr.addEventListener('click', (event) => {
          // Let buttons and links inside a row do their own thing.
          if (event.target.closest('button, a, input, select, textarea')) return;
          onRowClick(row, index);
        });
      }
      return tr;
    })
  );

  return el('div', { class: 'overflow-x-auto' }, [
    el('table', { class: 'table' }, [head, body, footer ? el('tfoot', {}, footer) : null]),
  ]);
}

function renderCell(cell, column, row, index) {
  if (column.render) {
    const result = column.render(row, index);
    if (result instanceof Node) cell.appendChild(result);
    else if (Array.isArray(result)) append(cell, result);
    else cell.textContent = result === null || result === undefined ? '—' : String(result);
    return;
  }
  const value = row[column.key];
  switch (column.type) {
    case 'money':
      cell.textContent = fmt.money(value);
      break;
    case 'num':
      cell.textContent = fmt.number(value);
      break;
    case 'percent':
      cell.textContent = fmt.percent(value);
      break;
    case 'date':
      cell.textContent = fmt.date(value);
      break;
    case 'dateTime':
      cell.textContent = fmt.dateTime(value);
      break;
    case 'status':
      cell.appendChild(statusChip(value));
      break;
    default:
      cell.textContent = fmt.text(value);
  }
}

/** Total row for a table footer. */
export function totalsRow(columns, totals, label = 'Total') {
  return el(
    'tr',
    { class: 'font-semibold' },
    columns.map((column, index) => {
      if (index === 0 && totals[column.key] === undefined) {
        return el('td', { class: 'px-3 py-2', text: label });
      }
      const value = totals[column.key];
      return el('td', {
        class: ['money', 'num', 'percent'].includes(column.type) ? 'table-numeric px-3 py-2' : 'px-3 py-2',
        text:
          value === undefined
            ? ''
            : column.type === 'money'
              ? fmt.money(value)
              : column.type === 'percent'
                ? fmt.percent(value)
                : fmt.number(value),
      });
    })
  );
}

export function pager({ page: current, pages, total, onChange }) {
  if (!pages || pages <= 1) {
    return el('p', { class: 'px-1 py-2 text-xs text-ink-500', text: `${fmt.number(total)} record(s)` });
  }
  return el('div', { class: 'flex items-center justify-between gap-3 px-1 py-2 no-print' }, [
    el('p', {
      class: 'text-xs text-ink-500',
      text: `Page ${current} of ${pages} • ${fmt.number(total)} records`,
    }),
    el('div', { class: 'flex gap-1' }, [
      button('Previous', { onClick: () => onChange(current - 1), disabled: current <= 1, size: 'sm' }),
      button('Next', { onClick: () => onChange(current + 1), disabled: current >= pages, size: 'sm' }),
    ]),
  ]);
}

/* ------------------------------------------------------------------- forms */

/**
 * Declarative form builder.
 *
 * fields: [{ name, label, type, options, required, hint, placeholder, min, max,
 *            step, rows, colSpan, disabled, value, when(values) }]
 * Types: text, email, tel, number, date, month, time, password, textarea, select,
 *        multiselect, checkbox, radio, hidden, static.
 *
 * Returns { node, values(), setValues(), setErrors(), clearErrors(), focus(), setBusy() }.
 */
export function form({ fields, values = {}, onSubmit, submitLabel = 'Save', cancelLabel, onCancel, columns = 2, note }) {
  const controls = new Map();
  const errorNodes = new Map();
  const current = { ...values };

  const formNode = el('form', { class: 'space-y-4', novalidate: true });

  const gridNode = el('div', {
    class: `grid grid-cols-1 gap-x-4 gap-y-3 ${columns === 1 ? '' : columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`,
  });

  for (const field of fields) {
    if (field.when && !field.when(current)) continue;
    const wrapper = el('div', {
      class: field.colSpan === 'full' ? (columns === 3 ? 'sm:col-span-3' : 'sm:col-span-2') : '',
    });

    if (field.type === 'hidden') {
      const input = el('input', { type: 'hidden', name: field.name, value: current[field.name] ?? '' });
      controls.set(field.name, input);
      wrapper.appendChild(input);
      gridNode.appendChild(wrapper);
      continue;
    }

    if (field.type === 'static') {
      wrapper.appendChild(el('p', { class: 'label', text: field.label }));
      wrapper.appendChild(
        el('p', { class: 'text-sm text-ink-800', text: fmt.text(field.value ?? current[field.name]) })
      );
      gridNode.appendChild(wrapper);
      continue;
    }

    if (field.type === 'checkbox') {
      const input = el('input', {
        type: 'checkbox',
        id: `f-${field.name}`,
        name: field.name,
        checked: !!current[field.name],
        disabled: !!field.disabled,
        class: 'h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500',
      });
      controls.set(field.name, input);
      wrapper.appendChild(
        el('div', { class: 'flex items-start gap-2 pt-5' }, [
          input,
          el('div', {}, [
            el('label', { for: `f-${field.name}`, class: 'text-sm text-ink-800', text: field.label }),
            field.hint ? el('p', { class: 'hint', text: field.hint }) : null,
          ]),
        ])
      );
      gridNode.appendChild(wrapper);
      continue;
    }

    const labelNode = el('label', { class: 'label', for: `f-${field.name}` }, [
      field.label,
      field.required ? el('span', { class: 'text-rose-500', text: ' *' }) : null,
    ]);
    wrapper.appendChild(labelNode);

    let input;
    if (field.type === 'select') {
      input = el('select', {
        id: `f-${field.name}`,
        name: field.name,
        class: 'input',
        disabled: !!field.disabled,
      });
      const options = resolveOptions(field.options);
      if (!field.required || field.placeholder) {
        input.appendChild(el('option', { value: '', text: field.placeholder || '— none —' }));
      }
      for (const option of options) {
        input.appendChild(el('option', { value: option.value, text: option.label }));
      }
      input.value = current[field.name] ?? '';
    } else if (field.type === 'multiselect') {
      input = el('select', {
        id: `f-${field.name}`,
        name: field.name,
        class: 'input',
        multiple: true,
        size: Math.min(6, Math.max(3, resolveOptions(field.options).length)),
      });
      for (const option of resolveOptions(field.options)) {
        const selected = Array.isArray(current[field.name])
          ? current[field.name].includes(option.value)
          : false;
        input.appendChild(el('option', { value: option.value, text: option.label, selected }));
      }
    } else if (field.type === 'textarea') {
      input = el('textarea', {
        id: `f-${field.name}`,
        name: field.name,
        class: 'input',
        rows: field.rows || 3,
        placeholder: field.placeholder || '',
        disabled: !!field.disabled,
        value: current[field.name] ?? '',
      });
    } else if (field.type === 'radio') {
      input = el(
        'div',
        { class: 'flex flex-wrap gap-3 pt-1' },
        resolveOptions(field.options).map((option) =>
          el('label', { class: 'flex items-center gap-1.5 text-sm' }, [
            el('input', {
              type: 'radio',
              name: field.name,
              value: option.value,
              checked: String(current[field.name] ?? '') === String(option.value),
              class: 'h-4 w-4 border-ink-300 text-brand-600 focus:ring-brand-500',
            }),
            option.label,
          ])
        )
      );
    } else {
      input = el('input', {
        id: `f-${field.name}`,
        name: field.name,
        type: field.type || 'text',
        class: 'input',
        placeholder: field.placeholder || '',
        required: !!field.required,
        disabled: !!field.disabled,
        readOnly: !!field.readOnly,
        min: field.min ?? null,
        max: field.max ?? null,
        step: field.step ?? null,
        maxLength: field.maxLength ?? null,
        autocomplete: field.autocomplete || 'off',
        inputMode: field.inputMode || null,
        value: current[field.name] ?? '',
      });
    }

    controls.set(field.name, input);
    wrapper.appendChild(input);

    const errorNode = el('p', { class: 'field-error hidden' });
    errorNodes.set(field.name, errorNode);
    wrapper.appendChild(errorNode);
    if (field.hint) wrapper.appendChild(el('p', { class: 'hint', text: field.hint }));

    gridNode.appendChild(wrapper);
  }

  formNode.appendChild(gridNode);
  if (note) formNode.appendChild(el('p', { class: 'text-xs text-ink-500', text: note }));

  const formError = el('div', { class: 'hidden rounded-lg bg-rose-50 p-3 text-sm text-rose-800' });
  formNode.appendChild(formError);

  const submitButton = el('button', { type: 'submit', class: 'btn-primary', text: submitLabel });
  const actionRow = el('div', { class: 'flex flex-wrap items-center gap-2 pt-1' }, [
    submitButton,
    onCancel ? button(cancelLabel || 'Cancel', { onClick: onCancel }) : null,
  ]);
  formNode.appendChild(actionRow);

  function readValues() {
    const out = {};
    for (const field of fields) {
      const control = controls.get(field.name);
      if (!control) continue;
      if (field.type === 'checkbox') {
        out[field.name] = control.checked;
      } else if (field.type === 'multiselect') {
        out[field.name] = [...control.selectedOptions].map((option) => option.value);
      } else if (field.type === 'radio') {
        const checked = control.querySelector('input:checked');
        out[field.name] = checked ? checked.value : null;
      } else if (field.type === 'number') {
        out[field.name] = control.value === '' ? null : Number(control.value);
      } else {
        out[field.name] = control.value === '' ? null : control.value;
      }
    }
    return out;
  }

  function setErrors(fieldErrors, message) {
    clearErrors();
    if (message) {
      formError.textContent = message;
      formError.classList.remove('hidden');
    }
    let firstBad = null;
    for (const [name, text] of Object.entries(fieldErrors || {})) {
      const node = errorNodes.get(name);
      const control = controls.get(name);
      if (!node || !text) continue;
      node.textContent = text;
      node.classList.remove('hidden');
      if (control && control.classList) control.classList.add('input-error');
      if (!firstBad) firstBad = control;
    }
    if (firstBad && firstBad.focus) firstBad.focus();
  }

  function clearErrors() {
    formError.classList.add('hidden');
    formError.textContent = '';
    for (const node of errorNodes.values()) {
      node.classList.add('hidden');
      node.textContent = '';
    }
    for (const control of controls.values()) {
      if (control.classList) control.classList.remove('input-error');
    }
  }

  function setBusy(busy, label) {
    submitButton.disabled = busy;
    submitButton.textContent = busy ? label || 'Saving…' : submitLabel;
  }

  formNode.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();

    const values2 = readValues();
    const missing = {};
    for (const field of fields) {
      if (!field.required) continue;
      if (field.when && !field.when(values2)) continue;
      const value = values2[field.name];
      if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) {
        missing[field.name] = 'This is required.';
      }
    }
    if (Object.keys(missing).length) {
      setErrors(missing, 'Fill in the highlighted fields.');
      return;
    }

    setBusy(true);
    try {
      await onSubmit(values2, { setErrors, clearErrors, setBusy });
    } catch (err) {
      if (err && err.fields) setErrors(err.fields, err.message);
      else setErrors({}, err?.message || 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  });

  return {
    node: formNode,
    values: readValues,
    setErrors,
    clearErrors,
    setBusy,
    control: (name) => controls.get(name),
    focus(name) {
      const control = controls.get(name) || controls.values().next().value;
      if (control && control.focus) control.focus();
    },
    setValues(next) {
      for (const [name, value] of Object.entries(next)) {
        const control = controls.get(name);
        if (!control) continue;
        if (control.type === 'checkbox') control.checked = !!value;
        else control.value = value ?? '';
      }
    },
  };
}

function resolveOptions(options) {
  const list = typeof options === 'function' ? options() : options || [];
  return list.map((option) =>
    typeof option === 'object' && option !== null
      ? { value: option.value ?? option.id ?? '', label: option.label ?? option.name ?? String(option.value) }
      : { value: option, label: fmt.humanise(option) }
  );
}

/** Turns a list of records into select options. */
export function toOptions(rows, valueKey = 'id', labelKey = 'name') {
  return (rows || []).map((row) => ({
    value: row[valueKey],
    label: typeof labelKey === 'function' ? labelKey(row) : row[labelKey],
  }));
}

/* ----------------------------------------------------------------- overlays */

const overlayRoot = () => document.getElementById('overlays');

export function modal({ title, body, actions, size = 'md', onClose, closeOnBackdrop = true }) {
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

  const panel = el('div', {
    class: `card w-full ${widths[size] || widths.md} max-h-[90vh] overflow-y-auto shadow-overlay`,
    role: 'dialog',
    'aria-modal': 'true',
  });

  const close = () => {
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
    if (onClose) onClose();
  };

  function onKeyDown(event) {
    if (event.key === 'Escape') close();
  }

  panel.appendChild(
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: title }),
      el('button', {
        class: 'btn-ghost btn-sm',
        'aria-label': 'Close',
        on: { click: close },
      }, [icon('close')]),
    ])
  );

  const bodyNode = el('div', { class: 'card-body' }, typeof body === 'function' ? body(close) : body);
  panel.appendChild(bodyNode);

  if (actions) {
    panel.appendChild(
      el(
        'div',
        { class: 'flex flex-wrap items-center justify-end gap-2 border-t border-ink-200/70 px-4 py-3' },
        typeof actions === 'function' ? actions(close) : actions
      )
    );
  }

  const backdrop = el(
    'div',
    {
      class: 'fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4 sm:items-center',
      on: {
        click: (event) => {
          if (closeOnBackdrop && event.target === backdrop) close();
        },
      },
    },
    [panel]
  );

  document.addEventListener('keydown', onKeyDown);
  overlayRoot().appendChild(backdrop);

  const focusable = panel.querySelector('input, select, textarea, button:not([aria-label="Close"])');
  if (focusable) focusable.focus();

  return { close, panel, body: bodyNode };
}

/**
 * Confirmation dialogue. `danger` styles the action red; `confirmText` demands the
 * user type a word first, which is what stands between a stray click and a restore.
 */
export function confirm({ title, message, confirmLabel = 'Confirm', danger = false, confirmText = null, detail }) {
  return new Promise((resolve) => {
    let typed = null;
    const actionButton = el('button', {
      class: danger ? 'btn-danger' : 'btn-primary',
      text: confirmLabel,
      disabled: !!confirmText,
    });

    const body = [
      el('p', { class: 'text-sm text-ink-700', text: message }),
      detail ? el('p', { class: 'mt-2 text-xs text-ink-500', text: detail }) : null,
    ];

    if (confirmText) {
      typed = el('input', {
        class: 'input mt-3',
        placeholder: confirmText,
        autocomplete: 'off',
        on: {
          input: () => {
            actionButton.disabled = typed.value.trim() !== confirmText;
          },
        },
      });
      body.push(
        el('label', { class: 'label mt-3', text: `Type ${confirmText} to confirm` }),
        typed
      );
    }

    const dialog = modal({
      title,
      body,
      size: 'sm',
      onClose: () => resolve(false),
      actions: (close) => {
        actionButton.addEventListener('click', () => {
          resolve(true);
          close();
        });
        return [
          button('Cancel', {
            onClick: () => {
              resolve(false);
              close();
            },
          }),
          actionButton,
        ];
      },
    });
    void dialog;
  });
}

/** Small single-field prompt, used for reasons that must be recorded. */
export function askReason({ title, label, message, confirmLabel = 'Continue', minLength = 5, placeholder }) {
  return new Promise((resolve) => {
    let settled = false;
    const dialog = modal({
      title,
      size: 'sm',
      onClose: () => {
        if (!settled) resolve(null);
      },
      body: () => {
        const formApi = form({
          fields: [
            {
              name: 'reason',
              label,
              type: 'textarea',
              rows: 3,
              required: true,
              colSpan: 'full',
              placeholder: placeholder || '',
              hint: `At least ${minLength} characters. This is recorded against your name.`,
            },
          ],
          columns: 1,
          submitLabel: confirmLabel,
          onSubmit: (values, helpers) => {
            const reason = String(values.reason || '').trim();
            if (reason.length < minLength) {
              helpers.setErrors({ reason: `Write at least ${minLength} characters.` });
              return;
            }
            settled = true;
            resolve(reason);
            dialog.close();
          },
          onCancel: () => {
            settled = true;
            resolve(null);
            dialog.close();
          },
        });
        return [message ? el('p', { class: 'mb-3 text-sm text-ink-700', text: message }) : null, formApi.node];
      },
    });
  });
}

/** Convenience: a modal wrapping a form. Resolves with the submitted values. */
export function formModal({ title, fields, values, submitLabel = 'Save', size = 'md', onSubmit, note, columns = 2 }) {
  let dialog;
  const formApi = form({
    fields,
    values,
    columns,
    submitLabel,
    note,
    onSubmit: async (submitted, helpers) => {
      await onSubmit(submitted, { ...helpers, close: () => dialog.close() });
    },
    onCancel: () => dialog.close(),
  });
  dialog = modal({ title, body: formApi.node, size });
  return { dialog, formApi };
}

/* -------------------------------------------------------------------- toast */

export function toast(message, kind = 'info', timeout = 5000) {
  const tones = {
    info: 'bg-ink-900 text-white',
    good: 'bg-emerald-600 text-white',
    warn: 'bg-amber-500 text-white',
    bad: 'bg-rose-600 text-white',
  };
  const node = el(
    'div',
    {
      class: `pointer-events-auto flex items-start gap-2 rounded-lg px-3 py-2 text-sm shadow-overlay ${tones[kind] || tones.info}`,
      role: 'status',
    },
    [
      icon(kind === 'good' ? 'check_circle' : kind === 'bad' ? 'error' : kind === 'warn' ? 'warning' : 'info'),
      el('span', { class: 'flex-1', text: message }),
      el('button', { class: 'opacity-70 hover:opacity-100', 'aria-label': 'Dismiss', on: { click: () => node.remove() } }, [
        icon('close', 'text-base'),
      ]),
    ]
  );
  document.getElementById('toasts').appendChild(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

/* ------------------------------------------------------------------ helpers */

export function debounce(fn, delay = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/** Search box wired to a debounced callback. */
export function searchBox(placeholder, onSearch, initial = '') {
  const input = el('input', {
    class: 'input pl-9',
    type: 'search',
    placeholder,
    value: initial,
    on: { input: debounce((event) => onSearch(event.target.value), 300) },
  });
  return el('div', { class: 'relative min-w-[12rem] flex-1' }, [
    el('span', { class: 'pointer-events-none absolute left-2.5 top-2.5 text-ink-400' }, [icon('search', 'text-base')]),
    input,
  ]);
}

export function filterBar(children) {
  return el('div', { class: 'mb-3 flex flex-wrap items-end gap-2 no-print' }, children);
}

/** Labelled select for filter bars. */
export function filterSelect({ label, options, value, onChange, placeholder = 'All', width = '10rem' }) {
  const select = el('select', {
    class: 'input',
    style: { width },
    on: { change: (event) => onChange(event.target.value || null) },
  });
  select.appendChild(el('option', { value: '', text: placeholder }));
  for (const option of resolveOptions(options)) {
    select.appendChild(el('option', { value: option.value, text: option.label }));
  }
  select.value = value ?? '';
  return el('div', {}, [label ? el('label', { class: 'label', text: label }) : null, select]);
}

export function filterInput({ label, type = 'date', value, onChange, width = '10rem', min, max }) {
  const input = el('input', {
    class: 'input',
    type,
    value: value ?? '',
    min: min ?? null,
    max: max ?? null,
    style: { width },
    on: { change: (event) => onChange(event.target.value || null) },
  });
  return el('div', {}, [label ? el('label', { class: 'label', text: label }) : null, input]);
}

/**
 * Prints a detached node (a receipt, report card, ID card sheet) without
 * navigating away. The node is mounted into a print-only container so the app
 * chrome disappears and the browser's own print dialogue handles the rest — no PDF
 * library, which keeps the app free of a heavyweight offline dependency.
 */
export function printNode(node, { title } = {}) {
  const holder = el('div', { id: 'print-root', class: 'hidden print:block' }, [node]);
  const previousTitle = document.title;
  if (title) document.title = title;

  const appNode = document.getElementById('app');
  appNode.classList.add('print:hidden');
  document.body.appendChild(holder);

  const cleanup = () => {
    holder.remove();
    appNode.classList.remove('print:hidden');
    document.title = previousTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  window.print();
  // Safety net: some browsers never fire afterprint.
  setTimeout(cleanup, 60000);
}

/** Definition list used on profile screens. */
export function details(items, columns = 2) {
  return el(
    'dl',
    { class: `grid grid-cols-1 gap-x-6 gap-y-3 ${columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}` },
    items
      .filter((item) => item)
      .map((item) =>
        el('div', { class: item.colSpan === 'full' ? 'sm:col-span-2' : '' }, [
          el('dt', { class: 'text-xs font-medium uppercase tracking-wide text-ink-500', text: item.label }),
          el('dd', { class: 'mt-0.5 text-sm text-ink-900' }, [
            item.node || fmt.text(item.value),
          ]),
        ])
      )
  );
}

/** Small inline key/value row for compact summaries. */
export function keyValue(label, value) {
  return el('div', { class: 'flex items-baseline justify-between gap-3 py-1 text-sm' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('span', { class: 'font-medium tabular-nums', text: value }),
  ]);
}
