/**
 * REST API.  Everything the web client, desktop client and Discord bot need,
 * plus a few endpoints the realtime hub does not cover (catalog, admin,
 * leaderboards, bot account linking).
 */
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, clientIp } from './lib/http.js';
import { config } from './config.js';
import { db } from './lib/db.js';
import {
  ROLES,
  canManage,
  createSession,
  isStaff,
  rateLimit,
  revokeSession,
  revokeUserSessions,
  roleLevel,
  sessionUser,
  signPayload,
  validatePassword,
  validateUsername,
  verifyPassword,
  verifyPayload,
} from './lib/auth.js';
import { ideaNotify } from './lib/notify.js';
import {
  audit,
  banUser,
  createUser,
  deleteUser,
  dmConversations,
  dmHistory,
  friendIds,
  friendList,
  getUser,
  getUserByName,
  grantXp,
  leaderboard,
  levelFromXp,
  listUsers,
  requestFriend,
  acceptFriend,
  removeFriend,
  sanitizeText,
  sendDm,
  setPassword,
  unbanUser,
  updateProfile,
  updateSettings,
  userPublic,
} from './store.js';
import { engineCatalog, engineErrors, getEngine } from './games.js';
import { onlineCount } from './lib/presence.js';
import { metaPayload, negotiate, APP_NAME, APP_VERSION, API_VERSION, MIN_CLIENT_VERSION } from '../shared/version.js';
import { downloadManifest, getDownload } from './lib/downloads.js';
import { id as newId, now } from './lib/ids.js';
import { GAMES, catalogWithEngines } from '../web/games/registry.js';

const MIME_AUDIO = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };

/** The public idea board: what players may suggest, and how staff triage it. */
const SUGGESTION_CATEGORIES = ['game', 'feature', 'update', 'other'];
const SUGGESTION_STATUSES = ['open', 'planned', 'in-progress', 'done', 'declined'];

function clientOf(ctx) {
  return {
    kind: ctx.req.headers['x-client'] || ctx.query.get('client') || 'web',
    version: (ctx.req.headers['x-client-version'] || ctx.query.get('cv') || '').toString(),
    caps: (ctx.req.headers['x-client-caps'] || ctx.query.get('caps') || '').toString(),
    api: ctx.req.headers['x-api-version'] || null,
    platform: ctx.req.headers['x-client-platform'] || 'unknown',
  };
}

function tokenOf(ctx) {
  const auth = ctx.req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (ctx.req.headers['x-session']) return String(ctx.req.headers['x-session']);
  const cookie = ctx.req.headers.cookie;
  if (cookie) {
    const m = /(?:^|;\s*)ma_token=([^;]+)/.exec(cookie);
    if (m) return decodeURIComponent(m[1]);
  }
  const q = ctx.query.get('token');
  return q || null;
}

function requireAuth(ctx) {
  const found = sessionUser(tokenOf(ctx));
  if (!found) throw new HttpError(401, 'Please sign in again.');
  if (found.user.banned) throw new HttpError(403, found.user.banned.reason || 'Account suspended.');
  ctx.user = found.user;
  ctx.session = found.session;
  return found.user;
}

function requireStaff(ctx, level = ROLES.mod) {
  const user = requireAuth(ctx);
  if (roleLevel(user.role) < level) throw new HttpError(403, 'Staff only.');
  return user;
}

function requireBot(ctx) {
  const secret = ctx.req.headers['x-bot-token'] || '';
  const expected = botSecret();
  if (!expected || secret !== expected) throw new HttpError(401, 'Invalid bot token.');
  return true;
}

let cachedBotSecret = null;
export function botSecret() {
  if (cachedBotSecret) return cachedBotSecret;
  // A public deployment pins the bot secret in the environment so the bot keeps
  // working across redeploys, which wipe data/bot-secret.txt.
  if (config.botSecret && config.botSecret.length >= 16) {
    cachedBotSecret = config.botSecret;
    return cachedBotSecret;
  }
  const file = path.join(config.dataDir, 'bot-secret.txt');
  try {
    if (fs.existsSync(file)) {
      cachedBotSecret = fs.readFileSync(file, 'utf8').trim();
      if (cachedBotSecret.length >= 16) return cachedBotSecret;
    }
  } catch {}
  cachedBotSecret = signPayload({ role: 'bot' }, 0).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  try {
    fs.writeFileSync(file, cachedBotSecret, { mode: 0o600 });
  } catch {}
  return cachedBotSecret;
}

function setCookie(ctx, token, days = 30) {
  const secure = ctx.req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  ctx.res.setHeader(
    'Set-Cookie',
    `ma_token=${encodeURIComponent(token)}; Path=/; Max-Age=${days * 86400}; HttpOnly; SameSite=Lax${secure}`,
  );
}

