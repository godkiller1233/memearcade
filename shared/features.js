/**
 * Feature toggles - the one place that says which parts of the arcade an owner
 * may switch off or hide, and how each switch is enforced.
 *
 * This module is imported by the API server (enforcement), the realtime hub
 * (the same rules over WebSockets) and the admin console (the panel is built
 * from these descriptors), so a toggle can never mean three different things.
 *
 * Two independent switches, because they answer different questions:
 *
 *   on: false      the feature is *refused* below the feature's keep-floor -
 *                  REST routes answer 403 and WebSocket ops bounce with the
 *                  same message.  `minRole` is that floor and defaults to
 *                  `mod`, so staff keep access and an owner can lock a feature
 *                  out of the arcade without locking themselves out.  Raise it
 *                  to keep a feature for VIPs or admins only while players
 *                  lose it.
 *   hidden: true   the feature still works; it is simply not advertised.  The
 *                  client drops its navigation entry for everyone below the
 *                  keep-floor, while a deep link (or a code a friend shares)
 *                  still reaches it for them.
 *
 * The keep-floor is one rule covering both switches *and* any schedule: a role
 * at or above it keeps the feature whatever an owner sets, a role below it
 * loses the feature the moment a switch or a window closes it.  Flags are sent
 * per viewer (see featureFlags) so a client never has to guess.
 *
 * `enforced: false` marks a display-only switch: there is no server route
 * behind it, so the panel says so instead of pretending a door is locked.
 * `hides` names the UI a switch removes, which is what an owner is really
 * asking when they flip it.
 *
 * Schedules are the third switch: an optional window in which a feature closes
 * itself ("chat is closed 22:00-08:00").  A schedule never *overrides* the
 * manual switch on purpose - "on: false" stays off all day - it only adds
 * closed hours.  Times are wall-clock local time, `days` names the day the
 * window opens (0 = Sunday), and a window with `from` after `to` runs over
 * midnight, so a Friday 22:00-08:00 window ends Saturday morning.  Comparisons
 * are `from <= now < to`, i.e. a window ending at 08:00 is open again at
 * 08:00:00 sharp.  Seconds are accepted in the stored clock text so tests can
 * cross a boundary without waiting for a minute tick; the console only ever
 * writes HH:MM.
 */

/** Groups drive the section headings in the admin console, in this order. */
export const FEATURE_GROUPS = ['Play', 'Social', 'Community', 'Client'];

export const FEATURES = [
  /* ---------------- play ---------------- */
  {
    // Display-only on purpose: the catalog feeds the home page, every game
    // picker and the bot, so the switch closes the Games tab instead of
    // refusing a list the shell needs.  Use the per-game switches below to
    // stop a specific game, or `rooms` to stop play altogether.
    id: 'catalog',
    label: 'Game library',
    icon: '🎮',
    group: 'Play',
    enforced: false,
    desc: 'The Games tab and every game picker (the list itself stays served).',
    hides: 'Games tab, side Quick play, Browse-all button',
  },
  {
    id: 'rooms',
    label: 'Online rooms',
    icon: '🏠',
    group: 'Play',
    enforced: true,
    desc: 'Hosting a room, joining one by code, rematches.',
    hides: 'Lobby tab, Join buttons',
  },
  {
    id: 'lobby',
    label: 'Public lobby browser',
    icon: '🔎',
    group: 'Play',
    enforced: true,
    desc: 'The live list of open rooms and its auto-refresh.',
    hides: 'Lobby tab',
  },
  {
    id: 'spectate',
    label: 'Watch live games',
    icon: '👀',
    group: 'Play',
    enforced: true,
    desc: 'Sitting in a match in progress as a spectator.',
    hides: 'Spectate buttons in the lobby',
  },
  {
    id: 'bots',
    label: 'Bot players',
    icon: '🤖',
    group: 'Play',
    enforced: true,
    desc: 'Adding the server-side bot players that fill a room.',
    hides: 'Add bot buttons',
  },
  {
    id: 'leaderboard',
    label: 'Leaderboards',
    icon: '🏆',
    group: 'Play',
    enforced: true,
    desc: 'Score tables served to clients and the bot.',
    hides: 'nothing yet - the web UI has no table view',
  },

  /* ---------------- social ---------------- */
  {
    id: 'friends',
    label: 'Friends & presence',
    icon: '👥',
    group: 'Social',
    enforced: true,
    desc: 'Friend requests, the friend list and who is online.',
    hides: 'Friends tab, "Online now" sidebar',
  },
  {
    id: 'dm',
    label: 'Direct messages',
    icon: '✉️',
    group: 'Social',
    enforced: true,
    desc: 'Private messages between two players.',
    hides: 'DM buttons and DM tabs',
  },
  {
    id: 'chat',
    label: 'Chat channels',
    icon: '💬',
    group: 'Social',
    enforced: true,
    desc: 'Global, party and room chat plus typing pings.',
    hides: 'Chat tab, in-room chat',
  },
  {
    id: 'parties',
    label: 'Parties',
    icon: '🎈',
    group: 'Social',
    enforced: true,
    desc: 'Grouping up before a game and starting as a party.',
    hides: 'Party sidebar, party buttons, Invite',
  },

  /* ---------------- community ---------------- */
  {
    id: 'suggestions',
    label: 'Idea board',
    icon: '💡',
    group: 'Community',
    enforced: true,
    desc: 'Posting, voting on and reading player ideas.',
    hides: 'Ideas tab, home idea card',
  },
  {
    id: 'changelog',
    label: 'Changelog',
    icon: '📦',
    group: 'Community',
    enforced: true,
    desc: 'The list of ideas that shipped.',
    hides: 'Changelog tab',
  },
  {
    id: 'reports',
    label: 'Player reports',
    icon: '📨',
    group: 'Community',
    enforced: true,
    desc: 'Bug reports and complaints filed from Settings.',
    hides: 'Report a bug button in Settings',
  },

  /* ---------------- client ---------------- */
  {
    id: 'downloads',
    label: 'Desktop downloads',
    icon: '⬇️',
    group: 'Client',
    enforced: true,
    desc: 'Download manifests and the desktop app zips.',
    hides: 'Download tab, home desktop banner',
  },
  {
    id: 'music',
    label: 'Background music',
    icon: '🎵',
    group: 'Client',
    enforced: true,
    desc: 'The music engine and the track list.',
    hides: 'Music toggle in the top bar',
  },
];

