'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const unzipper = require('unzipper');

const { paths, ensureDirs } = require('../paths');
const workbook = require('../store/workbook');
const crud = require('../store/crud');
const settings = require('../store/settings');
const audit = require('../store/audit');
const sessions = require('../store/sessions');
const errors = require('../errors');

/**
 * Backup and restore (SPEC §16).
 *
 * "An untested backup is not a backup" — the restore path here is the same code
 * the Admin screen calls, so testing the screen tests the real thing.
 */

const KINDS = ['manual', 'daily', 'shutdown', 'pre-restore'];

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

function backupName(kind, date = new Date()) {
  return `backup-${kind}-${stamp(date)}.zip`;
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Zips Database/data + Database/documents while holding every workbook lock, so
 * the archive is a consistent snapshot rather than a smear across writes.
 */
async function run({ kind = 'manual', ctx = { userId: 'system' } } = {}) {
  if (!KINDS.includes(kind)) kind = 'manual';
  ensureDirs();

  const started = Date.now();
  const file = path.join(paths.backups, backupName(kind));

  try {
    await workbook.withAllLocksFlushed(async () => {
      await zipFolders(file, [
        { source: paths.data, prefix: 'data' },
        { source: paths.documents, prefix: 'documents' },
      ]);
    });

    const stats = await fsp.stat(file);
    const checksum = await sha256(file);
    const durationMs = Date.now() - started;

    await crud.create(
      'System',
      'BackupRuns',
      {
        at: new Date().toISOString(),
        kind,
        status: 'success',
        file: path.basename(file),
        sizeBytes: stats.size,
        checksum,
        durationMs,
        error: null,
      },
      ctx,
      { label: 'backup run' }
    );
    await settings.set('system.lastBackupAt', new Date().toISOString(), ctx);

    await copyToSecondary(file).catch((err) =>
      console.warn(`[backup] secondary copy failed: ${err.message}`)
    );
    await prune().catch((err) => console.warn(`[backup] prune failed: ${err.message}`));

    await audit.log({
      action: audit.ACTIONS.BACKUP_RUN,
      entityType: 'backup',
      entityId: path.basename(file),
      after: { kind, sizeBytes: stats.size, checksum, durationMs },
      message: `Backup completed (${formatSize(stats.size)})`,
      actor: ctx,
    });

    return {
      file: path.basename(file),
      sizeBytes: stats.size,
      checksum,
      durationMs,
      kind,
      status: 'success',
    };
  } catch (err) {
    await fsp.rm(file, { force: true }).catch(() => {});
    await crud
      .create(
        'System',
        'BackupRuns',
        {
          at: new Date().toISOString(),
          kind,
          status: 'failed',
          file: path.basename(file),
          sizeBytes: 0,
          checksum: null,
          durationMs: Date.now() - started,
          error: err.message,
        },
        ctx,
        { label: 'backup run' }
      )
      .catch(() => {});
    await audit
      .log({
        action: audit.ACTIONS.BACKUP_FAILED,
        entityType: 'backup',
        entityId: path.basename(file),
        message: `Backup failed: ${err.message}`,
        actor: ctx,
      })
      .catch(() => {});
    console.error(`[backup] failed: ${err.message}`);
    throw errors.badRequest(`The backup did not complete: ${err.message}`);
  }
}

function zipFolders(target, folders) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(target);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (err) => console.warn(`[backup] ${err.message}`));
    archive.on('error', reject);

    archive.pipe(output);
    for (const folder of folders) {
      if (fs.existsSync(folder.source)) {
        archive.directory(folder.source, folder.prefix);
      }
    }
    archive.append(
      JSON.stringify(
        { createdAt: new Date().toISOString(), app: 'School Admin Portal', version: 1 },
        null,
        2
      ),
      { name: 'manifest.json' }
    );
    archive.finalize();
  });
}

async function copyToSecondary(file) {
  const target = await settings.get('backup.secondaryPath', '');
  if (!target) return false;
  if (!fs.existsSync(target)) {
    throw new Error(`second copy path not found: ${target}`);
  }
  await fsp.copyFile(file, path.join(target, path.basename(file)));
  return true;
}

/** Retention: keep N daily and the first backup of each of the last M months. */
async function prune() {
  const config = await settings.getMany(['backup.retainDaily', 'backup.retainMonthly']);
  const retainDaily = Number(config['backup.retainDaily'] ?? 30);
  const retainMonthly = Number(config['backup.retainMonthly'] ?? 12);

  const entries = (await fsp.readdir(paths.backups)).filter((name) => name.endsWith('.zip'));
  const files = [];
  for (const name of entries) {
    const stats = await fsp.stat(path.join(paths.backups, name));
    files.push({ name, at: stats.mtime, month: stats.mtime.toISOString().slice(0, 7) });
  }
  files.sort((a, b) => b.at - a.at);

  const keep = new Set();
  files.slice(0, retainDaily).forEach((f) => keep.add(f.name));

  const monthlySeen = new Set();
  for (const file of files) {
    if (monthlySeen.has(file.month)) continue;
    monthlySeen.add(file.month);
    if (monthlySeen.size <= retainMonthly) keep.add(file.name);
  }

  const removed = [];
  for (const file of files) {
    if (keep.has(file.name)) continue;
    await fsp.rm(path.join(paths.backups, file.name), { force: true });
    removed.push(file.name);
  }
  return removed;
}

/* ------------------------------------------------------------------ history */

async function history(limit = 50) {
  const rows = await workbook.read('System', 'BackupRuns');
  return rows
    .slice()
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, limit);
}

