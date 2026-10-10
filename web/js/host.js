/**
 * Game hosts.
 *
 * The same engine module runs in three places:
 *   solo   - you vs bots, entirely in the browser
 *   local  - hot-seat, several humans sharing this device
 *   online - the server owns state and streams per-player views
 *
 * A host exposes the small contract engines' render() expects:
 *   { role, uiState, refresh(), send(action), players, isHost, memory }
 *
 * `memory` is the optional per-game memory port: { seat, get(), set(memory) }.
 * An engine that should remember something between matches writes through it in
 * its client-side code only - the authoritative server state stays pure (see
 * gameMemoryPort in main.js and the games' own memory helpers).
 */
import * as UI from '../games/engines/ui.js';
import { SnapshotBuffer, Predictor, patchLocalSeat, netHudText, StreamClock, KeyframeGate, LinkSignal, scheduleFrame, cancelFrame } from './netcode.js';
import { state as appState } from './store.js';
import { toast } from './dom.js';
import { rt, gameAction, netStats } from './realtime.js';
import { sfx } from './audio.js';

const BOT_NAMES = ['RoboRita', 'Bytey', 'NullPointer', 'Glitchy', 'Sir Lagsalot', 'PixelPete', 'MechaMango', 'Tofu', 'Clicky', 'VoidCat'];

/** A stored counter that may be missing or junk, read as a number. */
function memoryNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** How long an unfinished solo run waits before it is written to memory. */
const PROGRESS_SAVE_MS = 12000;

/**
 * How much real time one stream wake may make up while the host tab is hidden.
 * Hidden tabs get their timers clamped to about once a second, so the normal
 * 200ms bank (right for a 60Hz-visible tab) would run the world at a fifth of
 * real speed; this keeps it in step with the wall clock at that coarse cadence.
 * A tab throttled to a wake a minute still crawls, but the room is told why.
 */
const BACKGROUND_CATCHUP_MS = 5000;

/** Seconds as a clock the record line can show: 95 -> "1:35". */
export function clockText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const rest = total % 60;
  return mins ? `${mins}:${String(rest).padStart(2, '0')}` : `${rest}s`;
}

/** A game's own label for a saved run, never allowed to break the save. */
function progressLabel(spec, view, state, seatId) {
  try {
    return String(spec.progress?.(view, state, seatId) ?? '').slice(0, 80);
  } catch {
    return '';
  }
}

/** JSON a game state, or null when it cannot be one (a function slipped in). */
function safeJson(value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}

export function botSeat(index, level = 2, name = null) {
  return {
    id: `bot${index}`,
    name: name || BOT_NAMES[index % BOT_NAMES.length],
    avatar: '🤖',
    kind: 'bot',
    level,
  };
}

/* ------------------------------------------------------------------ *
 * Local host (solo + hot-seat)
 * ------------------------------------------------------------------ */

export class LocalHost {
  constructor({ engine, mount, seats, options = {}, role = 'solo', onEvent = null, memory = null, resume = null }) {
    this.engine = engine;
    this.mount = mount;
    this.role = role; // 'solo' | 'local'
    this.uiState = {};
    this.onEvent = onEvent;
    this.memory = memory;
    this.seats = seats;
    // A run picked back up from memory (see record.resume in the engines): its
    // saved state replaces a fresh create(), and the clock starts again from
    // now - time spent away from the game is not time on the clock.
    this.resume = resume && typeof resume === 'object' && resume.state ? resume : null;
    this.state = this.resume
      ? this.resume.state
      : engine.create({
        players: seats,
        options,
        rng: Math.random,
        seed: Math.floor(Math.random() * 1e9),
        bots: seats.filter((s) => s.kind === 'bot').length,
      });
    this.manualSeat = null;
    this.botTimer = null;
    this.progressTimer = null;
    this.lastProgressJson = null;
    this.disposed = false;
    this.finished = false;
    this.startedAt = Date.now();
    // One run books once, however many sessions it spans: a resumed run keeps
    // the identity it was saved with.
    this.runId = this.resume?.runId || `${this.state?.seed ?? 'x'}-${this.startedAt}`;
    if (this.resume) this.lastProgressJson = safeJson(this.state);
  }

  /** Which seat is acting on this device right now. */
  activeSeat() {
    if (this.manualSeat) return this.manualSeat;
    // Ask the engine directly - view() resolves its seat through activeSeat(),
    // so calling view() here would recurse forever.
    const view = this.rawView(this.seats[0]?.id);
    const turn = view?.turn || [];
    const human = this.seats.find((s) => s.kind !== 'bot' && turn.includes(s.id));
    if (human) return human.id;
    return this.seats.find((s) => s.kind !== 'bot')?.id || this.seats[0].id;
  }

