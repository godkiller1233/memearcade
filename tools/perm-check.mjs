#!/usr/bin/env node
/**
 * Permission-matrix check.
 *
 *   npm run permcheck
 *
 * Boots a scratch arcade, makes one account of every role that matters - a
 * plain user, a moderator (promoted by the seeded owner) and the owner/admin
 * itself - then walks every staff-gated admin endpoint and asserts the exact
 * status each role is owed:
 *
 *   no session   -> 401   (requireAuth: you are not signed in at all)
 *   plain user   -> 403   (signed in, but below the lowest staff rung)
 *   moderator    -> 200 on a moderator-level route, 403 on an admin-only one
 *   admin/owner  -> 200 on every route
 *
 * The distinction matters: a moderator *is* staff, so the phrase "staff only"
 * covers two levels on this server. requireStaff() defaults to ROLES.mod, so
 * most routes let a moderator through, while config, broadcast, idea triage and
 * the bot secret demand ROLES.admin. The matrix encodes each route's real level
 * (below), which is what makes a mis-levelled guard fail loudly: lower a guard
 * to the wrong rung and either the moderator gets a 200 where the table says
 * 403, or an admin's call is refused where the table says 200.
 *
 * Each arm gets its own resource where the request mutates one (a fresh room
 * per close), so one arm never steals the fixture the next arm needs.  The
 * scratch server is chosen by bind-probing the suite's port range so a stale
 * server is skipped instead of booted onto (see startLocal), and its data dir
 * is removed on the way out.
 *
 * This is a scratch-only suite: promoting a moderator needs the owner password
 * a scratch run seeds for itself. It is not pointed at a deployed target.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './lib/free-port.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT_RANGE = { start: 8931, span: 40 };
/** A scratch port, chosen in startLocal from the ones actually free. */
let PORT = null;
const DATA = path.join(ROOT, 'data', 'perm-check');
/** Scratch runs seed their own owner with this password. */
const SCRATCH_ADMIN_PASS = 'perm-admin-2026';
const ADMIN_USER = process.env.MEMES_ADMIN_USER || 'memegodmidas';

let failures = 0;
let passed = 0;
const check = (ok, label, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(` FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const note = (text) => console.log(`  note  ${text}`);

/* ------------------------------------------------------------------ *
 * tiny REST helper (same client headers the web client sends)
 * ------------------------------------------------------------------ */

let base = '';
const clientHeaders = {
  'x-client': 'web',
  'x-client-version': '1.0.0',
  'x-client-caps': 'chat,dm,friends,parties,lobby,spectate,bots,drawing,music,themes,keybinds,admin,replays,assets-custom',
};

async function api(method, route, body, asToken = '') {
  const headers = { ...clientHeaders };
  if (asToken) headers.authorization = `Bearer ${asToken}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 200) };
    }
  }
  return { status: res.status, ok: res.ok, payload };
}

/* ------------------------------------------------------------------ *
 * scratch server
 * ------------------------------------------------------------------ */

let child = null;

