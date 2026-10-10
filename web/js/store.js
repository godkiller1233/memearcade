/**
 * Client-side state + settings.
 *
 * Settings live in localStorage for instant boot, and are mirrored to the
 * server so the desktop client, the website and the Discord bot all agree.
 */
import { el } from './dom.js';

export const CLIENT_VERSION = '1.0.0';
export const CLIENT_KIND = 'web';
/**
 * The API shape this build speaks.  Kept in sync with shared/version.js by
 * hand (the web bundle cannot reach outside web/), and tools/check.mjs fails
 * the build if the two ever drift apart.
 */
export const API_VERSION = 3;

const LS_KEY = 'memes-arcade:state';

export const THEMES = [
  { id: 'arcade-dark', name: 'Arcade Dark' },
  { id: 'midnight', name: 'Midnight' },
  { id: 'neon', name: 'Neon' },
  { id: 'candy', name: 'Candy' },
  { id: 'forest', name: 'Forest' },
  { id: 'paper', name: 'Paper (light)' },
];

export const KEYBIND_ACTIONS = [
  ['up', 'Move up'], ['down', 'Move down'], ['left', 'Move left'], ['right', 'Move right'],
  ['action', 'Primary action'], ['action2', 'Secondary action'],
  ['aim', 'Aim / shoot'], ['draw', 'Draw'], ['undo', 'Undo'], ['pause', 'Pause / menu'],
  ['chat', 'Open chat'], ['vote', 'Vote'], ['sprint', 'Sprint'], ['ready', 'Ready up'],
];

export const DEFAULT_KEYBINDS = {
  up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', action: 'Space', action2: 'KeyE',
  aim: 'MouseLeft', draw: 'MouseLeft', undo: 'KeyZ', pause: 'Escape', chat: 'KeyT',
  vote: 'KeyV', sprint: 'ShiftLeft', ready: 'KeyR',
};

export const state = {
  token: null,
  me: null,
  server: null,
  client: null,
  degraded: [],
  catalog: [],
  categories: [],
  friends: [],
  party: null,
  room: null,
  view: null,
  // Authoritative snapshot for realtime rooms the server hands the host
  // (the host is the one who simulates and streams it back).
  roomState: null,
  lobby: [],
  lobbyStats: null,
  globalStats: null,
  messages: {}, // scope -> [message]
  dms: {}, // userId -> [message]
  conversations: [],
  online: {}, // userId -> status
  chatScope: 'global',
  chatTarget: null,
  connection: 'offline',
  view: 'home',
  // The server's public config (motd, announcement, and the per-feature switch
  // map an owner edits in the admin console), already resolved for this
  // account's role.  See featureOn/featureHidden.
  serverConfig: null,
  features: {},
  settings: {
    theme: 'arcade-dark',
    accent: '#ff2fb0',
    reduceMotion: false,
    cardSize: 'normal',
    audio: { master: 0.8, music: true, musicVolume: 0.32, track: 'neon-runner', autoNextTrack: true, sfx: true, sfxVolume: 0.7 },
    keybinds: { ...DEFAULT_KEYBINDS },
    notifications: { friendRequests: true, partyInvites: true, sounds: true, mentions: true },
    privacy: { showInLobby: true, allowInvites: true, allowDms: 'friends', presence: 'online' },
    gameplay: { confirmMoves: false, autoReady: false, timers: true, largeText: false, colorblindSafe: false, lowSpec: false },
    // Per-game memory: game id -> whatever that game wants to remember between
    // matches (see gameMemory/rememberGame below).
    games: {},
  },
  ui: { busy: false },
};

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error('listener failed', err);
    }
  }
}

/* ------------------------------------------------------------------ *
 * persistence
 * ------------------------------------------------------------------ */

export function loadLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (raw.token) state.token = raw.token;
    if (raw.settings) state.settings = merge(state.settings, raw.settings);
    if (raw.view) state.view = raw.view;
  } catch {}
  return state;
}

