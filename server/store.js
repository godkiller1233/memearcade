/**
 * Domain layer: users, friends, parties, rooms, chat, dms, stats and audit.
 * Pure data operations over db.data - this module knows nothing about HTTP,
 * WebSockets or game rules, which keeps the API and realtime layers thin.
 */
import { db } from './lib/db.js';
import { hashPassword, roleLevel, ROLES } from './lib/auth.js';
import { id as newId, code as makeCode, now, shuffle } from './lib/ids.js';
import { statusOf } from './lib/presence.js';
import { log } from './config.js';

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

export const DEFAULT_KEYBINDS = {
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  action: 'Space',
  action2: 'KeyE',
  aim: 'MouseLeft',
  draw: 'MouseLeft',
  undo: 'KeyZ',
  pause: 'Escape',
  chat: 'KeyT',
  vote: 'KeyV',
  sprint: 'ShiftLeft',
  ready: 'KeyR',
};

export const DEFAULT_SETTINGS = {
  theme: 'arcade-dark',
  accent: '#ff2fb0',
  font: 'system',
  reduceMotion: false,
  cardSize: 'normal',
  audio: {
    master: 0.8,
    music: true,
    musicVolume: 0.32,
    track: 'neon-runner',
    autoNextTrack: true,
    sfx: true,
    sfxVolume: 0.7,
  },
  keybinds: { ...DEFAULT_KEYBINDS },
  notifications: { friendRequests: true, partyInvites: true, sounds: true, mentions: true },
  privacy: { showInLobby: true, allowInvites: true, allowDms: 'friends', presence: 'online' },
  gameplay: { confirmMoves: false, autoReady: false, timers: true, largeText: false, colorblindSafe: false, lowSpec: false },
  // Per-game memory (a game's remembered loadout/record), written by the client
  // and stored opaquely - the server never interprets it.
  games: {},
};

