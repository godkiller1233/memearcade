/**
 * Game room manager.
 *
 * Engines are the *same* ES modules the browser runs (web/games/engines/*.js),
 * so online play, local pass-and-play and solo-vs-bots all share one rule
 * implementation.  The server keeps authoritative state, hands each player a
 * secret-filtered `view()`, and drives bots and turn timers.
 *
 * Realtime engines (pong, mini golf, smash...) are host-authoritative: the
 * room host simulates the world, streams snapshots, and every other seat's
 * input is relayed to it so the host can simulate that player's controls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { db } from './lib/db.js';
import { code as makeCode, id as newId, now, rng } from './lib/ids.js';
import { recordGame, sanitizeText } from './store.js';
import { config, log } from './config.js';

export const engines = new Map();
export const engineErrors = [];

const SKIP_FILES = new Set(['index.js', 'util.js', 'ui.js', 'shared.js']);
const OPTIONAL = {};
/** Shortest gap between keyframe requests relayed from one realtime seat. */
const KEYFRAME_FLOOR_MS = 750;
/**
 * How long a realtime room waits on its host's stream before it says so.  A
 * hidden tab streams about once a second (browsers clamp its timers), so the
 * gap has to clear that cadence with room to spare before it counts as stalled.
 */
const STREAM_STALL_MS = 3500;

/** Load every engine module from disk. Safe to call more than once. */
export async function loadEngines() {
  const dir = path.join(config.webDir, 'games', 'engines');
  if (!fs.existsSync(dir)) {
    log('games: engine directory missing', dir);
    return engines;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !SKIP_FILES.has(f));
  for (const file of files) {
    const target = path.join(dir, file);
    try {
      const mod = await import(pathToFileURL(target).href);
      const list = [];
      if (mod.default?.meta) list.push(mod.default);
      for (const [key, value] of Object.entries(mod)) {
        if (key === 'default') continue;
        if (value && value.meta && typeof value.create === 'function') list.push(value);
      }
      for (const engine of list) engines.set(engine.meta.id, engine);
    } catch (err) {
      engineErrors.push({ file, error: err.message });
      log(`games: engine ${file} failed to load: ${err.message}`);
    }
  }
  log(`games: loaded ${engines.size} engines (${engineErrors.length} failed)`);
  return engines;
}

export function getEngine(id) {
  return engines.get(id) || null;
}

export function engineCatalog() {
  const out = [];
  for (const [id, e] of engines) {
    out.push({
      id,
      name: e.meta.name,
      category: e.meta.category,
      blurb: e.meta.blurb,
      players: e.meta.players,
      modes: e.meta.modes,
      tags: e.meta.tags || [],
      minutes: e.meta.minutes || 5,
      engine: true,
      realtime: !!e.meta.realtime,
      simultaneous: !!e.meta.simultaneous,
      secret: !!e.meta.secret,
    });
  }
  return out;
}

/**
 * A finished match as its engine wants it remembered (see `meta.review`).
 *
 * The hook is optional and engine-owned: chess returns colours, plies,
 * captures, the opening and the end reason, and a game without one simply keeps
 * the summary.  A broken hook must never cost the arcade a finished match, so
 * it is called defensively - the same trust level as the result itself, which
 * the host streams.
 */
