#!/usr/bin/env node
/**
 * Browser reload smoke check.
 *
 *   npm run browser                 # scratch server + headless Edge/Chrome
 *   npm run browser -- --cycles 3   # reload the host three times
 *   npm run browser -- --plain      # skip the fault injection (below)
 *   npm run browser -- --target https://arcade.example.com   # a deployed build
 *
 * Hosts a realtime Ping Pong room in a real browser, lets the host stream,
 * reloads the page mid-match, and asserts the snapshot stream resumes - the
 * failure this guards against froze every viewer when the host page reloaded.
 *
 * Before that it also regression-checks the invite links: /?party= joins a
 * party hosted by a second account (both while signed in and through the
 * sign-in screen - the real invite path), and a party member who never comes
 * back must be said goodbye in the open party chat panel as a live system
 * line while the member who returns (after the same grace) is offered the
 * party back and rejoins it with one click, /?room= drops you into another
 * account's room waiting area, both params together prefer the room, and the
 * address bar is cleaned afterwards. The waiting area also gets the
 * host-outage countdown: dropping the host's socket must raise the banner
 * naming who takes over and the seconds left, ticking down, and it must clear
 * when the host reconnects before the grace ends. It also checks account settings sync
 * (the account copy replaces the browser's local one) and the offline/
 * reconnect toasts (the socket is dropped for real - CDP offline emulation
 * alone does not close an established WebSocket). Finally it exercises the
 * toasts' one-click actions: a party invite joins on click and drops its Join
 * button once the player is already in that party, a friend request accepts
 * in place, and a duplicate request while already friends brings no Accept
 * button at all. On a scratch run the owner console also sends a real
 * broadcast, which must reach the sender as a toast and become the site
 * announcement banner; a target skips that step, since it would toast real
 * players and rewrite the live banner.
 *
 * The historical bug was a race: boot's catalog redraw could land while the
 * engine import for the room:start mount was still pending, and the loser of
 * the race disposed the host that held the start state.  Races pass tests by
 * accident, so this check slows exactly those two responses through the
 * DevTools protocol - the catalog fetch and the engine file - recreating the
 * interleaving on every run instead of hoping for it.  --plain disables it.
 *
 * No npm dependencies: it talks CDP over the browser's own debug socket.
 * A missing browser is reported and skipped (exit 0); set MEMES_BROWSER to a
 * Chromium/Edge/Chrome binary path to run it on an unusual setup.
 *
 * The scratch server's port is chosen by bind-probing the suite's range, so a
 * server left over from an earlier run is skipped instead of booted onto. A
 * port grabbed in the gap is refused rather than tested: the child is given a
 * per-run nonce and must echo it in the boot banner it prints after listen(),
 * so the suite proves the server it talks to is the one it spawned instead of
 * silently exercising a stale listener on the same port (see startServer).
 *
 * With --target (or MEMES_TARGET) the suite skips the scratch server and runs
 * the same black-box checks - invite links, settings sync, offline toasts, the
 * one-click toast actions, the moderator resolving and then reopening a
 * player's report through the panel, the owner's full console and the
 * host/reload scenario - against
 * the deployed build, which must answer /api/health and allow guest sign-in.
 * It writes test data to that host (a guest, three named accounts - one
 * promoted to moderator - and rooms), so point it at staging. The panel
 * checks need the owner account: scratch runs seed their own; a target needs
 * MEMES_ADMIN_PASS (and MEMES_ADMIN_USER if the owner was renamed) or those
 * checks are skipped. That same owner session removes the run's data on the
 * way out - the report it filed, the rooms it opened and every account it
 * registered - and the suite fails if anything survives; without it, cleanup
 * is skipped with a note.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './lib/free-port.mjs';
import { stopChild } from './lib/stop-child.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT_RANGE = { start: 8871, span: 40 };
let PORT = null; // a scratch port, chosen in startServer from the ones actually free
const DATA = path.join(ROOT, 'data', 'browser-reload');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/** A deployed build to test instead of a scratch server (see the header). */
const TARGET = String(argOf('--target', process.env.MEMES_TARGET || '')).trim().replace(/\/+$/, '');
if (TARGET && !/^https?:\/\//i.test(TARGET)) {
  console.error(`✗ --target must be an http(s) URL, got "${TARGET}"`);
  process.exit(2);
}
/** The deployed build to test, or filled in by startServer for a scratch run. */
let BASE = TARGET;
/** The websocket origin that matches BASE (https -> wss). */
let WS_BASE = TARGET ? TARGET.replace(/^http/i, 'ws') : '';

const CYCLES = Math.max(1, Number(argOf('--cycles', 1)) || 1);
const ENGINE_DELAY = Math.max(0, Number(argOf('--engine-delay', 900)) || 0);
const CATALOG_DELAY = Math.max(0, Number(argOf('--catalog-delay', 500)) || 0);
const PLAIN = args.includes('--plain');

/** Scratch runs seed their own owner with this password; targets need the real one. */
const SCRATCH_ADMIN_PASS = 'browser-admin-2026';
/**
 * A per-run secret handed to the scratch child, which echoes it in its boot
 * banner. No other process can know it, so seeing it back proves the server
 * answering on PORT is the child this run spawned - not a stale listener that
 * happened to grab the port in the gap between the bind probe and the child's
 * listen().
 */
const BOOT_NONCE = `browser-${crypto.randomBytes(12).toString('hex')}`;
const ADMIN_USER = process.env.MEMES_ADMIN_USER || 'memegodmidas';

let failures = 0;
let passed = 0;
let skipped = false;
const check = (ok, label, detail = '') => {
  if (ok) passed++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * browser discovery
 * ------------------------------------------------------------------ */

function which(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findBrowser() {
  if (process.env.MEMES_BROWSER) return process.env.MEMES_BROWSER;
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    return [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    ].filter(Boolean).find(existsSync) || null;
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].find(existsSync) || null;
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
    .map(which).find(Boolean) || null;
}

/* ------------------------------------------------------------------ *
 * scratch server + process cleanup
 * ------------------------------------------------------------------ */

let server = null;

async function startServer() {
  rmSync(DATA, { recursive: true, force: true });
  // Bind-probe the suite's range first: a port a leftover server still holds is
  // skipped rather than booted onto, so the run never deliberately boots onto
  // another process's leftovers.
  PORT = await pickFreePort(PORT_RANGE);
  BASE = `http://127.0.0.1:${PORT}`;
  WS_BASE = BASE.replace(/^http/i, 'ws');
  console.log(`\nBooting a scratch server on port ${PORT}…`);
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MEMES_PORT: String(PORT),
      MEMES_HOST: '127.0.0.1',
      MEMES_DATA: DATA,
      MEMES_PLATFORM: 'browser-reload',
      MEMES_ADMIN_PASS: process.env.MEMES_ADMIN_PASS || SCRATCH_ADMIN_PASS,
      // Party seats expire quickly here: the party-chat departure check must
      // watch a member actually fall off.  The room grace stays at its default
      // (20s), which the host-outage countdown check depends on.
      MEMES_PARTY_GRACE_MS: '1500',
      // Schedules are checked live: a window a few seconds out must open and
      // close on the production sweep, not wait 20s for it.
      MEMES_SCHEDULE_TICK_MS: '500',
      // Only this child sees the nonce, and it prints it in the banner it emits
      // after listen() succeeds. A banner carrying it is proof this process,
      // not an orphan, bound the port.
      MEMES_BOT_SECRET: BOOT_NONCE,
      // Keep the banner naming the local port it bound instead of any public
      // URL inherited from the developer's shell, so the proof can name the
      // exact port too.
      MEMES_PUBLIC_URL: '',
      RENDER_EXTERNAL_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let banner = '';
  server.stdout.on('data', (b) => { banner += String(b); });
  server.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
  const started = Date.now();
  while (Date.now() - started < 20000) {
    // A child that died on EADDRINUSE can never answer for PORT again; anything
    // the health check sees now belongs to somebody else, so stop rather than
    // silently test that stranger's code and data.
    if (server.exitCode !== null) {
      throw new Error(`the scratch server exited (code ${server.exitCode}) without serving port ${PORT} - something else is holding it (a leftover server?). Stop it and re-run`);
    }
    // MEMES_PORT pins the port (the server only walks to neighbouring ports
    // when it is free to drift), so our child listening means it bound PORT -
    // and a port has exactly one listener, which makes the health answer ours.
    if (banner.includes(BOOT_NONCE) && banner.includes(`localhost:${PORT}`)) {
      let health = null;
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) health = await res.json().catch(() => null);
      } catch {}
      if (health?.ok === true) {
        check(true, `the scratch server on port ${PORT} is the child this run spawned (boot nonce echoed)`);
        return;
      }
    }
    await sleep(200);
  }
  // Nothing proved ownership. Say which of the two failures it was: a stranger
  // answering the port is a leftover server to stop, silence is a broken boot.
  const stray = await fetch(`${BASE}/api/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  throw new Error(stray?.ok
    ? `port ${PORT} answers /api/health but never echoed this run's boot nonce - another server (a stale listener?) holds it; stop it and re-run`
    : `the scratch server never answered /api/health on port ${PORT}`);
}

/* ------------------------------------------------------------------ *
 * target cleanup
 * ------------------------------------------------------------------ */

/**
 * Everything a deployed run writes down, so the run can take it back. A scratch
 * run throws its whole data dir away instead; a target run shares a real
 * database with real players, so the accounts it registers, the rooms it opens
 * and the report it files must not outlive the check.
 *
 * Cleanup needs a staff session - the owner login the panel checks already use.
 * Without MEMES_ADMIN_PASS a target run cannot remove what it wrote (and says
 * so on the way out rather than pretending otherwise).
 */
const TARGET_WRITES = { accounts: [], reports: [], features: [], ownerToken: '' };

