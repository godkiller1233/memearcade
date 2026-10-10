/**
 * Client-side netcode for the host-authoritative realtime games.
 *
 * The room host owns the world and streams full JSON snapshots about twenty
 * times a second.  Drawing each snapshot the instant it lands makes every
 * remote seat step at that cadence, and makes your own paddle/ship wait a full
 * round trip before it moves.  This module fixes both:
 *
 *   SnapshotBuffer - keeps the last second of worlds on an arrival timeline and
 *     blends the two frames around `now - delay`, so a remote seat renders a
 *     smooth ~60fps world that trails the host by a fixed, small amount.
 *
 *   Predictor - keeps a local copy of the authoritative world, feeds this
 *     seat's keys into it immediately and steps it with the engine's own rules,
 *     so your controls respond on the next frame instead of a round trip later.
 *     Every fresh snapshot re-anchors the copy; the correction becomes a visual
 *     offset that decays away instead of a snap.
 *
 * Nothing here touches the DOM, so the tooling can import it in Node.
 */

/**
 * How far behind the newest snapshot a remote seat renders, in ms.  This is
 * only the starting value: once snapshots start arriving the buffer retunes it
 * to the stream's measured cadence and jitter.
 */
export const INTERP_DELAY = 100;
/** Adaptive delay bounds, in ms. */
export const MIN_INTERP_DELAY = 60;
export const MAX_INTERP_DELAY = 250;
/** Snapshots kept on the timeline (about a second at the 50ms stream cadence). */
const KEEP_FRAMES = 24;
/** Arrival gaps kept for the cadence/jitter estimate (about a second at 20Hz). */
const JITTER_FRAMES = 16;
/** Delay = median gap + MAD_FACTOR * mean absolute deviation + DELAY_MARGIN. */
const MAD_FACTOR = 2;
const DELAY_MARGIN = 30;
/** How fast the adaptive delay may move per arriving snapshot, in ms. */
const GROW_STEP = 12;
const SHRINK_STEP = 4;
/**
 * How far a slow stream may stretch the delay past one arrival interval, and
 * how much of the remaining distance it covers per arriving snapshot.  A host
 * tab in the background streams about once a second; the tight 250ms bound is
 * right for a 20/s stream and far too small for that one, so the ceiling has to
 * follow the measured cadence.
 */
const SLOW_CEILING_FACTOR = 1.5;
const GROW_FRACTION = 0.25;
/** Two blended entities further apart than this are treated as different things. */
const MATCH_RADIUS = 120;
/** Corrections larger than this are respawns/teleports: snap instead of smearing. */
const HARD_SNAP = 280;
/** The sampling cursor this far past the newest snapshot means the stream ran dry. */
const STARVE_MARGIN = 40;

const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const isObj = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Median of a small numeric list (copying, so callers keep their order). */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Mean distance of each value from a centre - a cheap, robust jitter measure. */
function deviation(values, centre) {
  let sum = 0;
  for (const value of values) sum += Math.abs(value - centre);
  return values.length ? sum / values.length : 0;
}

/* ------------------------------------------------------------------ *
 * world blending
 * ------------------------------------------------------------------ */

/**
 * Blend two worlds: numbers slide, everything else takes the newer value.
 * Objects recurse key-by-key; arrays match their items up first (by id, kind or
 * nearest position) so spawned/despawned bullets do not smear into each other.
 * The result never aliases either input, so callers may patch it in place.
 */
export function blendWorld(older, newer, t) {
  if (Array.isArray(newer)) return blendArray(Array.isArray(older) ? older : null, newer, t);
  if (isObj(newer)) {
    if (!isObj(older)) return clone(newer);
    const out = {};
    for (const key of Object.keys(newer)) {
      out[key] = key in older ? blendValue(older[key], newer[key], t) : clone(newer[key]);
    }
    return out;
  }
  return blendValue(older, newer, t);
}

function blendValue(a, b, t) {
  if (Array.isArray(b) || isObj(b)) return blendWorld(a, b, t);
  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
    return a + (b - a) * t;
  }
  return b;
}

