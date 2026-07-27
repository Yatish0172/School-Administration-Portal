#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Vendor-side licence tool. Never ships with the app — `tools/` is excluded from
 * the electron-builder file list and `license/private.key` is git-ignored.
 *
 *   node tools/generate-key.js init
 *   node tools/generate-key.js issue --machine <id> --school "Name" [--months 12] [--perpetual]
 *   node tools/generate-key.js verify <key>
 *
 * The machine ID is shown on the portal's Licence screen on the school's PC.
 */

const LICENSE_DIR = path.join(__dirname, '..', 'license');
const PRIVATE_KEY = path.join(LICENSE_DIR, 'private.key');
const PUBLIC_KEY = path.join(LICENSE_DIR, 'public.key');
const REGISTER = path.join(LICENSE_DIR, 'issued.json');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function init({ force }) {
  fs.mkdirSync(LICENSE_DIR, { recursive: true });
  if (fs.existsSync(PRIVATE_KEY) && !force) {
    console.error(
      'A key pair already exists. Regenerating it invalidates every key you have ever issued.\n' +
        'Re-run with --force only if you are certain.'
    );
    process.exit(1);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(
    PRIVATE_KEY,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  fs.writeFileSync(PUBLIC_KEY, publicKey.export({ type: 'spki', format: 'pem' }));

  console.log('Key pair created.');
  console.log(`  Private  ${PRIVATE_KEY}   ← never commit, never ship`);
  console.log(`  Public   ${PUBLIC_KEY}    ← ships inside the app`);
  console.log('\nBack up the private key somewhere safe and offline. Losing it means no');
  console.log('replacement keys can ever be issued for schools already running this build.');
}

function issue(args) {
  if (!fs.existsSync(PRIVATE_KEY)) {
    console.error('No private key found. Run `node tools/generate-key.js init` first.');
    process.exit(1);
  }
  const machineId = String(args.machine || '').trim();
  const school = String(args.school || '').trim();
  if (!machineId) {
    console.error('Missing --machine. Read it off the school\'s Licence screen.');
    process.exit(1);
  }
  if (!school) {
    console.error('Missing --school "School Name".');
    process.exit(1);
  }

  const perpetual = args.perpetual === true || args.perpetual === 'true';
  const months = Number(args.months || 12);
  const issuedAt = new Date();
  const expiresAt = perpetual
    ? null
    : new Date(issuedAt.getTime() + months * 30.44 * 86400000).toISOString();

  const payload = {
    v: 1,
    machineId,
    issuedTo: school,
    issuedAt: issuedAt.toISOString(),
    expiresAt,
    seats: Number(args.seats || 0) || null,
    features: args.features ? String(args.features).split(',') : ['all'],
  };

  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY, 'utf8'));
  const signature = crypto.sign(null, Buffer.from(payloadPart, 'utf8'), privateKey);
  const key = `${payloadPart}.${signature.toString('base64url')}`;

  const register = fs.existsSync(REGISTER)
    ? JSON.parse(fs.readFileSync(REGISTER, 'utf8'))
    : { issued: [] };
  register.issued.push({ ...payload, key });
  fs.writeFileSync(REGISTER, JSON.stringify(register, null, 2));

  console.log('\nProduct key issued\n');
  console.log(`  School      ${school}`);
  console.log(`  Machine     ${machineId}`);
  console.log(`  Expires     ${expiresAt ? expiresAt.slice(0, 10) : 'never (perpetual)'}`);
  console.log(`  Recorded in ${REGISTER}`);
  console.log('\nSend the school this key:\n');
  console.log(key);
  console.log('\nAfter expiry they get 14 days of full access with warnings, then read-only.');
  console.log('Export always keeps working.\n');
}

function verify(args) {
  const key = String(args._[1] || '').trim();
  if (!key) {
    console.error('Usage: node tools/generate-key.js verify <key>');
    process.exit(1);
  }
  if (!fs.existsSync(PUBLIC_KEY)) {
    console.error('No public key found. Run init first.');
    process.exit(1);
  }
  const dot = key.indexOf('.');
  if (dot === -1) {
    console.error('That is not a valid key format.');
    process.exit(1);
  }
  const payloadPart = key.slice(0, dot);
  const signature = Buffer.from(key.slice(dot + 1), 'base64url');
  const publicKey = crypto.createPublicKey(fs.readFileSync(PUBLIC_KEY, 'utf8'));
  const valid = crypto.verify(null, Buffer.from(payloadPart, 'utf8'), publicKey, signature);
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));

  console.log(`Signature: ${valid ? 'valid' : 'INVALID'}`);
  console.log(JSON.stringify(payload, null, 2));
  if (payload.expiresAt) {
    const daysLeft = Math.ceil((Date.parse(payload.expiresAt) - Date.now()) / 86400000);
    console.log(`Days left: ${daysLeft}`);
  }
  process.exit(valid ? 0 : 1);
}

function list() {
  if (!fs.existsSync(REGISTER)) {
    console.log('No keys issued yet.');
    return;
  }
  const register = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
  for (const entry of register.issued) {
    console.log(
      `${entry.issuedAt.slice(0, 10)}  ${entry.issuedTo.padEnd(30)}  ${entry.machineId}  ${
        entry.expiresAt ? entry.expiresAt.slice(0, 10) : 'perpetual'
      }`
    );
  }
}

function usage() {
  console.log(`School Admin Portal — licence tool

  init                        Create the Ed25519 key pair (once, ever)
  issue --machine <id> --school "Name" [--months 12] [--perpetual]
  verify <key>                Check a key you have issued
  list                        Show every key issued from this machine

The machine ID comes from the school's Licence screen. Keys are locked to that PC.
`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

switch (command) {
  case 'init':
    init(args);
    break;
  case 'issue':
    issue(args);
    break;
  case 'verify':
    verify(args);
    break;
  case 'list':
    list();
    break;
  default:
    usage();
    process.exit(command ? 1 : 0);
}