async function listFiles() {
  ensureDirs();
  const entries = (await fsp.readdir(paths.backups)).filter((name) => name.endsWith('.zip'));
  const out = [];
  for (const name of entries) {
    const stats = await fsp.stat(path.join(paths.backups, name));
    out.push({ name, sizeBytes: stats.size, at: stats.mtime.toISOString() });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Dashboard alerting (SPEC §16): red banner after a failed or missed backup.
 */
async function status() {
  const rows = await workbook.read('System', 'BackupRuns');
  const sorted = rows
    .slice()
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const lastSuccess = sorted.find((r) => r.status === 'success') || null;
  const last = sorted[0] || null;

  const hoursSince = lastSuccess
    ? Math.floor((Date.now() - Date.parse(lastSuccess.at)) / 3600000)
    : null;

  let severity = 'none';
  let message = null;
  if (!lastSuccess) {
    severity = 'critical';
    message = 'No backup has ever run on this PC. Run one now.';
  } else if (hoursSince > 48) {
    severity = 'critical';
    message = `The last successful backup was ${Math.floor(hoursSince / 24)} days ago. Run one now.`;
  } else if (hoursSince > 26) {
    severity = 'warning';
    message = `The last successful backup was ${hoursSince} hours ago.`;
  } else if (last && last.status === 'failed') {
    severity = 'warning';
    message = `The most recent backup attempt failed: ${last.error || 'unknown error'}`;
  }

  return { last, lastSuccess, hoursSince, severity, message };
}

/* ------------------------------------------------------------------ restore */

/**
 * Restores a backup over the live data. Admin only, re-authenticated at the route,
 * and it always takes a pre-restore backup first so a mistaken restore is undoable.
 */
async function restore(fileName, ctx) {
  const source = path.join(paths.backups, path.basename(fileName));
  if (!fs.existsSync(source)) {
    throw errors.notFound('That backup file is not in the backups folder.');
  }

  const contents = await inspect(source);
  if (!contents.hasData) {
    throw errors.badRequest(
      'That zip does not look like a portal backup — it has no data folder inside.'
    );
  }

  // Undo path for a restore chosen by mistake.
  const safety = await run({ kind: 'pre-restore', ctx });

  await workbook.withAllLocksFlushed(async () => {
    await fsp.rm(paths.data, { recursive: true, force: true });
    await fsp.mkdir(paths.data, { recursive: true });
    await extract(source);
    workbook.invalidateAll();
  });

  await workbook.init();
  // Everyone must sign in again: the users and permissions they were holding may
  // no longer exist in the restored data. The admin running the restore keeps
  // their session so they can see the result.
  const ended = await sessions.destroyAllExcept(ctx?.sessionToken || null, 'restored');

  await audit.log({
    action: audit.ACTIONS.RESTORE_RUN,
    entityType: 'backup',
    entityId: path.basename(fileName),
    before: { safetyBackup: safety.file },
    after: { restored: path.basename(fileName) },
    message: `Restored from ${path.basename(fileName)} (safety copy ${safety.file})`,
    actor: ctx,
    flush: true,
  });

  return { restored: path.basename(fileName), safetyBackup: safety.file, sessionsEnded: ended };
}

async function inspect(zipPath) {
  const directory = await unzipper.Open.file(zipPath);
  const names = directory.files.map((f) => f.path);
  return {
    hasData: names.some((name) => name.startsWith('data/')),
    hasDocuments: names.some((name) => name.startsWith('documents/')),
    fileCount: names.length,
    names: names.slice(0, 50),
  };
}

async function extract(zipPath) {
  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    let target = null;
    if (entry.path.startsWith('data/')) {
      target = path.join(paths.data, entry.path.slice('data/'.length));
    } else if (entry.path.startsWith('documents/')) {
      target = path.join(paths.documents, entry.path.slice('documents/'.length));
    } else {
      continue; // manifest.json and anything unexpected
    }
    // Path traversal guard — a crafted zip must not write outside Database/.
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(paths.database))) continue;
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await new Promise((resolve, reject) => {
      entry
        .stream()
        .pipe(fs.createWriteStream(resolved))
        .on('finish', resolve)
        .on('error', reject);
    });
  }
}

/* ---------------------------------------------------------------- scheduler */

let scheduler = null;

/** Checks every 10 minutes whether today's scheduled backup is due. */
function startScheduler() {
  if (scheduler) return scheduler;
  let lastRunDate = null;

  scheduler = setInterval(async () => {
    try {
      const hour = Number(await settings.get('backup.dailyHour', 20));
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (lastRunDate === today) return;
      if (now.getHours() < hour) return;

      const runs = await workbook.read('System', 'BackupRuns');
      const alreadyToday = runs.some(
        (r) => r.status === 'success' && String(r.at || '').slice(0, 10) === today && r.kind === 'daily'
      );
      if (alreadyToday) {
        lastRunDate = today;
        return;
      }

      console.log('[backup] running scheduled daily backup');
      await run({ kind: 'daily', ctx: { userId: 'system' } });
      lastRunDate = today;
    } catch (err) {
      console.error(`[backup] scheduled run failed: ${err.message}`);
    }
  }, 600000);
  if (scheduler.unref) scheduler.unref();
  return scheduler;
}

function stopScheduler() {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

module.exports = {
  KINDS,
  run,
  prune,
  history,
  listFiles,
  status,
  restore,
  inspect,
  startScheduler,
  stopScheduler,
  formatSize,
};
