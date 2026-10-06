#!/usr/bin/env node
/**
 * Discord bot check.
 *
 *   npm run botcheck
 *
 * Boots a scratch arcade, a fake Discord (REST + gateway on the project's own
 * WebSocket server) and the real bot process, then drives slash-command
 * interactions through the fake gateway and asserts what the bot posts back.
 * It also watches the arcade's own WebSocket as a promoted admin and as a
 * moderator: a new idea must ping the admin and leave the moderator silent.
 * Then it promotes a still-connected moderator to admin mid-session and posts
 * again - the same socket that stayed quiet must now hear the ping, proving
 * the notify loop reads each account's role at post time, not at connect time.
 * This covers the /arcade profile embed (title, bio, avatar thumbnail and
 * level colour), /profile (games played and achievements, read from the public
 * users API), /changelog (the site's shipped-idea log), /leaderboard game:
 * autocomplete from the live catalog and the margin-of-victory points a
 * finished Pong match books, /ideas, /suggest, /vote and /link flow end to end
 * without a Discord token; it does not test real Discord, only our side of the
 * protocol.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from '../server/lib/ws.js';
import { Arcade } from '../bot/arcade.js';
import { arcadeEmbed, profileEmbed, formatChangelog, changelogLine, avatarImageUrl, levelColor } from '../bot/commands.js';
import { pong } from '../web/games/engines/arcade.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCADE_PORT = 8811 + Math.floor(Math.random() * 40);
const FAKE_PORT = 9411 + Math.floor(Math.random() * 40);
const DATA = path.join(ROOT, 'data', 'bot-check');
const BOT_SECRET = 'bot-check-secret-4f9a2c7d1e28';
const APP_ID = '900000000000000001';
const ADMIN_PASS = 'bot-check-admin-2026';
const ARCADE = `http://127.0.0.1:${ARCADE_PORT}`;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * fake Discord: REST + gateway
 * ------------------------------------------------------------------ */

const fake = {
  commands: null,
  callbacks: new Map(), // interaction token -> callback body
  messages: new Map(), // interaction token -> edited message body
  connections: new Set(),
  seq: 1,
  identified: 0,
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try {
      resolve(raw ? JSON.parse(raw) : null);
    } catch {
      resolve(null);
    }
  });
});

let fakeHttp = null;
let fakeWs = null;

function startFakeDiscord() {
  fakeHttp = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const body = await readBody(req);
    const json = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/api/v10/users/@me') {
      return json(200, { id: APP_ID, username: 'memes-arcade-bot', discriminator: '0' });
    }
    if (url.pathname === '/api/v10/gateway/bot') {
      return json(200, { url: `ws://127.0.0.1:${FAKE_PORT}/gateway` });
    }
    if (req.method === 'PUT' && /^\/api\/v10\/applications\/[^/]+\/commands$/.test(url.pathname)) {
      fake.commands = body;
      return json(200, body);
    }
    if (req.method === 'PUT' && /^\/api\/v10\/applications\/[^/]+\/guilds\/[^/]+\/commands$/.test(url.pathname)) {
      fake.commands = body;
      return json(200, body);
    }
    const callback = url.pathname.match(/^\/api\/v10\/interactions\/([^/]+)\/([^/]+)\/callback$/);
    if (req.method === 'POST' && callback) {
      fake.callbacks.set(callback[2], body);
      res.writeHead(204);
      return res.end();
    }
    const edit = url.pathname.match(/^\/api\/v10\/webhooks\/([^/]+)\/([^/]+)\/messages\/@original$/);
    if (req.method === 'PATCH' && edit) {
      fake.messages.set(edit[2], body);
      return json(200, { id: 'msg-1', ...body });
    }
    return json(404, { message: `unhandled ${req.method} ${url.pathname}` });
  });
  fakeHttp.listen(FAKE_PORT, '127.0.0.1');
  fakeWs = attachWebSocket(fakeHttp, {
    path: '/gateway',
    pingIntervalMs: 60000,
    onConnection: (conn) => {
      fake.connections.add(conn);
      conn.on('close', () => fake.connections.delete(conn));
      conn.send({ op: 10, d: { heartbeat_interval: 45000 } });
      conn.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.op === 2) {
          fake.identified++;
          conn.send({
            op: 0,
            t: 'READY',
            s: fake.seq++,
            d: {
              user: { id: APP_ID, username: 'memes-arcade-bot' },
              session_id: 'sess-1',
              resume_gateway_url: `ws://127.0.0.1:${FAKE_PORT}/gateway`,
            },
          });
        }
        if (msg.op === 1) conn.send({ op: 11 }); // heartbeat ack
      });
    },
  });
}

/** Push an INTERACTION_CREATE and wait for the bot's edited reply. */
async function interact(user, name, options = []) {
  const token = `itoken-${++fake.seq}`;
  const conn = [...fake.connections][0];
  if (!conn) throw new Error('the bot is not connected to the fake gateway');
  conn.send({
    op: 0,
    t: 'INTERACTION_CREATE',
    s: fake.seq++,
    d: {
      id: `i${fake.seq}`,
      application_id: APP_ID,
      type: 2,
      token,
      data: { name, options },
      member: { user },
    },
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (fake.messages.has(token)) {
      return { callback: fake.callbacks.get(token), message: fake.messages.get(token), token };
    }
    await sleep(60);
  }
  throw new Error(`no reply to /${name}`);
}

/** Push an AUTOCOMPLETE interaction (type 4) and wait for the choices reply.
 *  Nothing is edited, so this waits on the interaction callback instead. */
async function pushAutocomplete(user, name, options = []) {
  const token = `itoken-${++fake.seq}`;
  const conn = [...fake.connections][0];
  if (!conn) throw new Error('the bot is not connected to the fake gateway');
  conn.send({
    op: 0,
    t: 'INTERACTION_CREATE',
    s: fake.seq++,
    d: {
      id: `i${fake.seq}`,
      application_id: APP_ID,
      type: 4,
      token,
      data: { name, options },
      member: { user },
    },
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (fake.callbacks.has(token)) return { callback: fake.callbacks.get(token), token };
    await sleep(60);
  }
  throw new Error(`no autocomplete reply to /${name}`);
}

/* ------------------------------------------------------------------ *
 * arcade REST helpers
 * ------------------------------------------------------------------ */

async function arcade(method, route, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${ARCADE}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, ok: res.ok, payload: text ? JSON.parse(text) : null };
}

const register = async (name) => (await arcade('POST', '/api/auth/register', { body: { name, password: 'bot-check-pass-1' } })).payload;

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let value = null;
    try {
      value = await fn();
    } catch {
      value = null;
    }
    if (value) return value;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Polls a captured frame list; false on timeout, so a missing frame fails a
 *  check instead of aborting the run. */
async function waitSeen(messages, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (messages.some(predicate)) return true;
    await sleep(80);
  }
  return false;
}

