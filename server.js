'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const bootstrap = require('./server/bootstrap');
const { apiRouter } = require('./server/routes');
const net = require('./server/services/net');

const PORT = Number(process.env.PORT || 4700);
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Express bound to 0.0.0.0:4700 so staff devices on the LAN can reach it.
 *
 * There is no CDN, no external font, no analytics and no runtime network call of
 * any kind — the school PC has no internet (CLAUDE.md tech stack).
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

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(PORT, HOST, () => resolve(listener));
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

  net.startMdns(PORT);
  printBanner(info);

  return { server, app, info, port: PORT };
}

function printBanner(info) {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  School Admin Portal is running');
  console.log(line);
  if (info.access.url) {
    console.log(`  Staff address     ${info.access.url}`);
    console.log(`  Or by name        ${info.access.mdnsUrl}`);
  } else {
    console.log('  No LAN address found — check the network cable or Wi-Fi.');
  }
  console.log(`  On this PC        ${info.access.localUrl}`);
  console.log(`  Data folder       ${info.dataDir}`);
  console.log(
    `  Server time       ${info.clockState.localDate} ${info.clockState.localTime} (${info.clockState.timezone})`
  );
  console.log(`  Licence           ${info.licenseState.status}${
    info.licenseState.daysLeft !== null ? `, ${info.licenseState.daysLeft} day(s) left` : ''
  }`);

  if (info.addressChanged) {
    console.log(`\n  ⚠  Address changed from ${info.previousIp} to ${info.access.ip}`);
    console.log('     Reprint the QR code for staff.');
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
