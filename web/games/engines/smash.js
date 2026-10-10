/**
 * MEME - the Smash-style platform fighter.
 *
 * Realtime and host-authoritative like the other arcade engines: act({}) accepts
 * input actions and `{ type: 'tick', dt }` advances the fight in fixed 1/60s
 * slices.  A match opens on a character-select screen - every seat picks a
 * fighter and the room agrees on a stage, a stock count and a timer - and then
 * runs on the chosen stage.  Fighters build up damage percent; the higher the
 * percent, the further they fly, and flying past a blast zone costs a stock.
 * Last fighter with stocks left wins.
 *
 * Roster flavour: recognisable anime fighters (the same "manga misc" cast the
 * card games already use) with colours and emoji standing in for sprites.
 *
 * A pick travels as part of an `input` action.  Online rooms only relay `input`
 * from non-host seats to the room host (see server/games.js), so riding along
 * with the seat's controls means a pick needs no relay path of its own.
 *
 * Memory: the match keeps a permanent per-account record through the host's
 * `memory` port (see main.js gameMemoryPort -> settings.games).  The client half
 * remembers the last fighter/stage/stocks/timer and a per-fighter record, shows
 * it on the select screen and writes it back when a match ends.  Nothing in the
 * engine's own state depends on it, so the authoritative server side stays pure.
 */
import * as U from './util.js';
import * as UI from './ui.js';

const MODES = ['solo', 'local', 'online'];
const SUBSTEP = 1 / 60;
const W = 720;
const H = 420;
const GRAVITY = 980;
const JUMP = -350;
const ACCEL = 1000;
const MAX_HS = 205;
const BLAST_X = 90;
const BLAST_Y = 110;
/** Seconds a seat has to pick before the bell rings and the stragglers are assigned. */
const SELECT_LIMIT = 30;
/** "3... 2... 1... FIGHT!" once every seat is locked in. */
const COUNTDOWN = 3;
const STOCK_CHOICES = [1, 2, 3, 5];
const TIME_CHOICES = [60, 120, 180, 240, 0];

/**
 * The roster.  Recognisable anime fighters, each with a special, a role and the
 * four numbers the select screen shows as bars: speed (accel + top speed),
 * reach (punch range), weight (how far a hit launches them) and shot (projectile
 * speed).  Stats are deliberately close together so a pick is flavour, not fate.
 */
const ROSTER = [
  { id: 'goku', name: 'Goku', emoji: '🥋', color: '#f97316', special: 'Kamehameha', role: 'All-rounder', speed: 1.02, reach: 58, weight: 1.0, shot: 1.1 },
  { id: 'luffy', name: 'Luffy', emoji: '🏴‍☠️', color: '#ef4444', special: 'Gum-Gum Pistol', role: 'Brawler', speed: 1.0, reach: 72, weight: 1.05, shot: 0.85 },
  { id: 'naruto', name: 'Naruto', emoji: '🍥', color: '#fbbf24', special: 'Rasengan', role: 'Rushdown', speed: 1.08, reach: 54, weight: 0.95, shot: 1.0 },
  { id: 'pikachu', name: 'Pikachu', emoji: '⚡', color: '#fde047', special: 'Thunderbolt', role: 'Zoner', speed: 1.1, reach: 48, weight: 0.88, shot: 1.35 },
  { id: 'sailor', name: 'Sailor Moon', emoji: '🌙', color: '#f472b6', special: 'Moon Tiara', role: 'Zoner', speed: 1.0, reach: 52, weight: 0.92, shot: 1.2 },
  { id: 'tanjiro', name: 'Tanjiro', emoji: '💧', color: '#2dd4bf', special: 'Water Breathing', role: 'Duelist', speed: 1.04, reach: 60, weight: 1.0, shot: 1.0 },
  { id: 'gojo', name: 'Gojo', emoji: '🧿', color: '#38bdf8', special: 'Cursed Blue', role: 'Zoner', speed: 1.0, reach: 56, weight: 0.94, shot: 1.3 },
  { id: 'zoro', name: 'Zoro', emoji: '⚔️', color: '#4ade80', special: 'Three-Sword Style', role: 'Swordsman', speed: 0.96, reach: 66, weight: 1.1, shot: 0.9 },
  { id: 'saitama', name: 'Saitama', emoji: '👊', color: '#facc15', special: 'One Punch', role: 'Heavy', speed: 0.94, reach: 62, weight: 1.15, shot: 0.8 },
  { id: 'levi', name: 'Levi', emoji: '🧣', color: '#94a3b8', special: 'Spinning Slash', role: 'Speedster', speed: 1.12, reach: 50, weight: 0.9, shot: 1.0 },
  { id: 'rimuru', name: 'Rimuru', emoji: '💠', color: '#60a5fa', special: 'Predator', role: 'Adaptive', speed: 1.0, reach: 58, weight: 0.96, shot: 1.15 },
  { id: 'light', name: 'Light', emoji: '📓', color: '#a78bfa', special: 'Name Drop', role: 'Tactician', speed: 0.98, reach: 56, weight: 0.98, shot: 1.25 },
];

/**
 * The stages.  Every layout is a main deck plus platforms that chain upward
 * within a double jump (roughly 125px of climb), so the arena is always
 * traversable whichever map the room picks.
 */
const STAGES = [
  {
    id: 'skyline',
    name: 'Neon Skyline',
    blurb: 'Rooftop brawl above a glowing grid.',
    palette: 'neon',
    accent: '#38bdf8',
    horizon: 0.72,
    stars: 34,
    decor: 'skyline',
    platforms: [
      { x1: 170, y1: 330, x2: 550, y2: 330, main: true },
      { x1: 250, y1: 232, x2: 400, y2: 232 },
      { x1: 460, y1: 170, x2: 600, y2: 170 },
    ],
  },
  {
    id: 'shrine',
    name: 'Cursed Shrine',
    blurb: 'Torii gate, twin towers, small mercy.',
    palette: 'sunset',
    accent: '#ff9f43',
    horizon: 0.7,
    stars: 22,
    decor: 'shrine',
    platforms: [
      { x1: 150, y1: 336, x2: 570, y2: 336, main: true },
      { x1: 120, y1: 248, x2: 240, y2: 248 },
      { x1: 480, y1: 248, x2: 600, y2: 248 },
    ],
  },
  {
    id: 'final',
    name: 'Final Destination',
    blurb: 'One flat deck. No excuses.',
    palette: 'arcade',
    accent: '#00f5d4',
    horizon: 0.76,
    stars: 48,
    decor: 'portal',
    platforms: [{ x1: 100, y1: 332, x2: 620, y2: 332, main: true }],
  },
  {
    id: 'towers',
    name: 'Twin Towers',
    blurb: 'Two perches over a narrow deck.',
    palette: 'mono',
    accent: '#cbd5e1',
    horizon: 0.7,
    stars: 26,
    decor: 'towers',
    platforms: [
      { x1: 210, y1: 340, x2: 510, y2: 340, main: true },
      { x1: 90, y1: 236, x2: 190, y2: 236 },
      { x1: 530, y1: 236, x2: 630, y2: 236 },
    ],
  },
  {
    id: 'gym',
    name: 'Hyperbolic Gym',
    blurb: 'Wide floor, one floating slab.',
    palette: 'forest',
    accent: '#2ecc71',
    horizon: 0.68,
    stars: 40,
    decor: 'gym',
    platforms: [
      { x1: 180, y1: 332, x2: 540, y2: 332, main: true },
      { x1: 320, y1: 216, x2: 460, y2: 216 },
    ],
  },
  {
    id: 'dojo',
    name: 'Meme Dojo',
    blurb: 'Stepped platforms and paper walls.',
    palette: 'candy',
    accent: '#ff85a1',
    horizon: 0.74,
    stars: 30,
    decor: 'dojo',
    platforms: [
      { x1: 160, y1: 330, x2: 560, y2: 330, main: true },
      { x1: 250, y1: 236, x2: 380, y2: 236 },
      { x1: 130, y1: 170, x2: 250, y2: 170 },
      { x1: 470, y1: 170, x2: 590, y2: 170 },
    ],
  },
];

const DEFAULT_STAGE = STAGES[0].id;

function rosterById(id) {
  return ROSTER.find((f) => f.id === id) || ROSTER[0];
}

function stageById(id) {
  return STAGES.find((s) => s.id === id) || STAGES[0];
}

function mainPlatform(platforms) {
  const list = platforms?.length ? platforms : STAGES[0].platforms;
  return list.find((p) => p.main) || list[0];
}

function clockText(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function blankInput() {
  return { left: false, right: false, up: false, down: false, fire: false };
}

/** A remembered counter: whole, non-negative and capped so memory cannot balloon. */
function memoryNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1000000, Math.floor(n));
}

