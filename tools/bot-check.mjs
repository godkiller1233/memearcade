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
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from '../server/lib/ws.js';
import { Arcade } from '../bot/arcade.js';
import { autoStartEnabled, botConnectionUrl, describeBotExit, readBotEnv } from '../server/bot.js';
import { DiscordGateway, FULL_INTENTS, SAFE_INTENTS } from '../bot/discord.js';
import { arcadeEmbed, profileEmbed, formatChangelog, changelogLine, avatarImageUrl, levelColor, describeSwitches, featureOffReply, parseTextCommand, textCommandHelp, textFallbackHints, optionsToObject, TEXT_PREFIX } from '../bot/commands.js';
import { pong } from '../web/games/engines/arcade.js';
import { stopChild } from './lib/stop-child.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCADE_PORT = 8811 + Math.floor(Math.random() * 40);
const FAKE_PORT = 9411 + Math.floor(Math.random() * 40);
const STRICT_PORT = FAKE_PORT + 137; // a gateway that refuses the privileged intent, like an unconfigured app
const DATA = path.join(ROOT, 'data', 'bot-check');
const BOT_SECRET = 'bot-check-secret-4f9a2c7d1e28';
const APP_ID = '900000000000000001';
const ADMIN_PASS = 'bot-check-admin-2026';
const ARCADE = `http://127.0.0.1:${ARCADE_PORT}`;
// A second arcade, which starts its own bot, on ports the first one never uses.
const AUTO_PORT = 8871 + Math.floor(Math.random() * 40);
const AUTO_DATA = path.join(ROOT, 'data', 'bot-check-auto');

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
  channelMessages: [], // { channelId, body } posted by the bot (text replies and DMs)
  dmBlocked: new Set(), // discord ids whose DMs the fake refuses, like a closed privacy setting
  connections: new Set(),
  seq: 1,
  identified: 0,
  intents: [], // intent mask on every IDENTIFY, in order
  strictIntents: [], // the strict gateway's IDENTIFY masks
  // The servers /users/@me/guilds reports. Deliberately unsorted: the summary
  // puts the owner's servers first, so a pass proves it did not just copy this.
  guilds: [
    { id: '910000000000000002', name: 'Party Friends', icon: null, owner: false },
    { id: '910000000000000001', name: 'Arcade Test Server', icon: 'abcdef0123456789abcdef0123456789', owner: true },
  ],
  channelLookups: [], // guild ids whose channel list was asked for
  // When set, /users/@me only answers a bot that sends exactly this token -
  // which is how the checks prove a token pasted with stray whitespace is
  // trimmed before it is used (Discord would answer 401 for `Bot x `).
  expectedToken: null,
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
      if (fake.expectedToken && req.headers.authorization !== `Bot ${fake.expectedToken}`) {
        return json(401, { message: '401: Unauthorized' });
      }
      return json(200, { id: APP_ID, username: 'memes-arcade-bot', discriminator: '0' });
    }
    if (url.pathname === '/api/v10/gateway/bot') {
      return json(200, { url: `ws://127.0.0.1:${FAKE_PORT}/gateway` });
    }
    if (url.pathname === '/api/v10/users/@me/guilds') {
      return json(200, fake.guilds);
    }
    const guildChannels = url.pathname.match(/^\/api\/v10\/guilds\/(\d+)\/channels$/);
    if (guildChannels) {
      fake.channelLookups.push(guildChannels[1]);
      // One guild hides its channels, like a server that stripped the bot's view:
      // the count must come back unknown, never zero.
      if (guildChannels[1] !== '910000000000000001') return json(403, { message: 'Missing Access' });
      return json(200, [
        { id: '910000000000000101', type: 0, name: 'general' },
        { id: '910000000000000102', type: 0, name: 'arcade' },
        { id: '910000000000000103', type: 2, name: 'Voice' },
        { id: '910000000000000104', type: 5, name: 'news' },
      ]);
    }
    if (req.method === 'POST' && url.pathname === '/api/v10/users/@me/channels') {
      const id = body?.recipient_id;
      if (fake.dmBlocked.has(id)) return json(403, { message: 'Cannot send messages to this user' });
      return json(200, { id: `dm-${id}`, type: 1 });
    }
    const postMessage = url.pathname.match(/^\/api\/v10\/channels\/([^/]+)\/messages$/);
    if (req.method === 'POST' && postMessage) {
      fake.channelMessages.push({ channelId: postMessage[1], body });
      return json(200, { id: `cmsg-${fake.channelMessages.length}`, ...body });
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
          fake.intents.push(msg.d?.intents ?? 0);
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

let strictHttp = null;
let strictWs = null;

/**
 * A second gateway that behaves like a Discord app whose owner never enabled
 * Message Content: the IDENTIFY carrying the privileged bit is closed with
 * 4014, and the retry without it is accepted. The bot must reconnect instead of
 * dying, so slash commands survive an app that was never configured.
 */
function startStrictGateway() {
  strictHttp = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  strictWs = attachWebSocket(strictHttp, {
    path: '/gateway-strict',
    pingIntervalMs: 60000,
    onConnection: (conn) => {
      conn.send({ op: 10, d: { heartbeat_interval: 45000 } });
      conn.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.op === 2) {
          const intents = msg.d?.intents ?? 0;
          fake.strictIntents.push(intents);
          if (intents & 32768) {
            conn.close(4014, 'disallowed intents');
            return;
          }
          conn.send({
            op: 0,
            t: 'READY',
            s: fake.seq++,
            d: {
              user: { id: APP_ID, username: 'strict-bot' },
              session_id: 'strict-session',
              resume_gateway_url: `ws://127.0.0.1:${STRICT_PORT}/gateway-strict`,
            },
          });
        }
        if (msg.op === 1) conn.send({ op: 11 });
      });
    },
  });
  return new Promise((resolve, reject) => {
    strictHttp.once('error', reject);
    strictHttp.listen(STRICT_PORT, '127.0.0.1', resolve);
  });
}