/** Polls a captured frame list and returns the first match (null on timeout). */
async function waitForFrame(messages, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = messages.find(predicate);
    if (hit) return hit;
    await sleep(80);
  }
  return null;
}

/** Opens an identified arcade socket a test can act through; `seen` holds
 *  every frame it receives, in arrival order. */
function openArcade(token) {
  const ws = new WebSocket(`${ARCADE.replace(/^http/i, 'ws')}/ws?token=${encodeURIComponent(token)}`);
  const seen = [];
  ws.onmessage = (ev) => {
    try {
      seen.push(JSON.parse(ev.data));
    } catch {}
  };
  const send = (msg) => ws.send(JSON.stringify(msg));
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => {
      send({ t: 'hello', v: '1.0.0', kind: 'web' });
      resolve();
    };
    ws.onerror = () => reject(new Error('the arcade socket failed'));
  });
  return { ws, seen, ready, send };
}

/** Opens an identified arcade socket that watches the idea board; `seen` holds
 *  every frame it receives, in arrival order. */
function watchBoard(token) {
  const ws = new WebSocket(`${ARCADE.replace(/^http/i, 'ws')}/ws?token=${encodeURIComponent(token)}`);
  const seen = [];
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', v: '1.0.0', kind: 'web' }));
      ws.send(JSON.stringify({ t: 'suggestions' }));
      resolve();
    };
    ws.onerror = () => reject(new Error('the staff watch socket failed'));
  });
  ws.onmessage = (ev) => {
    try {
      seen.push(JSON.parse(ev.data));
    } catch {}
  };
  return { ws, seen, ready };
}

/* ------------------------------------------------------------------ *
 * process management
 * ------------------------------------------------------------------ */

let arcadeServer = null;
let bot = null;
const botLog = [];

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {}
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  }
}

async function startArcade() {
  rmSync(DATA, { recursive: true, force: true });
  console.log(`\nBooting a scratch arcade on port ${ARCADE_PORT}…`);
  arcadeServer = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MEMES_PORT: String(ARCADE_PORT),
      MEMES_HOST: '127.0.0.1',
      MEMES_DATA: DATA,
      MEMES_PLATFORM: 'bot-check',
      MEMES_BOT_SECRET: BOT_SECRET,
      MEMES_ADMIN_PASS: ADMIN_PASS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  arcadeServer.stderr.on('data', (b) => process.stderr.write(`[arcade] ${b}`));
  await waitFor(async () => (await fetch(`${ARCADE}/api/health`)).ok, 20000, 'the arcade health endpoint');
}

