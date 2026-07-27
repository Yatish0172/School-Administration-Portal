'use strict';

const path = require('path');
const fs = require('fs');

/**
 * The Database folder must sit beside the .exe, not inside the packaged bundle —
 * a portable build unpacks to a temp folder that Windows wipes, which would
 * silently destroy the school's data on every run.
 */
function resolveRoot() {
  if (process.env.SCHOOL_PORTAL_DATA_DIR) {
    return process.env.SCHOOL_PORTAL_DATA_DIR;
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  try {
    // Inside Electron, but not a portable build (installed or `electron .`).
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.dirname(app.getPath('exe'));
    }
  } catch (err) {
    // Not running under Electron — plain `node server.js`.
  }
  return process.cwd();
}

const ROOT = resolveRoot();
const DATABASE = path.join(ROOT, 'Database');

const paths = {
  root: ROOT,
  appRoot: path.join(__dirname, '..'),
  database: DATABASE,
  data: path.join(DATABASE, 'data'),
  documents: path.join(DATABASE, 'documents'),
  backups: path.join(DATABASE, 'backups'),
  journal: path.join(DATABASE, 'journal'),
  temp: path.join(DATABASE, 'temp'),
  sessionsFile: path.join(DATABASE, 'sessions.json'),
  licenseFile: path.join(DATABASE, 'license.json'),
  publicKey: resolvePublicKey(),
};

function resolvePublicKey() {
  const candidates = [
    path.join(__dirname, '..', 'license', 'public.key'),
    path.join(process.resourcesPath || '', 'license', 'public.key'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function ensureDirs() {
  for (const dir of [
    paths.database,
    paths.data,
    paths.documents,
    paths.backups,
    paths.journal,
    paths.temp,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { paths, ensureDirs };