export const FEATURE_IDS = FEATURES.map((f) => f.id);

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

/** Descriptor for an id, or null - callers never have to guard for typos. */
export function featureById(id) {
  return BY_ID.get(String(id)) || null;
}

/** "Idea board" for a known id; the raw id for an unknown one. */
export function featureLabel(id) {
  return featureById(id)?.label || String(id);
}

/* ------------------------------------------------------------------ *
 * roles & the keep-floor
 *
 * server/lib/auth.js holds the same numbers for real accounts; this copy
 * exists because the browser imports this module and must not touch server
 * code.  Keep the two ladders in step.
 * ------------------------------------------------------------------ */

export const ROLE_RANK = Object.freeze({ guest: 0, user: 1, vip: 2, mod: 3, admin: 4, owner: 5 });

/**
 * Rungs an owner may name as a keep-floor, weakest first.  Guest is not one: an
 * anonymous visitor never keeps a closed feature.
 */
export const KEEP_ROLES = Object.freeze(['user', 'vip', 'mod', 'admin', 'owner']);

/** Staff keep every switch by default - the behaviour this arcade always had. */
export const DEFAULT_KEEP_ROLE = 'mod';

/** How the console labels each rung - the server sends this list to the panel. */
export const KEEP_ROLE_LABELS = Object.freeze({
  user: 'Players & up',
  vip: 'VIP & up',
  mod: 'Staff & up',
  admin: 'Admins & up',
  owner: 'Owner only',
});

/** "players" / "VIPs" / "staff" - the keep-floor in a sentence. */
const KEEP_PHRASES = Object.freeze({ user: 'players', vip: 'VIPs', mod: 'staff', admin: 'admins', owner: 'the owner' });

export function roleRank(role) {
  return ROLE_RANK[String(role)] ?? 0;
}

/** A stored keep-floor becomes a real rung; junk (or nothing) becomes staff. */
export function normalizeKeepRole(raw) {
  return KEEP_ROLES.includes(String(raw)) ? String(raw) : DEFAULT_KEEP_ROLE;
}

/** True when `role` sits at or above `keepRole` on the ladder. */
export function roleKeeps(role, keepRole) {
  return roleRank(role) >= roleRank(keepRole);
}

export function keepPhrase(keepRole) {
  return KEEP_PHRASES[normalizeKeepRole(keepRole)];
}

/**
 * The sentence a caller who was refused reads.  With the default staff floor the
 * old arcade-wide wording is still the whole truth; a role-worded message
 * otherwise, so a player does not read "the arcade is broken" when a feature is
 * deliberately kept for someone else.
 */
export function refusalMessage(label, keepRole) {
  if (normalizeKeepRole(keepRole) === DEFAULT_KEEP_ROLE) return `${label} is turned off on this arcade.`;
  return `${label} is kept for ${keepPhrase(keepRole)} - it is turned off for your account.`;
}

/** Every switch on, nothing hidden, staff keep-floor - what a fresh database gets. */
export function defaultFeatureState() {
  return Object.fromEntries(FEATURES.map((f) => [f.id, { on: true, hidden: false, minRole: DEFAULT_KEEP_ROLE }]));
}