/** The focused fighter's remembered record, in the shape the select screen draws. */
function fighterMemory(memory, fighterId) {
  const record = memory?.fighters && typeof memory.fighters === 'object' ? memory.fighters[fighterId] : null;
  return record && typeof record === 'object'
    ? { plays: memoryNumber(record.plays), wins: memoryNumber(record.wins), kos: memoryNumber(record.kos) }
    : { plays: 0, wins: 0, kos: 0 };
}

/**
 * What one finished match leaves in memory for the seat this account owns.
 * Totals are absolute (read previous, add this match) so a write is idempotent
 * once the match stamp is stored, and the roster's own fighter list keeps the
 * record from growing stale ids.
 */
function matchMemory(snapshot, previous, seatId) {
  if (!seatId) return null;
  const seat = (snapshot.players || []).find((p) => p.id === seatId);
  // Spectating, or a seat this device does not own: nothing to remember.
  if (!seat) return null;
  const before = previous && typeof previous === 'object' ? previous : {};
  const fighterId = snapshot.fighters?.[seatId]?.skin?.id || snapshot.picks?.[seatId] || before.pick || null;
  const won = (snapshot.winnerId || []).includes(seatId);
  const kos = memoryNumber(snapshot.kos?.[seatId]);
  const fighters = {};
  for (const fighter of ROSTER) {
    const old = fighterMemory(before, fighter.id);
    fighters[fighter.id] = { plays: old.plays, wins: old.wins, kos: old.kos };
  }
  if (fighters[fighterId]) {
    fighters[fighterId].plays += 1;
    fighters[fighterId].kos += kos;
    if (won) fighters[fighterId].wins += 1;
  }
  const streak = won ? memoryNumber(before.streak) + 1 : 0;
  // The table rules are *this* player's preference, so only their own choices
  // write them (see rememberChoice in render) - a match that ends must never
  // stamp somebody else's room rules over the loadout they picked.
  const keepStage = before.stage || snapshot.stage || DEFAULT_STAGE;
  const keepStocks = memoryNumber(before.stocks) || memoryNumber(snapshot.stocks) || 2;
  const keepTime = before.time === 0 ? 0 : memoryNumber(before.time) || (snapshot.limit === 0 ? 0 : memoryNumber(snapshot.limit) || 180);
  return {
    pick: fighterId,
    stage: keepStage,
    stocks: keepStocks,
    time: keepTime,
    played: memoryNumber(before.played) + 1,
    wins: memoryNumber(before.wins) + (won ? 1 : 0),
    losses: memoryNumber(before.losses) + (won ? 0 : 1),
    kos: memoryNumber(before.kos) + kos,
    streak,
    bestStreak: Math.max(memoryNumber(before.bestStreak), streak),
    fighters,
    lastMatch: snapshot.matchId || '',
    at: Date.now(),
  };
}

/** The seats still owed a pick, or (once everyone is in) everybody. */
function turnIds(state) {
  if (state.phase === 'select') {
    const waiting = state.players.filter((p) => !state.picks?.[p.id]).map((p) => p.id);
    return waiting.length ? waiting : state.players.map((p) => p.id);
  }
  return state.players.filter((p) => !state.out[p.id]).map((p) => p.id);
}

function seatIndex(state, id) {
  const at = state.players.findIndex((p) => p.id === id);
  return at < 0 ? 0 : at;
}

/** A free roster slot near `hint`, so bots never pick a fighter already taken. */
function freeFighterId(state, hint = 0) {
  const taken = new Set(Object.values(state.picks || {}));
  const start = ((Math.floor(hint) % ROSTER.length) + ROSTER.length) % ROSTER.length;
  for (let i = 0; i < ROSTER.length; i++) {
    const candidate = ROSTER[(start + i) % ROSTER.length];
    if (!taken.has(candidate.id)) return candidate.id;
  }
  return ROSTER[start].id;
}

function pickedBy(state, fighterId) {
  return Object.keys(state.picks || {}).find((id) => state.picks[id] === fighterId) || null;
}

/**
 * Lock a fighter in for one seat.  Returns false when the pick is not allowed
 * (already locked in, unknown fighter, or someone else has that fighter) - the
 * caller turns that into a warn event rather than a rejected action, so a bot
 * racing a human never looks like an illegal move.
 */
function pickFighter(state, id, fighterId, events) {
  if (state.phase !== 'select' || !id) return false;
  const seat = U.byId(state, id);
  if (!seat || state.picks[id]) return false;
  const fighter = ROSTER.find((f) => f.id === fighterId);
  if (!fighter) return false;
  const owner = pickedBy(state, fighter.id);
  if (owner && owner !== id) {
    events?.push(U.event(`${fighter.name} is already taken.`, 'warn'));
    return false;
  }
  state.picks[id] = fighter.id;
  const body = state.fighters[id];
  if (body) body.skin = { ...fighter };
  U.addLog(state, `${seat.name} locked in ${fighter.name} - ${fighter.special}!`, 'info');
  events?.push(U.event(`${seat.name} picked ${fighter.name}`, 'info'));
  return true;
}

/** Stock count, timer and stage: the bits of the match a seat may still change before the bell. */
function setRules(state, id, rules, events) {
  if (state.phase !== 'select' || !rules || typeof rules !== 'object') return false;
  const seat = U.byId(state, id);
  if (!seat) return false;
  let changed = false;
  if (rules.stocks !== undefined) {
    const value = Number(rules.stocks);
    if (STOCK_CHOICES.includes(value) && value !== state.stocks) {
      state.stocks = value;
      changed = true;
    }
  }
  if (rules.time !== undefined) {
    const value = Number(rules.time);
    if (TIME_CHOICES.includes(value) && value !== state.limit) {
      state.limit = value;
      changed = true;
    }
  }
  if (rules.stage !== undefined) {
    const stage = STAGES.find((s) => s.id === rules.stage);
    if (stage && stage.id !== state.stage) {
      state.stage = stage.id;
      state.platforms = stage.platforms;
      changed = true;
    }
  }
  if (rules.blast !== undefined) {
    const value = rules.blast ? 1 : 0;
    if (value !== (state.customBlast ? 1 : 0)) {
      state.customBlast = !!value;
      changed = true;
    }
  }
  if (!changed) return false;
  const stage = stageById(state.stage);
  U.addLog(state, `${seat.name} set the rules: ${state.stocks} stocks, ${state.limit > 0 ? `${state.limit}s timer` : 'no timer'}, ${stage.name}.`, 'info');
  events?.push(U.event(`${seat.name} changed the rules`, 'info'));
  return true;
}

/** The pre-match clock: bots pick on a stagger, stragglers are assigned, then the countdown. */
function selectStep(state, dt, events) {
  state.selectTime = (state.selectTime || 0) + dt;
  for (const p of state.players) {
    if (state.picks[p.id] || !p.bot) continue;
    if (state.selectTime >= 0.45 + seatIndex(state, p.id) * 0.5) {
      pickFighter(state, p.id, freeFighterId(state, seatIndex(state, p.id)), events);
    }
  }
  const waiting = state.players.filter((p) => !state.picks[p.id]);
  if (waiting.length && state.selectTime >= (state.selectLimit || SELECT_LIMIT)) {
    for (const p of waiting) pickFighter(state, p.id, freeFighterId(state, seatIndex(state, p.id)), events);
  }
  if (state.players.some((p) => !state.picks[p.id])) return;
  state.countdown = Math.max(0, (state.countdown || COUNTDOWN) - dt);
  if (state.countdown <= 0) startMatch(state, events);
}

/** Drop the chosen fighters onto the chosen stage and start the clock. */
function startMatch(state, events) {
  const stage = stageById(state.stage);
  state.phase = 'playing';
  state.time = 0;
  state.countdown = 0;
  state.summary = '';
  state.winnerId = null;
  state.out = {};
  for (const p of state.players) {
    const body = state.fighters[p.id];
    state.out[p.id] = false;
    if (!body) continue;
    if (state.picks[p.id]) body.skin = { ...rosterById(state.picks[p.id]) };
    const point = spawnPoint(state, seatIndex(state, p.id));
    body.x = point.x;
    body.y = point.y;
    body.vx = 0;
    body.vy = 0;
    body.percent = 0;
    body.stocks = state.stocks;
    body.facing = seatIndex(state, p.id) % 2 === 0 ? 1 : -1;
    body.onGround = false;
    body.jumps = 2;
    body.attack = 0;
    body.cooldown = 0;
    body.stun = 0;
    body.invuln = 1.6;
    body.respawn = 0;
    body.lastHitBy = null;
    state.kos[p.id] = 0;
  }
  U.addLog(state, `${state.stocks} stocks, ${state.limit > 0 ? `${state.limit}s timer` : 'no timer'}, ${stage.name} - fight!`, 'info');
  events?.push(U.event(`Fight! ${stage.name}.`, 'info'));
}

/** Spawn slots spread across the chosen stage's main deck. */
function spawnPoint(state, index) {
  const platforms = state.platforms?.length ? state.platforms : STAGES[0].platforms;
  const main = mainPlatform(platforms);
  const count = Math.max(1, state.players.length);
  const t = (index + 1) / (count + 1);
  return {
    x: main.x1 + (main.x2 - main.x1) * t,
    y: main.y1 - 90 - (index % 2) * 44,
  };
}