function blendArray(older, newer, t) {
  if (!older) return clone(newer);
  const used = new Set();
  const out = [];
  for (const item of newer) {
    if (!isObj(item)) {
      out.push(clone(item));
      continue;
    }
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < older.length; i++) {
      if (used.has(i)) continue;
      const candidate = older[i];
      if (!isObj(candidate) || !sameKind(candidate, item)) continue;
      const distance = itemDistance(candidate, item);
      if (distance < bestDist) {
        bestDist = distance;
        best = i;
      }
    }
    if (best >= 0 && bestDist <= MATCH_RADIUS) {
      used.add(best);
      out.push(blendWorld(older[best], item, t));
    } else {
      out.push(clone(item)); // freshly spawned: no predecessor to slide from
    }
  }
  return out;
}

/** `id` identifies a thing outright; otherwise kind/type/owner must agree. */
function sameKind(a, b) {
  if (a.id !== undefined || b.id !== undefined) return a.id === b.id;
  for (const key of ['kind', 'type', 'owner']) {
    if (a[key] !== undefined || b[key] !== undefined) {
      if (a[key] !== b[key]) return false;
    }
  }
  return true;
}

function itemDistance(a, b) {
  if (Number.isFinite(a.x) && Number.isFinite(b.x) && Number.isFinite(a.y) && Number.isFinite(b.y)) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * snapshot timeline
 * ------------------------------------------------------------------ */

export class SnapshotBuffer {
  constructor({ delay = INTERP_DELAY, keep = KEEP_FRAMES, minDelay = MIN_INTERP_DELAY, maxDelay = MAX_INTERP_DELAY, adapt = true } = {}) {
    this.delay = delay;
    this.keep = keep;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.adapt = adapt;
    this.frames = [];
    this.pushed = 0;
    /** Intervals between consecutive arrivals, newest last. */
    this.gaps = [];
    this.lastArrival = null;
  }

  push(snapshot, at = Date.now()) {
    if (!isObj(snapshot)) return;
    if (this.lastArrival !== null && at > this.lastArrival) {
      this.gaps.push(at - this.lastArrival);
      if (this.gaps.length > JITTER_FRAMES) this.gaps.shift();
      if (this.adapt) this.retune();
    }
    this.lastArrival = at;
    this.frames.push({ at, state: snapshot });
    while (this.frames.length > this.keep) this.frames.shift();
    this.pushed++;
  }

  /**
   * Retune the interpolation delay to the connection actually observed: aim a
   * little past one snapshot interval plus two mean absolute deviations of the
   * arrival gaps, so a calm stream renders close to real time and a jittery one
   * builds the slack it needs.  Snapshots land about twenty times a second, so
   * the delay may grow quickly to cover a stall but shrinks gently enough that
   * the picture never creeps while the network settles.
   */
  retune() {
    const gaps = this.gaps;
    if (gaps.length < 4) return;
    const centre = median(gaps);
    const target = centre + MAD_FACTOR * deviation(gaps, centre) + DELAY_MARGIN;
    // The ceiling follows the cadence.  A calm 20/s stream stays under the
    // usual 250ms bound, but a slowly-arriving one is allowed past its own
    // interval: a host tab in the background watches timers clamp to about
    // once a second, and holding the cursor 250ms behind snapshots that far
    // apart would run the timeline dry on every single frame.
    const ceiling = Math.max(this.maxDelay, centre * SLOW_CEILING_FACTOR + DELAY_MARGIN);
    const clamped = Math.max(this.minDelay, Math.min(ceiling, target));
    // A fast stream keeps the gentle 12ms-per-snapshot growth; a slow one
    // covers a quarter of its arrival gap per snapshot, so a second-long
    // cadence settles in a few seconds instead of a few minutes.
    const step = clamped > this.delay
      ? Math.max(GROW_STEP, Math.min(clamped - this.delay, centre * GROW_FRACTION))
      : SHRINK_STEP;
    this.delay += Math.max(-step, Math.min(step, clamped - this.delay));
  }

  /** Measured mean arrival interval, in ms (0 until two frames have arrived). */
  get interval() {
    if (!this.gaps.length) return 0;
    let sum = 0;
    for (const gap of this.gaps) sum += gap;
    return sum / this.gaps.length;
  }

  /** Measured snapshot rate, in snapshots per second. */
  get rate() {
    const interval = this.interval;
    return interval > 0 ? 1000 / interval : 0;
  }

  /** Measured jitter: mean absolute deviation of arrival gaps, in ms. */
  get jitter() {
    if (this.gaps.length < 2) return 0;
    return deviation(this.gaps, median(this.gaps));
  }

  /** Everything a network readout wants to show, free of the DOM. */
  get stats() {
    return { rate: this.rate, jitter: this.jitter, depth: this.frames.length, delay: this.delay, interval: this.interval };
  }

  get latest() {
    return this.frames.length ? this.frames[this.frames.length - 1].state : null;
  }

  get depth() {
    return this.frames.length;
  }

  /**
   * True when the timeline cannot feed the interpolation cursor: an empty buffer
   * (a viewer that joined mid-stall has nothing to draw) or a cursor that has
   * run past the newest snapshot (the stream went quiet and the picture is
   * holding still).  Remote seats use this to ask the host for a keyframe (an
   * immediate extra snapshot) instead of waiting out the rest of a stall.
   */
  starved(now = Date.now()) {
    if (!this.frames.length) return true;
    return now - this.delay > this.frames[this.frames.length - 1].at + STARVE_MARGIN;
  }

  clear() {
    this.frames.length = 0;
    this.gaps.length = 0;
    this.lastArrival = null;
  }

  /**
   * The world to draw now: the two snapshots around `at` (default now minus the
   * interpolation delay) blended by how far between them the clock has reached.
   * Always a fresh tree, ready to be patched or mutated.
   */
  sample(at = Date.now() - this.delay) {
    const frames = this.frames;
    if (!frames.length) return null;
    if (frames.length === 1 || at <= frames[0].at) return clone(frames[0].state);
    const last = frames[frames.length - 1];
    if (at >= last.at) return clone(last.state);
    for (let i = frames.length - 1; i > 0; i--) {
      if (frames[i - 1].at <= at) {
        const older = frames[i - 1];
        const newer = frames[i];
        const span = Math.max(1, newer.at - older.at);
        const t = Math.min(1, Math.max(0, (at - older.at) / span));
        return blendWorld(older.state, newer.state, t);
      }
    }
    return clone(last.state);
  }
}

/* ------------------------------------------------------------------ *
 * network readout
 * ------------------------------------------------------------------ */

/**
 * One compact line of live network stats for the realtime games: round-trip
 * ping, measured snapshot rate, how many snapshots are buffered and the
 * interpolation delay currently in use.  A host streams rather than buffers, so
 * it reports its outgoing rate instead of the last two fields.  `state` adds
 * the recovery cue (see LinkSignal).  Pure string formatting - the node tooling
 * and the HUD share this.
 */
export function netHudText({ ping = null, rate = 0, depth = 0, delay = 0, host = false, state = null } = {}) {
  const bits = [`ping ${Number.isFinite(ping) ? `${Math.round(ping)}ms` : '–'}`];
  bits.push(`snap ${rate > 0 ? `${rate.toFixed(1)}/s` : '–'}`);
  if (host) bits.push('host');
  else {
    bits.push(`buf ${depth}`);
    bits.push(`delay ${Math.round(delay)}ms`);
  }
  if (state === 'reconnecting') bits.push('reconnecting…');
  else if (state === 'recovering') bits.push('recovering…');
  return bits.join(' · ');
}

/**
 * The room-host outage banner's one line: a dropped host freezes a
 * host-authoritative match until the grace window ends and hosting migrates,
 * so the room says who takes over and when instead of going quiet.  `until` is
 * the server's handover deadline; the count reads down here, so the banner
 * needs no traffic of its own.  Pure string formatting - the node tooling and
 * the banner share this.  Returns null when there is no outage to show.
 */
export function roomAlertText(outage, nowMs = Date.now()) {
  if (!outage) return null;
  const secs = Math.max(0, Math.ceil((Number(outage.until) - nowMs) / 1000));
  const host = outage.hostName || 'The host';
  const who = outage.nextName ? `${outage.nextName} takes over` : 'the room closes';
  return `${host} lost connection — ${who} ${secs > 0 ? `in ${secs}s` : 'now'}.`;
}

/**
 * The room banner's line for a host whose tab is hidden or whose stream has
 * stalled (`room.hostStream`).  A host-authoritative match cannot advance
 * without its host, so the room says what it is waiting on instead of looking
 * broken; the host's own build of the line tells them what to do about it.
 * Returns null when the stream is healthy.  Pure string formatting - the node
 * tooling and the banner share this.
 */
export function hostStreamText(stream, { self = false } = {}) {
  if (!stream) return null;
  const host = stream.hostName || 'The host';
  if (stream.stalled) {
    return self
      ? 'Your tab stopped streaming — bring this match tab back to the foreground to keep the room moving.'
      : `${host} stopped streaming — the match is waiting on their tab.`;
  }
  if (stream.hidden) {
    return self
      ? 'Your tab is in the background — the room keeps streaming, but frames may be choppier until you are back.'
      : `${host} is hosting from a background tab — frames may be choppier until it is back.`;
  }
  return null;
}

/**
 * Turns a viewer's snapshot timeline into the recovery cue the readout shows.
 *
 * A frozen picture should read as "reconnecting", not as a broken game: while
 * the timeline is dry the seat is simply owed frames (the host is answering its
 * keyframe request).  Once frames arrive the cue flips to "recovering" - the
 * world moves again, but the buffer has not rebuilt its margin - and then fades.
 */
export class LinkSignal {
  constructor({ recoverMs = 1200 } = {}) {
    this.recoverMs = recoverMs;
    this.until = 0;
  }

  /** 'reconnecting' | 'recovering' | null for this timeline at `now`. */
  sample(buffer, now = Date.now()) {
    if (!buffer) return null;
    if (buffer.starved(now)) {
      this.until = now + this.recoverMs;
      return 'reconnecting';
    }
    return now < this.until ? 'recovering' : null;
  }
}

/* ------------------------------------------------------------------ *
 * host stream clock
 * ------------------------------------------------------------------ */

/**
 * Fixed-timestep clock for the room host's snapshot stream.
 *
 * A host drives the world and its snapshots from browser timers, and those
 * timers are not precise: a busy or backgrounded tab can fire a 16ms timeout
 * a hundred milliseconds late.  Stepping the world "one slice per callback"
 * would stretch the match, and sending "once 50ms have passed since the last
 * send" would stretch the snapshot cadence with it.
 *
 * So the clock banks real elapsed time and spends it in fixed slices - a slow
 * timer only changes how many slices a wake runs, never their size - and it
 * keeps snapshots on a fixed wall-clock grid: while the timer keeps up (wakes
 * faster than the cadence) the stream sends exactly one snapshot per interval,
 * and a wake that missed several slots collapses them into one fresh snapshot
 * instead of shifting the grid.  A late wake can never stretch the cadence.
 */
export class StreamClock {
  constructor({ step = 1000 / 60, interval = 50, maxCatchup = 200, minWake = 4 } = {}) {
    this.step = step; // fixed simulation slice, ms
    this.interval = interval; // snapshot cadence, ms (50 = a steady 20/s)
    this.maxCatchup = maxCatchup; // most real time one wake may make up, ms
    this.minWake = minWake; // scheduler floor, ms
    this.reset(0);
  }

  /** Restart at `now`: an empty bank and the next snapshot slot immediately due. */
  reset(now = 0) {
    this.acc = 0; // banked real time waiting to be simulated, ms
    this.stepAt = now; // when the bank was last topped up
    this.snapAt = now; // next snapshot deadline on the wall clock
  }

  /**
   * Bank the real time since the last wake and report how many fixed slices the
   * world owes.  A long stall banks at most `maxCatchup` ms, so the host warps
   * at most that far instead of replaying the whole pause.
   */
  advance(now = 0, cap = this.maxCatchup) {
    const at = Number.isFinite(now) ? now : this.stepAt;
    const limit = Number.isFinite(cap) && cap > 0 ? cap : this.maxCatchup;
    const elapsed = Math.min(Math.max(0, at - this.stepAt), limit);
    this.acc = Math.min(this.acc + elapsed, limit);
    this.stepAt = at;
    const steps = Math.floor(this.acc / this.step);
    this.acc = Math.max(0, this.acc - steps * this.step);
    return steps;
  }

  /** True when a snapshot slot is due; every missed slot collapses into this one. */
  snapshotDue(now = 0) {
    if (!(now >= this.snapAt)) return false;
    const missed = Math.floor((now - this.snapAt) / this.interval) + 1;
    this.snapAt += missed * this.interval;
    return true;
  }

  /** Milliseconds until the next fixed slice or snapshot slot, whichever lands first. */
  wait(now = 0) {
    const simAt = this.stepAt + Math.max(0, this.step - this.acc);
    return Math.max(this.minWake, Math.round(Math.min(simAt, this.snapAt) - now));
  }
}

/* ------------------------------------------------------------------ *
 * keyframe coalescing
 * ------------------------------------------------------------------ */

/**
 * One keyframe per window, however many viewers asked for it.
 *
 * When a stall ends - or a rough patch hits - every remote seat and spectator
 * notices at almost the same moment and asks the host for a keyframe.  The
 * host broadcasts snapshots to the whole room, so a single fresh world already
 * answers all of them: this gate lets the first request inside a window
 * through and absorbs the rest.  The window defaults to one snapshot interval,
 * short enough that a lone viewer's recovery is never delayed by waiting.
 */
export class KeyframeGate {
  constructor({ window = 50 } = {}) {
    this.window = window;
    this.last = null;
  }

  /**
   * True when a keyframe should go out now.
   *
   * False while the last keyframe still covers `now`, and false while
   * `lastSend` (the newest snapshot of any kind - a grid send already carries
   * the freshest world to everyone) does too.  A herd of requests collapses to
   * at most one extra snapshot per window.
   */
  due(now = Date.now(), lastSend = null) {
    if (lastSend !== null && lastSend !== undefined && now - lastSend < this.window) return false;
    if (this.last !== null && now - this.last < this.window) return false;
    this.last = now;
    return true;
  }

  reset() {
    this.last = null;
  }
}

/* ------------------------------------------------------------------ *
 * local-seat prediction
 * ------------------------------------------------------------------ */

const INPUT_FLAGS = ['up', 'down', 'left', 'right', 'fire'];

/** Do two key maps (or engine input records) describe the same controls? */
export function sameFlags(a, b) {
  if (!a || !b) return false;
  for (const flag of INPUT_FLAGS) if (!!a[flag] !== !!b[flag]) return false;
  return true;
}

/** Containers an engine keeps per-seat entities in (pong/invade/royale/smash). */
const SEAT_BAGS = ['paddles', 'ships', 'fighters'];
/** Pose-ish fields worth predicting; health, timers and stocks stay authoritative. */
const POSE_FIELDS = {
  paddles: ['x', 'y'],
  ships: ['x', 'y', 'vx', 'vy', 'angle'],
  fighters: ['x', 'y', 'vx', 'vy', 'facing'],
};

/** The seat's own entity inside a world, if that world has one. */
export function seatEntity(world, playerId) {
  if (!world || !playerId) return null;
  for (const bag of SEAT_BAGS) {
    const entity = world[bag]?.[playerId];
    if (entity) return { bag, entity };
  }
  return null;
}

export class Predictor {
  constructor({ engine, playerId, stepMs = 1000 / 60, maxSteps = 4, tauMs = 110, holdTauMs = 600, hardSnap = HARD_SNAP } = {}) {
    this.engine = engine;
    this.playerId = playerId;
    this.stepMs = stepMs;
    this.maxSteps = maxSteps;
    this.tauMs = tauMs;
    this.holdTauMs = holdTauMs;
    this.hardSnap = hardSnap;
    this.sim = null;
    this.offset = { x: 0, y: 0 };
    this.acc = 0;
    this.lastAt = 0;
    this.lastKeys = null;
    this.hostHasInput = false;
    this.anchors = 0;
    this.steps = 0;
  }

  get ready() {
    return !!this.sim;
  }

  /**
   * Take over a fresh authoritative world.  The local position is re-based on
   * the new copy and the difference - how far ahead of the host we predicted -
   * is carried as a decaying visual offset, so nothing jumps on screen.
   */
  anchor(snapshot) {
    if (!snapshot || !this.engine?.act) return;
    const rendered = this.renderedPosition();
    const next = clone(snapshot);
    const fresh = seatEntity(next, this.playerId);
    this.sim = next;
    if (rendered && fresh && Number.isFinite(fresh.entity.x) && Number.isFinite(fresh.entity.y) && Number.isFinite(rendered.x) && Number.isFinite(rendered.y)) {
      const dx = rendered.x - fresh.entity.x;
      const dy = rendered.y - fresh.entity.y;
      if (Math.hypot(dx, dy) <= this.hardSnap) this.offset = { x: dx, y: dy };
      else this.offset = { x: 0, y: 0 };
    } else {
      this.offset = { x: 0, y: 0 };
    }
    // Has this snapshot already applied the keys we are holding?  If not, part
    // of the offset is the input still travelling to the host - that lead is
    // worth keeping, so corrections ease off much more gently.
    const seatInputs = next.inputs?.[this.playerId];
    this.hostHasInput = !!seatInputs && !!this.lastKeys && sameFlags(seatInputs, this.lastKeys);
    this.anchors++;
  }

  /** Apply a seat's live key map to the local copy (when it differs). */
  applyKeys(keys) {
    const seat = this.sim?.inputs?.[this.playerId];
    if (!seat || !keys || sameFlags(seat, keys)) return;
    try {
      this.engine.act(this.sim, this.playerId, {
        type: 'input',
        up: !!keys.up,
        down: !!keys.down,
        left: !!keys.left,
        right: !!keys.right,
        fire: !!keys.fire,
      });
    } catch (err) {
      console.error('prediction input failed', err);
    }
  }

  /**
   * One render frame: feed the keys in, run the engine's fixed 1/60s slices,
   * then ease the correction offset toward the authority.  Corrections that are
   * really just our input still in flight decay gently; real errors (and the
   * input the host has already applied) ease away in about 110ms.
   */
  frame(keys, at = Date.now()) {
    if (!this.sim) return null;
    if (keys) this.lastKeys = keys;
    const dt = this.lastAt ? Math.max(0, Math.min(200, at - this.lastAt)) : 0;
    this.lastAt = at;
    this.applyKeys(keys);
    this.acc = Math.min(this.acc + dt, this.stepMs * this.maxSteps);
    let steps = 0;
    while (this.acc >= this.stepMs && steps < this.maxSteps) {
      this.acc -= this.stepMs;
      steps++;
      let res = null;
      try {
        res = this.engine.act(this.sim, this.playerId, { type: 'tick', dt: this.stepMs / 1000 });
      } catch (err) {
        console.error('prediction tick failed', err);
        break;
      }
      if (res?.ok === false) break;
    }
    this.steps += steps;
    const factor = Math.exp(-dt / (this.hostHasInput ? this.tauMs : this.holdTauMs));
    this.offset.x *= factor;
    this.offset.y *= factor;
    if (Math.abs(this.offset.x) < 0.05) this.offset.x = 0;
    if (Math.abs(this.offset.y) < 0.05) this.offset.y = 0;
    return this.sim;
  }

  /** Where the seat's entity should be drawn right now. */
  renderedPosition() {
    const found = seatEntity(this.sim, this.playerId);
    if (!found || !Number.isFinite(found.entity.x) || !Number.isFinite(found.entity.y)) return null;
    return { x: found.entity.x + this.offset.x, y: found.entity.y + this.offset.y };
  }

  /** The predicted entity, for patching into the blended world. */
  predictedEntity() {
    return seatEntity(this.sim, this.playerId);
  }
}

/**
 * Overlay the predicted local entity onto a blended world so remote seats see
 * their own paddle/ship/fighter react immediately.  Only pose fields move;
 * damage, stocks and timers keep following the authoritative blend.
 */
export function patchLocalSeat(world, predictor) {
  const found = predictor?.predictedEntity?.();
  const live = world?.[found?.bag]?.[predictor.playerId];
  if (!found || !live) return world;
  for (const field of POSE_FIELDS[found.bag] || []) {
    const value = found.entity[field];
    if (typeof value !== 'number' || typeof live[field] !== 'number' || !Number.isFinite(value)) continue;
    live[field] = value;
  }
  if (Number.isFinite(live.x) && Number.isFinite(found.entity.x)) live.x += predictor.offset.x;
  if (Number.isFinite(live.y) && Number.isFinite(found.entity.y)) live.y += predictor.offset.y;
  return world;
}

/* ------------------------------------------------------------------ *
 * frame scheduling
 * ------------------------------------------------------------------ */

/** requestAnimationFrame where it exists, a 16ms timer where it does not. */
export function scheduleFrame(cb) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => cb(Date.now()));
  return setTimeout(() => cb(Date.now()), 16);
}

export function cancelFrame(id) {
  if (id === null || id === undefined) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
}

export default {
  INTERP_DELAY,
  MIN_INTERP_DELAY,
  MAX_INTERP_DELAY,
  SnapshotBuffer,
  StreamClock,
  KeyframeGate,
  LinkSignal,
  Predictor,
  blendWorld,
  patchLocalSeat,
  seatEntity,
  netHudText,
  hostStreamText,
  scheduleFrame,
  cancelFrame,
};