async function cleanupTarget() {
  if (!TARGET) return;
  if (!TARGET_WRITES.ownerToken) {
    console.log('⤼ target cleanup skipped: no owner session (set MEMES_ADMIN_PASS so a target run can remove what it wrote)');
    return;
  }
  const auth = { authorization: `Bearer ${TARGET_WRITES.ownerToken}` };
  const json = async (route, options = {}) => {
    try {
      return await (await fetch(`${BASE}${route}`, options)).json().catch(() => null);
    } catch {
      return null;
    }
  };
  const adminPost = (route, body) => json(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });

  const hostedIds = new Set(TARGET_WRITES.accounts.map((a) => a.id).filter(Boolean));
  let closedRooms = 0;

  // Rooms first: the run hosted them over sockets that are closed by now, and
  // the room list below stops naming a deleted host.
  const listed = await json('/api/admin/rooms', { headers: auth });
  for (const room of listed?.rooms || []) {
    if (!hostedIds.has(room.host)) continue;
    const res = await adminPost(`/api/admin/rooms/${room.id}`, { op: 'close' });
    if (res?.ok === true) closedRooms++;
  }

  // The report the moderator resolved (and reopened) through the panel.
  const inbox = await json('/api/admin/reports?status=all&limit=200', { headers: auth });
  for (const report of inbox?.reports || []) {
    if (!TARGET_WRITES.reports.includes(report.text)) continue;
    await adminPost(`/api/admin/reports/${report.id}`, { op: 'delete' });
  }

  // Accounts last: the report records and room hosts above name them.
  // Feature switches the run flipped and did not restore itself - including
  // any schedule and any keep-floor, which a plain on:true would leave behind
  // on the target.
  for (const id of TARGET_WRITES.features) {
    await adminPost('/api/admin/features', { id, on: true, hidden: false, schedule: null, minRole: 'mod' });
  }

  for (const account of TARGET_WRITES.accounts) {
    if (!account.id) continue;
    await adminPost(`/api/admin/users/${account.id}`, { op: 'delete', reason: 'browser-reload-check cleanup' });
  }

  // Confirm the removals stuck: a 200 whose record survives is exactly the
  // silent leftover this cleanup exists to prevent. Accounts are looked up by
  // name so a busy target's user list cannot hide a survivor.
  const stragglers = [];
  for (const account of TARGET_WRITES.accounts) {
    if (!account.id) continue;
    const found = await json(`/api/admin/users?q=${encodeURIComponent(account.name)}&limit=10`, { headers: auth });
    if ((found?.users || []).some((u) => u.id === account.id)) stragglers.push(`account ${account.name}`);
  }
  const roomsLeft = await json('/api/admin/rooms', { headers: auth });
  for (const room of roomsLeft?.rooms || []) {
    if (hostedIds.has(room.host)) stragglers.push(`room ${room.code}`);
  }
  const reportsLeft = await json('/api/admin/reports?status=all&limit=200', { headers: auth });
  for (const report of reportsLeft?.reports || []) {
    if (TARGET_WRITES.reports.includes(report.text)) stragglers.push(`report ${report.id}`);
  }
  const flagsLeft = await json('/api/admin/features', { headers: auth });
  for (const feature of flagsLeft?.features || []) {
    if (TARGET_WRITES.features.includes(feature.id)
      && (feature.on === false || feature.hidden === true || (feature.minRole && feature.minRole !== 'mod'))) {
      stragglers.push(`feature ${feature.id} left off, hidden or role-kept`);
    }
  }

  check(stragglers.length === 0,
    `the target is left with no data from this run (${TARGET_WRITES.accounts.length} account(s), ${TARGET_WRITES.reports.length} report(s) and ${closedRooms} room(s) verified gone)`,
    stragglers.length ? `still there: ${stragglers.join(', ')}` : '');
}

/* ------------------------------------------------------------------ *
 * a tiny CDP client (no dependencies: the browser's own debug socket)
 * ------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result);
        return;
      }
      if (msg.method) for (const fn of this.listeners.get(msg.method) || []) {
        try {
          fn(msg.params, msg.sessionId);
        } catch {}
      }
    };
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }
}

let cdp = null;
let session = null;
let browserChild = null;
let profileDir = null;

async function launchBrowser(bin) {
  profileDir = mkdtempSync(path.join(os.tmpdir(), 'memes-reload-'));
  // Detached on POSIX so the browser leads its own process group: that group is
  // the only handle on its helper processes, and stopChild(..., { tree: true })
  // uses it to clear them before the profile directory is removed.  (Windows
  // reaches the same tree with taskkill /T /F, so it needs no detachment.)
  browserChild = spawn(bin, [
    '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--remote-allow-origins=*',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  browserChild.stderr.on('data', () => {});

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 25000;
  let debugPort = 0;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      try {
        const [first] = readFileSync(portFile, 'utf8').split('\n');
        if (Number(first)) {
          debugPort = Number(first);
          break;
        }
      } catch {
        // Chromium on Windows creates the file a beat before it is readable
        // (EBUSY); keep polling rather than crashing the whole check.
      }
    }
    await sleep(150);
  }
  if (!debugPort) throw new Error('the browser never reported its DevTools port');

  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('the CDP socket refused'));
  });
  cdp = new CDP(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  session = attached.sessionId;
  await cdp.send('Page.enable', {}, session);
  await cdp.send('Runtime.enable', {}, session);
  await cdp.send('Network.enable', {}, session);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, session);

  if (!PLAIN) {
    // Continuing paused requests from a listener: the catalog lands mid-load,
    // the engine import is still pending - the exact historical interleaving.
    cdp.on('Fetch.requestPaused', ({ request, requestId }, sid) => {
      const url = request.url;
      const delay = url.includes('/api/games') ? CATALOG_DELAY : ENGINE_DELAY;
      setTimeout(() => {
        cdp.send('Fetch.continueRequest', { requestId }, sid).catch(() => {});
      }, delay);
    });
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*api/games*', requestStage: 'Request' },
        { urlPattern: '*games/engines/*.js*', requestStage: 'Request' },
      ],
    }, session);
  }
}

async function closeBrowser() {
  try {
    if (cdp) await Promise.race([cdp.send('Browser.close'), sleep(1500)]);
  } catch {}
  // Browser.close is the polite path; stopChild covers the browser that ignores
  // it and, with `tree`, whatever it spawned - helpers keep writing into the
  // profile for a beat after the browser itself is gone, which is what left
  // memes-reload-* directories behind on CI's Linux runners.
  await stopChild(browserChild, { tree: true });
  await removeProfile();
}

/**
 * Delete the throwaway Chromium profile.  Chromium keeps a lock on it for a
 * beat after being killed - reliably so on Windows, which holds the directory
 * until the last child process exits - so retry instead of leaving a
 * multi-megabyte profile behind for the next run (or the stray-state check) to
 * find.  A single shot here silently leaked dozens of them.
 */
async function removeProfile() {
  if (!profileDir) return;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {}
    if (!existsSync(profileDir)) {
      profileDir = null;
      return;
    }
    await sleep(300);
  }
  console.log(`  note  could not remove the browser profile at ${profileDir}`);
}

/* ------------------------------------------------------------------ *
 * page driving
 * ------------------------------------------------------------------ */

const evaluate = async (expression) => {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'the page threw');
  return res.result?.value;
};

async function until(expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch {}
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const clickText = (text) => evaluate(
  `(() => { const hit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(text)})); if (!hit || hit.disabled) return false; hit.click(); return true; })()`,
);

const hudText = () => evaluate(`(document.querySelector('.net-hud') || {}).textContent || null`);
const streamRate = (text) => {
  const match = String(text || '').match(/snap ([\d.]+)\/s/);
  return match ? Number(match[1]) : 0;
};

const STREAMING = '(() => { const el = document.querySelector(".net-hud"); return !!el && /· host/.test(el.textContent) && /snap \\d/.test(el.textContent); })()';

async function expectStreaming(label) {
  try {
    await until(STREAMING, label, 30000);
  } catch (err) {
    return check(false, label, err.message);
  }
  await sleep(900);
  const text = await hudText();
  const rate = streamRate(text);
  return check(rate >= 10, label, `snap ${rate}/s · ${text}`);
}

const roomsNow = async () => (await (await fetch(`${BASE}/api/rooms`)).json()).rooms || [];

async function setRoomTarget(token, target) {
  const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('the side socket refused'));
  });
  ws.send(JSON.stringify({ t: 'hello', v: '1.0.0', kind: 'web' }));
  await sleep(250);
  ws.send(JSON.stringify({ t: 'room', op: 'options', options: { target } }));
  await sleep(250);
  ws.close();
}

/* ------------------------------------------------------------------ *
 * invite links, account settings sync and offline toasts
 * ------------------------------------------------------------------ */

/** Installed on every new document: records toasts even before the app is up,
 *  so a confirmation that fires while the page boots is never missed. */
const TOAST_LOG = `window.__toastLog = [];
new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) {
    if (n.nodeType === 1 && n.classList.contains('toast')) window.__toastLog.push(n.textContent);
  }
}).observe(document, { childList: true, subtree: true });`;

/** Keeps a handle on every socket the app opens, so the drop can be simulated
 *  for real: CDP offline emulation alone does not close an established WS. */
const WS_CAPTURE = `window.__sockets = [];
(() => {
  const Orig = window.WebSocket;
  const Wrapped = function (...args) {
    const sock = new Orig(...args);
    window.__sockets.push(sock);
    return sock;
  };
  Wrapped.prototype = Orig.prototype;
  Object.setPrototypeOf(Wrapped, Orig); // OPEN/CONNECTING constants come through
  window.WebSocket = Wrapped;
})();`;

/** `until` as a check, so a timeout is a failed check and not an abort. */
async function expectTrue(expression, label, timeoutMs = 15000) {
  try {
    await until(expression, label, timeoutMs);
    return check(true, label);
  } catch (err) {
    return check(false, label, err.message);
  }
}

/** Seed the client's saved state from a same-origin document that is not the
 *  app. A running client debounces localStorage writes (~200ms), so injecting
 *  while it is alive can be overwritten by a pending save. */
async function seedStoredState(saved) {
  await cdp.send('Page.navigate', { url: `${BASE}/api/health` }, session);
  await until(`document.readyState === 'complete'`, 'the origin page for seeding');
  await evaluate(`localStorage.setItem('memes-arcade:state', ${JSON.stringify(JSON.stringify(saved))})`);
}

async function expectToast(needle, label, timeoutMs = 12000) {
  try {
    await until(`(window.__toastLog || []).some((t) => t.includes(${JSON.stringify(needle)}))`, label, timeoutMs);
    return check(true, label);
  } catch (err) {
    const seen = await evaluate('window.__toastLog || []').catch(() => []);
    return check(false, label, `saw ${JSON.stringify(seen)}`);
  }
}

