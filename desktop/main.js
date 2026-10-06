/**
 * Memes Arcade - Electron shell for both desktop downloads.
 *
 *   LITE  the website in a window. Small download; needs the site reachable.
 *   HOST  the same window *plus* a bundled game server it can start itself, so
 *         games, matches and music work with no internet at all.
 *
 * The renderer never gets Node access: everything goes through the tiny
 * `window.arcade` bridge in preload.js.
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const IS_LITE = !fs.existsSync(path.join(__dirname, '..', 'server', 'index.js'));
const APP_NAME = IS_LITE ? 'Memes Arcade Desktop Lite' : 'Memes Arcade Desktop';

/* ------------------------------------------------------------------ *
 * settings (stored next to the user's app data, never in the install)
 * ------------------------------------------------------------------ */

const settingsFile = path.join(app.getPath('userData'), 'desktop-settings.json');

const defaults = {
  mode: IS_LITE ? 'lite' : 'auto', // auto | lite | host
  server: '', // remote arcade URL used in lite/auto mode
  localPort: 8787,
};

function loadSettings() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {}
  try {
    const baked = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
    file = { ...baked, ...file };
  } catch {}
  return { ...defaults, ...file };
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('could not save settings:', err.message);
  }
}

let settings = { ...defaults };

/* ------------------------------------------------------------------ *
 * local server (host mode only)
 * ------------------------------------------------------------------ */

let serverProcess = null;
let localUrl = '';

function startLocalServer() {
  if (IS_LITE) return { ok: false, error: 'This is the Lite download - it has no bundled server. Get "Desktop Host" to run games offline.' };
  if (serverProcess) return { ok: true, url: localUrl, already: true };

  const entry = path.join(__dirname, '..', 'server', 'index.js');
  const port = Number(settings.localPort) || 8787;
  const env = {
    ...process.env,
    MEMES_PORT: String(port),
    MEMES_HOST: '127.0.0.1',
    // Keep saves in the user profile so updating the app never wipes accounts.
    MEMES_DATA: path.join(app.getPath('userData'), 'data'),
    MEMES_PLATFORM: 'desktop',
    ELECTRON_RUN_AS_NODE: '1',
  };

  serverProcess = spawn(process.execPath, [entry], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  localUrl = `http://127.0.0.1:${port}`;
  serverProcess.stdout?.on('data', (buf) => process.stdout.write(`[server] ${buf}`));
  serverProcess.stderr?.on('data', (buf) => process.stderr.write(`[server] ${buf}`));
  serverProcess.on('exit', (code) => {
    console.log(`[server] exited with code ${code}`);
    serverProcess = null;
    mainWindow?.webContents.send('arcade:server-stopped', code);
  });
  return { ok: true, url: localUrl, started: true };
}

function stopLocalServer() {
  if (!serverProcess) return { ok: true };
  try {
    serverProcess.kill();
  } catch {}
  serverProcess = null;
  return { ok: true };
}

/** Poll until the freshly started server answers, so we never load a dead page. */
async function waitForServer(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * window
 * ------------------------------------------------------------------ */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#141021',
    autoHideMenuBar: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the real browser; the arcade stays in the window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  loadLauncher();
}

function loadLauncher() {
  mainWindow.loadFile(path.join(__dirname, 'launcher.html'));
}

async function connectTo(url) {
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'That does not look like a web address.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, error: 'Only http:// and https:// addresses work.' };

  settings.server = parsed.origin;
  saveSettings();
  mainWindow?.webContents.send('arcade:status', `Connecting to ${parsed.origin}…`);
  const alive = await waitForServer(parsed.origin, 8000);
  if (!alive) {
    // Still navigate - a slow host, a login page or a captive portal may work
    // even though /api/health did not answer.
    mainWindow?.webContents.send('arcade:status', `No health check from ${parsed.origin} - loading anyway.`);
  }
  await mainWindow?.loadURL(parsed.origin + '/');
  buildMenu();
  return { ok: true, url: parsed.origin };
}

async function startHostMode() {
  const res = startLocalServer();
  if (!res.ok) return res;
  mainWindow?.webContents.send('arcade:status', 'Starting the local arcade…');
  const alive = await waitForServer(res.url);
  if (!alive) return { ok: false, error: 'The local server did not come up. Check that Node.js 18+ is installed and port ' + settings.localPort + ' is free.' };
  settings.mode = 'host';
  saveSettings();
  await mainWindow?.loadURL(`${res.url}/`);
  buildMenu();
  return { ok: true, url: res.url };
}

/* ------------------------------------------------------------------ *
 * menu - the whole app is drivable from here
 * ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    {
      label: 'Server',
      submenu: [
        { label: 'Connect to a website…', click: () => showLauncher() },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { type: 'separator' },
        {
          label: 'Start local server (host mode)',
          enabled: !IS_LITE,
          click: async () => {
            const res = await startHostMode();
            if (!res.ok) dialog.showErrorBox('Could not start the server', res.error);
          },
        },
        { label: 'Stop local server', enabled: !IS_LITE, click: () => stopLocalServer() },
        { type: 'separator' },
        { label: 'Copy invite link', click: () => mainWindow?.webContents.executeJavaScript('location.href').then((url) => require('electron').clipboard.writeText(url)) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Which mode am I in?', click: () => dialog.showMessageBox({ message: IS_LITE ? 'Desktop Lite' : 'Desktop Host', detail: modeDescription(), buttons: ['OK'] }) },
        { label: 'Open the folder with my saves', click: () => shell.openPath(app.getPath('userData')) },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function modeDescription() {
  const parts = [`Settings file: ${settingsFile}`, `Server: ${settings.server || '(not chosen yet)'}`];
  if (!IS_LITE) parts.push(`Local server: ${serverProcess ? `running at ${localUrl}` : 'not running'}`, `Saves: ${path.join(app.getPath('userData'), 'data')}`);
  else parts.push('This download has no bundled server - use Desktop Host for offline play.');
  return parts.join('\n');
}

function showLauncher() {
  loadLauncher();
}

/* ------------------------------------------------------------------ *
 * renderer bridge
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('arcade:info', () => ({
    app: APP_NAME,
    lite: IS_LITE,
    version: app.getVersion(),
    settings,
    serverRunning: !!serverProcess,
    localUrl: serverProcess ? localUrl : '',
    defaultServer: settings.server,
    mode: serverProcess ? 'host' : settings.mode,
  }));

  ipcMain.handle('arcade:connect', (_ev, url) => connectTo(String(url || settings.server || '')));
  ipcMain.handle('arcade:start-host', () => startHostMode());
  ipcMain.handle('arcade:stop-host', () => stopLocalServer());
  ipcMain.handle('arcade:save-settings', (_ev, patch) => {
    settings = { ...settings, ...(patch || {}) };
    saveSettings();
    return { ok: true, settings };
  });
  ipcMain.handle('arcade:open-external', (_ev, url) => {
    if (/^https?:/i.test(String(url))) shell.openExternal(String(url));
    return { ok: true };
  });
  ipcMain.handle('arcade:open-folder', () => {
    shell.openPath(app.getPath('userData'));
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

// One arcade window per machine: a second launch focuses the first.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    settings = loadSettings();
    registerIpc();
    createWindow();
    buildMenu();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    stopLocalServer();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => stopLocalServer());
}