async function waitForHealth(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function startLocal() {
  rmSync(DATA, { recursive: true, force: true });
  PORT = await pickFreePort(PORT_RANGE);
  console.log(`\nBooting a scratch server on port ${PORT}…`);
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MEMES_PORT: String(PORT),
      MEMES_HOST: '127.0.0.1',
      MEMES_DATA: DATA,
      MEMES_PLATFORM: 'perm-check',
      MEMES_ADMIN_PASS: process.env.MEMES_ADMIN_PASS || SCRATCH_ADMIN_PASS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
  base = `http://127.0.0.1:${PORT}`;
  const alive = await waitForHealth(base);
  if (!alive) throw new Error('the scratch server never answered /api/health');
}

function stopLocal() {
  if (child) {
    try {
      child.kill();
    } catch {}
    child = null;
  }
}

/* ------------------------------------------------------------------ *
 * the matrix
 * ------------------------------------------------------------------ */

/** The owner/admin password a scratch run seeded, or MEMES_ADMIN_PASS if set. */
const adminPass = process.env.MEMES_ADMIN_PASS || SCRATCH_ADMIN_PASS;
const stamp = Date.now().toString(36);

let ownerToken = '';
let userToken = '';
let modToken = '';
let plainUserId = '';
let reportId = '';
let suggestionId = '';
let gameId = '';

/**
 * The staff-gated routes, each with the level its guard must enforce.
 * `path`/`body` may be async so a route can mint a fresh fixture per call -
 * the room close consumes the room, so every arm gets its own.
 */
const ROUTES = [
  { id: 'GET  /api/admin/overview', level: 'mod', method: 'GET', path: () => '/api/admin/overview' },
  { id: 'GET  /api/admin/users', level: 'mod', method: 'GET', path: () => '/api/admin/users' },
  {
    id: 'POST /api/admin/users/:id', level: 'mod', method: 'POST',
    path: () => `/api/admin/users/${plainUserId}`, body: () => ({ op: 'grant', xp: 0, coins: 0 }),
  },
  { id: 'GET  /api/admin/audit', level: 'mod', method: 'GET', path: () => '/api/admin/audit' },
  { id: 'GET  /api/admin/reports', level: 'mod', method: 'GET', path: () => '/api/admin/reports' },
  {
    id: 'POST /api/admin/reports/:id', level: 'mod', method: 'POST',
    path: () => `/api/admin/reports/${reportId}`, body: () => ({ op: 'resolve' }),
  },
  { id: 'GET  /api/admin/rooms', level: 'mod', method: 'GET', path: () => '/api/admin/rooms' },
  {
    id: 'POST /api/admin/rooms/:id', level: 'mod', method: 'POST',
    path: () => freshRoomPath(), body: () => ({ op: 'close' }),
  },
  { id: 'POST /api/admin/config', level: 'admin', method: 'POST', path: () => '/api/admin/config', body: () => ({}) },
  {
    id: 'POST /api/admin/broadcast', level: 'admin', method: 'POST',
    path: () => '/api/admin/broadcast', body: () => ({ text: 'perm-matrix probe' }),
  },
  {
    id: 'POST /api/admin/suggestions/:id', level: 'admin', method: 'POST',
    path: () => `/api/admin/suggestions/${suggestionId}`, body: () => ({ op: 'update', status: 'planned' }),
  },
  { id: 'GET  /api/bot/secret', level: 'admin', method: 'GET', path: () => '/api/bot/secret' },
];

/** Host a throwaway room as the plain user and return its admin-panel id. */
async function freshRoomPath() {
  const created = await api('POST', '/api/rooms', { gameId, visibility: 'private' }, userToken);
  const code = created.payload?.code || created.payload?.room?.code;
  // The create response carries the room, but the admin list is the id the
  // close route actually reads (ctx.params.id), so resolve it the same way.
  const list = await api('GET', '/api/admin/rooms', undefined, ownerToken);
  const room = (list.payload?.rooms || []).find((r) => r.code === code || r.id === code || r.id === created.payload?.room?.id);
  return `/api/admin/rooms/${room?.id || created.payload?.room?.id || code}`;
}

/** One matrix cell: hit the route as `token` and assert the status it is owed. */
async function arm(route, roleLabel, token, expected) {
  const routePath = await route.path();
  const body = route.body ? await route.body() : undefined;
  const res = await api(route.method, routePath, body, token);
  const ok = res.status === expected;
  check(ok, `${route.id}  ·  ${roleLabel} → ${expected}`, ok ? '' : `got ${res.status}${res.payload?.message ? ` (${res.payload.message})` : ''}`);
}

async function run() {
  console.log(`\nPermission matrix against ${base}\n`);

  /* setup: one account per role, plus the fixtures the body-taking routes need. */

  const ownerLogin = await api('POST', '/api/auth/login', { name: ADMIN_USER, password: adminPass });
  ownerToken = ownerLogin.payload?.token || '';
  check(!!ownerToken, 'the owner (admin) account signs in', ownerLogin.payload?.message);

  const userReg = await api('POST', '/api/auth/register', { name: `perm-user-${stamp}`, password: 'perm-pass-2026' });
  userToken = userReg.payload?.token || '';
  plainUserId = userReg.payload?.user?.id || '';
  check(!!userToken && !!plainUserId, 'a plain user account registers', userReg.payload?.message);

  const modReg = await api('POST', '/api/auth/register', { name: `perm-mod-${stamp}`, password: 'perm-pass-2026' });
  modToken = modReg.payload?.token || '';
  const modId = modReg.payload?.user?.id || '';
  check(!!modToken && !!modId, 'a second account registers to become the moderator', modReg.payload?.message);

  if (ownerToken && modId) {
    const promoted = await api('POST', `/api/admin/users/${modId}`, { op: 'role', role: 'mod' }, ownerToken);
    check(promoted.ok && promoted.payload?.role === 'mod', 'the owner promotes the second account to moderator', promoted.payload?.message);
  } else {
    check(false, 'the owner promotes the second account to moderator', 'no owner session or moderator id to work with');
  }

  // Fixtures for the routes that address a resource.
  const report = await api('POST', '/api/report', { text: 'Permission-matrix fixture report.', kind: 'bug' }, userToken);
  check(report.ok, 'a report exists for the report-triage route', report.payload?.message);
  if (ownerToken) {
    const inbox = await api('GET', '/api/admin/reports?status=all&limit=1', undefined, ownerToken);
    reportId = inbox.payload?.reports?.[0]?.id || '';
  }
  check(!!reportId, 'the newest open report id is known', reportId ? '' : 'the inbox did not return one');

  const idea = await api('POST', '/api/suggestions', { title: 'Permission-matrix fixture', text: 'Filed by the perm suite to exercise the admin-only triage route.', category: 'feature' }, userToken);
  suggestionId = idea.payload?.suggestion?.id || '';
  check(!!suggestionId, 'an idea exists for the admin-only triage route', idea.payload?.message);

  const games = await api('GET', '/api/games');
  gameId = (games.payload?.games || []).find((g) => g.playable)?.id || '';
  check(!!gameId, 'a playable game is available to host the room fixture', gameId ? '' : 'no playable game in /api/games');

  /* the matrix itself */

  if (!ownerToken || !userToken || !modToken || !reportId || !suggestionId || !gameId) {
    check(false, 'the matrix runs', 'setup did not produce every account and fixture');
    return;
  }

  for (const route of ROUTES) {
    await arm(route, 'no session', '', 401);
    await arm(route, 'plain user', userToken, 403);
    await arm(route, 'moderator ', modToken, route.level === 'admin' ? 403 : 200);
    await arm(route, 'admin     ', ownerToken, 200);
    note(`${route.id} is ${route.level === 'admin' ? 'admin-only' : 'moderator-level'} — table verified`);
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

let exitCode = 0;
try {
  await startLocal();
  await run();
} catch (err) {
  failures++;
  console.error(`\n✗ ${err?.message || err}`);
} finally {
  stopLocal();
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '✓' : '✗'} ${passed} passed, ${failures} failed\n`);
exitCode = failures === 0 ? 0 : 1;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopLocal();
    rmSync(DATA, { recursive: true, force: true });
    process.exit(130);
  });
}

process.exit(exitCode);
