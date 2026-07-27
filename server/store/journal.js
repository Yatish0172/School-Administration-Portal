'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { paths } = require('../paths');
const workbook = require('./workbook');

/**
 * Excel has no transactions (CLAUDE.md §9). Before a write that spans sheets or
 * workbooks, copy the affected files to Database/journal/. If any step throws,
 * copy them back. Delete the snapshot on success.
 */

async function snapshot(keys) {
  const token = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
    .randomBytes(4)
    .toString('hex')}`;
  const dir = path.join(paths.journal, token);
  await fsp.mkdir(dir, { recursive: true });

  const files = [];
  for (const key of keys) {
    const source = workbook.fileFor(key);
    if (!fs.existsSync(source)) continue; // nothing to roll back to yet
    const target = path.join(dir, path.basename(source));
    await fsp.copyFile(source, target);
    files.push({ key, source, target });
  }
  await fsp.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ token, at: new Date().toISOString(), files }, null, 2),
    'utf8'
  );
  return { token, dir, files };
}

async function restore(snap) {
  if (!snap) return;
  for (const file of snap.files) {
    try {
      await fsp.copyFile(file.target, file.source);
    } catch (err) {
      // Keep going — restoring the rest matters more than one failure, and the
      // snapshot folder is deliberately left on disk for manual recovery.
      console.error(`[journal] failed to restore ${file.source}: ${err.message}`);
    }
  }
  // Disk no longer matches memory; force a reload on next access.
  workbook.invalidateAll();
  await fsp
    .writeFile(
      path.join(snap.dir, 'RESTORED.txt'),
      `Restored at ${new Date().toISOString()}\n`,
      'utf8'
    )
    .catch(() => {});
}

async function discard(snap) {
  if (!snap) return;
  await fsp.rm(snap.dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Runs `fn` across the given workbooks with both memory rollback (from
 * workbook.mutateMany) and disk rollback (from this journal).
 *
 * The snapshot is taken by mutateMany immediately before it starts writing files,
 * so a rejected payment costs nothing and only a genuine mid-write failure leaves
 * a folder in Database/journal/ for someone to look at.
 */
async function runJournaled(keys, fn, options = {}) {
  return workbook.mutateMany(keys, fn, {
    ...options,
    hooks: {
      before: (ordered) => snapshot(ordered),
      afterPersist: (snap) => discard(snap),
      onError: async (snap, err) => {
        await restore(snap);
        console.error(`[journal] rolled back ${keys.join(', ')}: ${err.message}`);
      },
    },
  });
}

/** Left-over snapshots mean a crash mid-write. Surface them, never auto-restore. */
async function pendingSnapshots() {
  if (!fs.existsSync(paths.journal)) return [];
  const entries = await fsp.readdir(paths.journal, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(paths.journal, entry.name, 'manifest.json');
    if (!fs.existsSync(manifest)) continue;
    const restored = fs.existsSync(path.join(paths.journal, entry.name, 'RESTORED.txt'));
    try {
      const data = JSON.parse(await fsp.readFile(manifest, 'utf8'));
      out.push({ token: entry.name, at: data.at, restored, files: data.files.length });
    } catch (err) {
      out.push({ token: entry.name, at: null, restored, files: 0, unreadable: true });
    }
  }
  return out;
}

/** Snapshots older than the cutoff are noise from completed work. */
async function pruneSnapshots(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const snaps = await pendingSnapshots();
  const cutoff = Date.now() - maxAgeMs;
  for (const snap of snaps) {
    const at = snap.at ? Date.parse(snap.at) : 0;
    if (at && at < cutoff) {
      await fsp
        .rm(path.join(paths.journal, snap.token), { recursive: true, force: true })
        .catch(() => {});
    }
  }
}

module.exports = {
  snapshot,
  restore,
  discard,
  runJournaled,
  pendingSnapshots,
  pruneSnapshots,
};
