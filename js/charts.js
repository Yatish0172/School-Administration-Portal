/**
 * Chart primitives — inline SVG, no library.
 *
 * Nothing here may reach the network, so a charting library was never an option.
 * These are the four forms the analytics screens actually need, built to a fixed
 * spec so every chart in the portal reads the same way.
 *
 * Palette is the validated categorical set, checked against this app's white card
 * surface (`node scripts/validate_palette.js … --surface #ffffff`): lightness band,
 * chroma floor, CVD separation and normal-vision floor all pass. Three hues sit
 * below 3:1 contrast on white, which obliges visible labels or a table view — so
 * every chart here carries direct labels AND a "Show numbers" table. That is the
 * relief, not an optional extra.
 *
 * Form is chosen by the data's job, not by variety:
 *   trend over time      -> line + area wash, one hue, no legend
 *   compare magnitude    -> horizontal bar, one hue, value at the tip
 *   part-to-whole        -> stacked bar, categorical, legend + gaps
 *   one ratio vs a limit -> meter
 * There are deliberately no pie or donut charts, and never a second y-axis.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Validated categorical order. Assigned by slot, never cycled, never generated. */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

/** Single-hue ramp for magnitude. */
export const SEQUENTIAL = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#2a78d6', '#256abf', '#184f95'];

export const CHART = {
  surface: '#ffffff',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
  secondary: '#52514e',
  primary: '#0b0b0b',
  deemphasis: '#cbd5e1',
};

/** Status colours are reserved and never reused as a series. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

/* ------------------------------------------------------------------ helpers */

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

function html(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'on') for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Axis ticks land on clean numbers, never raw maxima. */
function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Works out the axis top and its tick values together, because the two have to
 * agree — picking a "nice" maximum and then dividing it by a fixed step count is
 * what produces an axis reading "16.7 students".
 *
 * For counts the step is forced to a whole number, so the ticks are too.
 */
function axisScale(rawMax, preferred = 4, integral = false) {
  const safeMax = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 1;

  if (integral) {
    const rough = safeMax / preferred;
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
    const step =
      [1, 2, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= rough) ||
      Math.ceil(rough);
    const top = Math.ceil(safeMax / step) * step;
    const count = Math.round(top / step);
    return { max: top, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) };
  }

  const top = niceCeiling(safeMax);
  return {
    max: top,
    ticks: Array.from({ length: preferred + 1 }, (_, index) => (top / preferred) * index),
  };
}

/** 1284 -> "1,284"; 1284000 -> "12.8L" in the Indian convention schools read. */
export function compact(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 10000000) return `${(n / 10000000).toFixed(abs >= 100000000 ? 0 : 1)}Cr`;
  if (abs >= 100000) return `${(n / 100000).toFixed(abs >= 1000000 ? 0 : 1)}L`;
  if (abs >= 1000) return `${(n / 1000).toFixed(abs >= 10000 ? 0 : 1)}K`;
  return new Intl.NumberFormat('en-IN').format(Math.round(n * 10) / 10);
}

function formatValue(value, format) {
  if (value === null || value === undefined) return '—';
  if (format === 'money') return `₹${compact(value)}`;
  if (format === 'percent') return `${Math.round(Number(value) * 10) / 10}%`;
  return compact(value);
}

/**
 * Wraps a chart with its title and a "Show numbers" table. The table is the
 * relief the palette validation requires, and it is also simply the thing anyone
 * reading a report eventually wants.
 */
export function figure({ title, subtitle, chart, columns, rows, empty: emptyText = 'Nothing to chart yet.' }) {
  if (!rows || !rows.length) {
    return html('div', { class: 'py-8 text-center text-sm text-ink-500', text: emptyText });
  }

  const tableWrap = html('div', { class: 'mt-3 hidden overflow-x-auto' });
  const toggle = html('button', {
    class: 'text-xs font-medium text-brand-700 hover:underline no-print',
    text: 'Show numbers',
    on: {
      click: () => {
        const hidden = tableWrap.classList.toggle('hidden');
        toggle.textContent = hidden ? 'Show numbers' : 'Hide numbers';
      },
    },
  });

  const table = html('table', { class: 'table text-xs' });
  table.appendChild(
    html('thead', {}, [html('tr', {}, columns.map((column) => html('th', { text: column.label })))])
  );
  table.appendChild(
    html(
      'tbody',
      {},
      rows.map((row) =>
        html(
          'tr',
          {},
          columns.map((column) =>
            html('td', {
              class: column.numeric ? 'table-numeric' : '',
              text: column.render ? column.render(row) : formatValue(row[column.key], column.format),
            })
          )
        )
      )
    )
  );
  tableWrap.appendChild(table);

  return html('figure', { class: 'min-w-0' }, [
    html('figcaption', { class: 'mb-2 flex flex-wrap items-baseline justify-between gap-2' }, [
      html('div', {}, [
        title ? html('h3', { class: 'text-sm font-semibold text-ink-900', text: title }) : null,
        subtitle ? html('p', { class: 'text-xs text-ink-500', text: subtitle }) : null,
      ]),
      toggle,
    ]),
    chart,
    tableWrap,
  ]);
}