/** Push a MESSAGE_CREATE, the event the text fallback reads. */
function pushMessage(author, content, id) {
  const conn = [...fake.connections][0];
  if (!conn) throw new Error('the bot is not connected to the fake gateway');
  conn.send({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: fake.seq++,
    d: {
      id,
      content,
      channel_id: 'chan-1',
      guild_id: 'guild-1',
      author: { id: author.id, username: author.username, global_name: author.global_name, bot: !!author.bot },
      timestamp: new Date().toISOString(),
    },
  });
}

/** Waits for a message the bot posted, in a channel or a DM. */
async function waitForChannelMessage(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = fake.channelMessages.find(predicate);
    if (hit) return hit;
    await sleep(60);
  }
  throw new Error(`no message for ${label}`);
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
      // This arcade is joined by the bot this suite starts by hand, against the
      // fake gateway; the auto-start check boots its own arcade later.
      MEMES_BOT_AUTOSTART: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  arcadeServer.stderr.on('data', (b) => process.stderr.write(`[arcade] ${b}`));
  await waitFor(async () => (await fetch(`${ARCADE}/api/health`)).ok, 20000, 'the arcade health endpoint');
}

async function startBot() {
  console.log(`Starting the bot against the fake Discord on port ${FAKE_PORT}…`);
  // From here on the fake Discord only answers a correctly formed token,
  // exactly as Discord does.
  fake.expectedToken = 'fake-token';
  bot = spawn(process.execPath, [path.join(ROOT, 'bot', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DISCORD_TOKEN: 'fake-token',
      ARCADE_BOT_SECRET: BOT_SECRET,
      ARCADE_URL: ARCADE,
      DISCORD_API_BASE: `http://127.0.0.1:${FAKE_PORT}/api/v10`,
      DISCORD_GATEWAY_URL: `ws://127.0.0.1:${FAKE_PORT}/gateway`,
      // Read the switches afresh for every command: the checks below flip them
      // and expect the very next interaction to see it.
      BOT_FEATURE_TTL_MS: '0',
      // One report per run: the checks read that first report, then replace it on
      // purpose, and a periodic refresh in the middle would cover the replacement.
      BOT_GUILD_REPORT_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bot.stdout.on('data', (b) => botLog.push(String(b)));
  bot.stderr.on('data', (b) => botLog.push(String(b)));
  await waitFor(() => fake.identified > 0, 15000, 'the bot to identify with the gateway');
}

/**
 * Stops the bot first, then the arcade it was talking to, and waits for both to
 * be gone before the scratch data dir goes: the arcade's SIGTERM shutdown
 * flushes its store, which mkdirSync's the dir back into existence - removing
 * it early left the dir on disk for the stray-state check, and once made
 * rmSync itself throw ENOTEMPTY on a file that had reappeared underneath.
 */
async function cleanup() {
  await stopChild(bot);
  await stopChild(arcadeServer);
  try {
    fakeWs?.close();
    strictWs?.close();
  } catch {}
  try {
    fakeHttp?.close();
    strictHttp?.close();
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
  check(JSON.stringify(names) === JSON.stringify(['arcade', 'changelog', 'help', 'ideas', 'leaderboard', 'link', 'profile', 'suggest', 'vote']), 'the bot registers all nine commands', names.join(', '));
  const helpDef = (registered || []).find((c) => c.name === 'help');
  check(!!helpDef && !helpDef.options?.length, '/help is registered and takes no options', JSON.stringify(helpDef));
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
  // The text fallback needs message events and, for text in servers, the
  // privileged Message Content bit - so the bot has to ask for both.
  check(fake.intents[0] === FULL_INTENTS,
    'the bot asks for the intents text commands need', `${fake.intents[0]} (wanted ${FULL_INTENTS})`);

  /* 1b. an app that never enabled Message Content: Discord closes the gateway
         with 4014. The bot must retry without that one bit, not go offline. */
  await startStrictGateway();
  const strictLogs = [];
  const probe = new DiscordGateway({
    token: 'fake-token',
    intents: FULL_INTENTS,
    gatewayUrl: async () => `ws://127.0.0.1:${STRICT_PORT}/gateway-strict`,
    onDispatch: () => {},
    log: (m) => strictLogs.push(m),
  });
  probe.start();
  let fellBack = false;
  try {
    fellBack = !!(await waitFor(() => probe.ready, 9000, 'the gateway to retry without the privileged intent'));
  } catch {
    fellBack = false;
  }
  check(fellBack, 'the gateway reconnects when Discord refuses the Message Content intent', strictLogs.join(' | '));
  check(JSON.stringify(fake.strictIntents) === JSON.stringify([FULL_INTENTS, SAFE_INTENTS]),
    'the retry drops only the privileged bit and keeps GUILDS, GUILD_MESSAGES and DMs',
    `${JSON.stringify(fake.strictIntents)} (safe ${SAFE_INTENTS})`);
  check(strictLogs.some((line) => /Message Content/.test(line)),
    'the fallback says which Developer Portal switch is missing', strictLogs.join(' | '));
  probe.stop();

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

  /* 4b. the console's server list: only the bot holds the Discord token, so it
        reports the servers it is in and the owner's panel reads that report.
        The list is what lets an owner pick a server and go try the commands in
        it, so the names, the channel counts and the jump-off have to be right. */
  const presenceList = await waitFor(async () => {
    const res = await arcade('GET', '/api/admin/bot/guilds', { token: admin.payload.token });
    return res.ok && res.payload?.guilds?.length ? res.payload : null;
  }, 15000, "the bot's server list report");
  const reported = presenceList.guilds || [];
  const partyFirstSeen = reported.find((g) => g.id === '910000000000000002')?.firstSeen;
  check(reported.length === 2 && reported[0]?.name === 'Arcade Test Server',
    "the bot reports every server it is in, the owner's first",
    reported.map((g) => `${g.name}${g.owner ? ' (owner)' : ''}`).join(', '));
  check(reported[0]?.channels === 3,
    'a channel count comes from the channels Discord shows it', String(reported[0]?.channels));
  check(reported[1]?.channels === null,
    'a server that hides its channels still lists, just without a count', String(reported[1]?.channels));
  check(presenceList.stale === false && presenceList.age >= 0,
    'a fresh check-in is not marked stale', `stale ${presenceList.stale}, age ${presenceList.age}`);
  check(presenceList.bot?.id === APP_ID && presenceList.bot?.username === 'memes-arcade-bot',
    'the panel knows which bot reported', JSON.stringify(presenceList.bot));
  check(String(presenceList.inviteUrl || '').includes(`client_id=${APP_ID}`)
    && String(presenceList.inviteUrl).includes('applications.commands'),
    'the panel gets an invite link for adding the bot to another server', presenceList.inviteUrl);
  check(botLog.join('').includes('reported 2 servers to the arcade console'),
    'the bot says what it reported', botLog.join('').split('\n').find((l) => l.includes('reported ')) || 'no report line');
  check([...fake.channelLookups].sort().join(',') === '910000000000000001,910000000000000002',
    'channels are read once per server, not guessed', fake.channelLookups.join(', '));

  // Only staff may read the list, and only the bot may write it.
  const fanPresence = await arcade('GET', '/api/admin/bot/guilds', { token: fan.token });
  check(fanPresence.status === 403, 'the server list is staff-only', `status ${fanPresence.status}`);
  const anonymousReport = await fetch(`${ARCADE}/api/bot/guilds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guilds: [] }),
  });
  check(anonymousReport.status === 401, 'reporting servers needs the bot secret', `status ${anonymousReport.status}`);

  // A report is input, not gospel: bad ids, duplicates and walls of text are
  // dropped or capped, and one report replaces the last - which is how a server
  // the bot left disappears from the panel.
  const crafted = await fetch(`${ARCADE}/api/bot/guilds`, {
    method: 'POST',
    headers: { 'x-bot-token': BOT_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({
      appId: 'not-an-id',
      username: 'memes-arcade-bot',
      guilds: [
        { id: '910000000000000001', name: 'Arcade Test Server', owner: true, channels: 3 },
        { id: 'not-a-snowflake', name: 'bad' },
        { id: '910000000000000001', name: 'duplicate' },
        { id: '910000000000000009', name: `  ${'x'.repeat(300)}  `, channels: 9999 },
      ],
    }),
  });
  const craftedBody = await crafted.json();
  check(crafted.status === 200 && craftedBody.count === 2,
    'a bad server id is dropped and a repeated one kept once', JSON.stringify(craftedBody));
  const afterCraft = (await arcade('GET', '/api/admin/bot/guilds', { token: admin.payload.token })).payload || {};
  check((afterCraft.guilds || []).length === 2 && afterCraft.guilds.every((g) => g.name.length <= 80),
    'a server name is flattened and capped', JSON.stringify(afterCraft.guilds));
  check(afterCraft.guilds?.find((g) => g.id === '910000000000000009')?.channels === 500,
    'an absurd channel count is capped', String(afterCraft.guilds?.find((g) => g.id === '910000000000000009')?.channels));
  check(afterCraft.bot?.id === null && afterCraft.inviteUrl === null,
    'a bad application id yields no invite link rather than a broken one',
    `${afterCraft.bot?.id} / ${afterCraft.inviteUrl}`);

  /* 4c. The bot has a memory of its servers. A complete report that leaves one
        out marks it as left instead of forgetting it; a capped report says
        nothing about the servers outside its slice; and a server the bot comes
        back to keeps the date it first arrived. */
  const leftOne = afterCraft.left?.find((g) => g.id === '910000000000000002');
  check(!!leftOne && leftOne.name === 'Party Friends' && Number.isFinite(leftOne.leftAt),
    'a server missing from a complete report is remembered as left', JSON.stringify(afterCraft.left));
  check(Number.isFinite(reported.find((g) => g.id === '910000000000000002')?.firstSeen),
    'each live server remembers when it was first seen', JSON.stringify(reported.map((g) => g.firstSeen)));

  await fetch(`${ARCADE}/api/bot/guilds`, {
    method: 'POST',
    headers: { 'x-bot-token': BOT_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({
      appId: APP_ID,
      username: 'memes-arcade-bot',
      total: 2,
      guilds: [{ id: '910000000000000001', name: 'Arcade Test Server', owner: true, channels: 3 }],
    }),
  });
  const capped = (await arcade('GET', '/api/admin/bot/guilds', { token: admin.payload.token })).payload || {};
  check(capped.guilds?.length === 2 && capped.guilds.some((g) => g.id === '910000000000000009'),
    'a capped report does not look like the bot left the servers outside it',
    JSON.stringify(capped.guilds?.map((g) => g.id)));

  await fetch(`${ARCADE}/api/bot/guilds`, {
    method: 'POST',
    headers: { 'x-bot-token': BOT_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({
      appId: APP_ID,
      username: 'memes-arcade-bot',
      total: 2,
      guilds: [
        { id: '910000000000000001', name: 'Arcade Test Server', owner: true, channels: 3 },
        { id: '910000000000000002', name: 'Party Friends', owner: false, channels: null },
      ],
    }),
  });
  const rejoined = (await arcade('GET', '/api/admin/bot/guilds', { token: admin.payload.token })).payload || {};
  const partyBack = rejoined.guilds?.find((g) => g.id === '910000000000000002');
  check(!!partyBack && !rejoined.left?.some((g) => g.id === '910000000000000002'),
    'a server the bot is in again comes back from the history', JSON.stringify(rejoined.left));
  check(partyBack?.firstSeen === partyFirstSeen,
    'coming back keeps the original first-seen date', `${partyBack?.firstSeen} vs ${partyFirstSeen}`);

  /* 4d. Discord's own events move the list: a join shows up without waiting
        for the five-minute refresh, an outage is not a leave, and a real
        removal is what puts a server into the memory. */
  const pushGateway = (type, data) => {
    const conn = [...fake.connections][0];
    if (!conn) throw new Error('the bot is not connected to the fake gateway');
    conn.send({ op: 0, t: type, s: fake.seq++, d: data });
  };
  fake.guilds.push({ id: '910000000000000003', name: 'Weekend Server', icon: null, owner: false });
  pushGateway('GUILD_CREATE', { id: '910000000000000003', name: 'Weekend Server' });
  const joined = await waitFor(async () => {
    const res = await arcade('GET', '/api/admin/bot/guilds', { token: admin.payload.token });
    return res.ok && res.payload?.guilds?.some((g) => g.id === '910000000000000003') ? res.payload : null;
  }, 10000, 'a join to reach the console without the report timer');
  check(joined.guilds.some((g) => g.id === '910000000000000003'),
    'a server the bot joins appears straight away', joined.guilds.map((g) => g.id).join(', '));
  check(botLog.join('').includes('joined a server (910000000000000003)'),
    'the bot says it joined a server', botLog.join('').split('\n').filter((l) => l.includes('server (')).slice(-2).join(' | '));

  // Discord calls a guild "unavailable" during an outage: it is still the
  // bot's server, and pretending otherwise would bury it in the history.
  fake.guilds = fake.guilds.filter((g) => g.id !== '910000000000000003');
  pushGateway('GUILD_DELETE', { id: '910000000000000003', unavailable: true });
  await sleep(3000);
  const afterOutage = (await arcade('GET', '/api/admin/bot/guilds', { token: admin.payload.token })).payload || {};
  check(!!afterOutage.guilds?.find((g) => g.id === '910000000000000003')
    && !afterOutage.left?.some((g) => g.id === '910000000000000003'),
    'a Discord outage is not mistaken for the bot leaving', JSON.stringify(afterOutage.guilds?.map((g) => g.id)));

  pushGateway('GUILD_DELETE', { id: '910000000000000003' });
  const removed = await waitFor(async () => {
    const res = await arcade('GET', '/api/admin/bot/guilds', { token: admin.payload.token });
    return res.ok && res.payload?.left?.some((g) => g.id === '910000000000000003') ? res.payload : null;
  }, 10000, 'a removal to reach the console history');
  check(removed.left.find((g) => g.id === '910000000000000003')?.name === 'Weekend Server',
    'a server the bot is removed from is kept, with its name', JSON.stringify(removed.left));

  // The memory lives in the database file, not in either process, so an arcade
  // or bot restart reads it back instead of starting empty.
  const saved = await waitFor(() => {
    const raw = JSON.parse(readFileSync(path.join(DATA, 'db.json'), 'utf8'));
    return raw.botGuilds?.['910000000000000003']?.leftAt ? raw : null;
  }, 8000, 'the server memory to be written to disk');
  check(Number.isFinite(saved.botGuilds['910000000000000003'].firstSeen)
    && saved.botGuilds['910000000000000003'].leftAt >= saved.botGuilds['910000000000000003'].firstSeen,
    'the memory is written to the database, so a restart keeps it');
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

  /* 15b. /help is the discovery path for both entries: it lists every command
         straight from the registration, and it tells a player whose `/` menu is
         still empty that the same commands answer as messages. It needs no link
         and no switches, and it must fit in one Discord message whole. */
  const helperUser = { id: 'discord-helper-7', username: 'helper' };
  const slashHelp = await interact(helperUser, 'help');
  const helpBody = slashHelp.message?.content || '';
  check(slashHelp.callback?.data?.flags === undefined && !!helpBody,
    '/help answers in the channel, not privately', JSON.stringify(slashHelp.callback?.data));
  check((registered || []).every((c) => helpBody.includes(`/${c.name}`)),
    '/help lists every registered command', helpBody.slice(0, 140));
  check(helpBody.includes(`${TEXT_PREFIX} <command>`) && helpBody.includes(`${TEXT_PREFIX} arcade ideafan`),
    "/help advertises the text fallback with a concrete example", helpBody.slice(-220));
  check(helpBody.includes('`/suggest <title> <details> [category]`'),
    '/help shows which arguments a command needs', helpBody.slice(0, 200));
  check(helpBody.length < 1990, 'the whole command list fits in one message', `${helpBody.length} chars`);
  check(!helpBody.includes('Link your account first'),
    '/help needs no linked account', helpBody.slice(0, 120));
  check(JSON.stringify(slashHelp.message?.allowed_mentions) === '{"parse":[]}',
    '/help never pings anyone', JSON.stringify(slashHelp.message?.allowed_mentions));
  // One renderer, two forms: the message list names the very same commands.
  const helpAsText = textCommandHelp();
  check((registered || []).every((c) => helpAsText.includes(`• \`${TEXT_PREFIX} ${c.name}`)),
    'the message form lists the same commands as /help', helpAsText.slice(0, 140));
  check(!helpAsText.includes('/help') && helpAsText.includes(`${TEXT_PREFIX} help`),
    'the message form points at itself, never at a slash command that may be missing',
    helpAsText.slice(-200));

  /* 16. feature switches: the bot is not a second door around a switch. The
        owner closes the idea board and every board command announces it; a
        hidden feature keeps serving; a scheduled window names when it reopens;
        and restoring a switch brings the command straight back. */
  const switches = (body) => arcade('POST', '/api/admin/features', { token: admin.payload.token, body });
  const liveFlags = async () => (await arcade('GET', '/api/meta')).payload?.config?.features || {};
  const replyOf = (msg) => msg.message?.content || '';

  check(botLog.join('').includes('feature switches: everything is on and shown'),
    'the bot announces the arcade switch state at boot', botLog.join('').split('\n').find((l) => l.includes('feature switches')) || 'no switch line');
  check(describeSwitches(null).includes('could not be read'),
    'an unreadable switch map is reported, never treated as all-clear', describeSwitches(null));
  check(describeSwitches({ suggestions: { on: false }, changelog: { on: true, hidden: true } }) === 'feature switches: 1 off (Idea board) · 1 hidden (Changelog)',
    'the boot line names exactly what is off and hidden', describeSwitches({ suggestions: { on: false }, changelog: { on: true, hidden: true } }));
  const scheduledReply = featureOffReply('suggestions', { on: false, scheduled: true, until: '2026-10-09T05:00:00.000Z' });
  check(scheduledReply.content.includes('Idea board is turned off') && scheduledReply.content.includes('It is on a schedule')
    && /reopens <t:\d+:R>/.test(scheduledReply.content) && scheduledReply.ephemeral === true,
    'a scheduled close names the feature and stamps its reopen', scheduledReply.content);

  const boardOff = await switches({ id: 'suggestions', on: false });
  check(boardOff.ok && boardOff.payload?.on === false, 'the owner switches the idea board off', boardOff.payload?.message);
  check((await liveFlags()).suggestions?.on === false, 'the switch is live on the arcade');

  const ideasOff = await interact(fanUser, 'ideas', [{ name: 'sort', value: 'top' }]);
  check(replyOf(ideasOff).includes('Idea board is turned off on this arcade'), '/ideas announces the switched-off idea board', replyOf(ideasOff).slice(0, 120));
  check(replyOf(ideasOff).includes('The owner switched it off'), '/ideas says who closed it and what to do', replyOf(ideasOff).slice(0, 170));
  check(!replyOf(ideasOff).includes('Kart racing mini-game'), '/ideas serves no board while it is off');
  check(!ideasOff.callback?.data?.flags, '/ideas keeps its public reply for the notice');

  const suggestOff = await interact(stranger, 'suggest', [
    { name: 'title', value: 'Anything at all' },
    { name: 'details', value: 'This must be refused before the link check asks for anything.' },
  ]);
  check(replyOf(suggestOff).includes('Idea board is turned off'), '/suggest announces before asking to link', replyOf(suggestOff).slice(0, 120));
  check(suggestOff.callback?.data?.flags === 64, '/suggest keeps its private reply for the notice');

  const voteOff = await interact(stranger, 'vote', [{ name: 'idea', value: 'zzzzzzzz' }]);
  check(replyOf(voteOff).includes('Idea board is turned off'), '/vote announces before it looks the idea up', replyOf(voteOff).slice(0, 120));

  const logWhileBoardOff = await interact(fanUser, 'changelog');
  check((replyOf(logWhileBoardOff) || '').includes('shipped'), '/changelog keeps serving while only the idea board is off', replyOf(logWhileBoardOff).slice(0, 100));

  // Hidden is not off: the log still answers, and only the boot line says so.
  await switches({ id: 'changelog', hidden: true });
  const hiddenLog = await interact(fanUser, 'changelog');
  check(replyOf(hiddenLog).includes('ideas shipped') && replyOf(hiddenLog).includes('**Changelog**'), 'a hidden feature still serves the bot', replyOf(hiddenLog).slice(0, 110));
  check(describeSwitches(await liveFlags()).includes('1 hidden (Changelog)'), 'the switch map reports the hidden feature', describeSwitches(await liveFlags()));
  await switches({ id: 'changelog', hidden: false });

  // Leaderboards: the whole board closes, and the picker goes quiet with it.
  await switches({ id: 'leaderboard', on: false });
  const ranksOff = await interact(fanUser, 'leaderboard', []);
  check(replyOf(ranksOff).includes('Leaderboards is turned off on this arcade'), '/leaderboard announces the closed board', replyOf(ranksOff).slice(0, 120));
  const gameBoardOff = await interact(fanUser, 'leaderboard', [{ name: 'game', value: 'pong' }]);
  check(replyOf(gameBoardOff).includes('Leaderboards is turned off'), 'the per-game board announces it too', replyOf(gameBoardOff).slice(0, 120));
  const offChoices = await pushAutocomplete(fanUser, 'leaderboard', [{ name: 'game', value: 'pin', focused: true }]);
  check((offChoices.callback?.data?.choices || []).length === 0, 'the game picker offers nothing while leaderboards are off', JSON.stringify(offChoices.callback?.data));
  const profileWhileOff = await interact(fanUser, 'arcade', [{ name: 'player', value: 'ideafan' }]);
  check(profileWhileOff.message?.embeds?.[0]?.title === 'ideafan', 'profile lookups keep working while leaderboards are off');
  await switches({ id: 'leaderboard', on: true });

  // Hiding the game library quiets the picker, exactly like the site's Games
  // tab - a typed id or name still reaches the board (a deep link still works).
  await switches({ id: 'catalog', hidden: true });
  const hiddenChoices = await pushAutocomplete(fanUser, 'leaderboard', [{ name: 'game', value: 'pin', focused: true }]);
  check((hiddenChoices.callback?.data?.choices || []).length === 0, 'hiding the game library empties the game picker', JSON.stringify(hiddenChoices.callback?.data));
  const typedGame = await interact(fanUser, 'leaderboard', [{ name: 'game', value: 'ping' }]);
  check(replyOf(typedGame).includes('Ping Pong'), 'a typed game still reaches its board while the library is hidden', replyOf(typedGame).slice(0, 100));
  await switches({ id: 'catalog', hidden: false });

  // A schedule never overrides the manual switch: with the board already off,
  // the notice blames the owner, because the window is not why it is closed.
  const manualWindow = await switches({ id: 'suggestions', schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '00:00' } });
  check(manualWindow.ok && manualWindow.payload?.on === false && manualWindow.payload?.hasSchedule === true,
    'a schedule stored beside a manual off is kept', JSON.stringify(manualWindow.payload?.schedule));
  const stillManual = await interact(fanUser, 'ideas', []);
  check(replyOf(stillManual).includes('The owner switched it off') && !replyOf(stillManual).includes('It is on a schedule'),
    'a manually closed board is not blamed on its schedule', replyOf(stillManual).slice(0, 120));

  // Now the window alone closes it: the notice names when it reopens.
  const scheduled = await switches({ id: 'suggestions', on: true, schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '00:00' } });
  check(scheduled.ok && scheduled.payload?.on === true && scheduled.payload?.closed === true,
    'the window alone closes the idea board right now', JSON.stringify(scheduled.payload?.schedule));
  const ideasScheduled = await interact(fanUser, 'ideas', []);
  check(replyOf(ideasScheduled).includes('It is on a schedule') && /reopens <t:\d+:R>/.test(replyOf(ideasScheduled)),
    '/ideas names the scheduled reopening', replyOf(ideasScheduled).slice(0, 170));
  const boardRestored = await switches({ id: 'suggestions', on: true, hidden: false, schedule: null });
  check(boardRestored.ok && boardRestored.payload?.closed === false && boardRestored.payload?.hasSchedule === false, 'the schedule is cleared again', JSON.stringify(boardRestored.payload?.schedule));
  const boardBack = await interact(fanUser, 'ideas', [{ name: 'sort', value: 'top' }]);
  check(replyOf(boardBack).includes('Kart racing mini-game'), 'restoring the switch brings /ideas straight back', replyOf(boardBack).slice(0, 100));

  /* 17. the text fallback: `!memearcade <command>` answers when the slash
        commands are not there yet (an hour of rollout, or an invite without the
        applications.commands scope). It runs the same runCommand, obeys the same
        switches, and DMs the private answers a message cannot mark ephemeral. */
  const chan = (m) => m.channelId === 'chan-1';
  const dmOf = (id) => (m) => m.channelId === `dm-${id}`;

  // The parser on its own, before any round-trip.
  check(parseTextCommand('good morning everyone') === null, 'a normal message is not a text command');
  check(parseTextCommand('!memearcade').help === true && parseTextCommand('  !MEMEArcade help ').help === true,
    'the bare prefix and help answer with the command list, whatever the case');
  const keyedIdeas = parseTextCommand('!memearcade ideas sort:new category:game');
  const keyedIdeasOpts = optionsToObject(keyedIdeas?.options || []);
  check(keyedIdeas?.name === 'ideas' && keyedIdeasOpts.sort === 'new' && keyedIdeasOpts.category === 'game',
    'name:value options are read', JSON.stringify(keyedIdeas));
  const positionalIdeas = parseTextCommand('!memearcade ideas newest in progress games');
  const positionalOpts = optionsToObject(positionalIdeas?.options || []);
  check(positionalIdeas?.name === 'ideas' && positionalOpts.sort === 'new' && positionalOpts.status === 'in-progress' && positionalOpts.category === 'game',
    'filters in any order are read, and "in progress" is one status', JSON.stringify(positionalIdeas));
  const voted = parseTextCommand('!memearcade /vote #a1b2c3d4');
  check(voted?.name === 'vote' && optionsToObject(voted.options).idea === 'a1b2c3d4',
    'a vote reads the id with or without a #, and tolerates a typed slash', JSON.stringify(voted));
  const named = parseTextCommand('!memearcade arcade some player name');
  check(optionsToObject(named?.options || []).player === 'some player name',
    'a player name keeps its spaces', JSON.stringify(named));
  const lbText = parseTextCommand('!memearcade leaderboard wins ping pong');
  const lbOpts = optionsToObject(lbText?.options || []);
  check(lbOpts.sort === 'wins' && lbOpts.game === 'ping pong',
    'a positional leaderboard reads the sort then the game', JSON.stringify(lbText));
  const suggestText = parseTextCommand('!memearcade suggest Kart racing | A top-down racer. | game');
  const suggestOpts = optionsToObject(suggestText?.options || []);
  check(suggestOpts.title === 'Kart racing' && suggestOpts.details === 'A top-down racer.' && suggestOpts.category === 'game',
    'suggest takes title | details | category', JSON.stringify(suggestText));
  check(!!parseTextCommand('!memearcade suggest only a title')?.error,
    'suggest without details explains the pipe syntax');
  check(/not a command/.test(parseTextCommand('!memearcade nope')?.error || ''),
    'an unknown command says so');
  check(/not an idea filter/.test(parseTextCommand('!memearcade ideas nonsense')?.error || ''),
    'an unknown idea filter says so');
  const helpText = textCommandHelp();
  check((registered || []).every((c) => helpText.includes(`${TEXT_PREFIX} ${c.name}`)),
    'the help lists every registered command', helpText.slice(0, 80));
  check(textFallbackHints('Run `/link` here, then `/arcade`.') === `Run \`${TEXT_PREFIX} link\` here, then \`${TEXT_PREFIX} arcade\`.`
    && textFallbackHints('see /api/meta or a/b') === 'see /api/meta or a/b',
    'slash hints in a reply become text commands, and other paths are left alone',
    textFallbackHints('Run `/link` here, then `/arcade`.'));

  // End to end through the fake gateway: a public answer lands in the channel,
  // quoting the message that asked.
  const ideasAsk = `m-${fake.seq++}`;
  pushMessage(fanUser, '!memearcade ideas', ideasAsk);
  const ideasText = await waitForChannelMessage((m) => chan(m) && m.body?.message_reference?.message_id === ideasAsk, 'the text ideas board');
  check((ideasText.body?.content || '').includes('Kart racing mini-game'),
    'a text command serves the same board the slash command does', (ideasText.body?.content || '').slice(0, 120));
  check(JSON.stringify(ideasText.body?.allowed_mentions) === '{"parse":[]}',
    'a text reply never pings anyone', JSON.stringify(ideasText.body?.allowed_mentions));

  // A private answer cannot be ephemeral as a message, so it is a DM - and the
  // channel must not see the stats or, later, a link code.
  const privateAsk = `m-${fake.seq++}`;
  pushMessage(fanUser, '!memearcade arcade player:ideafan', privateAsk);
  const privateDm = await waitForChannelMessage(dmOf(fanUser.id), 'the private profile DM');
  check(privateDm.body?.embeds?.[0]?.title === 'ideafan',
    'a private text answer arrives as a DM', privateDm.body?.embeds?.[0]?.title || '(no embed)');
  check(!fake.channelMessages.some((m) => chan(m) && m.body?.message_reference?.message_id === privateAsk),
    'the private answer is not posted in the channel');

  const helpAsk = `m-${fake.seq++}`;
  pushMessage(fanUser, '!memearcade', helpAsk);
  const helpReply = await waitForChannelMessage((m) => chan(m) && m.body?.message_reference?.message_id === helpAsk, 'the text help list');
  check((helpReply.body?.content || '').includes(`${TEXT_PREFIX} suggest <title>`) && (helpReply.body?.content || '').includes(`${TEXT_PREFIX} vote`),
    'the bare prefix answers with the copyable command list', (helpReply.body?.content || '').slice(0, 120));

  // Silence is part of the contract: ordinary chatter and other bots' messages
  // must not be answered.
  const beforeQuiet = fake.channelMessages.length;
  pushMessage(fanUser, 'good morning everyone', `m-${fake.seq++}`);
  pushMessage({ ...fanUser, id: 'discord-other-bot', username: 'otherbot', bot: true }, '!memearcade ideas', `m-${fake.seq++}`);
  await sleep(900);
  check(fake.channelMessages.length === beforeQuiet, 'ordinary chat and other bots are left alone',
    `${fake.channelMessages.length - beforeQuiet} unexpected replies`);

  // A player whose privacy settings refuse DMs: the channel hears that the
  // answer is private, never the answer itself (a link code would be a hijack).
  const closedUser = { id: 'discord-closed-dms', username: 'nodms' };
  fake.dmBlocked.add(closedUser.id);
  const closedAsk = `m-${fake.seq++}`;
  pushMessage(closedUser, '!memearcade link', closedAsk);
  const closedNote = await waitForChannelMessage((m) => chan(m) && m.body?.message_reference?.message_id === closedAsk, 'the closed-DM notice');
  check((closedNote.body?.content || '').includes('would not let me message you'),
    'a refused DM explains itself in the channel', (closedNote.body?.content || '').slice(0, 120));
  check(!(closedNote.body?.content || '').includes('Link your Discord account'),
    'a refused DM never leaks the private reply or its link code', closedNote.body?.content || '');

  // The linked account can vote and post through the fallback too.
  const voteBoard = await arcade('GET', '/api/suggestions?status=all');
  const voteTarget = (voteBoard.payload?.suggestions || []).find((s) => s.title === 'Kart racing mini-game');
  if (voteTarget) {
    const strangerUser = { id: 'discord-stranger-9', username: 'stranger' };
    pushMessage(strangerUser, `!memearcade vote ${voteTarget.id.slice(0, 6)}`, `m-${fake.seq++}`);
    const voteDm = await waitForChannelMessage(dmOf(strangerUser.id), 'the vote DM');
    check(/Upvoted|Removed your vote/.test(voteDm.body?.content || ''),
      'a text vote acts as the linked account and answers by DM', (voteDm.body?.content || '').slice(0, 100));

    pushMessage(strangerUser, '!memearcade suggest Text fallback | A message-only idea for the bot check. | feature', `m-${fake.seq++}`);
    const suggestDm = await waitForChannelMessage(
      (m) => dmOf(strangerUser.id)(m) && (m.body?.content || '').includes('Posted to the idea board'),
      'the suggest DM',
    );
    check((suggestDm.body?.content || '').includes(`${TEXT_PREFIX} ideas`) && !(suggestDm.body?.content || '').includes('`/ideas`'),
      'the reply points at the text form of the command it names', (suggestDm.body?.content || '').slice(-120));
    const postedBoard = await arcade('GET', '/api/suggestions?status=all');
    check((postedBoard.payload?.suggestions || []).some((s) => s.title === 'Text fallback' && s.fromName === 'secondfan'),
      'a text suggest posts to the real board as the linked account');
  } else {
    check(false, 'the text vote and suggest checks', 'the kart idea was not on the board');
  }

  const usageAsk = `m-${fake.seq++}`;
  pushMessage(fanUser, '!memearcade vote', usageAsk);
  const usageReply = await waitForChannelMessage((m) => chan(m) && m.body?.message_reference?.message_id === usageAsk, 'the usage hint');
  check((usageReply.body?.content || '').includes('Pass an idea id'),
    'a missing option is answered where it was typed, not DMed', (usageReply.body?.content || '').slice(0, 100));

  const errored = botLog.join('').includes('failed');
  check(!errored, 'the bot logged no command failures', botLog.filter((l) => l.includes('failed')).slice(0, 2).join(' | '));
}

