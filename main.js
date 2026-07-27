'use strict';

const path = require('path');
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');

const bootstrap = require('./server/bootstrap');

/**
 * Electron shell. Its only jobs are to start the Express server, open a window
 * pointing at it, and shut down cleanly (which triggers the exit backup).
 */

let mainWindow = null;
let serverInfo = null;
let shuttingDown = false;

// A second copy would fight over the workbook files and the port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#f8fafc',
    title: 'School Admin Portal',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://localhost:${port}/`);

  // Nothing in this app should open an external browser window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://localhost:${port}`)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function buildMenu(info) {
  const template = [
    {
      label: 'Portal',
      submenu: [
        {
          label: 'Show staff address',
          click: () => {
            if (!mainWindow) return;
            mainWindow.webContents.executeJavaScript(
              "window.location.hash = '#/access'"
            );
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Connection details',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Connection details',
              message: 'Staff connect to this PC over the school network.',
              detail: [
                info.access.url ? `Address: ${info.access.url}` : 'No LAN address detected.',
                `By name: ${info.access.mdnsUrl}`,
                `Data folder: ${info.dataDir}`,
                '',
                'Open Settings → Access to show the QR code staff can scan.',
              ].join('\n'),
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    const { start } = require('./server');
    serverInfo = await start();
    buildMenu(serverInfo.info);
    createWindow(serverInfo.port);

    if (serverInfo.info.seededAdmin) {
      // Also shown in the console banner, but a dialogue is much harder to miss and
      // this password cannot be recovered later.
      dialog.showMessageBox({
        type: 'warning',
        title: 'Write this down',
        message: 'An administrator account has been created for this first run.',
        detail: [
          `Username: ${serverInfo.info.seededAdmin.username}`,
          `Password: ${serverInfo.info.seededAdmin.password}`,
          '',
          'This password is not stored anywhere and cannot be shown again.',
          'You will be asked to change it when you sign in.',
        ].join('\n'),
        buttons: ['I have written it down'],
      });
    }

    if (serverInfo.info.addressChanged) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'The address has changed',
        message: `This PC's address changed from ${serverInfo.info.previousIp} to ${serverInfo.info.access.ip}.`,
        detail:
          'Any printed QR code is now wrong. Open Settings → Access, print the new code, ' +
          'and ask whoever manages the router to add a DHCP reservation so this stops happening.',
        buttons: ['OK'],
      });
    }

    if (serverInfo.info.clockState.movedBackwards) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Check the server clock',
        message: serverInfo.info.clockState.message,
        buttons: ['OK'],
      });
    }
  } catch (err) {
    dialog.showErrorBox(
      'The portal could not start',
      `${err.message}\n\nIf this keeps happening, send this message to support.`
    );
    app.quit();
  }
});

/**
 * Quit is intercepted so the shutdown backup and the final workbook flush finish
 * before the process dies. Killing it mid-write is what corrupts Excel files.
 */
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;

  if (mainWindow) {
    mainWindow.setEnabled(false);
    mainWindow.webContents
      .executeJavaScript("document.title = 'Saving and backing up…'")
      .catch(() => {});
  }

  bootstrap
    .stop({ backupOnExit: true })
    .catch((err) => console.error(`[shutdown] ${err.message}`))
    .finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null && serverInfo) createWindow(serverInfo.port);
});