let saveTimer = null;
export function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ token: state.token, settings: state.settings, view: state.view }));
    } catch {}
  }, 200);
}

export function merge(base, patch) {
  if (Array.isArray(base)) return patch ?? base;
  if (typeof base !== 'object' || base === null) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function setSettings(patch, { persist = true } = {}) {
  state.settings = merge(state.settings, patch);
  applyTheme();
  saveLocal();
  if (persist) mirrorSettings();
  notify();
  return state.settings;
}

/**
 * Per-game memory.
 *
 * A game that should never forget something - a loadout, a record, a high
 * score - reads and writes one small object under `settings.games[gameId]`.
 * It rides the settings pipeline the arcade already has: instant from
 * localStorage on boot, mirrored to the account so the website, the desktop
 * client and the bot agree, and device-only for a guest (mirrorSettings skips a
 * signed-out client).
 */
export function gameMemory(gameId) {
  const all = state.settings?.games;
  const memory = all && typeof all === 'object' ? all[String(gameId)] : null;
  return memory && typeof memory === 'object' ? memory : null;
}

/** Store a game's memory, persisting it and syncing it to the account. */
export function rememberGame(gameId, memory) {
  if (!memory || typeof memory !== 'object') return null;
  setSettings({ games: { [String(gameId)]: memory } });
  return memory;
}

/**
 * The unfinished solo run saved for a game, or null when there is none.
 *
 * A long solo game (a nine-hole round, a sudoku grid) parks its state here while
 * it is being played, so leaving the page - or quitting the app - does not throw
 * the run away.  The state travels as a string: the settings merge replaces a
 * primitive outright, which is the only way a saved run can also be *cleared*
 * (see clearGameProgress and the tombstone bookRun writes when a run finishes).
 */
export function gameProgress(gameId) {
  const progress = gameMemory(gameId)?.progress;
  const json = typeof progress?.json === 'string' ? progress.json : '';
  if (!json) return null;
  try {
    const state = JSON.parse(json);
    if (!state || typeof state !== 'object') return null;
    return { ...progress, state };
  } catch {
    return null;
  }
}

/** Retire a game's saved run (the record itself is untouched). */
export function clearGameProgress(gameId) {
  const memory = gameMemory(gameId);
  if (!memory?.progress) return null;
  return rememberGame(gameId, { ...memory, progress: { json: '', runId: memory.progress.runId || null, doneAt: Date.now() } });
}

/**
 * The remembered table rules for a game, in the shape engines take as
 * `options` - so a game the player already set up opens on their rules instead
 * of the stock defaults.
 */
export function gameLoadout(gameId) {
  const memory = gameMemory(gameId);
  if (!memory) return {};
  const out = {};
  for (const key of ['pick', 'stage', 'stocks', 'time']) if (memory[key] !== undefined) out[key] = memory[key];
  return out;
}

let settingsTimer = null;
export function mirrorSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    import('./api.js').then(({ api, isSignedIn }) => {
      if (!isSignedIn()) return;
      api.post('/api/settings', state.settings).catch(() => {});
    });
  }, 700);
}

/* ------------------------------------------------------------------ *
 * theme + accessibility
 * ------------------------------------------------------------------ */

export function applyTheme() {
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme || 'arcade-dark';
  document.documentElement.style.setProperty('--accent', s.accent || '#ff2fb0');
  document.body?.classList.toggle('reduce-motion', !!s.reduceMotion);
  if (s.gameplay?.largeText) document.documentElement.style.fontSize = '17px';
  else document.documentElement.style.fontSize = '';
}

export function cycleTheme() {
  const ids = THEMES.map((t) => t.id);
  const i = ids.indexOf(state.settings.theme);
  const next = ids[(i + 1) % ids.length];
  setSettings({ theme: next });
  return next;
}

/* ------------------------------------------------------------------ *
 * keybinds
 * ------------------------------------------------------------------ */

