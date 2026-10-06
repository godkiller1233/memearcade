#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 *   npm run smoke                        # boots its own server on a spare port
 *   npm run smoke -- https://arcade.com  # tests a deployed instance instead
 *
 * A deployed build may also arrive as --target URL or MEMES_TARGET - the forms
 * the realtime and browser suites use and the CI target input sets. A target
 * is health-gated before any check touches it.
 *
 * Signs in as a guest, lists games, opens a room, plays a legal move and checks
 * the desktop downloads are intact. This is the "would a real player be fine?"
 * check - it exercises the same HTTP surface the web client uses. It never
 * executes page code, so there is no localStorage to seed here (unlike the
 * browser suite); a scratch run starts by wiping data/smoke instead, while a
 * target keeps the accounts and rooms the run creates. With the seeded owner
 * it also covers the idea-notify silence rules, the admin-only idea triage
 * rule and the shipped ideas changelog; a deployed target needs
 * MEMES_ADMIN_PASS for those (they are skipped otherwise).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { signInGuest, describeGuestWait } from './lib/guest-signin.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flagAt = process.argv.indexOf('--target');
const flagTarget = flagAt >= 0 ? process.argv[flagAt + 1] || '' : '';
const positional = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : '';
/** A deployed instance to test instead of a local one (also MEMES_TARGET). */
const target = String(flagTarget || process.env.MEMES_TARGET || positional).trim().replace(/\/+$/, '');
if (target && !/^https?:\/\//i.test(target)) {
  console.error(`✗ the target must be an http(s) URL, got "${target}"`);
  process.exit(2);
}
const PORT = 8791 + Math.floor(Math.random() * 40);
const DATA = path.join(ROOT, 'data', 'smoke');
const SMOKE_ADMIN_PASS = 'smoke-admin-2026';
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

/* ------------------------------------------------------------------ *
 * tiny REST helper
 * ------------------------------------------------------------------ */

let token = '';
const clientHeaders = {
  'x-client': 'web',
  'x-client-version': '1.0.0',
  'x-client-caps': 'chat,dm,friends,parties,lobby,spectate,bots,drawing,music,themes,keybinds,admin,replays,assets-custom',
};

async function api(method, route, body, asToken = '') {
  const headers = { ...clientHeaders };
  const bearer = asToken || token;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
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
  return { status: res.status, ok: res.ok, payload, headers: res.headers };
}

/**
 * The guest sign-in, which has a quota a deployed target shares across clients
 * (six per IP per five minutes).  It waits that out - see lib/guest-signin.mjs -
 * and answers in the shape api() returns, so the checks read the same either
 * way.
 */
async function guestSignIn(body = {}) {
  const res = await signInGuest(base, body, {
    headers: clientHeaders,
    onWait: (wait) => console.log(`  note  ${describeGuestWait(wait)}`),
  });
  return { status: res.status, ok: res.ok, payload: res.json };
}

/* ------------------------------------------------------------------ *
 * realtime notify watcher (Node 22+ built-in WebSocket)
 * ------------------------------------------------------------------ */