async function startBot() {
  console.log(`Starting the bot against the fake Discord on port ${FAKE_PORT}…`);
  bot = spawn(process.execPath, [path.join(ROOT, 'bot', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DISCORD_TOKEN: 'fake-token',
      ARCADE_BOT_SECRET: BOT_SECRET,
      ARCADE_URL: ARCADE,
      DISCORD_API_BASE: `http://127.0.0.1:${FAKE_PORT}/api/v10`,
      DISCORD_GATEWAY_URL: `ws://127.0.0.1:${FAKE_PORT}/gateway`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bot.stdout.on('data', (b) => botLog.push(String(b)));
  bot.stderr.on('data', (b) => botLog.push(String(b)));
  await waitFor(() => fake.identified > 0, 15000, 'the bot to identify with the gateway');
}

function cleanup() {
  killTree(bot);
  killTree(arcadeServer);
  try {
    fakeWs?.close();
  } catch {}
  try {
    fakeHttp?.close();
  } catch {}
  // Leave no scratch data behind: the stray-state check fails the build on any
  // suite that does (see tools/leak-check.mjs).
  rmSync(DATA, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * checks
 * ------------------------------------------------------------------ */

async function run() {
  /* 1. the bot registers its commands */
  const registered = await waitFor(() => fake.commands, 10000, 'command registration');
  const names = (registered || []).map((c) => c.name).sort();
  check(JSON.stringify(names) === JSON.stringify(['arcade', 'changelog', 'ideas', 'leaderboard', 'link', 'profile', 'suggest', 'vote']), 'the bot registers all eight commands', names.join(', '));
  const changelogDef = (registered || []).find((c) => c.name === 'changelog');
  check(!changelogDef?.options?.length, '/changelog takes no options', JSON.stringify(changelogDef?.options));
  const suggest = (registered || []).find((c) => c.name === 'suggest');
  check(!!suggest?.options?.find((o) => o.name === 'details' && o.required), '/suggest requires title and details');
  const arcadeDef = (registered || []).find((c) => c.name === 'arcade');
  check(!!arcadeDef?.options?.find((o) => o.name === 'player' && !o.required), '/arcade takes an optional player name');
  const profileDef = (registered || []).find((c) => c.name === 'profile');
  check(!!profileDef?.options?.find((o) => o.name === 'player' && !o.required), '/profile takes an optional player name');
  const leaderboardDef = (registered || []).find((c) => c.name === 'leaderboard');
  check(!!leaderboardDef?.options?.find((o) => o.name === 'game' && !o.required), '/leaderboard takes an optional game');
  const gameOption = leaderboardDef?.options?.find((o) => o.name === 'game');
  check(gameOption?.autocomplete === true && gameOption.choices === undefined,
    '/leaderboard game: asks Discord for autocomplete instead of fixed choices', JSON.stringify(gameOption));

  /* 2. seed the board through the website API */
  const fan = await register('ideafan');
  const fan2 = await register('secondfan');
  const one = await arcade('POST', '/api/suggestions', { token: fan.token, body: { title: 'Kart racing mini-game', text: 'A top-down kart racer with meme power-ups would be brilliant.', category: 'game' } });
  const two = await arcade('POST', '/api/suggestions', { token: fan.token, body: { title: 'Photo mode for games', text: 'Let players pose and screenshot their party after a match.', category: 'update' } });
  await arcade('POST', '/api/suggestions', { token: fan2.token, body: { title: 'Meme museum', text: 'A museum of historic memes with a guided tour.', category: 'feature' } });
  await arcade('POST', `/api/suggestions/${one.payload.suggestion.id}/vote`, { token: fan2.token, body: {} }); // ▲ 2 on the kart idea
  check(!!one.payload?.suggestion?.id && !!two.payload?.suggestion?.id, 'the website API seeds three ideas');

  /* 3. /ideas shows the board with vote counts */
  const fanUser = { id: 'discord-fan-1', username: 'ideafan' };
  const board = await interact(fanUser, 'ideas', [{ name: 'sort', value: 'top' }]);
  check(board.callback?.type === 5 && !board.callback?.data, '/ideas defers with a public reply');
  const boardText = board.message?.content || '';
  check(boardText.includes('Kart racing mini-game'), '/ideas lists the top idea');
  check(boardText.includes('▲ 2'), '/ideas shows the vote count', boardText.slice(0, 120));
  check(boardText.includes('3 ideas'), '/ideas shows the board total');
  check(boardText.includes(one.payload.suggestion.id), '/ideas prints idea ids for /vote', boardText.slice(-160));

  /* 4. status filter: mark one planned, then filter it out */
  const admin = await arcade('POST', '/api/auth/login', { body: { name: 'memegodmidas', password: ADMIN_PASS } });
  await arcade('POST', `/api/admin/suggestions/${two.payload.suggestion.id}`, { token: admin.payload.token, body: { op: 'update', status: 'planned', note: 'On the roadmap.' } });
  const openOnly = await interact(fanUser, 'ideas', [{ name: 'status', value: 'open' }]);
  const openText = openOnly.message?.content || '';
  check(!openText.includes('Photo mode for games'), '/ideas status:open leaves planned ideas out');
  check(openText.includes('Kart racing mini-game'), '/ideas status:open keeps open ideas in');

  /* 5. /suggest before linking explains the link flow */
  const stranger = { id: 'discord-stranger-9', username: 'stranger' };
  const unlinked = await interact(stranger, 'suggest', [
    { name: 'title', value: 'Voice chat in rooms' },
    { name: 'details', value: 'Push-to-talk voice while playing party games.' },
    { name: 'category', value: 'feature' },
  ]);
  check((unlinked.message?.content || '').includes('/link'), '/suggest asks unlinked players to link first');
  const unlinkedArcade = await interact(stranger, 'arcade');
  check((unlinkedArcade.message?.content || '').includes('/link'), '/arcade asks unlinked players to link first');
  check(unlinkedArcade.callback?.data?.flags === 64, '/arcade replies privately');
  check(unlinked.callback?.data?.flags === 64, '/suggest replies privately');
  // Looking up a name needs no link: the public profile is open to anyone, and
  // it comes back as an embed - avatar thumbnail, title, bio, level colour.
  const ideafanBio = 'Kart racing regular and part-time meme historian.';
  await arcade('POST', '/api/profile', { token: fan.token, body: { bio: ideafanBio } });
  const ideafanRow = (await arcade('GET', '/api/users?q=ideafan')).payload?.users?.[0] || null;
  const lookup = await interact(stranger, 'arcade', [{ name: 'player', value: 'ideafan' }]);
  const lookupEmbed = lookup.message?.embeds?.[0] || null;
  const lookupDesc = lookupEmbed?.description || '';
  check(!!lookupEmbed && lookupEmbed.title === 'ideafan' && !lookup.message?.content,
    '/arcade player: looks up a public profile as an embed without linking', JSON.stringify(lookupEmbed).slice(0, 140));
  check(lookupDesc.includes(ideafanBio), 'the profile embed carries the player bio', lookupDesc.slice(0, 120));
  check(lookupDesc.includes('coins') && lookupDesc.includes(`Level ${ideafanRow?.level}`) && !lookupDesc.includes('/link'),
    'the profile embed keeps the level, coins and match record', lookupDesc.slice(0, 160));
  check(lookupEmbed?.color === levelColor(ideafanRow?.level),
    'the profile embed is coloured by the level', `level ${ideafanRow?.level} -> ${lookupEmbed?.color}`);
  check(!!lookupEmbed?.thumbnail?.url && lookupEmbed.thumbnail.url === avatarImageUrl(ideafanRow?.avatar),
    'the profile embed renders the avatar as its thumbnail', `${ideafanRow?.avatar} -> ${lookupEmbed?.thumbnail?.url}`);
  check(lookup.callback?.data?.flags === 64, '/arcade player: replies privately');
  const missing = await interact(stranger, 'arcade', [{ name: 'player', value: 'nobody-here' }]);
  check((missing.message?.content || '').includes('No arcade player matches **nobody-here**'), 'an unknown name says so plainly', (missing.message?.content || '').slice(0, 120));
  const hint = await interact(stranger, 'arcade', [{ name: 'player', value: 'ideaf' }]);
  check((hint.message?.content || '').includes('Did you mean') && (hint.message?.content || '').includes('**ideafan**'), 'a near-miss name suggests the closest player', (hint.message?.content || '').slice(0, 120));
  const cased = await interact(stranger, 'arcade', [{ name: 'player', value: 'IDEAfan' }]);
  check(cased.message?.embeds?.[0]?.title === 'ideafan', 'the lookup ignores capitalisation', cased.message?.embeds?.[0]?.title || '(no embed)');
  const before = await arcade('GET', '/api/suggestions?status=all');
  check(before.payload.total === 3, 'the unlinked /suggest posted nothing', `total ${before.payload.total}`);

  /* 6. /link, then claim the code on the website, then post for real */
  const link = await interact(stranger, 'link');
  const linkText = link.message?.content || '';
  const code = (linkText.match(/`([A-Z0-9]{12})`/) || [])[1];
  check(!!code, '/link hands out a claim code', linkText.slice(0, 80));
  const claimed = await arcade('POST', '/api/discord/claim', { token: fan2.token, body: { code } });
  check(claimed.ok && claimed.payload?.discordId === stranger.id, 'the website claims the code for the linked account');

  const posted = await interact(stranger, 'suggest', [
    { name: 'title', value: 'Voice chat in rooms' },
    { name: 'details', value: 'Push-to-talk voice while playing party games.' },
    { name: 'category', value: 'feature' },
  ]);
  const postedText = posted.message?.content || '';
  check(postedText.includes('Posted to the idea board'), '/suggest posts once linked', postedText.slice(0, 80));
  const after = await arcade('GET', '/api/suggestions?status=all');
  const fresh = (after.payload.suggestions || []).find((s) => s.title === 'Voice chat in rooms');
  check(!!fresh && fresh.votes === 1 && fresh.fromName === 'secondfan', 'the idea is on the board under the linked account', JSON.stringify(fresh && { votes: fresh.votes, fromName: fresh.fromName }));

  /* 7. /arcade and /leaderboard read real account data */
  await arcade('POST', `/api/admin/users/${fan2.user.id}`, { token: admin.payload.token, body: { op: 'grant', xp: 500, coins: 777 } });
  await arcade('POST', `/api/admin/users/${fan.user.id}`, { token: admin.payload.token, body: { op: 'grant', xp: 5000 } });
  const mine = await interact(stranger, 'arcade');
  const mineEmbed = mine.message?.embeds?.[0] || null;
  const mineDesc = mineEmbed?.description || '';
  check(mine.callback?.data?.flags === 64, '/arcade replies privately when linked');
  check(mineEmbed?.title === 'secondfan' && mineDesc.includes('Level 3'), '/arcade embeds the linked account and its level', `${mineEmbed?.title} / ${mineDesc.slice(0, 90)}`);
  check(mineDesc.includes('1,027') && mineDesc.includes('coins'), '/arcade shows the granted coin balance', mineDesc.slice(0, 160));
  check(mineDesc.includes('0 games') && mineDesc.includes('0% win rate'), '/arcade shows the match record', mineDesc.slice(0, 160));
  check(mineEmbed?.color === levelColor(3), 'the linked profile is coloured by its level', `level 3 -> ${mineEmbed?.color}`);
  const other = await interact(stranger, 'arcade', [{ name: 'player', value: 'ideafan' }]);
  const otherEmbed = other.message?.embeds?.[0] || null;
  check(otherEmbed?.title === 'ideafan' && otherEmbed?.title !== mineEmbed?.title,
    '/arcade player: shows the named player, not the linked account', otherEmbed?.title || '(no embed)');
  // The level ramp: every band maps to its own colour and the ends clamp.
  check(levelColor(1) === 0x6b7280 && levelColor(5) === 0x34d399 && levelColor(10) === 0x22d3ee
    && levelColor(20) === 0xa78bfa && levelColor(35) === 0xff2fb0 && levelColor(50) === 0xfbbf24
    && levelColor(0) === levelColor(1) && levelColor(999) === levelColor(50),
    'the level ramp maps every band to its colour and clamps outside it',
    [1, 5, 10, 20, 35, 50].map((l) => `${l}:${levelColor(l).toString(16)}`).join(' '));
  // Arcade avatars are emoji and Discord needs a URL; Twemoji names by code point.
  check(avatarImageUrl('👾') === 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f47e.png' && avatarImageUrl('AB') === null,
    'an emoji avatar becomes an image URL and text does not', `${avatarImageUrl('👾')} / ${avatarImageUrl('AB')}`);
  // byGame only grows by playing a match, so drive the top-game line through
  // the real catalog the bot uses - that lookup is easy to get wrong.
  const catalog = await new Arcade({ url: ARCADE, botToken: BOT_SECRET }).catalog();
  const sample = arcadeEmbed(
    { name: 'sample', level: 2, xp: 200, xpPct: 10, coins: 5, avatar: '🎮', bio: 'Samples the arcade.', stats: { games: 4, wins: 2, losses: 1, draws: 1, streak: 1, bestStreak: 2, byGame: { pong: 3, 'tic-tac-toe': 1 } } },
    { topGame: ['pong', 3], catalog },
  );
  check(!!catalog.games?.some((g) => g.id === 'pong') && sample.description.includes('Most played: **Ping Pong** · 3 games'), 'the top-game line resolves ids through the real catalog', sample.description.slice(-80));
  check(sample.title === 'sample' && sample.description.includes('_Samples the arcade._'), 'the embed puts the bio above the stats', sample.description.slice(0, 80));

  const ranks = await interact(fanUser, 'leaderboard', []);
  check(!ranks.callback?.data?.flags, '/leaderboard replies in public');
  const ranksText = ranks.message?.content || '';
  check(ranksText.includes('Top players') && ranksText.includes('ranked by level'), '/leaderboard headlines the ranking', ranksText.slice(0, 100));
  const firstAt = ranksText.indexOf('ideafan');
  const secondAt = ranksText.indexOf('secondfan');
  check(firstAt !== -1 && secondAt !== -1 && firstAt < secondAt, '/leaderboard ranks the higher-XP player first', ranksText.slice(0, 220));
  check(ranksText.includes('🥇') && ranksText.includes('5,000'), '/leaderboard shows medals and XP');
  const winsBoard = await interact(fanUser, 'leaderboard', [{ name: 'sort', value: 'wins' }]);
  check((winsBoard.message?.content || '').includes('claim the top spot'), '/leaderboard sort:wins explains an empty board', (winsBoard.message?.content || '').slice(0, 120));

  /* 8. /vote toggles, with counts */
  if (!fresh) {
    check(false, '/vote checks', 'the linked /suggest posted nothing to vote on');
  } else {
    const unvoted = await interact(stranger, 'vote', [{ name: 'idea', value: fresh.id }]);
    check((unvoted.message?.content || '').includes('Removed your vote') && (unvoted.message?.content || '').includes('▲ 0'), '/vote removes the auto-upvote and reports the count', (unvoted.message?.content || '').slice(0, 90));
    const revoted = await interact(stranger, 'vote', [{ name: 'idea', value: fresh.id.slice(0, 5) }]);
    check((revoted.message?.content || '').includes('Upvoted') && (revoted.message?.content || '').includes('▲ 1'), '/vote accepts an id prefix and re-votes');
    const bogus = await interact(stranger, 'vote', [{ name: 'idea', value: 'zzzzzzzz' }]);
    check((bogus.message?.content || '').includes('No idea matches'), '/vote explains an unknown id');
  }

  /* 9. validation stays server-side honest */
  const tooShort = await interact(stranger, 'suggest', [
    { name: 'title', value: 'ab' },
    { name: 'details', value: 'short' },
    { name: 'category', value: 'feature' },
  ]);
  check((tooShort.message?.content || '').includes('at least 4 characters'), '/suggest validates the title length');

  /* 10. /changelog reads the shipped-idea log the site's changelog page uses.
        Nothing has shipped on this scratch arcade yet, so the empty state has
        to come first; then ideas are shipped through the website API (owner),
        which is the only way an idea reaches the log. */
  const emptyLog = await interact(fanUser, 'changelog');
  check(!emptyLog.callback?.data?.flags && (emptyLog.message?.content || '').includes('Nothing has shipped yet'),
    '/changelog replies in public and explains an empty log', (emptyLog.message?.content || '').slice(0, 100));

  const shipNote = 'Shipped in the bot-check run.';
  const ownerName = admin.payload?.user?.name || 'memegodmidas';
  await arcade('POST', `/api/admin/suggestions/${one.payload.suggestion.id}`, { token: admin.payload.token, body: { op: 'update', status: 'done', note: shipNote } });
  const shipped = await interact(fanUser, 'changelog');
  const shippedText = shipped.message?.content || '';
  check(!shipped.callback?.data?.flags, '/changelog replies in public');
  check(shippedText.includes('1 idea shipped') && shippedText.includes('**Kart racing mini-game**'),
    '/changelog lists the shipped idea and counts it', shippedText.slice(0, 140));
  check(shippedText.includes('🎮 game') && shippedText.includes('▲ 2') && shippedText.includes('by ideafan'),
    '/changelog shows the category, the votes it earned and the author', shippedText.slice(0, 170));
  check(shippedText.includes(`🛡️ ${ownerName}: ${shipNote}`),
    '/changelog credits the note staff left when shipping it', shippedText.slice(0, 200));
  check(/shipped <t:\d+:R>/.test(shippedText), '/changelog stamps when it shipped', shippedText.slice(0, 130));
  check(!shippedText.includes('Photo mode for games'), '/changelog leaves unshipped ideas out');

  // A later ship must lead the log, and the count must follow every ship.
  await sleep(1100); // a later updatedAt, so newest-first is unambiguous
  await arcade('POST', `/api/admin/suggestions/${two.payload.suggestion.id}`, { token: admin.payload.token, body: { op: 'update', status: 'done', note: 'Also shipped.' } });
  const orderedLog = await interact(fanUser, 'changelog');
  const orderedText = orderedLog.message?.content || '';
  check(orderedText.includes('2 ideas shipped')
    && orderedText.indexOf('Photo mode for games') !== -1
    && orderedText.indexOf('Photo mode for games') < orderedText.indexOf('Kart racing mini-game'),
    '/changelog leads with the idea shipped last', orderedText.slice(0, 170));

  // The formatter's edges, without waiting on the server: the eight-line cap,
  // a shipped idea with no note, and one with no ship date at all.
  const manyShipped = formatChangelog({
    total: 20,
    entries: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, title: `Shipped idea ${i}`, text: `What shipped, number ${i}.`, category: 'feature', votes: i, fromName: 'fan', shippedAt: 1700000000000 - i * 1000, note: null })),
  });
  check(manyShipped.includes('…and 12 more') && manyShipped.includes('**8.**') && !manyShipped.includes('**9.**') && !manyShipped.includes('Shipped idea 8'),
    'the changelog stops at eight entries and says how many are left', manyShipped.split('\n').slice(-1)[0]);
  check(!manyShipped.includes('🛡️'), 'a shipped idea with no note gets no note line');
  const undated = changelogLine({ title: 'No date', text: 'Shipped before dates existed.', category: 'other', votes: 0, fromName: 'fan', shippedAt: 0, note: null }, 1);
  check(!undated.includes('shipped <t:') && undated.includes('**No date**'), 'an entry with no ship date omits the stamp', undated.slice(0, 90));
  const longEntry = changelogLine({ title: 'T'.repeat(120), text: 'B'.repeat(200), category: 'other', votes: 0, fromName: 'n'.repeat(40), shippedAt: 1700000000000, note: 'N'.repeat(200), by: null }, 1);
  check(longEntry.includes(`${'T'.repeat(89)}…`) && longEntry.includes(`${'B'.repeat(139)}…`) && longEntry.includes('🛡️ staff: ') && longEntry.includes(`${'N'.repeat(119)}…`),
    'a long title, text and note are cut, and an unnamed note author falls back to staff', longEntry.slice(0, 120));
  const giantLog = formatChangelog({
    total: 500,
    entries: Array.from({ length: 8 }, () => ({ title: 'T'.repeat(90), text: 'x'.repeat(3000), category: 'other', votes: 0, fromName: 'n', shippedAt: 1700000000000, note: 'N'.repeat(5000) })),
  });
  check(giantLog.length <= 1900 && giantLog.endsWith('…'), "the changelog clips itself to Discord's message budget", `${giantLog.length} chars`);

  /* 11. per-game boards: a real finished match feeds /leaderboard game: */
  // Drive a real Ping Pong room to the end: the host streams the snapshot its
  // own engine would send at match point (the winner set), so the result
  // lands in the same stats the per-game board reads. The snapshot is ended by
  // pong's own step(), so the winner *and* the points the engine books are the
  // real ones - the host streams a real score, it does not declare them.
  const hostSock = openArcade(fan.token);
  const guestSock = openArcade(fan2.token);
  let playedPong = false;
  let matchError = '';
  try {
    await Promise.all([hostSock.ready, guestSock.ready]);
    await waitForFrame(hostSock.seen, (m) => m.t === 'welcome', 4000);
    hostSock.send({ t: 'room', op: 'create', gameId: 'pong', visibility: 'public', options: { target: 3 } });
    const created = await waitForFrame(hostSock.seen, (m) => m.t === 'game' && m.room?.gameId === 'pong' && m.room?.code);
    if (!created?.room?.code) throw new Error('the room never opened');
    guestSock.send({ t: 'room', op: 'join', code: created.room.code });
    await waitForFrame(guestSock.seen, (m) => m.t === 'game' && m.room?.players?.length === 2);
    hostSock.send({ t: 'room', op: 'start' });
    const started = await waitForFrame(hostSock.seen, (m) => m.t === 'room:state', 4000);
    if (!started?.state) throw new Error('the host never received the start state');
    const finalState = started.state;
    // The left side is the host (the engine seats players[0] on 'l'), so the
    // host wins 3-1: a margin of 2. One engine step declares the winner and
    // books the margin as that side's points, exactly as a live host would.
    finalState.score = { l: finalState.target || 3, r: 1 };
    pong.step(finalState, 0);
    hostSock.send({ t: 'tick', snapshot: finalState });
    playedPong = !!(await waitForFrame(hostSock.seen, (m) => m.t === 'game' && m.room?.status === 'finished', 6000));
  } catch (err) {
    matchError = err.message;
  }
  check(playedPong, 'a real Ping Pong match finishes on the scratch arcade', matchError || 'the room never finished');
  hostSock.ws.close();
  guestSock.ws.close();

  if (playedPong) {
    const ranking = await arcade('GET', '/api/leaderboard?game=pong');
    const top = ranking.payload?.entries?.[0];
    const loser = ranking.payload?.entries?.[1];
    check(top?.name === 'ideafan' && top?.score === 2 && top?.points === 2 && top?.plays === 1 && top?.wins === 1,
      'the margin of victory lands on the arcade per-game ranking as points',
      JSON.stringify((ranking.payload?.entries || []).map((e) => [e.name, e.points, e.plays])));
    check(ranking.payload?.rankedBy === 'points' && loser?.name === 'secondfan' && loser?.points === 0 && loser?.plays === 1,
      'the board ranks by points and keeps everyone who played on it',
      `rankedBy ${ranking.payload?.rankedBy}, loser ${JSON.stringify(loser && [loser.name, loser.points, loser.plays])}`);
    const publicCard = await arcade('GET', '/api/users/ideafan');
    check(publicCard.payload?.user?.stats?.points?.pong === 2,
      'the points show on the public profile the users API serves', JSON.stringify(publicCard.payload?.user?.stats?.points));
    // The store now answers { rankedBy, entries }, so every route that serves a
    // board keeps its promised shape.
    const globalBoard = await arcade('GET', '/api/leaderboard');
    check(globalBoard.payload?.rankedBy === 'wins' && Array.isArray(globalBoard.payload?.entries)
      && globalBoard.payload?.entries?.[0]?.name === 'ideafan' && globalBoard.payload?.entries?.[0]?.plays >= 1,
      'the global board still ranks by wins and serves a plain entries array',
      JSON.stringify([globalBoard.payload?.rankedBy, (globalBoard.payload?.entries || []).length]));
    const gamePage = await arcade('GET', '/api/games/pong');
    check(Array.isArray(gamePage.payload?.leaderboard) && gamePage.payload.leaderboard[0]?.name === 'ideafan',
      'the game page still serves its board as an array', JSON.stringify(gamePage.payload?.leaderboard?.[0]?.name));
    const stats = await arcade('GET', '/api/stats');
    check(Array.isArray(stats.payload?.top) && stats.payload?.top?.[0]?.name === 'ideafan',
      'the public stats payload still gets its top board as an array', JSON.stringify(stats.payload?.top?.[0]?.name));

    const pongBoard = await interact(fanUser, 'leaderboard', [{ name: 'game', value: 'ping' }]);
    const pongText = pongBoard.message?.content || '';
    check(!pongBoard.callback?.data?.flags, 'the game board replies in public');
    check(pongText.includes('🏓 Ping Pong top players') && pongText.includes('ranked by points'),
      'a partial game name finds the board, which is ranked by points', pongText.slice(0, 100));
    check(pongText.includes('🥇') && pongText.includes('**ideafan**') && pongText.includes('⭐ 2 points · 🎮 1 game'),
      'the board shows the winner with their points and game count', pongText.slice(0, 160));
    check(pongText.includes('**secondfan**'), 'the board lists everyone who played', pongText.slice(0, 200));

    const byId = await interact(fanUser, 'leaderboard', [{ name: 'game', value: 'PONG' }]);
    check((byId.message?.content || '').includes('Ping Pong'), 'the game id resolves regardless of case', (byId.message?.content || '').slice(0, 80));

    const typo = await interact(fanUser, 'leaderboard', [{ name: 'game', value: 'warpzone' }]);
    check((typo.message?.content || '').includes('No arcade game matches') && !typo.callback?.data?.flags,
      'an unknown game explains itself', (typo.message?.content || '').slice(0, 120));
  } else {
    check(false, 'the per-game board checks', 'no finished match to rank');
  }

  /* 12. /leaderboard game: autocompletes from the live catalog, so a player
        picks a real game id instead of typing a name that may be misspelled. */
  const typed = await pushAutocomplete(fanUser, 'leaderboard', [{ name: 'game', value: 'pin', focused: true }]);
  const choices = typed.callback?.data?.choices || [];
  check(typed.callback?.type === 8 && Array.isArray(typed.callback?.data?.choices),
    'autocomplete answers with an autocomplete result (type 8)', `type ${typed.callback?.type}`);
  check(choices.length === 1 && choices[0].value === 'pong' && choices[0].name.includes('Ping Pong'),
    'typing part of a game name offers exactly that game', JSON.stringify(choices));
  check(choices.every((c) => (catalog.games || []).some((g) => g.id === c.value)),
    'every offered value is a real catalog game id', JSON.stringify(choices.map((c) => c.value)));
  check(choices.every((c) => c.name?.length > 0 && c.name.length <= 100 && String(c.value).length > 0 && String(c.value).length <= 100),
    "every choice fits Discord's name/value limits", JSON.stringify(choices));

  const upper = await pushAutocomplete(fanUser, 'leaderboard', [{ name: 'game', value: 'PONG', focused: true }]);
  check((upper.callback?.data?.choices || []).some((c) => c.value === 'pong'),
    'autocomplete ignores capitalisation', JSON.stringify((upper.callback?.data?.choices || []).map((c) => c.value)));
  const multi = await pushAutocomplete(fanUser, 'leaderboard', [{ name: 'game', value: 'tic', focused: true }]);
  const multiIds = (multi.callback?.data?.choices || []).map((c) => c.value);
  check(multiIds.includes('tic-tac-toe') && multiIds.includes('ultimate-ttt'),
    'a partial name offers every game it could mean', multiIds.join(', '));
  const browse = await pushAutocomplete(fanUser, 'leaderboard', [{ name: 'game', value: '', focused: true }]);
  const browseIds = (browse.callback?.data?.choices || []).map((c) => c.value);
  check(browseIds.length === 25 && new Set(browseIds).size === 25,
    "an empty box offers the catalog itself, capped at Discord's 25 choices", `${browseIds.length} choices`);
  const noHits = await pushAutocomplete(fanUser, 'leaderboard', [{ name: 'game', value: 'zzzz', focused: true }]);
  check(noHits.callback?.type === 8 && (noHits.callback?.data?.choices || []).length === 0,
    'a query that matches nothing answers with no choices', JSON.stringify(noHits.callback?.data));
  const otherOption = await pushAutocomplete(fanUser, 'leaderboard', [{ name: 'sort', value: 'wins', focused: true }]);
  check(otherOption.callback?.type === 8 && (otherOption.callback?.data?.choices || []).length === 0,
    'only the option being typed is answered', JSON.stringify(otherOption.callback?.data));
  const otherCommand = await pushAutocomplete(fanUser, 'profile', [{ name: 'player', value: 'idea', focused: true }]);
  check(otherCommand.callback?.type === 8 && (otherCommand.callback?.data?.choices || []).length === 0,
    'a command without autocomplete answers with no choices', JSON.stringify(otherCommand.callback?.data));
  // The value a player picks must drive the same per-game board as typing it.
  const pickedGame = multiIds.includes('tic-tac-toe') ? 'tic-tac-toe' : multiIds[0];
  const picked = await interact(fanUser, 'leaderboard', [{ name: 'game', value: pickedGame }]);
  const pickedText = picked.message?.content || '';
  check(pickedText.includes('❌ Tic-Tac-Toe top players') && pickedText.includes('ranked by games played'),
    'a game with no points yet still ranks by games played', pickedText.slice(0, 110));
  check(pickedText.includes('Nobody has played'), 'an unplayed game explains itself', pickedText.slice(0, 110));

  /* 13. /profile reads the two sections of the public users API that /arcade
        ignores: `recent` (games played per game) and `achievements`. */
  const fanCard = await arcade('GET', '/api/users/ideafan');
  const fanPublic = fanCard.payload?.user || {};
  const fanAch = fanCard.payload?.achievements || [];
  const cardLookup = await interact(fanUser, 'profile', [{ name: 'player', value: 'ideafan' }]);
  const card = cardLookup.message?.embeds?.[0] || null;
  const playsField = card?.fields?.find((f) => String(f.name).includes('Games played'))?.value || '';
  const achField = card?.fields?.find((f) => String(f.name).includes('Achievements'))?.value || '';
  check(cardLookup.callback?.data?.flags === 64 && !cardLookup.message?.content,
    '/profile player: replies privately without a link', `flags ${cardLookup.callback?.data?.flags}`);
  check(card?.title === 'ideafan' && (card?.description || '').includes(`Level ${fanPublic.level}`),
    '/profile embeds the named player and their level', `${card?.title} / ${(card?.description || '').slice(0, 90)}`);
  check(card?.color === levelColor(fanPublic.level) && !!card?.thumbnail?.url,
    '/profile keeps the level colour and avatar thumbnail', `level ${fanPublic.level} -> ${card?.color} / ${card?.thumbnail?.url}`);
  check(playsField.includes('**Ping Pong** — 1 game (100%)'),
    '/profile lists the games that player has played, named off the catalog', playsField.slice(0, 120));
  // Expected lines are derived from the API payload, and the empty-state note
  // is barred: it names First Blood, so it would fake a pass on its own.
  const expectedAch = fanAch.map((a) => `${a.icon || '🏅'} **${a.name}**`);
  check(expectedAch.length > 0 && !achField.includes('None yet') && expectedAch.every((line) => achField.includes(line)),
    '/profile lists every achievement the users API reports', `${achField.slice(0, 120)} (API: ${JSON.stringify(fanAch.map((a) => a.name))})`);
  check((card?.description || '').includes(`${fanAch.length} achievement`) && (card?.description || '').includes(`${fanPublic.stats?.games} game`),
    '/profile headline counts the games and achievements the API reports', card?.description);

  const mineCardLookup = await interact(stranger, 'profile');
  const mineCard = mineCardLookup.message?.embeds?.[0] || null;
  const minePlays = mineCard?.fields?.find((f) => String(f.name).includes('Games played'))?.value || '';
  const mineWon = mineCard?.fields?.find((f) => String(f.name).includes('Achievements'))?.value || '';
  check(mineCardLookup.callback?.data?.flags === 64 && mineCard?.title === 'secondfan',
    '/profile with no name embeds the linked account', mineCard?.title || '(no embed)');
  check(minePlays.includes('**Ping Pong** — 1 game (100%)'),
    '/profile reads the linked account games via the bot token', minePlays.slice(0, 120));
  check(mineWon.includes('None yet') && mineWon.includes('First Blood'),
    '/profile says how to earn a first achievement when none are earned', mineWon.slice(0, 120));

  const newbieCard = await interact({ id: 'discord-newbie-3', username: 'newbie' }, 'profile');
  check((newbieCard.message?.content || '').includes('/link'),
    '/profile asks unlinked players to link for their own card', (newbieCard.message?.content || '').slice(0, 90));
  const cardMiss = await interact(fanUser, 'profile', [{ name: 'player', value: 'nobody-here' }]);
  check((cardMiss.message?.content || '').includes('No arcade player matches **nobody-here**'),
    '/profile explains an unknown name', (cardMiss.message?.content || '').slice(0, 120));
  const cardHint = await interact(fanUser, 'profile', [{ name: 'player', value: 'ideaf' }]);
  check((cardHint.message?.content || '').includes('Did you mean') && (cardHint.message?.content || '').includes('**ideafan**'),
    '/profile offers the closest name when one misses', (cardHint.message?.content || '').slice(0, 120));

  // The pure formatter, driven with a rich sample and the real catalog: the
  // field headings are what a reader scans, and each game's share must add up.
  const richCard = profileEmbed(
    { name: 'sample', level: 4, avatar: '👾', stats: { games: 12, wins: 3, losses: 9, byGame: { pong: 9, 'tic-tac-toe': 3 } } },
    {
      byGame: [['pong', 9], ['tic-tac-toe', 3]],
      achievements: [{ id: 'first-win', name: 'First Blood', icon: '🥇' }, { id: 'streak-5', name: 'On Fire', icon: '🔥' }],
      catalog,
    },
  );
  check(richCard.title === 'sample' && richCard.thumbnail?.url === avatarImageUrl('👾'),
    'a profile card uses the emoji avatar as its thumbnail', richCard.thumbnail?.url || '(none)');
  check(richCard.fields[0].name === '🕹️ Games played' && richCard.fields[1].name === '🏅 Achievements',
    'the card separates games played from achievements', richCard.fields.map((f) => f.name).join(' / '));
  check(richCard.fields[0].value.includes('**Ping Pong** — 9 games (75%)') && richCard.fields[0].value.includes('**Tic-Tac-Toe** — 3 games (25%)'),
    'each game carries its count and share, resolved through the catalog', richCard.fields[0].value);
  check(richCard.fields[1].value.includes('🥇 **First Blood**') && richCard.fields[1].value.includes('🔥 **On Fire**'),
    'each achievement keeps its icon and name', richCard.fields[1].value);
  check(richCard.color === levelColor(4) && (richCard.description || '').includes('12 games played') && (richCard.description || '').includes('2 achievements earned'),
    'the card headline counts games played and achievements earned', richCard.description);
  const bareCard = profileEmbed({ name: 'bare', level: 1, avatar: 'AB', stats: { games: 0, byGame: {} } }, {});
  check(bareCard.title === 'AB bare' && !bareCard.thumbnail && bareCard.fields[0].value.includes('None yet') && bareCard.fields[1].value.includes('None yet'),
    'a brand-new account gets a text avatar and two empty-state notes', `${bareCard.title} / ${bareCard.fields[0].value}`);

  /* 14. new-idea pings are admin-only: a promoted admin hears about a fresh
        idea, a moderator stays silent - and the moderator socket is proven
        live (watch ack + board broadcast) so the silence means something. */
  const loudAdmin = await register('loudadmin');
  const quietMod = await register('quietmod');
  const promotedAdmin = loudAdmin?.user?.id ? await arcade('POST', `/api/admin/users/${loudAdmin.user.id}`, { token: admin.payload.token, body: { op: 'role', role: 'admin' } }) : null;
  const promotedMod = quietMod?.user?.id ? await arcade('POST', `/api/admin/users/${quietMod.user.id}`, { token: admin.payload.token, body: { op: 'role', role: 'mod' } }) : null;
  check(!!promotedAdmin?.ok && promotedAdmin.payload?.role === 'admin', 'an admin account is ready for the ping check', promotedAdmin?.payload?.message);
  check(!!promotedMod?.ok && promotedMod.payload?.role === 'mod', 'a moderator account is ready for the ping check', promotedMod?.payload?.message);

  if (loudAdmin?.token && quietMod?.token && promotedAdmin?.ok && promotedMod?.ok) {
    const adminWatch = watchBoard(loudAdmin.token);
    const modWatch = watchBoard(quietMod.token);
    await Promise.all([adminWatch.ready, modWatch.ready]);
    const adminWatched = await waitSeen(adminWatch.seen, (m) => m.t === 'suggestions' && m.watching !== false);
    const modWatched = await waitSeen(modWatch.seen, (m) => m.t === 'suggestions' && m.watching !== false);
    check(adminWatched && modWatched, 'the admin and moderator sockets both watch the board');
    const probeTitle = 'Ping routing probe';
    const probe = await arcade('POST', '/api/suggestions', { token: fan.token, body: { title: probeTitle, text: 'The admin hears about this one; the moderator must not.', category: 'feature' } });
    check(probe.ok, 'a new idea posts for the ping check', `status ${probe.status}`);
    const heard = await waitSeen(adminWatch.seen, (m) => m.t === 'notify' && m.kind === 'suggestion' && (m.text || '').includes(probeTitle));
    const ping = adminWatch.seen.find((m) => m.t === 'notify' && m.kind === 'suggestion');
    check(heard && (ping?.text || '').includes(fan.user?.name || ''), 'a promoted admin hears about a new idea', ping?.text || 'no ping seen');
    // The server sends pings before the board broadcast, so the moderator's
    // broadcast doubles as proof its socket was live when the ping was sent.
    const sawBroadcast = await waitSeen(modWatch.seen, (m) => m.t === 'suggestions:changed');
    check(sawBroadcast, 'the moderator socket was live when the idea posted');
    await sleep(150);
    check(!modWatch.seen.some((m) => m.t === 'notify' && m.kind === 'suggestion'), 'the moderator gets no new-idea ping', JSON.stringify(modWatch.seen.filter((m) => m.t === 'notify')));
    adminWatch.ws.close();
    modWatch.ws.close();
  } else {
    check(false, 'the new-idea ping checks', 'the staff accounts above were not ready');
  }

  /* 15. the role is read live, not cached at connect: a socket opened as a
        moderator stays silent on a new idea, is then promoted to admin while
        that same socket is still open, and must hear the very next idea. A
        server that froze the role at connect would keep the socket quiet and
        fail the last check. */
  const liveMod = await register('livemod');
  const livePoster = await register('liveposter');
  const seededMod = liveMod?.user?.id ? await arcade('POST', `/api/admin/users/${liveMod.user.id}`, { token: admin.payload.token, body: { op: 'role', role: 'mod' } }) : null;
  check(!!seededMod?.ok && seededMod.payload?.role === 'mod', 'a moderator account is ready for the live-role check', seededMod?.payload?.message);

  if (liveMod?.token && livePoster?.token && seededMod?.ok) {
    const watch = watchBoard(liveMod.token);
    await watch.ready;
    const watching = await waitSeen(watch.seen, (m) => m.t === 'suggestions' && m.watching !== false);
    check(watching, 'the moderator socket watches the board before any promotion');

    // Still a moderator: a fresh idea must not ping this socket.
    await arcade('POST', '/api/suggestions', { token: livePoster.token, body: { title: 'Live role probe (as moderator)', text: 'A moderator must not hear this one before the promotion.', category: 'feature' } });
    const quietLive = await waitSeen(watch.seen, (m) => m.t === 'suggestions:changed');
    check(quietLive, 'the moderator socket is live when the pre-promotion idea posts');
    await sleep(150);
    check(!watch.seen.some((m) => m.t === 'notify' && m.kind === 'suggestion'), 'the moderator hears no ping before promotion', JSON.stringify(watch.seen.filter((m) => m.t === 'notify')));

    // Promote the same still-open socket, then post again.
    const livePromo = await arcade('POST', `/api/admin/users/${liveMod.user.id}`, { token: admin.payload.token, body: { op: 'role', role: 'admin' } });
    check(!!livePromo?.ok && livePromo.payload?.role === 'admin', 'the connected account is promoted to admin mid-session', livePromo?.payload?.message);

    const loudTitle = 'Live role probe (now admin)';
    await arcade('POST', '/api/suggestions', { token: livePoster.token, body: { title: loudTitle, text: 'The freshly promoted admin should hear about this one.', category: 'feature' } });
    const heardLive = await waitSeen(watch.seen, (m) => m.t === 'notify' && m.kind === 'suggestion' && (m.text || '').includes(loudTitle));
    const livePing = watch.seen.find((m) => m.t === 'notify' && m.kind === 'suggestion');
    check(heardLive, 'the same socket hears a new-idea ping after promotion', livePing?.text || 'no ping seen');
    check((livePing?.text || '').includes(livePoster.user?.name || ''), 'the live ping names the idea author', livePing?.text || '');
    watch.ws.close();
  } else {
    check(false, 'the live-role ping checks', 'the moderator or poster account above was not ready');
  }

  const errored = botLog.join('').includes('failed');
  check(!errored, 'the bot logged no command failures', botLog.filter((l) => l.includes('failed')).slice(0, 2).join(' | '));
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

if (typeof WebSocket !== 'function') {
  console.log('⤼ bot check skipped: the bot needs Node 22+ (built-in WebSocket)');
} else {
  try {
    startFakeDiscord();
    await startArcade();
    await startBot();
    await run();
  } catch (err) {
    failures++;
    console.error(`\nBot check crashed: ${err.stack || err.message}`);
  } finally {
    cleanup();
  }

  console.log(`\n${failures ? `✗ ${failures} failure(s), ${passed} passed` : `✓ all ${passed} bot checks passed`}\n`);
}
process.exit(failures ? 1 : 0);
