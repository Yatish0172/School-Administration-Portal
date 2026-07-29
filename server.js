'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const bootstrap = require('./server/bootstrap');
const { apiRouter } = require('./server/routes');
const net = require('./server/services/net');

const PORT = Number(process.env.PORT || 4700);

/**
 * Two ways in, in order of how staff are expected to use them:
 *
 *  1. The Cloudflare link, opened on startup. This is the primary route and works
 *     from anywhere.
 *  2. The school Wi-Fi, on by default because it is the only route that survives an
 *     internet outage. Turning `network.lanEnabled` off binds to this PC alone.
 *
 * The app itself still makes no outbound calls of its own — no CDN, no fonts, no
 * analytics. `cloudflared` is a separate process the school installs, and it is the
 * only thing that talks to the internet.
 */
function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // inline styles are used for print layouts
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          baseUri: ["'self'"],
        },
      },
      // The LAN runs plain HTTP, so HSTS would lock the school out of their own server.
      hsts: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  app.use('/api', apiRouter());

  // Static front end. Database/ is never served from here — documents go through
  // an authorising route only.
  //
  // Code is served with revalidation rather than a long cache: an upgrade replaces
  // the .exe wholesale, and a browser holding yesterday's JS against today's API is
  // a confusing failure to diagnose. ETags keep it cheap — a revalidation of
  // unchanged files is a 304, not a re-download. Fonts never change, so they cache.
  const root = __dirname;
  const codeOptions = { maxAge: 0, etag: true, index: false, dotfiles: 'deny' };
  app.use('/css', express.static(path.join(root, 'css'), codeOptions));
  app.use('/js', express.static(path.join(root, 'js'), codeOptions));
  app.use('/assets', express.static(path.join(root, 'assets'), codeOptions));
  app.use('/fonts', express.static(path.join(root, 'fonts'), { maxAge: '30d', dotfiles: 'deny' }));

  // A missing asset must 404, not fall through to the SPA shell. Otherwise the
  // browser receives HTML where it expected a font and reports a decode error,
  // which sends whoever is debugging in entirely the wrong direction.
  const ASSET_PREFIXES = ['/css/', '/js/', '/fonts/', '/assets/'];
  app.use((req, res, next) => {
    if (!ASSET_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();
    return res.status(404).type('text/plain').send('Not found');
  });

  // Single-page app: every other GET returns the shell and the client router decides.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(root, 'index.html'));
  });

  return app;
}

async function start() {
  const app = createApp();
  const info = await bootstrap.start({ port: PORT });

  // With the Wi-Fi route switched off, bind to loopback only. `cloudflared` runs on
  // this PC and reaches it there, so the Cloudflare link keeps working while nothing
  // on the school network can connect directly.
  const host = process.env.HOST || (info.lanEnabled ? '0.0.0.0' : '127.0.0.1');

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(PORT, host, () => resolve(listener));
    listener.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${PORT} is already in use. Another copy of the portal may already be running — ` +
              'check the system tray before starting a second one.'
          )
        );
      } else {
        reject(err);
      }
    });
  });

  if (info.lanEnabled) net.startMdns(PORT);

  // Only now that the port answers is it worth pointing a tunnel at it.
  info.tunnelState = await bootstrap.startRemote();

  printBanner(info);

  return { server, app, info, port: PORT, host };
}

function printBanner(info) {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  School Admin Portal is running');
  console.log(line);
  // The Cloudflare link goes first: it is what staff are given.
  const remote = info.tunnelState;
  if (remote && remote.url) {
    console.log(`  STAFF LINK        ${remote.url}`);
    if (remote.confirmed) {
      console.log('                    Send this to staff. It changes on every restart.');
    } else {
      console.log('                    Issued, but Cloudflare is not serving it yet.');
      console.log('                    Check Settings → Access before sending it out.');
    }
  } else {
    console.log('  STAFF LINK        not available yet');
  }

  console.log('');
  if (info.lanEnabled) {
    if (info.access.url) {
      console.log(`  On school Wi-Fi   ${info.access.url}`);
      console.log(`  Or by name        ${info.access.mdnsUrl}`);
    } else {
      console.log('  On school Wi-Fi   no address found — check the network cable or Wi-Fi.');
    }
  } else {
    console.log('  On school Wi-Fi   switched off — the staff link is the only way in.');
  }
  console.log(`  On this PC        ${info.access.localUrl}`);
  console.log(`  Data folder       ${info.dataDir}`);
  console.log(
    `  Server time       ${info.clockState.localDate} ${info.clockState.localTime} (${info.clockState.timezone})`
  );
  console.log(`  Licence           ${info.licenseState.status}${
    info.licenseState.daysLeft !== null ? `, ${info.licenseState.daysLeft} day(s) left` : ''
  }`);

  // The staff link is the primary route, so say clearly why it is missing and what
  // to do about it. The portal is still usable on the Wi-Fi in the meantime.
  if (remote && remote.url && !remote.confirmed) {
    console.log(`\n  ⚠  The staff link has not answered from outside yet.`);
    console.log('     Usually it starts working within a minute or two on its own.');
  }

  if (!remote || !remote.url) {
    console.log(`\n${line}`);
    if (remote && remote.installed === false) {
      console.log('  ⚠  Remote access needs cloudflared, which is not installed');
      for (const hint of remote.installHint || []) console.log(`     ${hint}`);
    } else if (remote && remote.error) {
      console.log(`  ⚠  Remote access could not start: ${remote.error}`);
      console.log('     Check this PC has internet, then reopen it from Settings → Access.');
    } else {
      console.log('  ⚠  Remote access is switched off');
      console.log('     Turn it on in Settings → Access to get a staff link.');
    }
    console.log(
      info.lanEnabled
        ? '     Staff on the school Wi-Fi can use the address above in the meantime.'
        : '     Nobody can reach the portal until this is fixed, because the Wi-Fi route is off.'
    );
  }

  if (info.addressChanged && info.lanEnabled) {
    console.log(`\n  ⚠  Wi-Fi address changed from ${info.previousIp} to ${info.access.ip}`);
    console.log('     Reprint the QR code for staff who use the Wi-Fi route.');
  }
  if (info.clockState.movedBackwards) {
    console.log(`\n  ⚠  ${info.clockState.message}`);
  }
  if (info.backupState.message) {
    console.log(`\n  ⚠  Backup: ${info.backupState.message}`);
  }
  if (info.pendingJournalSnapshots.length) {
    console.log(
      `\n  ⚠  ${info.pendingJournalSnapshots.length} unfinished write snapshot(s) in Database/journal/.`
    );
    console.log('     The last shutdown may not have been clean. Check the data, then delete them.');
  }
  if (info.seededAdmin) {
    console.log(`\n${line}`);
    console.log('  FIRST RUN — administrator account created');
    console.log(line);
    console.log(`  Username          ${info.seededAdmin.username}`);
    console.log(`  Password          ${info.seededAdmin.password}`);
    console.log('\n  Write this down now. It is not stored anywhere and will not be shown again.');
    console.log('  You will be asked to change it at first sign-in.');
  }
  console.log(`${line}\n`);
}

if (require.main === module) {
  start().catch((err) => {
    console.error(`\nThe portal could not start: ${err.message}\n`);
    process.exit(1);
  });

  const shutdown = async (signal) => {
    console.log(`\nShutting down (${signal})…`);
    await bootstrap.stop({ backupOnExit: true });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createApp, start, PORT };