/* -------------------------------------------------------------- tooltip layer */

function attachTooltip(container) {
  const tip = html('div', {
    class:
      'pointer-events-none absolute z-20 hidden whitespace-nowrap rounded-md bg-ink-900 px-2 py-1 text-xs text-white shadow-overlay',
  });
  container.appendChild(tip);
  return {
    show(x, y, lines) {
      tip.replaceChildren(
        ...lines.map((line) =>
          html('div', { class: line.strong ? 'font-semibold' : 'opacity-90', text: line.text })
        )
      );
      tip.classList.remove('hidden');
      const bounds = container.getBoundingClientRect();
      const width = tip.offsetWidth;
      const left = Math.min(Math.max(4, x - width / 2), bounds.width - width - 4);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(4, y - tip.offsetHeight - 10)}px`;
    },
    hide() {
      tip.classList.add('hidden');
    },
  };
}

/* ------------------------------------------------------------------- trend */

/**
 * Line with an area wash. One series, so no legend — the title says what it is.
 * Endpoint is labelled; everything else is carried by the axis and the tooltip.
 *
 * @param {Array<{label: string, value: number|null}>} points
 */
export function trendChart(points, { height = 200, format = 'number', color = SERIES[0], goal = null } = {}) {
  const width = 720;
  const padding = { top: 18, right: 54, bottom: 26, left: 46 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const values = points.map((point) => (point.value === null ? null : Number(point.value)));
  const present = values.filter((value) => value !== null);
  const integral = format === 'number' && present.every((value) => Number.isInteger(value));
  const scale = axisScale(Math.max(...present, goal || 0, 1), 4, integral);
  const max = scale.max;

  const x = (index) => padding.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value) => padding.top + plotHeight - (value / max) * plotHeight;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'w-full',
    style: `height:${height}px`,
    role: 'img',
    'aria-label': 'Trend over time',
  });

  // Gridlines: hairline, solid, recessive.
  for (const value of scale.ticks) {
    const gy = y(value);
    svg.appendChild(svgEl('line', { x1: padding.left, x2: width - padding.right, y1: gy, y2: gy, stroke: CHART.grid, 'stroke-width': 1 }));
    const tick = svgEl('text', { x: padding.left - 8, y: gy + 4, 'text-anchor': 'end', fill: CHART.muted, 'font-size': 11 });
    tick.setAttribute('style', 'font-variant-numeric: tabular-nums');
    tick.textContent = formatValue(value, format);
    svg.appendChild(tick);
  }

  if (goal !== null) {
    const gy = y(goal);
    svg.appendChild(svgEl('line', { x1: padding.left, x2: width - padding.right, y1: gy, y2: gy, stroke: STATUS.warning, 'stroke-width': 1.5 }));
    // Anchored at the left and sitting above the line. Placing it at the right end
    // put it straight on top of the series' own end label whenever the last point
    // was near the target — two labels in the same few pixels.
    const label = svgEl('text', { x: padding.left + 6, y: gy - 6, fill: CHART.secondary, 'font-size': 10 });
    label.textContent = `target ${formatValue(goal, format)}`;
    svg.appendChild(label);
  }

  // Only draw across points that exist; a gap in the data stays a gap.
  const segments = [];
  let current = [];
  points.forEach((point, index) => {
    if (values[index] === null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push([x(index), y(values[index])]);
  });
  if (current.length) segments.push(current);

  for (const segment of segments) {
    if (segment.length > 1) {
      const areaPath = `M${segment[0][0]},${padding.top + plotHeight} ${segment
        .map(([px, py]) => `L${px},${py}`)
        .join(' ')} L${segment[segment.length - 1][0]},${padding.top + plotHeight} Z`;
      svg.appendChild(svgEl('path', { d: areaPath, fill: color, 'fill-opacity': 0.1 }));
    }
    svg.appendChild(
      svgEl('path', {
        d: segment.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px},${py}`).join(' '),
        fill: 'none',
        stroke: color,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      })
    );
  }

  // End marker with a surface ring, plus the one direct label.
  const lastIndex = values.reduce((found, value, index) => (value !== null ? index : found), -1);
  if (lastIndex >= 0) {
    svg.appendChild(svgEl('circle', { cx: x(lastIndex), cy: y(values[lastIndex]), r: 5, fill: color, stroke: CHART.surface, 'stroke-width': 2 }));
    const label = svgEl('text', { x: x(lastIndex) + 9, y: y(values[lastIndex]) + 4, fill: CHART.primary, 'font-size': 12, 'font-weight': 600 });
    label.textContent = formatValue(values[lastIndex], format);
    svg.appendChild(label);
  }

  // Axis: first, middle and last label only, so they never collide.
  svg.appendChild(svgEl('line', { x1: padding.left, x2: width - padding.right, y1: padding.top + plotHeight, y2: padding.top + plotHeight, stroke: CHART.axis, 'stroke-width': 1 }));
  for (const index of [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]) {
    if (index < 0 || !points[index]) continue;
    const label = svgEl('text', {
      x: x(index),
      y: height - 8,
      'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
      fill: CHART.muted,
      'font-size': 11,
    });
    label.textContent = points[index].label;
    svg.appendChild(label);
  }

  const container = html('div', { class: 'relative' }, [svg]);
  const tooltip = attachTooltip(container);
  const marker = svgEl('line', { y1: padding.top, y2: padding.top + plotHeight, stroke: CHART.axis, 'stroke-width': 1, opacity: 0 });
  svg.appendChild(marker);

  svg.addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const scale = width / box.width;
    const localX = (event.clientX - box.left) * scale;
    const index = Math.round(((localX - padding.left) / plotWidth) * (points.length - 1));
    const point = points[Math.min(points.length - 1, Math.max(0, index))];
    if (!point) return;
    const px = x(Math.min(points.length - 1, Math.max(0, index)));
    marker.setAttribute('x1', px);
    marker.setAttribute('x2', px);
    marker.setAttribute('opacity', 1);
    tooltip.show((px / scale), ((y(point.value ?? 0)) / scale), [
      { text: point.label, strong: true },
      { text: point.value === null ? 'not recorded' : formatValue(point.value, format) },
    ]);
  });
  svg.addEventListener('mouseleave', () => {
    marker.setAttribute('opacity', 0);
    tooltip.hide();
  });

  return container;
}

