'use strict';

const { ensureDirs, paths } = require('./paths');
const workbook = require('./store/workbook');
const settings = require('./store/settings');
const counters = require('./store/counters');
const permissions = require('./store/permissions');
const sessions = require('./store/sessions');
const users = require('./store/users');
const journal = require('./store/journal');
const audit = require('./store/audit');
const hours = require('./services/hours');
const clock = require('./services/clock');
const license = require('./services/license');
const backup = require('./services/backup');
const files = require('./services/files');
const net = require('./services/net');

/**
 * First-run setup and every-run startup work, in dependency order.
 * Returns the facts main.js needs to print to the Electron console.
 */

const SYSTEM_CTX = { userId: 'system', name: 'System', roleKey: 'admin' };

async function start({ port }) {
  ensureDirs();

  // 1. Storage first — everything else reads from it.
  await workbook.init();

  // 2. Reference data. Each seeder is a no-op once its rows exist.
  await settings.seedDefaults(SYSTEM_CTX);
  await counters.seedDefaults(SYSTEM_CTX);
  await permissions.seed(SYSTEM_CTX);
  await hours.seed(SYSTEM_CTX);

  // 3. First-run admin. The password is returned once and never stored in clear.
  const seededAdmin = await users.seedAdmin();

  // 4. Sessions and licence.
  await sessions.load();
  await license.init();
  const licenseState = await license.state();

  // 5. Clock integrity check (SPEC §3).
  const clockState = await clock.check(SYSTEM_CTX);

  // 6. LAN address, and whether it changed since last run (SPEC §1).
  const access = net.accessInfo(port);
  const previousIp = await settings.get('system.lastLanIp', '');
  const addressChanged = !!(previousIp && access.ip && previousIp !== access.ip);
  if (access.ip) await settings.set('system.lastLanIp', access.ip, SYSTEM_CTX);

  // 7. Anything left in the journal means a crash mid-write. Report, never auto-restore.
  const pending = (await journal.pendingSnapshots()).filter((snap) => !snap.restored);
  await journal.pruneSnapshots();
  await files.clearTemp();

  // 8. Background work.
  sessions.startSweeper();
  clock.startHeartbeat();
  backup.startScheduler();

  // 9. Whether the school Wi-Fi is a route in at all. Read here so the caller can
  //    bind the socket accordingly before it starts listening.
  const lanEnabled = (await settings.get('network.lanEnabled', true)) !== false;

  const backupState = await backup.status();

  await audit.log({
    action: 'system.start',
    entityType: 'system',
    entityId: 'server',
    after: {
      port,
      ip: access.ip,
      license: licenseState.status,
      addressChanged,
    },
    message: `Server started on ${access.url || `port ${port}`}`,
    actor: SYSTEM_CTX,
  });

  return {
    access,
    addressChanged,
    previousIp,
    seededAdmin,
    licenseState,
    clockState,
    backupState,
    lanEnabled,
    // Filled in by startRemote() once the port is actually listening.
    tunnelState: null,
    pendingJournalSnapshots: pending,
    dataDir: paths.database,
  };
}

/**
 * Opens the Cloudflare tunnel. Deliberately separate from `start` and called only
 * once Express is listening: `cloudflared` proxies straight to the port, and
 * starting it first means the first visitors get a gateway error while the two race.
 *
 * Never fatal. A missing `cloudflared`, or no internet, must still leave a portal
 * running on the LAN rather than no portal at all.
 */
async function startRemote() {
  try {
    return await require('./services/tunnel').resumeIfEnabled();
  } catch (err) {
    console.error(`[tunnel] could not open remote access: ${err.message}`);
    return null;
  }
}

/** Graceful shutdown: flush everything, back up, release mDNS. */
async function stop({ backupOnExit = true } = {}) {
  try {
    // Close the tunnel first: leaving cloudflared running past shutdown would keep
    // publishing a hostname that points at nothing.
    await require('./services/tunnel')
      .stop({ quiet: true })
      .catch(() => {});
    await audit.flushNow();
    await sessions.persist();
    await workbook.flushAll();
    if (backupOnExit) {
      await backup.run({ kind: 'shutdown', ctx: SYSTEM_CTX }).catch((err) => {
        console.error(`[shutdown] backup failed: ${err.message}`);
      });
    }
    backup.stopScheduler();
    await net.stopMdns();
  } catch (err) {
    console.error(`[shutdown] ${err.message}`);
  }
}

module.exports = { start, startRemote, stop, SYSTEM_CTX };