  /** Seats that are humans (for the pass-the-device switcher). */
  get humanSeats() {
    return this.seats.filter((s) => s.kind !== 'bot');
  }

  view(seatId = null) {
    return this.rawView(seatId || this.activeSeat());
  }

  /** engine.view() without any seat guessing - safe to call from anywhere. */
  rawView(seatId = null) {
    try {
      return this.engine.view(this.state, seatId);
    } catch (err) {
      console.error('engine view failed', err);
      return { turn: [], players: this.seats, scores: {}, log: [] };
    }
  }

  get players() {
    return this.seats;
  }

  send(action) {
    const seat = this.activeSeat();
    const res = this.engine.act(this.state, seat, action);
    if (res && res.ok === false) {
      toast(res.error || 'That move is not allowed.', 'bad', 2500);
      sfx('error');
      return false;
    }
    if (res?.events?.length) {
      for (const ev of res.events) this.onEvent?.(ev);
      const win = res.events.find((e) => e.kind === 'win');
      sfx(win ? 'correct' : 'click');
    }
    this.manualSeat = null;
    this.render();
    this.scheduleBots();
    return true;
  }

  scheduleBots() {
    clearTimeout(this.botTimer);
    if (this.disposed) return;
    const done = this.engine.over(this.state);
    if (done?.over) return this.finish(done);
    const view = this.view();
    const turn = view?.turn || [];
    const botId = turn.find((id) => this.seats.find((s) => s.id === id)?.kind === 'bot');
    if (!botId) return;
    this.botTimer = setTimeout(() => {
      if (this.disposed) return;
      const action = this.engine.bot(this.state, botId);
      if (!action) {
        this.scheduleBots();
        return;
      }
      const res = this.engine.act(this.state, botId, action);
      if (res?.events?.length) for (const ev of res.events) if (ev.text) this.onEvent?.(ev);
      this.render();
      this.scheduleBots();
    }, 420 + Math.random() * 380);
  }

  finish(done) {
    if (this.finished) return;
    this.finished = true;
    this.result = done;
    clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const winners = (done.winners || []).map((id) => this.seats.find((s) => s.id === id)?.name).filter(Boolean);
    sfx(winners.length ? 'win' : 'lose');
    // Book the record first so the news can carry it.
    const booked = this.bookRun(done);
    const note = booked?.notes?.length ? ` · ${booked.notes[0]}` : '';
    this.onEvent?.({ text: `${done.summary || (winners.length ? `${winners.join(' & ')} win!` : 'Game over')}${note}`, kind: 'win' });
    if (booked) this.onEvent?.({ kind: 'record', memory: booked.record });
    this.render();
  }

