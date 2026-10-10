#!/usr/bin/env node
/**
 * Online realtime multiplayer end-to-end check.
 *
 *   npm run realtime                    # scratch server on a spare port
 *   npm run realtime -- --target URL    # the same checks against a deployed build
 *   npm run stress                      # the suite plus a seeded random-stall match
 *
 * With --target (or MEMES_TARGET) no scratch server is booted: the deployed
 * build is health-gated first, then receives the same checks - they create
 * guest accounts, parties and rooms on it, so point it at staging. The
 * party-disconnect checks measure the target's own grace window on their
 * first cleanup instead of assuming the scratch server's injected 700ms.
 *
 * Boots a scratch server, opens two WebSocket clients (a room host and a remote
 * player), and walks the host-authoritative flow the browser uses:
 *
 *   host  - creates a Ping Pong room, receives the pristine `room:state`,
 *           simulates it with the real engine and streams snapshots
 *   guest - joins, sends `input` actions, and renders the streamed snapshots
 *
 * It then proves the pieces the browser client depends on: the guest's controls
 * reach the host, the host's snapshots reach the guest, the host never receives
 * its own echo, and a finished snapshot closes the room.  A dropped host is
 * announced instead of silently freezing: the room names who takes over and the
 * handover deadline, the countdown withdraws if the host rejoins inside the
 * grace, and the migration clears it.  A host stall is
 * exercised end-to-end too: a real OnlineHost viewer's HUD must read
 * reconnecting (rate dashed), soften to recovering as frames return, then go
 * plain again - and a spectator watching the same stream must follow suit.
 *
 * `--stress` keeps one more match playing and stalls the host at seeded random
 * intervals - sometimes answering keyframes while stalled, sometimes frozen
 * until it resumes - so the recovery paths are exercised across varied timings
 * (--seed N replays a schedule, --stalls N resizes the run).
 *
 * A second section exercises the client-side netcode (web/js/netcode.js) used
 * by remote seats: snapshot blending on the arrival timeline and local-seat
 * prediction with eased reconciliation.  The client modules run headless on
 * a clean in-memory storage shim (tools/lib/storage-shim.mjs) so no ambient or
 * persisted state can leak into the run.
 *
 * A third exercises the host-side StreamClock: the fixed 1/60s timestep, its
 * real-time catch-up when browser timers fire late, and the fixed 20/s
 * snapshot grid that a slow timer must not be able to stretch.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installStorageShim } from './lib/storage-shim.mjs';
import { signInGuest, describeGuestWait } from './lib/guest-signin.mjs';
import { stopChild } from './lib/stop-child.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8831 + Math.floor(Math.random() * 40);
const DATA = path.join(ROOT, 'data', 'realtime-check');
const STRESS = process.argv.includes('--stress');
const argOf = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** A deployed build to test instead of a scratch server (see the header). */
const TARGET = String(argOf('--target', process.env.MEMES_TARGET || '')).trim().replace(/\/+$/, '');
if (TARGET && !/^https?:\/\//i.test(TARGET)) {
  console.error(`✗ --target must be an http(s) URL, got "${TARGET}"`);
  process.exit(2);
}

/** The party and room disconnect graces this run expects. Scratch servers boot
 *  with 700ms injected for both; a deployed target runs its own (usually the
 *  20s default), which the disconnect checks measure on the first cleanup and
 *  then reuse for the checks that follow. */
let graceMs = 700;
let roomGraceMs = 700;