function authRate(ctx, name, max = 12, windowMs = 60000) {
  const ip = clientIp(ctx.req);
  const r = rateLimit(`${name}:${ip}`, max, windowMs);
  if (!r.ok) throw new HttpError(429, 'Too many attempts. Wait a moment and try again.');
  return r;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export function registerApi(app, { rooms, hub }) {
  /* ---------------- meta / health ---------------- */

  app.get('/api/health', () => ({
    ok: true,
    status: 'healthy',
    now: now(),
    uptime: process.uptime(),
    rooms: rooms.rooms.size,
    online: onlineCount(),
    engines: engineCatalog().length,
  }));

  app.get('/api/meta', (ctx) => {
    const client = clientOf(ctx);
    const negotiated = negotiate(client, { allowUnknown: true });
    const engines = engineCatalog();
    const catalog = catalogWithEngines(engines);
    ctx.res.setHeader('X-Memes-Api', String(API_VERSION));
    if (!negotiated.ok) {
      ctx.res.setHeader('X-Memes-Upgrade-Required', String(MIN_CLIENT_VERSION));
      throw new HttpError(negotiated.status, negotiated.message, { code: negotiated.code, upgrade: true });
    }
    return metaPayload({
      ok: true,
      app: APP_NAME,
      version: APP_VERSION,
      catalog,
      serverNow: now(),
      client: negotiated.client,
      degraded: negotiated.degraded,
      negotiatedCaps: negotiated.caps,
      features: {
        discordBot: config.discord.enabled,
        desktop: true,
        registrations: db.data.config.registrationsOpen,
        maintenance: db.data.config.maintenance,
        rooms: true,
        spectate: true,
        bots: true,
      },
      counts: {
        games: catalog.length,
        playable: catalog.filter((g) => g.playable).length,
        registered: Object.keys(db.data.users).length,
        online: onlineCount(),
      },
      config: publicConfig(),
    });
  });

  app.get('/api/compat', (ctx) => {
    const client = clientOf(ctx);
    const result = negotiate(client, { allowUnknown: true });
    return {
      ok: result.ok,
      code: result.code,
      client: result.client,
      serverApi: API_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      degraded: result.degraded,
      capabilities: result.caps,
      message: result.message,
    };
  });

  app.get('/api/stats', () => ({
    online: onlineCount(),
    registered: Object.keys(db.data.users).length,
    gamesPlayed: db.data.stats.gamesPlayed,
    byGame: db.data.stats.byGame,
    peakOnline: db.data.stats.peakOnline || 0,
    rooms: rooms.stats(),
    top: leaderboard(null, 10).entries,
    uptime: process.uptime(),
  }));

  /* ---------------- auth ---------------- */

  app.post('/api/auth/register', (ctx) => {
    if (!db.data.config.registrationsOpen) throw new HttpError(403, 'Registrations are currently closed.');
    if (db.data.config.maintenance) throw new HttpError(503, 'Memes Arcade is in maintenance mode - try again soon.');
    authRate(ctx, 'register', 8, 300000);
    const nameCheck = validateUsername(ctx.body.name);
    if (!nameCheck.ok) throw new HttpError(400, nameCheck.error);
    const pwCheck = validatePassword(ctx.body.password);
    if (!pwCheck.ok) throw new HttpError(400, pwCheck.error);
    if (getUserByName(nameCheck.value)) throw new HttpError(409, 'That username is already taken.');

    const user = createUser({ name: nameCheck.value, password: pwCheck.value });
    const token = createSession(user.id, { kind: clientOf(ctx).kind, ip: clientIp(ctx.req) });
    setCookie(ctx, token);
    audit(user, 'user.register', user.id, {});
    return { ok: true, token, user: userPublic(user, { self: true }) };
  });

  app.post('/api/auth/login', (ctx) => {
    authRate(ctx, 'login', 20, 60000);
    const user = getUserByName(String(ctx.body.name || '').trim());
    if (!user || !verifyPassword(ctx.body.password, user.pw)) throw new HttpError(401, 'Wrong username or password.');
    if (db.data.config.maintenance && !isStaff(user)) throw new HttpError(503, 'Maintenance mode: only staff can sign in right now.');
    if (user.banned) {
      const until = user.banned.until ? new Date(user.banned.until).toISOString() : 'forever';
      throw new HttpError(403, `Account suspended until ${until}: ${user.banned.reason || 'no reason given'}`);
    }
    user.lastSeen = now();
    const token = createSession(user.id, { kind: clientOf(ctx).kind, ip: clientIp(ctx.req) });
    setCookie(ctx, token);
    return { ok: true, token, user: userPublic(user, { self: true }) };
  });

  app.post('/api/auth/guest', (ctx) => {
    authRate(ctx, 'guest', 6, 300000);
    if (!db.data.config.registrationsOpen) throw new HttpError(403, 'Registrations are currently closed.');
    let name;
    do {
      name = `Guest${Math.floor(1000 + Math.random() * 8999)}`;
    } while (getUserByName(name));
    const user = createUser({ name, password: `guest-${Math.random()}`, kind: 'guest' });
    const token = createSession(user.id, { kind: clientOf(ctx).kind, ip: clientIp(ctx.req), ttlDays: 2 });
    setCookie(ctx, token, 2);
    return { ok: true, token, user: userPublic(user, { self: true }), guest: true };
  });

  app.post('/api/auth/logout', (ctx) => {
    revokeSession(tokenOf(ctx));
    ctx.res.setHeader('Set-Cookie', 'ma_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return { ok: true };
  });

  app.get('/api/auth/me', (ctx) => {
    const found = sessionUser(tokenOf(ctx));
    if (!found) return { ok: true, user: null, online: onlineCount() };
    return { ok: true, user: userPublic(found.user, { self: true }), online: onlineCount() };
  });

  app.post('/api/auth/password', (ctx) => {
    const user = requireAuth(ctx);
    if (!verifyPassword(ctx.body.current, user.pw)) throw new HttpError(401, 'Current password is wrong.');
    const check = validatePassword(ctx.body.next);
    if (!check.ok) throw new HttpError(400, check.error);
    setPassword(user, check.value);
    revokeUserSessions(user.id, tokenOf(ctx));
    audit(user, 'user.password', user.id, {});
    return { ok: true };
  });

  /* ---------------- catalog ---------------- */

  app.get('/api/games', (ctx) => {
    const engines = engineCatalog();
    const catalog = catalogWithEngines(engines);
    const category = ctx.query.get('category');
    const q = (ctx.query.get('q') || '').toLowerCase();
    const filtered = catalog.filter(
      (g) => (!category || g.category === category) && (!q || g.name.toLowerCase().includes(q) || (g.tags || []).some((t) => t.includes(q))),
    );
    return { ok: true, total: filtered.length, games: filtered, categories: [...new Set(catalog.map((g) => g.category))].sort() };
  });

  app.get('/api/games/:id', (ctx) => {
    const engine = getEngine(ctx.params.id);
    const meta = GAMES.find((g) => g.id === ctx.params.id) || (engine ? engine.meta : null);
    if (!meta) throw new HttpError(404, 'No such game.');
    return {
      ok: true,
      game: { ...meta, engine: !!engine, playable: !!engine },
      rules: engine?.meta.rules || meta.rules || null,
      options: engine?.meta.options || meta.options || [],
      leaderboard: leaderboard(ctx.params.id, 10).entries,
    };
  });

  app.get('/api/leaderboard', (ctx) => {
    const gameId = ctx.query.get('game') || null;
    // rankedBy tells the caller what `score` holds: points, games played or wins.
    return { ok: true, gameId, ...leaderboard(gameId, 25) };
  });

  /* ---------------- users & social ---------------- */

  app.get('/api/users', (ctx) => {
    const { users, total } = listUsers({
      q: ctx.query.get('q') || '',
      sort: ctx.query.get('sort') || 'level',
      limit: Math.min(100, Number(ctx.query.get('limit')) || 50),
      offset: Number(ctx.query.get('offset')) || 0,
    });
    return { ok: true, total, users, online: onlineCount() };
  });

  app.get('/api/users/:id', (ctx) => {
    const user = getUser(ctx.params.id) || getUserByName(ctx.params.id);
    if (!user) throw new HttpError(404, 'User not found.');
    const viewer = tokenOf(ctx) ? sessionUser(tokenOf(ctx))?.user : null;
    return {
      ok: true,
      user: userPublic(user, { viewer }),
      recent: user.stats.byGame,
      achievements: achievementsFor(user),
    };
  });

  app.post('/api/profile', (ctx) => {
    const user = requireAuth(ctx);
    const profile = updateProfile(user, ctx.body || {});
    return { ok: true, profile, user: userPublic(user, { self: true }) };
  });

  app.post('/api/settings', (ctx) => {
    const user = requireAuth(ctx);
    const settings = updateSettings(user, ctx.body || {});
    return { ok: true, settings };
  });

  app.get('/api/friends', (ctx) => {
    const user = requireAuth(ctx);
    return { ok: true, friends: friendList(user.id), ids: friendIds(user.id) };
  });

  app.post('/api/friends', (ctx) => {
    const user = requireAuth(ctx);
    const target = getUser(ctx.body.userId) || getUserByName(ctx.body.name);
    if (!target) throw new HttpError(404, 'User not found.');
    const rec = ctx.body.action === 'accept' ? acceptFriend(user, target) : requestFriend(user, target);
    if (rec.status === 'accepted') {
      hub?.sendToUser(target.id, { t: 'friends:refresh' });
      hub?.notify(target.id, 'friend-accept', `${user.name} accepted your friend request.`);
    } else {
      hub?.notify(target.id, 'friend-request', `${user.name} sent you a friend request.`);
    }
    hub?.sendToUser(user.id, { t: 'friends:refresh' });
    return { ok: true, status: rec.status };
  });

  app.delete('/api/friends/:id', (ctx) => {
    const user = requireAuth(ctx);
    const target = getUser(ctx.params.id);
    if (!target) throw new HttpError(404, 'User not found.');
    removeFriend(user, target);
    hub?.sendToUser(target.id, { t: 'friends:refresh' });
    return { ok: true };
  });

  app.get('/api/dm', (ctx) => {
    const user = requireAuth(ctx);
    const target = getUser(ctx.query.get('with')) || getUserByName(ctx.query.get('with'));
    if (!target) throw new HttpError(404, 'User not found.');
    return { ok: true, with: userPublic(target), messages: dmHistory(user, target) };
  });

  app.get('/api/dm/conversations', (ctx) => {
    const user = requireAuth(ctx);
    return { ok: true, conversations: dmConversations(user.id) };
  });

  app.post('/api/dm', (ctx) => {
    const user = requireAuth(ctx);
    const target = getUser(ctx.body.to) || getUserByName(ctx.body.to);
    if (!target) throw new HttpError(404, 'User not found.');
    const text = sanitizeText(ctx.body.text);
    if (!text) throw new HttpError(400, 'Message is empty.');
    const message = sendDm(user, target, text);
    hub?.sendToUser(target.id, { t: 'dm', message, from: userPublic(user) });
    return { ok: true, message };
  });

  /* ---------------- rooms ---------------- */

  app.get('/api/rooms', (ctx) => ({
    ok: true,
    rooms: rooms.lobbyList({ gameId: ctx.query.get('game') }),
    stats: rooms.stats(),
    online: onlineCount(),
  }));

  app.get('/api/rooms/:code', (ctx) => {
    const wanted = String(ctx.params.code).toUpperCase();
    const room = [...rooms.rooms.values()].find((r) => r.code === wanted || r.id === ctx.params.code);
    if (!room) throw new HttpError(404, 'No room with that code.');
    return { ok: true, room: rooms.roomInfo(room) };
  });

  app.post('/api/rooms', (ctx) => {
    const user = requireAuth(ctx);
    const engine = getEngine(ctx.body.gameId);
    if (!engine) throw new HttpError(400, `"${ctx.body.gameId}" is not playable yet.`);
    const room = rooms.createRoom({
      gameId: ctx.body.gameId,
      host: user,
      visibility: ctx.body.visibility === 'private' ? 'private' : 'public',
      options: ctx.body.options || {},
    });
    for (let i = 0; i < Math.min(8, Number(ctx.body.bots) || 0); i++) {
      try {
        rooms.addBot(room, { level: ctx.body.botLevel || 2, by: user });
      } catch {}
    }
    if (ctx.body.autostart && rooms.canStart(room)) rooms.start(room);
    return { ok: true, room: rooms.roomInfo(room), code: room.code };
  });

  /* ---------------- desktop downloads ---------------- */

  app.get('/api/downloads', (ctx) => downloadManifest({ server: ctx.query.get('server') || '' }));

  app.get('/api/downloads/:id', (ctx) => {
    const item = getDownload(ctx.params.id, { server: ctx.query.get('server') || '' });
    if (!item) throw new HttpError(404, 'No such download.');
    return {
      __raw: true,
      status: 200,
      buffer: item.buffer,
      type: 'application/zip',
      headers: {
        'Content-Disposition': `attachment; filename="${item.filename}"`,
        'Cache-Control': 'public, max-age=300',
        'X-Memes-Download': item.sha256.slice(0, 16),
      },
    };
  });

  /* ---------------- music & assets ---------------- */

  app.get('/api/music', () => {
    const dir = path.join(config.webDir, 'assets', 'music');
    const files = [];
    try {
      for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const ext = path.extname(file).toLowerCase();
        if (MIME_AUDIO[ext]) files.push({ name: file.replace(ext, ''), file, url: `/assets/music/${encodeURIComponent(file)}`, license: 'Check docs/MUSIC-CREDITS.md' });
      }
    } catch {}
    return {
      ok: true,
      procedural: [
        { id: 'neon-runner', name: 'Neon Runner', mood: 'arcade', bpm: 128 },
        { id: 'lofi-pixel', name: 'Lofi Pixel', mood: 'chill', bpm: 84 },
        { id: 'hype-train', name: 'Hype Train', mood: 'hype', bpm: 150 },
        { id: 'chip-suite', name: 'Chip Suite', mood: 'retro', bpm: 110 },
        { id: 'zen-garden', name: 'Zen Garden', mood: 'ambient', bpm: 72 },
        { id: 'boss-rush', name: 'Boss Rush', mood: 'intense', bpm: 160 },
      ],
      files,
      credits: '/docs/MUSIC-CREDITS.md',
    };
  });

  app.get('/api/assets/characters', () => {
    const dir = path.join(config.webDir, 'assets', 'characters');
    const out = [];
    try {
      for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(file)) {
          out.push({ id: path.basename(file, path.extname(file)), file, url: `/assets/characters/${encodeURIComponent(file)}` });
        }
      }
    } catch {}
    return { ok: true, characters: out };
  });

  /* ---------------- suggestions (public idea board) ---------------- */

  app.get('/api/suggestions', (ctx) => {
    const viewer = tokenOf(ctx) ? sessionUser(tokenOf(ctx))?.user : null;
    const sort = ctx.query.get('sort') === 'new' ? 'new' : 'top';
    const status = String(ctx.query.get('status') || 'all');
    const category = String(ctx.query.get('category') || 'all');
    let list = db.data.suggestions.slice();
    if (status !== 'all') list = list.filter((s) => s.status === status);
    if (category !== 'all') list = list.filter((s) => s.category === category);
    list.sort(sort === 'new'
      ? (a, b) => (b.at || 0) - (a.at || 0)
      : (a, b) => voteCount(b) - voteCount(a) || (b.at || 0) - (a.at || 0));
    const counts = {};
    for (const s of db.data.suggestions) counts[s.status] = (counts[s.status] || 0) + 1;
    return {
      ok: true,
      sort,
      status,
      category,
      total: db.data.suggestions.length,
      counts,
      suggestions: list.slice(0, 200).map((s) => suggestionPublic(s, viewer?.id)),
    };
  });

  app.post('/api/suggestions', (ctx) => {
    const user = requireAuth(ctx);
    const limit = rateLimit(`suggest:${user.id}`, 5, 3600000);
    if (!limit.ok) {
      const mins = Math.max(1, Math.ceil(limit.retryAfter / 60000));
      throw new HttpError(429, `That is a lot of ideas! Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    const title = sanitizeText(ctx.body.title, 120);
    const text = sanitizeText(ctx.body.text, 2000);
    const category = SUGGESTION_CATEGORIES.includes(ctx.body.category) ? ctx.body.category : 'feature';
    if (title.length < 4) throw new HttpError(400, 'Give your idea a title (at least 4 characters).');
    if (text.length < 10) throw new HttpError(400, 'Describe the idea a little more (at least 10 characters).');
    const suggestion = {
      id: newId(8),
      at: now(),
      updatedAt: now(),
      from: user.id,
      fromName: user.name,
      title,
      text,
      category,
      status: 'open',
      // Your own idea starts with your vote, so the board feels alive at once.
      votes: { [user.id]: 1 },
    };
    db.data.suggestions.push(suggestion);
    if (db.data.suggestions.length > 500) db.data.suggestions.splice(0, db.data.suggestions.length - 500);
    audit(user, 'suggestion.create', suggestion.id, { title, category });
    for (const staff of Object.values(db.data.users)) {
      // Idea triage is admin-only: mods are not pinged about a queue they cannot open.
      if (roleLevel(staff.role) >= ROLES.admin) hub?.notify(staff.id, 'suggestion', `New ${category} idea from ${user.name}: ${title}`);
    }
    db.touch();
    hub?.broadcastSuggestions();
    return { ok: true, suggestion: suggestionPublic(suggestion, user.id) };
  });

  app.post('/api/suggestions/:id/vote', (ctx) => {
    const user = requireAuth(ctx);
    const suggestion = db.data.suggestions.find((s) => s.id === ctx.params.id);
    if (!suggestion) throw new HttpError(404, 'That suggestion is gone.');
    suggestion.votes ||= {};
    if (suggestion.votes[user.id]) delete suggestion.votes[user.id];
    else suggestion.votes[user.id] = 1;
    suggestion.updatedAt = now();
    db.touch();
    hub?.broadcastSuggestions();
    return { ok: true, voted: !!suggestion.votes[user.id], votes: voteCount(suggestion) };
  });

  /* ---------------- changelog (shipped ideas) ---------------- */

  app.get('/api/changelog', (ctx) => {
    const shipped = db.data.suggestions
      .filter((s) => s.status === 'done')
      .sort((a, b) => (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0));
    // One page per response: never more than 100 entries, however long the log
    // grows. Clients walk it with ?offset (and ?limit to size the page), and
    // hasMore saves them from guessing when to stop. Both are forgiving: a
    // junk value falls back to the default page instead of failing.
    const limit = Math.min(100, Math.max(1, Math.floor(Number(ctx.query.get('limit')) || 100)));
    const offset = Math.max(0, Math.floor(Number(ctx.query.get('offset')) || 0));
    const page = shipped.slice(offset, offset + limit).map((s) => ({
      id: s.id,
      title: s.title,
      text: s.text,
      category: s.category,
      at: s.at,
      shippedAt: s.updatedAt || s.at,
      votes: voteCount(s),
      fromName: s.fromName,
      note: s.adminNote || null,
      by: s.adminName || null,
    }));
    return {
      ok: true,
      total: shipped.length,
      limit,
      offset,
      hasMore: offset + page.length < shipped.length,
      entries: page,
    };
  });

  /* ---------------- reports ---------------- */

  app.post('/api/report', (ctx) => {
    const user = tokenOf(ctx) ? sessionUser(tokenOf(ctx))?.user : null;
    const text = sanitizeText(ctx.body.text, 1000);
    if (!text) throw new HttpError(400, 'Tell us what happened.');
    const kind = sanitizeText(ctx.body.kind, 40) || 'bug';
    const target = ctx.body.target ? sanitizeText(String(ctx.body.target), 80) : null;
    const report = {
      id: newId(8),
      at: now(),
      from: user?.id || null,
      fromName: user?.name || 'a guest',
      kind,
      text,
      target,
      status: 'open',
    };
    db.data.reports.push(report);
    if (db.data.reports.length > 500) db.data.reports.splice(0, db.data.reports.length - 500);
    audit(user, 'report', target, { text, kind });
    for (const staff of Object.values(db.data.users)) {
      if (isStaff(staff)) hub?.notify(staff.id, 'report', `New ${kind} report from ${report.fromName}.`);
    }
    db.touch();
    return { ok: true, message: 'Thanks - the admins can see it now.' };
  });

  /* ---------------- admin ---------------- */

  app.get('/api/admin/overview', (ctx) => {
    requireStaff(ctx);
    return {
      ok: true,
      stats: {
        users: Object.keys(db.data.users).length,
        online: onlineCount(),
        sessions: Object.keys(db.data.sessions).length,
        rooms: rooms.stats(),
        gamesPlayed: db.data.stats.gamesPlayed,
        peakOnline: db.data.stats.peakOnline || 0,
        uptime: process.uptime(),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        node: process.version,
        apiVersion: API_VERSION,
        appVersion: APP_VERSION,
      },
      config: db.data.config,
      engines: engineCatalog(),
      engineErrors,
      reports: { open: db.data.reports.filter((r) => r.status === 'open').length, total: db.data.reports.length },
      suggestions: { open: db.data.suggestions.filter((s) => s.status === 'open').length, total: db.data.suggestions.length },
      recentAudit: db.data.audit.slice(-40).reverse(),
      topGames: Object.entries(db.data.stats.byGame)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([id, plays]) => ({ id, plays })),
    };
  });

  app.get('/api/admin/users', (ctx) => {
    requireStaff(ctx);
    const { users, total } = listUsers({
      q: ctx.query.get('q') || '',
      sort: ctx.query.get('sort') || 'seen',
      limit: Math.min(200, Number(ctx.query.get('limit')) || 60),
      offset: Number(ctx.query.get('offset')) || 0,
    });
    return {
      ok: true,
      total,
      users: users.map((u) => ({ ...u, banned: db.data.users[u.id]?.banned || null })),
    };
  });

  app.post('/api/admin/users/:id', (ctx) => {
    const actor = requireStaff(ctx);
    const target = getUser(ctx.params.id);
    if (!target) throw new HttpError(404, 'User not found.');
    if (!canManage(actor, target) && actor.id !== target.id) throw new HttpError(403, 'You cannot moderate that account.');
    const op = String(ctx.body.op || '');
    switch (op) {
      case 'ban':
        if (roleLevel(target.role) >= roleLevel(actor.role)) throw new HttpError(403, 'Cannot ban an equal or higher role.');
        banUser(target, { reason: sanitizeText(ctx.body.reason, 200), until: ctx.body.days ? now() + ctx.body.days * 86400000 : null, by: actor });
        hub?.sendToUser(target.id, { t: 'banned', message: target.banned.reason || 'Suspended by an admin.' });
        return { ok: true, banned: true };
      case 'unban':
        unbanUser(target, actor);
        return { ok: true, banned: false };
      case 'role': {
        const role = String(ctx.body.role || 'user');
        if (!(role in ROLES)) throw new HttpError(400, 'Unknown role.');
        if (roleLevel(role) >= roleLevel(actor.role) && actor.id !== target.id) throw new HttpError(403, 'You cannot grant a role equal to or above your own.');
        target.role = role;
        audit(actor, 'user.role', target.id, { role });
        db.touch();
        return { ok: true, role };
      }
      case 'reset-password': {
        const pw = sanitizeText(ctx.body.password, 100) || `arcade-${Math.random().toString(36).slice(2, 10)}`;
        setPassword(target, pw);
        revokeUserSessions(target.id);
        audit(actor, 'user.resetpw', target.id, {});
        return { ok: true, password: pw };
      }
      case 'grant':
        grantXp(target, Number(ctx.body.xp) || 0);
        target.coins = Math.max(0, (target.coins || 0) + (Number(ctx.body.coins) || 0));
        db.touch();
        return { ok: true, xp: target.xp, coins: target.coins };
      case 'kick':
        if (hub) {
          hub.sendToUser(target.id, { t: 'kicked', message: ctx.body.reason || 'An admin removed you from the session.' });
          for (const [conn, s] of hub.clients) if (s.user?.id === target.id) conn.close(4008, 'kicked');
        }
        return { ok: true };
      case 'delete':
        if (roleLevel(target.role) >= roleLevel(actor.role) && actor.id !== target.id) throw new HttpError(403, 'Cannot delete that account.');
        deleteUser(target.id, { by: actor, reason: sanitizeText(ctx.body.reason, 200) });
        return { ok: true, deleted: true };
      default:
        throw new HttpError(400, `Unknown admin op "${op}".`);
    }
  });

  app.post('/api/admin/config', (ctx) => {
    const actor = requireStaff(ctx, ROLES.admin);
    const allowed = ['registrationsOpen', 'maintenance', 'motd', 'announcement', 'featured', 'maxRooms', 'maxPartySize'];
    for (const key of allowed) if (ctx.body[key] !== undefined) db.data.config[key] = ctx.body[key];
    if (typeof db.data.config.motd === 'string') db.data.config.motd = sanitizeText(db.data.config.motd, 200);
    if (typeof db.data.config.announcement === 'string') db.data.config.announcement = sanitizeText(db.data.config.announcement, 300);
    audit(actor, 'config.update', null, { keys: Object.keys(ctx.body) });
    db.touch();
    return { ok: true, config: db.data.config };
  });

  app.post('/api/admin/broadcast', (ctx) => {
    const actor = requireStaff(ctx, ROLES.admin);
    const text = sanitizeText(ctx.body.text, 300);
    if (!text) throw new HttpError(400, 'Nothing to broadcast.');
    db.data.config.announcement = text;
    audit(actor, 'broadcast', null, { text });
    db.touch();
    hub?.sendToUsers(hub.clients.size ? [...hub.clients.values()].map((s) => s.user?.id).filter(Boolean) : [], {
      t: 'notify',
      kind: 'broadcast',
      text,
      from: actor.name,
    });
    return { ok: true };
  });

  app.get('/api/admin/audit', (ctx) => {
    requireStaff(ctx);
    const limit = Math.min(500, Number(ctx.query.get('limit')) || 100);
    return { ok: true, entries: db.data.audit.slice(-limit).reverse() };
  });

  /* ---------------- admin: report inbox ---------------- */

  app.get('/api/admin/reports', (ctx) => {
    requireStaff(ctx);
    const status = String(ctx.query.get('status') || 'open');
    const all = db.data.reports.slice().reverse();
    const wanted = status === 'all' ? all : all.filter((r) => r.status === status);
    const limit = Math.min(200, Number(ctx.query.get('limit')) || 100);
    return {
      ok: true,
      total: all.length,
      open: all.filter((r) => r.status === 'open').length,
      reports: wanted.slice(0, limit),
    };
  });

  app.post('/api/admin/reports/:id', (ctx) => {
    const actor = requireStaff(ctx);
    const report = db.data.reports.find((r) => r.id === ctx.params.id);
    if (!report) throw new HttpError(404, 'That report is already gone.');
    const op = String(ctx.body.op || 'resolve');
    if (op === 'resolve') {
      report.status = 'resolved';
      report.resolvedBy = actor.name;
      report.resolvedAt = now();
    } else if (op === 'reopen') {
      report.status = 'open';
      delete report.resolvedBy;
      delete report.resolvedAt;
    } else if (op === 'delete') {
      db.data.reports = db.data.reports.filter((r) => r.id !== report.id);
    } else {
      throw new HttpError(400, `Unknown report op "${op}".`);
    }
    audit(actor, `report.${op}`, report.id, {});
    db.touch();
    return { ok: true };
  });

  /* ---------------- admin: idea board ---------------- */

  app.post('/api/admin/suggestions/:id', (ctx) => {
    // Admin-only, like the console's Ideas tab and the new-idea ping: a
    // moderator must be refused even through a direct API call.
    const actor = requireStaff(ctx, ROLES.admin);
    const suggestion = db.data.suggestions.find((s) => s.id === ctx.params.id);
    if (!suggestion) throw new HttpError(404, 'That suggestion is already gone.');
    const op = String(ctx.body.op || 'status');
    if (op === 'delete') {
      db.data.suggestions = db.data.suggestions.filter((s) => s.id !== suggestion.id);
      audit(actor, 'suggestion.delete', suggestion.id, { title: suggestion.title });
      db.touch();
      hub?.broadcastSuggestions();
      return { ok: true, deleted: true };
    }
    if (op !== 'update') throw new HttpError(400, `Unknown suggestion op "${op}".`);
    const before = { status: suggestion.status, note: suggestion.adminNote || null };
    if (ctx.body.status !== undefined) {
      if (!SUGGESTION_STATUSES.includes(ctx.body.status)) throw new HttpError(400, 'Unknown status.');
      suggestion.status = ctx.body.status;
    }
    if (ctx.body.note !== undefined) {
      suggestion.adminNote = sanitizeText(ctx.body.note, 400) || null;
      suggestion.adminName = actor.name;
    }
    suggestion.updatedAt = now();
    audit(actor, 'suggestion.update', suggestion.id, { status: suggestion.status });
    db.touch();
    hub?.broadcastSuggestions();
    notifyIdeaAuthor(suggestion, before, actor, hub);
    return { ok: true, suggestion: suggestionPublic(suggestion, actor.id) };
  });

  /* ---------------- admin: live rooms ---------------- */

  app.get('/api/admin/rooms', (ctx) => {
    requireStaff(ctx);
    const list = rooms.lobbyList({ includePrivate: true }).map((room) => ({
      ...room,
      hostName: getUser(room.host)?.name || 'unknown',
      ageMs: Math.max(0, now() - (room.createdAt || now())),
      idleMs: Math.max(0, now() - (room.updatedAt || now())),
    }));
    return { ok: true, rooms: list, stats: rooms.stats() };
  });

  app.post('/api/admin/rooms/:id', (ctx) => {
    const actor = requireStaff(ctx);
    const room = rooms.getRoom(ctx.params.id);
    if (!room) throw new HttpError(404, 'That room is already gone.');
    const op = String(ctx.body.op || 'close');
    if (op !== 'close') throw new HttpError(400, `Unknown room op "${op}".`);
    const info = { id: room.id, code: room.code, gameId: room.gameId };
    rooms.systemMessage(room, `${actor.name} closed this room from the admin panel.`);
    rooms.close(room, 'closed-by-admin');
    audit(actor, 'room.close', room.id, info);
    return { ok: true, closed: info };
  });

  /* ---------------- discord bot bridge ---------------- */

  app.get('/api/bot/secret', (ctx) => {
    requireStaff(ctx, ROLES.admin);
    return { ok: true, secret: botSecret(), note: 'Put this in bot/.env as ARCADE_BOT_SECRET (header X-Bot-Token).' };
  });

  /** Bot asks for a link code the player can type on the website. */
  app.post('/api/bot/link/start', (ctx) => {
    requireBot(ctx);
    const discordId = String(ctx.body.discordId || '');
    if (!discordId) throw new HttpError(400, 'discordId required.');
    const existing = db.data.botLinks[discordId];
    if (existing && getUser(existing.userId)) {
      return { ok: true, linked: true, user: userPublic(getUser(existing.userId)), token: createSession(existing.userId, { kind: 'bot', ttlDays: 7 }) };
    }
    const full = signPayload({ discordId, name: ctx.body.discordName || null, kind: 'link' }, 15 * 60000);
    const code = full.slice(0, 12).toUpperCase();
    // The player types this short code on the website, so remember which signed
    // token it stands for - /api/discord/claim verifies it from here.
    const expires = now() + 15 * 60000;
    db.data.linkCodes = db.data.linkCodes || {};
    for (const [key, entry] of Object.entries(db.data.linkCodes)) if (!entry || entry.exp < now()) delete db.data.linkCodes[key];
    db.data.linkCodes[code] = { full, discordId, exp: expires };
    db.touch();
    return { ok: true, linked: false, code, full, expiresIn: 900 };
  });

  /** Website side: signed-in player claims a code shown by the bot. */
  app.post('/api/discord/claim', (ctx) => {
    const user = requireAuth(ctx);
    const raw = String(ctx.body.code || '').trim();
    // Players type the short code the bot showed; it maps to the signed token.
    const pending = db.data.linkCodes?.[raw.toUpperCase()];
    const payload = verifyPayload(raw) || (pending ? verifyPayload(pending.full) : null);
    if (!payload || payload.kind !== 'link') throw new HttpError(400, 'That code is invalid or expired.');
    if (pending) delete db.data.linkCodes[raw.toUpperCase()];
    db.data.botLinks[payload.discordId] = { userId: user.id, discordId: payload.discordId, at: now(), name: payload.name };
    audit(user, 'discord.link', user.id, { discordId: payload.discordId });
    db.touch();
    return { ok: true, discordId: payload.discordId, user: userPublic(user, { self: true }) };
  });

  /** Bot polls to see whether the code was claimed. */
  app.post('/api/bot/link/check', (ctx) => {
    requireBot(ctx);
    const raw = String(ctx.body.code || '').trim();
    const pending = db.data.linkCodes?.[raw.toUpperCase()];
    const payload = verifyPayload(raw) || (pending ? verifyPayload(pending.full) : null);
    if (!payload || payload.kind !== 'link') throw new HttpError(400, 'Code invalid or expired.');
    const link = db.data.botLinks[payload.discordId];
    if (!link) return { ok: true, linked: false };
    const user = getUser(link.userId);
    return {
      ok: true,
      linked: true,
      user: userPublic(user),
      token: createSession(user.id, { kind: 'bot', ttlDays: 7 }),
    };
  });

  app.get('/api/bot/user', (ctx) => {
    requireBot(ctx);
    const user = getUser(tokenOf(ctx) ? sessionUser(tokenOf(ctx))?.user?.id : null);
    if (!user) throw new HttpError(401, 'Bad bot session.');
    return { ok: true, user: userPublic(user, { self: true }), friends: friendList(user.id) };
  });

}

function voteCount(suggestion) {
  return Object.keys(suggestion.votes || {}).length;
}

/**
 * Tell the author when their idea actually moved. The rules live in
 * lib/notify.js (pure, and covered by npm run notifycheck); this only ships
 * whatever it decided - silence comes back as null.
 */
function notifyIdeaAuthor(suggestion, before, actor, hub) {
  const message = ideaNotify(suggestion, before, actor);
  if (message) hub?.notify(message.to, message.kind, message.text, message.meta);
}

/** Public shape of an idea: no voter identities, only the count + your own vote. */
function suggestionPublic(suggestion, viewerId) {
  return {
    id: suggestion.id,
    title: suggestion.title,
    text: suggestion.text,
    category: suggestion.category,
    status: suggestion.status,
    at: suggestion.at,
    updatedAt: suggestion.updatedAt || suggestion.at,
    fromName: suggestion.fromName,
    from: suggestion.from || null,
    votes: voteCount(suggestion),
    voted: !!(viewerId && suggestion.votes?.[viewerId]),
    adminNote: suggestion.adminNote || null,
    adminName: suggestion.adminName || null,
  };
}

function publicConfig() {
  return {
    registrationsOpen: db.data.config.registrationsOpen,
    maintenance: db.data.config.maintenance,
    motd: db.data.config.motd,
    announcement: db.data.config.announcement,
    featured: db.data.config.featured,
    maxPartySize: db.data.config.maxPartySize,
    maxRooms: db.data.config.maxRooms,
  };
}

function achievementsFor(user) {
  const out = [];
  if (user.stats.wins >= 1) out.push({ id: 'first-win', name: 'First Blood', icon: '🥇' });
  if (user.stats.wins >= 25) out.push({ id: 'winner-25', name: 'Regular Champion', icon: '🏆' });
  if (user.stats.games >= 50) out.push({ id: 'veteran', name: 'Arcade Veteran', icon: '🕹️' });
  if (user.stats.bestStreak >= 5) out.push({ id: 'streak-5', name: 'On Fire', icon: '🔥' });
  const variety = Object.keys(user.stats.byGame || {}).length;
  if (variety >= 10) out.push({ id: 'explorer', name: 'Genre Explorer', icon: '🧭' });
  if (levelFromXp(user.xp).level >= 10) out.push({ id: 'level-10', name: 'Level 10', icon: '⭐' });
  return out;
}