  /**
   * Write the finished run into the account's memory for this game - the high
   * score, the best time, the runs played - so a reload (or the desktop client,
   * or the bot) still knows about it.
   *
   * Only games that say what a good run looks like keep a record (`meta.record`,
   * see the engines): an arcade score and a puzzle time mean something, while a
   * two-player board game already has its win column.  A game that books itself
   * (smash keeps a whole career) declares `self` and is left alone here.
   *
   * Returns `{ record, notes }` - the notes are the record broken, ready to ride
   * the end-of-game toast ("new best 1,240 points").
   */
  bookRun(done) {
    const port = this.memory;
    const spec = this.engine?.meta?.record;
    if (!port || typeof port.set !== 'function' || !spec || spec.self === true || spec === false) return null;
    // The seat this account owns: a hot-seat guest's run is not your record.
    const seat = port.seat || this.seats.find((s) => s.kind !== 'bot')?.id || null;
    if (!seat || !this.seats.some((s) => s.id === seat)) return null;
    const previous = port.get() || {};
    // One run books once, however many sessions it spans and however many times
    // the finish is redrawn.
    if (previous.lastRun === this.runId) return null;
    const score = Number(done?.scores?.[seat] ?? this.state?.scores?.[seat] ?? 0) || 0;
    const won = (done?.winners || []).includes(seat);
    const seconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    const label = spec.label || 'points';
    const notes = [];
    const record = {
      ...previous,
      played: memoryNum(previous.played) + 1,
      wins: memoryNum(previous.wins) + (won ? 1 : 0),
      lastScore: score,
      lastSummary: String(done?.summary || '').slice(0, 160),
      lastAt: Date.now(),
      lastRun: this.runId,
      // The run is over: retire the saved state so the game never offers to
      // resume a finished one.  The tombstone is an empty string because that
      // is the one value the settings merge replaces outright.
      progress: { json: '', runId: this.runId, doneAt: Date.now() },
    };
    const hadBest = previous.bestScore !== undefined && previous.bestScore !== null;
    if (spec.best === 'low' || spec.best) {
      const best = hadBest ? memoryNum(previous.bestScore) : null;
      const low = spec.best === 'low';
      const beaten = best === null || (low ? score < best : score > best);
      if (beaten) notes.push(`${best === null ? 'best' : 'new best'} ${score} ${label}`);
      record.bestScore = best === null ? score : low ? Math.min(best, score) : Math.max(best, score);
    }
    // A clock only counts on a lane nobody else steers: solo (bots included) or
    // a single seat.  A hot-seat guest's pace - or a race you lost - is not your
    // best time.
    const soloLane = this.role === 'solo' || this.seats.length === 1 || this.seats.every((s) => s.kind !== 'bot');
    if (spec.time && soloLane && (won || this.seats.length === 1)) {
      const hadTime = previous.bestTime !== undefined && previous.bestTime !== null;
      const best = hadTime ? memoryNum(previous.bestTime) : null;
      if (spec.time === 'long') {
        if (best === null || seconds > best) notes.push(`${spec.timeLabel || 'longest run'} ${clockText(seconds)}`);
        record.bestTime = Math.max(best ?? 0, seconds);
      } else {
        if (best === null || seconds < best) notes.push(`${best === null ? 'best' : 'new best'} time ${clockText(seconds)}`);
        record.bestTime = best === null ? seconds : Math.min(best, seconds);
      }
    }
    port.set(record);
    return { record, notes };
  }

  /**
   * Arm the ride-along save for a long solo run.  A spent timer re-arms from the
   * next repaint, so an active game checkpoints every PROGRESS_SAVE_MS while an
   * idle one is left alone - the engine only paints when something happened.
   */
  armProgressSave() {
    if (this.progressTimer || this.disposed || this.finished) return;
    if (!this.engine?.meta?.record?.resume || this.role !== 'solo') return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.saveProgress();
    }, PROGRESS_SAVE_MS);
  }

  /**
   * Park the unfinished run in memory so a reload can pick it up.
   *
   * Only for a game that asked for it (`meta.record.resume`), only on the
   * account's own seat, and never for a finished or hot-seat run.  The state
   * rides as a string so the settings merge can both replace and clear it (see
   * gameProgress in store.js).
   */
  saveProgress({ force = false } = {}) {
    const port = this.memory;
    const spec = this.engine?.meta?.record;
    if (!port || typeof port.set !== 'function' || !spec?.resume) return null;
    if (this.role !== 'solo' || this.finished) return null;
    if (this.disposed && !force) return null;
    const seat = port.seat || this.seats.find((s) => s.kind !== 'bot')?.id || null;
    if (!seat) return null;
    const json = safeJson(this.state);
    // Nothing moved since the last checkpoint: leave the account alone.
    if (!json || json === this.lastProgressJson) return null;
    this.lastProgressJson = json;
    const previous = port.get() || {};
    port.set({
      ...previous,
      progress: {
        json,
        label: progressLabel(spec, this.rawView(seat), this.state, seat),
        startedAt: this.startedAt,
        runId: this.runId,
        savedAt: Date.now(),
      },
    });
    return true;
  }

  refresh() {
    this.render();
  }

  render() {
    if (this.disposed) return;
    const seat = this.activeSeat();
    const view = this.view(seat);
    const previous = this.mount.firstElementChild;
    if (previous) UI.cleanupTree(previous);
    UI.clear(this.mount);
    try {
      const cleanup = this.engine.render({
        el: this.mount,
        view,
        state: this.state,
        playerId: seat,
        players: this.seats,
        send: (action) => this.send(action),
        host: this,
      });
      if (typeof cleanup === 'function') {
        const node = this.mount.firstElementChild;
        if (node) node.__cleanup = cleanup;
      }
    } catch (err) {
      console.error('engine render failed', err);
      this.mount.appendChild(UI.h('div', { class: 'card', text: `This game failed to draw: ${err.message}` }));
    }
    this.maybeFinished();
    this.armProgressSave();
  }

  maybeFinished() {
    const done = this.engine.over(this.state);
    if (done?.over && !this.finished) this.finish(done);
  }

  dispose() {
    // Leaving the game is the checkpoint that matters: park the run before the
    // host goes away, then stop everything.
    this.saveProgress({ force: true });
    this.disposed = true;
    clearTimeout(this.botTimer);
    clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const node = this.mount?.firstElementChild;
    if (node) UI.cleanupTree(node);
  }
}