let failures = 0;
let passed = 0;
const check = (ok, label, detail = '') => {
  if (ok) passed++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * deterministic client storage
 * ------------------------------------------------------------------ */

/** Install before the web/ modules below are imported, so nothing they read
 *  can come from ambient or persisted state.  The helper (tools/lib/
 *  storage-shim.mjs) counts every access; those counters back the "never
 *  touch persisted state" check at the end of main(). */
const storage = installStorageShim();

/** A seeded PRNG (mulberry32), so a randomized stress run can be replayed. */
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * server under test
 * ------------------------------------------------------------------ */

let child = null;
let base = TARGET || `http://127.0.0.1:${PORT}`;
/** The websocket origin that matches base (https -> wss). */
const WS_BASE = base.replace(/^http/i, 'ws');

async function waitForHealth(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function startServer() {
  rmSync(DATA, { recursive: true, force: true });
  console.log(`\nBooting a scratch server on port ${PORT}…`);
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    // A long waiting-room countdown keeps the suite in charge of when its rooms
    // start: the arming and clearing are asserted below, and no check waits for
    // an automatic start to fire.
    env: { ...process.env, MEMES_PORT: String(PORT), MEMES_HOST: '127.0.0.1', MEMES_DATA: DATA, MEMES_PLATFORM: 'realtime-check', MEMES_PARTY_GRACE_MS: '700', MEMES_ROOM_GRACE_MS: '700', MEMES_AUTO_START_MS: '60000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
  if (!(await waitForHealth(base))) throw new Error('the scratch server never answered /api/health');
}

/**
 * Stop the scratch server and wait for it to be gone: its shutdown flush would
 * re-create the data dir the suite removes next (see lib/stop-child.mjs).
 */
async function stopServer() {
  const dying = child;
  child = null;
  await stopChild(dying);
}

async function guest(name) {
  // A deployed target shares its guest quota across clients (six per IP per
  // five minutes), so wait it out rather than fail a re-run against staging.
  const signin = await signInGuest(base, { name }, { onWait: (wait) => console.log(`  note  ${describeGuestWait(wait)}`) });
  const payload = signin.json;
  if (!payload?.token) {
    throw new Error(signin.status === 429
      ? `guest sign-in for ${name} is still rate limited after ${Math.round(signin.waitedMs / 1000)}s of backoff (the target allows six guests per IP per five minutes)`
      : `guest sign-in failed for ${name} (HTTP ${signin.status})`);
  }
  const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${payload.token}` } });
  const user = (await me.json())?.user;
  if (!user?.id) throw new Error(`session lookup failed for ${name}`);
  return { token: payload.token, id: user.id, name: user.name };
}

/* ------------------------------------------------------------------ *
 * a tiny client that records what the server says
 * ------------------------------------------------------------------ */

class Client {
  constructor(label) {
    this.label = label;
    this.messages = [];
    this.ws = null;
  }

  connect(account) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(account.token)}`);
      this.ws.onopen = () => {
        this.send({ t: 'hello', v: '1.0.0', kind: 'web' });
        resolve();
      };
      this.ws.onerror = () => reject(new Error(`${this.label} websocket failed`));
      this.ws.onmessage = (ev) => {
        try {
          // Stamp the arrival so timing checks (a keyframe answering a stall)
          // can tell when the server said it.
          this.messages.push({ ...JSON.parse(ev.data), at: Date.now() });
        } catch {}
      };
    });
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  /** Every message of a type, newest last. */
  of(type, filter = null) {
    return this.messages.filter((m) => m.t === type && (!filter || filter(m)));
  }

  async waitFor(type, filter = null, timeoutMs = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const hit = this.of(type, filter).slice(-1)[0];
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

/** A DOM-less stand-in for the .net-hud readout: its text and class toggles. */
function hudStub() {
  const classes = new Set(['net-hud']);
  return {
    hidden: true,
    textContent: '',
    classList: {
      contains: (name) => classes.has(name),
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * client netcode: interpolation + prediction
 * ------------------------------------------------------------------ */

function netcodeChecks(engine, { SnapshotBuffer, Predictor, blendWorld, patchLocalSeat, netHudText, roomAlertText, hostStreamText, KeyframeGate, LinkSignal, INTERP_DELAY, MIN_INTERP_DELAY, MAX_INTERP_DELAY }) {
  console.log('\nClient netcode (interpolation + prediction)…');

  /* world blending */
  const blend = blendWorld(
    { x: 0, alive: true, shots: [{ x: 0, owner: 'a' }, { x: 400, owner: 'b' }], paddles: { p1: { y: 10 } } },
    { x: 10, alive: false, shots: [{ x: 10, owner: 'a' }, { x: 90, owner: 'c' }], paddles: { p1: { y: 30 } } },
    0.5,
  );
  check(blend.x === 5, 'numbers slide between snapshots');
  check(blend.alive === false, 'booleans take the newer snapshot');
  check(blend.shots.length === 2, 'despawned items leave the blend');
  check(blend.shots[0]?.x === 5 && blend.shots[0]?.owner === 'a', 'array items blend with their match');
  check(blend.shots[1]?.x === 90 && blend.shots[1]?.owner === 'c', 'new items appear at full position');
  check(blend.paddles.p1.y === 20, 'keyed seat bags blend field by field');

  /* the arrival timeline */
  const buffer = new SnapshotBuffer({ delay: INTERP_DELAY });
  check(buffer.sample(1000) === null, 'an empty buffer renders nothing');
  buffer.push({ ball: { x: 100 } }, 1000);
  buffer.push({ ball: { x: 200 } }, 1050);
  buffer.push({ ball: { x: 300 } }, 1100);
  check(buffer.sample(1000).ball.x === 100, 'at the oldest frame the world is exact');
  check(buffer.sample(1025).ball.x === 150, 'midpoints blend the two surrounding snapshots');
  check(buffer.sample(1099).ball.x === 298, 'blending reaches the newer frame');
  check(buffer.sample(9999).ball.x === 300, 'past the newest frame the world holds still');
  check(buffer.latest.ball.x === 300 && buffer.depth === 3, 'the timeline reports its newest frame');

  /* a 20Hz stream rendered at 60Hz */
  const timeline = new SnapshotBuffer({ delay: INTERP_DELAY });
  for (let i = 0; i <= 6; i++) timeline.push({ ball: { x: i * 50 } }, 2000 + i * 50);
  let previous = null;
  let worst = 0;
  let stalls = 0;
  let frames = 0;
  for (let at = 2000 + INTERP_DELAY + 20; at <= 2300 - 20; at += 1000 / 60) {
    const x = timeline.sample(at).ball.x;
    if (previous !== null) {
      const delta = x - previous;
      worst = Math.max(worst, delta);
      if (delta < 0.5) stalls++;
      frames++;
    }
    previous = x;
  }
  check(frames >= 8 && stalls === 0 && worst <= 18, `a 50ms snapshot stream renders as ${frames} even frames (worst step ${worst.toFixed(1)}px)`);

  /* the interpolation delay adapts to the measured stream */
  const adaptive = new SnapshotBuffer();
  check(adaptive.delay === INTERP_DELAY, 'the buffer starts at the default interpolation delay');
  let stamp = 5000;
  for (const gap of [30, 70, 25, 75, 35, 65, 40, 60, 20, 80, 45, 55]) {
    stamp += gap;
    adaptive.push({ n: stamp }, stamp);
  }
  check(Math.abs(adaptive.rate - 20) < 1, `the buffer measures the snapshot rate (${adaptive.rate.toFixed(1)}/s)`);
  check(adaptive.jitter > 10, `the buffer measures arrival jitter (${adaptive.jitter.toFixed(1)}ms)`);
  check(adaptive.delay > INTERP_DELAY, `a jittery stream widens the interpolation delay (${adaptive.delay.toFixed(1)}ms)`);
  check(adaptive.delay <= adaptive.maxDelay, 'the adaptive delay respects its ceiling');
  const widened = adaptive.delay;
  for (let i = 0; i < 40; i++) {
    stamp += 50;
    adaptive.push({ n: i }, stamp);
  }
  check(adaptive.delay < widened, `a settled stream narrows the delay again (${widened.toFixed(1)} → ${adaptive.delay.toFixed(1)}ms)`);
  check(adaptive.delay >= adaptive.minDelay && adaptive.delay <= adaptive.maxDelay, 'the narrowed delay stays inside its bounds');
  const fast = new SnapshotBuffer();
  for (let i = 0; i < 40; i++) fast.push({ n: i }, 9000 + i * 5);
  check(fast.delay >= MIN_INTERP_DELAY && fast.delay <= INTERP_DELAY, `an unusually fast stream stays above the floor (${fast.delay.toFixed(1)}ms)`);
  const stalled = new SnapshotBuffer();
  let stalledAt = 0;
  for (let i = 0; i < 30; i++) {
    stalledAt += i % 2 ? 400 : 20;
    stalled.push({ n: i }, stalledAt);
  }
  // The delay's ceiling now follows the measured cadence (see retune): a
  // stream whose arrivals are genuinely far apart is allowed to lag past its
  // own gap instead of running dry on every frame, so what matters here is the
  // behaviour - the cursor is never starved between arrivals - not the old
  // fixed 250ms bound.
  check(stalled.delay > 200, `a stalling stream widens the delay to cover its gaps (${stalled.delay.toFixed(1)}ms)`);
  let drySamples = 0;
  for (let at = stalledAt - 1200; at <= stalledAt; at += 20) if (stalled.starved(at)) drySamples++;
  check(drySamples === 0, `the widened delay keeps a jittery timeline fed between arrivals (${drySamples} dry samples)`);
  check(stalled.sample(stalledAt + 5000).n === 29, 'the adaptive timeline still samples the newest world');

  /* a host tab in the background streams about once a second: the timeline
     must stretch to that cadence, or every remote seat freezes solid the
     moment the browser clamps the host's timers */
  const sparse = new SnapshotBuffer();
  let sparseAt = 1_000_000;
  let sparseX = 0;
  for (let i = 0; i < 8; i++) {
    sparseX += 60;
    sparse.push({ ball: { x: sparseX } }, sparseAt);
    sparseAt += 1000;
  }
  const sparseNewestAt = sparseAt - 1000;
  check(sparse.delay > MAX_INTERP_DELAY, `a 1/s stream stretches the delay past the fast bound (${sparse.delay.toFixed(0)}ms)`);
  check(!sparse.starved(sparseNewestAt + 300), 'the stretched timeline is not dry 300ms after the newest frame');
  const sparseMid = sparse.sample(sparseNewestAt - 600).ball.x;
  const sparseNewest = sparse.sample(sparseNewestAt).ball.x;
  check(sparseMid > 0 && sparseMid < sparseNewest, `the picture keeps moving between the sparse frames (${sparseMid.toFixed(1)} → ${sparseNewest.toFixed(1)})`);

  /* the network readout line */
  const remoteHud = netHudText({ ping: 42.4, rate: 19.8, depth: 3, delay: 88 });
  check(remoteHud === 'ping 42ms · snap 19.8/s · buf 3 · delay 88ms', `remote seats see ping, rate, buffer depth and delay (${remoteHud})`);
  check(netHudText({ host: true, rate: 20 }) === 'ping – · snap 20.0/s · host', 'the host readout reports its stream rate instead of a buffer');
  check(netHudText({}).startsWith('ping –'), 'an unknown ping shows as a dash instead of a lie');
  const dryHud = netHudText({ ping: 42, rate: 0, depth: 24, delay: 90, state: 'reconnecting' });
  check(dryHud === 'ping 42ms · snap – · buf 24 · delay 90ms · reconnecting…', `a dry timeline reads as reconnecting (${dryHud})`);
  const refillHud = netHudText({ ping: 42, rate: 19.4, depth: 2, delay: 90, state: 'recovering' });
  check(refillHud === 'ping 42ms · snap 19.4/s · buf 2 · delay 90ms · recovering…', `a refilling buffer reads as recovering (${refillHud})`);
  check(netHudText({ ping: 42, rate: 20, depth: 24, delay: 90 }) === 'ping 42ms · snap 20.0/s · buf 24 · delay 90ms', 'a healthy timeline shows no cue');
  check(!netHudText({ ping: 1, rate: 20, depth: 3, delay: 80, state: 'weird' }).includes('weird'), 'an unknown cue is ignored');

  /* the room-host outage banner line (roomAlertText) */
  check(roomAlertText(null) === null && roomAlertText(undefined) === null, 'an intact room shows no outage banner');
  const outageText = roomAlertText({ hostName: 'Ada', nextName: 'Bo', until: 5000 }, 1000);
  check(outageText === 'Ada lost connection — Bo takes over in 4s.', `the banner names the next host and the seconds left (${outageText})`);
  check(roomAlertText({ hostName: 'Ada', until: 5000 }, 1000) === 'Ada lost connection — the room closes in 4s.',
    'with nobody left to take over the banner says the room closes');
  check(roomAlertText({ hostName: 'Ada', nextName: 'Bo', until: 4100 }, 4000).includes('in 1s'), 'a partial second still shows as a second');
  check(roomAlertText({ hostName: 'Ada', nextName: 'Bo', until: 5000 }, 5000) === 'Ada lost connection — Bo takes over now.',
    'a passed deadline reads as now, not a negative count');
  check(roomAlertText({ until: 1000 }, 5000) === 'The host lost connection — the room closes now.', 'an unnamed host still gets a line');

  /* the host-stream banner line (hostStreamText) */
  check(hostStreamText(null) === null && hostStreamText(undefined) === null, 'a healthy stream shows no room banner');
  const hiddenLine = hostStreamText({ hidden: true, hostName: 'Ada' });
  check(hiddenLine?.includes('Ada') && hiddenLine.includes('background tab'), `a hidden host tab is announced to the room (${hiddenLine})`);
  check(hostStreamText({ hidden: true, hostName: 'Ada' }, { self: true }).startsWith('Your tab is in the background'),
    'the host reads the same banner about their own tab');
  const streamStallLine = hostStreamText({ stalled: true, hidden: true, hostName: 'Ada' });
  check(streamStallLine?.includes('Ada') && streamStallLine.includes('stopped streaming'), `a stalled stream outranks a hidden tab (${streamStallLine})`);
  check(hostStreamText({ stalled: true }, { self: true }).startsWith('Your tab stopped streaming'),
    'the host is told to bring their tab back');
  check(hostStreamText({ hidden: true })?.startsWith('The host '), 'an unnamed host still gets a line', hostStreamText({ hidden: true }));

  /* the cue's state machine: dry -> reconnecting, refilling -> recovering */
  const signal = new LinkSignal();
  const cueTimeline = new SnapshotBuffer({ delay: 100, adapt: false });
  for (let i = 0; i < 6; i++) cueTimeline.push({ n: i }, 1000 + i * 50);
  check(signal.sample(cueTimeline, 1300) === null, 'a fed timeline shows no cue');
  check(signal.sample(cueTimeline, 1600) === 'reconnecting', 'a dry timeline reads as reconnecting');
  let resumed = 1600;
  for (let i = 0; i < 28; i++) {
    resumed += 50;
    cueTimeline.push({ n: i }, resumed);
  }
  check(signal.sample(cueTimeline, 1700) === 'recovering', 'the cue turns to recovering as frames return');
  check(signal.sample(cueTimeline, 3100) === null, 'the recovering cue fades once the buffer has settled');
  check(new LinkSignal().sample(null, 2000) === null, 'a host with no timeline shows no cue');

  /* a dry buffer notices the stall, so the seat can ask for a keyframe */
  const dry = new SnapshotBuffer();
  check(dry.starved(1000), 'an empty buffer counts as starving (a viewer that joined mid-stall has nothing to draw)');
  dry.push({ n: 0 }, 1000);
  check(!dry.starved(1000), 'one fresh frame is enough to stop starving');
  let fedAt = 1000;
  for (let i = 1; i <= 8; i++) {
    fedAt += 50;
    dry.push({ n: i }, fedAt);
  }
  check(!dry.starved(fedAt + dry.delay - 10), 'a live 20/s stream keeps the cursor fed');
  check(dry.starved(fedAt + dry.delay + 120), `once the cursor runs past the newest snapshot the buffer reports itself dry (delay ${dry.delay}ms)`);
  dry.push({ n: 9 }, fedAt + 500);
  check(!dry.starved(fedAt + 500), 'a keyframe refills the buffer the moment it lands');

  /* keyframe coalescing: one snapshot answers a whole window of requests */
  const gate = new KeyframeGate();
  check(gate.window === 50, 'the keyframe window defaults to one snapshot interval');
  check(gate.due(1000), 'the first viewer in a window gets a keyframe');
  check(!gate.due(1020) && !gate.due(1049), 'requests inside the window are absorbed by that keyframe');
  check(gate.due(1050), 'a request in the next window gets its own keyframe');
  gate.reset();
  check(gate.due(1051), 'a reset gate answers the very next request');
  check(!gate.due(1080, 1060), 'a snapshot that just went out absorbs the request instead');
  check(gate.due(1120, 1060), 'once that snapshot is outside the window a keyframe goes out again');
  const narrowGate = new KeyframeGate({ window: 10 });
  check(narrowGate.due(0) && narrowGate.due(10), 'the window is configurable');

  /* prediction: the seat reacts now, the host hears later */
  const seats = [
    { id: 'host', name: 'Host', avatar: '🙂', kind: 'human', level: 2 },
    { id: 'guest', name: 'Guest', avatar: '🙂', kind: 'human', level: 2 },
  ];
  const world = engine.create({ players: seats, seed: 4242, options: { target: 5, powerups: 0 } });
  const keys = { up: false, down: false, left: false, right: false, fire: false };
  const predictor = new Predictor({ engine, playerId: 'guest' });
  const startY = world.paddles.guest.y;
  const KEY_AT = 300;        // the player presses up
  const RELEASE_AT = 700;    // and lets go
  const LATENCY = 80;        // ms for the input to reach the host
  const SNAPSHOT_AGE = 100;  // ms between the host sampling a world and it arriving
  const STEP = 1000 / 60;
  const history = [];
  const snapshots = [];
  const samples = [];
  let lastSnap = -Infinity;
  let lastAnchor = -Infinity;
  let lastDelivered = null;
  for (let t = 0; t <= 1600; t += STEP) {
    keys.up = t >= KEY_AT && t < RELEASE_AT;
    history.push({ t, up: keys.up });
    let heard = history[history.length - 1];
    for (const entry of history) if (entry.t <= t - LATENCY) heard = entry;
    engine.act(world, 'guest', { type: 'input', up: heard.up });
    if (t - lastSnap >= 50) {
      lastSnap = t;
      snapshots.push({ at: t, state: JSON.parse(JSON.stringify(world)) });
    }
    engine.act(world, 'host', { type: 'tick', dt: STEP / 1000 });
    const delivered = snapshots.filter((snap) => snap.at <= t - SNAPSHOT_AGE).slice(-1)[0];
    if (delivered && delivered.at > lastAnchor) {
      lastAnchor = delivered.at;
      lastDelivered = delivered.state;
      predictor.anchor(delivered.state);
    }
    predictor.frame(keys, t);
    samples.push({ t, rendered: predictor.renderedPosition()?.y ?? NaN, authority: world.paddles.guest.y });
  }
  const at = (ms) => samples.find((sample) => sample.t >= ms);

  const instant = at(KEY_AT + 40);
  check(Number.isFinite(instant.rendered) && instant.rendered <= startY - 4, `the seat moves within a frame of the key (y ${startY.toFixed(0)} → ${instant.rendered?.toFixed(0)}, authority still ${instant.authority.toFixed(0)})`);
  check(Math.abs(instant.authority - startY) < 1, 'the authoritative paddle has not heard the key yet');
  const inFlight = at(KEY_AT + 170);
  check(inFlight.rendered <= inFlight.authority - 8, `prediction keeps its lead while the input is in flight (${(inFlight.authority - inFlight.rendered).toFixed(1)}px)`);
  const settled = at(1500);
  check(Math.abs(settled.rendered - settled.authority) <= 6, `reconciliation converges once input has landed (${(settled.authority - settled.rendered).toFixed(1)}px apart)`);
  let jump = 0;
  for (let i = 1; i < samples.length; i++) {
    const delta = Math.abs(samples[i].rendered - samples[i - 1].rendered);
    if (Number.isFinite(delta)) jump = Math.max(jump, delta);
  }
  check(jump <= 12, `corrections ease instead of snapping (largest frame-to-frame move ${jump.toFixed(1)}px)`);
  check(predictor.anchors >= 20 && predictor.steps >= 60, `the predictor re-anchored ${predictor.anchors} times over ${predictor.steps} local steps`);

  /* patching the predicted seat into a blended world */
  const olderWorld = JSON.parse(JSON.stringify(world));
  const newerWorld = JSON.parse(JSON.stringify(world));
  newerWorld.paddles.guest.y -= 10;
  newerWorld.paddles.host.y -= 30;
  const blended = patchLocalSeat(blendWorld(olderWorld, newerWorld, 0.5), predictor);
  const predictedY = (predictor.predictedEntity()?.entity.y ?? NaN) + predictor.offset.y;
  check(Math.abs(blended.paddles.guest.y - predictedY) < 1e-9, 'the local seat is drawn from prediction');
  check(Math.abs(blended.paddles.host.y - (world.paddles.host.y - 15)) < 1e-9, 'other seats keep the blended authority');
  check(Math.abs(olderWorld.paddles.guest.y - world.paddles.guest.y) < 1e-9, 'blending never mutates the snapshots');
  check(!!lastDelivered, 'snapshots flowed to the client during the prediction run');

  /* the ship and fighter seat bags use the same overlay */
  const shipWorld = patchLocalSeat({ ships: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 100, hp: 99 } } }, {
    playerId: 'p2',
    offset: { x: 3, y: -4 },
    predictedEntity: () => ({ bag: 'ships', entity: { x: 10, y: 20, vx: 1, vy: 2, angle: 0.5, hp: 5 } }),
  });
  check(shipWorld.ships.p2.x === 13 && shipWorld.ships.p2.y === 16, 'predicted ships move to the predicted pose');
  check(shipWorld.ships.p2.hp === 99 && shipWorld.ships.p1.x === 0, 'hull and other seats stay authoritative');

  const fighterWorld = patchLocalSeat({ fighters: { p3: { x: 1, y: 1, vx: 0, vy: 0, facing: 1, percent: 88, stocks: 1 } } }, {
    playerId: 'p3',
    offset: { x: 0, y: 0 },
    predictedEntity: () => ({ bag: 'fighters', entity: { x: 42, y: 7, vx: 5, vy: -6, facing: -1, percent: 0, stocks: 3 } }),
  });
  check(fighterWorld.fighters.p3.x === 42 && fighterWorld.fighters.p3.facing === -1, 'predicted fighters move to the predicted pose');
  check(fighterWorld.fighters.p3.percent === 88 && fighterWorld.fighters.p3.stocks === 1, 'damage and stocks stay authoritative');
}

/* ------------------------------------------------------------------ *
 * host stream clock: fixed timestep + catch-up + a steady 20/s grid
 * ------------------------------------------------------------------ */

function streamClockChecks(engine, { StreamClock }) {
  console.log('\nHost stream clock (fixed timestep + catch-up)…');

  const clock = new StreamClock();
  check(clock.step === 1000 / 60 && clock.interval === 50, 'the clock runs a fixed 1/60s step on a 50ms snapshot grid');

  /* the snapshot grid */
  clock.reset(1000);
  check(clock.snapshotDue(1000), 'the first snapshot slot is due as soon as the stream starts');
  check(!clock.snapshotDue(1049), 'no snapshot is due before the next slot');
  check(clock.snapshotDue(1050) && !clock.snapshotDue(1051), 'a snapshot falls due exactly on the grid, once');
  check(!clock.snapshotDue(1099) && clock.snapshotDue(1100), 'the grid stays 50ms wide after a send');
  check(clock.snapAt === 1150, 'the grid stays phase-locked to the wall clock, not to the last send');

  /* a late wake collapses the slots it missed into one fresh snapshot */
  const late = new StreamClock();
  late.reset(0);
  check(late.snapshotDue(310), 'a late wake still serves the snapshot the grid asked for');
  check(late.snapAt === 350, `the missed slots collapse into the next grid slot (${late.snapAt}ms)`);
  check(!late.snapshotDue(349) && late.snapshotDue(350), 'the cadence resumes on the grid at once, not 50ms after the late send');
  const stalled = new StreamClock();
  stalled.reset(0);
  check(stalled.snapshotDue(5000) && stalled.snapAt === 5050, 'a five-second stall collapses into a single snapshot, never a replay');

  /* fixed slices: a healthy timer spends real time in fixed 1/60s bites */
  const steady = new StreamClock();
  steady.reset(0);
  let at = 0;
  let slices = 0;
  for (let i = 0; i < 300; i++) {
    at += 16;
    slices += steady.advance(at);
  }
  check(slices >= 286 && slices <= 288, `4.8s of 16ms wakes simulate ${slices} fixed slices`);
  check(at - slices * steady.step <= steady.step, 'the bank never simulates past the wall clock');

  /* slow timers: the same real elapsed time, just fewer and bigger bites */
  const slow = new StreamClock();
  slow.reset(0);
  let slowAt = 0;
  let slowSlices = 0;
  let slowSends = 0;
  for (let i = 0; i < 80; i++) {
    slowAt += 90;
    slowSlices += slow.advance(slowAt);
    if (slow.snapshotDue(slowAt)) slowSends++;
  }
  check(Math.abs(slowSlices * slow.step - slowAt) <= slow.step, `a 90ms timer still simulates all ${slowAt}ms of real time (${(slowSlices * slow.step).toFixed(1)}ms)`);
  check(slowSends === 80, 'every late wake still sends its one snapshot (none are queued up or replayed)');
  check(slow.snapAt % slow.interval === 0, 'the grid stays aligned to the wall clock through the slow stretch');

  /* a long stall makes up at most the catch-up cap, never the whole pause */
  const pause = new StreamClock();
  pause.reset(0);
  const pauseSlices = pause.advance(60000);
  check(pauseSlices >= 1 && pauseSlices * pause.step <= pause.maxCatchup + 1e-6, `a one-minute pause warps the world at most ${pause.maxCatchup}ms (${pauseSlices} fixed slices)`);

  /* a hidden tab: the browser clamps its timers to about a second, so the bank
     takes that much real time and the world stays in step with the wall clock */
  const sleepy = new StreamClock();
  sleepy.reset(0);
  let sleepyAt = 0;
  let sleepyTime = 0;
  for (let i = 0; i < 30; i++) {
    sleepyAt += 1000;
    sleepyTime += sleepy.advance(sleepyAt, 5000) * sleepy.step;
  }
  check(Math.abs(sleepyTime - sleepyAt) <= sleepy.step, `a hidden tab's 1s wakes still simulate all ${sleepyAt}ms of real time (${sleepyTime.toFixed(0)}ms)`);
  const hiddenPause = sleepy.advance(sleepyAt + 60000, 5000);
  check(hiddenPause > 0 && hiddenPause * sleepy.step <= 5000 + 1e-6, `a minute-long hidden wake warps the world at most the background cap (${(hiddenPause * sleepy.step).toFixed(0)}ms)`);

  /* once the timer recovers, the full 20/s cadence is back immediately */
  const recovery = new StreamClock();
  recovery.reset(0);
  let recoveryAt = 0;
  for (let i = 0; i < 60; i++) {
    recoveryAt += 90;
    recovery.advance(recoveryAt);
    recovery.snapshotDue(recoveryAt);
  }
  const sends = [];
  for (let i = 0; i < 44; i++) {
    recoveryAt += 20;
    recovery.advance(recoveryAt);
    if (recovery.snapshotDue(recoveryAt)) sends.push(recoveryAt);
  }
  const gaps = sends.slice(1).map((t, i) => t - sends[i]);
  const rate = gaps.length ? 1000 / (gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) : 0;
  check(sends.length >= 17 && Math.abs(rate - 20) < 0.05, `a recovered timer streams at ${rate.toFixed(2)}/s straight away`);

  /* the real engine on the fixed-timestep loop: a slow timer cannot slow the match */
  const seats = [
    { id: 'host', name: 'Host', avatar: '🙂', kind: 'human', level: 2 },
    { id: 'guest', name: 'Guest', avatar: '🙂', kind: 'human', level: 2 },
  ];
  const world = engine.create({ players: seats, seed: 99, options: { target: 99, powerups: 0 } });
  const loop = new StreamClock();
  loop.reset(0);
  let loopAt = 0;
  let streamed = 0;
  for (let i = 0; i < 120; i++) {
    loopAt += 90;
    const due = loop.advance(loopAt);
    for (let s = 0; s < due; s++) engine.act(world, 'host', { type: 'tick', dt: loop.step / 1000 });
    if (loop.snapshotDue(loopAt)) streamed++;
  }
  check(Math.abs(world.time - loopAt / 1000) <= loop.step / 1000, `the world keeps real time through a slow timer (${world.time.toFixed(2)}s of ${(loopAt / 1000).toFixed(2)}s)`);
  check(streamed === 120, 'every late wake still carried a snapshot to the room');
  check(Number.isFinite(world.paddles.host.y) && !world.winnerId, 'the caught-up world is still a sane match');
}

/* ------------------------------------------------------------------ *
 * the flow
 * ------------------------------------------------------------------ */

async function run(engine, OnlineHost) {
  const hostAccount = await guest('Hosty');
  const guestAccount = await guest('Guesty');
  check(!!hostAccount.id && !!guestAccount.id, 'two guest accounts signed in');

  const host = new Client('host');
  const guestClient = new Client('guest');
  await host.connect(hostAccount);
  await guestClient.connect(guestAccount);
  check(await host.waitFor('welcome', null, 3000) !== null, 'host websocket completed the handshake');

  /* 0. round-trip ping (the network HUD's liveness measurement) */
  const sentAt = Date.now();
  host.send({ t: 'ping', ts: sentAt });
  const pong = await host.waitFor('pong', null, 3000);
  check(pong?.ts === sentAt, 'the server echoes the ping timestamp for round-trip timing');
  check(Number.isFinite(pong?.serverTime) && Date.now() - sentAt < 2000, `the round trip answered in ${Date.now() - sentAt}ms`);

  /* 1. room + seats */
  host.send({ t: 'room', op: 'create', gameId: 'pong', visibility: 'public', options: { target: 5 } });
  const created = await host.waitFor('game', (m) => m.room?.gameId === 'pong' && m.room?.status === 'lobby');
  const code = created?.room?.code;
  check(!!code, 'host opened a Ping Pong room', code ? `code ${code}` : 'no code');
  if (!code) return;

  check(created?.room?.autoStartAt === 0, 'a room sitting alone does not count down', String(created?.room?.autoStartAt));
  guestClient.send({ t: 'room', op: 'join', code });
  const joined = await guestClient.waitFor('game', (m) => m.room?.players?.length === 2);
  check(!!joined, 'guest joined the room', joined ? '' : 'guest never saw the room');
  check(joined?.room?.host === hostAccount.id, 'the room host is the first account');

  /* 1b. the waiting-room countdown: the moment a room has company it advertises
         when it will start itself, and the deadline travels to every seat. */
  const armed = await host.waitFor('game', (m) => m.room?.autoStartAt > 0, 3000);
  const armedAt = armed?.at || Date.now();
  const armedMs = Number(armed?.room?.autoStartMs);
  check(!!armed, 'a waiting room with company arms its auto-start countdown');
  check(Number.isFinite(armedMs) && armedMs >= 3000, 'the room advertises how long the countdown runs', String(armed?.room?.autoStartMs));
  check(armed?.room?.autoStartAt > armedAt && armed.room.autoStartAt - armedAt <= armedMs,
    'the countdown deadline sits inside the advertised window',
    `${armed?.room?.autoStartAt ? armed.room.autoStartAt - armedAt : '--'}ms of ${armedMs}ms`);
  const guestArmed = await guestClient.waitFor('game', (m) => m.room?.autoStartAt > 0, 3000);
  check(guestArmed?.room?.autoStartAt === armed?.room?.autoStartAt,
    'every seat is told the same deadline', String(guestArmed?.room?.autoStartAt));

  /* 2. start: the host is handed the pristine world */
  host.send({ t: 'room', op: 'start' });
  const startState = await host.waitFor('room:state', null, 3000);
  const state = startState?.state;
  check(!!state && Array.isArray(state.players), 'host received the authoritative room state');
  check(state?.players?.length === 2, `state has both seats`, String(state?.players?.length));
  check(!!state?.ball && !!state?.paddles?.[guestAccount.id], 'state carries the ball and every paddle');
  const playing = await host.waitFor('game', (m) => m.room?.status === 'playing');
  check(!!playing, 'the room reports itself as playing');
  await guestClient.waitFor('game', (m) => m.room?.status === 'playing');

  /* 3. the guest's controls reach the host (server relay) */
  guestClient.send({ t: 'game', action: { type: 'input', up: true } });
  const relayed = await host.waitFor('room:input', (m) => m.from === guestAccount.id, 3000);
  check(!!relayed, "the guest's input reached the host", relayed ? '' : 'no room:input message');
  check(relayed?.action?.up === true, 'the relayed action kept the key');
  check(host.of('room:input', (m) => m.from === hostAccount.id).length === 0, 'the server ignores a non-host streaming state');

  const apply = engine.act(state, relayed.from, relayed.action);
  check(apply?.ok !== false, 'the host engine accepted the forwarded input');

  /* 4. the host simulates and streams; the guest renders the snapshots */
  const guestPaddleY = () => state.paddles[guestAccount.id].y;
  const beforeY = guestPaddleY();
  let streamed = 0;
  for (let i = 0; i < 25; i++) {
    engine.act(state, hostAccount.id, { type: 'tick', dt: 1 / 30 });
    host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
    streamed++;
    await sleep(24);
  }
  const ticks = guestClient.of('tick', (m) => m.snapshot?.paddles);
  check(ticks.length >= 3, `the guest received ${ticks.length} streamed snapshots`);
  check(host.of('tick').length === 0, 'the host never received its own snapshots back');
  const latest = ticks.slice(-1)[0]?.snapshot;
  check(!!latest?.paddles?.[guestAccount.id], 'snapshots carry the guest paddle');
  check(guestPaddleY() < beforeY - 20, `the guest's held key moved its paddle up (${Math.round(beforeY)} → ${Math.round(guestPaddleY())})`);
  check(latest?.inputs?.[guestAccount.id]?.up === true, 'the streamed world remembers the guest input');
  check(latest?.time > 0.5, `the simulated clock advanced (${(latest?.time || 0).toFixed(2)}s)`);

  /* 4b. a starved guest asks the host for a keyframe (an extra snapshot) */
  const ticksBeforeAsk = guestClient.of('tick').length;
  guestClient.send({ t: 'game', action: { type: 'keyframe' } });
  const ask = await host.waitFor('room:request', (m) => m.from === guestAccount.id, 3000);
  check(ask?.kind === 'keyframe', 'the server relayed the keyframe request to the host');
  guestClient.send({ t: 'game', action: { type: 'keyframe' } });
  await sleep(150);
  check(host.of('room:request', (m) => m.from === guestAccount.id).length === 1, 'a repeat request inside the floor is dropped');
  const askedAt = Date.now();
  host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
  const keyframe = await guestClient.waitFor('tick', (m) => m.at >= askedAt, 1500);
  check(!!keyframe && keyframe.at - askedAt < 300, `the keyframe reached the starved guest in ${keyframe ? keyframe.at - askedAt : '--'}ms`);
  check(guestClient.of('tick').length > ticksBeforeAsk, 'the keyframe added a snapshot outside the regular cadence');

  /* 4c. a spectator may ask for a keyframe, but can never touch the match */
  const specAccount = await guest('Watchy');
  const spectator = new Client('spectator');
  await spectator.connect(specAccount);
  spectator.send({ t: 'room', op: 'join', code });
  const watching = await spectator.waitFor('game', (m) => m.spectating === true, 3000);
  check(!!watching, 'a late joiner became a spectator of the running match');
  host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
  const watchingTicks = await spectator.waitFor('tick', (m) => m.snapshot?.paddles, 3000);
  check(!!watchingTicks, 'spectators receive the snapshot stream too');
  const stateBeforeWatcher = JSON.stringify(state);
  spectator.send({ t: 'game', action: { type: 'keyframe' } });
  const specAsk = await host.waitFor('room:request', (m) => m.from === specAccount.id, 3000);
  check(specAsk?.kind === 'keyframe', 'the spectator keyframe request reached the host');
  check(JSON.stringify(state) === stateBeforeWatcher, 'the spectator request changed nothing in the match');
  spectator.send({ t: 'game', action: { type: 'keyframe' } });
  await sleep(150);
  check(host.of('room:request', (m) => m.from === specAccount.id).length === 1, 'the spectator floor drops a repeat request');
  const specAskedAt = Date.now();
  host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
  const specKeyframe = await spectator.waitFor('tick', (m) => m.at >= specAskedAt, 1500);
  check(!!specKeyframe && specKeyframe.at - specAskedAt < 300, `the spectator keyframe arrived in ${specKeyframe ? specKeyframe.at - specAskedAt : '--'}ms`);
  const errorsBefore = spectator.of('error').length;
  spectator.send({ t: 'game', action: { type: 'input', up: true } });
  const specErr = await spectator.waitFor('error', null, 1500);
  check(spectator.of('error').length > errorsBefore && /not seated/i.test(specErr?.message || ''), 'a spectator input is still refused');
  check(host.of('room:input', (m) => m.from === specAccount.id).length === 0, "the spectator's input never reached the host");
  spectator.send({ t: 'game', action: { type: 'tick', snapshot: { fake: true } } });
  const specStreamErr = await spectator.waitFor('error', (m) => /host streams|not seated/i.test(m.message || ''), 1500);
  check(!!specStreamErr, 'a spectator cannot stream a snapshot into the room');
  check(JSON.stringify(state) === stateBeforeWatcher, 'the refused attempts left the match untouched');
  check(state.inputs[specAccount.id] === undefined, 'no seat was created for the spectator');

  /* 4d. a herd of requests in the same window all reach the host */
  await sleep(800); // let the per-sender keyframe floors cool off
  const stormBefore = host.of('room:request').length;
  guestClient.send({ t: 'game', action: { type: 'keyframe' } });
  spectator.send({ t: 'game', action: { type: 'keyframe' } });
  await sleep(250);
  const storm = host.of('room:request').slice(stormBefore);
  check(storm.length === 2, `both viewers' requests in the same window reached the host (${storm.length})`);
  check(new Set(storm.map((m) => m.from)).size === 2, 'the herd came from two different viewers');

  /* 4f. the host's stream is the room's heartbeat: a hidden tab is announced
        the moment it hides, a stream that actually stops is called out to the
        room and to the host, and the first snapshot after a stall clears it */
  host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
  await sleep(150);
  check(!host.of('game').slice(-1)[0]?.room?.hostStream, 'a healthy stream puts no warning on the room');

  host.send({ t: 'room', op: 'visibility', hidden: true });
  const hiddenInfo = await guestClient.waitFor('game', (m) => m.room?.hostStream?.hidden === true, 2000);
  check(!!hiddenInfo, 'a hidden host tab shows up in the room state');
  check(hiddenInfo?.room?.hostStream?.stalled === false, 'a hidden tab is not the same as a stalled stream');
  check(hiddenInfo?.room?.hostStream?.hostName === hostAccount.name, 'the warning names the host', hiddenInfo?.room?.hostStream?.hostName);
  const hiddenChat = await guestClient.waitFor('chat', (m) => /background tab/.test(m.message?.text || ''), 2000);
  check(!!hiddenChat, 'the room chat says why frames got choppier', hiddenChat?.message?.text);

  const gamesBefore = guestClient.of('game').length;
  guestClient.send({ t: 'room', op: 'visibility', hidden: true });
  await sleep(250);
  check(guestClient.of('game').length === gamesBefore, "a seat's visibility report is ignored");

  host.send({ t: 'room', op: 'visibility', hidden: false });
  const backInfo = await guestClient.waitFor('game', (m) => m.room?.hostStream === null, 2000);
  check(!!backInfo, 'coming back to the foreground clears the room warning');
  const backChat = await guestClient.waitFor('chat', (m) => /back in the foreground/.test(m.message?.text || ''), 2000);
  check(!!backChat, 'the room hears that the host is back');

  const stallAt = Date.now();
  const stalledInfo = await host.waitFor('game', (m) => m.at >= stallAt && m.room?.hostStream?.stalled === true, 8000);
  check(!!stalledInfo, `the room notices a silent host (${stalledInfo ? stalledInfo.at - stallAt : '--'}ms of quiet)`);
  check(stalledInfo?.room?.hostStream?.hidden === false, 'a stall stands on its own, not as a hidden tab');
  const stallChat = await guestClient.waitFor('chat', (m) => /stopped streaming/.test(m.message?.text || ''), 3000);
  check(!!stallChat, 'the room chat says the match is waiting on the host tab', stallChat?.message?.text);
  const hostWarned = await host.waitFor('notify', (m) => m.kind === 'host-stream', 3000);
  check(!!hostWarned, 'the host is warned directly');
  check((hostWarned?.text || '').includes('foreground'), 'the warning tells the host what to do', hostWarned?.text);

  host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
  const recovered = await host.waitFor('game', (m) => m.room?.hostStream === null, 3000);
  check(!!recovered, 'the first snapshot after a stall clears the warning');
  const recoverChat = await guestClient.waitFor('chat', (m) => /streaming again/.test(m.message?.text || ''), 3000);
  check(!!recoverChat, 'the room hears that the stream is back', recoverChat?.message?.text);

  /* 4e. a viewer's HUD reads a host stall as reconnecting, then recovering */
  const viewerHud = hudStub();
  const watcherHud = hudStub();
  const viewerRoom = { id: created.room.id, status: 'playing', host: hostAccount.id, players: joined?.room?.players || [] };
  const viewer = new OnlineHost({ mount: null, room: viewerRoom, view: null, playerId: guestAccount.id });
  const watcher = new OnlineHost({ mount: null, room: viewerRoom, view: null, playerId: specAccount.id });
  for (const remote of [viewer, watcher]) {
    remote.setEngine(engine);
    remote.liveCanvas = true; // keeps render() off the DOM - the readout is what is under test
  }
  viewer.netEl = viewerHud;
  watcher.netEl = watcherHud;
  let guestSeen = guestClient.of('tick').length;
  let specSeen = spectator.of('tick').length;
  const drainTicks = () => {
    for (const msg of guestClient.of('tick').slice(guestSeen)) if (msg.snapshot) viewer.applyTick(msg.snapshot);
    guestSeen = guestClient.of('tick').length;
    for (const msg of spectator.of('tick').slice(specSeen)) if (msg.snapshot) watcher.applyTick(msg.snapshot);
    specSeen = spectator.of('tick').length;
  };
  // A live 20/s burst from the wire: both readers build a real timeline.
  let healthySeen = null;
  for (let i = 0; i < 8; i++) {
    host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
    await sleep(50);
    drainTicks();
    if (i === 4) {
      viewer.updateNetHud();
      watcher.updateNetHud();
      healthySeen = { text: viewerHud.textContent, stale: viewerHud.classList.contains('stale'), recovering: viewerHud.classList.contains('recovering') };
    }
  }
  check(!!healthySeen && !healthySeen.stale && !healthySeen.recovering && !/reconnecting|recovering/.test(healthySeen.text), `a live stream shows a plain HUD (${healthySeen?.text})`);

  // The host goes quiet: the timeline runs dry and the readout must say so.
  const stallStart = Date.now();
  let staleSeen = null;
  let watcherStale = false;
  while (Date.now() - stallStart < 900) {
    viewer.updateNetHud();
    watcher.updateNetHud();
    if (!staleSeen && viewerHud.classList.contains('stale')) staleSeen = { at: Date.now(), text: viewerHud.textContent };
    if (watcherHud.classList.contains('stale')) watcherStale = true;
    await sleep(25);
  }
  check(!!staleSeen, 'a stalled stream flips the viewer HUD to stale');
  check(!!staleSeen && staleSeen.at - stallStart < 700, `the reconnecting cue arrived ${staleSeen ? staleSeen.at - stallStart : '--'}ms into the stall`);
  check(!!staleSeen && staleSeen.text.endsWith('reconnecting…') && staleSeen.text.includes('snap –'), `the dry readout reads reconnecting with no rate (${staleSeen?.text || 'no sample'})`);
  check(watcherStale, 'a spectator gets the reconnecting cue too');

  // Frames return: the cue softens to recovering, then fades while the stream
  // keeps flowing (a stopped stream would only starve again - correctly).
  let recoveringSeen = null;
  let watcherRecovering = false;
  let clearedSeen = null;
  for (let i = 0; i < 34; i++) {
    host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
    await sleep(50);
    drainTicks();
    viewer.updateNetHud();
    watcher.updateNetHud();
    if (!recoveringSeen && viewerHud.classList.contains('recovering')) recoveringSeen = { text: viewerHud.textContent };
    if (watcherHud.classList.contains('recovering')) watcherRecovering = true;
    if (!clearedSeen && recoveringSeen && !viewerHud.classList.contains('stale') && !viewerHud.classList.contains('recovering')) clearedSeen = { text: viewerHud.textContent };
  }
  check(!!recoveringSeen, 'a refilling stream reads as recovering');
  check(!!recoveringSeen && recoveringSeen.text.endsWith('recovering…'), `the refilled readout says recovering (${recoveringSeen?.text || 'no sample'})`);
  check(watcherRecovering, 'a spectator recovers too');
  check(!!clearedSeen && !/reconnecting|recovering/.test(clearedSeen.text), `the cue clears once the stream is healthy again (${clearedSeen?.text || 'not within the burst'})`);

  /* 5. a finished snapshot closes the room for everyone */
  state.winnerId = [hostAccount.id];
  state.summary = 'Test sweep!';
  host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
  const finished = await host.waitFor('game', (m) => m.room?.status === 'finished', 3000);
  check(!!finished, 'the room finished when the streamed world reported a winner');
  check(finished?.view?.result?.winners?.[0] === hostAccount.id, 'the result names the winner');
  const guestFinished = await guestClient.waitFor('game', (m) => m.room?.status === 'finished', 3000);
  check(!!guestFinished, 'the guest saw the finished room too');

  /* a keyframe request after the whistle is dropped quietly */
  const requestsBefore = host.of('room:request').length;
  guestClient.send({ t: 'game', action: { type: 'keyframe' } });
  await sleep(150);
  check(host.of('room:request').length === requestsBefore, 'a keyframe request after the finish is ignored');
  check(guestClient.of('error').length === 0, 'the dropped request does not pop an error');
  const specErrorsBefore = spectator.of('error').length;
  spectator.send({ t: 'game', action: { type: 'keyframe' } });
  await sleep(150);
  check(host.of('room:request').length === requestsBefore, 'a spectator keyframe after the finish is ignored too');
  check(spectator.of('error').length === specErrorsBefore, 'the dropped spectator request does not pop an error');

  /* 6. parties: a dropped member is marked offline at once, then cleaned up
        after the grace window - unless they reconnect inside it. The room
        accounts are reused so the guest rate limit stays untouched. */
  host.send({ t: 'party', op: 'create' });
  const partyMade = await host.waitFor('party', (m) => m.party?.members?.length === 1, 3000);
  const partyCode = partyMade?.party?.code;
  check(!!partyCode, 'a party is open for the disconnect checks', partyCode ? `code ${partyCode}` : 'no party');
  if (partyCode) {
    guestClient.send({ t: 'party', op: 'join', code: partyCode });
    const joinAt = Date.now();
    const joinedParty = await host.waitFor('party', (m) => m.at >= joinAt && m.party?.members?.length === 2, 3000);
    check(!!joinedParty, 'the second account joined the party');
    const mateRow = () => host.of('party').slice(-1)[0]?.party?.members?.find((m) => m.id === guestAccount.id);
    check(mateRow()?.presence === 'online', 'party members carry presence', mateRow()?.presence);

    const dropAt = Date.now();
    guestClient.close();
    const offline = await host.waitFor('party', (m) => m.at >= dropAt && m.party?.members?.some((x) => x.id === guestAccount.id && x.presence === 'offline'), 3000);
    check(!!offline, 'a dropped member is marked offline right away');

    // Scratch servers boot with a 700ms grace; a deployed target runs its own
    // (usually the 20s default), so measure it here and reuse it below.
    const cleaned = await host.waitFor('party', (m) => m.at >= dropAt && m.party?.members?.length === 1, TARGET ? 45000 : 4000);
    check(!!cleaned && !cleaned.party.members.some((m) => m.id === guestAccount.id), 'the ghost is removed after the grace window');
    if (TARGET && cleaned) graceMs = Math.max(500, cleaned.at - dropAt + 1000);
    check(cleaned?.party?.leader === hostAccount.id, 'the remaining member keeps the party');
    // The cleanup says goodbye: the rest of the party sees who left and why.
    const goodbye = await host.waitFor('chat', (m) => m.message?.kind === 'system' && /left the party/i.test(m.message?.text || ''), 3000);
    check(!!goodbye && (goodbye.message.text || '').includes(guestAccount.name), 'the grace cleanup leaves a system line naming the member', goodbye?.message?.text);

    /* 6b. the return trip: the seat was reclaimed above, so the reconnecting
           member is offered the party back - and taking it says they are back.
           Then a reconnect inside the grace keeps the seat (a reload or a blip). */
    await guestClient.connect(guestAccount);
    const offer = await guestClient.waitFor('notify', (m) => m.kind === 'party-rejoin', 3000);
    check(offer?.code === partyCode, 'a reclaimed member is offered the party back on return',
      JSON.stringify(offer ? { kind: offer.kind, code: offer.code, text: offer.text } : null));
    const rejoinAt = Date.now();
    guestClient.send({ t: 'party', op: 'join', code: offer?.code || partyCode });
    const rejoined = await host.waitFor('party', (m) => m.at >= rejoinAt && m.party?.members?.some((x) => x.id === guestAccount.id && x.presence === 'online'), 3000);
    check(!!rejoined, 'the member rejoins for the reconnect check');
    const backLine = await host.waitFor('chat', (m) => m.at >= rejoinAt && /rejoined the party/.test(m.message?.text || ''), 3000);
    check(!!backLine && (backLine.message.text || '').includes(guestAccount.name),
      'the return is announced with its own system line', backLine?.message?.text);

    // The offer is spent on use: leaving on purpose and rejoining is a welcome.
    const ticketAt = Date.now();
    guestClient.send({ t: 'party', op: 'leave' });
    const outAgain = await host.waitFor('party', (m) => m.at >= ticketAt && !m.party?.members?.some((x) => x.id === guestAccount.id), 3000);
    check(!!outAgain, 'the member leaves for the spent-ticket check');
    const plainJoinAt = Date.now();
    guestClient.send({ t: 'party', op: 'join', code: partyCode });
    const plainLine = await host.waitFor('chat', (m) => m.at >= plainJoinAt && m.message?.text === `${guestAccount.name} joined the party.`, 3000);
    check(!!plainLine, 'a spent offer rejoins with a plain welcome', plainLine?.message?.text);
    const secondDropAt = Date.now();
    guestClient.close();
    const offlineAgain = await host.waitFor('party', (m) => m.at >= secondDropAt && m.party?.members?.some((x) => x.id === guestAccount.id && x.presence === 'offline'), 3000);
    check(!!offlineAgain, 'the second drop marks the dot offline again');
    await sleep(250); // comfortably inside even a long target grace
    const reconnectAt = Date.now();
    await guestClient.connect(guestAccount);
    const greenAgain = await host.waitFor('party', (m) => m.at >= reconnectAt && m.party?.members?.some((x) => x.id === guestAccount.id && x.presence === 'online'), 2500);
    check(!!greenAgain, 'a reconnect inside the grace turns the dot green again');
    await sleep(Math.max(1200, graceMs + 500)); // let the grace pass; the seat must still be there
    const lateGhost = host.of('party', (m) => m.at >= reconnectAt && (m.party?.members?.length || 0) < 2);
    check(lateGhost.length === 0, 'the seat survives when the member reconnects inside the grace', String(lateGhost.length));
    const falseGoodbyes = host.of('chat', (m) => m.at >= reconnectAt && /left the party/i.test(m.message?.text || '') && (m.message?.text || '').includes(guestAccount.name));
    check(falseGoodbyes.length === 0, 'a reconnect inside the grace writes no departure line', JSON.stringify(falseGoodbyes.map((m) => m.message.text)));

    /* 6c. the leader drops; the lead moves to the member left behind. */
    const leadDropAt = Date.now();
    host.close();
    const moved = await guestClient.waitFor('party', (m) => m.at >= leadDropAt && m.party?.members?.length === 1, Math.max(4000, graceMs + 2000));
    check(moved?.party?.leader === guestAccount.id && moved?.party?.members?.[0]?.host === true, 'leadership moves when the leader disconnects', moved?.party?.leader);
    const leadLine = await guestClient.waitFor('chat', (m) => /left the party/i.test(m.message?.text || '') && (m.message?.text || '').includes(hostAccount.name), 3000);
    check(!!leadLine, "the leader's cleanup writes the same line for the member left behind", leadLine?.message?.text);
    guestClient.close();

    /* 6d. once the last member is gone the party stops existing. */
    await sleep(Math.max(1200, graceMs + 500));
    const partyProbe = new Client('party-probe');
    await partyProbe.connect(guestAccount);
    const disbanded = await partyProbe.waitFor('party', (m) => m.party === null, 3000);
    check(!!disbanded, 'the party is disbanded after its last member disconnects');
    partyProbe.close();
  }

  /* 6e. joining or starting a party is a move, not an addition: an account can
        never sit in two parties.  The socket's own partyId cannot be trusted
        (it goes stale after a reload or an invite link), so the store decides
        what there is to leave - otherwise the disconnect grace reclaims the
        seat in whichever party it finds first and the other one keeps a ghost
        member who can never be cleaned up. */
  const mHost = new Client('move-host');
  const mGuest = new Client('move-guest');
  await mHost.connect(hostAccount);
  await mGuest.connect(guestAccount);
  mHost.send({ t: 'party', op: 'create' });
  const firstParty = await mHost.waitFor('party', (m) => m.party?.members?.length === 1, 3000);
  const firstCode = firstParty?.party?.code;
  check(!!firstCode, 'a party is open for the move checks', firstCode ? `code ${firstCode}` : 'no party');
  if (firstCode) {
    mGuest.send({ t: 'party', op: 'join', code: firstCode });
    const guestInFirst = await mHost.waitFor('party', (m) => m.party?.members?.some((x) => x.id === guestAccount.id), 3000);
    check(!!guestInFirst, 'the mover joins the first party');
    // The same account now starts a party of its own: a move, not a second seat.
    const moveAt = Date.now();
    mGuest.send({ t: 'party', op: 'create' });
    const ownParty = await mGuest.waitFor('party', (m) => m.at >= moveAt && m.party?.members?.length === 1, 3000);
    check(!!ownParty, 'the mover starts their own party', ownParty?.party?.code);
    const leftBehind = await mHost.waitFor('party', (m) => m.at >= moveAt && m.party?.members?.length === 1, 3000);
    check(!!leftBehind && !leftBehind.party.members.some((x) => x.id === guestAccount.id),
      'starting another party leaves the first one', JSON.stringify(leftBehind?.party?.members?.map((x) => x.name)));
    const moveLine = await mHost.waitFor('chat',
      (m) => m.at >= moveAt && m.message?.kind === 'system' && m.message.text === `${guestAccount.name} left for another party.`, 3000);
    check(!!moveLine, 'the party left behind says where they went', moveLine?.message?.text);
    // The only seat left is the one they hold now: dropping out reclaims it
    // there, and the party they already left writes no second goodbye.
    const moverGoneAt = Date.now();
    mGuest.close();
    await sleep(Math.max(1200, graceMs + 500));
    const moveProbe = new Client('move-probe');
    await moveProbe.connect(guestAccount);
    const seatGone = await moveProbe.waitFor('party', (m) => m.party === null, 3000);
    check(!!seatGone, 'the grace reclaims the seat in the party they were really in');
    const strayGoodbyes = mHost.of('chat',
      (m) => m.at >= moverGoneAt && /left/i.test(m.message?.text || '') && (m.message?.text || '').includes(guestAccount.name));
    check(strayGoodbyes.length === 0, 'the party they left writes no second goodbye',
      JSON.stringify(strayGoodbyes.map((m) => m.message.text)));
    moveProbe.close();
  }
  mHost.close();
  mGuest.close();

  host.close();
  guestClient.close();
  spectator.close();

  /* 7. room seats: a dropped member keeps their seat through the grace window
        - and loses it after - and a live match survives its host dropping.
        The remaining seat takes over, is handed the authoritative state, and
        streaming continues from it. */
  const rHost = new Client('room-host');
  const rGuest = new Client('room-guest');
  const rWatch = new Client('room-watch');
  await rHost.connect(hostAccount);
  await rGuest.connect(guestAccount);
  await rWatch.connect(specAccount);
  rHost.send({ t: 'room', op: 'create', gameId: 'pong', visibility: 'public', options: { target: 99 } });
  const freshRoom = await rHost.waitFor('game', (m) => m.room?.gameId === 'pong' && m.room?.status === 'lobby', 4000);
  const seatCode = freshRoom?.room?.code;
  check(!!seatCode, 'a room is open for the seat-grace checks', seatCode ? `code ${seatCode}` : 'no room');
  if (seatCode) {
    rGuest.send({ t: 'room', op: 'join', code: seatCode });
    const tookSeat = await rHost.waitFor('game', (m) => m.room?.players?.length === 2, 3000);
    check(!!tookSeat, 'the second account takes a seat in the room');

    // The waiting room's Invite button: a member asks a friend in one tap, and
    // the notification carries everything that friend needs to join.
    const invitedAt = Date.now();
    rHost.send({ t: 'room', op: 'invite', name: specAccount.name });
    const invite = await rWatch.waitFor('notify', (m) => m.at >= invitedAt && m.kind === 'room-invite', 3000);
    check(!!invite, 'a room invite reaches the friend as a notification');
    check(invite?.code === seatCode && invite?.roomId === freshRoom?.room?.id && invite?.from?.id === hostAccount.id,
      'the invite carries the room code, its id and who sent it',
      JSON.stringify(invite ? { code: invite.code, roomId: invite.roomId, from: invite.from?.name } : null));
    rHost.send({ t: 'room', op: 'invite', name: 'nobody-by-that-name' });
    const inviteError = await rHost.waitFor('error', (m) => m.at >= invitedAt && /User not found/.test(m.message || ''), 2000);
    check(!!inviteError, 'inviting a username nobody holds answers with an error');

    // The drop flips the seat offline at once; the grace then removes it.
    const seatDropAt = Date.now();
    rGuest.close();
    const greyed = await rHost.waitFor('game', (m) => m.at >= seatDropAt && m.view?.players?.some((p) => p.id === guestAccount.id && p.connected === false), 3000);
    check(!!greyed, 'a dropped seat is marked disconnected right away');
    check(greyed?.room?.players?.some((p) => p.id === guestAccount.id && p.connected === false),
      'the room list the UI renders ghosts the dropped seat', JSON.stringify(greyed?.room?.players));
    check(rHost.of('game', (m) => m.at >= seatDropAt && m.room?.hostOutage).length === 0,
      'a dropped guest seat raises no host-outage countdown');
    const seatCleaned = await rHost.waitFor('game', (m) => m.at >= seatDropAt && !m.room?.players?.some((p) => p.id === guestAccount.id), TARGET ? 45000 : 4000);
    check(!!seatCleaned, 'the disconnected seat is removed after the grace window', JSON.stringify(seatCleaned?.room?.players?.map((p) => p.name)));
    // A room left alone must stop counting down to a start that can no longer
    // happen - the deadline is withdrawn, not left as a stale promise.
    const disarmed = await rHost.waitFor('game', (m) => m.at >= seatDropAt && m.room?.players?.length === 1 && m.room?.autoStartAt === 0, 3000);
    check(!!disarmed, 'the countdown clears when the room is left alone', String(seatCleaned?.room?.autoStartAt));
    if (TARGET && seatCleaned) roomGraceMs = Math.max(500, seatCleaned.at - seatDropAt + 1000);

    // A blip inside the window keeps the seat - and it must survive the window.
    await rGuest.connect(guestAccount);
    const backAt = Date.now();
    rGuest.send({ t: 'room', op: 'join', code: seatCode });
    const reseated = await rHost.waitFor('game', (m) => m.at >= backAt && m.view?.players?.some((p) => p.id === guestAccount.id && p.connected !== false), 3000);
    check(!!reseated, 'a reconnect inside the grace takes the seat back and shows it online');
    check(reseated?.room?.players?.some((p) => p.id === guestAccount.id && p.connected !== false),
      'the room list un-ghosts the seat on reconnect');
    await sleep(Math.max(1200, roomGraceMs + 500));
    const neverRemoved = rHost.of('game', (m) => m.at >= backAt && !m.room?.players?.some((p) => p.id === guestAccount.id));
    check(neverRemoved.length === 0, 'the seat survives when the member reconnects inside the grace', String(neverRemoved.length));

    /* 7a. the host drops in the waiting room: the room must announce who takes
           over and when - and withdraw the countdown if the host makes it
           back inside the grace. */
    const hostBlipAt = Date.now();
    rHost.close();
    const lobbyOutage = await rGuest.waitFor('game', (m) => m.at >= hostBlipAt && m.room?.hostOutage, 3000);
    check(!!lobbyOutage, 'a dropped host announces the handover to the room');
    const lobbyDeadline = lobbyOutage ? lobbyOutage.room.hostOutage.until - lobbyOutage.at : 0;
    check(lobbyOutage?.room?.hostOutage?.hostName === hostAccount.name && lobbyOutage?.room?.hostOutage?.nextName === guestAccount.name,
      'the countdown names the absent host and who takes over', JSON.stringify(lobbyOutage?.room?.hostOutage));
    check(lobbyDeadline > roomGraceMs / 2 && lobbyDeadline <= roomGraceMs + 600,
      'the countdown runs to the end of the grace window', `${lobbyDeadline}ms of ${roomGraceMs}ms`);
    const lobbyLine = await rGuest.waitFor('chat', (m) => m.at >= hostBlipAt && /takes over in \d+s/.test(m.message?.text || ''), 2000);
    const saidSeconds = Number((lobbyLine?.message?.text.match(/takes over in (\d+)s/) || [])[1]);
    check(!!lobbyLine && saidSeconds === Math.max(1, Math.round(lobbyDeadline / 1000)),
      'the room chat announces the same handover', lobbyLine?.message?.text);

    await rHost.connect(hostAccount);
    const hostBackAt = Date.now();
    const withdrawn = await rGuest.waitFor('game', (m) => m.at >= hostBackAt && m.room?.hostOutage === null, 3000);
    check(!!withdrawn && withdrawn.room.host === hostAccount.id, 'a host reconnect inside the grace withdraws the countdown');
    const falseLines = rGuest.of('chat', (m) => m.at >= hostBackAt && /is hosting now/.test(m.message?.text || ''));
    check(falseLines.length === 0, 'a withdrawn handover writes no hosting line', JSON.stringify(falseLines.map((m) => m.message.text)));

    /* 7b. the host drops mid-match: their seat is cleaned up, the remaining
           seat takes over with the authoritative state, and the match keeps
           streaming through the new host. */
    rWatch.send({ t: 'room', op: 'join', code: seatCode, spectate: true });
    await rWatch.waitFor('game', (m) => m.room?.code === seatCode, 3000);
    rHost.send({ t: 'room', op: 'start' });
    const pristine = await rHost.waitFor('room:state', (m) => m.state != null, 3000);
    check(!!pristine?.state, 'the host starts with the authoritative match state');
    await rGuest.waitFor('game', (m) => m.room?.status === 'playing', 3000);
    await rWatch.waitFor('game', (m) => m.room?.status === 'playing', 3000);

    const hostDropAt = Date.now();
    rHost.close();
    // The freeze is announced before the graceful handover: the seated player
    // sees who takes over and the deadline, and spectators see it too.
    const matchOutage = await rGuest.waitFor('game', (m) => m.at >= hostDropAt && m.room?.hostOutage, 3000);
    check(!!matchOutage && matchOutage.room.hostOutage.nextName === guestAccount.name,
      'a mid-match host drop counts down the handover to the seated player', JSON.stringify(matchOutage?.room?.hostOutage));
    check(matchOutage?.room?.players?.some((p) => p.id === hostAccount.id && p.connected === false)
      && matchOutage?.room?.players?.some((p) => p.id === guestAccount.id && p.connected !== false),
      'a mid-match drop ghosts its seat in the room list and leaves the others solid',
      JSON.stringify(matchOutage?.room?.players));
    const matchLine = await rWatch.waitFor('chat', (m) => m.at >= hostDropAt && /takes over in \d+s/.test(m.message?.text || ''), 2000);
    check(!!matchLine, 'the countdown reaches the spectators too', matchLine?.message?.text);
    const migrated = await rGuest.waitFor('game', (m) => m.at >= hostDropAt && m.room?.host === guestAccount.id && !m.room?.players?.some((p) => p.id === hostAccount.id), Math.max(4000, roomGraceMs + 2000));
    check(!!migrated, 'the dropped host is cleaned up and the remaining seat takes over', migrated?.room?.host);
    check(migrated?.room?.hostOutage === null, 'the countdown clears when the handover lands');
    const handover = await rGuest.waitFor('room:state', (m) => m.state != null, 3000);
    check(!!handover?.state, 'the new host is handed the authoritative match state');

    const snapshot = { ...(handover?.state || pristine.state), score: { l: 1, r: 0 } };
    rGuest.send({ t: 'game', action: { type: 'tick', snapshot } });
    const streamed = await rWatch.waitFor('tick', (m) => m.snapshot?.score?.l === 1, 3000);
    check(!!streamed, 'the migrated host streams to the watchers');
  }
  rHost.close();
  rGuest.close();
  rWatch.close();
  return { hostAccount, guestAccount, specAccount };
}

/* ------------------------------------------------------------------ *
 * stress mode: random host stalls over one longer match
 * ------------------------------------------------------------------ */

/**
 * `run()` proves one stall and one recovery on a scripted timeline.  A stress
 * run keeps a match playing and lets a seeded PRNG decide when the host goes
 * quiet, for how long, and whether it can hear the room while quiet:
 *
 *   responsive host - its snapshot timer is throttled, but room messages still
 *     arrive, so every keyframe request is answered mid-stall (the viewer can
 *     dip back out of the cue while the stall continues)
 *   frozen host - no snapshots and no answers until it wakes; the requests
 *     queue up, and the first frame of the resume answers them all at once
 *
 * Every cycle must still end the same way: the viewer read the stall as
 * reconnecting with a dashed rate, asked for a keyframe, got healthy frames
 * back, softened to recovering and then cleared - and a spectator riding the
 * same stream followed the whole way.  Timings are random but seeded, so a run
 * replays exactly; `--seed N` explores other schedules and `--stalls N`
 * changes how many cycles the match runs.
 */
async function stressRun(engine, OnlineHost, accounts) {
  const { rt } = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'realtime.js')).href);
  const seed = (Number(argOf('--seed', '20261004')) || 20261004) >>> 0;
  const stallCount = Math.max(1, Number(argOf('--stalls', '5')) || 5);
  const rng = rngFrom(seed);
  console.log(`\nStress: ${stallCount} random host stalls through one longer match (seed ${seed})…`);
  console.log(`  replay with --seed ${seed} --stalls ${stallCount}`);

  const { hostAccount, guestAccount, specAccount } = accounts;
  const host = new Client('stress-host');
  const guestClient = new Client('stress-guest');
  const spectator = new Client('stress-watcher');
  for (const [client, account, label] of [[host, hostAccount, 'host'], [guestClient, guestAccount, 'guest'], [spectator, specAccount, 'spectator']]) {
    await client.connect(account);
    check(await client.waitFor('welcome', null, 3000) !== null, `the ${label} reconnected on the same account`);
  }

  /* a longer match: a target the run cannot reach keeps the room playing */
  host.send({ t: 'room', op: 'create', gameId: 'pong', visibility: 'public', options: { target: 99 } });
  const created = await host.waitFor('game', (m) => m.room?.gameId === 'pong' && m.room?.status === 'lobby', 4000);
  const code = created?.room?.code;
  check(!!code, 'the stress room opened', code ? `code ${code}` : 'no code');
  if (!code) return;
  guestClient.send({ t: 'room', op: 'join', code });
  const joined = await guestClient.waitFor('game', (m) => m.room?.players?.length === 2, 3000);
  check(!!joined, 'the guest took the second seat');
  host.send({ t: 'room', op: 'start' });
  const startState = await host.waitFor('room:state', null, 3000);
  const state = startState?.state;
  check(!!state?.paddles?.[guestAccount.id], 'the stress match started with both paddles');
  if (!state) return;
  await host.waitFor('game', (m) => m.room?.status === 'playing', 3000);
  await guestClient.waitFor('game', (m) => m.room?.status === 'playing', 3000);
  spectator.send({ t: 'room', op: 'join', code });
  const watching = await spectator.waitFor('game', (m) => m.spectating === true, 3000);
  check(!!watching, 'a spectator watches the stressed match');

  /* two real viewers: the seated guest runs the full per-frame netcode, the
     spectator only reads its HUD (the guest's socket carries the requests) */
  const viewerHud = hudStub();
  const watcherHud = hudStub();
  const room = { id: created.room.id, status: 'playing', host: hostAccount.id, players: joined?.room?.players || [] };
  const viewer = new OnlineHost({ mount: null, room, view: null, playerId: guestAccount.id });
  const watcher = new OnlineHost({ mount: null, room, view: null, playerId: specAccount.id });
  for (const remote of [viewer, watcher]) {
    remote.setEngine(engine);
    remote.liveCanvas = true; // no DOM: the netcode and the HUD stub are what is under test
  }
  viewer.netEl = viewerHud;
  watcher.netEl = watcherHud;

  /* In the browser the viewer's keyframe request goes out on the page's own
     websocket.  Capture that decision here and forward it on the real guest
     socket instead, so the server relay and the host's answer stay under test. */
  const realRtSend = rt.send;
  const askQueue = [];
  rt.send = (msg) => {
    if (msg?.t === 'game' && msg?.action?.type === 'keyframe') {
      askQueue.push(msg);
      return true;
    }
    return realRtSend.call(rt, msg);
  };

  let guestSeen = guestClient.of('tick').length;
  let specSeen = spectator.of('tick').length;
  let viewerTicks = 0;
  let lastViewerTickAt = 0;
  let hostFrozen = false;
  let requestSeen = 0;
  let streamed = 0;
  const queued = [];
  const drain = () => {
    for (const msg of guestClient.of('tick').slice(guestSeen)) {
      if (msg.snapshot) {
        viewer.applyTick(msg.snapshot);
        viewerTicks++;
        lastViewerTickAt = msg.at;
      }
    }
    guestSeen = guestClient.of('tick').length;
    for (const msg of spectator.of('tick').slice(specSeen)) if (msg.snapshot) watcher.applyTick(msg.snapshot);
    specSeen = spectator.of('tick').length;
  };
  /* what the browser host does when a viewer asks: push the freshest world */
  const pushSnapshot = () => {
    engine.act(state, hostAccount.id, { type: 'tick', dt: 1 / 20 });
    host.send({ t: 'game', action: { type: 'tick', snapshot: state } });
    streamed++;
  };
  const pumpRequests = (rec) => {
    const all = host.of('room:request');
    for (let i = requestSeen; i < all.length; i++) {
      if (all[i].kind !== 'keyframe') continue;
      rec.requestSeen++;
      if (hostFrozen) {
        queued.push(all[i]);
      } else {
        pushSnapshot();
        rec.answered++;
        rec.firstAnswerAt ||= Date.now();
      }
    }
    requestSeen = all.length;
  };
  const forwardAsks = (rec) => {
    while (askQueue.length) {
      askQueue.shift();
      guestClient.send({ t: 'game', action: { type: 'keyframe' } });
      rec.asked++;
      rec.firstAskAt ||= Date.now();
    }
  };
  const observe = (rec) => {
    viewer.netcodeFrame(); // the real per-frame entry: samples and asks when starved
    watcher.updateNetHud();
    forwardAsks(rec);
    if (viewerHud.classList.contains('stale')) {
      rec.staleAt ||= Date.now();
      rec.staleText ||= viewerHud.textContent;
    }
    if (viewerHud.classList.contains('recovering')) rec.recoveringAt ||= Date.now();
    if (rec.recoveringAt && rec.resumeAt && !rec.clearedAfterResumeAt && !viewerHud.classList.contains('stale') && !viewerHud.classList.contains('recovering')) rec.clearedAfterResumeAt = Date.now();
    if (rec.firstAskAt && lastViewerTickAt > rec.firstAskAt && !rec.refillAt) rec.refillAt = lastViewerTickAt;
    if (rec.resumeAt && lastViewerTickAt > rec.resumeAt && !rec.resumeTickAt) rec.resumeTickAt = lastViewerTickAt;
    if (watcherHud.classList.contains('stale')) rec.watcherStaleAt ||= Date.now();
    if (rec.watcherStaleAt && rec.resumeAt && !rec.watcherClearedAt && !watcherHud.classList.contains('stale') && !watcherHud.classList.contains('recovering')) rec.watcherClearedAt = Date.now();
  };
  const streamStep = async () => {
    pushSnapshot();
    await sleep(50);
    drain();
  };
  const age = (v) => (Number.isFinite(v) && v >= 0 ? `${Math.round(v)}ms` : '--');

  const cycles = [];
  try {
    /* warm-up: a healthy second builds the timeline and tunes the delay */
    const warmupEnd = Date.now() + 1200;
    while (Date.now() < warmupEnd) await streamStep();

    for (let i = 0; i < stallCount; i++) {
      const stallMs = 900 + Math.round(rng() * 800);
      const frozen = rng() < 0.5;
      const rec = { cycle: i + 1, stallMs, frozen, staleAt: 0, staleText: '', recoveringAt: 0, clearedAfterResumeAt: 0, asked: 0, requestSeen: 0, answered: 0, firstAskAt: 0, firstAnswerAt: 0, refillAt: 0, resumeAt: 0, resumeTickAt: 0, ticksAtResume: viewerTicks, timeBefore: state.time, watcherStaleAt: 0, watcherClearedAt: 0 };
      hostFrozen = frozen;
      const stallStart = Date.now();
      const stallEnd = stallStart + stallMs;
      while (Date.now() < stallEnd) {
        drain(); // a live viewer applies frames as they land, even mid-stall
        observe(rec);
        pumpRequests(rec);
        await sleep(25);
      }
      /* the host wakes: queued keyframe requests are answered by the first frame out */
      hostFrozen = false;
      rec.resumeAt = Date.now();
      if (queued.length) {
        queued.length = 0;
        pushSnapshot();
        rec.answered++;
        rec.firstAnswerAt ||= rec.resumeAt;
      }
      /* a sustained healthy burst: the cue softens to recovering, then clears */
      const settleEnd = Date.now() + 2400 + Math.round(rng() * 700);
      while (Date.now() < settleEnd) {
        await streamStep();
        observe(rec);
        pumpRequests(rec);
      }
      cycles.push(rec);

      const sawStall = rec.staleAt > 0 && rec.staleAt - stallStart < 1000 && rec.staleAt < stallEnd && /reconnecting…/.test(rec.staleText) && /snap –/.test(rec.staleText);
      check(sawStall, `cycle ${rec.cycle}: a ${rec.stallMs}ms ${frozen ? 'frozen' : 'responsive'} stall read as reconnecting with a dashed rate (${rec.staleAt ? `${rec.staleAt - stallStart}ms in` : 'never'})`);
      check(rec.asked >= 1 && rec.requestSeen >= 1, `cycle ${rec.cycle}: the starved viewer asked for a keyframe and the relay delivered it to the host`);
      const answeredWhen = frozen ? rec.firstAnswerAt >= rec.resumeAt : rec.firstAnswerAt > 0 && rec.firstAnswerAt < rec.resumeAt;
      check(rec.answered >= 1 && answeredWhen, `cycle ${rec.cycle}: the host answered the request (${frozen ? 'queued until the resume' : 'mid-stall'})`);
      const refill = frozen ? rec.resumeTickAt - rec.resumeAt : rec.refillAt - rec.firstAskAt;
      check(rec.answered >= 1 && refill > 0 && refill < 600, `cycle ${rec.cycle}: the answer refilled the viewer (${frozen ? 'post-resume tick' : 'answer'} in ${age(refill)})`);
      check(rec.recoveringAt > 0 && rec.clearedAfterResumeAt > 0 && rec.clearedAfterResumeAt - rec.resumeAt < 2400, `cycle ${rec.cycle}: the resumed stream softened to recovering, then cleared after ${age(rec.clearedAfterResumeAt - rec.resumeAt)}`);
      check(viewerTicks - rec.ticksAtResume >= 20 && state.time > rec.timeBefore + 0.5, `cycle ${rec.cycle}: the stream and the world carried on (${viewerTicks - rec.ticksAtResume} ticks, clock ${rec.timeBefore.toFixed(1)}s → ${state.time.toFixed(1)}s)`);
      check(rec.watcherStaleAt > 0 && rec.watcherStaleAt - stallStart < 1000 && rec.watcherStaleAt < stallEnd && rec.watcherClearedAt > 0 && rec.watcherClearedAt - rec.resumeAt < 2400, `cycle ${rec.cycle}: the spectator rode the stall and recovered too`);
    }

    /* after the last stall the stream must be fully healthy again */
    const finalEnd = Date.now() + 1500;
    while (Date.now() < finalEnd) await streamStep();
    viewer.netcodeFrame();
    watcher.updateNetHud();
    const frozenCount = cycles.filter((c) => c.frozen).length;
    console.log(`  ${frozenCount} frozen / ${stallCount - frozenCount} responsive stalls · ${streamed} snapshots · world clock ${state.time.toFixed(1)}s`);
    check(!viewerHud.classList.contains('stale') && !viewerHud.classList.contains('recovering') && /snap \d/.test(viewerHud.textContent), `the viewer ended healthy (${viewerHud.textContent})`);
    check(host.of('error').length === 0 && guestClient.of('error').length === 0 && spectator.of('error').length === 0, 'no socket errored during the stress run');
  } finally {
    rt.send = realRtSend;
    viewer.dispose();
    watcher.dispose();
    host.close();
    guestClient.close();
    spectator.close();
  }
}