export const memesSmash = {
  meta: {
    id: 'memes-smash',
    name: 'MEME (Smash-style)',
    category: 'arcade',
    players: { min: 2, max: 4 },
    modes: MODES,
    realtime: true,
    simultaneous: true,
    blurb: 'Platform fighter with a character-select screen, anime fighters, six stages, stocks and a timer - it remembers your loadout and your record.',
    tags: ['fighter', 'flagship', 'custom-art'],
    minutes: 4,
    status: 'playable',
    bots: true,
    maxBots: 3,
    rules: [
      'Pick your fighter on the select screen - bots choose their own and show what they took.',
      'Punch up close with space, or fire a special blast with down. Higher damage means a longer flight.',
      'Knocked past the blast zone? That costs a stock, and losing them all puts you out.',
      'Last fighter with stocks wins; if the timer runs out, most stocks then least damage takes it.',
      'Your fighter, stage, stocks and timer are remembered - and so is your record with each fighter.',
    ],
    options: [
      { id: 'stocks', label: 'Stocks', type: 'select', values: STOCK_CHOICES, default: 2 },
      { id: 'time', label: 'Time (s)', type: 'select', values: TIME_CHOICES, default: 180 },
      { id: 'stage', label: 'Stage', type: 'select', values: STAGES.map((s) => s.id), default: DEFAULT_STAGE },
      { id: 'blast', label: 'Blast zones', type: 'select', values: [1, 0], default: 1 },
    ],
    // Handy for the client (and for docs): the roster and stages are plain data.
    roster: ROSTER.map((f) => ({ id: f.id, name: f.name, emoji: f.emoji, special: f.special })),
    stages: STAGES.map((s) => ({ id: s.id, name: s.name, blurb: s.blurb })),
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    const stockPick = Number(options.stocks);
    const timePick = Number(options.time);
    const stage = STAGES.find((s) => s.id === options.stage) || STAGES[0];
    state.phase = 'select';
    state.time = 0;
    state.inputs = {};
    state.stocks = STOCK_CHOICES.includes(stockPick) ? stockPick : 2;
    state.limit = Number.isFinite(timePick) && TIME_CHOICES.includes(timePick) ? timePick : 180;
    state.out = {};
    state.customBlast = options.blast !== 0;
    state.stage = stage.id;
    state.platforms = stage.platforms;
    state.picks = {};
    state.selectTime = 0;
    state.countdown = COUNTDOWN;
    state.selectLimit = SELECT_LIMIT;
    state.winnerId = null;
    state.summary = '';
    state.fighters = {};
    state.projectiles = [];
    state.hits = {};
    state.kos = {};
    // A stamp for this match: the client's memory uses it so a re-render (or a
    // second streaming client) can never book the same result twice.
    state.matchId = U.uid('sm');
    state.players.forEach((p, i) => {
      state.inputs[p.id] = blankInput();
      state.out[p.id] = false;
      state.hits[p.id] = 0;
      state.kos[p.id] = 0;
      const point = spawnPoint(state, i);
      state.fighters[p.id] = {
        x: point.x,
        y: point.y,
        vx: 0,
        vy: 0,
        percent: 0,
        stocks: state.stocks,
        facing: i % 2 === 0 ? 1 : -1,
        onGround: false,
        jumps: 2,
        attack: 0,
        cooldown: 0,
        stun: 0,
        invuln: 1.4,
        respawn: 0,
        // Who last sent this fighter flying: a knockout on the way out is
        // credited to them, and landing on a platform clears it.
        lastHitBy: null,
        // A default skin keeps every seat's entity drawable (and predictable)
        // before the select screen resolves; the pick overwrites it.
        skin: { ...ROSTER[i % ROSTER.length] },
      };
    });
    U.addLog(state, `Choose your fighter - ${state.stocks} stocks, ${state.limit > 0 ? `${state.limit}s` : 'no timer'}, ${stage.name}.`, 'info');
    return state;
  },
  step(state, dt) {
    if (state.phase !== 'playing') return;
    state.time += dt;
    for (const p of state.players) {
      const fighter = state.fighters[p.id];
      if (!fighter) continue;
      if (fighter.respawn > 0) {
        fighter.respawn -= dt;
        if (fighter.respawn <= 0) respawnFighter(state, p.id);
        continue;
      }
      if (p.bot) smashAi(state, p.id, dt);
      applyFighterInput(state, p.id, dt);
    }
    // projectiles
    for (const shot of state.projectiles) {
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      shot.life -= dt;
      shot.vy += 120 * dt;
      for (const p of state.players) {
        if (p.id === shot.owner) continue;
        const fighter = state.fighters[p.id];
        if (!fighter || fighter.respawn > 0 || fighter.invuln > 0) continue;
        if (Math.hypot(fighter.x - shot.x, fighter.y - shot.y) < 30) {
          hitFighter(state, p.id, shot.owner, 4, Math.sign(shot.vx) || fighter.facing * -1, 0.45);
          shot.dead = true;
          break;
        }
      }
    }
    state.projectiles = state.projectiles.filter((s) => !s.dead && s.life > 0 && s.x > -60 && s.x < W + 60 && s.y < H + 80);
    // knockouts
    const alive = state.players.filter((p) => state.fighters[p.id] && state.fighters[p.id].stocks > 0);
    for (const p of alive) {
      const fighter = state.fighters[p.id];
      if (fighter.respawn > 0) continue;
      if (fighter.x < -BLAST_X || fighter.x > W + BLAST_X || fighter.y > H + BLAST_Y || fighter.y < -BLAST_Y - 120) {
        fighter.stocks--;
        fighter.respawn = 1.2;
        // The knockout goes to whoever last launched them (never to themselves).
        const credit = fighter.lastHitBy;
        fighter.lastHitBy = null;
        if (credit && credit !== p.id && state.kos[credit] !== undefined) state.kos[credit] += 1;
        if (fighter.stocks <= 0) {
          state.out[p.id] = true;
          U.addLog(state, `${U.byId(state, p.id)?.name} is out of stocks!`, 'warn');
        } else {
          U.addLog(state, `${U.byId(state, p.id)?.name} loses a stock (${fighter.stocks} left).`, 'warn');
        }
      }
    }
    const remaining = state.players.filter((p) => !state.out[p.id]);
    const timedOut = state.limit > 0 && state.time > state.limit;
    if (remaining.length <= 1 || timedOut) {
      const ranked = (remaining.length ? remaining : state.players)
        .map((p) => ({ id: p.id, stocks: state.fighters[p.id]?.stocks || 0, percent: state.fighters[p.id]?.percent || 0, hits: state.hits[p.id] || 0 }))
        .sort((a, b) => b.stocks - a.stocks || a.percent - b.percent || b.hits - a.hits);
      const best = ranked[0];
      state.winnerId = ranked
        .filter((r) => r.stocks === best.stocks && r.percent === best.percent && r.hits === best.hits)
        .map((r) => r.id);
      state.summary = remaining.length <= 1
        ? `${U.byId(state, state.winnerId[0])?.name} wins the match!`
        : `Time! ${U.byId(state, state.winnerId[0])?.name} wins on stocks.`;
      for (const p of state.players) state.scores[p.id] = state.hits[p.id] || 0;
    }
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    if (action.type === 'input') {
      const seat = state.inputs[playerId];
      if (!seat) return { ok: false, error: 'Not in this match.' };
      for (const key of Object.keys(seat)) if (action[key] !== undefined) seat[key] = !!action[key];
      const events = [];
      if (state.phase === 'select') {
        if (action.pick !== undefined) pickFighter(state, playerId, action.pick, events);
        if (action.rules !== undefined) setRules(state, playerId, action.rules, events);
      }
      return { ok: true, events };
    }
    if (action.type === 'tick') {
      const events = [];
      const budget = U.clamp(Number(action.dt) || 1 / 30, SUBSTEP, 0.1);
      if (state.phase === 'select') {
        let remaining = budget;
        let guard = 0;
        while (remaining > 0 && state.phase === 'select' && guard++ < 64) {
          const slice = Math.min(SUBSTEP, remaining);
          selectStep(state, slice, events);
          remaining -= slice;
        }
        return { ok: true, events };
      }
      let remaining = budget;
      let guard = 0;
      while (remaining > 0 && !state.winnerId && guard++ < 64) {
        const slice = Math.min(SUBSTEP, remaining);
        this.step(state, slice);
        remaining -= slice;
      }
      if (state.winnerId && !state.summaryLogged) {
        state.summaryLogged = true;
        events.push(U.event(state.summary, 'win'));
      }
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, id) {
    if (state.winnerId) return null;
    if (state.phase === 'select') {
      if (!state.picks?.[id]) return { type: 'input', pick: freeFighterId(state, seatIndex(state, id)) };
      // Locked in: wait for the other seats, then run the countdown so the
      // match cannot sit on the select screen forever.
      if (state.players.some((p) => !state.picks[p.id])) return null;
      return { type: 'tick', dt: 0.1 };
    }
    return { type: 'tick', dt: 0.1 };
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.time = state.time || 0;
    v.fighters = state.fighters;
    v.projectiles = state.projectiles;
    v.platforms = state.platforms;
    v.stocks = state.stocks;
    v.limit = state.limit;
    v.out = state.out;
    v.hits = state.hits;
    v.kos = state.kos;
    v.matchId = state.matchId || '';
    v.viewerId = viewerId || null;
    v.stage = state.stage || DEFAULT_STAGE;
    v.picks = state.picks || {};
    v.selectTime = state.selectTime || 0;
    v.selectLimit = state.selectLimit || SELECT_LIMIT;
    v.countdown = state.countdown || 0;
    v.winnerId = state.winnerId || null;
    v.summary = state.summary || '';
    v.turn = turnIds(state);
    return v;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, state, playerId, send, host }) {
    // The local select cursor: which roster slot the pointer/arrow keys are on.
    // It never crosses the wire - only picks and rule changes do.
    const focus = { zone: 'roster', index: 0, cursor: 0 };
    // The per-account memory port, when the client offered one.  `seat` is the
    // seat this account owns, so only that seat's result is ever recorded.
    const memory = host?.memory && typeof host.memory.get === 'function' ? host.memory : null;
    const mine = memory?.seat || null;
    const booked = { matchId: null };
    /** Book one finished match once, however many times a snapshot is drawn. */
    const bookMatch = (snap) => {
      if (!memory || !mine || !snap || !Array.isArray(snap.winnerId) || !snap.winnerId.length) return;
      if (!snap.matchId || booked.matchId === snap.matchId) return;
      const previous = memory.get();
      if (previous && previous.lastMatch === snap.matchId) return;
      const record = matchMemory(snap, previous, mine);
      if (!record) return;
      booked.matchId = snap.matchId;
      memory.set(record);
    };
    const stage = UI.realtimeStage({
      el,
      snapshot: state || view,
      width: W,
      height: H,
      // Every snapshot the client draws passes through here, which is what makes
      // this the one place that can notice a match finishing - including on a
      // remote seat, whose DOM is built once and otherwise only repaints.
      draw: (ctx, w, h, snap) => {
        bookMatch(snap);
        drawSmash(ctx, w, h, snap, playerId, focus, memory);
      },
      hudText: (s) => smashHud(s),
    });
    const keys = blankInput();
    const { mode, cleanup } = UI.realtimeControls({ wrap: stage.wrap, host, state, playerId, keys, send });
    const selectState = () => state || view;
    // Picks and rule changes this seat makes are worth remembering right away
    // (they are the loadout the next match should open on); a hot-seat guest's
    // are not, so only the seat that owns the memory writes.
    const rememberChoice = (action) => {
      if (!memory || !mine || playerId !== mine) return;
      const previous = memory.get() || {};
      const patch = { ...previous };
      if (action.pick) patch.pick = action.pick;
      if (action.rules) for (const key of ['stage', 'stocks', 'time']) if (action.rules[key] !== undefined) patch[key] = action.rules[key];
      memory.set(patch);
    };
    const select = bindSelectScreen({
      box: stage.box,
      focus,
      viewerId: playerId,
      onAction: (action) => {
        send?.({ type: 'input', ...action });
        rememberChoice(action);
      },
      snapshot: selectState,
    });
    if (mode === 'local') {
      let ended = false;
      UI.every(stage.wrap, 33, () => {
        if (!state) return;
        const seat = state.players?.some((p) => p.id === playerId) ? playerId : state.players?.[0]?.id;
        if (state.winnerId) {
          if (!ended) {
            ended = true;
            host?.refresh?.();
          }
          return;
        }
        // One driver for both phases: tick() runs the select clock (picks,
        // bots, countdown) before the bell and the fight after it.
        memesSmash.act(state, seat, { type: 'tick', dt: 1 / 30 });
        stage.box.redraw();
      });
    }
    const hint = 'Click a fighter (or arrows + Enter) to lock in. In the fight: arrows / WASD move and jump, space punches, down fires.';
    stage.wrap.appendChild(UI.muted(UI.realtimeHint(mode, hint, 'Spectating the brawl...')));
    const teardown = () => {
      select.dispose();
      cleanup?.();
    };
    return UI.withLive(teardown, stage, { keys });
  },
};