/* ------------------------------------------------------------------ *
 * starting with the site
 * ------------------------------------------------------------------ */

/**
 * The site starts the bot by itself: boot another arcade with a token and the
 * auto-start switch on, and run nothing by hand. The fake gateway must see the
 * bot identify, the bot's own log must show it reached the arcade with the
 * secret the site handed over, and stopping that arcade must take the bot with
 * it - an orphan would answer every command a second time.
 */
async function checkAutoStart() {
  // The decisions, without a token having to exist on this machine.
  check(autoStartEnabled({}) && autoStartEnabled({ MEMES_BOT_AUTOSTART: 'on' })
    && !autoStartEnabled({ MEMES_BOT_AUTOSTART: 'off' }) && !autoStartEnabled({ MEMES_BOT_AUTOSTART: '0' }),
    'the site starts the bot by default, and MEMES_BOT_AUTOSTART=off stops it');
  check(botConnectionUrl(8877, '0.0.0.0') === 'http://127.0.0.1:8877'
    && botConnectionUrl(8877, '::') === 'http://127.0.0.1:8877'
    && botConnectionUrl(8877, '127.0.0.1') === 'http://127.0.0.1:8877',
    'the bot is pointed at the real port, never the bind wildcard', botConnectionUrl(8877, '0.0.0.0'));
  const envFile = path.join(os.tmpdir(), `bot-env-${process.pid}.env`);
  writeFileSync(envFile, '# a comment\nDISCORD_TOKEN="quoted-token"\nARCADE_URL=http://example.test:1\n', 'utf8');
  const parsed = readBotEnv(envFile);
  rmSync(envFile, { force: true });
  check(parsed.DISCORD_TOKEN === 'quoted-token' && parsed.ARCADE_URL === 'http://example.test:1' && !('a comment' in parsed),
    'the website reads bot/.env with the same rules the bot does', JSON.stringify(parsed));

  // Health is where a bot that never came online has to be visible, so the
  // reason has to be there too - starting with the switch this suite turns off.
  const offHealth = await (await fetch(`${ARCADE}/api/health`)).json();
  check(offHealth.bot?.running === false && /MEMES_BOT_AUTOSTART/.test(offHealth.bot?.reason || ''),
    'health says the bot is off and why (the switch)', JSON.stringify(offHealth.bot));

  rmSync(AUTO_DATA, { recursive: true, force: true });
  const beforeIdentified = fake.identified;
  const beforeConnections = fake.connections.size;
  const logs = [];
  const url = `http://127.0.0.1:${AUTO_PORT}`;
  // This token is pasted with the stray whitespace a hosting dashboard keeps,
  // and the fake Discord only answers the trimmed one - so the bot only comes
  // online if the site (and the bot) trim before using it.
  fake.expectedToken = 'auto-token';
  const auto = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MEMES_PORT: String(AUTO_PORT),
      MEMES_HOST: '127.0.0.1',
      MEMES_DATA: AUTO_DATA,
      MEMES_PLATFORM: 'bot-check',
      MEMES_ADMIN_PASS: ADMIN_PASS,
      MEMES_BOT_SECRET: `${BOT_SECRET}-auto`,
      MEMES_BOT_AUTOSTART: 'on',
      // Only the token: the URL and the secret below are the site's own.
      DISCORD_TOKEN: '  auto-token\n',
      DISCORD_API_BASE: `http://127.0.0.1:${FAKE_PORT}/api/v10`,
      DISCORD_GATEWAY_URL: `ws://127.0.0.1:${FAKE_PORT}/gateway`,
      BOT_FEATURE_TTL_MS: '0',
      BOT_GUILD_REPORT_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  auto.stdout.on('data', (b) => logs.push(String(b)));
  auto.stderr.on('data', (b) => logs.push(String(b)));
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${url}/api/health`)).ok;
      } catch {
        return false;
      }
    }, 20000, 'the auto-start arcade');
    const started = await waitFor(() => fake.identified > beforeIdentified, 15000, 'the site to start the bot')
      .then(() => true)
      .catch(() => false);
    const output = logs.join('');
    const botLines = output.split('\n').filter((l) => /bot/i.test(l)).slice(-2).join(' | ');
    check(started, 'starting the site starts the bot - no npm run bot needed', botLines);
    // The report proves both halves of the wiring: the address (the site's
    // real port) and the secret (the one this server hands out, not a stale
    // copy in bot/.env). A 401 here would log "report failed".
    const reported = await waitFor(() => /reported 2 servers to the arcade console/.test(logs.join('')), 8000, 'the bot to report its servers')
      .then(() => true)
      .catch(() => false);
    check(reported, 'the bot the site started reached the arcade with the secret the site handed it',
      logs.join('').split('\n').filter((l) => /reported|report failed/i.test(l)).slice(-2).join(' | '));
    check(/Discord bot \.\.\.\.\.\. started with the site/.test(output),
      'the banner says the bot is running with the site',
      output.split('\n').filter((l) => /Discord bot/i.test(l)).slice(-2).join(' | '));
    check(/surrounding whitespace/.test(output),
      'the site noticed the token had stray whitespace and trimmed it',
      output.split('\n').filter((l) => /whitespace/i.test(l)).slice(-1).join(' | '));
    const runningHealth = await (await fetch(`${url}/api/health`)).json();
    check(runningHealth.bot?.running === true && /started with the site/.test(runningHealth.bot?.reason || ''),
      'health says the bot is running', JSON.stringify(runningHealth.bot));
  } finally {
    await stopChild(auto);
  }

  const gone = await waitFor(() => fake.connections.size === beforeConnections, 12000, 'the bot to disconnect')
    .then(() => true)
    .catch(() => false);
  check(gone, 'stopping the site stops the bot it started (no duplicate left online)',
    `${fake.connections.size} gateway connection(s) left, expected ${beforeConnections}`);

  // A token Discord rejects has its own exit code, so a supervisor - and the
  // /api/health line that reads its words - can say "Discord rejected the
  // token" instead of "exited with code 1".
  fake.expectedToken = 'only-this-token';
  const rejectedLog = [];
  const rejected = spawn(process.execPath, [path.join(ROOT, 'bot', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DISCORD_TOKEN: 'not-the-token',
      ARCADE_BOT_SECRET: BOT_SECRET,
      ARCADE_URL: ARCADE,
      DISCORD_API_BASE: `http://127.0.0.1:${FAKE_PORT}/api/v10`,
      DISCORD_GATEWAY_URL: `ws://127.0.0.1:${FAKE_PORT}/gateway`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rejected.stderr.on('data', (b) => rejectedLog.push(String(b)));
  const rejectedCode = await new Promise((resolve) => rejected.once('exit', (code) => resolve(code)));
  check(rejectedCode === 3, 'a token Discord rejects exits with its own code (3)', String(rejectedCode));
  check(describeBotExit(3) === 'exited with code 3 - Discord rejected the token'
    && /configuration/.test(describeBotExit(2))
    && describeBotExit(1) === 'exited with code 1'
    && describeBotExit(null, 'SIGKILL') === 'stopped by SIGKILL',
    'the supervisor turns that code into words for the banner and health', describeBotExit(3));
  check(/Discord rejected the bot token/.test(rejectedLog.join('')),
    'and the reason is on stderr for the host log', rejectedLog.join('').trim().split('\n').slice(-1)[0] || '(nothing)');
  fake.expectedToken = null;

  // And the other invisible case: a service with the switch on but no token at
  // all must say exactly that on /api/health, not just look quiet.
  fake.expectedToken = null;
  const noToken = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MEMES_PORT: String(AUTO_PORT),
      MEMES_HOST: '127.0.0.1',
      MEMES_DATA: AUTO_DATA,
      MEMES_PLATFORM: 'bot-check',
      MEMES_ADMIN_PASS: ADMIN_PASS,
      MEMES_BOT_SECRET: `${BOT_SECRET}-auto`,
      MEMES_BOT_AUTOSTART: 'on',
      // No DISCORD_TOKEN on purpose.
      DISCORD_API_BASE: `http://127.0.0.1:${FAKE_PORT}/api/v10`,
      DISCORD_GATEWAY_URL: `ws://127.0.0.1:${FAKE_PORT}/gateway`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${url}/api/health`)).ok;
      } catch {
        return false;
      }
    }, 20000, 'the no-token arcade');
    const health = await (await fetch(`${url}/api/health`)).json();
    check(health.bot?.running === false && /DISCORD_TOKEN/.test(health.bot?.reason || ''),
      'a service with no token says so on /api/health', JSON.stringify(health.bot));
  } finally {
    await stopChild(noToken);
  }
  rmSync(AUTO_DATA, { recursive: true, force: true });
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
    await checkAutoStart();
  } catch (err) {
    failures++;
    console.error(`\nBot check crashed: ${err.stack || err.message}`);
  } finally {
    await cleanup();
  }

  console.log(`\n${failures ? `✗ ${failures} failure(s), ${passed} passed` : `✓ all ${passed} bot checks passed`}\n`);
}
process.exit(failures ? 1 : 0);
