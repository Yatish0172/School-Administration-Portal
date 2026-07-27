'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { paths, ensureDirs } = require('../paths');
const settings = require('../store/settings');
const errors = require('../errors');

/**
 * Uploads and downloads (SPEC §6, §17, T16).
 *
 * Rules enforced here: extension allow-list, size cap, server-generated filenames,
 * stored under Database/documents/, and never served by a static path — every
 * download goes through an authorising route that calls `resolveStored`.
 */

const ALLOWED = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const IMAGE_ONLY = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const DOC_TYPES = [
  'Birth certificate',
  'Transfer certificate',
  'Aadhaar',
  'Photo',
  'Report card',
  'Caste certificate',
  'Medical record',
  'Other',
];

function extensionOf(originalName) {
  return path.extname(String(originalName || '')).toLowerCase();
}

/** Server-generated name: nothing from the client survives into the filesystem. */
function storedNameFor(originalName, prefix = 'doc') {
  const ext = extensionOf(originalName);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${prefix}-${stamp}-${crypto.randomBytes(12).toString('hex')}${ext}`;
}

function folderFor(kind) {
  const map = {
    student: path.join(paths.documents, 'students'),
    staff: path.join(paths.documents, 'staff'),
    photo: path.join(paths.documents, 'photos'),
    logo: path.join(paths.documents, 'branding'),
    notice: path.join(paths.documents, 'notices'),
    import: paths.temp,
  };
  return map[kind] || path.join(paths.documents, 'other');
}

async function maxBytes() {
  const mb = Number(await settings.get('uploads.maxSizeMb', 5)) || 5;
  return mb * 1024 * 1024;
}

/**
 * Builds a multer middleware for one upload kind.
 * `imagesOnly` is used for photos and the school logo.
 */
function uploader({ kind = 'other', imagesOnly = false, maxFiles = 1 } = {}) {
  const destination = folderFor(kind);
  ensureDirs();
  fs.mkdirSync(destination, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, destination),
    filename: (req, file, cb) => cb(null, storedNameFor(file.originalname, kind)),
  });

  return multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024, files: maxFiles },
    fileFilter: (req, file, cb) => {
      const ext = extensionOf(file.originalname);
      if (!ALLOWED[ext]) {
        return cb(
          errors.badRequest(
            `Files of type "${ext || 'unknown'}" are not allowed. Use ${Object.keys(ALLOWED).join(', ')}.`
          )
        );
      }
      if (imagesOnly && !IMAGE_ONLY.has(ext)) {
        return cb(errors.badRequest('Upload a JPG, PNG or WEBP image.'));
      }
      return cb(null, true);
    },
  });
}

/**
 * Second-stage check after multer has written the file: the configured size cap
 * lives in settings, which multer cannot read synchronously.
 */
async function enforceSizeCap(file) {
  if (!file) return;
  const cap = await maxBytes();
  if (file.size > cap) {
    await fsp.rm(file.path, { force: true }).catch(() => {});
    throw errors.badRequest(
      `That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${(cap / 1048576).toFixed(0)} MB.`
    );
  }
}

function describe(file, kind) {
  return {
    storedName: path.basename(file.filename || file.path),
    originalName: file.originalname,
    mimeType: ALLOWED[extensionOf(file.originalname)] || file.mimetype,
    sizeBytes: file.size,
    kind,
  };
}

/**
 * Resolves a stored filename to an absolute path, refusing anything that escapes
 * the documents folder. This is the only way a download route gets a path.
 */
function resolveStored(kind, storedName) {
  const base = folderFor(kind);
  const safeName = path.basename(String(storedName || ''));
  if (!safeName || safeName.startsWith('.')) {
    throw errors.badRequest('That file reference is not valid.');
  }
  const resolved = path.resolve(base, safeName);
  if (!resolved.startsWith(path.resolve(base))) {
    throw errors.forbidden('That file reference is not valid.');
  }
  if (!fs.existsSync(resolved)) {
    throw errors.notFound('That file is no longer on the server. It may have been restored over.');
  }
  return resolved;
}

function contentTypeFor(storedName) {
  return ALLOWED[extensionOf(storedName)] || 'application/octet-stream';
}

async function remove(kind, storedName) {
  try {
    const resolved = resolveStored(kind, storedName);
    await fsp.rm(resolved, { force: true });
    return true;
  } catch (err) {
    return false;
  }
}

/** Import uploads live in a temp folder and are deleted after commit (SPEC §15). */
async function clearTemp(olderThanMs = 24 * 3600 * 1000) {
  ensureDirs();
  const entries = await fsp.readdir(paths.temp).catch(() => []);
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of entries) {
    const file = path.join(paths.temp, name);
    const stats = await fsp.stat(file).catch(() => null);
    if (!stats || stats.mtimeMs > cutoff) continue;
    await fsp.rm(file, { force: true, recursive: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

module.exports = {
  ALLOWED,
  DOC_TYPES,
  uploader,
  enforceSizeCap,
  describe,
  resolveStored,
  contentTypeFor,
  storedNameFor,
  folderFor,
  remove,
  clearTemp,
  maxBytes,
};