/** Opens an identified socket and records every `notify` frame it receives. */
function watchNotifies(tok) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(tok)}`);
    const notes = [];
    const timer = setTimeout(() => reject(new Error('the notify socket never opened')), 5000);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'notify') notes.push(msg);
      } catch {}
    };
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({ notes, close: () => { try { ws.close(); } catch {} } });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('the notify socket failed to connect'));
    };
  });
}

/* ------------------------------------------------------------------ *
 * optional local server
 * ------------------------------------------------------------------ */

let child = null;
let base = target;

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

/* Scratch runs start with a changelog longer than one page. */
const SEEDED_SHIPS = 120;

/**
 * Seed a changelog that is older than one page, so the 100-entry cap and its
 * paging are exercised against real data. Written before boot, because the
 * only way to ship an idea through the API is one admin save at a time (and a
 * target keeps its own history - those checks skip themselves there).
 */
function seedChangelog() {
  const base = 1600000000000;
  const suggestions = Array.from({ length: SEEDED_SHIPS }, (_, i) => ({
    id: `seed-ship-${String(i).padStart(3, '0')}`,
    at: base + i * 1000,
    from: `seed-author-${i}`,
    fromName: `archivist${i % 7}`,
    title: `Archived ship ${i}`,
    text: `Idea ${i}, long since shipped.`,
    category: 'feature',
    status: 'done',
    votes: { [`seed-voter-${i}`]: 1 },
    adminNote: i % 3 === 0 ? `Noted when shipping ${i}.` : null,
    adminName: 'memegodmidas',
    updatedAt: base + i * 1000,
  }));
  mkdirSync(DATA, { recursive: true });
  writeFileSync(path.join(DATA, 'db.json'), JSON.stringify({ suggestions }, null, 2));
}

async function startLocal() {
  rmSync(DATA, { recursive: true, force: true });
  seedChangelog();
  console.log(`\nBooting a local server on port ${PORT}…`);
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, MEMES_PORT: String(PORT), MEMES_HOST: '127.0.0.1', MEMES_DATA: DATA, MEMES_PLATFORM: 'smoke', MEMES_ADMIN_PASS: process.env.MEMES_ADMIN_PASS || SMOKE_ADMIN_PASS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
  base = `http://127.0.0.1:${PORT}`;
  const alive = await waitForHealth(base);
  if (!alive) throw new Error('the local server never answered /api/health');
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
 * the actual checks
 * ------------------------------------------------------------------ */