/* ------------------------------------------------------------------ *
 * the host tab's own visibility
 * ------------------------------------------------------------------ */

/**
 * A hidden host tab is the one warning the server cannot see for itself until
 * the stream has already gone quiet, so the host's client reports it the
 * moment it hides - and marks its own tab while it is away.  This drives that
 * handler directly: the browser's visibility API cannot be faked in the
 * preview panel these checks are developed against, but the handler only reads
 * `document.visibilityState` and sends one room message, so a stand-in covers
 * it.  The handler also arms a "you were away, the room slowed down" notice on
 * return; that fires only after five seconds away (and needs a DOM to show), so
 * this test comes straight back and asserts the parts that do not touch it.
 */
function hostVisibilityChecks(OnlineHost, rt) {
  console.log('\nHost tab visibility…');
  const listeners = new Map();
  const titleBefore = 'Memes Arcade';
  const fakeDoc = {
    visibilityState: 'visible',
    title: titleBefore,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const sent = [];
  const realSend = rt.send;
  globalThis.document = fakeDoc;
  rt.send = (msg) => { sent.push(msg); return true; };
  try {
    const host = new OnlineHost({
      mount: null,
      room: { id: 'vis-room', status: 'playing', host: 'me', players: [], spectators: [] },
      view: null,
      playerId: 'me',
    });
    // The stream only runs with an engine and a world in hand.
    host.engine = { meta: { realtime: true }, over: () => ({ over: false }) };
    host.state = { winnerId: null, paddles: {} };
    host.liveCanvas = true; // keeps render() off the DOM
    check(listeners.has('visibilitychange'), 'the host listens for its tab hiding');

    fakeDoc.visibilityState = 'hidden';
    listeners.get('visibilitychange')();
    check(host.hidden === true, 'hiding the tab puts the host into background streaming');
    check(fakeDoc.title === `⚠ ${titleBefore}`, `the tab itself carries the warning (${fakeDoc.title})`);
    check(sent.some((m) => m.t === 'room' && m.op === 'visibility' && m.hidden === true),
      'the room is told the host tab hid', JSON.stringify(sent.slice(-1)[0] || null));

    // With the tab hidden the bank may hold a whole (clamped) second of real
    // time, instead of the 200ms a visible tab is held to.
    const clock = host.clock;
    clock.reset(0);
    const hiddenSteps = clock.advance(1000, host.hidden ? 5000 : clock.maxCatchup);
    check(Math.abs(hiddenSteps * clock.step - 1000) <= clock.step,
      `a hidden host still simulates a full second per delayed wake (${(hiddenSteps * clock.step).toFixed(0)}ms)`);

    fakeDoc.visibilityState = 'visible';
    listeners.get('visibilitychange')();
    check(host.hidden === false, 'coming back restores normal streaming');
    check(fakeDoc.title === titleBefore, 'the warning marker leaves the tab title');
    check(sent.some((m) => m.t === 'room' && m.op === 'visibility' && m.hidden === false), 'the room hears the host is back');

    host.dispose();
    check(!listeners.has('visibilitychange'), 'disposing the host drops the visibility listener');
  } finally {
    rt.send = realSend;
    delete globalThis.document;
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const engine = (await import(pathToFileURL(path.join(ROOT, 'web', 'games', 'engines', 'arcade.js')).href)).pong;
if (!engine?.meta?.realtime) {
  console.error('the pong engine is missing or is not marked realtime');
  process.exit(1);
}
const netcode = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'netcode.js')).href);
const { OnlineHost } = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'host.js')).href);
const { rt } = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'realtime.js')).href);

try {
  let ready = true;
  if (TARGET) {
    const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
    ready = check(health?.ok === true, 'the target answers the arcade /api/health', health ? `status ${health.status}, ${health.engines} engines` : 'unreachable or not the arcade API');
  }
  if (ready) {
    netcodeChecks(engine, netcode);
    streamClockChecks(engine, netcode);
    hostVisibilityChecks(OnlineHost, rt);
    if (!TARGET) await startServer();
    const accounts = await run(engine, OnlineHost);
    if (STRESS && accounts) await stressRun(engine, OnlineHost, accounts);
    check(storage.log.reads === 0 && storage.log.writes === 0, 'the headless client modules never touch persisted state', `${storage.log.reads} reads, ${storage.log.writes} writes`);
  }
} catch (err) {
  failures++;
  console.error(`\nRealtime check crashed: ${err.stack || err.message}`);
} finally {
  await stopServer();
  // Leave no scratch data behind: the stray-state check fails the build on any
  // suite that does (see tools/leak-check.mjs).
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${failures ? `✗ ${failures} failure(s), ${passed} passed` : `✓ all ${passed} realtime checks passed`}\n`);
process.exit(failures ? 1 : 0);