function smashHud(s) {
  if (!s) return '';
  if (s.phase === 'select') {
    const players = s.players || [];
    const locked = players.filter((p) => s.picks?.[p.id]).length;
    if (locked >= players.length) return `All fighters locked in · FIGHT in ${Math.max(0, Math.ceil(s.countdown || 0))}`;
    const left = Math.max(0, Math.ceil((s.selectLimit || SELECT_LIMIT) - (s.selectTime || 0)));
    return `Choose your fighter · ${locked}/${players.length} locked in · auto-start in ${left}s`;
  }
  const limit = Number(s.limit) || 0;
  const clock = limit > 0 ? clockText(limit - (s.time || 0)) : `${clockText(s.time || 0)} ∞`;
  const parts = (s.players || []).map((p) => {
    const fighter = s.fighters?.[p.id];
    if (!fighter) return p.name;
    if (s.out?.[p.id]) return `${p.name} 💀`;
    const pips = '●'.repeat(Math.max(0, fighter.stocks || 0));
    return `${p.name} ${pips}${Math.round(fighter.percent)}%`;
  });
  return `⏱ ${clock} · ${parts.join(' · ')}`;
}

/* ------------------------------------------------------------------ *
 * Character-select screen (canvas)
 * ------------------------------------------------------------------ */

/**
 * Every rect on the select screen, in canvas units.  Drawing and hit-testing
 * both go through this, so a click always lands on what the player saw.
 */
function selectLayout() {
  const cols = 4;
  const cellW = 92;
  const cellH = 56;
  const gap = 8;
  const gridX = 24;
  const gridY = 56;
  const cells = ROSTER.map((fighter, i) => ({
    fighter,
    i,
    x: gridX + (i % cols) * (cellW + gap),
    y: gridY + Math.floor(i / cols) * (cellH + gap),
    w: cellW,
    h: cellH,
  }));
  const chipW = 105;
  const chipGap = 8;
  const stages = STAGES.map((s, i) => ({
    stage: s,
    i,
    x: gridX + i * (chipW + chipGap),
    y: 250,
    w: chipW,
    h: 48,
  }));
  const stocks = STOCK_CHOICES.map((value, i) => ({ value, i, x: 108 + i * 54, y: 306, w: 46, h: 26 }));
  const times = TIME_CHOICES.map((value, i) => ({ value, i, x: 108 + i * 66, y: 342, w: 58, h: 26 }));
  return {
    cells,
    stages,
    stocks,
    times,
    seats: { x: 436, y: 56, w: 260, gap: 8 },
    preview: { x: 380, y: 300, w: 316, h: 92 },
  };
}

/** Which piece of the select screen is under a canvas-space point. */
function selectTargetAt(x, y) {
  const L = selectLayout();
  const hit = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  for (const cell of L.cells) if (hit(cell)) return { zone: 'roster', index: cell.i };
  for (const chip of L.stages) if (hit(chip)) return { zone: 'stage', index: chip.i };
  for (const chip of L.stocks) if (hit(chip)) return { zone: 'stocks', index: chip.i };
  for (const chip of L.times) if (hit(chip)) return { zone: 'time', index: chip.i };
  return null;
}

/** The input action a focused/clicked control maps to, or null when it is a no-op. */
function selectAction(zone, index, snapshot, viewerId) {
  if (zone === 'roster') {
    const fighter = ROSTER[index];
    if (!fighter) return null;
    const taken = pickedBy(snapshot, fighter.id);
    if (taken && taken !== viewerId) return null;
    return { pick: fighter.id };
  }
  if (zone === 'stage') {
    const stage = STAGES[index];
    return stage ? { rules: { stage: stage.id } } : null;
  }
  if (zone === 'stocks') {
    return STOCK_CHOICES[index] === undefined ? null : { rules: { stocks: STOCK_CHOICES[index] } };
  }
  if (zone === 'time') {
    return TIME_CHOICES[index] === undefined ? null : { rules: { time: TIME_CHOICES[index] } };
  }
  return null;
}

