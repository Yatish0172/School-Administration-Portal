'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { app, BrowserWindow, dialog, Menu, shell } = require('electron');

const PORT = Number(process.env.SCHOOL_PORTAL_PORT || 5100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const READY_URL = `${BASE_URL}/health/ready`;

let mainWindow = null;
let webProcess = null;
let ownsWebProcess = false;
let shuttingDown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function requestStatus(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode || 0);
    });

    request.on('timeout', () => {
      request.destroy();
      resolve(0);
    });
    request.on('error', () => resolve(0));
  });
}

async function waitForReady(timeoutMs = 45000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (webProcess && webProcess.exitCode !== null) {
      throw new Error(
        `The portal backend exited with code ${webProcess.exitCode}.`
      );
    }

    if ((await requestStatus(READY_URL)) === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    'The portal backend did not become ready within 45 seconds.'
  );
}

function repositoryRoot() {
  return path.resolve(__dirname, '..');
}

function resolveDotnet() {
  const configured = process.env.SCHOOL_PORTAL_DOTNET;
  if (configured && fs.existsSync(configured)) return configured;

  const userLocal = path.join(os.homedir(), '.dotnet', 'dotnet.exe');
  if (fs.existsSync(userLocal)) return userLocal;

  return 'dotnet';
}

function resolveDotnetRoot() {
  const executable = resolveDotnet();
  return path.isAbsolute(executable)
    ? path.dirname(executable)
    : process.env.DOTNET_ROOT;
}

function ensureDevelopmentPostgres() {

  const postgresRoot = path.join(
    os.homedir(),
    '.local',
    'postgresql-18.4',
    'pgsql'
  );
  const postgresBin = path.join(postgresRoot, 'bin');
  const dataDirectory = path.join(
    os.homedir(),
    '.local',
    'school-portal-postgres',
    'data'
  );
  const logFile = path.join(
    os.homedir(),
    '.local',
    'school-portal-postgres',
    'postgresql.log'
  );
  const readyExecutable = path.join(postgresBin, 'pg_isready.exe');
  const controlExecutable = path.join(postgresBin, 'pg_ctl.exe');

  if (!fs.existsSync(readyExecutable) || !fs.existsSync(controlExecutable)) {
    throw new Error(
      'The local PostgreSQL development installation was not found.'
    );
  }

  const ready = spawnSync(
    readyExecutable,
    ['-h', '127.0.0.1', '-p', '5433', '-d', 'school_portal'],
    { windowsHide: true, encoding: 'utf8' }
  );
  if (ready.status === 0) return;

  const start = spawnSync(
    controlExecutable,
    ['-D', dataDirectory, '-l', logFile, '-w', '-t', '30', 'start'],
    { windowsHide: true, encoding: 'utf8' }
  );
  if (start.status !== 0) {
    throw new Error(
      `PostgreSQL could not start.\n${start.stderr || start.stdout}`
    );
  }
}

function buildDevelopmentBackend() {
  if (app.isPackaged) return;

  const result = spawnSync(
    resolveDotnet(),
    ['build', 'SchoolPortal.sln', '--configuration', 'Debug'],
    {
      cwd: repositoryRoot(),
      windowsHide: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        DOTNET_NOLOGO: '1',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      },
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `The portal backend could not be built.\n${result.stderr || result.stdout}`
    );
  }
}

function backendExecutable() {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'web',
      'SchoolPortal.Web.exe'
    );
  }

  return path.join(
    repositoryRoot(),
    'src',
    'SchoolPortal.Web',
    'bin',
    'Debug',
    'net10.0',
    'SchoolPortal.Web.exe'
  );
}

async function startBackend() {
  if ((await requestStatus(READY_URL)) === 200) return;

  ensureDevelopmentPostgres();
  buildDevelopmentBackend();

  const executable = backendExecutable();
  if (!fs.existsSync(executable)) {
    throw new Error(`The portal backend is missing: ${executable}`);
  }

  webProcess = spawn(executable, [`--urls=${BASE_URL}`], {
    cwd: path.dirname(executable),
    windowsHide: true,
    env: {
      ...process.env,
      ASPNETCORE_ENVIRONMENT: 'Development',
      Authentication__RequirePassword: 'false',
      Authentication__BypassLogin: 'true',
      ...(resolveDotnetRoot()
        ? { DOTNET_ROOT: resolveDotnetRoot() }
        : {}),
      DOTNET_NOLOGO: '1',
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    },
  });
  ownsWebProcess = true;

  webProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[web] ${chunk}`);
  });
  webProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[web] ${chunk}`);
  });

  await waitForReady();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#ffffff',
    title: 'School Administration Portal',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(BASE_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE_URL)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(BASE_URL)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function configureMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Portal',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
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
          { role: 'togglefullscreen' },
          { type: 'separator' },
          { role: 'toggleDevTools' },
        ],
      },
    ])
  );
}

function stopOwnedBackend() {
  if (!ownsWebProcess || !webProcess || webProcess.killed) return;
  webProcess.kill();
}

app.whenReady().then(async () => {
  try {
    await startBackend();
    configureMenu();
    createWindow();
  } catch (error) {
    dialog.showErrorBox(
      'The new portal could not start',
      `${error.message}\n\nThe legacy portal has not been changed.`
    );
    app.quit();
  }
});

app.on('before-quit', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopOwnedBackend();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