/**
 * Merge whatever is stored (possibly from an older build, possibly junk) over
 * the defaults.  Unknown ids are dropped, so a retired feature cannot linger
 * in a database and a new one always starts switched on.  A schedule survives
 * the merge in its normalized shape; features without one have no `schedule`
 * key at all, so a fresh database carries no dead weight.  The keep-floor is
 * stored on every feature and repaired on the way in, which is why a database
 * written before keep-floors existed keeps its old staff-only behaviour.
 */
export function normalizeFeatures(raw) {
  const out = defaultFeatureState();
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!BY_ID.has(id) || !value || typeof value !== 'object') continue;
    const schedule = normalizeSchedule(value.schedule);
    out[id] = {
      on: value.on !== false,
      hidden: value.hidden === true,
      minRole: normalizeKeepRole(value.minRole),
      ...(schedule ? { schedule } : {}),
    };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * schedules
 *
 * A schedule is `{ enabled, days, from, to }`.  `from`/`to` are clock strings
 * ("22:00"); the first transition of the day happens at `from` and the window
 * closes again at `to`.  See the header for the over-midnight rule.
 * ------------------------------------------------------------------ */

const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** "22:00" / "07:30:15" -> seconds since midnight, or null when unparseable. */
export function parseClock(text) {
  const match = CLOCK_RE.exec(String(text ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] ? Number(match[3]) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Seconds since midnight back to clock text - "HH:MM", or with seconds when they matter. */
export function clockText(seconds) {
  const total = ((Math.round(Number(seconds) || 0) % 86400) + 86400) % 86400;
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}${s ? `:${pad(s)}` : ''}`;
}

/** What the console offers when an owner first switches scheduling on. */
export const DEFAULT_SCHEDULE = Object.freeze({ enabled: true, days: Object.freeze([0, 1, 2, 3, 4, 5, 6]), from: '22:00', to: '08:00' });

/**
 * Whatever is stored becomes a usable schedule, or null when there is none.
 * Bad clock text falls back to the default evening window rather than a
 * schedule that can never fire, because a switch that silently does nothing is
 * worse than one that closes at a sensible hour.
 */
export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = parseClock(raw.from);
  const to = parseClock(raw.to);
  const valid = Array.isArray(raw.days)
    ? [...new Set(raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];
  const days = valid.length ? valid : [0, 1, 2, 3, 4, 5, 6];
  return {
    enabled: raw.enabled === true,
    days,
    from: from === null ? DEFAULT_SCHEDULE.from : clockText(from),
    to: to === null ? DEFAULT_SCHEDULE.to : clockText(to),
  };
}

/** True while `schedule` is inside its closed window at `date` (local time). */
export function scheduleActive(schedule, date = new Date()) {
  if (!schedule || schedule.enabled !== true) return false;
  const from = parseClock(schedule.from);
  const to = parseClock(schedule.to);
  if (from === null || to === null) return false;
  const days = Array.isArray(schedule.days) ? schedule.days : [];
  if (!days.length) return false;
  const day = date.getDay();
  const seconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  if (from === to) return days.includes(day); // 00:00-00:00 means the whole day
  if (from < to) return days.includes(day) && seconds >= from && seconds < to;
  // Spans midnight: the day it opens, plus the morning after a selected day.
  if (days.includes(day) && seconds >= from) return true;
  return days.includes((day + 6) % 7) && seconds < to;
}

/**
 * When this schedule next flips: the end of the window it is in, or the start
 * of the next one.  Null when the schedule can never fire.  Used to tell an
 * owner "closes in 3h" / "opens at 08:00", and to stamp the client notice.
 */
export function nextScheduleChange(schedule, date = new Date()) {
  if (!schedule || schedule.enabled !== true) return null;
  const from = parseClock(schedule.from);
  const to = parseClock(schedule.to);
  if (from === null || to === null) return null;
  const days = Array.isArray(schedule.days) ? schedule.days : [];
  if (!days.length) return null;
  const span = (from === to ? 86400 : ((to - from + 86400) % 86400)) * 1000;
  const midnight = new Date(date);
  midnight.setHours(0, 0, 0, 0);
  for (let ahead = 0; ahead < 8; ahead++) {
    const start = new Date(midnight.getTime() + ahead * 86400000 + from * 1000);
    if (!days.includes(start.getDay())) continue;
    const end = new Date(start.getTime() + span);
    if (end <= date) continue; // that window is already over
    return start > date ? start : end;
  }
  return null;
}

/** Stored state for one feature, defaults filled in. */
export function featureState(config, id) {
  return normalizeFeatures(config?.features)[id] || { on: true, hidden: false };
}

/** True while this feature's schedule has it closed at `date`. */
export function featureClosed(config, id, date = new Date()) {
  return scheduleActive(featureState(config, id).schedule, date);
}

/**
 * The lowest role this feature is kept for while its switches are set.  An
 * unknown id reads as the staff default, so a typo can never open a door.
 */
export function featureKeepRole(config, id) {
  return normalizeKeepRole(featureState(config, id).minRole);
}

/** True when `role` keeps this feature even while it is switched off or hidden. */
export function featureKept(config, id, role) {
  return roleKeeps(role, featureKeepRole(config, id));
}

/**
 * May `role` use the feature right now: the switch is on and any window is open,
 * or the caller sits at or above the keep-floor.  This is the one question every
 * route and every socket op asks.
 */
export function featureAllowed(config, id, { role = 'guest', date = new Date() } = {}) {
  return featureOn(config, id, date) || featureKept(config, id, role);
}

/** The refusal sentence for a caller who may not use this feature. */
export function featureRefusal(config, id) {
  return refusalMessage(featureLabel(id), featureKeepRole(config, id));
}

/**
 * True when the feature is served *right now*: the manual switch is on and any
 * schedule for it is between windows.  Does not know about staff bypass.
 */
export function featureOn(config, id, date = new Date()) {
  const state = featureState(config, id);
  if (state.on === false) return false;
  return !scheduleActive(state.schedule, date);
}

/** True when the feature is unlisted by an owner (still served, just not advertised). */
export function featureHidden(config, id) {
  return featureState(config, id).hidden === true;
}

/**
 * The switch map **one viewer** receives: the stored truth with that viewer's
 * keep-floor applied, plus any schedule that is closed right now, so "on"
 * always means "this caller may use it as of this second".  Above the floor both
 * switches are lifted - the feature is simply there for that role, and no window
 * applies to them.  Below it, a closed window adds `scheduled: true` and `until`
 * (an ISO stamp) so the client can say *why* a tab vanished and when it comes
 * back.  Nothing here is a secret: a player sees the effect anyway, and the
 * floor is what tells them it is kept for someone else.
 */
export function featureFlags(config, date = new Date(), { role = 'guest' } = {}) {
  const out = normalizeFeatures(config?.features);
  for (const id of FEATURE_IDS) {
    const state = out[id];
    if (roleKeeps(role, state.minRole)) {
      out[id] = { ...state, on: true, hidden: false };
      continue;
    }
    if (state.on === false) continue;
    if (!scheduleActive(state.schedule, date)) continue;
    const until = nextScheduleChange(state.schedule, date);
    out[id] = { ...state, on: false, hidden: true, scheduled: true, until: until ? until.toISOString() : null };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * per-game visibility
 *
 * The same two switches, but for one catalog entry: `on` refuses a game for
 * players, `hidden` keeps it playable by anyone who has the link or the room
 * code while dropping it out of the library list.
 * ------------------------------------------------------------------ */

export function defaultGameState() {
  return { on: true, hidden: false, minRole: DEFAULT_KEEP_ROLE };
}

/** Normalize a stored per-game map; unknown game ids are kept (catalog moves). */
export function normalizeGames(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    out[id] = { on: value.on !== false, hidden: value.hidden === true, minRole: normalizeKeepRole(value.minRole) };
  }
  return out;
}

export function gameState(config, id) {
  return normalizeGames(config?.games)[id] || defaultGameState();
}

export function gameOn(config, id) {
  return gameState(config, id).on !== false;
}

export function gameHidden(config, id) {
  return gameState(config, id).hidden === true;
}

/** The lowest role this game is kept for while its switches are set. */
export function gameKeepRole(config, id) {
  return normalizeKeepRole(gameState(config, id).minRole);
}

/** True when `role` keeps this game even while it is switched off or hidden. */
export function gameKept(config, id, role) {
  return roleKeeps(role, gameKeepRole(config, id));
}

/** True when `role` may start this game: switched on, or kept above the floor. */
export function gameAllowed(config, id, { role = 'guest' } = {}) {
  return gameOn(config, id) || gameKept(config, id, role);
}

/** Games that belong in `role`'s library: switched on and shown, or kept. */
export function gameListed(config, id, role = 'guest') {
  if (gameKept(config, id, role)) return true;
  const state = gameState(config, id);
  return state.on !== false && state.hidden !== true;
}

/** The games `role` should see in the catalog. */
export function visibleGames(config, games, { role = 'guest' } = {}) {
  return games.filter((g) => gameListed(config, g?.id, role));
}

/** The refusal sentence for a game `role` may not start. */
export function gameRefusal(config, id, label = '') {
  return refusalMessage(label || String(id), gameKeepRole(config, id));
}