/** Arrow-key navigation between the roster grid, the stage chips and the rule rows. */
function moveFocus(focus, key) {
  const cols = 4;
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  if (focus.zone === 'roster') {
    const row = Math.floor(focus.index / cols);
    if (key === 'left') focus.index = clamp(focus.index - 1, ROSTER.length - 1);
    else if (key === 'right') focus.index = clamp(focus.index + 1, ROSTER.length - 1);
    else if (key === 'up') {
      if (row === 0) focus.zone = 'stage';
      else focus.index = clamp(focus.index - cols, ROSTER.length - 1);
    } else if (key === 'down') {
      if (row >= Math.ceil(ROSTER.length / cols) - 1) focus.zone = 'stocks';
      else focus.index = clamp(focus.index + cols, ROSTER.length - 1);
    }
    focus.cursor = focus.index;
    return;
  }
  if (focus.zone === 'stage') {
    if (key === 'left') focus.index = clamp(focus.index - 1, STAGES.length - 1);
    else if (key === 'right') focus.index = clamp(focus.index + 1, STAGES.length - 1);
    else if (key === 'up') {
      focus.zone = 'roster';
      focus.index = clamp(focus.cursor, ROSTER.length - 1);
    } else if (key === 'down') {
      focus.zone = 'stocks';
      focus.index = 0;
    }
    return;
  }
  if (focus.zone === 'stocks') {
    if (key === 'left') focus.index = clamp(focus.index - 1, STOCK_CHOICES.length - 1);
    else if (key === 'right') focus.index = clamp(focus.index + 1, STOCK_CHOICES.length - 1);
    else if (key === 'up') focus.zone = 'stage';
    else if (key === 'down') {
      focus.zone = 'time';
      focus.index = 0;
    }
    return;
  }
  if (focus.zone === 'time') {
    if (key === 'left') focus.index = clamp(focus.index - 1, TIME_CHOICES.length - 1);
    else if (key === 'right') focus.index = clamp(focus.index + 1, TIME_CHOICES.length - 1);
    else if (key === 'up') {
      focus.zone = 'stocks';
      focus.index = 0;
    }
  }
}

/**
 * Wire the select screen to the pointer and the keyboard.  Only picks and rule
 * changes are sent; the cursor is purely local, so nothing here spams the room.
 */
function bindSelectScreen({ box, focus, viewerId, onAction, snapshot }) {
  const canvas = box.canvas || box.el;
  const active = () => (snapshot?.()?.phase || 'playing') === 'select';
  const toCanvas = (event) => {
    const rect = canvas.getBoundingClientRect?.();
    if (!rect || !rect.width || !rect.height) return null;
    return { x: ((event.clientX - rect.left) / rect.width) * W, y: ((event.clientY - rect.top) / rect.height) * H };
  };
  const onClick = (event) => {
    if (!active()) return;
    const point = toCanvas(event);
    if (!point) return;
    const target = selectTargetAt(point.x, point.y);
    if (!target) return;
    focus.zone = target.zone;
    focus.index = target.index;
    if (target.zone === 'roster') focus.cursor = target.index;
    const snap = snapshot?.() || {};
    const action = selectAction(target.zone, target.index, snap, viewerId);
    if (action) onAction?.(action);
  };
  const onMove = (event) => {
    if (!active()) return;
    const point = toCanvas(event);
    if (!point) return;
    const target = selectTargetAt(point.x, point.y);
    if (!target) return;
    if (target.zone === focus.zone && target.index === focus.index) return;
    focus.zone = target.zone;
    focus.index = target.index;
    if (target.zone === 'roster') focus.cursor = target.index;
  };
  const onKey = (event) => {
    if (!active()) return;
    const t = event.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down' };
    if (map[event.code]) {
      moveFocus(focus, map[event.code]);
      return;
    }
    if (event.code === 'Enter' || event.code === 'Space' || event.code === 'NumpadEnter') {
      const snap = snapshot?.() || {};
      const action = selectAction(focus.zone, focus.index, snap, viewerId);
      if (action) onAction?.(action);
    }
  };
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointermove', onMove);
  window.addEventListener('keydown', onKey);
  return {
    dispose() {
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey);
    },
  };
}

