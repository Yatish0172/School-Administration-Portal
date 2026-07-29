'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const { spawn, execFile } = require('child_process');

const { paths } = require('../paths');
const settings = require('../store/settings');
const audit = require('../store/audit');
const errors = require('../errors');

/**
 * Remote access over a Cloudflare quick tunnel — the primary way staff reach the
 * portal. It opens on startup; the school Wi-Fi is the optional second route.
 *
 * A quick tunnel mints a fresh hostname every time `cloudflared` starts, which is
 * exactly the "new link each day" behaviour asked for — the rotation below simply
 * restarts it. That also means the old link dies on rotation, which is the useful
 * half of the property: a link that leaks stops working within the day.
 *
 * Two things learned the hard way, both load-bearing:
 *
 *  - cloudflared prints its assigned hostname well before the edge will route to
 *    it. Treating the hostname as "ready" reports a link that 404s for another
 *    minute or more, so `start` waits for the connection to register too.
 *  - `stop` must wait for the process to actually exit. Killing it and immediately
 *    starting another leaves two cloudflareds overlapping; the second loses the
 *    race for the metrics port and dies, having already printed a hostname that
 *    then never works. `--metrics 127.0.0.1:0` removes the collision as well.
 *
 * Security notes that matter more than the plumbing:
 *  - `cloudflared` connects to localhost, so every remote visitor would otherwise
 *    look like they were sitting at the server PC. `middleware/authenticate.js`
 *    detects the Cloudflare headers and refuses to treat them as local.
 *  - The URL is not a secret in any meaningful sense. Anyone holding it reaches the
 *    sign-in page. Passwords, the lockout and school hours are what protect the
 *    data, exactly as on the school Wi-Fi.
 */

const QUICK_TUNNEL_HOST = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** cloudflared says this once a connection to the edge is actually established. */
const REGISTERED = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;

const START_TIMEOUT_MS = 60000;
const STOP_TIMEOUT_MS = 10000;

/**
 * How long to wait for the new hostname to start resolving at Cloudflare's edge.
 *
 * Split in two so startup is not held hostage to it: wait a short while inline, and
 * if the edge is still catching up, carry on in the background and let the status
 * flip to running when it works. Startup stays quick and the office is never shown a
 * link that is claimed to work when it does not.
 */
const VERIFY_INLINE_MS = 20000;
const VERIFY_TOTAL_MS = 240000;
const VERIFY_INTERVAL_MS = 3000;

let child = null;
let state = {
  status: 'stopped', // stopped | starting | running | failed | unavailable
  url: null,
  startedAt: null,
  rotatedAt: null,
  error: null,
  log: [],
};
let rotationTimer = null;

/* ---------------------------------------------------------------- discovery */

/** Where cloudflared plausibly lives, in the order worth trying. */
function candidatePaths() {
  return [
    process.env.CLOUDFLARED_PATH,
    path.join(paths.root, 'cloudflared.exe'),
    path.join(paths.root, 'cloudflared'),
    path.join(paths.appRoot, 'cloudflared.exe'),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'cloudflared', 'cloudflared.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\cloudflared.exe',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  ].filter(Boolean);
}

/** Resolves the binary, preferring a configured path, then disk, then PATH. */
async function resolveBinary() {
  const configured = await settings.get('remote.cloudflaredPath', '');
  const ordered = [configured, ...candidatePaths()].filter(Boolean);

  for (const candidate of ordered) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (err) {
      // Unreadable path, keep looking.
    }
  }

  // Last resort: on PATH.
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFile(probe, ['cloudflared'], (error, stdout) => {
      if (error || !stdout) return resolve(null);
      const first = String(stdout).split(/\r?\n/).find((line) => line.trim());
      resolve(first ? first.trim() : null);
    });
  });
}

async function version(binary) {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 8000 }, (error, stdout, stderr) => {
      if (error) return resolve(null);
      resolve(String(stdout || stderr).trim().split(/\r?\n/)[0]);
    });
  });
}