/* --------------------------------------------------------------------- bars */

/**
 * Horizontal bars for comparing magnitude. One hue by default; pass
 * `emphasis` to highlight a single row and gray the rest, which is usually the
 * honest form when one row is the point.
 *
 * @param {Array<{label: string, value: number, note?: string, tone?: string}>} rows
 */
export function barChart(rows, { format = 'number', color = SERIES[0], emphasis = null, max: forcedMax = null } = {}) {
  const barHeight = 22; // capped, never fills the band
  const gap = 12;
  const labelWidth = 150;
  const valueWidth = 74;
  const width = 720;
  const height = rows.length * (barHeight + gap) + 6;
  const plotWidth = width - labelWidth - valueWidth;
  const integral = format === 'number' && rows.every((row) => Number.isInteger(Number(row.value) || 0));
  const max = forcedMax ?? axisScale(Math.max(...rows.map((row) => Number(row.value) || 0), 1), 4, integral).max;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'w-full',
    style: `height:${height}px`,
    role: 'img',
    'aria-label': 'Comparison',
  });

  const container = html('div', { class: 'relative' }, [svg]);
  const tooltip = attachTooltip(container);

  rows.forEach((row, index) => {
    const y = index * (barHeight + gap) + 3;
    const value = Number(row.value) || 0;
    const barWidth = Math.max(value > 0 ? 3 : 0, (value / max) * plotWidth);
    const fill = row.tone ? STATUS[row.tone] || color : emphasis ? (row.label === emphasis ? color : CHART.deemphasis) : color;

    const label = svgEl('text', { x: labelWidth - 10, y: y + barHeight / 2 + 4, 'text-anchor': 'end', fill: CHART.secondary, 'font-size': 12 });
    label.textContent = row.label.length > 22 ? `${row.label.slice(0, 21)}…` : row.label;
    svg.appendChild(label);

    // Track, then the bar with a 4px rounded data-end and a square baseline.
    svg.appendChild(svgEl('rect', { x: labelWidth, y, width: plotWidth, height: barHeight, rx: 3, fill: '#f1f5f9' }));
    if (barWidth > 0) {
      const bar = svgEl('path', {
        d: roundedRightPath(labelWidth, y, barWidth, barHeight, 4),
        fill,
      });
      svg.appendChild(bar);
    }

    const valueLabel = svgEl('text', { x: labelWidth + plotWidth + 8, y: y + barHeight / 2 + 4, fill: CHART.primary, 'font-size': 12, 'font-weight': 600 });
    valueLabel.setAttribute('style', 'font-variant-numeric: tabular-nums');
    valueLabel.textContent = formatValue(value, format);
    svg.appendChild(valueLabel);

    const hit = svgEl('rect', { x: 0, y: y - gap / 2, width, height: barHeight + gap, fill: 'transparent' });
    hit.addEventListener('mousemove', (event) => {
      const box = svg.getBoundingClientRect();
      const scale = width / box.width;
      tooltip.show((event.clientX - box.left), (y + barHeight / 2) / scale, [
        { text: row.label, strong: true },
        { text: formatValue(value, format) + (row.note ? ` · ${row.note}` : '') },
      ]);
    });
    hit.addEventListener('mouseleave', () => tooltip.hide());
    svg.appendChild(hit);
  });

  return container;
}