function drawSelectScreen(ctx, w, h, snapshot, viewerId, focus, memoryPort) {
  const L = selectLayout();
  const players = snapshot.players || [];
  const picks = snapshot.picks || {};
  // The account's permanent record for this game, when the client has one.
  const saved = memoryPort?.get?.() || null;
  const career = {
    played: memoryNumber(saved?.played),
    wins: memoryNumber(saved?.wins),
    losses: memoryNumber(saved?.losses),
    kos: memoryNumber(saved?.kos),
    streak: memoryNumber(saved?.streak),
    bestStreak: memoryNumber(saved?.bestStreak),
    pick: typeof saved?.pick === 'string' ? saved.pick : null,
  };
  const takenBy = {};
  for (const [id, fighterId] of Object.entries(picks)) takenBy[fighterId] = id;
  UI.arenaBackdrop(ctx, w, h, { palette: 'arcade', horizon: 0.88, stars: 40, grid: false });
  ctx.fillStyle = 'rgba(6,9,24,0.76)';
  ctx.fillRect(0, 0, w, h);

  // header
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.fillText('CHOOSE YOUR FIGHTER', 24, 34);
  ctx.textAlign = 'right';
  ctx.font = 'bold 13px system-ui, sans-serif';
  const locked = players.filter((p) => picks[p.id]).length;
  let status;
  if (players.length && locked >= players.length) status = `FIGHT IN ${Math.max(1, Math.ceil(snapshot.countdown || 0))}`;
  else status = `AUTO-START ${Math.max(0, Math.ceil((snapshot.selectLimit || SELECT_LIMIT) - (snapshot.selectTime || 0)))}s`;
  ctx.fillStyle = locked >= players.length ? '#4ade80' : '#94a3b8';
  ctx.fillText(status, 696, 34);
  // Career line: the record this account has built up with this game.
  ctx.textAlign = 'left';
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(148,163,184,0.95)';
  const careerLine = career.played
    ? `CAREER  ${career.played} match${career.played === 1 ? '' : 'es'} · ${career.wins}W-${career.losses}L · ${career.kos} KOs · best streak ${career.bestStreak}`
    : 'CAREER  first match with this arcade - your fighter, stage and rules are remembered from here on';
  ctx.fillText(careerLine, 24, 50);

  // roster grid
  for (const cell of L.cells) {
    const { fighter } = cell;
    const owner = takenBy[fighter.id];
    const mine = owner === viewerId;
    const focused = focus?.zone === 'roster' && focus.index === cell.i;
    const mineFighter = picks[viewerId] === fighter.id;
    ctx.save();
    const body = ctx.createLinearGradient(0, cell.y, 0, cell.y + cell.h);
    body.addColorStop(0, UI.withAlpha(UI.shadeColor(fighter.color, -0.25), owner ? 0.16 : 0.5));
    body.addColorStop(1, UI.withAlpha('#0b1120', 0.9));
    if (focused || mineFighter) {
      UI.withGlow(ctx, fighter.color, 14, () => {
        ctx.fillStyle = body;
        UI.roundRect(ctx, cell.x, cell.y, cell.w, cell.h, 9);
        ctx.fill();
      });
    } else {
      ctx.fillStyle = body;
      UI.roundRect(ctx, cell.x, cell.y, cell.w, cell.h, 9);
      ctx.fill();
    }
    // Colour bar down the left edge - and, once you have played them, a fill
    // that reads as a win rate for that fighter.
    const record = fighterMemory(saved, fighter.id);
    const ratio = record.plays ? record.wins / record.plays : 1;
    ctx.fillStyle = UI.withAlpha(fighter.color, record.plays ? 0.25 : 1);
    UI.roundRect(ctx, cell.x + 3, cell.y + 7, 4, cell.h - 14, 2);
    ctx.fill();
    if (record.plays) {
      const track = cell.h - 14;
      ctx.fillStyle = fighter.color;
      UI.roundRect(ctx, cell.x + 3, cell.y + 7 + track * (1 - ratio), 4, Math.max(3, track * ratio), 2);
      ctx.fill();
    }
    ctx.strokeStyle = focused ? '#f8fafc' : mineFighter ? fighter.color : 'rgba(148,163,184,0.45)';
    ctx.lineWidth = focused || mineFighter ? 2 : 1;
    UI.roundRect(ctx, cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1, 9);
    ctx.stroke();
    const dim = owner && !mine;
    ctx.globalAlpha = dim ? 0.42 : 1;
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(fighter.emoji, cell.x + 13, cell.y + 27);
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillText(fighter.name, cell.x + 13, cell.y + 44);
    ctx.globalAlpha = 1;
    if (owner) {
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillStyle = mine ? '#4ade80' : '#94a3b8';
      ctx.textAlign = 'right';
      ctx.fillText(mine ? 'YOU' : 'TAKEN', cell.x + cell.w - 7, cell.y + 14);
      ctx.textAlign = 'left';
    } else if (career.pick === fighter.id) {
      // Never let the player lose their fighter: the last one they locked in
      // wears a badge until somebody takes it.
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.fillStyle = UI.withAlpha(fighter.color, 0.95);
      ctx.textAlign = 'right';
      ctx.fillText('LAST', cell.x + cell.w - 7, cell.y + 14);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  // seat cards
  const n = Math.max(1, players.length);
  const twoCol = n > 4;
  const cardW = twoCol ? 124 : L.seats.w;
  const cardH = twoCol ? 40 : Math.min(42, Math.floor((186 - (n - 1) * 8) / n));
  players.forEach((p, i) => {
    const x = L.seats.x + (twoCol ? (i % 2) * (cardW + 8) : 0);
    const y = L.seats.y + (twoCol ? Math.floor(i / 2) : i) * (cardH + L.seats.gap);
    const pick = picks[p.id] ? rosterById(picks[p.id]) : null;
    const isMe = p.id === viewerId;
    ctx.save();
    ctx.fillStyle = 'rgba(9,13,30,0.72)';
    UI.roundRect(ctx, x, y, cardW, cardH, 9);
    ctx.fill();
    ctx.strokeStyle = isMe ? '#f8fafc' : 'rgba(148,163,184,0.4)';
    ctx.lineWidth = isMe ? 2 : 1;
    UI.roundRect(ctx, x + 0.5, y + 0.5, cardW - 1, cardH - 1, 9);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(pick ? pick.emoji : p.bot ? '🤖' : '❔', x + 8, y + cardH / 2 + 5);
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillStyle = pick ? pick.color : '#94a3b8';
    const label = String(p.name || 'Player').slice(0, twoCol ? 10 : 14);
    ctx.fillText(label, x + 32, y + cardH / 2 - 1);
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(pick ? `${pick.name} · ${pick.special}` : p.bot ? 'choosing…' : 'pick a fighter', x + 32, y + cardH / 2 + 11);
    ctx.restore();
  });

  // stage chips, each showing its platform layout
  for (const chip of L.stages) {
    const chosen = snapshot.stage === chip.stage.id;
    const focused = focus?.zone === 'stage' && focus.index === chip.i;
    ctx.save();
    ctx.fillStyle = chosen ? UI.withAlpha(chip.stage.accent, 0.26) : 'rgba(9,13,30,0.7)';
    UI.roundRect(ctx, chip.x, chip.y, chip.w, chip.h, 8);
    ctx.fill();
    ctx.strokeStyle = focused || chosen ? chip.stage.accent : 'rgba(148,163,184,0.35)';
    ctx.lineWidth = focused || chosen ? 2 : 1;
    UI.roundRect(ctx, chip.x + 0.5, chip.y + 0.5, chip.w - 1, chip.h - 1, 8);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillStyle = chosen ? '#f8fafc' : '#cbd5e1';
    ctx.fillText(chip.stage.name, chip.x + chip.w / 2, chip.y + 14);
    // miniature of the stage's decks
    const minis = chip.stage.platforms;
    ctx.fillStyle = UI.withAlpha(chip.stage.accent, chosen ? 0.95 : 0.6);
    const scaleX = (chip.w - 16) / W;
    const scaleY = 22 / H;
    for (const platform of minis) {
      const px = chip.x + 8 + platform.x1 * scaleX;
      const py = chip.y + 20 + platform.y1 * scaleY;
      const pw = Math.max(4, (platform.x2 - platform.x1) * scaleX);
      ctx.fillRect(px, py, pw, 3);
    }
    ctx.restore();
  }

  // rule rows
  const rowTag = (label, y) => {
    ctx.textAlign = 'left';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(label, 24, y);
  };
  rowTag('STOCKS', 323);
  rowTag('TIME', 359);
  const toggleChip = (rect, label, on, focused, tint) => {
    ctx.save();
    ctx.fillStyle = on ? UI.withAlpha(tint, 0.3) : 'rgba(9,13,30,0.7)';
    UI.roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 7);
    ctx.fill();
    ctx.strokeStyle = focused || on ? tint : 'rgba(148,163,184,0.35)';
    ctx.lineWidth = focused || on ? 2 : 1;
    UI.roundRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, 7);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = on ? '#f8fafc' : '#cbd5e1';
    ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 4);
    ctx.restore();
  };
  for (const chip of L.stocks) {
    toggleChip(chip, `${chip.value}`, snapshot.stocks === chip.value, focus?.zone === 'stocks' && focus.index === chip.i, '#facc15');
  }
  for (const chip of L.times) {
    toggleChip(chip, chip.value === 0 ? '∞' : `${chip.value}s`, snapshot.limit === chip.value, focus?.zone === 'time' && focus.index === chip.i, '#38bdf8');
  }

  // focused fighter preview
  const previewFighter = ROSTER[focus?.cursor ?? 0] || ROSTER[0];
  const P = L.preview;
  ctx.save();
  ctx.fillStyle = 'rgba(9,13,30,0.72)';
  UI.roundRect(ctx, P.x, P.y, P.w, P.h, 9);
  ctx.fill();
  ctx.strokeStyle = UI.withAlpha(previewFighter.color, 0.8);
  ctx.lineWidth = 2;
  UI.roundRect(ctx, P.x + 0.5, P.y + 0.5, P.w - 1, P.h - 1, 9);
  ctx.stroke();
  UI.withGlow(ctx, previewFighter.color, 16, () => {
    ctx.font = '34px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(previewFighter.emoji, P.x + 14, P.y + 48);
  });
  ctx.textAlign = 'left';
  ctx.font = 'bold 15px system-ui, sans-serif';
  ctx.fillStyle = previewFighter.color;
  ctx.fillText(previewFighter.name, P.x + 62, P.y + 24);
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(previewFighter.special, P.x + 62, P.y + 40);
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(previewFighter.role, P.x + 62, P.y + 52);
  // The career block: how this account has done overall, kept beside the pick.
  const CB = P.x + 186;
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(148,163,184,0.9)';
  ctx.fillText('CAREER', CB, P.y + 18);
  ctx.font = '10px system-ui, sans-serif';
  const careerLines = career.played
    ? [`${career.played} matches`, `${career.wins}W · ${career.losses}L`, `${career.kos} KOs`, `${career.streak} streak`]
    : ['no matches yet', '—', '0 KOs', '0 streak'];
  careerLines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? '#e2e8f0' : '#94a3b8';
    ctx.fillText(line, CB, P.y + 30 + i * 11);
  });
  const bars = [
    ['SPD', (previewFighter.speed - 0.85) / 0.35],
    ['PWR', (previewFighter.reach - 44) / 32],
    ['WGT', (previewFighter.weight - 0.85) / 0.35],
  ];
  bars.forEach(([label, value], i) => {
    const bx = P.x + 62;
    const by = P.y + 62 + i * 10;
    ctx.font = 'bold 8px system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(label, bx, by + 6);
    ctx.fillStyle = 'rgba(148,163,184,0.25)';
    UI.roundRect(ctx, bx + 26, by, 84, 6, 3);
    ctx.fill();
    ctx.fillStyle = previewFighter.color;
    UI.roundRect(ctx, bx + 26, by, Math.max(4, 84 * U.clamp(value, 0.08, 1)), 6, 3);
    ctx.fill();
  });
  // This fighter's own record, bottom right of the card.
  ctx.textAlign = 'right';
  ctx.font = '9px system-ui, sans-serif';
  const mineRecord = fighterMemory(saved, previewFighter.id);
  ctx.fillStyle = mineRecord.plays ? UI.withAlpha(previewFighter.color, 0.95) : '#64748b';
  ctx.fillText(
    mineRecord.plays ? `${mineRecord.plays}p · ${mineRecord.wins}w · ${mineRecord.kos} KO` : 'never fought with them',
    P.x + P.w - 12,
    P.y + P.h - 8,
  );
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(148,163,184,0.85)';
  ctx.fillText('Arrows move, Enter picks. Click a stage, a stock or a time chip - it is all remembered for next time.', 24, 410);
}

/* ------------------------------------------------------------------ *
 * Fight art
 * ------------------------------------------------------------------ */

