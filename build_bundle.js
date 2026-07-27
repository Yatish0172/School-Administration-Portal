#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Build step: compiles Tailwind to css/app.css and checks that nothing in the
 * front end reaches out to the network.
 *
 * Runs before `electron .` and before packaging. It is deliberately the only build
 * step - there is no JS bundler, because the front end is plain ES modules served
 * straight off disk (CLAUDE.md tech stack).
 */

const ROOT = __dirname;
const INPUT = path.join(ROOT, 'css', 'src.css');
const OUTPUT = path.join(ROOT, 'css', 'app.css');

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const minify = !args.includes('--no-minify');

function buildCss() {
  const cli = resolveTailwindCli();
  const cliArgs = ['-i', INPUT, '-o', OUTPUT, '--config', path.join(ROOT, 'tailwind.config.js')];
  if (minify) cliArgs.push('--minify');
  if (watch) cliArgs.push('--watch');

  process.stdout.write('[build] compiling Tailwind... ');
  try {
    execFileSync(process.execPath, [cli, ...cliArgs], {
      cwd: ROOT,
      stdio: watch ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.log('failed');
    const detail = err.stderr ? err.stderr.toString() : err.message;
    console.error(detail);
    process.exit(1);
  }
  if (!watch) {
    const size = fs.statSync(OUTPUT).size;
    console.log(`done (${(size / 1024).toFixed(1)} KB)`);
  }
}

function resolveTailwindCli() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
    path.join(ROOT, 'node_modules', '.bin', 'tailwindcss'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  console.error('[build] Tailwind is not installed. Run `npm install` before building.');
  process.exit(1);
  return null;
}

/**
 * Guard rail, not decoration: a single CDN link would break the app the moment it
 * is installed in a school with no internet, and it would break silently - the
 * page still loads, just unstyled or missing a feature.
 */
const FORBIDDEN = [
  { pattern: /https?:\/\/(?!localhost|127\.0\.0\.1|school-portal\.local)[a-z0-9.-]+/gi, label: 'external URL' },
  { pattern: /@import\s+url\(/gi, label: 'CSS @import url()' },
  { pattern: /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs/gi, label: 'CDN reference' },
];

/**
 * XML namespace URIs are identifiers, never fetched. `createElementNS` needs the
 * SVG namespace verbatim, so it is allowed by exact string - anything else on the
 * same host still fails the check.
 */
const ALLOWED_STRINGS = new Set(['http://www.w3.org']);

const SCAN_DIRS = ['js', 'css', 'assets'];
const SCAN_FILES = ['index.html'];
const SKIP_FILE_PATTERNS = [/qrcode\.min\.js$/]; // vendored file carries its upstream URL in a comment

function scanForNetworkCalls() {
  const offences = [];
  const files = [...SCAN_FILES.map((f) => path.join(ROOT, f))];

  for (const dir of SCAN_DIRS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    walk(full, files);
  }

  for (const file of files) {
    if (SKIP_FILE_PATTERNS.some((pattern) => pattern.test(file))) continue;
    if (file === OUTPUT) continue;
    if (!/\.(js|css|html)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const rule of FORBIDDEN) {
      const matches = text.match(rule.pattern);
      if (!matches) continue;
      for (const match of new Set(matches)) {
        if (ALLOWED_STRINGS.has(match)) continue;
        offences.push({ file: path.relative(ROOT, file), label: rule.label, match });
      }
    }
  }
  return offences;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

function checkVendored() {
  const required = [{ file: 'js/vendor/qrcode.min.js', why: 'the Access screen QR code' }];
  const missing = required.filter((item) => !fs.existsSync(path.join(ROOT, item.file)));
  for (const item of missing) {
    console.error(`[build] missing ${item.file} - needed for ${item.why}`);
  }
  return missing.length === 0;
}

/**
 * Icons are inline SVG, so only the two text fonts are optional assets. The app is
 * fully usable and correctly laid out without them.
 */
function reportFonts() {
  const dir = path.join(ROOT, 'fonts');
  const expected = ['Fraunces-Variable.woff2', 'Inter-Variable.woff2'];
  fs.mkdirSync(dir, { recursive: true });
  const missing = expected.filter((name) => !fs.existsSync(path.join(dir, name)));
  if (missing.length) {
    console.log(`[build] note: ${missing.length} text font(s) not vendored yet (${missing.join(', ')}).`);
    console.log('        The app falls back to system fonts until they are dropped into fonts/.');
  }
}

/** A stray icon name with no path would silently render as a placeholder dot. */
function checkIcons() {
  const iconsFile = path.join(ROOT, 'js', 'icons.js');
  if (!fs.existsSync(iconsFile)) {
    console.error('[build] js/icons.js is missing - the interface would have no icons');
    return false;
  }
  const iconsText = fs.readFileSync(iconsFile, 'utf8');
  const defined = new Set(
    [...iconsText.matchAll(/^\s{2}([a-z0-9_]+):\s*'/gm)].map((match) => match[1])
  );

  const used = new Set();
  const jsFiles = [];
  walk(path.join(ROOT, 'js'), jsFiles);
  for (const file of jsFiles) {
    if (!file.endsWith('.js') || file.endsWith('icons.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/icon\(\s*'([a-z0-9_]+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/iconName:\s*'([a-z0-9_]+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/^\s*icon:\s*'([a-z0-9_]+)'/gm)) used.add(match[1]);
  }

  const unknown = [...used].filter((name) => !defined.has(name));
  if (unknown.length) {
    console.error(`[build] FAILED - ${unknown.length} icon(s) used but not drawn: ${unknown.join(', ')}`);
    return false;
  }
  console.log(`[build] icons: ${defined.size} drawn, ${used.size} used, none missing`);
  return true;
}

function main() {
  buildCss();
  if (watch) return;

  reportFonts();

  if (!checkVendored()) process.exit(1);
  if (!checkIcons()) process.exit(1);

  const offences = scanForNetworkCalls();
  if (offences.length) {
    console.error('\n[build] FAILED - the front end must never reach the network:');
    for (const offence of offences) {
      console.error(`  ${offence.file}: ${offence.label} -> ${offence.match}`);
    }
    console.error('\nThe school PC has no internet. Vendor the dependency instead.\n');
    process.exit(1);
  }
  console.log('[build] offline check passed - no external references');
}

main();