/** A rect with only its right-hand corners rounded — the data-end spec. */
function roundedRightPath(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  return `M${x},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h - radius} Q${x + w},${y + h} ${x + w - radius},${y + h} H${x} Z`;
}

/* ---------------------------------------------------------------- columns */

/** Vertical columns, for a short ordered sequence like days of the week. */
export function columnChart(rows, { height = 190, format = 'number', color = SERIES[0] } = {}) {
  const width = 720;
  const padding = { top: 24, right: 12, bottom: 30, left: 44 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const integral = format === 'number' && rows.every((row) => Number.isInteger(Number(row.value) || 0));
  const scale = axisScale(Math.max(...rows.map((row) => Number(row.value) || 0), 1), 3, integral);
  const max = scale.max;
  const band = plotWidth / rows.length;
  const barWidth = Math.min(24, band * 0.5);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'w-full', style: `height:${height}px`, role: 'img', 'aria-label': 'Comparison' });

  for (const value of scale.ticks) {
    const gy = padding.top + plotHeight - (value / max) * plotHeight;
    svg.appendChild(svgEl('line', { x1: padding.left, x2: width - padding.right, y1: gy, y2: gy, stroke: CHART.grid, 'stroke-width': 1 }));
    const tick = svgEl('text', { x: padding.left - 8, y: gy + 4, 'text-anchor': 'end', fill: CHART.muted, 'font-size': 11 });
    tick.setAttribute('style', 'font-variant-numeric: tabular-nums');
    tick.textContent = formatValue(value, format);
    svg.appendChild(tick);
  }

  const container = html('div', { class: 'relative' }, [svg]);
  const tooltip = attachTooltip(container);

  rows.forEach((row, index) => {
    const value = Number(row.value) || 0;
    const barHeight = Math.max(value > 0 ? 3 : 0, (value / max) * plotHeight);
    const x = padding.left + band * index + (band - barWidth) / 2;
    const y = padding.top + plotHeight - barHeight;

    if (barHeight > 0) {
      svg.appendChild(svgEl('path', { d: roundedTopPath(x, y, barWidth, barHeight, 4), fill: row.tone ? STATUS[row.tone] : color }));
    }
    const cap = svgEl('text', { x: x + barWidth / 2, y: y - 7, 'text-anchor': 'middle', fill: CHART.primary, 'font-size': 11, 'font-weight': 600 });
    cap.textContent = formatValue(value, format);
    svg.appendChild(cap);

    const label = svgEl('text', { x: x + barWidth / 2, y: height - 10, 'text-anchor': 'middle', fill: CHART.muted, 'font-size': 11 });
    label.textContent = row.label;
    svg.appendChild(label);

    const hit = svgEl('rect', { x: padding.left + band * index, y: padding.top, width: band, height: plotHeight, fill: 'transparent' });
    hit.addEventListener('mousemove', (event) => {
      const box = svg.getBoundingClientRect();
      tooltip.show(event.clientX - box.left, y * (box.height / height), [
        { text: row.label, strong: true },
        { text: formatValue(value, format) },
      ]);
    });
    hit.addEventListener('mouseleave', () => tooltip.hide());
    svg.appendChild(hit);
  });

  svg.appendChild(svgEl('line', { x1: padding.left, x2: width - padding.right, y1: padding.top + plotHeight, y2: padding.top + plotHeight, stroke: CHART.axis, 'stroke-width': 1 }));
  return container;
}