/** Per-stage skyline/decor behind the arena floor. */
function drawStageDecor(ctx, w, h, stage, colors) {
  if (!stage) return;
  ctx.save();
  if (stage.decor === 'skyline') {
    ctx.fillStyle = UI.withAlpha(UI.shadeColor(colors[0], -0.55), 0.85);
    const towers = [[0, 118, 58], [66, 92, 46], [128, 150, 52], [192, 108, 40], [244, 166, 64], [320, 98, 46], [378, 140, 58], [452, 118, 44], [508, 176, 66], [588, 126, 50], [648, 108, 60]];
    for (const [x, top, wd] of towers) ctx.fillRect(x, top, wd, h - top);
  } else if (stage.decor === 'shrine') {
    ctx.fillStyle = UI.withAlpha(colors[1], 0.45);
    ctx.fillRect(w * 0.34, 150, 14, h - 150);
    ctx.fillRect(w * 0.62, 150, 14, h - 150);
    ctx.fillRect(w * 0.29, 136, w * 0.42, 15);
    ctx.fillRect(w * 0.32, 158, w * 0.36, 9);
  } else if (stage.decor === 'portal') {
    const glow = ctx.createRadialGradient(w / 2, 186, 12, w / 2, 186, 210);
    glow.addColorStop(0, UI.withAlpha(colors[2], 0.42));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(w / 2 - 210, 0, 420, 400);
    ctx.strokeStyle = UI.withAlpha(colors[2], 0.5);
    ctx.lineWidth = 2;
    for (const r of [118, 152]) {
      ctx.beginPath();
      ctx.arc(w / 2, 186, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (stage.decor === 'towers') {
    ctx.fillStyle = UI.withAlpha(UI.shadeColor(colors[0], -0.4), 0.9);
    ctx.fillRect(34, 116, 96, h - 116);
    ctx.fillRect(w - 130, 116, 96, h - 116);
    ctx.fillStyle = UI.withAlpha(colors[1], 0.35);
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(44, 132 + i * 34, 76, 3);
      ctx.fillRect(w - 120, 132 + i * 34, 76, 3);
    }
  } else if (stage.decor === 'gym') {
    ctx.strokeStyle = UI.withAlpha(colors[2], 0.3);
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      ctx.beginPath();
      ctx.moveTo((w * i) / 10, 0);
      ctx.lineTo((w * i) / 10, h * 0.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, (h * 0.8 * i) / 10);
      ctx.lineTo(w, (h * 0.8 * i) / 10);
      ctx.stroke();
    }
  } else if (stage.decor === 'dojo') {
    ctx.fillStyle = UI.withAlpha(colors[0], 0.5);
    ctx.fillRect(0, 96, w, h - 96);
    ctx.fillStyle = UI.withAlpha(colors[1], 0.4);
    for (const x of [110, 610]) {
      UI.withGlow(ctx, '#ffd6e0', 12, () => {
        ctx.beginPath();
        ctx.arc(x, 108, 14, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillRect(x - 1, 108, 3, 30);
    }
    ctx.fillStyle = UI.withAlpha(colors[2], 0.28);
    ctx.fillRect(24, 186, w - 48, 6);
  }
  ctx.restore();
}

function drawFight(ctx, w, h, snapshot, viewerId) {
  const stage = stageById(snapshot.stage);
  const colors = UI.arenaBackdrop(ctx, w, h, { palette: stage.palette, horizon: stage.horizon, stars: stage.stars });
  drawStageDecor(ctx, w, h, stage, colors);
  for (const platform of snapshot.platforms || []) {
    const pw = platform.x2 - platform.x1;
    ctx.save();
    // A drop shadow under the deck sells the height the fighters jump from.
    ctx.fillStyle = 'rgba(2,6,23,0.5)';
    UI.roundRect(ctx, platform.x1 + 3, platform.y1 + 6, pw, 14, 6);
    ctx.fill();
    const deck = ctx.createLinearGradient(0, platform.y1, 0, platform.y1 + 14);
    deck.addColorStop(0, platform.main ? '#64748b' : '#475569');
    deck.addColorStop(1, '#1e293b');
    UI.withGlow(ctx, stage.accent, 10, () => {
      ctx.fillStyle = deck;
      UI.roundRect(ctx, platform.x1, platform.y1, pw, 14, 6);
      ctx.fill();
    });
    ctx.fillStyle = 'rgba(186,220,255,0.55)';
    UI.roundRect(ctx, platform.x1 + 3, platform.y1 + 2, Math.max(0, pw - 6), 3, 2);
    ctx.fill();
    ctx.restore();
  }
  for (const shot of snapshot.projectiles || []) {
    const color = shot.color || '#facc15';
    UI.withGlow(ctx, color, 14, () => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(shot.x, shot.y, 8, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 12px system-ui, sans-serif';
  for (const p of snapshot.players || []) {
    const fighter = snapshot.fighters?.[p.id];
    if (!fighter || snapshot.out?.[p.id]) continue;
    if (fighter.respawn > 0) continue;
    const blink = fighter.invuln > 0 && Math.floor(fighter.invuln * 12) % 2 === 0;
    ctx.globalAlpha = blink ? 0.35 : 1;
    const skin = fighter.skin?.color || '#38bdf8';
    // Lit body with a darker rim: a flat silhouette read as a placeholder.
    UI.withGlow(ctx, skin, 14, () => {
      const body = ctx.createRadialGradient(fighter.x - 6, fighter.y - 8, 2, fighter.x, fighter.y, 22);
      body.addColorStop(0, UI.shadeColor(skin, 0.45));
      body.addColorStop(1, UI.shadeColor(skin, -0.2));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.ellipse(fighter.x, fighter.y, 17, 20, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.strokeStyle = UI.withAlpha(UI.shadeColor(skin, -0.45), 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(fighter.x, fighter.y, 17, 20, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(fighter.x + fighter.facing * 6, fighter.y - 6, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(fighter.skin?.emoji || '🥊', fighter.x, fighter.y + 5);
    ctx.textAlign = 'left';
    // Floating stock pips, so a life count reads off the fighter too.
    const stocks = Math.max(0, fighter.stocks || 0);
    ctx.fillStyle = skin;
    for (let i = 0; i < stocks; i++) {
      ctx.beginPath();
      ctx.arc(fighter.x - (stocks - 1) * 5 + i * 10, fighter.y - 46, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = damageColor(fighter.percent);
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(fighter.percent)}%`, fighter.x, fighter.y - 30);
    ctx.textAlign = 'left';
    if (p.id === viewerId) {
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(fighter.x, fighter.y, 21, 24, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  drawFightHud(ctx, w, h, snapshot, viewerId, stage);
}

function damageColor(percent) {
  const p = Number(percent) || 0;
  if (p < 60) return '#e2e8f0';
  if (p < 120) return '#fbbf24';
  if (p < 200) return '#fb923c';
  return '#f87171';
}

/** Timer, stage name and the per-seat stock/percent strip. */
function drawFightHud(ctx, w, h, snapshot, viewerId, stage) {
  const players = snapshot.players || [];
  const n = Math.max(1, players.length);
  const limit = Number(snapshot.limit) || 0;
  const left = limit > 0 ? Math.max(0, limit - (snapshot.time || 0)) : 0;
  const urgent = limit > 0 && left <= 20;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = 'bold 20px system-ui, sans-serif';
  const label = limit > 0 ? clockText(left) : `∞ ${clockText(snapshot.time || 0)}`;
  const pillW = ctx.measureText(label).width + 30;
  ctx.fillStyle = 'rgba(2,6,23,0.66)';
  UI.roundRect(ctx, w / 2 - pillW / 2, 6, pillW, 30, 9);
  ctx.fill();
  ctx.strokeStyle = urgent ? '#f87171' : UI.withAlpha(stage.accent, 0.7);
  ctx.lineWidth = urgent ? 2 : 1;
  UI.roundRect(ctx, w / 2 - pillW / 2 + 0.5, 6.5, pillW - 1, 29, 9);
  ctx.stroke();
  ctx.fillStyle = urgent ? '#fca5a5' : '#f8fafc';
  ctx.fillText(label, w / 2, 28);
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.fillStyle = UI.withAlpha(stage.accent, 0.95);
  ctx.fillText(stage.name.toUpperCase(), w / 2, 48);

  const chipW = (w - 16 - (n - 1) * 6) / n;
  players.forEach((p, i) => {
    const fighter = snapshot.fighters?.[p.id] || {};
    const skin = fighter.skin || {};
    const x = 8 + i * (chipW + 6);
    const y = h - 34;
    const color = skin.color || '#38bdf8';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(2,6,23,0.7)';
    UI.roundRect(ctx, x, y, chipW, 28, 8);
    ctx.fill();
    ctx.strokeStyle = snapshot.out?.[p.id] ? 'rgba(248,113,113,0.8)' : UI.withAlpha(color, 0.9);
    ctx.lineWidth = p.id === viewerId ? 2 : 1;
    UI.roundRect(ctx, x + 0.5, y + 0.5, chipW - 1, 27, 8);
    ctx.stroke();
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(snapshot.out?.[p.id] ? '💀' : skin.emoji || '🥊', x + 5, y + 19);
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillStyle = color;
    const name = String(p.name || 'Player');
    const maxChars = Math.max(4, Math.floor((chipW - 34) / 6));
    ctx.fillText(name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name, x + 24, y + 12);
    // stock pips + damage percent
    const stocks = Math.max(0, fighter.stocks || 0);
    ctx.fillStyle = color;
    for (let s = 0; s < stocks; s++) {
      ctx.beginPath();
      ctx.arc(x + 28 + s * 8, y + 21, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.textAlign = 'right';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = snapshot.out?.[p.id] ? '#f87171' : damageColor(fighter.percent);
    ctx.fillText(snapshot.out?.[p.id] ? 'OUT' : `${Math.round(fighter.percent || 0)}%`, x + chipW - 7, y + 19);
    ctx.textAlign = 'left';
  });

  if (snapshot.winnerId && snapshot.winnerId.length) {
    const winners = snapshot.winnerId.map((id) => snapshot.fighters?.[id]?.skin?.name || U.byId(snapshot, id)?.name || 'Winner');
    ctx.fillStyle = 'rgba(2,6,23,0.72)';
    ctx.fillRect(0, h / 2 - 48, w, 96);
    ctx.strokeStyle = UI.withAlpha(stage.accent, 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, h / 2 - 48);
    ctx.lineTo(w, h / 2 - 48);
    ctx.moveTo(0, h / 2 + 48);
    ctx.lineTo(w, h / 2 + 48);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(snapshot.summary || 'Match over', w / 2, h / 2 - 4);
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillStyle = stage.accent;
    const kos = memoryNumber(snapshot.kos?.[snapshot.winnerId[0]]);
    const hits = memoryNumber(snapshot.hits?.[snapshot.winnerId[0]]);
    ctx.fillText(`${winners.join(' · ')} — ${kos} KO${kos === 1 ? '' : 's'} · ${hits} hits`, w / 2, h / 2 + 22);
  }
  ctx.restore();
}

function drawSmash(ctx, w, h, snapshot, viewerId, focus, memoryPort) {
  if (!snapshot) return;
  if (snapshot.phase === 'select') {
    drawSelectScreen(ctx, w, h, snapshot, viewerId, focus, memoryPort);
    return;
  }
  drawFight(ctx, w, h, snapshot, viewerId);
}

/* ------------------------------------------------------------------ *
 * Fight rules
 * ------------------------------------------------------------------ */

function applyFighterInput(state, id, dt) {
  const fighter = state.fighters[id];
  const input = state.inputs[id] || blankInput();
  if (!fighter || fighter.respawn > 0) return;
  const skin = fighter.skin || {};
  const speed = skin.speed || 1;
  const reach = skin.reach || 56;
  fighter.invuln = Math.max(0, fighter.invuln - dt);
  fighter.stun = Math.max(0, fighter.stun - dt);
  fighter.attack = Math.max(0, fighter.attack - dt);
  fighter.cooldown = Math.max(0, fighter.cooldown - dt);
  if (fighter.stun > 0) {
    fighter.vx *= 1 - 0.6 * dt;
  } else {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir) {
      fighter.facing = dir;
      fighter.vx += dir * ACCEL * speed * dt * (fighter.onGround ? 1 : 0.75);
    } else if (fighter.onGround) {
      fighter.vx *= 1 - 8 * dt;
    } else {
      // Air drag stays light so launches actually carry people off stage.
      fighter.vx *= 1 - 0.45 * dt;
    }
    fighter.vx = U.clamp(fighter.vx, -MAX_HS * 1.6 * speed, MAX_HS * 1.6 * speed);
    if (input.up && fighter.jumps > 0 && !fighter.jumpHeld) {
      fighter.vy = JUMP;
      fighter.jumps--;
      fighter.onGround = false;
      fighter.jumpHeld = true;
    }
  }
  fighter.jumpHeld = !!input.up;
  if (input.fire && fighter.cooldown <= 0 && fighter.stun <= 0) {
    fighter.cooldown = 0.42;
    fighter.attack = 0.14;
    // Punches swing both ways: pick the closest fighter in range and face them.
    const victims = state.players
      .filter((p) => p.id !== id && !state.out[p.id] && state.fighters[p.id]?.respawn <= 0)
      .map((p) => ({ p, target: state.fighters[p.id] }))
      .filter(({ target }) => Math.abs(target.x - fighter.x) < reach && Math.abs(target.y - fighter.y) < 42)
      .sort((a, b) => Math.abs(a.target.x - fighter.x) - Math.abs(b.target.x - fighter.x));
    if (victims.length) {
      const target = victims[0].target;
      const dir = Math.sign(target.x - fighter.x) || fighter.facing;
      fighter.facing = dir;
      hitFighter(state, victims[0].p.id, id, 7, dir, 1);
    }
  }
  if (input.down && fighter.cooldown <= 0 && fighter.stun <= 0 && fighter.onGround) {
    fighter.cooldown = 1.1;
    state.projectiles.push({
      x: fighter.x + fighter.facing * 22,
      y: fighter.y - 6,
      vx: fighter.facing * 300 * (skin.shot || 1),
      vy: -20,
      owner: id,
      life: 1.8,
      color: fighter.skin?.color || '#facc15',
    });
  }
  // physics
  fighter.vy += GRAVITY * dt;
  fighter.x += fighter.vx * dt;
  fighter.y += fighter.vy * dt;
  const wasFalling = fighter.vy >= 0;
  fighter.onGround = false;
  for (const platform of state.platforms || []) {
    if (fighter.x < platform.x1 - 6 || fighter.x > platform.x2 + 6) continue;
    if (wasFalling && fighter.y >= platform.y1 - 18 && fighter.y <= platform.y1 + 14 && fighter.vy >= 0) {
      fighter.y = platform.y1 - 18;
      fighter.vy = 0;
      fighter.onGround = true;
      fighter.jumps = 2;
      // Back on solid ground: the exchange that launched them is over, so a
      // later fall off the stage is nobody's knockout.
      fighter.lastHitBy = null;
    }
  }
  if (fighter.onGround) fighter.jumps = 2;
}

function hitFighter(state, targetId, attackerId, damage, dir, scale) {
  const target = state.fighters[targetId];
  const attacker = state.fighters[attackerId];
  if (!target || target.invuln > 0) return;
  target.percent = Math.min(999, target.percent + damage);
  const weight = target.skin?.weight || 1;
  const knock = ((65 + target.percent * 2.4) * scale) / weight;
  target.vx = dir * knock * 0.75 + (attacker?.vx || 0) * 0.25;
  target.vy = -knock * 0.42;
  target.stun = 0.22;
  target.onGround = false;
  target.lastHitBy = attackerId;
  state.hits[attackerId] = (state.hits[attackerId] || 0) + 1;
  U.addScore(state, attackerId, 1);
}

function respawnFighter(state, id) {
  const fighter = state.fighters[id];
  if (!fighter || fighter.stocks <= 0) return;
  const point = spawnPoint(state, seatIndex(state, id));
  fighter.x = point.x;
  fighter.y = point.y - 60;
  fighter.vx = 0;
  fighter.vy = 0;
  fighter.percent = 0;
  fighter.invuln = 2;
  fighter.respawn = 0;
  fighter.onGround = false;
  fighter.jumps = 2;
  fighter.lastHitBy = null;
}

function smashAi(state, id, dt) {
  const me = state.fighters[id];
  if (!me || me.respawn > 0) return;
  const input = state.inputs[id];
  const level = U.byId(state, id)?.level ?? 2;
  const skill = U.botSkill(level);
  const platforms = state.platforms || [];
  const foes = state.players.filter((p) => p.id !== id && !state.out[p.id] && state.fighters[p.id]?.respawn <= 0);
  const recovering = me.y > 300 && !me.onGround;
  if (!foes.length) {
    input.left = input.right = input.up = input.fire = input.down = false;
    return;
  }
  const target = foes.sort((a, b) => Math.hypot(state.fighters[a.id].x - me.x, state.fighters[a.id].y - me.y) - Math.hypot(state.fighters[b.id].x - me.x, state.fighters[b.id].y - me.y))[0];
  const foe = state.fighters[target.id];
  const dx = foe.x - me.x;
  const dy = foe.y - me.y;
  const dist = Math.hypot(dx, dy);
  if (me.x < 130 || me.x > W - 130 || recovering) {
    // get back to the stage
    const home = U.clamp(me.x, 220, W - 220);
    input.left = me.x > home + 10;
    input.right = me.x < home - 10;
    input.up = me.jumps > 0 && (me.y > 260 || me.vy > 60);
    input.fire = false;
    input.down = false;
    return;
  }
  // Fighters end up on different platforms: walk off an edge to drop down, or
  // hop up when the target is above us.
  if (Math.abs(dy) > 56) {
    input.fire = false;
    input.down = false;
    if (dy > 56) {
      const plat = platforms.find((pl) => me.onGround && Math.abs(me.y - (pl.y1 - 18)) < 6 && me.x > pl.x1 - 16 && me.x < pl.x2 + 16);
      const leftEdge = plat ? plat.x1 - 40 : me.x;
      const rightEdge = plat ? plat.x2 + 40 : me.x;
      const goal = Math.abs(me.x - leftEdge) <= Math.abs(rightEdge - me.x) ? leftEdge : rightEdge;
      input.left = me.x > goal + 4;
      input.right = me.x < goal - 4;
      input.up = false;
    } else {
      input.left = dx < -8;
      input.right = dx > 8;
      input.up = me.jumps > 0 && Math.abs(dx) < 120 && Math.random() < 0.12 + skill * 0.1;
    }
    return;
  }
  const aim = dx + (Math.random() - 0.5) * (1 - skill) * 60;
  input.left = aim < -6;
  input.right = aim > 6;
  input.up = me.jumps > 1 && dy < -50 && Math.random() < 0.5 + skill * 0.3;
  input.fire = dist < (me.skin?.reach || 56) && Math.random() < 0.6 + skill * 0.35;
  input.down = me.onGround && dist > 220 && dist < 460 && Math.random() < 0.01 + skill * 0.02;
}

export default { memesSmash };