const INSTALL_HINT = [
  'Cloudflare Tunnel needs the free `cloudflared` program on this PC.',
  'Install it once, as an administrator:  winget install --id Cloudflare.cloudflared',
  'Or download cloudflared.exe and put it in the same folder as the portal.',
  'Nothing else is needed — no Cloudflare account, no card, no configuration.',
];

/* -------------------------------------------------------------------- start */

/**
 * Keeps the last stretch of cloudflared output in memory for the Access screen, and
 * appends it to a file for anyone diagnosing a tunnel that will not come up.
 *
 * Written here rather than with cloudflared's own `--logfile` because this process
 * needs to read the output to know when the tunnel is actually ready, and that flag
 * diverts it away from the pipes.
 */
function note(line) {
  const trimmed = String(line).trim();
  if (!trimmed) return;
  state.log.push(trimmed.slice(0, 400));
  if (state.log.length > 60) state.log.shift();
  try {
    fs.appendFileSync(path.join(paths.database, 'cloudflared.log'), `${trimmed}\n`);
  } catch (err) {
    // Diagnostics only — never let logging break the tunnel.
  }
}

/**
 * Starts the tunnel and resolves once Cloudflare has both handed back a hostname
 * and confirmed the connection is registered. Both signals arrive on stderr, which
 * is why both streams are read.
 */
async function start(ctx = { userId: 'system' }) {
  if (state.status === 'running' && child) return status();
  if (state.status === 'starting') return status();

  const binary = await resolveBinary();
  if (!binary) {
    state = { ...state, status: 'unavailable', url: null, error: INSTALL_HINT[0] };
    throw errors.badRequest(INSTALL_HINT.join(' '));
  }

  if (!(await internetLooksUp())) {
    const message =
      'This PC cannot reach the internet, so no remote link can be issued. ' +
      'The portal is still running on the school Wi-Fi.';
    state = { ...state, status: 'failed', url: null, error: message };
    throw errors.badRequest(message);
  }

  state = { status: 'starting', url: null, startedAt: null, rotatedAt: state.rotatedAt, error: null, log: [] };

  const port = Number(process.env.PORT || 4700);
  const args = [
    'tunnel',
    '--no-autoupdate',
    '--url',
    `http://localhost:${port}`,
    // Let the OS pick the metrics port. The default is fixed, so a rotation that
    // briefly overlaps two processes would otherwise kill the incoming one.
    '--metrics',
    '127.0.0.1:0',
  ];

  child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const spawned = child;

  const url = await new Promise((resolve, reject) => {
    let settled = false;
    let host = null;
    let registered = false;

    const finish = () => {
      if (settled || !host || !registered) return;
      settled = true;
      clearTimeout(timer);
      resolve(host);
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      // A hostname without a registration is the interesting failure: the link
      // exists but Cloudflare will not route to it, so say so rather than handing
      // the office an address that does not work.
      fail(
        host
          ? `Cloudflare issued ${host} but the tunnel never connected within ${Math.round(
              START_TIMEOUT_MS / 1000
            )} seconds. Check this PC's internet connection.`
          : `Cloudflare did not hand back a link within ${Math.round(
              START_TIMEOUT_MS / 1000
            )} seconds. Check that this PC can reach the internet.`
      );
    }, START_TIMEOUT_MS);

    const scan = (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) note(line);
      if (!host) {
        const match = text.match(QUICK_TUNNEL_HOST);
        if (match) host = match[0];
      }
      if (!registered && REGISTERED.test(text)) registered = true;
      finish();
    };

    spawned.stdout.on('data', scan);
    spawned.stderr.on('data', scan);

    spawned.on('error', (err) => fail(`cloudflared could not be started: ${err.message}`));

    spawned.on('exit', (code) => {
      if (!settled) {
        fail(`cloudflared stopped straight away (exit code ${code}).`);
      } else if (child === spawned && state.status === 'running') {
        // Died after going live — the link is dead, so say so rather than leaving a
        // stale address on the Access screen.
        state = {
          ...state,
          status: 'failed',
          url: null,
          error: `The tunnel stopped unexpectedly (exit code ${code}).`,
        };
        child = null;
      }
    });
  }).catch(async (err) => {
    await stop({ quiet: true });
    state = { ...state, status: 'failed', url: null, error: err.message };
    throw errors.badRequest(err.message);
  });

  // Registration is still not proof the link works. Create quick tunnels too quickly
  // and Cloudflare throttles: it hands back a hostname, accepts the connection, and
  // never publishes DNS for it. Observed repeatedly while testing rotations. So the
  // link is fetched from the outside, the way a member of staff would, before it is
  // presented as working.
  const reachable = await verify(url, VERIFY_INLINE_MS);

  state = {
    status: reachable.ok ? 'running' : 'verifying',
    url,
    startedAt: new Date().toISOString(),
    rotatedAt: state.rotatedAt,
    error: reachable.ok ? null : throttleMessage(url, reachable.last),
    log: state.log,
  };

  // Not up yet is not the same as broken — the edge often needs another minute. Keep
  // watching without holding up startup, and say so plainly in the meantime.
  if (!reachable.ok) {
    console.log(`[tunnel] ${url} issued but not serving yet — still checking`);
    void continueVerifying(url, VERIFY_INLINE_MS);
  }

  await settings.setMany(
    {
      'remote.enabled': true,
      'remote.currentUrl': url,
      'remote.startedAt': state.startedAt,
    },
    ctx
  );

  await audit.log({
    action: audit.ACTIONS.REMOTE_TUNNEL_OPENED,
    entityType: 'remote',
    entityId: url,
    after: { url },
    message: `Remote access opened at ${url}`,
    actor: ctx,
    flush: true,
  });

  scheduleRotation();
  return status();
}