async function run() {
  console.log(`\nSmoke test against ${base}\n`);

  /* 1. health + meta */
  const health = await api('GET', '/api/health');
  check(health.ok && health.payload?.ok === true, '/api/health reports healthy', `status ${health.status}`);
  check(Number.isFinite(health.payload?.engines), 'health reports an engine count', String(health.payload?.engines));

  const meta = await api('GET', '/api/meta');
  check(meta.ok, '/api/meta answers', `status ${meta.status}`);
  check(meta.payload?.appVersion === '1.0.0', 'app version is 1.0.0', String(meta.payload?.appVersion));
  check(Array.isArray(meta.payload?.catalog) && meta.payload.catalog.length > 0, `catalog has ${meta.payload?.catalog?.length ?? 0} games`);
  check((meta.payload?.counts?.playable ?? 0) > 0, `${meta.payload?.counts?.playable ?? 0} games are playable`);
  check((meta.payload?.counts?.games ?? 0) > 0, `catalog lists ${meta.payload?.counts?.games ?? 0} entries`);

  /* 2. compatibility negotiation */
  const compat = await api('GET', '/api/compat');
  check(compat.payload?.ok === true, '/api/compat accepts this client', compat.payload?.message);

  /* 3. auth: guest -> session -> me */
  const guest = await guestSignIn({});
  check(guest.ok && !!guest.payload?.token, 'guest sign-in returns a token',
    guest.ok ? '' : `${guest.payload?.message || `HTTP ${guest.status}`}${guest.status === 429 ? ' (the target shares its guest quota: six sign-ins per IP per five minutes)' : ''}`);
  token = guest.payload?.token || '';
  const me = await api('GET', '/api/auth/me');
  check(me.ok && me.payload?.user?.name, 'session restore works', me.payload?.message);

  /* 3b. account settings sync: what an account saves comes back on every
        sign-in (the client adopts it from the REST and realtime `me`). */
  const guestToken = token;
  const settingsName = `settings-${Date.now().toString(36)}`; // usernames cap at 20 chars
  const settingsPass = 'smoke-pass-2026';
  const registered = await api('POST', '/api/auth/register', { name: settingsName, password: settingsPass });
  check(registered.ok && !!registered.payload?.token, 'a named account registers for the settings check', registered.payload?.message);
  if (registered.payload?.token) {
    token = registered.payload.token;
    const saved = await api('POST', '/api/settings', {
      theme: 'neon', accent: '#00ff88', reduceMotion: true, keybinds: { action: 'KeyQ' }, audio: { master: 0.31 },
    });
    check(saved.ok && saved.payload?.settings?.theme === 'neon', 'settings save to the account', saved.payload?.message);
    const mine = await api('GET', '/api/auth/me');
    check(mine.payload?.user?.settings?.keybinds?.action === 'KeyQ' && mine.payload?.user?.settings?.audio?.master === 0.31,
      'the saved settings come back on the session');
    const again = await api('POST', '/api/auth/login', { name: settingsName, password: settingsPass });
    check(again.payload?.user?.settings?.theme === 'neon' && again.payload?.user?.settings?.accent === '#00ff88',
      'a fresh sign-in receives the same settings', again.payload?.message);
    const anon = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { ...clientHeaders, 'content-type': 'application/json' },
      body: '{"theme":"hacked"}',
    });
    check(anon.status === 401, 'settings cannot be written without a session', `status ${anon.status}`);
    token = guestToken;
  }

  /* 3c. idea notifications (silence rules) + the shipped-ideas changelog.
        Needs the owner account: scratch runs seed one, a deployed target
        needs MEMES_ADMIN_PASS set - otherwise this block is skipped. */
  const adminPass = process.env.MEMES_ADMIN_PASS || (target ? '' : SMOKE_ADMIN_PASS);
  if (!adminPass) {
    console.log('⤼ changelog and idea-notify checks skipped: set MEMES_ADMIN_PASS to use the owner on a target');
  } else {
    const authorReg = await api('POST', '/api/auth/register', { name: `idean-${Date.now().toString(36)}`, password: 'smoke-pass-2026' });
    const authorToken = authorReg.payload?.token || '';
    check(!!authorToken, 'an idea author account is ready', authorReg.payload?.message);
    const one = authorToken ? await api('POST', '/api/suggestions', { title: 'Smoke kart racer', text: 'A kart racer pitched by the smoke suite.', category: 'game' }, authorToken) : null;
    const two = authorToken ? await api('POST', '/api/suggestions', { title: 'Smoke photo mode', text: 'Must stay out of the changelog until it ships.', category: 'update' }, authorToken) : null;
    check(!!one?.payload?.suggestion?.id && !!two?.payload?.suggestion?.id, 'the author posts two ideas');
    const ideaId = one?.payload?.suggestion?.id || '';
    const otherId = two?.payload?.suggestion?.id || '';
    const authorName = authorReg.payload?.user?.name || '';

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { ...clientHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ name: ADMIN_USER, password: adminPass }),
    });
    const owner = await login.json().catch(() => null);
    check(!!owner?.token, 'the owner signs in for idea triage', owner?.message);
    const ownerToken = owner?.token || '';

    const updates = (notes, id = ideaId) => notes.filter((n) => n.kind === 'suggestion-update' && n.suggestionId === id);
    const settle = () => new Promise((r) => setTimeout(r, 500));

    if (!authorToken || !ownerToken || !ideaId) {
      check(false, 'idea notification checks', 'the setup above did not produce an author, owner and idea');
    } else if (typeof WebSocket !== 'function') {
      console.log('⤼ idea-notify checks skipped: they need Node 22+ (built-in WebSocket)');
    } else {
      const authorSock = await watchNotifies(authorToken);
      const ownerSock = await watchNotifies(ownerToken);
      await settle(); // let both sockets register before the first action

      // An unchanged save - the status row clicked on the status it already has.
      authorSock.notes.length = 0;
      await api('POST', `/api/admin/suggestions/${ideaId}`, { op: 'update', status: 'open' }, ownerToken);
      await settle();
      check(updates(authorSock.notes).length === 0, 'an unchanged save stays silent', JSON.stringify(updates(authorSock.notes)));

      // A real status move pings once - this also proves the watcher works.
      authorSock.notes.length = 0;
      await api('POST', `/api/admin/suggestions/${ideaId}`, { op: 'update', status: 'planned' }, ownerToken);
      await settle();
      const moved = updates(authorSock.notes);
      check(moved.length === 1 && (moved[0].text || '').includes('is now planned'), 'a status change notifies the author once', JSON.stringify(moved.map((m) => m.text)));

      // Adding a note pings; saving the same note again is silent.
      authorSock.notes.length = 0;
      await api('POST', `/api/admin/suggestions/${ideaId}`, { op: 'update', note: 'On the smoke roadmap.' }, ownerToken);
      await settle();
      check(updates(authorSock.notes).length === 1 && (updates(authorSock.notes)[0]?.text || '').includes('left a note'), 'adding a staff note notifies the author');
      authorSock.notes.length = 0;
      await api('POST', `/api/admin/suggestions/${ideaId}`, { op: 'update', note: 'On the smoke roadmap.' }, ownerToken);
      await settle();
      check(updates(authorSock.notes).length === 0, 're-saving the same note stays silent', JSON.stringify(updates(authorSock.notes)));

      // Clearing the note is not an addition: the author hears nothing.
      authorSock.notes.length = 0;
      await api('POST', `/api/admin/suggestions/${ideaId}`, { op: 'update', note: '' }, ownerToken);
      await settle();
      check(updates(authorSock.notes).length === 0, 'clearing a staff note stays silent', JSON.stringify(updates(authorSock.notes)));

      // A status move and a new note together are one message, not two.
      authorSock.notes.length = 0;
      await api('POST', `/api/admin/suggestions/${ideaId}`, { op: 'update', status: 'in-progress', note: 'Halfway through the smoke build.' }, ownerToken);
      await settle();
      const combined = updates(authorSock.notes);
      check(combined.length === 1 && combined[0].status === 'in-progress'
        && (combined[0].text || '').includes('is now in progress')
        && (combined[0].text || '').includes('Halfway through the smoke build.'),
        'a status move with a note arrives as one message', JSON.stringify(combined.map((m) => m.text)));

      // The last edge: clearing the note *while* moving the status. The move
      // must still ping - exactly once - and the note it cleared must leave no
      // Note line (and no stale text) behind.
      authorSock.notes.length = 0;
      await api('POST', `/api/admin/suggestions/${ideaId}`, { op: 'update', status: 'done', note: '' }, ownerToken);
      await settle();
      const clearedMove = updates(authorSock.notes);
      check(clearedMove.length === 1 && (clearedMove[0]?.text || '').includes('is now done'),
        'clearing a note while moving the status still pings once', JSON.stringify(clearedMove.map((m) => m.text)));
      check(clearedMove.length === 1 && !(clearedMove[0]?.text || '').includes('Note:')
        && !(clearedMove[0]?.text || '').includes('Halfway through the smoke build.')
        && !clearedMove[0]?.note,
        'the cleared note leaves no Note line or stale text behind',
        JSON.stringify(clearedMove.map((m) => ({ text: m.text, note: m.note }))));

      // Staff editing their own idea: the editor is never pinged.
      const own = await api('POST', '/api/suggestions', { title: 'Owner smoke idea', text: 'Posted by the owner to prove self-edits are silent.', category: 'other' }, ownerToken);
      const ownId = own?.payload?.suggestion?.id || '';
      ownerSock.notes.length = 0;
      if (ownId) await api('POST', `/api/admin/suggestions/${ownId}`, { op: 'update', status: 'planned' }, ownerToken);
      await settle();
      check(!!ownId && updates(ownerSock.notes, ownId).length === 0, 'staff editing their own idea stays silent', JSON.stringify(updates(ownerSock.notes, ownId)));

      authorSock.close();
      ownerSock.close();
    }

    // Triage is admin-only: the console's Ideas tab is admin-only, and a
    // moderator must be refused even through a direct API call. A probe idea
    // keeps the checks above untouched if the permission ever regresses.
    if (ownerToken && authorToken) {
      const modProbe = await api('POST', '/api/suggestions', { title: 'Moderator triage probe', text: 'Must stay open while a moderator is refused.', category: 'other' }, authorToken);
      const probeId = modProbe.payload?.suggestion?.id || '';
      const modName = `triage-${Date.now().toString(36)}`;
      const modReg = await api('POST', '/api/auth/register', { name: modName, password: 'smoke-pass-2026' });
      const modId = modReg.payload?.user?.id || '';
      const promote = modId ? await api('POST', `/api/admin/users/${modId}`, { op: 'role', role: 'mod' }, ownerToken) : null;
      check(!!promote?.ok && promote.payload?.role === 'mod', 'a moderator account is ready for the triage check', promote?.payload?.message);
      const modLogin = modId ? await api('POST', '/api/auth/login', { name: modName, password: 'smoke-pass-2026' }) : null;
      const modToken = modLogin?.payload?.token || '';
      check(!!modToken, 'the moderator signs in for the triage check', modLogin?.payload?.message);
      if (modToken && probeId) {
        const refused = await api('POST', `/api/admin/suggestions/${probeId}`, { op: 'update', status: 'planned' }, modToken);
        check(refused.status === 403, 'a moderator cannot triage ideas through a direct API call', `status ${refused.status}`);
        const refusedDelete = await api('POST', `/api/admin/suggestions/${probeId}`, { op: 'delete' }, modToken);
        check(refusedDelete.status === 403, 'a moderator cannot delete an idea through a direct API call', `status ${refusedDelete.status}`);
        const board = await api('GET', '/api/suggestions');
        const still = (board.payload?.suggestions || []).find((s) => s.id === probeId);
        check(!!still && still.status === 'open', 'the refused triage changed nothing', JSON.stringify(still && { status: still.status }));
      } else {
        check(false, 'moderator triage checks', 'the setup above did not produce a moderator and a probe idea');
      }
      // Leave a target tidy: the temporary moderator goes back to player.
      if (modId) await api('POST', `/api/admin/users/${modId}`, { op: 'role', role: 'user' }, ownerToken);
    }

    // The changelog: shipped ideas only, newest first, with the staff note and
    // author. Shipping both ideas also proves the ordering - the later ship
    // must lead - and that the total tracks each ship exactly.
    if (ideaId && otherId && ownerToken) {
      await api('POST', `/api/admin/suggestions/${ideaId}`, { op: 'update', status: 'done', note: 'Shipped in the smoke run.' }, ownerToken);
      const firstLog = await api('GET', '/api/changelog');
      const firstEntries = firstLog.payload?.entries || [];
      const entry = firstEntries.find((e) => e.id === ideaId);
      check(!!entry && entry.note === 'Shipped in the smoke run.' && entry.by === ADMIN_USER && entry.fromName === authorName && entry.votes >= 1,
        'the changelog lists the shipped idea with its note, owner and author', JSON.stringify(entry && { note: entry.note, by: entry.by, fromName: entry.fromName, votes: entry.votes }));
      check(!firstEntries.some((e) => e.id === otherId), 'the changelog leaves unshipped ideas out', `${firstEntries.length} entries`);

      await settle(); // a later updatedAt, so newest-first is unambiguous
      await api('POST', `/api/admin/suggestions/${otherId}`, { op: 'update', status: 'done', note: 'Second smoke ship.' }, ownerToken);
      const log = await api('GET', '/api/changelog');
      const entries = log.payload?.entries || [];
      const total = log.payload?.total || 0;
      const laterAt = entries.findIndex((e) => e.id === otherId);
      const earlierAt = entries.findIndex((e) => e.id === ideaId);
      check(laterAt !== -1 && earlierAt !== -1 && laterAt < earlierAt,
        'the changelog leads with the idea shipped last', JSON.stringify(entries.map((e) => [e.id, e.shippedAt])));
      check(entries.every((e, i) => i === 0 || entries[i - 1].shippedAt >= e.shippedAt),
        'the changelog is newest-first throughout', JSON.stringify(entries.slice(0, 3).map((e) => e.shippedAt)));
      check(total === (firstLog.payload?.total || 0) + 1 && entries.length === Math.min(total, 100),
        'shipping raises the total by exactly one, and a page stops at the cap', `total ${firstLog.payload?.total} -> ${total}, entries ${entries.length}`);

      // Paging: a response never exceeds the 100-entry cap, and offset is how a
      // longer log stays browsable. A scratch run pre-seeds 120 ships; a target
      // is measured against whatever history it has.
      const paged = await api('GET', '/api/changelog');
      const size = paged.payload?.total || 0;
      check(paged.payload?.limit === 100 && paged.payload?.offset === 0 && entries.length === Math.min(size, 100),
        'a changelog page is capped at 100 entries', `limit ${paged.payload?.limit}, ${entries.length} of ${size}`);
      check(paged.payload?.hasMore === (size > entries.length),
        'hasMore says whether another page exists', `hasMore ${paged.payload?.hasMore} for ${size} entries in ${entries.length}`);

      const big = await api('GET', '/api/changelog?limit=5000');
      check(big.payload?.limit === 100 && (big.payload?.entries || []).length <= 100,
        'a limit above the cap is clamped to one page', `limit ${big.payload?.limit}, ${(big.payload?.entries || []).length} entries`);
      const junk = await api('GET', '/api/changelog?limit=abc&offset=-5');
      check(junk.payload?.limit === 100 && junk.payload?.offset === 0,
        'a junk limit or offset falls back to the first page', JSON.stringify({ limit: junk.payload?.limit, offset: junk.payload?.offset }));
      const pair = await api('GET', '/api/changelog?limit=2');
      check(JSON.stringify((pair.payload?.entries || []).map((e) => e.id)) === JSON.stringify(entries.slice(0, 2).map((e) => e.id)),
        'a smaller limit takes the same newest-first page', JSON.stringify((pair.payload?.entries || []).map((e) => e.id)));
      const last = await api('GET', `/api/changelog?offset=${size - 1}&limit=5`);
      check((last.payload?.entries || []).length === 1 && !last.payload?.hasMore,
        'the last offset returns the final entry and ends the log', JSON.stringify({ entries: (last.payload?.entries || []).length, hasMore: last.payload?.hasMore }));

      if (!target && size > 100) {
        const second = await api('GET', '/api/changelog?offset=100&limit=100');
        const secondEntries = second.payload?.entries || [];
        const ids = [...entries, ...secondEntries].map((e) => e.id);
        check(secondEntries.length === size - 100 && !second.payload?.hasMore,
          'the page after the cap carries the rest and ends the log', JSON.stringify({ second: secondEntries.length, hasMore: second.payload?.hasMore, size }));
        check(new Set(ids).size === size,
          'paging across the cap yields every shipped idea exactly once', `${new Set(ids).size} unique of ${size}`);
      } else {
        console.log(`⤼ the over-100 paging checks are skipped: ${target ? 'a target keeps its own history' : 'the seed is missing'} (${size} entries)`);
      }
    } else {
      check(false, 'the changelog checks', 'the setup above did not produce an author, owner and both ideas');
    }
  }

  /* 4. catalog via REST */
  const games = await api('GET', '/api/games');
  check(games.ok && Array.isArray(games.payload?.games), '/api/games lists the catalog');
  const playable = (games.payload?.games || []).filter((g) => g.playable);
  check(playable.length > 0, `${playable.length} playable games`);

  /* 5. play one real game: open a room with bots, start it, read it back.
        (Moves travel over the WebSocket hub; the REST surface is what this
        test can check without a WS client, and it proves rooms really work.) */
  const game = playable[0];
  if (game) {
    const created = await api('POST', '/api/rooms', {
      gameId: game.engine || game.id,
      bots: game.players?.min > 1 ? game.players.min : 1,
      botLevel: 1,
      autostart: true,
    });
    check(created.ok && !!created.payload?.code, `opened and started a ${game.name} room`, created.payload?.message);
    const code = created.payload?.code;
    if (code) {
      const back = await api('GET', `/api/rooms/${code}`);
      check(back.ok, 'the room is readable by its code', `status ${back.status}`);
      const lower = await api('GET', `/api/rooms/${String(code).toLowerCase()}`);
      check(lower.ok && lower.payload?.room?.code === code, 'a room code resolves in any case (invite links survive a retype)', `status ${lower.status}`);
      check(back.payload?.room?.gameId === (game.engine || game.id), 'the room reports the right game', String(back.payload?.room?.gameId));
      check((back.payload?.room?.players?.length || 0) >= 1, `room has ${back.payload?.room?.players?.length || 0} seats`);
    }
    const open = await api('GET', '/api/rooms');
    check(open.ok && Array.isArray(open.payload?.rooms), 'the public room list answers', `status ${open.status}`);
  }

  /* 6. stats */
  const stats = await api('GET', '/api/stats');
  check(stats.ok && Number.isFinite(stats.payload?.registered), '/api/stats answers', `status ${stats.status}`);

  /* 7. desktop downloads: both archives exist, are real zips, and differ */
  const manifest = await api('GET', '/api/downloads');
  check(manifest.ok && Array.isArray(manifest.payload?.downloads), '/api/downloads lists packages');
  const lite = manifest.payload?.downloads?.find((d) => d.id === 'desktop-lite');
  const host = manifest.payload?.downloads?.find((d) => d.id === 'desktop-host');
  check(!!lite && lite.size > 0, `Desktop Lite package is ${Math.round((lite?.size || 0) / 1024)} KB`);
  check(!!host && host.size > 0, `Desktop Host package is ${Math.round((host?.size || 0) / 1024)} KB`);
  check((host?.size || 0) > (lite?.size || 0) * 3, 'Host package is substantially bigger than Lite (it carries the server)');

  for (const [label, entry] of [['Lite', lite], ['Host', host]]) {
    if (!entry) continue;
    const res = await fetch(`${base}${entry.url}`, { headers: clientHeaders });
    const buf = Buffer.from(await res.arrayBuffer());
    const isZip = buf.length > 22 && buf.readUInt32LE(0) === 0x04034b50;
    const disposition = res.headers.get('content-disposition') || '';
    check(isZip, `${label} download is a valid zip (${Math.round(buf.length / 1024)} KB)`, `magic ${buf.readUInt32LE(0).toString(16)}`);
    check(/attachment; filename=/.test(disposition), `${label} sets a download filename`, disposition);
    check(buf.length === entry.size, `${label} size matches the manifest`);
  }

  /* 8. the website itself */
  const page = await fetch(`${base}/`);
  const html = await page.text();
  check(page.ok && /MEMES/.test(html), 'the website index loads', `status ${page.status}`);
  check(/data-view="download"/.test(html), 'the Download tab is in the page');
  const css = await fetch(`${base}/css/app.css`);
  check(css.ok, 'the stylesheet loads', `status ${css.status}`);
  const mainJs = await fetch(`${base}/js/main.js`);
  check(mainJs.ok, 'the client script loads', `status ${mainJs.status}`);
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

try {
  let ready = true;
  if (!target) {
    await startLocal();
  } else {
    const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
    ready = check(health?.ok === true, 'the target answers the arcade /api/health', health ? `status ${health.status}, ${health.engines} engines` : 'unreachable or not the arcade API');
  }
  if (ready) await run();
} catch (err) {
  failures++;
  console.error(`\nSmoke test crashed: ${err.message}`);
} finally {
  stopLocal();
  // Leave no scratch data behind: the stray-state check fails the build on any
  // suite that does (see tools/leak-check.mjs). Ignored in --target mode, where
  // no scratch dir was ever created.
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${failures ? `✗ ${failures} failure(s), ${passed} passed` : `✓ all ${passed} smoke checks passed`}\n`);
process.exit(failures ? 1 : 0);