function matchReview(room, result) {
  try {
    const hook = room.engine?.meta?.review;
    if (typeof hook !== 'function' || !room.state) return null;
    const review = hook(room.state, result);
    return review && typeof review === 'object' ? review : null;
  } catch (err) {
    log(`games: review() failed for ${room.gameId}:`, err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Seats
 * ------------------------------------------------------------------ */

const BOT_NAMES = [
  'RoboRita', 'Bytey', 'NullPointer', 'Glitchy', 'Sir Lagsalot', 'PixelPete',
  'MechaMango', 'Tofu', 'Clicky', 'VoidCat', 'BoltBrian', 'NoodleZilla',
];

export function makeBot(level = 2, name = null) {
  const idx = Math.floor(Math.random() * BOT_NAMES.length);
  return {
    id: `bot_${newId(5)}`,
    name: name || `${BOT_NAMES[idx]}`,
    kind: 'bot',
    avatar: '🤖',
    level: Math.max(0, Math.min(5, Number(level) || 2)),
    connected: true,
  };
}

/* ------------------------------------------------------------------ *
 * Rooms
 * ------------------------------------------------------------------ */

export class GameRooms {
  constructor({ hub = null } = {}) {
    this.rooms = new Map();
    this.hub = hub;
    this.timer = setInterval(() => this.tickAll(), 500);
    if (this.timer.unref) this.timer.unref();
    this.reaper = setInterval(() => this.reap(), 30000);
    if (this.reaper.unref) this.reaper.unref();
  }

  /* ---------------- creation ---------------- */

  createRoom({ gameId, host, partyId = null, visibility = 'public', options = {}, seed = null }) {
    const engine = getEngine(gameId);
    if (!engine) throw new Error(`Unknown game "${gameId}".`);
    const id = newId(9);
    const room = {
      id,
      code: makeCode(4),
      gameId,
      engine,
      host: host?.id || null,
      partyId,
      visibility,
      options,
      players: [],
      spectators: [],
      state: null,
      status: 'lobby',
      seed: seed ?? Math.floor(Math.random() * 1e9),
      createdAt: now(),
      updatedAt: now(),
      messages: [],
      deadline: 0,
      lastActivity: now(),
      botTimer: 0,
      result: null,
      snapshots: [],
      // Host stream health for the live-room warnings (see watchHostStream):
      // when the host's last snapshot landed, whether the room has already been
      // told the stream stalled, and whether the host reports a hidden tab.
      streamAt: 0,
      streamWarned: false,
      streamWarnedAt: 0,
      hostHidden: false,
      hostHiddenAt: 0,
    };
    this.rooms.set(id, room);
    if (host) this.addPlayer(room, host);
    this.publish(room);
    this.persist(room);
    return room;
  }

  getRoom(id) {
    return this.rooms.get(id) || null;
  }

  /* ---------------- membership ---------------- */

  addPlayer(room, user, { level = 2 } = {}) {
    const max = room.engine.meta.players.max + (room.engine.meta.maxBots || 0);
    if (room.players.length >= max) throw new Error('That room is full.');
    if (room.players.some((p) => p.id === user.id)) return room.players.find((p) => p.id === user.id);
    const seat = {
      id: user.id,
      name: user.name,
      avatar: user.avatar || '👾',
      kind: user.kind === 'bot' ? 'bot' : 'human',
      level,
      connected: true,
    };
    room.players.push(seat);
    if (!room.host) room.host = seat.id;
    if (room.status === 'playing') this.syncState(room);
    this.touch(room);
    return seat;
  }

  addBot(room, { level = 2, name = null, by = null } = {}) {
    const max = room.engine.meta.players.max + (room.engine.meta.maxBots || 0);
    if (room.players.length >= max) throw new Error('No free seats for a bot.');
    if (room.engine.meta.bots === false) throw new Error('This game does not support bots.');
    const bot = makeBot(level, name);
    room.players.push({ ...bot, connected: true });
    this.touch(room);
    return bot;
  }

  /**
   * Who hosts once `playerId` is gone: a connected human first, so a live match
   * never migrates to a seat that cannot stream, then any human, then any seat
   * at all.  `removePlayer` and the outage countdown both call this, so the
   * name the room is promised is the one it actually gets.
   */
  nextHost(room, playerId) {
    const others = room.players.filter((p) => p.id !== playerId);
    const humans = others.filter((p) => p.kind === 'human');
    return humans.find((p) => p.connected !== false) || humans[0] || others.find((p) => p.connected !== false) || others[0] || null;
  }

  removePlayer(room, playerId, { reason = 'left' } = {}) {
    const seat = room.players.find((p) => p.id === playerId);
    if (!seat) return { removed: false };
    room.players = room.players.filter((p) => p.id !== playerId);
    if (seat.kind === 'human') room.spectators = room.spectators.filter((s) => s.id !== playerId);
    const hostLeft = room.host === playerId;
    if (hostLeft) {
      // The wait is over: whoever is picked here hosts from now on, so any
      // outage countdown stops with the handover.
      room.hostOutageUntil = 0;
      room.host = this.nextHost(room, playerId)?.id || null;
    }
    this.systemMessage(room, `${seat.name} ${reason}.`);
    if (room.players.filter((p) => p.kind === 'human').length === 0) {
      this.close(room, 'empty');
      return { removed: true, closed: true };
    }
    if (room.status === 'playing' && room.engine.onLeave) {
      try {
        room.engine.onLeave(room.state, playerId);
      } catch (err) {
        log('engine onLeave failed:', err.message);
      }
    }
    if (hostLeft && room.host) {
      const next = room.players.find((p) => p.id === room.host);
      // A live realtime match is host-authoritative: the new host needs the
      // authoritative world before it starts streaming, exactly like a start.
      if (room.status === 'playing' && room.engine.meta.realtime && room.state) {
        this.hub?.sendToUser(room.host, { t: 'room:state', roomId: room.id, state: room.state });
      }
      if (next?.kind === 'human') this.systemMessage(room, `${next.name} is hosting now.`);
    }
    this.touch(room);
    return { removed: true };
  }

  /**
   * The pending host handover, for clients counting it down.  Set while a
   * dropped host still owns their seat through the grace window: the room names
   * who takes over and the moment the wait ends.  A room with no other human
   * left closes instead of migrating, so `nextName` is null then.
   */
  hostOutage(room) {
    if (!room.hostOutageUntil || !room.host) return null;
    const host = room.players.find((p) => p.id === room.host);
    const next = this.nextHost(room, room.host);
    const inheritor = next && next.kind === 'human' ? next : null;
    return {
      hostId: room.host,
      hostName: host?.name || null,
      nextId: inheritor?.id || null,
      nextName: inheritor?.name || null,
      until: room.hostOutageUntil,
    };
  }

  /**
   * What the room should say about its host's stream, or null when there is
   * nothing to say.  A host-authoritative match cannot advance without its
   * host, so a hidden tab or a stalled stream is room news, not a private
   * problem: it rides along in roomInfo and each client's banner reads it.
   */
  hostStreamInfo(room) {
    if (!room || room.status !== 'playing' || !room.engine?.meta?.realtime) return null;
    if (!room.hostHidden && !room.streamWarned) return null;
    const host = room.players.find((p) => p.id === room.host);
    return {
      hidden: !!room.hostHidden,
      stalled: !!room.streamWarned,
      hostName: host?.name || null,
      since: room.streamWarnedAt || room.hostHiddenAt || 0,
    };
  }

  /** The host's tab reported hiding or coming back; true when it changed. */
  noteHostVisibility(room, hidden) {
    const next = !!hidden;
    if (room.hostHidden === next) return false;
    room.hostHidden = next;
    room.hostHiddenAt = next ? now() : 0;
    return true;
  }

  /**
   * A host snapshot landed: the stream is healthy again.  If the room had been
   * told it stalled, it is told it recovered too - the roster banner clears on
   * either message, and the chat says why it went quiet.
   */
  noteHostSnapshot(room) {
    room.streamAt = now();
    if (!room.streamWarned) return;
    room.streamWarned = false;
    room.streamWarnedAt = 0;
    const host = room.players.find((p) => p.id === room.host);
    this.systemMessage(room, `▶️ ${host?.name || 'The host'}'s tab is streaming again.`);
    this.broadcast(room);
  }

  /**
   * The host stream watchdog, run from tickAll.  Nothing can stop a browser
   * from throttling a hidden tab's timers, so the room's job is to notice and
   * say so: the host is told to bring their tab back, and everyone else hears
   * why the match stopped moving instead of being left to guess.
   */
  watchHostStream(room, t = now()) {
    if (!room.engine?.meta?.realtime || !room.host || room.hostOutageUntil) return;
    if (!room.streamAt) {
      room.streamAt = t; // the match just started: the first snapshot is due
      return;
    }
    if (t - room.streamAt <= STREAM_STALL_MS || room.streamWarned) return;
    room.streamWarned = true;
    room.streamWarnedAt = t;
    const host = room.players.find((p) => p.id === room.host);
    const name = host?.name || 'The host';
    this.systemMessage(room, `⏳ ${name} stopped streaming — the match is waiting on their tab.`);
    if (host?.kind === 'human') {
      this.hub?.sendToUser(room.host, {
        t: 'notify',
        kind: 'host-stream',
        text: 'Your tab stopped streaming — the match is waiting on it. Bring this tab back to the foreground.',
        at: now(),
        roomId: room.id,
        code: room.code,
      });
    }
    this.broadcast(room);
  }

  addSpectator(room, user) {
    if (!room.spectators.some((s) => s.id === user.id)) {
      room.spectators.push({ id: user.id, name: user.name, avatar: user.avatar || '👀' });
      this.touch(room);
    }
    return true;
  }

  /* ---------------- start / finish ---------------- */

  canStart(room) {
    const meta = room.engine.meta;
    return room.players.length >= meta.players.min && room.players.length <= meta.players.max + (meta.maxBots || 0);
  }

  start(room) {
    const meta = room.engine.meta;
    if (!this.canStart(room)) {
      throw new Error(`Needs ${meta.players.min}-${meta.players.max} players (currently ${room.players.length}).`);
    }
    room.seed = (room.seed + 1) >>> 0;
    // The countdown is spent: the match is here, and a stale deadline must not
    // leak into a finished room's info.
    room.autoStartAt = 0;
    const state = room.engine.create({
      players: room.players.map((p) => ({ ...p })),
      options: room.options,
      rng: rng(room.seed),
      seed: room.seed,
      bots: room.players.filter((p) => p.kind === 'bot').length,
    });
    room.state = state;
    room.status = 'playing';
    room.result = null;
    room.startedAt = now();
    // The host stream watchdog starts here: if the host's first snapshot never
    // arrives, the room learns that within the stall window (see
    // watchHostStream) instead of waiting forever.
    room.streamAt = now();
    room.streamWarned = false;
    room.streamWarnedAt = 0;
    room.deadline = meta.turnMs ? now() + meta.turnMs : 0;
    this.systemMessage(room, `Game started: ${meta.name}`);
    // Realtime rooms are host-authoritative: the host needs the pristine
    // engine state, not just its filtered view, before it starts ticking.
    if (meta.realtime && room.host) {
      this.hub?.sendToUser(room.host, { t: 'room:state', roomId: room.id, state });
    }
    this.touch(room);
    this.maybeBots(room);
    return room;
  }

  finish(room, result) {
    if (room.status === 'finished') return;
    room.status = 'finished';
    room.result = result;
    room.finishedAt = now();
    const humans = room.players.filter((p) => p.kind === 'human');
    // The engine's own result carries the per-player points (see over()), and
    // its optional review carries what a replay would ask about - chess keeps
    // colours, plies, captures, the opening and how the game ended.
    recordGame(room.gameId, humans, {
      roomId: room.id,
      winners: result?.winners || [],
      scores: result?.scores,
      summary: result?.summary || null,
      review: matchReview(room, result),
    });
    const winners = (result?.winners || []).map((id) => room.players.find((p) => p.id === id)?.name).filter(Boolean);
    this.systemMessage(
      room,
      winners.length ? `🏆 ${winners.join(', ')} win${winners.length > 1 ? '' : 's'}!` : 'Game over - no winner.',
    );
    this.touch(room);
  }

  /**
   * The waiting-room countdown.
   *
   * A room starts itself only once it *can* start and at least one other seat
   * has turned up: a table sitting at one player is the dead air the nudge
   * buttons are for, not something to force into a solo match, and a game whose
   * minimum is one player still waits for company.  The state is recomputed on
   * every tick, so it needs no hook in every membership change - it arms the
   * moment the room is ready, disarms the moment it is not, and fires once.
   * Returns true when the countdown moved, so the tick can broadcast it.
   */
  syncCountdown(room) {
    const ready = room.status === 'lobby' && this.canStart(room) && room.players.length >= 2;
    if (!ready) {
      if (!room.autoStartAt) return false;
      room.autoStartAt = 0;
      return true;
    }
    if (!room.autoStartAt) {
      room.autoStartAt = now() + config.autoStartMs;
      return true;
    }
    return false;
  }

  /**
   * A seat or spectator whose interpolation buffer ran dry asks the host for an
   * immediate extra snapshot.  Read-only: the request never touches the match,
   * it is only relayed to the host, with a per-sender floor so a stalling
   * connection cannot pester it.  Watchers count too - they draw the same
   * stream, and asking for a frame cannot change the game.
   */
  requestKeyframe(room, playerId) {
    if (room.status !== 'playing' || !room.engine.meta.realtime || playerId === room.host) return { ok: true };
    const t = now();
    room.keyframeSeen ||= {};
    if (t - (room.keyframeSeen[playerId] || 0) < KEYFRAME_FLOOR_MS) return { ok: true };
    room.keyframeSeen[playerId] = t;
    // A watcher's request is not game activity: it must not keep the room warm.
    if (room.players.some((p) => p.id === playerId)) room.updatedAt = t;
    this.hub?.sendToUser(room.host, { t: 'room:request', roomId: room.id, from: playerId, kind: 'keyframe' });
    return { ok: true };
  }

  close(room, reason = 'closed') {
    room.status = 'closed';
    room.hostOutageUntil = 0;
    room.autoStartAt = 0;
    room.closedAt = now();
    room.closeReason = reason;
    this.rooms.delete(room.id);
    this.persist(room);
    this.emit(room, { t: 'room:closed', reason });
  }

  /* ---------------- actions ---------------- */

  act(room, playerId, action) {
    action = { ...(action || {}), type: sanitizeText(action?.type || '', 40) };
    // A spectator holds no seat and may not act - except for the read-only
    // keyframe request, which only asks the host for a fresh snapshot.
    if (action.type === 'keyframe' && !room.players.some((p) => p.id === playerId)) {
      return this.requestKeyframe(room, playerId);
    }
    if (!room.state) throw new Error('The game has not started yet.');
    const seat = room.players.find((p) => p.id === playerId);
    if (!seat) throw new Error('You are not seated in this room.');
    const engineMeta = room.engine.meta;
    if (room.status !== 'playing') {
      // Anything that races the final whistle (a keypress, the host's last
      // snapshot) is dropped quietly instead of popping an error mid-toast.
      if (engineMeta.realtime && (action.type === 'input' || action.type === 'keyframe' || action.snapshot !== undefined)) return { ok: true };
      throw new Error('That game is already over.');
    }
    if (engineMeta.realtime) {
      // Host-authoritative: the host streams snapshots; everyone else may only
      // contribute input, which the host simulates.
      if (action.snapshot !== undefined) {
        if (playerId !== room.host) throw new Error('Only the room host streams realtime state.');
        room.state = action.snapshot ?? room.state;
        room.updatedAt = now();
        room.lastActivity = now();
        // The stream is the room's heartbeat: a snapshot clears any stall.
        this.noteHostSnapshot(room);
        // Everyone but the host: it just sent this snapshot.
        this.emit(room, { t: 'tick', snapshot: room.state }, { except: [playerId] });
        // A streamed snapshot can be a finished match - close the room for it.
        if (room.engine.over) {
          try {
            const result = room.engine.over(room.state);
            if (result?.over) this.finish(room, result);
          } catch (err) {
            log(`games: over() failed for ${room.gameId}:`, err.message);
          }
        }
        return { ok: true };
      }
      if (action.type === 'input' && playerId !== room.host) {
        // Inputs are simulated by the host: relay the action to it instead of
        // mutating the server's copy of the world.  A light per-seat floor on
        // the interval keeps a spammy client from flooding the host, but only
        // repeated *unchanged* input is coalesced: the same channel carries the
        // discrete choices a realtime game asks for (smash's fighter, stage,
        // stocks), and a floor would swallow them for good - a remote seat
        // tapping pick -> stage -> stocks loses the taps that arrive inside the
        // window, with nothing on screen to say so.
        const t = now();
        const stamp = JSON.stringify(action);
        room.inputSeen ||= {};
        room.lastInput ||= {};
        if (stamp === room.lastInput[playerId] && t - (room.inputSeen[playerId] || 0) < 20) return { ok: true };
        room.inputSeen[playerId] = t;
        room.lastInput[playerId] = stamp;
        room.updatedAt = t;
        room.lastActivity = t;
        this.hub?.sendToUser(room.host, { t: 'room:input', roomId: room.id, from: playerId, action });
        return { ok: true };
      }
      if (action.type === 'keyframe') return this.requestKeyframe(room, playerId);
      const res = room.engine.act(room.state, playerId, action) || { ok: true };
      room.updatedAt = now();
      if (res.events?.length) for (const ev of res.events) if (ev.text) this.systemMessage(room, ev.text);
      this.touch(room);
      return res;
    }
    const res = room.engine.act(room.state, playerId, action) || { ok: true };
    if (res.ok === false) return res;
    room.lastActivity = now();
    if (engineMeta.turnMs) {
      const turn = room.engine.view(room.state, playerId)?.turn || [];
      room.deadline = turn.length ? now() + engineMeta.turnMs : 0;
    }
    if (res.events?.length) {
      for (const ev of res.events) if (ev.text) this.systemMessage(room, ev.text);
    }
    this.checkEnd(room);
    this.touch(room);
    this.maybeBots(room);
    return res;
  }

  checkEnd(room) {
    if (!room.engine.over) return false;
    const result = room.engine.over(room.state);
    if (result?.over) {
      this.finish(room, result);
      return true;
    }
    return false;
  }

  /* ---------------- bots + timers ---------------- */

  maybeBots(room) {
    if (room.status !== 'playing' || !room.engine.bot) return;
    if (room.engine.meta.realtime) return;
    if (room.botTimer) return;
    const run = () => {
      room.botTimer = 0;
      if (room.status !== 'playing') return;
      try {
        const view = room.engine.view(room.state, room.host || room.players[0]?.id);
        const turn = view?.turn || [];
        // Try every bot in turn until one has a legal action: in party games
        // several seats act at once and one bot may be waiting on the others.
        let acted = false;
        for (const actorId of turn) {
          const seat = room.players.find((p) => p.id === actorId);
          if (seat?.kind !== 'bot') continue;
          const action = room.engine.bot(room.state, actorId);
          if (!action) continue;
          const res = room.engine.act(room.state, actorId, action);
          if (res?.ok === false) continue;
          if (res?.events?.length) for (const ev of res.events) if (ev.text) this.systemMessage(room, ev.text);
          acted = true;
          break;
        }
        if (!acted) return;
        this.checkEnd(room);
        this.touch(room);
        if (room.status === 'playing') room.botTimer = setTimeout(run, 420 + Math.random() * 420);
        if (room.botTimer?.unref) room.botTimer.unref();
      } catch (err) {
        log(`games: bot move failed in ${room.gameId}:`, err.message);
      }
    };
    room.botTimer = setTimeout(run, 420);
    if (room.botTimer.unref) room.botTimer.unref();
  }

  tickAll() {
    const t = now();
    for (const room of this.rooms.values()) {
      if (room.status === 'lobby') {
        // Arm/disarm the countdown, then let a ready room start itself.  A room
        // nobody is using any more is closed here too - the countdown must not
        // keep an abandoned table alive forever.
        if (this.syncCountdown(room)) this.touch(room);
        if (room.autoStartAt && t >= room.autoStartAt && this.canStart(room)) {
          try {
            this.start(room);
          } catch (err) {
            log(`games: autostart failed for ${room.gameId}:`, err.message);
          }
        }
        if (t - room.lastActivity > 1000 * 60 * 45) this.close(room, 'idle');
        continue;
      }
      if (room.status !== 'playing') continue;
      // A realtime room lives on its host's tab: watch that the stream is alive.
      this.watchHostStream(room, t);
      if (room.deadline && t > room.deadline) {
        const view = room.engine.view(room.state, room.host || room.players[0]?.id);
        const turn = view?.turn || [];
        for (const actorId of turn) {
          const seat = room.players.find((p) => p.id === actorId);
          if (seat?.kind !== 'human') continue;
          try {
            const timeoutAction = room.engine.timeout ? room.engine.timeout(room.state, actorId) : null;
            if (timeoutAction) {
              const res = room.engine.act(room.state, actorId, timeoutAction);
              if (res?.events?.length) for (const ev of res.events) if (ev.text) this.systemMessage(room, ev.text);
            } else if (room.engine.meta && room.engine.meta.skipOnTimeout) {
              room.engine.act(room.state, actorId, { type: 'skip' });
            }
          } catch (err) {
            log('games: timeout action failed:', err.message);
          }
        }
        room.deadline = room.engine.meta.turnMs ? now() + room.engine.meta.turnMs : 0;
        this.checkEnd(room);
        this.touch(room);
        this.maybeBots(room);
      }
      if (t - room.lastActivity > 1000 * 60 * 45 && room.status === 'lobby') this.close(room, 'idle');
    }
  }

  reap() {
    const t = now();
    for (const room of this.rooms.values()) {
      const idle = t - room.lastActivity;
      if (room.status === 'finished' && idle > 1000 * 60 * 20) this.close(room, 'expired');
      else if (room.status === 'lobby' && idle > 1000 * 60 * 90) this.close(room, 'idle');
    }
    for (const [id, rec] of Object.entries(db.data.rooms)) {
      if (rec.status !== 'closed' && !this.rooms.has(id) && now() - (rec.updatedAt || 0) > 1000 * 60 * 60 * 6) {
        rec.status = 'closed';
      }
    }
    db.touch();
  }

  /* ---------------- views / messaging ---------------- */

  view(room, viewerId, { withSecrets = false } = {}) {
    if (!room.state) {
      return {
        status: room.status,
        phase: 'lobby',
        players: room.players,
        options: room.options,
        turn: [],
        lobby: true,
      };
    }
    let view;
    try {
      view = room.engine.view(room.state, withSecrets ? room.host || viewerId : viewerId);
    } catch (err) {
      log(`games: view failed for ${room.gameId}:`, err.message);
      view = { error: 'view-failed' };
    }
    if (view && typeof view === 'object') {
      view.status = room.status;
      view.players = room.players;
      view.spectators = room.spectators.map((s) => ({ id: s.id, name: s.name }));
      if (room.deadline) view.deadline = room.deadline;
      if (room.result) view.result = room.result;
    }
    return view;
  }

  roomInfo(room) {
    return {
      id: room.id,
      code: room.code,
      gameId: room.gameId,
      game: room.engine.meta,
      host: room.host,
      partyId: room.partyId,
      visibility: room.visibility,
      status: room.status,
      // `connected` rides along so the room UI can grey a seat out while its
      // socket is gone (the grace window keeps the seat, not the connection).
      players: room.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, kind: p.kind, level: p.level, connected: p.connected !== false })),
      hostOutage: this.hostOutage(room),
      hostStream: this.hostStreamInfo(room),
      spectators: room.spectators.length,
      options: room.options,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      canStart: this.canStart(room),
      realtime: !!room.engine.meta.realtime,
      // When the room will start itself (0 = not counting down) and how long
      // the whole countdown is, so a late-joining client can draw the same bar.
      autoStartAt: room.autoStartAt || 0,
      autoStartMs: config.autoStartMs,
    };
  }

  systemMessage(room, text) {
    const msg = { id: newId(5), kind: 'system', text: sanitizeText(text, 200), at: now() };
    room.messages.push(msg);
    if (room.messages.length > 150) room.messages.splice(0, room.messages.length - 150);
    this.emit(room, { t: 'chat', scope: `room:${room.id}`, message: msg });
    return msg;
  }

  chat(room, user, text) {
    const msg = { id: newId(5), kind: 'chat', from: user.id, name: user.name, avatar: user.avatar, text: sanitizeText(text), at: now() };
    room.messages.push(msg);
    if (room.messages.length > 150) room.messages.splice(0, room.messages.length - 150);
    room.lastActivity = now();
    this.emit(room, { t: 'chat', scope: `room:${room.id}`, message: msg });
    return msg;
  }

  touch(room) {
    room.updatedAt = now();
    room.lastActivity = now();
    this.publish(room);
    this.broadcast(room);
  }

  /** Send each member their own secret-filtered view. */
  broadcast(room) {
    if (!this.hub) return;
    for (const seat of room.players) {
      if (seat.kind === 'bot') continue;
      this.hub.sendToUser(seat.id, {
        t: 'game',
        room: this.roomInfo(room),
        view: this.view(room, seat.id),
        messages: room.messages.slice(-40),
      });
    }
    for (const spec of room.spectators) {
      this.hub.sendToUser(spec.id, {
        t: 'game',
        room: this.roomInfo(room),
        view: this.view(room, `spectator:${spec.id}`),
        messages: room.messages.slice(-40),
        spectating: true,
      });
    }
    this.hub.broadcastLobby();
  }

  emit(room, message, { except = [] } = {}) {
    if (!this.hub) return;
    const recipients = [
      ...room.players.filter((p) => p.kind === 'human' && !except.includes(p.id)).map((p) => p.id),
      ...room.spectators.map((s) => s.id),
    ];
    if (recipients.length) this.hub.sendToUsers(recipients, { ...message, roomId: room.id });
  }

  publish(room) {
    const rec = db.data.rooms[room.id] || {};
    db.data.rooms[room.id] = {
      ...rec,
      id: room.id,
      code: room.code,
      gameId: room.gameId,
      host: room.host,
      partyId: room.partyId,
      visibility: room.visibility,
      status: room.status,
      playerCount: room.players.length,
      spectatorCount: room.spectators.length,
      players: room.players.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      options: room.options,
      createdAt: room.createdAt,
      // A finished match keeps its verdict in the snapshot as well as the audit:
      // room snapshots are the long-lived half of the history (the audit is a
      // rotating window), so "every match of this game" can be answered after
      // the audit has rolled over.  `result` stays null until the game ends.
      startedAt: room.startedAt || null,
      finishedAt: room.finishedAt || null,
      result: room.finishedAt && room.result
        ? {
          at: room.finishedAt,
          winners: (room.result.winners || []).slice(),
          summary: String(room.result.summary || '').slice(0, 200),
        }
        : null,
      updatedAt: room.updatedAt,
    };
    db.touch();
  }

  persist(room) {
    this.publish(room);
    db.flush();
  }

  lobbyList({ gameId = null, includePrivate = false } = {}) {
    const out = [];
    for (const room of this.rooms.values()) {
      if (room.status === 'closed') continue;
      if (gameId && room.gameId !== gameId) continue;
      if (!includePrivate && room.visibility !== 'public') continue;
      out.push(this.roomInfo(room));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 80);
  }

  stats() {
    const byGame = {};
    for (const room of this.rooms.values()) byGame[room.gameId] = (byGame[room.gameId] || 0) + 1;
    return { rooms: this.rooms.size, players: [...this.rooms.values()].reduce((n, r) => n + r.players.length, 0), byGame };
  }
}