/**
 * Is there any point trying? cloudflared retries a dead connection for as long as
 * you let it, so on a school with the internet down this would otherwise add the
 * full start timeout to every boot before falling back to the Wi-Fi route. One DNS
 * lookup against the host cloudflared itself checks answers the question in
 * milliseconds.
 */
async function internetLooksUp() {
  try {
    await Promise.race([
      dns.resolve4('region1.v2.argotunnel.com'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Confirms the new link actually serves the portal, by asking for it the way a
 * member of staff would. The request goes out to Cloudflare and back to this same
 * machine, so a 200 proves the whole path.
 */
async function verify(url, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = 'no response';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return { ok: true };
      last = `HTTP ${res.status}`;
    } catch (err) {
      // ENOTFOUND while DNS is unpublished, timeouts while the edge settles.
      last = err.cause?.code || err.name || err.message;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
  }

  return { ok: false, last };
}

function throttleMessage(url, last) {
  return (
    `Cloudflare issued ${url} but it is not serving the portal yet (${last}). ` +
    'This usually means several links were created in a short time and Cloudflare is throttling new ones. ' +
    'It often starts working on its own within a few minutes.'
  );
}

/**
 * Keeps checking a link that had not come up by the time startup finished, and
 * promotes it to running the moment it does.
 *
 * Guarded on the url still being the current one, so a rotation or a stop part-way
 * through cannot resurrect a stale address.
 */
async function continueVerifying(url, alreadySpentMs) {
  const remaining = VERIFY_TOTAL_MS - alreadySpentMs;
  if (remaining <= 0) return;

  const result = await verify(url, remaining);
  if (state.url !== url) return; // rotated or stopped meanwhile

  if (result.ok) {
    state = { ...state, status: 'running', error: null };
    note(`link confirmed working: ${url}`);
    console.log(`[tunnel] link is now live: ${url}`);
    return;
  }

  note(`link verification gave up: ${result.last}`);
  console.error(`[tunnel] ${url} never came up (${result.last})`);
  state = {
    ...state,
    status: 'failed',
    url: null,
    error: throttleMessage(url, result.last),
  };

  // Nothing else would retry: `start` returned successfully with the link merely
  // unconfirmed, so the scheduled rotation already counts as done. Without this the
  // school would sit with no remote access until someone noticed.
  clearTimeout(rotationTimer);
  rotationTimer = setTimeout(() => rotateNow(), ROTATE_RETRY_MS);
  if (rotationTimer.unref) rotationTimer.unref();
  console.log(`[tunnel] will try for a new link in ${Math.round(ROTATE_RETRY_MS / 60000)} minutes`);
}

/**
 * Ends a cloudflared process and waits for it to actually be gone.
 *
 * Returning before the process has exited is what broke rotation: `start` would
 * spawn a replacement that overlapped the outgoing one. On Windows a plain kill is
 * also not always enough, so fall back to taskkill on the whole process tree.
 */
function terminate(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(forceTimer);
      resolve();
    };

    proc.once('exit', finish);

    try {
      proc.kill();
    } catch (err) {
      return finish();
    }

    const forceTimer = setTimeout(() => {
      if (done) return;
      if (process.platform === 'win32' && proc.pid) {
        execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => finish());
      } else {
        try {
          proc.kill('SIGKILL');
        } catch (err) {
          // Nothing more to try.
        }
        finish();
      }
    }, STOP_TIMEOUT_MS);
    if (forceTimer.unref) forceTimer.unref();
  });
}

