/**
 * Shared, DOM-free helpers for game engines.  Every engine imports this so the
 * same rules run in the browser (solo/local) and in Node (online, authoritative).
 */

/* ------------------------------- randomness ------------------------------- */

export function makeRng(seed = Date.now()) {
  let a = typeof seed === 'number' ? seed >>> 0 : hash(String(seed));
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function shuffle(arr, rng = Math.random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

export function pickMany(arr, n, rng = Math.random) {
  return shuffle(arr, rng).slice(0, n);
}

export function intBetween(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function chance(p, rng = Math.random) {
  return rng() < p;
}

/* --------------------------------- misc ---------------------------------- */

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function uid(prefix = 'x') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function seatIds(state) {
  return state.players.map((p) => p.id);
}

export function byId(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

export function others(state, id) {
  return state.players.filter((p) => p.id !== id);
}

export function isBot(state, id) {
  return !!byId(state, id)?.bot;
}

/** Append a line to the shared, client-visible game log. */
export function addLog(state, text, kind = 'info') {
  state.log = state.log || [];
  state.log.push({ at: state.tick ?? 0, text: String(text).slice(0, 220), kind });
  if (state.log.length > 120) state.log.splice(0, state.log.length - 120);
  state.tick = (state.tick ?? 0) + 1;
  return state.log[state.log.length - 1];
}

/** Standard event payload for act() results. */
export function event(text, kind = 'info') {
  return { text, kind };
}

/* --------------------------------- scoring -------------------------------- */

export function zeroScores(state) {
  state.scores = {};
  for (const p of state.players) state.scores[p.id] = 0;
  return state.scores;
}

export function addScore(state, id, amount) {
  state.scores[id] = (state.scores[id] || 0) + amount;
  return state.scores[id];
}

/** Turn the score map into a ranked list (id, score, rank). */
export function ranking(state) {
  const entries = state.players.map((p) => ({ id: p.id, name: p.name, score: state.scores?.[p.id] || 0 }));
  entries.sort((a, b) => b.score - a.score);
  let rank = 0;
  let last = null;
  return entries.map((e, i) => {
    if (last === null || e.score !== last) rank = i + 1;
    last = e.score;
    return { ...e, rank };
  });
}

export function leaders(state) {
  const r = ranking(state);
  const best = r[0]?.score ?? 0;
  return r.filter((e) => e.score === best).map((e) => e.id);
}

/* ------------------------------ turns / phases ---------------------------- */

/** Advance a simple rotating turn pointer over state.order. */
export function nextTurn(state, { skip = [] } = {}) {
  const order = state.order?.length ? state.order : seatIds(state);
  let i = order.indexOf(state.turnId);
  for (let step = 1; step <= order.length; step++) {
    const cand = order[(i + step) % order.length];
    if (skip.includes(cand)) continue;
    state.turnId = cand;
    state.turnCount = (state.turnCount || 0) + 1;
    return cand;
  }
  return state.turnId;
}

export function phase(state, name, extra = {}) {
  state.phase = name;
  Object.assign(state, extra);
  return state;
}

/** Number of "steps" done so far, used by simultaneous games. */
export function submitted(state, list) {
  return (list || []).filter((x) => x !== undefined && x !== null && x !== '');
}

/* -------------------------------- texts ---------------------------------- */

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function title(s) {
  return String(s || '').replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

export function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* --------------------------------- grids ---------------------------------- */

export function gridIndex(x, y, w) {
  return y * w + x;
}

export function inBounds(x, y, w, h) {
  return x >= 0 && y >= 0 && x < w && y < h;
}

export const DIRS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export const DIRS4 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/** Standard bot-difficulty normaliser: 0..5 -> 0..1 */
export function botSkill(level) {
  return clamp(Number(level ?? 2) / 5, 0, 1);
}

/** Wrap a move with a tiny artificial delay so bots feel human. */
export function botThink(state) {
  return { delay: 250 + Math.floor(Math.random() * 350) };
}

/* ---------------------------- engine scaffolding --------------------------- */

/**
 * Build the common `create` scaffolding: seats, scores, log, turn pointer.
 * Engines add their own fields on top.
 */
export function baseState({ players, seed, order }) {
  const seats = players.map((p, i) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar || '👾',
    bot: p.kind === 'bot',
    level: p.level ?? 2,
    seat: i,
  }));
  const state = {
    version: 1,
    seed: seed ?? Math.floor(Math.random() * 1e9),
    players: seats,
    order: order || seats.map((s) => s.id),
    turnId: (order || seats.map((s) => s.id))[0],
    turnCount: 0,
    phase: 'playing',
    log: [],
    tick: 0,
    scores: {},
  };
  for (const s of seats) state.scores[s.id] = 0;
  return state;
}

/**
 * Default "is the game over" check: engines with a winner set state.winner.
 *
 * The result's `scores` is the per-game score the arcade books with the match
 * (server/store.js takes it straight from here): a map of player id -> the
 * points that player earned, so the per-game leaderboard can rank by points.
 * The convention is already what scoring helpers build (see baseRealtime) -
 * an engine only has to make sure the final value means "points earned", not
 * some other scale. Engines that award nothing leave it at zero.
 */
export function simpleOver(state, { draw = false } = {}) {
  if (state.winnerId) {
    return { over: true, winners: Array.isArray(state.winnerId) ? state.winnerId : [state.winnerId], scores: state.scores, summary: state.summary || 'Winner!' };
  }
  if (draw || state.draw) return { over: true, winners: [], scores: state.scores, summary: state.summary || 'Draw.' };
  return { over: false };
}

/** Standard seat-view skeleton every engine extends. */
export function baseView(state, viewerId) {
  return {
    phase: state.phase,
    turn: state.turnId ? [state.turnId] : [],
    players: state.players,
    scores: state.scores,
    log: state.log.slice(-24),
    turnCount: state.turnCount || 0,
  };
}

export function keepAlive(state) {
  state.updatedAt = Date.now();
  return state;
}