/* ------------------------------------------------------------------ *
 * Online host (server authoritative, except realtime rooms)
 * ------------------------------------------------------------------ */

/**
 * Realtime rooms are host-authoritative: the room host steps the world in this
 * browser and streams plain-JSON snapshots.  The world runs on a fixed 1/60s
 * timestep with real-time catch-up and snapshots leave on a fixed 20/s grid
 * (StreamClock, netcode.js), so a slow or jittery browser timer only decides
 * how many slices a wake runs - never their size or when snapshots go out.
 */

/**
 * A remote seat whose interpolation buffer ran dry may ask the host for an
 * immediate extra snapshot.  One request a second per seat is plenty: the host
 * answers with the freshest world, and the grid carries on from there.
 */
const KEYFRAME_COOLDOWN = 1000;

export class OnlineHost {
  constructor({ mount, room, view, playerId, onEvent = null, initialState = null, memory = null }) {
    this.mount = mount;
    this.room = room;
    this.view_ = view;
    this.state = null;
    this.playerId = playerId;
    this.uiState = {};
    this.memory = memory;
    this.role = room.status === 'playing' ? (room.players.some((p) => p.id === playerId) ? 'online' : 'spectator') : 'lobby';
    this.onEvent = onEvent;
    this.engine = null;
    this.disposed = false;
    this.snapshotAt = 0;
    this.streamTimer = null;
    // Fixed-timestep stream clock: banks real elapsed time for the world and
    // keeps snapshots on a steady 20/s wall-clock grid.
    this.clock = new StreamClock();
    // One keyframe answers every viewer that asked inside the same window.
    this.keyframes = new KeyframeGate();
    // The readout's recovery cue: reconnecting while the timeline is dry,
    // recovering for a moment once frames flow again.
    this.signal = new LinkSignal();
    // Client-side netcode (remote seats only): the snapshot timeline, the
    // local prediction copy, its animation-frame loop, and the seat's live keys.
    this.buffer = null;
    this.predictor = null;
    this.frameTimer = null;
    this.liveKeys = null;
    this.keyframeAt = 0;
    // Small in-game network readout (ping / snapshot rate / buffer).
    this.netEl = null;
    this.netHudAt = 0;
    this.sentAt = [];
    // The host tab's own visibility: a hidden tab keeps streaming, but the
    // browser clamps its timers, so the world switches to a coarser catch-up
    // and the room is told why frames got choppier (see handleVisibility).
    this.hidden = false;
    this.hiddenAt = 0;
    this.titleRestore = null;
    this.onVisibility = () => this.handleVisibility();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    if (initialState) this.state = initialState;
  }

  get isHost() {
    return this.room.host === this.playerId;
  }

  setEngine(engine) {
    this.engine = engine;
    if (this.state) this.syncView();
    this.syncNetcode();
    // The host owns the simulation: start streaming as soon as the engine and
    // the pristine start-of-match state are both here.  (The server also hands
    // the host the state after a rematch.)
    if (this.engine?.meta?.realtime && this.isHost && this.state) this.startStream();
  }

  applyRoom(room, view) {
    this.room = room;
    this.view_ = view;
    this.role = room.status === 'playing' ? (room.players.some((p) => p.id === this.playerId) ? 'online' : 'spectator') : 'lobby';
    if (room.status !== 'playing') this.stopStream();
    else if (this.isHost && this.state && this.engine?.meta?.realtime) this.startStream();
    this.syncNetcode();
    this.render();
  }

  /**
   * The host's authoritative start-of-match state: the server owns the pristine
   * copy so the host can start ticking (or restart on a rematch) from exactly
   * the world the room already saw.
   */
  applyStartState(state) {
    if (!state || typeof state !== 'object') return;
    this.state = state;
    this.snapshotAt = Date.now();
    this.syncView();
    this.syncNetcode();
    if (this.engine?.meta?.realtime && this.isHost) {
      this.stopStream();
      if (this.room?.status === 'playing') this.startStream();
    }
    this.render();
  }

