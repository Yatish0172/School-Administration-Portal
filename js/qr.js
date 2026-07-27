/**
 * QR rendering wrapper around the vendored generator (js/vendor/qrcode.min.js).
 *
 * Renders SVG rather than canvas: it prints crisply at any size, which matters
 * because the whole point is a code taped to a wall or printed on an ID card.
 */

import qrcode from './vendor/qrcode.min.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} text
 * @param {object} options
 * @param {number} [options.size]      pixel size of the rendered square
 * @param {number} [options.margin]    quiet zone in modules (4 is the standard)
 * @param {string} [options.level]     'L' | 'M' | 'Q' | 'H'
 * @returns {SVGSVGElement}
 */
export function qrSvg(text, { size = 220, margin = 4, level = 'M', title } = {}) {
  const qr = qrcode(0, level); // typeNumber 0 = pick the smallest that fits
  qr.addData(String(text ?? ''));
  qr.make();

  const count = qr.getModuleCount();
  const total = count + margin * 2;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', title || 'QR code');

  const background = document.createElementNS(SVG_NS, 'rect');
  background.setAttribute('width', String(total));
  background.setAttribute('height', String(total));
  background.setAttribute('fill', '#ffffff');
  svg.appendChild(background);

  // One path for every dark module keeps the DOM small enough to print fast.
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      path += `M${col + margin},${row + margin}h1v1h-1z`;
    }
  }
  const shape = document.createElementNS(SVG_NS, 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('fill', '#0f172a');
  svg.appendChild(shape);

  return svg;
}

/** Replaces a container's contents with a freshly rendered code. */
export function renderInto(container, text, options) {
  container.replaceChildren(qrSvg(text, options));
  return container;
}

/**
 * Best-effort capability check. If the vendored file were ever missing, the Access
 * screen should say so plainly rather than showing an empty box next to
 * instructions telling staff to scan it.
 */
export function isAvailable() {
  try {
    const probe = qrcode(0, 'M');
    probe.addData('probe');
    probe.make();
    return probe.getModuleCount() > 0;
  } catch (err) {
    return false;
  }
}