function roundedTopPath(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h} Z`;
}

/* ------------------------------------------------------------ part to whole */

/**
 * One horizontal stacked bar. Segments are separated by a 2px gap in the surface
 * colour rather than a stroke, and a legend is always present because there is
 * more than one series.
 *
 * @param {Array<{label: string, value: number}>} segments
 */
export function stackedBar(segments, { format = 'number', height = 30, colors = SERIES } = {}) {
  const total = segments.reduce((sum, segment) => sum + (Number(segment.value) || 0), 0);
  if (total <= 0) {
    return html('div', { class: 'py-6 text-center text-sm text-ink-500', text: 'Nothing recorded yet.' });
  }

  const width = 720;
  const gapPx = 2;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'w-full', style: `height:${height}px`, role: 'img', 'aria-label': 'Share of total' });

  const container = html('div', { class: 'relative' }, [svg]);
  const tooltip = attachTooltip(container);

  let cursor = 0;
  segments.forEach((segment, index) => {
    const value = Number(segment.value) || 0;
    if (value <= 0) return;
    const rawWidth = (value / total) * width;
    const isLast = index === segments.length - 1;
    const drawWidth = Math.max(2, rawWidth - (isLast ? 0 : gapPx));
    const fill = colors[index % colors.length];

    svg.appendChild(svgEl('rect', { x: cursor, y: 0, width: drawWidth, height, rx: 3, fill }));

    // Label inside only when it genuinely fits, otherwise the legend carries it.
    const share = Math.round((value / total) * 100);
    const text = `${share}%`;
    if (drawWidth > 42) {
      const label = svgEl('text', { x: cursor + drawWidth / 2, y: height / 2 + 4, 'text-anchor': 'middle', fill: '#ffffff', 'font-size': 11, 'font-weight': 600 });
      label.textContent = text;
      svg.appendChild(label);
    }

    const hit = svgEl('rect', { x: cursor, y: 0, width: drawWidth, height, fill: 'transparent' });
    hit.addEventListener('mousemove', (event) => {
      const box = svg.getBoundingClientRect();
      tooltip.show(event.clientX - box.left, 0, [
        { text: segment.label, strong: true },
        { text: `${formatValue(value, format)} · ${share}%` },
      ]);
    });
    hit.addEventListener('mouseleave', () => tooltip.hide());
    svg.appendChild(hit);

    cursor += rawWidth;
  });

  return html('div', {}, [container, legend(segments.filter((s) => Number(s.value) > 0), colors, format)]);
}

/** Legend: a coloured mark beside text in an ink token. Text never wears the hue. */
export function legend(items, colors = SERIES, format = 'number') {
  return html(
    'div',
    { class: 'mt-2 flex flex-wrap gap-x-4 gap-y-1' },
    items.map((item, index) =>
      html('span', { class: 'inline-flex items-center gap-1.5 text-xs text-ink-600' }, [
        html('span', {
          class: 'inline-block h-2.5 w-2.5 flex-none rounded-sm',
          style: { backgroundColor: colors[index % colors.length] },
        }),
        `${item.label} `,
        html('span', { class: 'font-medium text-ink-900', text: formatValue(item.value, format) }),
      ])
    )
  );
}

/* -------------------------------------------------------------------- meter */

/**
 * One ratio against a limit. The unfilled track is a lighter step of the same
 * ramp so the state reads across the whole bar.
 */
export function meter({ value, max, label, format = 'number', tone = null }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const fill = tone ? STATUS[tone] : ratio > 0.9 ? STATUS.critical : ratio > 0.75 ? STATUS.warning : SERIES[0];

  return html('div', { class: 'space-y-1' }, [
    html('div', { class: 'flex items-baseline justify-between gap-2 text-xs' }, [
      html('span', { class: 'text-ink-600', text: label }),
      html('span', { class: 'font-semibold tabular-nums text-ink-900', text: `${formatValue(value, format)} / ${formatValue(max, format)}` }),
    ]),
    html('div', { class: 'h-2 w-full overflow-hidden rounded-full', style: { backgroundColor: SEQUENTIAL[0] } }, [
      html('div', { class: 'h-full rounded-full', style: { width: `${ratio * 100}%`, backgroundColor: fill } }),
    ]),
  ]);
}

/* ---------------------------------------------------------------- sparkline */

/** 12-point sparkline for a stat tile. De-emphasised; the tile's value is the point. */
export function sparkline(values, { width = 96, height = 26, color = SERIES[0] } = {}) {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length < 2) return html('div', { style: { height: `${height}px` } });

  const max = Math.max(...present);
  const min = Math.min(...present);
  const span = max - min || 1;
  const step = width / (values.length - 1);

  const points = values
    .map((value, index) => (value === null ? null : [index * step, height - 2 - ((value - min) / span) * (height - 6)]))
    .filter(Boolean);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true', class: 'overflow-visible' });
  svg.appendChild(
    svgEl('path', {
      d: points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' '),
      fill: 'none',
      stroke: color,
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      opacity: 0.85,
    })
  );
  const [lastX, lastY] = points[points.length - 1];
  svg.appendChild(svgEl('circle', { cx: lastX, cy: lastY, r: 3, fill: color, stroke: CHART.surface, 'stroke-width': 2 }));
  return svg;
}

/* ------------------------------------------------------------- stat tile */

/**
 * Stat tile: label, value, optional delta against a named period, optional
 * sparkline. The delta's colour is direction x whether up is good.
 */
export function statTile({ label, value, delta = null, deltaLabel = '', trend = null, tone = null, hint = null, upIsGood = true }) {
  const deltaNode =
    delta === null || delta === undefined || !Number.isFinite(Number(delta))
      ? null
      : (() => {
          const positive = Number(delta) > 0;
          const good = positive === upIsGood;
          const colour = Number(delta) === 0 ? 'text-ink-500' : good ? 'text-emerald-700' : 'text-rose-700';
          return html('span', { class: `text-xs font-medium ${colour}` }, [
            `${positive ? '▲' : Number(delta) === 0 ? '' : '▼'} ${Math.abs(Number(delta)).toFixed(1)}% `,
            html('span', { class: 'font-normal text-ink-500', text: deltaLabel }),
          ]);
        })();

  return html('div', { class: 'card p-4' }, [
    html('p', { class: 'stat-label', text: label }),
    html('div', { class: 'mt-1 flex items-end justify-between gap-3' }, [
      html('p', {
        class: `font-display text-2xl font-semibold ${tone ? `text-${tone}` : 'text-ink-900'}`,
        text: value,
      }),
      trend ? sparkline(trend) : null,
    ]),
    deltaNode || (hint ? html('p', { class: 'stat-sub', text: hint }) : null),
  ]);
}

/** A row of tiles that divides evenly rather than leaving a ragged gap. */
export function tileRow(tiles) {
  const kept = tiles.filter(Boolean);
  const cols = kept.length <= 2 ? kept.length : kept.length % 4 === 0 ? 4 : kept.length % 3 === 0 ? 3 : kept.length % 2 === 0 ? 2 : 4;
  const map = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' };
  return html('div', { class: `grid grid-cols-1 gap-4 ${map[cols] || map[4]}` }, kept);
}

/** Panel wrapper so every chart sits in the same card treatment. */
export function panel(title, subtitle, body, actions = null) {
  return html('section', { class: 'card' }, [
    html('div', { class: 'card-head' }, [
      html('div', {}, [
        html('h2', { class: 'card-title', text: title }),
        subtitle ? html('p', { class: 'mt-0.5 text-xs text-ink-500', text: subtitle }) : null,
      ]),
      actions,
    ]),
    html('div', { class: 'card-body' }, body),
  ]);
}