  applyTick(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.state = snapshot;
    this.snapshotAt = Date.now();
    this.syncView();
    // Remote seats keep a timeline of snapshots and draw a blended world from
    // the frame loop; the predictor re-anchors on each fresh piece of authority.
    if (this.buffer) this.buffer.push(snapshot, this.snapshotAt);
    if (this.predictor) this.predictor.anchor(snapshot);
    // Keep the readout fresh even when animation frames are throttled (the
    // picture pauses in a hidden tab; the stats need not).
    this.updateNetHud(this.snapshotAt);
    this.render();
  }

  /**
   * Apply a seat's controls to the authoritative world.  The room host calls
   * this for its own keys and for every remote seat the server forwards.
   */
  applyInput(from, action) {
    if (!this.state || !action) return false;
    try {
      const res = this.engine?.act?.(this.state, from, action);
      return res?.ok !== false;
    } catch (err) {
      console.error('realtime input failed', err);
      return false;
    }
  }

  syncView() {
    try {
      this.view_ = this.engine?.view ? this.engine.view(this.state, this.playerId) : this.view_;
    } catch (err) {
      console.error('tick view failed', err);
    }
  }

  /* ------------- client-side netcode (remote seats only) ------------- */

  /**
   * A remote seat of a realtime room renders interpolated snapshots and predicts
   * its own controls.  The room host does not: it owns the world already.
   */
  syncNetcode() {
    const remote = !!this.engine?.meta?.realtime && this.room?.status === 'playing' && !this.isHost;
    if (!remote) {
      this.buffer = null;
      this.predictor = null;
      this.liveKeys = null;
      this.stopFrames();
      if (this.netEl) this.netEl.hidden = true;
      return;
    }
    if (!this.buffer) this.buffer = new SnapshotBuffer();
    if (this.role === 'online' && this.playerId) {
      if (!this.predictor || this.predictor.engine !== this.engine || this.predictor.playerId !== this.playerId) {
        this.predictor = new Predictor({ engine: this.engine, playerId: this.playerId });
      }
    } else {
      this.predictor = null;
    }
    if (this.liveCanvas) this.startFrames();
  }

  startFrames() {
    if (this.frameTimer || this.disposed || !this.buffer) return;
    const step = () => {
      this.frameTimer = scheduleFrame(step);
      try {
        this.netcodeFrame();
      } catch (err) {
        console.error('netcode frame failed', err);
      }
    };
    this.frameTimer = scheduleFrame(step);
  }

  stopFrames() {
    cancelFrame(this.frameTimer);
    this.frameTimer = null;
  }

  /** One animation frame: blend the world, fold in local prediction, repaint. */
  netcodeFrame() {
    if (this.disposed || !this.buffer) return;
    const now = Date.now();
    // Ask before drawing: an empty buffer (a viewer that joined mid-stall) has
    // nothing to sample, and that is exactly when the host should be asked.
    this.requestKeyframe(now);
    const world = this.buffer.sample(now - this.buffer.delay);
    if (!world) return;
    if (this.predictor && this.liveKeys) {
      this.predictor.frame(this.liveKeys, now);
      patchLocalSeat(world, this.predictor);
    }
    if (this.liveFrame) this.liveFrame(world);
    else if (this.redraw) this.redraw();
    this.updateNetHud(now);
  }

  /**
   * A remote seat's timeline holds still when the stream stalls.  Rather than
   * waiting out the rest of the gap, ask the room host for an immediate
   * keyframe - throttled to one request a second per viewer.  Watchers ask too:
   * they draw the same stream, and asking for a frame cannot change the match.
   */
  requestKeyframe(now = Date.now()) {
    if (!this.buffer || (this.role !== 'online' && this.role !== 'spectator')) return false;
    if (now - this.keyframeAt < KEYFRAME_COOLDOWN) return false;
    if (!this.buffer.starved(now)) return false;
    this.keyframeAt = now;
    gameAction({ type: 'keyframe' });
    return true;
  }

  /* ---------------------- network readout (HUD) --------------------- */

