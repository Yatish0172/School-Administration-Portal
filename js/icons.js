/**
 * Inline SVG icon set.
 *
 * Icons were originally a ligature font. That was the wrong choice: if the font
 * file is missing the browser renders the ligature *name* as literal text, so
 * "dashboard" appeared beside every menu item and the whole layout broke. A font
 * binary is also the one asset that cannot be authored here, which made the app
 * dependent on a file nobody could supply.
 *
 * These are hand-authored 24×24 outline paths on a common grid: stroke-based,
 * 1.75 width, round caps and joins. They inherit `currentColor` and the font size
 * of their container, so they sit correctly next to text at any scale, print
 * crisply, and cannot fail to load.
 */

/** Every glyph is a path (or set of paths) drawn in a 0 0 24 24 viewBox. */
const PATHS = {
  /* ---------------------------------------------------------- navigation */
  dashboard: 'M4 5h6v6H4zM14 5h6v4h-6zM14 13h6v6h-6zM4 15h6v4H4z',
  school: 'M3 9l9-5 9 5-9 5-9-5zM7 12v5c0 1.4 2.4 2.5 5 2.5s5-1.1 5-2.5v-5M20 10v5',
  how_to_reg: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 11-4.7M14.5 18.5l2 2 4-4.5',
  fact_check: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM7.5 8.5h5M7.5 12h5M7.5 15.5h3M15 14.5l1.4 1.4 2.6-2.8',
  calendar_view_week: 'M4 6h16v13H4zM4 10h16M9 10v9M15 10v9',
  assignment: 'M9 4h6v2H9zM7 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 18.5 4H17M8 11h8M8 15h5',
  edit_note: 'M4 6h11M4 10h11M4 14h6M14 18.5l6-6-2.2-2.2-6 6-.4 2.6z',
  description: 'M13 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8.5zM13 3v5.5h5.5M9 13h6M9 17h4',
  insights: 'M4 19V6M4 19h16M8 16v-4M12 16V9M16 16v-6M20 16v-9',
  payments: 'M3 8h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM10 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 10v7a1 1 0 0 1-1 1H6',
  tune: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  receipt_long: 'M6 3h11a1 1 0 0 1 1 1v14l-2.5-1.5L13 18l-2.5-1.5L8 18l-2.5-1.5V4a1 1 0 0 1 1-1zM9 7h6M9 10.5h6M9 14h4M18 8h3v9a2.5 2.5 0 0 1-2.5 2.5',
  discount: 'M8.5 4h9a2.5 2.5 0 0 1 2.5 2.5v9L8.5 4zM4 8.5L15.5 20H6.5A2.5 2.5 0 0 1 4 17.5v-9zM9 9h.01M15 15h.01M9.5 14.5l5-5',
  undo: 'M4 9h9.5A5.5 5.5 0 1 1 13.5 20H8M4 9l4-4M4 9l4 4',
  query_stats: 'M4 19V6M4 19h16M7 15l3.5-4 3 2.5L18 8M15.5 8H18v2.5M18.5 17.5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0zM20.5 19.5l-1.7-1.7',
  menu_book: 'M12 6.5C10 5 7.5 4.5 4 5v12c3.5-.5 6 0 8 1.5 2-1.5 4.5-2 8-1.5V5c-3.5-.5-6 0-8 1.5zM12 6.5v12',
  directions_bus: 'M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 9h16M7.5 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM16.5 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM8 12.5h.01M16 12.5h.01',
  badge: 'M9 4h6v2.5H9zM5 6.5h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM12 13a1.75 1.75 0 1 0 0-3.5A1.75 1.75 0 0 0 12 13zM8.75 16.5a3.5 3.5 0 0 1 6.5 0',
  event_available: 'M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM4 10.5h16M8 4v3M16 4v3M9 15l2 2 4-4',
  beach_access: 'M12 12L3.5 20M12 12c2-3.5 5-5.5 8-5s3.5 3.5 2 6.5M12 12c-3.5-2-5.5-5-5-8s3.5-3.5 6.5-2M12 12c1.5 3.5 1 6.5-1 8M6 15l-2.5 5',
  account_balance_wallet: 'M4 7.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V9A1.5 1.5 0 0 1 4 7.5zM4 7.5V6a1.5 1.5 0 0 1 1.5-1.5h9M15 14h4.5M15.5 13.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  campaign: 'M4 10h3l7-4v12l-7-4H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1zM7 14v4M17.5 9a4 4 0 0 1 0 6M20 6.5a7.5 7.5 0 0 1 0 11',
  summarize: 'M6 3h8l4.5 4.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h4.5M8.5 12h7M8.5 15.5h7M8.5 19h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  account_tree: 'M8 4h6v4H8zM3 15h5v4H3zM15 15h6v4h-6zM11 8v3M11 11H5.5v4M11 11h7v4',
  group: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 19.5a6.5 6.5 0 0 1 13 0M16 5.5a3 3 0 0 1 0 5.8M17.5 14a5.5 5.5 0 0 1 4 5.5',
  admin_panel_settings: 'M11 3l7 2.5v5.5c0 4-3 7.5-7 9-4-1.5-7-5-7-9V5.5zM11 11.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5zM7.75 16a3.5 3.5 0 0 1 6.5 0',
  devices: 'M3 6h11v9H3zM1.5 18h14M17 9h5.5v9.5H17zM19 16.5h1.5',
  schedule: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3.5 2',
  qr_code_2: 'M4 4h5v5H4zM15 4h5v5h-5zM4 15h5v5H4zM12 4v3M12 10h3M19 12v3M15 15v2M18 18h2M12 19v1M15 20h2',
  backup: 'M12 16V8M12 8L8.5 11.5M12 8l3.5 3.5M6.5 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.7 9.4 4 4 0 0 1 17.5 19z',
  history: 'M3.5 11a8.5 8.5 0 1 1 3 7M3.5 11V6M3.5 11h5M12 8v4.5l3 1.8',
  verified: 'M12 3l2.2 2.2 3.1-.4.4 3.1L20 10l-2.3 2.1.4 3.1-3.1.4L12 18l-2.2-2.4-3.1-.4.4-3.1L4 10l2.3-2.1-.4-3.1 3.1.4zM9.5 10.5l2 2 3.5-3.5',
  monitor_heart: 'M3 5h18v12H3zM7 21h10M12 17v4M6 11h2.5l1.5-2.5 2 5 1.5-2.5H18',
  analytics: 'M4 19V5M4 19h16M8 19v-6M12 19v-9M16 19v-4M20 19V8',
  chevron_right: 'M9.5 6l6 6-6 6',

  /* --------------------------------------------------------------- actions */
  add: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  check_circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.5 2.5L16 9.5',
  save: 'M5 4h10.5L20 8.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 4v5h7V4.5M8.5 16h7',
  edit: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3zM14.5 6.5l3 3',
  delete: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1L17.5 7M10 11v6M14 11v6',
  print: 'M7 8V4h10v4M7 17H5.5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 5.5 9h13a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 18.5 17H17M7 14h10v6H7z',
  download: 'M12 4v10M12 14l-4-4M12 14l4-4M5 17v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2',
  upload: 'M12 16V6M12 6L8 10M12 6l4 4M5 17v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2',
  upload_file: 'M13 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8.5zM13 3v5.5h5.5M12 18v-6M12 12l-2.5 2.5M12 12l2.5 2.5',
  refresh: 'M20 11a8 8 0 1 0-2.5 6.4M20 5.5V11h-5.5',
  sync: 'M4 12a8 8 0 0 1 13.5-5.8M20 12a8 8 0 0 1-13.5 5.8M17.5 3v3.5H14M6.5 21v-3.5H10',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16.5 16.5L21 21',
  content_copy: 'M9 9h9.5a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM15.5 6V4.5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1V16a1 1 0 0 0 1 1h1.5',
  swap_horiz: 'M6 9h13M19 9l-3.5-3.5M18 15H5M5 15l3.5 3.5',
  done_all: 'M3 12.5l3.5 3.5L14 8.5M9.5 16l1.5 1.5L21 7',
  preview: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 9h18M12 15.5c-2.2 0-4-2.2-4-2.2s1.8-2.3 4-2.3 4 2.3 4 2.3-1.8 2.2-4 2.2zM12 14a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z',
  publish: 'M12 4l5 5H7zM12 9v8M5 20h14',
  trending_up: 'M4 17l6-6 3.5 3.5L20 8M15 8h5v5',
  key: 'M15.5 9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM13 11.5L4 20.5v-2H2v-2h2v-2l4.5-4.5',
  grade: 'M12 4l2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8z',
  book: 'M5 4h9.5A1.5 1.5 0 0 1 16 5.5V20H6.5A1.5 1.5 0 0 1 5 18.5zM16 8h2.5A1.5 1.5 0 0 1 20 9.5v9A1.5 1.5 0 0 1 18.5 20H16M8.5 8h4',
  person: 'M12 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  person_add: 'M10 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5zM2.5 20.5a7.5 7.5 0 0 1 15 0M18.5 8v6M15.5 11h6',
  logout: 'M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8M17 8.5l3.5 3.5-3.5 3.5M10 12h10',
  menu: 'M4 7h16M4 12h16M4 17h16',
  arrow_forward: 'M5 12h14M14 7l5 5-5 5',
  lock: 'M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM8 11V8a4 4 0 0 1 8 0v3M12 14.5v3',
  lock_open: 'M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM8 11V8a4 4 0 0 1 7.6-1.7M12 14.5v3',

  /* ------------------------------------------------------------- messaging */
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  warning: 'M12 4l8.5 15H3.5zM12 9.5v4.5M12 16.5h.01',
  error: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V13M12 16h.01',
  inbox: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM3 13h5a4 4 0 0 0 8 0h5',
  call: 'M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z',
  mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3.5 6.5L12 13l8.5-6.5',
  cake: 'M4 15h16v5H4zM4 15a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3M8 12V9M12 12V9M16 12V9M8 6.5V5M12 6.5V5M16 6.5V5',
};

/** Glyphs that read better filled than stroked. */
const FILLED = new Set(['grade']);

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Builds an icon element. Unknown names render a small circle rather than
 * nothing, so a typo is visible in review but never breaks a layout or leaks a
 * word into the interface.
 */
export function svgIcon(name, extraClass = '') {
  const path = PATHS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `sap-icon ${extraClass}`.trim());

  const shape = document.createElementNS(SVG_NS, 'path');
  shape.setAttribute('d', path || 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z');

  if (FILLED.has(name)) {
    shape.setAttribute('fill', 'currentColor');
  } else {
    shape.setAttribute('stroke', 'currentColor');
    shape.setAttribute('stroke-width', '1.75');
    shape.setAttribute('stroke-linecap', 'round');
    shape.setAttribute('stroke-linejoin', 'round');
  }

  svg.appendChild(shape);
  return svg;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}

export function iconNames() {
  return Object.keys(PATHS).sort();
}