async function stop({ ctx = { userId: 'system' }, quiet = false } = {}) {
  clearTimeout(rotationTimer);
  rotationTimer = null;

  const previous = state.url;
  if (child) {
    await terminate(child);
    child = null;
  }

  state = { ...state, status: 'stopped', url: null, error: null };
  if (!quiet) {
    await settings.setMany({ 'remote.enabled': false, 'remote.currentUrl': '' }, ctx);
    if (previous) {
      await audit.log({
        action: audit.ACTIONS.REMOTE_TUNNEL_CLOSED,
        entityType: 'remote',
        entityId: previous,
        before: { url: previous },
        message: `Remote access closed (${previous} no longer works)`,
        actor: ctx,
        flush: true,
      });
    }
  }
  return status();
}

/** Stop and start, which is what produces a fresh hostname. */
async function rotate(ctx = { userId: 'system' }) {
  await stop({ ctx, quiet: true });
  const result = await start(ctx);
  state.rotatedAt = new Date().toISOString();
  await settings.set('remote.rotatedAt', state.rotatedAt, ctx);
  return result;
}

/* ----------------------------------------------------------------- rotation */

/** How long to wait before trying again when the nightly rotation fails. */
const ROTATE_RETRY_MS = 10 * 60 * 1000;

/**
 * Performs the scheduled rotation, retrying rather than leaving the school without
 * remote access until somebody notices.
 *
 * The old link is already dead by the time a rotation can fail — a quick tunnel
 * cannot be kept alive across a restart — so there is nothing to roll back to. The
 * only useful response is to keep trying, which also handles the throttling case:
 * wait a few minutes and Cloudflare issues a working link again.
 *
 * On success `start` reschedules for the next day, so this is not a loop.
 */
async function rotateNow(attempt = 1) {
  try {
    console.log('[tunnel] rotating the remote link for a new day');
    await rotate({ userId: 'system' });
    console.log(`[tunnel] new link: ${state.url}`);
  } catch (err) {
    console.error(`[tunnel] rotation attempt ${attempt} failed: ${err.message}`);
    // Six tries covers an hour of throttling before giving up until tomorrow.
    if (attempt >= 6) {
      console.error('[tunnel] giving up until the next scheduled rotation');
      scheduleRotation();
      return;
    }
    clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => rotateNow(attempt + 1), ROTATE_RETRY_MS);
    if (rotationTimer.unref) rotationTimer.unref();
  }
}

/**
 * Rotates once a day at the configured hour. A new link daily means a leaked or
 * forwarded address stops working quickly, which is the point.
 */
