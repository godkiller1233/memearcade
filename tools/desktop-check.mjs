#!/usr/bin/env node
/**
 * Electron desktop main-process check.
 *
 *   npm run desktopcheck
 *
 * The desktop shell (desktop/main.js) is the one part of the project nothing
 * else exercises: it only runs inside Electron, and Electron is a devDependency
 * that a zero-dependency checkout deliberately never installs.  So this suite
 * loads main.js in plain Node with a stub `electron` module injected through
 * the CommonJS loader, then drives the contract the shell is built on:
 *
 *   - the single-instance lock (a second launch quits, no window, no bridge)
 *   - the window it opens: isolated renderer, preload only, external links
 *     pushed to the real browser and denied in-window
 *   - every ipc channel the renderer bridge calls, and how each behaves -
 *     including that the URL guards actually refuse bad addresses
 *   - host mode for real: it starts the bundled server on a free port, the
 *     window navigates to it, /api/health answers, and stopping frees the port
 *   - the application menu (Server / View / Help) and its actions
 *   - the Lite flavour, loaded from a copy with no bundled server next to it
 *   - preload.js: the exact bridge surface, and that every channel it invokes
 *     is one main.js registered, and every event it listens for is one main.js
 *     sends (a rename on either side fails here instead of at the user)
 *
 * Nothing here needs a display, Electron, or the network: host mode boots the
 * project's own server on 127.0.0.1, and the stub writes into a temp profile
 * so no real user data is touched.  Only http:// scratch servers are started.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickFreePort, portFree } from './lib/free-port.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const PRELOAD = path.join(DESKTOP, 'preload.js');
const SERVER_BUNDLE = path.join(ROOT, 'server', 'index.js');
const IS_HOST = fs.existsSync(SERVER_BUNDLE);

/** A scratch port range of its own; the other suites use 8791-8910. */
const PORT_RANGE = { start: 8911, span: 20 };