export function keybind(action) {
  return state.settings.keybinds?.[action] || DEFAULT_KEYBINDS[action];
}

/** The engine-facing input map: intent -> key code, honouring user bindings. */
export function inputMap() {
  const out = {};
  for (const [id] of KEYBIND_ACTIONS) out[id] = keybind(id);
  return out;
}

export function bindKeyCapture(node, action) {
  const label = el('button', { class: 'btn keybind-capture', text: 'Press a key…' });
  let capturing = false;
  const start = () => {
    capturing = true;
    label.textContent = 'Listening…';
    window.addEventListener('keydown', onKey, true);
  };
  const stop = () => {
    capturing = false;
    window.removeEventListener('keydown', onKey, true);
    label.textContent = keyLabelShort(keybind(action));
  };
  const onKey = (ev) => {
    if (!capturing) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.code === 'Escape') return stop();
    setSettings({ keybinds: { [action]: ev.code } });
    stop();
  };
  label.addEventListener('click', start);
  label.dataset.action = action;
  label.textContent = keyLabelShort(keybind(action));
  return label;
}

export function keyLabelShort(code) {
  return String(code || '—')
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace('ShiftLeft', 'LShift')
    .replace('ControlLeft', 'LCtrl')
    .replace('ArrowUp', '↑')
    .replace('ArrowDown', '↓')
    .replace('ArrowLeft', '←')
    .replace('ArrowRight', '→');
}

/** Quick lookup used by canvas games: is this event one of the bound keys? */
export function eventMatches(ev, action) {
  const code = keybind(action);
  if (code?.startsWith('Mouse')) return false;
  return ev.code === code;
}

export function me() {
  return state.me;
}

/**
 * Adopt a signed-in user (REST auth and the realtime `me` push both carry the
 * account's stored settings).  The account copy wins over this browser's
 * local copy - that is the whole point of syncing them across the website,
 * the desktop client and the bot.
 */
export function setMe(user) {
  state.me = user;
  if (user?.settings && typeof user.settings === 'object') {
    state.settings = merge(state.settings, user.settings);
    applyTheme();
    saveLocal();
  }
  notify();
  return user;
}

export function isStaff() {
  return !!state.me?.permissions?.mod || !!state.me?.permissions?.admin;
}

export function isAdmin() {
  return !!state.me?.permissions?.admin;
}

/* ------------------------------------------------------------------ *
 * feature switches
 * ------------------------------------------------------------------ */

/**
 * Adopt the server's public config - the boot handshake, the realtime welcome
 * and the live `config` push all arrive in this shape.  The feature switches
 * ride inside it *already resolved for this account*: the server applies the
 * keep-floor (staff by default, or whoever an owner keeps a feature for) before
 * sending, so a role that keeps a feature simply receives `on: true` and this
 * side needs no role logic of its own.
 */
export function setServerConfig(config) {
  if (!config || typeof config !== 'object') return state.serverConfig;
  state.serverConfig = { ...(state.serverConfig || {}), ...config };
  if (config.features) state.features = config.features;
  return state.serverConfig;
}

/** The raw switch map for one feature, defaults filled in. */
export function featureRaw(id) {
  return state.features?.[id] || { on: true, hidden: false };
}

/**
 * May this account use the feature?  The server already answered for our role
 * (staff keep everything by default, and a higher keep-floor is applied the
 * same way), so the flags are the truth here - no local role check.
 */
export function featureOn(id) {
  return featureRaw(id).on !== false;
}

/** Should the UI stop advertising this feature to this account? */
export function featureHidden(id) {
  const flags = featureRaw(id);
  return flags.hidden === true || flags.on === false;
}

export function resetClientState() {
  state.me = null;
  state.token = null;
  state.room = null;
  state.view = null;
  state.roomState = null;
  state.party = null;
  state.friends = [];
  state.messages = {};
  state.dms = {};
  state.conversations = [];
  saveLocal();
  notify();
}