function scheduleRotation() {
  clearTimeout(rotationTimer);
  rotationTimer = null;

  settings
    .getMany(['remote.rotateDaily', 'remote.rotateHour'])
    .then((config) => {
      if (config['remote.rotateDaily'] === false) return;
      const hour = Number(config['remote.rotateHour'] ?? 3);

      const now = new Date();
      const next = new Date(now);
      next.setHours(hour, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);

      const delay = next.getTime() - now.getTime();
      rotationTimer = setTimeout(() => rotateNow(), delay);
      if (rotationTimer.unref) rotationTimer.unref();
    })
    .catch(() => {});
}

function nextRotationAt() {
  return settings.getMany(['remote.rotateDaily', 'remote.rotateHour']).then((config) => {
    if (config['remote.rotateDaily'] === false) return null;
    const hour = Number(config['remote.rotateHour'] ?? 3);
    const next = new Date();
    next.setHours(hour, 0, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  });
}

/* ------------------------------------------------------------------- status */

async function status() {
  const binary = await resolveBinary();
  const config = await settings.getMany([
    'remote.enabled',
    'remote.rotateDaily',
    'remote.rotateHour',
    'remote.currentUrl',
    'remote.startedAt',
    'remote.rotatedAt',
  ]);

  return {
    status: binary ? state.status : 'unavailable',
    installed: !!binary,
    binary: binary || null,
    version: binary ? await version(binary) : null,
    installHint: binary ? null : INSTALL_HINT,
    // A link still being checked is reported, because it is very likely about to
    // work and the office may as well have it — but `confirmed` says whether it has
    // actually been fetched from outside, so nothing claims more than it knows.
    url: state.status === 'running' || state.status === 'verifying' ? state.url : null,
    confirmed: state.status === 'running',
    startedAt: state.startedAt,
    rotatedAt: state.rotatedAt || config['remote.rotatedAt'] || null,
    rotateDaily: config['remote.rotateDaily'] !== false,
    rotateHour: Number(config['remote.rotateHour'] ?? 3),
    nextRotationAt: state.status === 'running' || state.status === 'verifying' ? await nextRotationAt() : null,
    error: state.error,
    recentLog: state.log.slice(-12),
    lastKnownUrl: config['remote.currentUrl'] || null,
    wasEnabled: config['remote.enabled'] === true,
  };
}

/**
 * Opens the tunnel on startup. This is the primary route in, so it runs on every
 * boot unless the school has switched remote access off.
 *
 * Failure is never fatal and never silent: it always returns a status object saying
 * what went wrong, so the startup banner can tell "not installed" from "no internet"
 * from "switched off" and print the right instruction. The portal itself comes up
 * either way.
 */
async function resumeIfEnabled() {
  try {
    // Escape hatch for automated runs and for starting a second copy on one PC:
    // opening a tunnel every time would burn Cloudflare's quick-tunnel allowance and
    // slow every start. Never set in normal use.
    if (process.env.PORTAL_NO_REMOTE === '1') {
      console.log('[tunnel] skipped (PORTAL_NO_REMOTE=1)');
      return await status();
    }

    const enabled = await settings.get('remote.enabled', true);
    if (!enabled) {
      console.log('[tunnel] remote access is switched off');
      return await status();
    }

    const binary = await resolveBinary();
    if (!binary) {
      console.log('[tunnel] remote access is on but cloudflared is not installed');
      return await status();
    }

    console.log('[tunnel] opening remote access');
    return await start({ userId: 'system' });
  } catch (err) {
    console.error(`[tunnel] could not open remote access: ${err.message}`);
    state = { ...state, status: 'error', url: null, error: err.message };
    try {
      return await status();
    } catch (statusErr) {
      // Even reporting failed; give the banner something usable rather than null.
      return { status: 'error', installed: false, url: null, error: err.message, installHint: INSTALL_HINT };
    }
  }
}

function isRunning() {
  return state.status === 'running' && !!state.url;
}

function currentUrl() {
  return isRunning() ? state.url : null;
}

module.exports = {
  start,
  stop,
  rotate,
  status,
  resumeIfEnabled,
  isRunning,
  currentUrl,
  resolveBinary,
  INSTALL_HINT,
};