function deepMerge(base, patch) {
  if (Array.isArray(base)) return patch === undefined ? base : patch;
  if (typeof base !== 'object' || base === null) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

const LEVEL_CURVE = (lvl) => Math.round(120 * Math.pow(lvl, 1.35));

export function levelFromXp(xp = 0) {
  let level = 1;
  let need = LEVEL_CURVE(1);
  let remaining = xp;
  while (remaining >= need) {
    remaining -= need;
    level++;
    need = LEVEL_CURVE(level);
  }
  return { level, into: remaining, need, pct: Math.round((remaining / need) * 100) };
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export function createUser({ name, password, role = 'user', avatar = '', bio = '', settings = {}, kind = 'human' }) {
  const key = String(name).toLowerCase();
  if (db.data.names[key]) throw new Error('That username is already taken.');
  const id = newId(9);
  const user = {
    id,
    name,
    nameLower: key,
    role,
    kind, // human | bot | guest
    avatar: avatar || pickAvatar(name),
    bio,
    pw: hashPassword(password),
    createdAt: now(),
    lastSeen: now(),
    banned: null,
    bots: {}, // gameId -> local bot opponent record for single player
    settings: deepMerge(DEFAULT_SETTINGS, settings),
    profile: { title: 'Player', banner: 'aurora', pinned: [], favGames: [] },
    stats: { games: 0, wins: 0, losses: 0, draws: 0, playtimeMs: 0, byGame: {}, points: {}, streak: 0, bestStreak: 0 },
    xp: 0,
    coins: 250,
    unlocks: { themes: [], characters: [] },
    friendsOnly: false,
  };
  db.data.users[id] = user;
  db.data.names[key] = id;
  db.data.stats.registrations++;
  db.touch();
  return user;
}

const AVATARS = ['🦊', '🐸', '🐙', '🦄', '🐲', '👾', '🤖', '🐱', '🐼', '🦉', '🐝', '🦈', '🐺', '🍕', '🎲', '🚀'];

function pickAvatar(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

export function getUser(id) {
  return db.data.users[id] || null;
}

export function getUserByName(name) {
  const id = db.data.names[String(name || '').toLowerCase()];
  return id ? db.data.users[id] || null : null;
}

export function setPassword(user, password) {
  user.pw = hashPassword(password);
  db.touch();
}

export function updateSettings(user, patch) {
  user.settings = deepMerge(user.settings, patch);
  db.touch();
  return user.settings;
}

export function updateProfile(user, patch) {
  const allowed = ['bio', 'avatar', 'title', 'banner', 'favGames'];
  if (patch.avatar !== undefined) user.avatar = String(patch.avatar).slice(0, 8);
  if (patch.bio !== undefined) user.bio = String(patch.bio).slice(0, 240);
  for (const key of allowed) {
    if (patch[key] !== undefined && key !== 'bio' && key !== 'avatar') user.profile[key] = patch[key];
  }
  db.touch();
  return user.profile;
}

export function userPublic(user, { self = false, viewer = null } = {}) {
  if (!user) return null;
  const lvl = levelFromXp(user.xp);
  const out = {
    id: user.id,
    name: user.name,
    avatar: user.avatar || pickAvatar(user.name),
    role: user.role,
    bio: user.bio || '',
    createdAt: user.createdAt,
    lastSeen: user.lastSeen,
    level: lvl.level,
    xp: user.xp,
    xpPct: lvl.pct,
    coins: user.coins,
    presence: user.settings?.privacy?.presence === 'invisible' ? 'offline' : statusOf(user.id),
    profile: user.profile,
    stats: {
      games: user.stats.games,
      wins: user.stats.wins,
      losses: user.stats.losses,
      draws: user.stats.draws,
      streak: user.stats.streak,
      bestStreak: user.stats.bestStreak,
      byGame: user.stats.byGame,
      points: user.stats.points || {},
    },
    kind: user.kind,
  };
  if (self) {
    out.settings = user.settings;
    out.email = user.email || null;
    out.permissions = {
      admin: roleLevel(user.role) >= ROLES.admin,
      mod: roleLevel(user.role) >= ROLES.mod,
      level: roleLevel(user.role),
    };
  }
  out.isFriend = viewer ? friendState(viewer.id, user.id)?.status === 'accepted' : false;
  return out;
}

export function listUsers({ q = '', sort = 'level', limit = 50, offset = 0, role = null } = {}) {
  let users = Object.values(db.data.users);
  if (q) {
    const needle = String(q).toLowerCase();
    users = users.filter((u) => u.nameLower.includes(needle));
  }
  if (role) users = users.filter((u) => u.role === role);
  const sorters = {
    level: (a, b) => b.xp - a.xp,
    wins: (a, b) => b.stats.wins - a.stats.wins,
    games: (a, b) => b.stats.games - a.stats.games,
    newest: (a, b) => b.createdAt - a.createdAt,
    name: (a, b) => a.nameLower.localeCompare(b.nameLower),
    seen: (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0),
  };
  users.sort(sorters[sort] || sorters.level);
  return { total: users.length, users: users.slice(offset, offset + limit).map((u) => userPublic(u)) };
}

export function deleteUser(id, { by = null, reason = '' } = {}) {
  const user = db.data.users[id];
  if (!user) return false;
  delete db.data.users[id];
  delete db.data.names[user.nameLower];
  db.data.friends = db.data.friends.filter((f) => f.a !== id && f.b !== id);
  for (const [tok, s] of Object.entries(db.data.sessions)) if (s.userId === id) delete db.data.sessions[tok];
  for (const party of Object.values(db.data.parties)) {
    party.members = party.members.filter((m) => m.id !== id);
    if (party.leader === id) {
      if (party.members.length) party.leader = party.members[0].id;
      else delete db.data.parties[party.id];
    }
  }
  audit(by, 'user.delete', id, { name: user.name, reason });
  db.touch();
  return true;
}

export function banUser(user, { reason = '', until = null, by = null, silent = false } = {}) {
  user.banned = { reason, until, at: now(), by: by?.id || null };
  for (const [tok, s] of Object.entries(db.data.sessions)) if (s.userId === user.id) delete db.data.sessions[tok];
  if (!silent) log(`moderation: ${user.name} banned (${reason || 'no reason'})`);
  audit(by, 'user.ban', user.id, { reason, until });
  db.touch();
  return user.banned;
}

export function unbanUser(user, by) {
  user.banned = null;
  audit(by, 'user.unban', user.id, {});
  db.touch();
}

export function grantXp(user, amount) {
  user.xp = Math.max(0, (user.xp || 0) + amount);
  db.touch();
  return levelFromXp(user.xp);
}

export function touchLogin(user) {
  user.lastSeen = now();
  db.data.stats.logins++;
  db.touch();
}

/* ------------------------------------------------------------------ *
 * Friends
 * ------------------------------------------------------------------ */

export function friendKey(a, b) {
  return [a, b].sort().join('|');
}

export function friendState(a, b) {
  if (!a || !b || a === b) return null;
  return db.data.friends.find((f) => friendKey(f.a, f.b) === friendKey(a, b)) || null;
}

export function requestFriend(from, to) {
  if (from.id === to.id) throw new Error("You can't add yourself.");
  const existing = friendState(from.id, to.id);
  if (existing) {
    if (existing.status === 'accepted') throw new Error('You are already friends.');
    if (existing.status === 'blocked') throw new Error('That user blocked you.');
    if (existing.by === from.id) throw new Error('Request already sent.');
    return acceptFriend(from, to);
  }
  const rec = { a: from.id, b: to.id, status: 'pending', by: from.id, at: now() };
  db.data.friends.push(rec);
  db.touch();
  return rec;
}

export function acceptFriend(a, b) {
  const rec = friendState(a.id, b.id);
  if (!rec) throw new Error('No pending request.');
  rec.status = 'accepted';
  rec.at = now();
  db.touch();
  return rec;
}

export function removeFriend(a, b) {
  const key = friendKey(a.id, b.id);
  db.data.friends = db.data.friends.filter((f) => friendKey(f.a, f.b) !== key);
  db.touch();
}

export function blockUser(a, b) {
  const rec = friendState(a.id, b.id);
  if (rec) {
    rec.status = 'blocked';
    rec.by = a.id;
  } else {
    db.data.friends.push({ a: a.id, b: b.id, status: 'blocked', by: a.id, at: now() });
  }
  db.touch();
}

export function friendList(userId) {
  const out = [];
  for (const rec of db.data.friends) {
    if (rec.a !== userId && rec.b !== userId) continue;
    const otherId = rec.a === userId ? rec.b : rec.a;
    const other = db.data.users[otherId];
    if (!other) continue;
    const direction = rec.by === userId ? 'outgoing' : 'incoming';
    out.push({
      ...userPublic(other, { viewer: db.data.users[userId] }),
      friendStatus: rec.status,
      direction,
      since: rec.at,
    });
  }
  return out.sort((x, y) => (y.presence === 'offline' ? 0 : 1) - (x.presence === 'offline' ? 0 : 1) || x.name.localeCompare(y.name));
}

export function friendIds(userId) {
  return db.data.friends
    .filter((f) => f.status === 'accepted' && (f.a === userId || f.b === userId))
    .map((f) => (f.a === userId ? f.b : f.a));
}

/* ------------------------------------------------------------------ *
 * Direct messages
 * ------------------------------------------------------------------ */

export function dmKey(a, b) {
  return [a, b].sort().join('|');
}

export function sendDm(from, to, text) {
  const key = dmKey(from.id, to.id);
  const msg = { id: newId(6), from: from.id, name: from.name, to: to.id, text: sanitizeText(text), at: now(), kind: 'dm' };
  (db.data.dms[key] ||= []).push(msg);
  if (db.data.dms[key].length > 400) db.data.dms[key].splice(0, db.data.dms[key].length - 400);
  db.touch();
  return msg;
}

export function dmHistory(a, b, limit = 100) {
  const list = db.data.dms[dmKey(a, b)] || [];
  return list.slice(-limit);
}

export function dmConversations(userId) {
  const out = [];
  for (const [key, list] of Object.entries(db.data.dms)) {
    if (!key.includes(userId) || !list.length) continue;
    const otherId = key.split('|').find((x) => x !== userId);
    const other = db.data.users[otherId];
    if (!other) continue;
    const last = list[list.length - 1];
    out.push({
      userId: otherId,
      name: other.name,
      avatar: other.avatar,
      unread: list.filter((m) => m.to === userId && m.at > (db.data.users[userId].lastSeen || 0)).length,
      last: { text: last.text, at: last.at, from: last.from },
    });
  }
  return out.sort((a, b) => b.last.at - a.last.at);
}

/* ------------------------------------------------------------------ *
 * Parties (persistent social groups)
 * ------------------------------------------------------------------ */

export function createParty(leader, { visibility = 'public', gameId = null, options = {}, code = null } = {}) {
  const id = newId(9);
  const party = {
    id,
    code: code || makeCode(4),
    leader: leader.id,
    members: [{ id: leader.id, name: leader.name, ready: true, joinedAt: now(), host: true }],
    invites: [],
    rejoin: {},
    visibility,
    gameId,
    options,
    chat: [],
    status: 'idle',
    roomId: null,
    createdAt: now(),
  };
  db.data.parties[id] = party;
  audit(leader, 'party.create', id, { visibility });
  db.touch();
  return party;
}

export function getParty(id) {
  return db.data.parties[id] || null;
}

export function getPartyByCode(code) {
  const wanted = String(code || '').trim().toUpperCase();
  return Object.values(db.data.parties).find((p) => p.code === wanted) || null;
}

/**
 * Every party this user is a member of.  A player belongs in exactly one, so
 * more than one entry means memberships written before joining started moving
 * them out (the hub now does that in moveOutOfOtherParties).
 */
export function partiesOf(userId) {
  return Object.values(db.data.parties).filter((p) => p.members.some((m) => m.id === userId));
}

export function partyOf(userId) {
  return partiesOf(userId)[0] || null;
}

export function joinParty(party, user) {
  if (party.members.length >= db.data.config.maxPartySize) throw new Error('That party is full.');
  if (!party.members.some((m) => m.id === user.id)) {
    party.members.push({ id: user.id, name: user.name, ready: false, joinedAt: now() });
  }
  party.invites = party.invites.filter((i) => i !== user.id);
  if (party.visibility === 'private') party.visibility = 'private';
  db.touch();
  return party;
}

export function leaveParty(party, userId) {
  party.members = party.members.filter((m) => m.id !== userId);
  if (!party.members.length) {
    delete db.data.parties[party.id];
    db.touch();
    return null;
  }
  if (party.leader === userId) {
    party.leader = party.members[0].id;
    party.members[0].host = true;
  }
  db.touch();
  return party;
}

export function partyPublic(party, { includeChat = false } = {}) {
  if (!party) return null;
  return {
    id: party.id,
    code: party.code,
    leader: party.leader,
    visibility: party.visibility,
    gameId: party.gameId,
    options: party.options,
    status: party.status,
    roomId: party.roomId,
    createdAt: party.createdAt,
    chat: includeChat ? party.chat.slice(-80) : undefined,
    members: party.members.map((m) => {
      const u = db.data.users[m.id];
      return {
        id: m.id,
        name: u?.name || m.name,
        avatar: u?.avatar || '👾',
        level: u ? levelFromXp(u.xp).level : 1,
        ready: !!m.ready,
        host: party.leader === m.id,
        presence: statusOf(m.id),
      };
    }),
    invites: party.invites,
  };
}

/**
 * A member whose seat the grace window reclaimed earns a rejoin ticket: the
 * party still exists, and the returning client can be handed it back without
 * hunting for the code.  The ticket lives on the party and dies with it, so a
 * disbanded party never leaves a stale offer behind.
 */
export function rememberPartyRejoin(party, userId, name) {
  if (!party) return null;
  party.rejoin ||= {};
  party.rejoin[userId] = { name: name || null, at: now() };
  db.touch();
  return party.rejoin[userId];
}

/** The rejoin ticket a party holds for a user, if any. */
export function partyRejoinFor(party, userId) {
  return party?.rejoin?.[userId] || null;
}

/** Spend a ticket - the member is back, or they left on purpose. */
export function clearPartyRejoin(party, userId) {
  if (!party?.rejoin?.[userId]) return false;
  delete party.rejoin[userId];
  db.touch();
  return true;
}

/** The party still holding a rejoin ticket for a user who is no longer in it. */
export function rejoinablePartyOf(userId) {
  return Object.values(db.data.parties).find((p) => p.rejoin?.[userId] && !p.members.some((m) => m.id === userId)) || null;
}

export function appendPartyChat(party, message) {
  party.chat.push(message);
  if (party.chat.length > 200) party.chat.splice(0, party.chat.length - 200);
  db.touch();
  return party.chat;
}

/* ------------------------------------------------------------------ *
 * Chat scopes + rooms
 * ------------------------------------------------------------------ */

export function sanitizeText(text, max = 400) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

export function appendMessage(scope, message, limit = 120) {
  const list = (db.data.messages[scope] ||= []);
  list.push(message);
  if (list.length > limit) list.splice(0, list.length - limit);
  db.touch();
  return list;
}

export function getMessages(scope, limit = 60) {
  return (db.data.messages[scope] || []).slice(-limit);
}

export function listRooms({ gameId = null, publicOnly = true, limit = 60 } = {}) {
  const rooms = Object.values(db.data.rooms);
  const filtered = rooms.filter((r) => r.status !== 'closed' && (!publicOnly || r.visibility === 'public') && (!gameId || r.gameId === gameId));
  return filtered.slice(-limit).reverse();
}

export function roomByCode(code) {
  const wanted = String(code || '').trim().toUpperCase();
  return Object.values(db.data.rooms).find((r) => r.code === wanted && r.status !== 'closed') || null;
}

/* ------------------------------------------------------------------ *
 * Stats, audit
 * ------------------------------------------------------------------ */

/** A padded score is still a padded score: no single match may award more. */
const MAX_MATCH_POINTS = 10000;

/**
 * The points an engine awarded this match, per player: what its over() result
 * reported as `scores` (see simpleOver in web/games/engines/util.js). Only
 * finite, positive numbers for seats that actually played count - a game whose
 * metric is not points earned (mini golf reports negative strokes) simply
 * records none, and its board keeps ranking by games played. Hosts stream the
 * snapshots, so this is the same trust level as the winner list itself; the
 * cap only keeps a malformed value out of the stats shape.
 */
function matchPoints(scores, players) {
  const out = {};
  if (!scores || typeof scores !== 'object') return out;
  for (const p of players) {
    const value = Number(scores[p.id]);
    if (Number.isFinite(value) && value > 0) out[p.id] = Math.min(Math.floor(value), MAX_MATCH_POINTS);
  }
  return out;
}

export function recordGame(gameId, players = [], { roomId = null, winners = [], scores = null, summary = null, review = null } = {}) {
  const points = matchPoints(scores, players);
  db.data.stats.gamesPlayed++;
  db.data.stats.byGame[gameId] = (db.data.stats.byGame[gameId] || 0) + 1;
  for (const p of players) {
    const user = db.data.users[p.id];
    if (!user) continue;
    user.stats.games++;
    user.stats.byGame[gameId] = (user.stats.byGame[gameId] || 0) + 1;
    // Older records have no points map yet.
    if (points[p.id]) {
      user.stats.points ||= {};
      user.stats.points[gameId] = (user.stats.points[gameId] || 0) + points[p.id];
    }
    const won = winners.includes(p.id);
    if (won) {
      user.stats.wins++;
      user.stats.streak = (user.stats.streak || 0) + 1;
      user.stats.bestStreak = Math.max(user.stats.bestStreak || 0, user.stats.streak);
      grantXp(user, 60);
      user.coins += 25;
    } else if (winners.length) {
      user.stats.losses++;
      user.stats.streak = 0;
      grantXp(user, 20);
      user.coins += 8;
    } else {
      user.stats.draws++;
      user.stats.streak = 0;
      grantXp(user, 30);
      user.coins += 12;
    }
  }
  audit(null, 'game.finish', gameId, {
    roomId,
    players: players.map((p) => p.id),
    winners,
    points,
    // How it ended, in the engine's own words, and - for a game that keeps one
    // (see meta.review) - its review of the match.  The audit is the only place
    // a finished game's detail survives, so the chess analysis reads it here.
    summary: summary ? String(summary).slice(0, 200) : null,
    review: review || null,
  });
  db.touch();
}

/**
 * One ranking, two metrics. A game board counts the points its engine awards
 * (see recordGame) and falls back to games played when nobody has scored yet -
 * a board from before points existed, or a game whose metric is not points.
 * Every player who has played the game stays on the board; `rankedBy` tells
 * the caller which number `score` holds, and both `points` and `plays` ride
 * along so the two can be shown side by side. The global board still counts
 * wins.
 */
export function leaderboard(gameId = null, limit = 20) {
  const users = Object.values(db.data.users);
  const pointsOf = (u) => (gameId ? (u.stats.points || {})[gameId] || 0 : 0);
  const playsOf = (u) => (gameId ? u.stats.byGame[gameId] || 0 : 0);
  const byPoints = !!gameId && users.some((u) => pointsOf(u) > 0);
  const score = !gameId ? (u) => u.stats.wins : byPoints ? pointsOf : playsOf;
  const played = !gameId ? (u) => u.stats.wins > 0 : (u) => playsOf(u) > 0;
  return {
    rankedBy: gameId ? (byPoints ? 'points' : 'plays') : 'wins',
    entries: users
      .filter(played)
      .sort((a, b) => score(b) - score(a) || b.xp - a.xp)
      .slice(0, limit)
      .map((u) => ({
        id: u.id,
        name: u.name,
        avatar: u.avatar,
        level: levelFromXp(u.xp).level,
        score: score(u),
        points: pointsOf(u),
        plays: gameId ? playsOf(u) : u.stats.games,
        wins: u.stats.wins,
        games: u.stats.games,
        role: u.role,
      })),
  };
}

/* ------------------------------------------------------------------ *
 * Match history (admin analysis)
 * ------------------------------------------------------------------ */

/**
 * One seat as the analysis shows it: the live account when we still have it
 * (names change, accounts get deleted), the name it played under otherwise.
 */
function seatInfo(id, fallbackName = null, kind = 'human') {
  const user = db.data.users[id];
  return {
    id,
    name: user?.name || fallbackName || id || 'unknown',
    avatar: user?.avatar || (kind === 'bot' ? '🤖' : '❔'),
    role: user?.role || null,
    kind,
    account: !!user,
  };
}

/** The end reason a pre-review match's summary implies, if it says anything. */
function reasonFromSummary(summary) {
  const text = String(summary || '');
  if (/resign/i.test(text)) return 'resignation';
  if (/checkmate/i.test(text)) return 'checkmate';
  if (/50-move|fifty/i.test(text)) return 'fifty-move';
  if (/insufficient/i.test(text)) return 'insufficient-material';
  if (/threefold|repetition/i.test(text)) return 'repetition';
  if (/stalemate/i.test(text)) return 'stalemate';
  return null;
}

/**
 * Every finished match of one game the arcade still knows about.
 *
 * Two sources hold different halves of the story, so they are merged by room id
 * and each match counted once:
 *  - persisted room snapshots - who sat down, who won, when it ran - which last
 *    as long as the database does;
 *  - the audit's `game.finish` entries - a rotating window (the newest few
 *    thousand events across every game), but they carry the engine's review:
 *    colours, plies, captures, opening moves and the end reason.
 */
function matchHistory(gameId) {
  const matches = new Map();
  for (const room of Object.values(db.data.rooms || {})) {
    if (room?.gameId !== gameId || !room.result || !room.finishedAt) continue;
    matches.set(room.id, {
      roomId: room.id,
      code: room.code || null,
      at: room.result.at || room.finishedAt,
      startedAt: room.startedAt || room.createdAt || null,
      finishedAt: room.finishedAt,
      players: (room.players || []).map((p) => seatInfo(p.id, p.name, p.kind)),
      winners: (room.result.winners || []).slice(),
      summary: room.result.summary || '',
      points: null,
      review: null,
    });
  }
  for (const entry of db.data.audit || []) {
    if (entry.action !== 'game.finish' || entry.target !== gameId) continue;
    const meta = entry.meta || {};
    let target = matches.get(meta.roomId || `audit:${entry.at}`);
    if (!target) {
      target = {
        roomId: meta.roomId || null,
        code: null,
        at: entry.at,
        startedAt: null,
        finishedAt: entry.at,
        players: [],
        winners: [],
        summary: '',
        points: null,
        review: null,
      };
      matches.set(meta.roomId || `audit:${entry.at}`, target);
    }
    // The audit is the richer side: it knows the points, the end reason and the
    // engine's review, where a room snapshot only kept who won.
    if (meta.winners) target.winners = meta.winners.slice();
    if (meta.summary) target.summary = meta.summary;
    if (meta.points) target.points = meta.points;
    if (meta.review) target.review = meta.review;
    // Seats, combined rather than replaced.  The audit names the humans who
    // finished the match; the room snapshot names every seat including bots, but
    // it is republished as players leave - a room that closed after the loser
    // walked out has their seat missing from the snapshot, and the audit is the
    // only place they survive.
    if (meta.players?.length) {
      const seats = new Map(target.players.map((p) => [p.id, p]));
      for (const id of meta.players) if (!seats.has(id)) seats.set(id, seatInfo(id));
      target.players = [...seats.values()];
    }
  }
  return [...matches.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * The admin console's chess analysis: every finished chess match the arcade can
 * still account for, aggregated.
 *
 * Chess is the game whose history is worth reading twice - colour matters, how
 * it ended matters, and a single opening line can explain a whole losing streak
 * - so the shape here is a review, not a scoreboard: results by colour, the mix
 * of endings, the openings that get played, who plays whom, who is beating whom,
 * what a typical game costs in moves and minutes, and how much of it the arcade
 * actually has data for (the audit window is finite and reviews only exist for
 * matches finished since they were added).
 */
export function chessAnalysis({ days = 14, recent = 25 } = {}) {
  const matches = matchHistory('chess');
  const perPlayer = new Map();
  const perPair = new Map();
  const endings = new Map();
  const openings = new Map();
  const activity = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  let decisive = 0;
  let drawn = 0;
  let whiteWins = 0;
  let blackWins = 0;
  let reviewed = 0;
  let plies = 0;
  let plyGames = 0;
  let durationMs = 0;
  let timedGames = 0;
  let longest = null;
  let quickest = null;

  for (const match of matches) {
    const seats = match.players.length ? match.players : [seatInfo('unknown')];
    const winners = match.winners || [];
    const won = winners.length > 0;
    if (won) decisive++; else drawn++;
    const review = match.review || null;
    if (review) reviewed++;
    const end = review?.end || reasonFromSummary(match.summary) || 'unrecorded';
    bump(endings, end);

    // Colour: only a reviewed match knows which seat played white.  A draw
    // belongs to neither colour, so it counts towards neither tally.
    if (won && review?.white && winners.includes(review.white)) whiteWins++;
    else if (won && review?.black && winners.includes(review.black)) blackWins++;

    if (Number.isFinite(review?.plies)) {
      plies += review.plies;
      plyGames++;
      if (!longest || review.plies > longest.plies) longest = { at: match.at, plies: review.plies, players: seats, winners, code: match.code };
      if (won && (!quickest || review.plies < quickest.plies)) quickest = { at: match.at, plies: review.plies, players: seats, winners, code: match.code, end };
    }
    if (match.startedAt && match.finishedAt && match.finishedAt > match.startedAt) {
      durationMs += match.finishedAt - match.startedAt;
      timedGames++;
    }
    const opening = Array.isArray(review?.opening) ? review.opening : null;
    if (opening?.length) bump(openings, opening.slice(0, 2).join(' '));

    for (const seat of seats) {
      const row = perPlayer.get(seat.id) || {
        id: seat.id, name: seat.name, avatar: seat.avatar, role: seat.role, kind: seat.kind,
        played: 0, wins: 0, losses: 0, draws: 0, points: 0, white: 0, black: 0, lastAt: 0, streak: 0, bestStreak: 0,
      };
      // A seat that left the account list still counts; a rename should not
      // split one player into two rows.
      row.name = seat.name || row.name;
      row.played++;
      row.points += Number(match.points?.[seat.id]) || 0;
      row.lastAt = Math.max(row.lastAt, match.at || 0);
      if (seat.id === review?.white) row.white++;
      if (seat.id === review?.black) row.black++;
      if (won && winners.includes(seat.id)) {
        row.wins++;
        row.streak++;
        row.bestStreak = Math.max(row.bestStreak, row.streak);
      } else if (won) {
        row.losses++;
        row.streak = 0;
      } else {
        row.draws++;
        row.streak = 0;
      }
      perPlayer.set(seat.id, row);
    }

    // Head to head, for the seats that actually met in this match.
    if (seats.length === 2 && seats[0].id !== seats[1].id) {
      const [a, b] = [...seats].sort((x, y) => String(x.id).localeCompare(String(y.id)));
      const key = `${a.id}|${b.id}`;
      const pair = perPair.get(key) || { a, b, matches: 0, aWins: 0, bWins: 0, draws: 0 };
      pair.matches++;
      if (!won) pair.draws++;
      else if (winners.includes(a.id)) pair.aWins++;
      else if (winners.includes(b.id)) pair.bWins++;
      pair.lastAt = Math.max(pair.lastAt || 0, match.at || 0);
      perPair.set(key, pair);
    }

    // Activity per calendar day, filled out for the whole window later.
    const day = new Date(match.at || 0).toISOString().slice(0, 10);
    bump(activity, day);
  }

  const start = now() - (days - 1) * 86400000;
  const activityDays = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
    activityDays.push({ date, matches: activity.get(date) || 0 });
  }

  const rank = (row) => row.played * 10 + row.wins;
  const players = [...perPlayer.values()]
    .map((row) => ({ ...row, winRate: row.played ? row.wins / row.played : 0 }))
    .sort((a, b) => rank(b) - rank(a) || b.lastAt - a.lastAt);

  const resultLabel = (match) => {
    const winners = match.winners || [];
    const nameOf = (id) => match.players.find((p) => p.id === id)?.name || 'someone';
    if (!winners.length) return 'Draw';
    const review = match.review;
    if (review && winners.includes(review.white)) return `White won (${nameOf(review.white)})`;
    if (review && winners.includes(review.black)) return `Black won (${nameOf(review.black)})`;
    return `${winners.map(nameOf).join(' & ')} won`;
  };

  const shaped = matches.map((match) => ({
    at: match.at,
    roomId: match.roomId,
    code: match.code,
    players: match.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, kind: p.kind })),
    winners: match.winners,
    result: resultLabel(match),
    end: match.review?.end || reasonFromSummary(match.summary) || 'unrecorded',
    plies: Number.isFinite(match.review?.plies) ? match.review.plies : null,
    minutes: match.startedAt && match.finishedAt && match.finishedAt > match.startedAt
      ? Math.max(1, Math.round((match.finishedAt - match.startedAt) / 60000))
      : null,
    summary: match.summary || '',
    opening: match.review?.opening || null,
    reviewed: !!match.review,
    humans: match.players.filter((p) => p.kind !== 'bot').length,
  }));

  return {
    game: { id: 'chess', name: 'Chess', icon: '♞' },
    totals: {
      matches: matches.length,
      decisive,
      draws: drawn,
      drawRate: matches.length ? drawn / matches.length : 0,
      humans: new Set(matches.flatMap((m) => m.players.filter((p) => p.kind !== 'bot').map((p) => p.id))).size,
      bots: new Set(matches.flatMap((m) => m.players.filter((p) => p.kind === 'bot').map((p) => p.id))).size,
      vsBots: matches.filter((m) => m.players.some((p) => p.kind === 'bot')).length,
      whiteWins,
      blackWins,
      reviewed,
      avgPlies: plyGames ? plies / plyGames : null,
      avgMinutes: timedGames ? durationMs / timedGames / 60000 : null,
      longest: longest ? { at: longest.at, plies: longest.plies, names: longest.players.map((p) => p.name), code: longest.code } : null,
      quickest: quickest ? { at: quickest.at, plies: quickest.plies, names: quickest.players.map((p) => p.name), code: quickest.code, end: quickest.end } : null,
    },
    endings: [...endings.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    openings: [...openings.entries()].map(([line, count]) => ({ line, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    players,
    pairings: [...perPair.values()].sort((a, b) => b.matches - a.matches).slice(0, 12),
    activity: activityDays,
    busiestDay: activityDays.slice().sort((a, b) => b.matches - a.matches)[0] || null,
    recent: shaped.slice(-recent).reverse(),
    sources: {
      rooms: Object.values(db.data.rooms || {}).filter((r) => r?.gameId === 'chess').length,
      auditEntries: (db.data.audit || []).length,
      auditCapped: (db.data.audit || []).length >= 2000,
      from: matches[0]?.at || null,
      to: matches[matches.length - 1]?.at || null,
    },
  };
}

export function audit(actor, action, target = null, meta = {}) {
  db.data.audit.push({
    at: now(),
    actor: actor?.id || actor || null,
    actorName: actor?.name || 'system',
    action,
    target,
    meta,
  });
  if (db.data.audit.length > 2000) db.data.audit.splice(0, db.data.audit.length - 2000);
  db.touch();
}

/* ------------------------------------------------------------------ *
 * Bots (local AI opponents owned by a user)
 * ------------------------------------------------------------------ */

export function botRoster(user) {
  return Object.entries(user.bots || {}).map(([gameId, rec]) => ({ gameId, ...rec }));
}

export function difficultyName(level) {
  return ['Rookie', 'Casual', 'Regular', 'Sharp', 'Ruthless', 'Insane'][Math.max(0, Math.min(5, level))];
}

export function shuffleSeats(list) {
  return shuffle(list, Math.random);
}
