/**
 * Game hosts.
 *
 * The same engine module runs in three places:
 *   solo   - you vs bots, entirely in the browser
 *   local  - hot-seat, several humans sharing this device
 *   online - the server owns state and streams per-player views
 *
 * A host exposes the small contract engines' render() expects:
 *   { role, uiState, refresh(), send(action), players, isHost }
 */
import * as UI from '../games/engines/ui.js';
import { SnapshotBuffer, Predictor, patchLocalSeat, netHudText, StreamClock, KeyframeGate, LinkSignal, scheduleFrame, cancelFrame } from './netcode.js';
import { state as appState } from './store.js';
import { toast } from './dom.js';
import { rt, gameAction, netStats } from './realtime.js';
import { sfx } from './audio.js';

const BOT_NAMES = ['RoboRita', 'Bytey', 'NullPointer', 'Glitchy', 'Sir Lagsalot', 'PixelPete', 'MechaMango', 'Tofu', 'Clicky', 'VoidCat'];

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
  constructor({ engine, mount, seats, options = {}, role = 'solo', onEvent = null }) {
    this.engine = engine;
    this.mount = mount;
    this.role = role; // 'solo' | 'local'
    this.uiState = {};
    this.onEvent = onEvent;
    this.seats = seats;
    this.state = engine.create({
      players: seats,
      options,
      rng: Math.random,
      seed: Math.floor(Math.random() * 1e9),
      bots: seats.filter((s) => s.kind === 'bot').length,
    });
    this.manualSeat = null;
    this.botTimer = null;
    this.disposed = false;
    this.finished = false;
    this.startedAt = Date.now();
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
    const winners = (done.winners || []).map((id) => this.seats.find((s) => s.id === id)?.name).filter(Boolean);
    sfx(winners.length ? 'win' : 'lose');
    this.onEvent?.({ text: done.summary || (winners.length ? `${winners.join(' & ')} win!` : 'Game over'), kind: 'win' });
    this.render();
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
  }

  maybeFinished() {
    const done = this.engine.over(this.state);
    if (done?.over && !this.finished) this.finish(done);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.botTimer);
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
  constructor({ mount, room, view, playerId, onEvent = null, initialState = null }) {
    this.mount = mount;
    this.room = room;
    this.view_ = view;
    this.state = null;
    this.playerId = playerId;
    this.uiState = {};
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
   * instead of replaying the whole pause.
   */
  stepWorld(now) {
    const steps = this.clock.advance(now);
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
    this.redraw?.();
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