  /**
   * Refresh the small in-game network readout: round-trip ping, observed
   * snapshot rate, buffered snapshots and the adaptive interpolation delay.
   * Remote seats measure all four; the room host streams, so it reports its
   * outgoing rate instead of a buffer.  Throttled to a few updates a second.
   */
  updateNetHud(now = Date.now()) {
    const el = this.netEl;
    if (!el) return;
    if (this.disposed || !this.engine?.meta?.realtime || this.room?.status !== 'playing') {
      el.hidden = true;
      return;
    }
    if (this.netHudAt && now - this.netHudAt < 250) return;
    this.netHudAt = now;
    // Viewers (seats and spectators alike) report their timeline's health; the
    // host streams, so it has no cue.
    const cue = this.isHost ? null : this.signal.sample(this.buffer, now);
    const stats = this.isHost
      ? { host: true, rate: this.streamRate(now) }
      : { host: false, ...(this.buffer?.stats || {}) };
    // A frozen stream has no rate to report: dash it instead of showing the
    // healthy figure measured just before the stall.
    if (cue === 'reconnecting') stats.rate = 0;
    const text = netHudText({ ping: netStats.ping, ...stats, state: cue });
    if (el.textContent !== text) el.textContent = text;
    el.hidden = false;
    // Pinning the interpolation delay at its ceiling means the connection is
    // rough enough that the buffer is straining; tint the readout.
    const stressed = !this.isHost && !!this.buffer && this.buffer.delay >= this.buffer.maxDelay - 0.5;
    el.classList.toggle('warn', stressed);
    el.classList.toggle('stale', cue === 'reconnecting');
    el.classList.toggle('recovering', cue === 'recovering');
  }

  /** Remember when a snapshot went out, for the host's measured stream rate. */
  noteSnapshot(at = Date.now()) {
    this.sentAt.push(at);
    while (this.sentAt.length && at - this.sentAt[0] > 2000) this.sentAt.shift();
  }

  /** Outgoing snapshot rate over the last couple of seconds. */
  streamRate(now = Date.now()) {
    const times = this.sentAt.filter((at) => now - at <= 2000);
    if (times.length < 2) return 0;
    const span = times[times.length - 1] - times[0];
    return span > 0 ? ((times.length - 1) * 1000) / span : 0;
  }

  /* ---------------- host tab visibility ---------------- */

  /**
   * What happens when the host tab hides or comes back.
   *
   * The host is the room's only source of world state, and every browser
   * throttles timers in hidden tabs - Chrome clamps them to about once a second
   * and, after five minutes, to once a minute.  Nothing can stop that, so the
   * room does the next best thing: it keeps streaming at the cadence the
   * browser still allows, tells the room why the frames got choppier, and, when
   * the host comes back, tells them what happened while they were away.  The
   * tab title carries the same warning for anyone scanning their tab strip.
   */
  handleVisibility() {
    if (this.disposed || typeof document === 'undefined') return;
    const hidden = document.visibilityState === 'hidden';
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    const hosting = this.isHost && this.room?.status === 'playing' && !!this.engine?.meta?.realtime;
    // The server mirrors this in the room's banner, so the other seats know
    // they are waiting on a background tab rather than on a broken game.
    if (hosting) rt.send({ t: 'room', op: 'visibility', hidden });
    if (hidden) {
      if (!hosting) return;
      this.hiddenAt = Date.now();
      this.markTitle();
      return;
    }
    if (!this.hiddenAt) return;
    const away = Date.now() - this.hiddenAt;
    this.hiddenAt = 0;
    this.restoreTitle();
    this.redraw?.();
    // A blink out and back is not worth a notice; a real absence is.
    if (hosting && away > 5000) {
      toast(`Your tab was in the background for ${clockText(away / 1000)} — the room kept streaming at a reduced rate. Keep this tab visible for smooth play.`, 'warn', 9000);
    }
  }

  /** While the host tab is hidden, the tab itself carries the warning. */
  markTitle() {
    if (typeof document === 'undefined' || this.titleRestore !== null) return;
    this.titleRestore = document.title;
    document.title = `⚠ ${document.title}`;
  }

  restoreTitle() {
    if (typeof document === 'undefined' || this.titleRestore === null) return;
    document.title = this.titleRestore;
    this.titleRestore = null;
  }

  /* ---------------- realtime streaming (host only) ---------------- */

  startStream() {
    if (this.streamTimer || this.disposed) return;
    if (!this.engine?.meta?.realtime || !this.isHost || !this.state) return;
    if (this.room?.status !== 'playing') return;
    this.clock.reset(Date.now());
    this.scheduleStreamTick();
  }

  stopStream() {
    clearTimeout(this.streamTimer);
    this.streamTimer = null;
  }