let failures = 0;
let passed = 0;
const check = (ok, label, detail = '') => {
  if (ok) passed++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const note = (text) => console.log(`  note  ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
async function waitFor(fn, timeoutMs = 6000, every = 150) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return true;
    await sleep(every);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * electron loader stub
 *
 * `electron` is a devDependency this checkout never installs, so we hand
 * main.js a stand-in through the CommonJS loader instead.  It records what the
 * process asks of Electron; the checks below read that record.
 * ------------------------------------------------------------------ */

let stub = null;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron' && stub) return stub;
  return originalLoad.call(this, request, parent, isMain);
};

/**
 * Build a fake `electron` module.  `state` carries per-run knobs (userData
 * path, version, singleInstance, and the URL executeJavaScript should return).
 */
function makeElectron(state = {}) {
  const windows = [];
  const events = new Map();
  const ipc = new Map();
  const menu = { template: null, installs: 0 };
  const log = { openExternal: [], openPath: [], clipboard: [], errors: [], messages: [], reloads: 0, locks: 0, quits: 0 };

  class FakeWindow {
    constructor(options = {}) {
      this.options = options;
      this.handlers = {};
      this.focused = false;
      this.minimized = false;
      this.restored = false;
      this.webContents = {
        sent: [],
        loaded: [],
        openHandler: null,
        send: (channel, ...rest) => { this.webContents.sent.push([channel, ...rest]); },
        reload: () => { log.reloads += 1; },
        setWindowOpenHandler: (fn) => { this.webContents.openHandler = fn; },
        executeJavaScript: () => Promise.resolve(state.location || 'https://arcade.test/'),
        loadURL: (url) => { this.webContents.loaded.push(url); return Promise.resolve(); },
      };
      windows.push(this);
    }
    on(event, fn) { this.handlers[event] = fn; }
    loadFile(file) { this.webContents.loaded.push(file); }
    loadURL(url) { this.webContents.loaded.push(url); return Promise.resolve(); }
    isMinimized() { return this.minimized; }
    restore() { this.restored = true; }
    focus() { this.focused = true; }
    static getAllWindows() { return windows; }
  }

  return {
    state,
    windows,
    events,
    ipc,
    menu,
    log,
    electron: {
      app: {
        getPath: (name) => (name === 'userData' ? state.userData : path.join(String(state.userData), name)),
        getVersion: () => state.version || '1.0.0',
        requestSingleInstanceLock: () => { log.locks += 1; return state.singleInstance !== false; },
        whenReady: () => Promise.resolve(),
        on: (event, fn) => { if (!events.has(event)) events.set(event, []); events.get(event).push(fn); },
        quit: () => { log.quits += 1; },
      },
      BrowserWindow: FakeWindow,
      Menu: {
        buildFromTemplate: (template) => { menu.template = template; return { template }; },
        setApplicationMenu: () => { menu.installs += 1; },
      },
      dialog: {
        showErrorBox: (title, content) => log.errors.push([title, content]),
        showMessageBox: (options) => log.messages.push(options),
      },
      ipcMain: { handle: (channel, fn) => ipc.set(channel, fn) },
      shell: {
        openExternal: (url) => { log.openExternal.push(url); return Promise.resolve(); },
        openPath: (target) => { log.openPath.push(target); return Promise.resolve(''); },
      },
      clipboard: { writeText: (text) => log.clipboard.push(text) },
    },
  };
}

/** Load a CommonJS file of ours with `electron` stubbed.  Cached loads are reset. */
function loadWith(electron, file) {
  stub = electron;
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  require(file);
}

/** A stub for preload.js: captures the bridge object and the calls it makes. */
function makePreload() {
  const exposed = {};
  const invoked = [];
  const subscribed = [];
  return {
    exposed,
    invoked,
    subscribed,
    electron: {
      contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
      ipcRenderer: {
        invoke: (channel, ...rest) => { invoked.push(channel); return Promise.resolve({ channel, rest }); },
        on: (channel) => { subscribed.push(channel); },
      },
    },
  };
}

function fire(run, event, ...args) {
  const fns = run.events.get(event) || [];
  for (const fn of fns) fn(...args);
}

/* ------------------------------------------------------------------ *
 * cleanup safety net
 * ------------------------------------------------------------------ */

const tempDirs = [];
const mkTemp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

/** Last resort on Windows: kill whatever still holds a port we started. */
function killByPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const row = out.split(/\r?\n/).find((l) => l.includes(`:${port} `) && /LISTENING/i.test(l));
    const pid = row?.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid)) execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

const CHANNELS = [
  'arcade:info', 'arcade:connect', 'arcade:start-host', 'arcade:stop-host',
  'arcade:save-settings', 'arcade:open-external', 'arcade:open-folder',
];
const BRIDGE_ACTIONS = [
  'connect', 'info', 'onServerStopped', 'onStatus', 'openExternal',
  'openFolder', 'saveSettings', 'startHost', 'stopHost',
];

let hostPort = 0;
let hostRun = null;

async function checkHostFlavour() {
  console.log('\n[1/5] the Host flavour loads and wires itself up');
  const state = { userData: mkTemp('memes-desktop-'), location: 'https://arcade.test/room/ABCD' };
  const run = makeElectron(state);
  hostRun = run;

  let error = null;
  try { loadWith(run.electron, path.join(DESKTOP, 'main.js')); } catch (err) { error = err; }
  if (!check(!error, 'the main process loads with a stubbed electron', error?.message)) return;
  await tick();

  check(run.log.locks === 1, 'it takes the single-instance lock');
  check(run.log.quits === 0, 'the first instance keeps running');
  check(run.windows.length === 1, 'it opens exactly one window once the app is ready', `${run.windows.length} window(s)`);
  const win = run.windows[0];
  if (!check(!!win, 'the window exists')) return;

  check(/launcher\.html$/.test(win.webContents.loaded[0] || ''), 'the window opens on the bundled launcher page', win.webContents.loaded[0]);
  check(win.options.width === 1280 && win.options.height === 840 && win.options.minWidth === 900, 'the window opens at a sane, resizable size');
  const wp = win.options.webPreferences || {};
  check(wp.contextIsolation === true && wp.nodeIntegration === false && /preload\.js$/.test(wp.preload || ''),
    'the renderer has no Node access (isolated, preload bridge only)', JSON.stringify({ contextIsolation: wp.contextIsolation, nodeIntegration: wp.nodeIntegration }));
  check(win.options.title === (IS_HOST ? 'Memes Arcade Desktop' : 'Memes Arcade Desktop Lite'), 'the window is titled for this flavour', win.options.title);

  console.log('\n[2/5] external navigation and the renderer bridge');
  const openHandler = win.webContents.openHandler;
  if (check(typeof openHandler === 'function', 'external navigation is intercepted')) {
    const https = openHandler({ url: 'https://example.com/invite' });
    check(https?.action === 'deny' && run.log.openExternal.at(-1) === 'https://example.com/invite',
      'an https link opens in the real browser and is denied in-window');
    const before = run.log.openExternal.length;
    const file = openHandler({ url: 'file:///etc/passwd' });
    check(file?.action === 'deny' && run.log.openExternal.length === before,
      'a non-http link is denied and never handed to the OS');
  }

  check(CHANNELS.every((c) => run.ipc.has(c)) && run.ipc.size === CHANNELS.length,
    'it registers exactly the seven renderer channels', [...run.ipc.keys()].join(', '));

  const info = await run.ipc.get('arcade:info')();
  check(info?.app === (IS_HOST ? 'Memes Arcade Desktop' : 'Memes Arcade Desktop Lite') && info?.lite !== IS_HOST,
    'info reports the running flavour', JSON.stringify({ app: info?.app, lite: info?.lite }));
  check(info?.version === '1.0.0' && info?.serverRunning === false && info?.mode === (IS_HOST ? 'auto' : 'lite'),
    'info reports the version, no server, and the start-up mode', JSON.stringify({ version: info?.version, mode: info?.mode }));

  const garbage = await run.ipc.get('arcade:connect')(null, 'not a web address');
  check(garbage?.ok === false && /web address/i.test(garbage.error || ''),
    'an address that is not a URL is refused with a readable message', garbage?.error);

  const externalBefore = run.log.openExternal.length;
  await run.ipc.get('arcade:open-external')(null, 'javascript:alert(1)');
  check(run.log.openExternal.length === externalBefore, 'the bridge refuses to open a non-http address');
  await run.ipc.get('arcade:open-external')(null, 'https://arcade.test/help');
  check(run.log.openExternal.at(-1) === 'https://arcade.test/help', 'the bridge opens an https address in the real browser');

  await run.ipc.get('arcade:open-folder')();
  check(run.log.openPath.at(-1) === state.userData, 'the bridge opens the user data folder', String(run.log.openPath.at(-1)));

  console.log('\n[3/5] host mode boots the bundled server for real');
  const settingsFile = path.join(state.userData, 'desktop-settings.json');
  if (IS_HOST) {
    hostPort = await pickFreePort(PORT_RANGE);
    const saved = await run.ipc.get('arcade:save-settings')(null, { localPort: hostPort });
    check(saved?.ok === true && saved.settings.localPort === hostPort, 'settings patches are merged and returned', `localPort ${saved?.settings?.localPort}`);
    let onDisk = null;
    try { onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
    check(onDisk?.localPort === hostPort, 'settings are written to the user profile', settingsFile);

    const started = await run.ipc.get('arcade:start-host')();
    if (check(started?.ok === true && started.url === `http://127.0.0.1:${hostPort}`, 'host mode starts the bundled arcade', JSON.stringify(started))) {
      const health = await fetch(`${started.url}/api/health`).then((r) => r.json()).catch(() => null);
      check(health?.ok === true, 'the spawned arcade answers /api/health', health ? `${health.engines} engines` : 'unreachable');
      check(win.webContents.loaded.at(-1) === `${started.url}/`, 'the window navigates to the local arcade', win.webContents.loaded.at(-1));
      const hostInfo = await run.ipc.get('arcade:info')();
      check(hostInfo?.serverRunning === true && hostInfo?.mode === 'host' && hostInfo?.localUrl === started.url,
        'info switches to host mode with the local URL', JSON.stringify({ serverRunning: hostInfo?.serverRunning, mode: hostInfo?.mode }));

      const bare = await run.ipc.get('arcade:connect')(null, `127.0.0.1:${hostPort}`);
      check(bare?.ok === true && bare.url === `http://127.0.0.1:${hostPort}`, 'a bare host:port is normalized to http://', JSON.stringify(bare));
      const conn = await run.ipc.get('arcade:connect')(null, started.url);
      check(conn?.ok === true && conn.url === started.url, 'connect accepts the live arcade address', JSON.stringify(conn));
      check(win.webContents.loaded.at(-1) === `${started.url}/`, 'connect navigates the window to it');
      try { onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
      check(onDisk?.server === started.url, 'connect remembers the server for the next launch');

      const stopped = await run.ipc.get('arcade:stop-host')();
      check(stopped?.ok === true, 'stop-host reports ok');
      check(await waitFor(() => portFree(hostPort)), 'stopping the host frees its port');
    }
  } else {
    note('no bundled server here, so the host-mode checks are skipped');
  }

  console.log('\n[4/5] the application menu');
  const labels = (run.menu.template || []).map((m) => m.label);
  check(JSON.stringify(labels) === JSON.stringify(['Server', 'View', 'Help']), 'the menu has the three expected top-level menus', labels.join(' / '));
  const serverMenu = run.menu.template?.find((m) => m.label === 'Server')?.submenu || [];
  const viewMenu = run.menu.template?.find((m) => m.label === 'View')?.submenu || [];
  const helpMenu = run.menu.template?.find((m) => m.label === 'Help')?.submenu || [];
  check(!!serverMenu.find((i) => i.label === 'Start local server (host mode)'), 'the Server menu offers host mode');
  check(serverMenu.find((i) => i.label === 'Start local server (host mode)')?.enabled === IS_HOST,
    IS_HOST ? 'the Host build enables the local-server entry' : 'the Lite build disables the local-server entry');
  check(serverMenu.find((i) => i.label === 'Stop local server')?.enabled === IS_HOST, 'the stop entry follows the same rule');
  check(viewMenu.some((i) => i.role === 'zoomIn') && viewMenu.some((i) => i.role === 'toggleDevTools'), 'the View menu carries the zoom and devtools roles');

  const copyEntry = serverMenu.find((i) => i.label === 'Copy invite link');
  if (check(!!copyEntry, 'the Server menu offers a copy-invite-link action')) {
    await copyEntry.click();
    await waitFor(() => run.log.clipboard.length > 0, 1500);
    check(run.log.clipboard.at(-1) === state.location, 'copy invite link puts the current page in the clipboard', String(run.log.clipboard.at(-1)));
  }
  const reloadEntry = serverMenu.find((i) => i.label === 'Reload');
  if (check(!!reloadEntry, 'the Server menu offers a reload action')) {
    reloadEntry.click();
    check(run.log.reloads === 1, 'reload asks the window to reload');
  }
  const modeEntry = helpMenu.find((i) => i.label === 'Which mode am I in?');
  if (check(!!modeEntry, 'the Help menu explains the running mode')) {
    modeEntry.click();
    check(/Desktop (Host|Lite)/.test(run.log.messages.at(-1)?.message || ''), 'the mode dialog names the flavour', run.log.messages.at(-1)?.message);
  }
  const folderEntry = helpMenu.find((i) => i.label === 'Open the folder with my saves');
  if (check(!!folderEntry, 'the Help menu can open the saves folder')) {
    folderEntry.click();
    check(run.log.openPath.at(-1) === state.userData, 'the saves-folder action opens the user profile');
  }
  check(helpMenu.some((i) => i.label === 'Version 1.0.0' && i.enabled === false), 'the Help menu shows a disabled version entry', helpMenu.map((i) => i.label).join(', '));

  console.log('\n[5/5] lifecycle, the second instance, the Lite flavour, and preload');
  win.minimized = true;
  fire(run, 'second-instance');
  check(win.focused === true && win.restored === true, 'a second launch focuses and restores the first window');

  if (IS_HOST && hostPort) {
    const again = await run.ipc.get('arcade:start-host')();
    check(again?.ok === true, 'host mode can start again after a stop');
    fire(run, 'window-all-closed');
    await sleep(200);
    check(await waitFor(() => portFree(hostPort)), 'closing the last window stops the bundled server');
    if (process.platform !== 'darwin') check(run.log.quits >= 1, 'closing the last window quits the app');
    else note('macOS keeps the app alive after the last window closes');
  }

  fire(run, 'before-quit');
  check(true, 'the before-quit hook runs without throwing');

  // A second instance must do nothing but quit.
  const secondState = { userData: mkTemp('memes-desktop-2nd-'), singleInstance: false };
  const second = makeElectron(secondState);
  let secondError = null;
  try { loadWith(second.electron, path.join(DESKTOP, 'main.js')); } catch (err) { secondError = err; }
  await tick();
  check(!secondError, 'the main process still loads when the lock is held elsewhere', secondError?.message);
  check(second.log.quits === 1 && second.windows.length === 0 && second.ipc.size === 0,
    'a second instance quits without a window or a renderer bridge',
    JSON.stringify({ quits: second.log.quits, windows: second.windows.length, handlers: second.ipc.size }));

  // The Lite flavour: the same shell loaded from a copy with no bundled server
  // next to it, so IS_LITE flips and the host affordances must turn off.
  const liteRoot = mkTemp('memes-desktop-lite-');
  const liteDir = path.join(liteRoot, 'desktop');
  fs.cpSync(DESKTOP, liteDir, { recursive: true });
  const lite = makeElectron({ userData: mkTemp('memes-desktop-lite-data-') });
  let liteError = null;
  try { loadWith(lite.electron, path.join(liteDir, 'main.js')); } catch (err) { liteError = err; }
  await tick();
  check(!liteError, 'the Lite build loads without a bundled server', liteError?.message);
  if (IS_HOST) {
    check(lite.windows[0]?.options.title === 'Memes Arcade Desktop Lite', 'the Lite build titles the window accordingly', lite.windows[0]?.options.title);
    const liteInfo = await lite.ipc.get('arcade:info')();
    check(liteInfo?.lite === true && liteInfo?.mode === 'lite', 'Lite info reports no bundled server and lite start-up mode', JSON.stringify({ lite: liteInfo?.lite, mode: liteInfo?.mode }));
    const liteServerMenu = lite.menu.template?.find((m) => m.label === 'Server')?.submenu || [];
    check(liteServerMenu.find((i) => i.label === 'Start local server (host mode)')?.enabled === false, 'Lite disables the local-server menu entry');
    const refused = await lite.ipc.get('arcade:start-host')();
    check(refused?.ok === false && /Lite download/.test(refused.error || ''), 'Lite refuses to start a server with a pointed message', refused?.error);
  } else {
    note('this checkout is already the Lite flavour; the Host checks above were skipped');
  }

  // preload.js: the bridge surface must match what main.js registered.
  const pre = makePreload();
  let preloadError = null;
  try { loadWith(pre.electron, PRELOAD); } catch (err) { preloadError = err; }
  if (check(!preloadError, 'the preload bridge loads', preloadError?.message)) {
    const bridge = pre.exposed.arcade;
    if (check(!!bridge && typeof bridge === 'object', 'preload exposes window.arcade')) {
      const names = Object.keys(bridge).sort();
      check(JSON.stringify(names) === JSON.stringify(BRIDGE_ACTIONS), 'the bridge exposes exactly the documented actions', names.join(', '));
      for (const [name, fn] of Object.entries(bridge)) if (typeof fn === 'function' && !name.startsWith('on')) fn('x');
      const invoked = [...new Set(pre.invoked)].sort();
      check(JSON.stringify(invoked) === JSON.stringify([...CHANNELS].sort()),
        'every channel the bridge invokes is one the main process registered', invoked.join(', '));
      bridge.onStatus?.(() => {});
      bridge.onServerStopped?.(() => {});
      const mainSrc = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
      const sentChannels = new Set([...mainSrc.matchAll(/webContents\.send\(\s*'([^']+)'/g)].map((m) => m[1]));
      const subs = [...new Set(pre.subscribed)];
      check(subs.length > 0 && subs.every((c) => sentChannels.has(c)),
        'every event the bridge listens for is one the main process sends', `listens ${subs.join(', ')}`);
      const runtimeSent = [...new Set(run.windows.flatMap((w) => w.webContents.sent.map(([c]) => c)))];
      check(runtimeSent.length > 0 && runtimeSent.every((c) => sentChannels.has(c)),
        'the main process pushes no event the bridge cannot hear', runtimeSent.join(', '));
      check(!('ipcRenderer' in bridge) && !('require' in bridge), 'the bridge hands the renderer no raw Electron objects');
    }
  }
}

try {
  await checkHostFlavour();
} catch (err) {
  failures++;
  console.error(`\nDesktop check crashed: ${err.stack || err.message}`);
} finally {
  try { await hostRun?.ipc.get('arcade:stop-host')?.(); } catch {}
  if (hostPort && !(await portFree(hostPort))) {
    killByPort(hostPort);
    await sleep(300);
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

if (hostPort) {
  const left = !(await portFree(hostPort));
  check(!left, 'the run leaves no scratch server behind', left ? `port ${hostPort} still held` : 'clean');
}

console.log(`\n${failures ? `✗ ${failures} failure(s), ${passed} passed` : `✓ all ${passed} desktop checks passed`}\n`);
process.exit(failures ? 1 : 0);