async function runRegressionChecks() {
  console.log('\nInvite links, account settings sync and offline toasts…');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `${TOAST_LOG}\n${WS_CAPTURE}` }, session);

  // A named account whose saved settings deliberately differ from this
  // browser's local copy, so adopting them proves the sync direction.
  const name = `flags-${Date.now().toString(36)}`;
  const registered = await (await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password: 'browser-pass-2026' }),
  })).json();
  check(!!registered?.token, 'a named account is ready for the regression checks', registered?.message);
  TARGET_WRITES.accounts.push({ id: registered?.user?.id, name });
  if (!registered?.token) return;

  await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${registered.token}` },
    body: JSON.stringify({ theme: 'neon', accent: '#00ff88', reduceMotion: true }),
  });
  await seedStoredState({
    token: registered.token,
    settings: { theme: 'midnight', accent: '#ff2fb0' },
    view: 'home',
  });
  await cdp.send('Page.navigate', { url: `${BASE}/` }, session);
  try {
    await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app shell for the settings check', 25000);
    await expectTrue(`document.documentElement.dataset.theme === 'neon'`, "the account's theme replaces this browser's local theme");
    await expectTrue(`document.documentElement.style.getPropertyValue('--accent').trim() === '#00ff88'`, "the account's accent syncs too");
    await expectTrue(`document.body.classList.contains('reduce-motion') === true`, 'account accessibility settings reach the DOM');
  } catch (err) {
    check(false, 'account settings sync', err.message);
  }

  // A second account hosts the invite targets, so every link below joins
  // someone else's party/room - a re-attach to your own would not prove the
  // join path. The host socket creates parties on demand and remembers what
  // the server broadcasts, proving each join from the host's side too.
  const hostName = `link-host-${Date.now().toString(36)}`;
  const hostReg = await (await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: hostName, password: 'browser-pass-2026' }),
  })).json();
  check(!!hostReg?.token, 'a second account hosts the invite targets', hostReg?.message);
  const hostToken = hostReg?.token || '';
  TARGET_WRITES.accounts.push({ id: hostReg?.user?.id, name: hostName });

  const sideState = { partyCode: '', members: [], rows: [], notifies: [], errors: [] };
  let side = null;
  /** Open (or re-open) the host socket.  One handler feeds `sideState`, so the
   *  invite checks below keep working across the outage check's reconnect. */
  const openSide = () => {
    const sock = new WebSocket(`${WS_BASE}/ws`);
    sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', v: '1.0.0', kind: 'web', api: 3, token: hostToken }));
    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'party' && msg.party) {
        sideState.partyCode = msg.party.code;
        sideState.members = (msg.party.members || []).map((m) => m.name);
        sideState.rows = (msg.party.members || []).map((m) => ({ name: m.name, presence: m.presence }));
      }
      if (msg.t === 'notify') sideState.notifies.push({ kind: msg.kind, text: msg.text });
      if (msg.t === 'error') sideState.errors.push(msg.message || '');
    };
    side = sock;
    return sock;
  };
  openSide();
  const waitSide = async (pred, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  };
  const hostParty = async () => {
    if (!(await waitSide(() => side.readyState === 1, 8000))) return '';
    const before = sideState.partyCode;
    side.send(JSON.stringify({ t: 'party', op: 'create' }));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && sideState.partyCode === before) await sleep(100);
    return sideState.partyCode !== before ? sideState.partyCode : '';
  };

  // Party invite link: /?party=CODE must join the host's party and clean the URL.
  const partyCode = await hostParty();
  check(!!partyCode, 'opened a party for the invite-link check', partyCode || 'no code');
  if (partyCode) {
    try {
      await cdp.send('Page.navigate', { url: `${BASE}/?party=${partyCode}` }, session);
      await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app shell after the party link', 25000);
      await expectTrue(`location.search === ''`, 'the party invite link is consumed');
      await expectTrue(`(document.querySelector('#side-party') || {}).textContent?.includes('code ${partyCode}')`, 'the party link auto-joins the party');
      await expectToast(`Joined party ${partyCode}`, 'the party join is confirmed with a toast');
      const sawJoin = await waitSide(() => sideState.partyCode === partyCode && sideState.members.includes(name));
      check(sawJoin, "the party host's member list shows the linked player", JSON.stringify(sideState));

      /* A member who never comes back is said goodbye where the party can see
         it: with the party chat open, the post-grace departure has to land in
         the panel as a live system line - no reload, no manual refresh.  The
         socket comes back even when the check fails, so the room-link checks
         below are never left without their host. */
      try {
        await evaluate(`window.__setView('chat')`);
        await until(`[...document.querySelectorAll('.tabs-list button')].some((b) => b.textContent.trim() === 'Party')`, 'the chat tabs');
        await evaluate(`(() => { const b = [...document.querySelectorAll('.tabs-list button')].find((x) => x.textContent.trim() === 'Party'); b.click(); return true; })()`);
        await until(`[...document.querySelectorAll('.chat-line')].some((l) => l.textContent.includes('joined the party'))`, 'the party chat to open', 8000);
        check(true, 'the party chat panel is open and showing the join line');
        side.close();
        await until(`[...document.querySelectorAll('.chat-line.system')].some((l) => l.textContent.includes('lost connection and left the party'))`,
          'the departure system line', TARGET ? 45000 : 15000);
        const departure = await evaluate(`(() => {
          const l = [...document.querySelectorAll('.chat-line.system')].find((x) => x.textContent.includes('lost connection and left the party'));
          if (!l) return null;
          const r = l.getBoundingClientRect();
          return { cls: l.className, named: !!l.querySelector('.chat-name'), text: l.textContent.replace(/\\s+/g, ' ').trim(), h: Math.round(r.height), w: Math.round(r.width), display: getComputedStyle(l).display };
        })()`);
        check(!!departure && departure.cls.includes('system') && !departure.named
          && departure.display !== 'none' && departure.h > 0 && departure.w > 0
          && departure.text.includes(`${hostName} lost connection and left the party.`),
          'the post-grace departure shows as a visible system line in the party chat', JSON.stringify(departure));
      } catch (err) {
        check(false, 'the party chat shows the departure', err.message);
      } finally {
        await openSide();
        await waitSide(() => side?.readyState === 1, 5000);
      }

      /* One-click rejoin: a member whose seat the grace reclaimed gets the
         party back without hunting for the code.  The browser is the one that
         falls off (navigate away past the grace), and the host takes its own
         offer first so the party is still alive when the browser returns. */
      try {
        side.send(JSON.stringify({ t: 'party', op: 'join', code: partyCode }));
        const hostBack = await waitSide(() => sideState.partyCode === partyCode && sideState.members.includes(name), 8000);
        check(hostBack, 'the host rejoins so the party survives the next drop', JSON.stringify(sideState));
        // A member who exists only for this round trip.  This page has been
        // through many navigations and drop simulations by now, and a socket
        // left behind by an earlier document would - correctly - keep the
        // account online, so its seat would never be reclaimed.  One socket,
        // one member, no history.
        const rejoinName = `rejoin-${Date.now().toString(36)}`;
        const rejoinReg = await (await fetch(`${BASE}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: rejoinName, password: 'rejoin-pass-2026' }),
        })).json();
        check(!!rejoinReg?.token, 'a member account is ready for the rejoin check', rejoinReg?.message);
        TARGET_WRITES.accounts.push({ id: rejoinReg?.user?.id, name: rejoinName });
        await seedStoredState({ token: rejoinReg.token, view: 'home' });
        await cdp.send('Page.navigate', { url: `${BASE}/?party=${partyCode}` }, session);
        await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app for the rejoin member', 25000);
        check(await waitSide(() => sideState.members.includes(rejoinName), 10000), 'the rejoin member joins the party from the link',
          JSON.stringify(sideState.rows));
        // Fall off the party the way a closed tab does: that member's one socket
        // goes, and we leave the document before its reconnect timer can open
        // another.  about:blank guarantees the app really is gone rather than
        // served as a download, so the server sees the member leave for good.
        await evaluate('(window.__sockets || []).forEach((s) => { try { s.close(); } catch {} }); true');
        await cdp.send('Page.navigate', { url: 'about:blank' }, session);
        const away = await until('!document.querySelector("#app")', 'the member to leave the arcade', 10000);
        check(!!away, 'the returning member really left the app', `location: ${await evaluate('location.href')}`);
        const reclaimed = await waitSide(() => !sideState.members.includes(rejoinName), TARGET ? 45000 : 15000);
        check(reclaimed, 'the grace reclaims the seat of a member who is really gone',
          `host sees ${JSON.stringify(sideState.rows)}`);
        await cdp.send('Page.navigate', { url: `${BASE}/` }, session);
        await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app after the rejoin round trip', 25000);
        const offer = await until(`(() => { const t = [...document.querySelectorAll('#toasts .toast')].find((x) => x.textContent.includes('Rejoin party')); return t ? t.textContent.replace(/\\s+/g, ' ').trim() : null; })()`, 'the rejoin toast', 12000);
        check(String(offer).includes('🎈 Rejoin party'), 'the returning member is offered the party back', String(offer));
        check((await clickToastAction('Rejoin party')) === true, 'the Rejoin party button is clickable');
        await expectToast(`Joined party ${partyCode}`, 'one click puts the returning member back in the party');
        await expectTrue(`(document.querySelector('#side-party') || {}).textContent?.includes('code ${partyCode}')`, 'the sidebar shows the rejoin landed');
        check(await waitSide(() => sideState.members.includes(rejoinName)), "the party host's member list shows the returning member", JSON.stringify(sideState));
        await evaluate(`window.__setView('chat')`);
        await evaluate(`(() => { const b = [...document.querySelectorAll('.tabs-list button')].find((x) => x.textContent.trim() === 'Party'); if (b) b.click(); return !!b; })()`);
        const backLine = await until(`(() => {
          const l = [...document.querySelectorAll('.chat-line.system')].find((x) => x.textContent.includes(${JSON.stringify(`${rejoinName} rejoined the party.`)}));
          if (!l) return null;
          const r = l.getBoundingClientRect();
          return { cls: l.className, text: l.textContent.replace(/\\s+/g, ' ').trim(), h: Math.round(r.height) };
        })()`, 'the return line in the party chat', 10000);
        check(!!backLine && backLine.cls.includes('system') && backLine.h > 0,
          'the party chat announces the return as a system line', JSON.stringify(backLine));
        // Hand the page back to the suite's own account for the checks below.
        await seedStoredState({ token: registered.token, view: 'home' });
        await cdp.send('Page.navigate', { url: `${BASE}/` }, session);
        await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app back on the suite account', 25000);
      } catch (err) {
        const seen = await evaluate('(window.__toastLog || []).slice(-6)').catch(() => null);
        check(false, 'one-click party rejoin', `${err.message} — toasts: ${JSON.stringify(seen)}`);
        // A failure here must not leave the suite signed in as the member above.
        await seedStoredState({ token: registered.token, view: 'home' }).catch(() => {});
        await cdp.send('Page.navigate', { url: `${BASE}/` }, session).catch(() => {});
      }
    } catch (err) {
      check(false, 'party invite link', err.message);
    }
  }

  // Room invite link: /?room=CODE must seat you in the host's waiting room.
  const created = await (await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ gameId: 'tic-tac-toe', bots: 0 }),
  })).json();
  check(!!created?.code, 'opened a room for the invite-link check', created?.message);
  if (created?.code) {
    try {
      await cdp.send('Page.navigate', { url: `${BASE}/?room=${created.code}` }, session);
      await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app shell after the room link', 25000);
      await expectTrue(`location.search === ''`, 'the room invite link is consumed');
      await expectTrue(`(document.querySelector('#status-room') || {}).textContent?.includes('${created.code}')`, 'the room link drops you into the room');
      await expectTrue(`(document.querySelector('#game-stage') || {}).textContent?.includes('Waiting for the host')`, 'the join renders the room waiting area');
      await expectTrue(`(document.querySelector('.waiting-list') || {}).textContent?.includes(${JSON.stringify(name)})`, 'the linked player is seated in the waiting list');
      const info = await (await fetch(`${BASE}/api/rooms/${created.code}`)).json();
      check((info.room?.players || []).some((p) => p.name === name), 'the server has the linked player in the room', JSON.stringify((info.room?.players || []).map((p) => p.name)));

      /* A dropped host used to leave the room frozen and silent.  The banner
         must name who takes over and count the wait down - and clear when the
         host makes it back before the grace ends. */
      side.close();
      await expectTrue(`(() => { const b = document.querySelector('#room-alert'); return !!b && !b.hidden && /lost connection/.test(b.textContent); })()`,
        'a dropped host raises the outage countdown banner', 8000);
      const banner = await evaluate(`(document.querySelector('#room-alert') || {}).textContent || ''`);
      const countdown = banner.match(/takes over in (\d+)s/);
      check(banner.includes(name) && !!countdown, 'the banner names who takes over and the seconds left', banner);
      const laidOut = await evaluate(`(() => { const b = document.querySelector('#room-alert'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { display: getComputedStyle(b).display, h: Math.round(r.height), w: Math.round(r.width) }; })()`);
      check(!!laidOut && laidOut.display === 'flex' && laidOut.h > 0 && laidOut.w > 0,
        'the banner is really laid out on the page, not just unhidden', JSON.stringify(laidOut));
      const ghost = await evaluate(`(() => { const c = [...document.querySelectorAll('#room-seats .chip')].find((x) => x.textContent.includes(${JSON.stringify(hostName)})); return c ? { cls: c.className, text: c.textContent.replace(/\s+/g, ' ').trim() } : null; })()`);
      check(!!ghost && ghost.cls.includes('ghost') && ghost.text.includes('reconnecting'),
        'the dropped host seat greys out as a reconnecting ghost', JSON.stringify(ghost));
      const firstLeft = countdown ? Number(countdown[1]) : 0;
      await sleep(1400);
      const later = await evaluate(`(() => { const b = document.querySelector('#room-alert'); return b && !b.hidden ? b.textContent : null; })()`);
      const laterLeft = Number((String(later || '').match(/takes over in (\d+)s/) || [])[1]);
      if (firstLeft > 3) check(!!later && laterLeft < firstLeft, 'the countdown ticks the seconds down', later || 'the banner was gone');
      else console.log('⤼ the countdown-tick check is skipped: this server hands over too quickly');
      openSide();
      await expectTrue(`(document.querySelector('#room-alert') || {}).hidden === true`,
        'a host reconnect inside the grace clears the banner', 8000);
      const unghosted = await evaluate(`(() => { const c = [...document.querySelectorAll('#room-seats .chip')].find((x) => x.textContent.includes(${JSON.stringify(hostName)})); return c ? { cls: c.className, text: c.textContent.replace(/\s+/g, ' ').trim() } : null; })()`);
      check(!!unghosted && !unghosted.cls.includes('ghost') && !unghosted.text.includes('reconnecting'),
        'the reconnected host seat loses the ghost styling', JSON.stringify(unghosted));
      if (firstLeft > 3) {
        const still = await (await fetch(`${BASE}/api/rooms/${created.code}`)).json();
        check(still.room?.host === hostReg.user.id, 'the reconnected host keeps the room through the grace', still.room?.host);
      } else {
        console.log('⤼ the host-keeps-the-room check is skipped: this server hands over too quickly');
      }
    } catch (err) {
      check(false, 'room invite link', err.message);
    }
  }

  // The real invite path: a visitor with no session opens /?party=CODE, sees
  // the sign-in screen, and the link must survive it and join right after.
  const party2 = await hostParty();
  check(!!party2, 'opened a second party for the sign-in link check', party2 || 'no code');
  if (party2) {
    try {
      // Sign out like a real visitor: the app invalidates the session
      // server-side and returns to the auth screen, so the next navigation
      // is anonymous.
      await evaluate(`(() => { document.querySelector('#logout').click(); return true; })()`);
      await until(`!document.querySelector('#auth').classList.contains('hidden')`, 'the signed-out auth screen', 25000);
      await cdp.send('Page.navigate', { url: `${BASE}/?party=${party2}` }, session);
      await until(`!document.querySelector('#auth').classList.contains('hidden')`, 'the auth screen for a fresh visitor', 25000);
      check(true, 'a party link opens the sign-in screen first');
      const staleToken = await evaluate(`(JSON.parse(localStorage.getItem('memes-arcade:state') || '{}').token || '')`);
      await evaluate(`(() => {
        document.querySelector('#auth-name').value = ${JSON.stringify(name)};
        document.querySelector('#auth-pass').value = 'browser-pass-2026';
        document.querySelector('#auth-form').requestSubmit();
        return true;
      })()`);
      await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app shell after signing in from the link', 25000);
      // The client debounces persistence (~200ms): the fresh session must be
      // stored before the next hard navigation, or it restores the dead token.
      await until(`(JSON.parse(localStorage.getItem('memes-arcade:state') || '{}').token || '') !== ${JSON.stringify(staleToken)}`, 'the fresh session to be persisted', 8000);
      await expectTrue(`location.search === ''`, 'the party link is consumed once signed in');
      await expectTrue(`(document.querySelector('#side-party') || {}).textContent?.includes('code ${party2}')`, 'the link joins the party right after sign-in');
      await expectToast(`Joined party ${party2}`, 'the post-sign-in join is confirmed with a toast');
      const sawSignInJoin = await waitSide(() => sideState.partyCode === party2 && sideState.members.includes(name));
      check(sawSignInJoin, 'the host sees the post-sign-in join land', JSON.stringify(sideState));
    } catch (err) {
      check(false, 'party invite link through the sign-in screen', err.message);
    }
  }

  // Both params pasted together: the room wins, the party link is dropped.
  const party3 = await hostParty();
  check(!!party3, 'opened a third party for the precedence check', party3 || 'no code');
  if (party3) {
    try {
      await cdp.send('Page.navigate', { url: `${BASE}/?room=ZZZZ&party=${party3}` }, session);
      try {
        await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app shell after the combined link', 25000);
      } catch (err) {
        const diag = await evaluate(`({
          href: location.href,
          authShown: !document.querySelector('#auth').classList.contains('hidden'),
          boot: (document.querySelector('#boot') || {}).textContent?.slice(0, 140) || null,
          stored: (localStorage.getItem('memes-arcade:state') || '(none)').slice(0, 60),
        })`).catch(() => null);
        console.log(`    [diag] combined link page: ${JSON.stringify(diag)}`);
        throw err;
      }
      await expectTrue(`location.search === ''`, 'both invite params are consumed');
      await expectToast('No room with that code', 'the unknown room code fails loudly');
      await expectTrue(`!(document.querySelector('#side-party') || {}).textContent?.includes('code ${party3}')`, 'the party link is ignored when a room link is present');
      await sleep(600);
      check(sideState.partyCode === party3 && !sideState.members.includes(name), 'the combined link never joins the party', JSON.stringify(sideState));
    } catch (err) {
      check(false, 'combined invite link precedence', err.message);
    }
  }

  // One-click toast actions: the party-invite toast joins on click, the
  // friend request accepts in place - and neither offers its button once the
  // action is moot (already in that party, already friends).
  console.log('\nOne-click toast actions…');

  /** Action-button labels on the newest live toast containing `needle`:
   *  null when no such toast is up, [] when it carries no actions at all. */
  const toastActions = (needle) => evaluate(`(() => {
    const t = [...document.querySelectorAll('#toasts .toast')].reverse().find((n) => n.textContent.includes(${JSON.stringify(needle)}));
    return t ? [...t.querySelectorAll('.toast-actions button')].map((b) => b.textContent.trim()) : null;
  })()`);

  /** Click the first action button on that toast; false when it is not there. */
  /** A declaration, not a const arrow: the party checks above run before this
   *  line and must be able to click a toast action too. */
  function clickToastAction(needle) {
    return evaluate(`(() => {
      const t = [...document.querySelectorAll('#toasts .toast')].reverse().find((n) => n.textContent.includes(${JSON.stringify(needle)}));
      const b = t?.querySelector('.toast-actions button');
      if (!b) return false;
      b.click();
      return true;
    })()`);
  }

  const inviteText = `${hostName} invited you to a party.`;
  const friendText = `${hostName} sent you a friend request.`;

  // A party invite with a Join button: one click must land the seat, prove it
  // from the host's member list, and confirm through the join toast.
  const party4 = await hostParty();
  check(!!party4, 'opened a party for the one-click join check', party4 || 'no code');
  if (party4) {
    try {
      side.send(JSON.stringify({ t: 'party', op: 'invite', name }));
      await until(`[...document.querySelectorAll('#toasts .toast')].some((n) => n.textContent.includes(${JSON.stringify(inviteText)}))`, 'the party invite toast');
      const labels = await toastActions(inviteText);
      check(JSON.stringify(labels) === JSON.stringify(['🎈 Join party']), 'the party invite toast offers a Join party button', JSON.stringify(labels));
      check((await clickToastAction(inviteText)) === true, 'the Join party button is clickable');
      await expectToast(`Joined party ${party4}`, 'one click joins the party');
      await expectTrue(`(document.querySelector('#side-party') || {}).textContent?.includes('code ${party4}')`, 'the sidebar shows the joined party');
      const sawJoin = await waitSide(() => sideState.partyCode === party4 && sideState.members.includes(name));
      check(sawJoin, "the party host's member list shows the one-click join", JSON.stringify(sideState));
    } catch (err) {
      check(false, 'one-click Join party', err.message);
    }
  }

  // Inviting the app into the party it is already in: the toast still arrives,
  // but the Join button must be gone - there is nothing left to join.
  if (party4) {
    try {
      await until(`![...document.querySelectorAll('#toasts .toast')].some((n) => n.textContent.includes(${JSON.stringify(inviteText)}))`, 'the clicked invite toast to clear');
      side.send(JSON.stringify({ t: 'party', op: 'invite', name }));
      await until(`[...document.querySelectorAll('#toasts .toast')].some((n) => n.textContent.includes(${JSON.stringify(inviteText)}))`, 'the repeat invite toast');
      const labels = await toastActions(inviteText);
      check(JSON.stringify(labels) === '[]', 'an invite into the current party offers no Join button', JSON.stringify(labels));
    } catch (err) {
      check(false, 'invite into the current party', err.message);
    }
  }

  // The same one-click deal for a friend request, plus the already-friends
  // case: the server refuses the duplicate, so no Accept button may appear.
  const appToken = await evaluate(`(JSON.parse(localStorage.getItem('memes-arcade:state') || '{}').token || '')`);
  const appWho = appToken ? await (await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${appToken}` } })).json().catch(() => null) : null;
  check(appWho?.user?.id === registered.user.id, 'the live app session belongs to the regression account', appWho?.user?.name || 'no session');
  try {
    side.send(JSON.stringify({ t: 'friend', op: 'request', userId: registered.user.id }));
    await until(`[...document.querySelectorAll('#toasts .toast')].some((n) => n.textContent.includes(${JSON.stringify(friendText)}))`, 'the friend request toast');
    const labels = await toastActions(friendText);
    check(JSON.stringify(labels) === JSON.stringify(['✅ Accept']), 'the friend request toast offers an Accept button', JSON.stringify(labels));
    check((await clickToastAction(friendText)) === true, 'the Accept button is clickable');
    const accepted = await waitSide(() => sideState.notifies.some((n) => n.kind === 'friend-accept'));
    check(accepted, 'the requester hears the accept back', JSON.stringify(sideState.notifies.at(-1) || null));
    let friends = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      friends = await (await fetch(`${BASE}/api/friends`, { headers: { authorization: `Bearer ${appToken}` } })).json().then((b) => b.friends || []).catch(() => []);
      if (friends.some((f) => f.id === hostReg.user.id && f.friendStatus === 'accepted')) break;
      await sleep(200);
    }
    check(friends.some((f) => f.id === hostReg.user.id && f.friendStatus === 'accepted'), 'one click makes the friendship official server-side', JSON.stringify(friends.map((f) => [f.name, f.friendStatus])));

    // Already friends: the duplicate request is refused by the server and must
    // not put a new Accept button in front of the player.
    const logBefore = await evaluate('(window.__toastLog || []).length');
    side.send(JSON.stringify({ t: 'friend', op: 'request', userId: registered.user.id }));
    const refused = await waitSide(() => sideState.errors.some((e) => e.includes('already friends')));
    check(refused, 'a duplicate friend request is refused by the server', JSON.stringify(sideState.errors.at(-1) || 'no error seen'));
    await sleep(1500);
    const after = await evaluate(`({
      log: (window.__toastLog || []).slice(${logBefore}).filter((t) => t.includes(${JSON.stringify(friendText)})),
      live: [...document.querySelectorAll('#toasts .toast')].filter((n) => n.textContent.includes(${JSON.stringify(friendText)})).map((n) => [...n.querySelectorAll('.toast-actions button')].map((b) => b.textContent.trim())),
    })`);
    check(after.log.length === 0 && after.live.every((labels) => labels.length === 0), 'an already-friends request offers no new Accept button', JSON.stringify(after));
  } catch (err) {
    check(false, 'one-click Accept friend', err.message);
  }

  side.close();

  // Offline toasts: a dropped socket warns, and the reconnect says so. The
  // network is emulated offline right after the close so the automatic
  // retries keep failing until this check brings it back.
  try {
    // Close over the live network first: with CDP offline emulation already
    // active the close handshake can stall in CLOSING until the network
    // returns, so onclose (and the toast under test) would never fire. The
    // emulation only needs to be on before the 800ms reconnect fires.
    const dropState = await evaluate(`(() => { const s = (window.__sockets || []).at(-1); if (!s) return null; const rs = s.readyState; s.close(); return rs; })()`);
    check(dropState === 1, 'the app socket was open to drop', `readyState ${dropState}`);
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, session);
    await expectToast('Connection lost', 'a dropped connection warns the player', 15000);
    await expectTrue(`(document.querySelector('#status-connection') || {}).textContent?.includes('offline')`, 'the status bar shows the drop');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, session);
    await expectToast('Back online', 'reconnecting announces itself', 25000);
  } catch (err) {
    check(false, 'offline toast checks', err.message);
  }

  // The moderator's console, exercised for real: the panel lists exactly
  // Players, Rooms and Reports - never an owner-only tab or action the server
  // would refuse - and a player's report is resolved end-to-end through the
  // Reports tab. The owner's counterpart then shows the full nine-tab panel
  // and the Broadcast action, and a switch flipped there has to reach a player's
  // browser. Needs the owner account: scratch runs seeded one
  // above; a target needs MEMES_ADMIN_PASS in the environment, otherwise both
  // are skipped.
  const adminPass = process.env.MEMES_ADMIN_PASS || (TARGET ? '' : SCRATCH_ADMIN_PASS);
  if (!adminPass) {
    console.log('⤼ moderator and owner panel checks skipped: set MEMES_ADMIN_PASS to sign in the owner on the target');
  } else {
    console.log('\nModerator view of the admin console…');
    const modName = `modpan-${Date.now().toString(36)}`;
    const modReg = await (await fetch(`${BASE}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: modName, password: 'browser-pass-2026' }),
    })).json();
    TARGET_WRITES.accounts.push({ id: modReg?.user?.id, name: modName });
    const owner = await (await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ADMIN_USER, password: adminPass }),
    })).json();
    TARGET_WRITES.ownerToken = owner?.token || TARGET_WRITES.ownerToken;
    let promote = null;
    if (modReg?.token && owner?.token) {
      promote = await (await fetch(`${BASE}/api/admin/users/${modReg.user.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({ op: 'role', role: 'mod' }),
      })).json();
    }
    const modReady = !!(promote?.ok && promote.role === 'mod');
    check(modReady, 'a moderator account is ready for the panel checks', modReady ? modName
      : !owner?.token ? `admin sign-in failed: ${owner?.message || 'no token'}`
      : !modReg?.token ? `registration failed: ${modReg?.message || 'no token'}`
      : `promotion failed: ${promote?.message || 'refused'}`);
    if (modReady) {
      // The panel mounts twice (the lazily imported admin view re-renders once
      // after registering), and that second mount resets its report filter to
      // Open. Every assertion below re-selects the view it is about to read
      // instead of trusting one to survive the action in between.
      const filterTo = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('#admin-body .admin-toolbar button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
      /** Select a filter, let its fetch paint, then test the list - retried, so
       *  a re-mount mid-check cannot strand the wrong view. */
      const viewHolds = async (label, predicate, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          await filterTo(label);
          await sleep(300);
          if (await evaluate(predicate)) return true;
        }
        return false;
      };
      // A player's report for the moderator to resolve through the panel
      // below - the tabs must do real work, not just render. The text is
      // unique so both the card and the server record are unambiguous.
      const filedText = `panel-resolve-${Date.now().toString(36)}`;
      TARGET_WRITES.reports.push(filedText);
      // The invite-link sign-in scenario logged this account out and back in,
      // so the register token from the top of the run is revoked by now - a
      // fresh sign-in is what a returning player would really have.
      const filer = await (await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, password: 'browser-pass-2026' }),
      })).json();
      const filed = await (await fetch(`${BASE}/api/report`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${filer?.token || ''}` },
        body: JSON.stringify({ kind: 'bug', text: filedText, target: 'browser-reload-check' }),
      })).json();
      check(filed?.ok === true, 'a player files a report for the moderator inbox', filed?.message || JSON.stringify(filed));
      try {
        await seedStoredState({ token: modReg.token, view: 'home' });
        await cdp.send('Page.navigate', { url: `${BASE}/admin` }, session);
        await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app shell at /admin', 25000);
        await until(`document.querySelector('.admin-tabs')`, 'the moderator admin panel');

        const tabs = await evaluate(`[...document.querySelectorAll('.admin-tabs button')].map((b) => b.textContent.trim())`);
        const want = ['👥 Players', '🎮 Rooms', '📨 Reports'];
        check(JSON.stringify(tabs) === JSON.stringify(want), 'the moderator panel lists exactly Players, Rooms and Reports', JSON.stringify(tabs));

        const head = await evaluate(`(() => { const card = document.querySelector('.admin-tabs')?.closest('.card'); return card ? { text: card.textContent, buttons: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })()`);
        check(!!head && head.text.includes('moderator') && !head.text.includes('owner/admin') && !head.buttons.some((t) => t.includes('Broadcast')),
          'the moderator is offered no owner-only actions', JSON.stringify(head));

        const problems = [];
        for (const id of ['players', 'rooms', 'reports']) {
          await evaluate(`(() => { document.querySelector('.admin-tabs .tab-${id}').click(); return true; })()`);
          try {
            await until(`(() => { const b = document.querySelector('#admin-body'); return !!b && !b.textContent.includes('Loading…'); })()`, `the ${id} tab to draw`, 12000);
          } catch (err) {
            problems.push(`${id}: ${err.message}`);
            continue;
          }
          const drawn = await evaluate(`(() => { const b = document.querySelector('#admin-body'); return { err: !!b.querySelector('.error'), text: b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) }; })()`);
          if (drawn.err) problems.push(`${id}: ${drawn.text}`);
        }
        check(problems.length === 0, 'every moderator tab renders without errors', problems.join('; ') || 'players, rooms and reports');

        // Resolve the player's report end-to-end through the panel: click
        // Resolve, watch the open inbox drop it, find it under the Resolved
        // filter with the moderator named, and confirm the server agrees.
        const clicked = await until(`(() => {
          const card = [...document.querySelectorAll('#admin-body .report-card')].find((c) => c.textContent.includes(${JSON.stringify(filedText)}) && c.textContent.includes(${JSON.stringify(name)}));
          if (!card) return false;
          const resolve = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Resolve');
          if (!resolve) return false;
          resolve.click();
          return true;
        })()`, 'the filed report and its Resolve button', 12000).then(() => true).catch(() => false);
        check(clicked, 'the filed report reaches the moderator inbox, attributed to its author, with a Resolve action');
        if (!clicked) {
          const bodyText = await evaluate(`(document.querySelector('#admin-body') || {}).textContent?.replace(/\\s+/g, ' ').trim().slice(0, 240) || 'no #admin-body'`).catch(() => 'no #admin-body');
          const mine = await (await fetch(`${BASE}/api/admin/reports?status=open&limit=120`, { headers: { authorization: `Bearer ${modReg.token}` } })).json().catch(() => null);
          const mineRec = (mine?.reports || []).find((r) => r.text === filedText);
          check(false, 'the report is resolved end-to-end through the panel', `the Resolve button never appeared; card on server: ${mineRec ? `yes, from ${mineRec.fromName}` : 'no'}; body: ${bodyText}`);
        } else {
          const dropped = await until(`!document.querySelector('#admin-body').textContent.includes(${JSON.stringify(filedText)})`, 'the resolved report to leave the open inbox', 10000).then(() => true).catch(() => false);
          check(dropped, 'resolving drops the report from the open inbox');

          const resolvedShown = await viewHolds('Resolved', `(() => {
            const card = [...document.querySelectorAll('#admin-body .report-card')].find((c) => c.textContent.includes(${JSON.stringify(filedText)}));
            return !!card && card.textContent.includes(${JSON.stringify(`resolved by ${modName}`)}) && [...card.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Reopen');
          })()`);
          check(resolvedShown, 'the Resolved filter shows the moderator as the resolver');

          const after = await (await fetch(`${BASE}/api/admin/reports?status=all&limit=200`, { headers: { authorization: `Bearer ${modReg.token}` } })).json().catch(() => null);
          const record = (after?.reports || []).find((r) => r.text === filedText);
          check(record?.status === 'resolved' && record?.resolvedBy === modName && !!record?.resolvedAt,
            'the server records the moderator as the resolver', JSON.stringify(record ? { status: record.status, resolvedBy: record.resolvedBy } : null));

          // And back again through the same panel: Reopen on the resolved card
          // must put the report back in the open state - on the server and in
          // both filter views.
          const readReport = async () => ((await (await fetch(`${BASE}/api/admin/reports?status=all&limit=200`, { headers: { authorization: `Bearer ${modReg.token}` } })).json().catch(() => null))?.reports || []).find((r) => r.text === filedText) || null;
          // Re-select the resolved view: the second mount may have happened since.
          await filterTo('Resolved');
          const reopened = await until(`(() => {
            const card = [...document.querySelectorAll('#admin-body .report-card')].find((c) => c.textContent.includes(${JSON.stringify(filedText)}));
            if (!card) return false;
            const reopen = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reopen');
            if (!reopen) return false;
            reopen.click();
            return true;
          })()`, 'the Reopen action on the resolved report', 10000).then(() => true).catch(() => false);
          check(reopened, 'the resolved report offers a Reopen action in the panel');
          // The round trip itself is a server fact, so poll it there; the two
          // panel views are asserted right below.
          let reopenedRecord = reopened ? await readReport() : null;
          for (let i = 0; i < 20 && reopenedRecord && reopenedRecord.status !== 'open'; i++) {
            await sleep(250);
            reopenedRecord = await readReport();
          }
          check(reopenedRecord?.status === 'open' && !reopenedRecord?.resolvedBy && !reopenedRecord?.resolvedAt,
            'the server clears the resolution when the report reopens',
            JSON.stringify(reopenedRecord ? { status: reopenedRecord.status, resolvedBy: reopenedRecord.resolvedBy || null, resolvedAt: reopenedRecord.resolvedAt || null } : null));

          const leftResolved = await viewHolds('Resolved', `!document.querySelector('#admin-body').textContent.includes(${JSON.stringify(filedText)})`);
          check(leftResolved, 'reopening drops the report from the Resolved filter');
          // Match the card's own actions, not its text: 'Reopen' contains 'open',
          // so only Resolve-without-Reopen proves it is back in the open state.
          const backOpen = await viewHolds('Open', `(() => {
            const card = [...document.querySelectorAll('#admin-body .report-card')].find((c) => c.textContent.includes(${JSON.stringify(filedText)}));
            if (!card) return false;
            const labels = [...card.querySelectorAll('button')].map((b) => b.textContent.trim());
            return labels.includes('Resolve') && !labels.includes('Reopen');
          })()`);
          check(backOpen, 'the reopened report is back in the open inbox with its Resolve action');
        }
      } catch (err) {
        check(false, 'the moderator admin panel opens', err.message);
      }
    }

    // Owner's counterpart: the same panel must offer the whole console and the
    // Broadcast action. The owner token was fetched for the promotion above;
    // if sign-in failed the moderator checks already said so.
    if (owner?.token) {
      console.log('\nOwner view of the admin console…');
      try {
        await seedStoredState({ token: owner.token, view: 'home' });
        await cdp.send('Page.navigate', { url: `${BASE}/admin` }, session);
        await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the app shell at /admin for the owner', 25000);
        await until(`document.querySelector('.admin-tabs')`, 'the owner admin panel');

        const tabs = await evaluate(`[...document.querySelectorAll('.admin-tabs button')].map((b) => b.textContent.trim())`);
        const want = ['📊 Overview', '👥 Players', '🎛️ Site', '🎚️ Features', '🎮 Rooms', '📨 Reports', '💡 Ideas', '📜 Audit', '🤖 Discord bot'];
        check(JSON.stringify(tabs) === JSON.stringify(want), 'the owner panel lists all nine tabs', JSON.stringify(tabs));

        const head = await evaluate(`(() => { const card = document.querySelector('.admin-tabs')?.closest('.card'); return card ? { text: card.textContent, buttons: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })()`);
        check(!!head && head.text.includes('owner/admin') && !head.text.includes('moderator') && head.buttons.some((t) => t.includes('Broadcast')),
          'the owner sees the owner/admin badge and the Broadcast action', JSON.stringify(head));

        await evaluate(`(() => { const b = [...document.querySelectorAll('.admin-toolbar button')].find((x) => x.textContent.includes('Broadcast')); if (b) b.click(); return !!b; })()`);
        const composer = await until(`(() => { const m = document.querySelector('#modal'); const c = document.querySelector('#modal-card'); return !!m && !m.classList.contains('hidden') && !!c && c.textContent.includes('Send to everyone') && (c.querySelector('input')?.placeholder || '').includes('Message for everyone online'); })()`, 'the Broadcast composer', 8000).then(() => true).catch(() => false);
        check(composer, 'the Broadcast action opens the composer for everyone online');
        await evaluate(`(() => { document.querySelector('#modal-card .icon-btn')?.click(); return true; })()`);
        const dismissed = await until(`document.querySelector('#modal').classList.contains('hidden')`, 'the Broadcast composer to close', 5000).then(() => true).catch(() => false);
        check(dismissed, 'the composer closes without sending anything');

        // Scratch-only: send a real broadcast. It pops a toast for every live
        // client - this owner page included - and rewrites the announcement
        // banner. A target skips it: the toast would reach real players and
        // the banner would stay changed on the deployed site.
        if (!TARGET) {
          const broadcastText = `scratch-broadcast-${Date.now().toString(36)}`;
          await evaluate(`(() => { const b = [...document.querySelectorAll('.admin-toolbar button')].find((x) => x.textContent.includes('Broadcast')); if (b) b.click(); return !!b; })()`);
          const reopened = await until(`(() => { const m = document.querySelector('#modal'); const c = document.querySelector('#modal-card'); return !!m && !m.classList.contains('hidden') && !!c && c.textContent.includes('Send to everyone'); })()`, 'the Broadcast composer for the real send', 8000).then(() => true).catch(() => false);
          check(reopened, 'the Broadcast composer reopens for the scratch send');
          if (reopened) {
            await evaluate(`(() => { const i = document.querySelector('#modal-card input.input'); if (!i) return false; i.value = ${JSON.stringify(broadcastText)}; return true; })()`);
            await evaluate(`(() => { const b = [...document.querySelectorAll('#modal-card button')].find((x) => x.textContent.trim() === 'Send to everyone'); if (b) b.click(); return !!b; })()`);
            // The text toast is the round trip: the server's notify reaches
            // this page's own socket. The local 'Broadcast sent' toast alone
            // would only prove the click, not that anything was delivered.
            await expectToast(broadcastText, 'the sent broadcast reaches the sender as a toast');
            await expectTrue(`(() => { const a = document.querySelector('#announcement'); return !!a && !a.classList.contains('hidden') && a.textContent.includes(${JSON.stringify(broadcastText)}); })()`, 'the broadcast becomes the site announcement banner');
            const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json()).catch(() => null);
            check(meta?.config?.announcement === broadcastText, 'the server persists the broadcast as the announcement', JSON.stringify(meta?.config?.announcement ?? null));
          }
        }

        const problems = [];
        for (const id of ['overview', 'players', 'site', 'features', 'rooms', 'reports', 'ideas', 'audit', 'bot']) {
          await evaluate(`(() => { document.querySelector('.admin-tabs .tab-${id}').click(); return true; })()`);
          try {
            await until(`(() => { const b = document.querySelector('#admin-body'); return !!b && !b.textContent.includes('Loading…'); })()`, `the ${id} tab to draw`, 12000);
          } catch (err) {
            problems.push(`${id}: ${err.message}`);
            continue;
          }
          const drawn = await evaluate(`(() => { const b = document.querySelector('#admin-body'); return { err: !!b.querySelector('.error'), text: b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) }; })()`);
          if (drawn.err) problems.push(`${id}: ${drawn.text}`);
        }
        check(problems.length === 0, 'every owner tab renders without errors', problems.join('; ') || 'all nine tabs');

        // The Features tab's schedule editor, driven like an owner would: open
        // the Chat row's editor, check the defaults, save a whole-day window
        // (00:00-00:00 needs no clock wait) and watch the row badge itself,
        // then clear it from the same dialog.  The clear runs outside the
        // nesting, so a failure can never leave a schedule ticking behind for
        // the player checks that follow.
        const chatRow = `(() => [...document.querySelectorAll('#admin-body .feature-row')].find((r) => r.textContent.includes('Chat channels')))()`;
        const ownerAuth = { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` };
        const flipFeature = (body) => fetch(`${BASE}/api/admin/features`, {
          method: 'POST', headers: ownerAuth, body: JSON.stringify(body),
        }).then((r) => r.json()).catch(() => null);
        // Whatever chat's schedule was before this check (a target may have a
        // real one), so the run can put it back exactly.
        const preFeatures = await fetch(`${BASE}/api/admin/features`, { headers: { authorization: `Bearer ${owner.token}` } }).then((r) => r.json()).catch(() => null);
        const chatBefore = (preFeatures?.features || []).find((f) => f.id === 'chat') || null;
        await evaluate(`(() => { document.querySelector('.admin-tabs .tab-features').click(); return true; })()`);
        const rowsDrawn = await until(`(() => { const row = ${chatRow}; return !!row && [...row.querySelectorAll('button')].some((b) => b.textContent.includes('Schedule')); })()`, 'the Features rows with their schedule action', 12000).then(() => true).catch(() => false);
        check(rowsDrawn, 'the console draws a schedule action on a feature row');

        // The keep-floor picker every row carries, driven like an owner would:
        // the rungs come from the server, the stored value is selected, and
        // choosing one posts it back.
        if (rowsDrawn) {
          const picker = await evaluate(`(() => { const row = ${chatRow}; const sel = row && row.querySelector('.keep-picker select'); return sel ? { value: sel.value, options: [...sel.options].map((o) => o.value) } : null; })()`);
          check(!!picker && picker.options.join(',') === 'user,vip,mod,admin,owner', 'the console offers the server keep-floor ladder', JSON.stringify(picker));
          check(picker?.value === (chatBefore?.minRole || 'mod'), 'the picker shows the stored keep-floor', String(picker?.value));
          const chosen = await until(`(() => { const row = ${chatRow}; const sel = row && row.querySelector('.keep-picker select'); if (!sel) return false; sel.value = 'vip'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`, 'the keep-floor picker to change', 8000).then(() => true).catch(() => false);
          const stored = chosen && await until(
            `fetch('/api/admin/features', { headers: { authorization: 'Bearer ${owner.token}' } }).then((r) => r.json()).then((d) => (d.features || []).find((f) => f.id === 'chat')?.minRole === 'vip')`,
            'the keep-floor to reach the server', 8000,
          ).then((v) => v === true).catch(() => false);
          check(stored, 'choosing a keep-floor posts it to the server');

          // With chat off and kept for VIPs, the row says so; keeping it for
          // everyone then badges it off for guests only.
          await flipFeature({ id: 'chat', on: false });
          const vipBadge = await until(`(() => { const row = ${chatRow}; return !!row && row.textContent.includes('off except VIP+'); })()`, 'the row to badge a VIP keep-floor', 8000).then(() => true).catch(() => false);
          check(vipBadge, 'a role-kept row badges who still gets the feature');
          await flipFeature({ id: 'chat', on: false, minRole: 'user' });
          const guestBadge = await until(`(() => { const row = ${chatRow}; return !!row && row.textContent.includes('off for guests'); })()`, 'the row to badge a players-kept feature', 8000).then(() => true).catch(() => false);
          check(guestBadge, 'a players-kept row says guests are the ones shut out');
          await flipFeature({ id: 'chat', on: true, hidden: false, minRole: chatBefore?.minRole || 'mod' });
          const pickerBack = await until(`(() => { const row = ${chatRow}; const sel = row && row.querySelector('.keep-picker select'); return !!sel && sel.value === '${chatBefore?.minRole || 'mod'}'; })()`, 'the picker to follow the restored floor', 8000).then(() => true).catch(() => false);
          check(pickerBack, 'the row follows the keep-floor back when it is restored');
        }
        if (rowsDrawn) {
          // Every click retries while the panel rebinds: each save pushes a
          // config frame, which redraws the console underneath the check.
          // The row's one button is the schedule action; after a save its label
          // is the window ("🕒 00:00–00:00"), so match the position, not the text.
          const openEditor = async (label) => until(`(() => { const row = ${chatRow}; if (!row) return false; const b = row.querySelector('.feature-switches button'); if (!b) return false; b.click(); return true; })()`, label, 8000).then(() => true).catch(() => false);
          const opened = await openEditor('the schedule editor to open');
          const editorOpen = opened && await until(`document.querySelector('#modal-card .day-chips .day-chip')`, 'the schedule editor to draw', 8000).then(() => true).catch(() => false);
          check(editorOpen, 'the schedule editor opens with its day chips');
          if (editorOpen) {
            const painted = await evaluate(`(() => { const chips = [...document.querySelectorAll('#modal-card .day-chip')]; const times = [...document.querySelectorAll('#modal-card input[type="time"]')]; return { chips: chips.length, on: chips.filter((c) => c.classList.contains('on')).length, times: times.map((t) => t.value) }; })()`);
            check(painted.chips === 7 && painted.on >= 1 && painted.times.length === 2, 'the editor offers seven day chips and both times', JSON.stringify(painted));
            await evaluate(`(() => {
              const times = [...document.querySelectorAll('#modal-card input[type="time"]')];
              const set = (input, value) => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
              const box = document.querySelector('#modal-card input[type="checkbox"]');
              if (box && !box.checked) box.click();
              for (const chip of document.querySelectorAll('#modal-card .day-chip')) if (!chip.classList.contains('on')) chip.click();
              set(times[0], '00:00'); set(times[1], '00:00');
              return true;
            })()`);
            const saved = await until(`(() => { const b = [...document.querySelectorAll('#modal-card button')].find((x) => x.textContent.trim() === 'Save schedule'); if (!b) return false; b.click(); return true; })()`, 'the Save schedule action', 8000).then(() => true).catch(() => false);
            check(saved, 'the editor saves the schedule');
            const badged = await until(`(() => { const row = ${chatRow}; return !!row && row.textContent.includes('closed by schedule'); })()`, 'the row to badge its scheduled close', 8000).then(() => true).catch(() => false);
            check(badged, 'saving a schedule badges the row as closed');

            const reopenedEditor = await openEditor('the schedule button to reopen the editor');
            check(reopenedEditor, 'a saved schedule reopens its editor');
            const clearable = await until(`(() => { const b = [...document.querySelectorAll('#modal-card button')].find((x) => x.textContent.trim() === 'Clear schedule'); if (!b) return false; b.click(); return true; })()`, 'the Clear schedule action', 8000).then(() => true).catch(() => false);
            check(clearable, 'a stored schedule offers Clear schedule in the editor');
            const unbadged = await until(`(() => { const row = ${chatRow}; return !!row && !row.textContent.includes('closed by schedule'); })()`, 'the row badge to clear', 8000).then(() => true).catch(() => false);
            check(unbadged, 'clearing the schedule removes the badge');
          }
          await fetch(`${BASE}/api/admin/features`, { method: 'POST', headers: ownerAuth, body: JSON.stringify({ id: 'chat', schedule: chatBefore?.hasSchedule ? chatBefore.schedule : null, minRole: chatBefore?.minRole || 'mod' }) }).catch(() => null);
        }
      } catch (err) {
        check(false, 'the owner admin panel opens', err.message);
      }
    }

    // A switch flipped in the console has to reach a player's browser: the tab
    // disappears, a deep link shows the polite door instead of a refusal, and
    // restoring the switch brings the tab back live - no reload anywhere.
    if (owner?.token) {
      console.log('\nFeature switches reaching a player…');
      const ownerAuth = { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` };
      const flip = (body) => fetch(`${BASE}/api/admin/features`, { method: 'POST', headers: ownerAuth, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
      try {
        TARGET_WRITES.features.push('chat', 'changelog');
        // Chat's keep-floor before this run, so a target with a real one is put
        // back exactly (scratch runs find the staff default).
        const chatPre = (await fetch(`${BASE}/api/admin/features`, { headers: { authorization: `Bearer ${owner.token}` } }).then((r) => r.json()).catch(() => null))?.features?.find((f) => f.id === 'chat') || null;
        const chatFloor = chatPre?.minRole || 'mod';
        const player = await (await fetch(`${BASE}/api/auth/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, password: 'browser-pass-2026' }),
        })).json();
        if (!player?.token) throw new Error('the player account could not sign in for the switch check');

        await flip({ id: 'chat', on: false });
        await flip({ id: 'changelog', hidden: true });
        await seedStoredState({ token: player.token, view: 'home' });
        await cdp.send('Page.navigate', { url: `${BASE}/` }, session);
        await until(`!!document.querySelector('.nav [data-feature="chat"]') && !document.querySelector('#app').classList.contains('hidden')`, 'the player app shell', 25000);

        const flags = Object.fromEntries((await evaluate(`[...document.querySelectorAll('.nav [data-feature]')].map((t) => [t.dataset.feature, t.classList.contains('hidden')])`)));
        check(flags.chat === true, 'a switched-off feature leaves the player navigation', JSON.stringify(flags));
        check(flags.changelog === true, 'a hidden feature leaves the player navigation', JSON.stringify(flags));
        check(flags.friends === false && flags.downloads === false, 'untouched features keep their tab', JSON.stringify(flags));

        await evaluate(`(() => { window.__setView('chat'); return true; })()`);
        await until(`(document.querySelector('#view') || {}).textContent?.includes('Turned off')`, 'the turned-off card for the player', 8000);
        const card = await evaluate(`document.querySelector('#view').textContent.replace(/\\s+/g, ' ').trim().slice(0, 80)`);
        check(/Chat has been switched off/.test(card), 'a deep link shows the turned-off card, not a refusal', card);

        await flip({ id: 'chat', on: true, hidden: false });
        await flip({ id: 'changelog', on: true, hidden: false });
        const back = await until(`(() => { const tab = document.querySelector('.nav [data-feature="chat"]'); return !!tab && !tab.classList.contains('hidden'); })()`, 'the chat tab to return once the switch is back on', 10000).then(() => true).catch(() => false);
        check(back, 'restoring a switch brings the tab back without a reload');

        // Role keep-floors, seen from the player's own tab: the player's account
        // is a plain user, so chat switched off but kept for players stays with
        // them, raising the floor to VIP takes the tab away live, and lowering
        // it brings the tab back - no reload anywhere.  The deep link then says
        // who the feature is kept for instead of blaming a plain switch.
        console.log('\nRole keep-floors reaching a player…');
        await flip({ id: 'chat', on: false, minRole: 'user' });
        const keptForPlayers = await until(`(() => { const t = document.querySelector('.nav [data-feature="chat"]'); return !!t && !t.classList.contains('hidden'); })()`, 'the chat tab to stay while the switch is off but kept for players', 10000).then(() => true).catch(() => false);
        check(keptForPlayers, 'a feature kept for players stays for a player while it is off');
        await flip({ id: 'chat', minRole: 'vip' });
        const raised = await until(`(() => { const t = document.querySelector('.nav [data-feature="chat"]'); return !!t && t.classList.contains('hidden'); })()`, 'the chat tab to leave when the keep-floor rises', 10000).then(() => true).catch(() => false);
        check(raised, 'raising the keep-floor above the player takes the tab away live');
        await evaluate(`(() => { window.__setView('home'); return true; })()`);
        await evaluate(`(() => { window.__setView('chat'); return true; })()`);
        const keptCard = await until(`(document.querySelector('#view') || {}).textContent?.includes('kept for VIPs')`, 'the kept-for card on the player deep link', 8000)
          .then(() => evaluate(`document.querySelector('#view').textContent.replace(/\\s+/g, ' ').trim().slice(0, 120)`)).catch(() => '');
        check(/kept for VIPs/.test(keptCard), 'the deep link names the role the feature is kept for', keptCard);
        await flip({ id: 'chat', minRole: 'user' });
        const lowered = await until(`(() => { const t = document.querySelector('.nav [data-feature="chat"]'); return !!t && !t.classList.contains('hidden'); })()`, 'the chat tab to come back when the keep-floor drops', 10000).then(() => true).catch(() => false);
        check(lowered, 'lowering the keep-floor back brings the tab without a reload');
        // Back to the stored floor before the schedule checks, which speak for
        // every viewer (the loop below and the target cleanup restore the rest).
        await flip({ id: 'chat', on: true, hidden: false, minRole: chatFloor });
        const floorReset = await until(`(() => { const t = document.querySelector('.nav [data-feature="chat"]'); return !!t && !t.classList.contains('hidden'); })()`, 'the chat tab after the keep-floor is restored', 10000).then(() => true).catch(() => false);
        check(floorReset, 'restoring the keep-floor leaves the player with the tab');

        // A schedule closes chat on its own. 00:00-00:00 is the whole day, so
        // this window is open in any timezone (a target included) and needs no
        // clock wait: the player's tab must lose Chat and the deep link must
        // say when it comes back, with no reload anywhere.
        console.log('\nScheduled switches reaching a player…');
        await flip({ id: 'chat', schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '00:00' } });
        const scheduledAway = await until(`(() => { const t = document.querySelector('.nav [data-feature="chat"]'); return !!t && t.classList.contains('hidden'); })()`, 'the chat tab to leave the player during its scheduled window', 10000).then(() => true).catch(() => false);
        check(scheduledAway, 'a scheduled close hides the player navigation without a reload');
        await evaluate(`(() => { window.__setView('chat'); return true; })()`);
        const scheduledCard = await until(`(document.querySelector('#view') || {}).textContent?.includes('closed until')`, 'the scheduled closed card for the player', 8000)
          .then(() => evaluate(`document.querySelector('#view').textContent.replace(/\\s+/g, ' ').trim().slice(0, 140)`)).catch(() => '');
        check(/closed until/i.test(scheduledCard) && /scheduled these hours/.test(scheduledCard), 'the deep link says when the feature comes back', scheduledCard);

        // On the scratch server the whole cycle is watched live: a window a few
        // seconds out must hide the tab when it opens and bring it back when it
        // ends - the player never asked for anything.
        if (!TARGET) {
          const clockOf = (t) => new Date(t).toTimeString().slice(0, 8);
          await flip({ id: 'chat', schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], from: clockOf(Date.now() + 3000), to: clockOf(Date.now() + 12000) } });
          const closedLive = await until(`(() => { const t = document.querySelector('.nav [data-feature="chat"]'); return !!t && t.classList.contains('hidden'); })()`, 'the tab to disappear when the window opens', 20000).then(() => true).catch(() => false);
          const reopenedLive = await until(`(() => { const t = document.querySelector('.nav [data-feature="chat"]'); return !!t && !t.classList.contains('hidden'); })()`, 'the tab to return when the window ends', 20000).then(() => true).catch(() => false);
          check(closedLive && reopenedLive, 'the arcade closes and reopens the tab at the scheduled times');
        }

        await flip({ id: 'chat', on: true, hidden: false, schedule: null, minRole: 'mod' });
        const clearedSchedule = await until(`(() => { const t = document.querySelector('.nav [data-feature="chat"]'); return !!t && !t.classList.contains('hidden'); })()`, 'the chat tab after the schedule is cleared', 10000).then(() => true).catch(() => false);
        check(clearedSchedule, 'clearing the schedule brings the tab back');
      } catch (err) {
        check(false, 'the feature-switch checks', err.message);
        await flip({ id: 'chat', on: true, hidden: false, schedule: null, minRole: 'mod' });
        await flip({ id: 'changelog', on: true, hidden: false, schedule: null, minRole: 'mod' });
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * the flow
 * ------------------------------------------------------------------ */

async function main() {
  const browser = findBrowser();
  if (!browser) {
    skipped = true;
    console.log('⤼ browser reload check skipped: no Chromium/Edge/Chrome found (set MEMES_BROWSER to a binary path to run it)');
    return;
  }
  console.log(`Browser: ${browser}`);
  if (!PLAIN) console.log(`Fault injection: catalog +${CATALOG_DELAY}ms, engine +${ENGINE_DELAY}ms (forces the historical mount race)`);
  if (TARGET) {
    console.log(`\nTarget: ${BASE} (deployed build - no scratch server)`);
    const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
    if (!check(health?.ok === true, 'the target answers the arcade /api/health', health ? `status ${health.status}, ${health.engines} engines` : 'unreachable or not the arcade API')) return;
  } else {
    await startServer();
  }
  await launchBrowser(browser);

  const signIn = await (await fetch(`${BASE}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  if (!signIn?.token) throw new Error(`guest sign-in failed: ${JSON.stringify(signIn)}`);
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${signIn.token}` } })).json();
  const userId = me?.user?.id;
  check(!!userId, 'a guest account is ready');
  TARGET_WRITES.accounts.push({ id: userId, name: me?.user?.name });

  // Hand the client its session, then boot on it.
  await seedStoredState({ token: signIn.token, view: 'home' });
  await cdp.send('Page.navigate', { url: `${BASE}/` }, session);
  await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the signed-in app shell', 25000);
  check(true, 'the client boots signed in from a restored session');

  await runRegressionChecks();

  // Hand the browser back to the playing guest for the realtime scenario.
  console.log('\nSigning back in as the play-testing guest…');
  await seedStoredState({ token: signIn.token, view: 'home' });
  await cdp.send('Page.navigate', { url: `${BASE}/` }, session);
  await until(`!document.querySelector('#app').classList.contains('hidden')`, 'the play-testing app shell', 25000);
  check(true, 'the play-testing session is restored');

  console.log('\nHosting a realtime room through the UI…');
  await until(`document.querySelector('.game-card')`, 'the catalog to render');
  check(await clickText('Browse all games'), 'opened the games catalog');
  await until(`[...document.querySelectorAll('.game-card')].some((c) => c.textContent.includes('Ping Pong'))`, 'the Ping Pong card');
  await evaluate(`(() => { const card = [...document.querySelectorAll('.game-card')].find((c) => c.textContent.includes('Ping Pong')); [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Play').click(); return true; })()`);
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Online room'))`, 'the play-options modal');
  check(await clickText('Online room'), 'created an online room');
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Add bot'))`, 'the room lobby');
  // The default first-to-5 would end mid-check with an idle host paddle.
  await setRoomTarget(signIn.token, 99);
  check(await clickText('Add bot'), 'added a bot seat');
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Start game' && !b.disabled)`, 'Start game to enable');
  check(await clickText('Start game'), 'started the match');

  const streaming = await expectStreaming('the host stage mounts and streams');
  if (!streaming) return;

  const firstRoom = (await roomsNow()).find((r) => r.host === userId);
  check(!!firstRoom && firstRoom.status === 'playing', 'the room reports itself as playing', firstRoom?.code || 'no room');
  if (!firstRoom) return;
  const tickA = firstRoom.updatedAt;
  await sleep(900);
  const tickB = (await roomsNow()).find((r) => r.id === firstRoom.id)?.updatedAt || 0;
  check(tickB > tickA, "the host's snapshots reach the server", `+${tickB - tickA}ms`);

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    console.log(`\nReload ${cycle}/${CYCLES}: refreshing the host mid-match…`);
    await cdp.send('Page.reload', {}, session);
    try {
      await until(`!document.querySelector('#app').classList.contains('hidden')`, `reload ${cycle}: the app shell`, 25000);
      check(true, `reload ${cycle}: the app comes back signed in`);
    } catch (err) {
      check(false, `reload ${cycle}: the app comes back signed in`, err.message);
      continue;
    }
    const resumed = await expectStreaming(`reload ${cycle}: the stream resumes`);
    if (!resumed) {
      const page = await evaluate(`({
        status: (document.querySelector('#status-room') || {}).textContent || null,
        hud: (document.querySelector('.net-hud') || {}).textContent || null,
        stage: (document.querySelector('#game-stage') || {}).textContent?.slice(0, 120) || null,
      })`).catch(() => null);
      console.log(`    [diag] page: ${JSON.stringify(page)}`);
      const rooms = await roomsNow().catch(() => []);
      console.log(`    [diag] rooms: ${JSON.stringify(rooms.map((r) => ({ code: r.code, status: r.status, updatedAgo: Date.now() - r.updatedAt, players: r.players.map((p) => p.name) })))}`);
    }
    const canvas = await evaluate(`!!document.querySelector('#game-stage canvas')`).catch(() => false);
    check(!!canvas, `reload ${cycle}: the match canvas is back`);
    const roomA = (await roomsNow()).find((r) => r.id === firstRoom.id);
    const t1 = roomA?.updatedAt || 0;
    await sleep(900);
    const roomB = (await roomsNow()).find((r) => r.id === firstRoom.id);
    const t2 = roomB?.updatedAt || 0;
    check(!!roomB && roomB.status === 'playing' && roomB.code === firstRoom.code && t2 > t1,
      `reload ${cycle}: the room survives and keeps receiving snapshots`, `+${t2 - t1}ms`);
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

try {
  await main();
} catch (err) {
  failures++;
  console.error(`\nBrowser reload check crashed: ${err.stack || err.message}`);
} finally {
  await closeBrowser();
  await cleanupTarget();
  // The scratch server must be gone, not merely signalled, before its data dir
  // goes: its shutdown flush would write the dir straight back.
  await stopChild(server);
  // Leave no scratch data behind: the stray-state check fails the build on any
  // suite that does (see tools/leak-check.mjs).
  rmSync(DATA, { recursive: true, force: true });
}

const where = TARGET ? BASE : `scratch server on port ${PORT}`;
if (!skipped) console.log(`\n${failures ? `✗ ${failures} failure(s), ${passed} passed (${where})` : `✓ all ${passed} browser reload checks passed (${where})`}\n`);
process.exit(failures ? 1 : 0);
