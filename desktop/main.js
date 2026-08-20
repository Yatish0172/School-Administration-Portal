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
const PACKAGED_POSTGRES_PORT = 55432;

let mainWindow = null;
let startupWindow = null;
let webProcess = null;
let ownsWebProcess = false;
let shuttingDown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const activeWindow = mainWindow || startupWindow;
    if (!activeWindow) return;
    if (activeWindow.isMinimized()) activeWindow.restore();
    activeWindow.show();
    activeWindow.focus();
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

function resolvePostgresBin() {
  const configured = process.env.SCHOOL_PORTAL_POSTGRES_BIN;
  if (configured && fs.existsSync(configured)) return configured;

  const portable = path.join(
    os.homedir(),
    '.local',
    'postgresql-18.4',
    'pgsql',
    'bin'
  );
  if (fs.existsSync(portable)) return portable;

  const systemInstall = 'C:\\Program Files\\PostgreSQL\\18\\bin';
  if (fs.existsSync(systemInstall)) return systemInstall;

  return portable;
}

function ensureDevelopmentPostgres() {

  const postgresBin = resolvePostgresBin();
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

function packagedPostgresBin() {
  return path.join(process.resourcesPath, 'postgresql', 'bin');
}

function packagedPostgresDataDir() {
  return path.join(app.getPath('userData'), 'postgres-data');
}

function ensurePackagedPostgres() {
  const postgresBin = packagedPostgresBin();
  const dataDirectory = packagedPostgresDataDir();
  const logFile = path.join(app.getPath('userData'), 'postgres.log');

  const initdbExe = path.join(postgresBin, 'initdb.exe');
  const pgCtlExe = path.join(postgresBin, 'pg_ctl.exe');
  const pgIsReadyExe = path.join(postgresBin, 'pg_isready.exe');
  const psqlExe = path.join(postgresBin, 'psql.exe');

  if (!fs.existsSync(initdbExe) || !fs.existsSync(pgCtlExe)) {
    throw new Error('The bundled PostgreSQL runtime is missing from this installation.');
  }

  const isFirstRun = !fs.existsSync(path.join(dataDirectory, 'PG_VERSION'));

  if (isFirstRun) {
    fs.mkdirSync(dataDirectory, { recursive: true });
    const init = spawnSync(
      initdbExe,
      ['-D', dataDirectory, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8'],
      { windowsHide: true, encoding: 'utf8' }
    );
    if (init.status !== 0) {
      throw new Error(
        `The local database could not be initialized.\n${init.stderr || init.stdout}`
      );
    }
    fs.appendFileSync(
      path.join(dataDirectory, 'postgresql.conf'),
      `\nport = ${PACKAGED_POSTGRES_PORT}\nlisten_addresses = '127.0.0.1'\n`
    );
  }

  const ready = spawnSync(
    pgIsReadyExe,
    ['-h', '127.0.0.1', '-p', String(PACKAGED_POSTGRES_PORT)],
    { windowsHide: true, encoding: 'utf8' }
  );
  if (ready.status !== 0) {
    const start = spawnSync(
      pgCtlExe,
      ['-D', dataDirectory, '-l', logFile, '-w', '-t', '30', 'start'],
      { windowsHide: true, encoding: 'utf8' }
    );
    if (start.status !== 0) {
      throw new Error(
        `The local database could not start.\n${start.stderr || start.stdout}`
      );
    }
  }

  const roleExists = spawnSync(
    psqlExe,
    [
      '-U', 'postgres',
      '-h', '127.0.0.1',
      '-p', String(PACKAGED_POSTGRES_PORT),
      '-tAc', "SELECT 1 FROM pg_roles WHERE rolname = 'school_portal';",
    ],
    { windowsHide: true, encoding: 'utf8' }
  );
  if (roleExists.status !== 0) {
    throw new Error(
      `The local database could not be reached.\n${roleExists.stderr || roleExists.stdout}`
    );
  }

  if (roleExists.stdout.trim() !== '1') {
    const createRole = spawnSync(
      psqlExe,
      [
        '-U', 'postgres',
        '-h', '127.0.0.1',
        '-p', String(PACKAGED_POSTGRES_PORT),
        '-c', 'CREATE ROLE school_portal LOGIN CREATEDB;',
      ],
      { windowsHide: true, encoding: 'utf8' }
    );
    if (createRole.status !== 0) {
      throw new Error(
        `The application database role could not be created.\n${createRole.stderr || createRole.stdout}`
      );
    }
  }

  return `Host=127.0.0.1;Port=${PACKAGED_POSTGRES_PORT};Database=school_portal;Username=school_portal`;
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

  const connectionString = app.isPackaged
    ? ensurePackagedPostgres()
    : (ensureDevelopmentPostgres(), null);
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
      ASPNETCORE_ENVIRONMENT: app.isPackaged ? 'Production' : 'Development',
      ...(app.isPackaged
        ? {
            ConnectionStrings__SchoolDb: connectionString,
            Trial__Enabled: 'true',
            Trial__DurationDays: '7',
          }
        : {
            Authentication__RequirePassword: 'false',
            Authentication__BypassLogin: 'true',
          }),
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

function createStartupWindow() {
  startupWindow = new BrowserWindow({
    width: 460,
    height: 280,
    frame: false,
    resizable: false,
    show: false,
    center: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const markup = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;',
    'background:linear-gradient(145deg,#0f172a,#1e3a5f);color:#f8fafc;font-family:"Segoe UI",sans-serif;',
    'text-align:center}main{padding:36px}h1{margin:0 0 10px;font-size:26px;font-weight:650}',
    'p{margin:0;color:#cbd5e1;font-size:14px}.loader{width:42px;height:42px;margin:28px auto 0;',
    'border:4px solid rgba(255,255,255,.2);border-top-color:#38bdf8;border-radius:50%;',
    'animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>',
    '</head><body><main><h1>School Administration Portal</h1>',
    '<p>Starting the local database and portal...</p>',
    '<div class="loader" aria-label="Starting"></div></main></body></html>',
  ].join('');

  startupWindow.once('ready-to-show', () => startupWindow?.show());
  startupWindow.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(markup)
  );
  startupWindow.on('closed', () => {
    startupWindow = null;
  });
}

function closeStartupWindow() {
  if (!startupWindow || startupWindow.isDestroyed()) return;
  startupWindow.close();
}

function windowIcon() {
  const packaged = path.join(
    process.resourcesPath,
    'web',
    'wwwroot',
    'favicon.ico'
  );
  const development = path.join(
    repositoryRoot(),
    'src',
    'SchoolPortal.Web',
    'wwwroot',
    'favicon.ico'
  );
  const icon = app.isPackaged ? packaged : development;
  return fs.existsSync(icon) ? icon : undefined;
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
    icon: windowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    closeStartupWindow();
    mainWindow.show();
  });
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
  createStartupWindow();

  try {
    await startBackend();
    configureMenu();
    createWindow();
  } catch (error) {
    closeStartupWindow();
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