  /** Wake for the next fixed slice or snapshot slot, whichever lands first. */
  scheduleStreamTick(now = Date.now()) {
    if (this.streamTimer || this.disposed) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this.streamTick();
    }, this.clock.wait(now));
  }

  /**
   * One stream wake: catch the world up to the wall clock in fixed slices, then
   * hand the room whatever the snapshot grid has due.  A late wake simulates
   * every slice it missed and sends one fresh snapshot where the grid says a
   * slot passed, so the cadence keeps its 20/s phase instead of being stretched
   * to "50ms after the last send".
   */
  streamTick() {
    if (this.disposed || !this.state || this.room?.status !== 'playing') return this.stopStream();
    if (this.state.winnerId) return this.stopStream();
    const now = Date.now();
    if (!this.stepWorld(now)) return;
    let sent = false;
    if (this.clock.snapshotDue(now)) {
      this.pushSnapshot(now);
      sent = true;
    }
    const done = this.engine.over?.(this.state);
    if (done?.over) {
      // Carry the final world (and its winner) to the room before stopping.
      if (!sent) this.pushSnapshot(now);
      return this.stopStream();
    }
    this.updateNetHud(now);
    this.scheduleStreamTick(now);
  }

  /**
   * Advance the authoritative world to `now` in fixed 1/60s slices.  A slow
   * timer changes how many slices a wake runs, not their size, and the bank is
   * capped (see StreamClock) so a long stall warps the world by at most 200ms
   * instead of replaying the whole pause.  A hidden tab is the one exception:
   * its timers are clamped to about a second, so the bank may hold that much
   * real time and the world keeps step with the wall clock while the room keeps
   * receiving snapshots on the same fixed grid.
   */
  stepWorld(now) {
    const steps = this.clock.advance(now, this.hidden ? BACKGROUND_CATCHUP_MS : this.clock.maxCatchup);
    if (steps <= 0) return true;
    const events = [];
    try {
      for (let i = 0; i < steps; i++) {
        const res = this.engine.act(this.state, this.playerId, { type: 'tick', dt: this.clock.step / 1000 });
        if (res?.events?.length) events.push(...res.events);
        if (this.state.winnerId) break;
      }
    } catch (err) {
      console.error('online tick failed', err);
      this.stopStream();
      return false;
    }
    for (const ev of events) if (ev.text) this.onEvent?.(ev);
    this.syncView();
    // Nothing is on screen while the tab is hidden: skip the repaint, and
    // repaint once when the host comes back (see handleVisibility).
    if (!this.hidden) this.redraw?.();
    return true;
  }

  /** The freshest world goes out now, and counts toward the measured rate. */
  pushSnapshot(at = Date.now()) {
    this.send({ type: 'tick', snapshot: this.state }, { quiet: true });
    this.noteSnapshot(at);
  }

  /**
   * A remote seat or spectator's buffer ran dry (a stall, a hitch, a hidden
   * tab): answer with the freshest world right away.  The keyframe takes the
   * current grid slot, so the next regular snapshot is a full interval later -
   * nobody recovers into a burst of catch-up frames.  Requests are coalesced:
   * the snapshot is broadcast to the whole room, so one keyframe answers every
   * viewer that asked inside the same window, and a snapshot that just went out
   * (grid or keyframe) carries the freshest world to them too.
   */
  freshSnapshot(at = Date.now()) {
    if (this.disposed || !this.isHost || this.room?.status !== 'playing') return false;
    if (!this.state || !this.engine?.meta?.realtime) return false;
    const last = this.sentAt[this.sentAt.length - 1];
    if (!this.keyframes.due(at, last === undefined ? null : last)) return false;
    this.pushSnapshot(at);
    this.clock.snapAt = at + this.clock.interval;
    return true;
  }

  view() {
    return this.view_;
  }

  get players() {
    return this.room?.players || [];
  }

  send(action, { quiet = false } = {}) {
    if (this.role === 'spectator') {
      if (!quiet) toast('You are spectating - join a seat to play.', 'warn');
      return false;
    }
    if (this.room.status !== 'playing') {
      if (!quiet) toast('The game has not started yet.', 'warn');
      return false;
    }
    // The room host owns the world: its own controls are applied to the
    // authoritative state directly and ride out with the next snapshot.
    if (this.engine?.meta?.realtime && action?.type === 'input' && this.isHost && this.state) {
      this.applyInput(this.playerId, action);
      return true;
    }
    gameAction(action);
    if (!quiet) sfx('click');
    return true;
  }

  refresh() {
    this.render();
  }

  render() {
    if (this.disposed || !this.engine) return;
    // Online realtime play redraws the canvas in place from every streamed
    // snapshot (see streamTick/applyTick).  Rebuilding the stage would wipe the
    // keyboard listeners and reset scroll every frame, so only build it once.
    if (this.liveCanvas) {
      // With a snapshot timeline the frame loop owns the repaint, so an arriving
      // snapshot must never snap the picture; without one (match over, or the
      // stage is not live yet) a plain repaint of the latest world is right.
      if (!this.buffer) {
        if (this.liveFrame) this.liveFrame(this.state);
        else this.redraw?.();
      }
      return;
    }
    this.liveCanvas = false;
    this.netEl = null;
    const previous = this.mount.firstElementChild;
    if (previous) UI.cleanupTree(previous);
    UI.clear(this.mount);
    // Before the server starts the match it sends a synthetic lobby view: there
    // is no engine state yet, and engines expect their own shape.
    if (!this.view_ || this.room?.status !== 'playing' || this.view_.lobby) {
      this.mount.appendChild(UI.h('div', { class: 'col' },
        UI.h('p', { class: 'muted', text: this.room?.status === 'finished' ? 'That match is over - the host can start a rematch.' : 'Waiting for the host to start…' }),
        UI.h('p', { class: 'muted small', text: 'Chat and the player list stay available while you wait.' })));
      return;
    }
    try {
      const cleanup = this.engine.render({
        el: this.mount,
        view: this.view_,
        state: this.state,
        playerId: this.playerId,
        players: this.players,
        send: (action) => this.send(action),
        host: this,
      });
      this.redraw = typeof cleanup?.redraw === 'function' ? cleanup.redraw : null;
      this.liveFrame = typeof cleanup?.live === 'function' ? cleanup.live : null;
      // Realtime engines also hand back their seat's live key map, which the
      // predictor reads on every frame, and the stage's network readout line.
      this.liveKeys = cleanup && typeof cleanup.keys === 'object' ? cleanup.keys : null;
      this.netEl = cleanup && cleanup.net ? cleanup.net : null;
      this.netHudAt = 0;
      if (typeof cleanup === 'function') {
        const node = this.mount.firstElementChild;
        if (node) node.__cleanup = cleanup;
      }
      // Realtime engines hand back a live repaint hook: streamed frames redraw
      // the existing canvas instead of rebuilding the whole stage.
      this.liveCanvas = !!this.liveFrame && this.room?.status === 'playing';
      if (this.liveCanvas && this.buffer) this.startFrames();
      else this.stopFrames();
    } catch (err) {
      console.error('online render failed', err);
      this.mount.appendChild(UI.h('div', { class: 'card', text: `Render error: ${err.message}` }));
    }
  }

  dispose() {
    this.disposed = true;
    if (typeof document !== 'undefined' && this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    this.restoreTitle();
    this.stopStream();
    this.stopFrames();
    this.buffer = null;
    this.predictor = null;
    this.netEl = null;
    this.sentAt = [];
    const node = this.mount?.firstElementChild;
    if (node) UI.cleanupTree(node);
  }
}

/* ------------------------------------------------------------------ *
 * seat helpers
 * ------------------------------------------------------------------ */

export function seatsFor(gameMeta, { mode = 'solo', humans = 1, botLevel = 2, myName = 'You', myAvatar = '🙂' } = {}) {
  const seats = [];
  if (mode === 'online') return seats;
  const humanCount = mode === 'solo' ? 1 : Math.max(1, humans);
  for (let i = 0; i < humanCount; i++) {
    seats.push({
      id: `h${i}`,
      name: mode === 'solo' ? myName : i === 0 ? `${myName} (P1)` : `Player ${i + 1}`,
      avatar: i === 0 ? myAvatar : '🙂',
      kind: 'human',
      level: 2,
    });
  }
  let botIndex = 1;
  const target = Math.max(gameMeta.players.min, humanCount);
  while (seats.length < target) {
    seats.push({ ...botSeat(botIndex++, botLevel), id: `bot${seats.length}` });
  }
  return seats;
}

export function watchRoom(host, cb) {
  const off = rt.on('game', (msg) => {
    host.applyRoom(msg.room, msg.view);
    cb?.(msg);
  });
  const off2 = rt.on('tick', (msg) => {
    if (msg.roomId === host.room?.id) host.applyTick(msg.snapshot);
  });
  const off3 = rt.on('chat', (msg) => cb?.({ chat: msg }));
  const off4 = rt.on('room:input', (msg) => {
    if (msg.roomId === host.room?.id) host.applyInput(msg.from, msg.action);
  });
  const off5 = rt.on('room:state', (msg) => {
    if (msg.roomId === host.room?.id) host.applyStartState(msg.state);
  });
  return () => {
    off();
    off2();
    off3();
    off4();
    off5();
  };
}

export function currentSeatName() {
  return appState.me?.name || 'You';
}
