/**
 * Arcade family: Ping Pong, Invade, Rocket Bot Royale and Mini Golf.
 *
 * Pong, Invade and Rocket Bot Royale are realtime: `meta.realtime` marks them
 * host-authoritative for the server, and the simulation lives in `act()`:
 *
 *   { type: 'input', up, down, fire, ... }  - a seat's controls
 *   { type: 'tick', dt }                    - advance the world (any seat)
 *
 * That means the same rules run in three places: the browser host drives ticks
 * from an animation loop, the test harness asks bots for ticks, and an online
 * room host streams snapshots.  Everything is plain JSON.
 *
 * Mini Golf is turn-based instead: the whole shot is simulated inside act()
 * and the render replays the recorded trail.
 */
import * as U from './util.js';
import * as UI from './ui.js';

const MODES = ['solo', 'local', 'online'];
const RT_MODES = MODES;
const TICK_MIN = 1 / 60;
const TICK_MAX = 0.1;
const SUBSTEP = 1 / 60;

/**
 * Advance the world in fixed slices.  A raw 100ms tick would let fast bullets
 * and balls tunnel straight through thin things, so every tick is broken into
 * 1/60s physics steps no matter how big the request was.
 */
function stepIncrements(stepFn, state, dt) {
  let remaining = Math.max(0, dt);
  let guard = 0;
  while (remaining > 0 && !state.winnerId && guard++ < 64) {
    const slice = Math.min(SUBSTEP, remaining);
    stepFn(state, slice);
    remaining -= slice;
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * shared realtime helpers
 * ------------------------------------------------------------------ */

function clampTick(dt) {
  const value = Number(dt);
  if (!Number.isFinite(value)) return 1 / 30;
  return U.clamp(value, TICK_MIN, TICK_MAX);
}

function blankInput() {
  return { up: false, down: false, left: false, right: false, fire: false };
}

function readInput(state, id) {
  return state.inputs[id] || blankInput();
}

function realtimeTurn(state) {
  return state.players.filter((p) => state.alive[p.id] !== false).map((p) => p.id);
}

function baseRealtime({ players, seed }) {
  const state = U.baseState({ players, seed });
  state.time = 0;
  state.inputs = {};
  state.alive = {};
  state.winnerId = null;
  for (const p of state.players) {
    state.inputs[p.id] = blankInput();
    state.alive[p.id] = true;
  }
  return state;
}

function realtimeAct(state, playerId, action, step) {
  if (state.winnerId) return { ok: false, error: 'Game over.' };
  if (action.type === 'input') {
    const seat = state.inputs[playerId];
    if (!seat) return { ok: false, error: 'Not in this match.' };
    for (const key of Object.keys(seat)) {
      if (action[key] !== undefined) seat[key] = !!action[key];
    }
    return { ok: true, events: [] };
  }
  if (action.type === 'tick') {
    const events = [];
    stepIncrements((s, slice) => step(s, slice, events), state, clampTick(action.dt));
    return { ok: true, events };
  }
  return { ok: false, error: 'Unknown action.' };
}

function realtimeBot(state) {
  if (state.winnerId) return null;
  return { type: 'tick', dt: 0.1 };
}

/**
 * Local host canvas loop shared by the realtime engines: mutate the live state
 * directly (we are the authority in solo/local play) and redraw the canvas,
 * without rebuilding the DOM every frame.  `view` based HUD text is refreshed
 * once per second and once when the match ends.
 */
function realtimeLoop({ wrap, box, state, host, draw, stepWorld, onEnd }) {
  let ended = false;
  UI.every(wrap, 33, () => {
    if (!state || state.winnerId) {
      if (!ended && state?.winnerId) {
        ended = true;
        onEnd?.(state);
      }
      return;
    }
    stepWorld(state, 1 / 30);
    draw();
  });
  return () => {};
}

/* ========================================================================= *
 * Ping Pong
 * ========================================================================= */

const PONG_W = 640;
const PONG_H = 380;
const PADDLE_H = 64;
const PADDLE_W = 10;
const PADDLE_SPEED = 360;
const BALL_R = 7;

export const pong = {
  meta: {
    id: 'pong',
    // What a good run at this game looks like, for the account's per-game record
    // (see bookRun in host.js): a pong "score" is the margin you won by.
    record: { best: 'high', label: 'win margin' },
    name: 'Ping Pong',
    category: 'arcade',
    players: { min: 2, max: 4 },
    modes: RT_MODES,
    realtime: true,
    simultaneous: true,
    blurb: 'Pong with spin, power-ups and a two-versus-two mode.',
    tags: ['arcade', 'quick'],
    minutes: 5,
    status: 'playable',
    bots: true,
    maxBots: 3,
    rules: [
      'Move your paddle up and down - the ball gets faster with every hit.',
      'Score by getting the ball past the other side. First to the target wins.',
      'Four players split into two teams, one paddle each.',
      'Pickups grant a bigger paddle or a slower ball.',
    ],
    options: [
      { id: 'target', label: 'Points to win', type: 'select', values: [3, 5, 7], default: 5 },
      { id: 'powerups', label: 'Power-ups', type: 'select', values: [1, 0], default: 1 },
    ],
  },
  create({ players, seed, options = {} }) {
    const state = baseRealtime({ players, seed });
    state.target = options.target || 5;
    state.powerups = options.powerups !== 0;
    state.score = { l: 0, r: 0 };
    state.teams = { l: [], r: [] };
    state.paddles = {};
    state.players.forEach((p, i) => {
      const side = i % 2 === 0 ? 'l' : 'r';
      state.teams[side].push(p.id);
      const slot = Math.floor(i / 2);
      const perSide = state.players.length > 2 ? 2 : 1;
      const span = PONG_H / perSide;
      state.paddles[p.id] = {
        x: side === 'l' ? 18 : PONG_W - 18 - PADDLE_W,
        y: span * slot + (span - PADDLE_H) / 2,
        side,
        slot,
        vy: 0,
      };
    });
    state.ball = { x: PONG_W / 2, y: PONG_H / 2, vx: 0, vy: 0, speed: 330 };
    state.effects = { grow: null, slow: null, ball: null };
    state.pickup = null;
    state.pickupTimer = 6;
    state.lastHit = null;
    serveBall(state, Math.random() < 0.5 ? -1: 1);
    U.addLog(state, 'First serve!');
    return state;
  },
  step(state, dt) {
    state.time += dt;
    // effects tick down
    for (const key of ['grow', 'slow', 'ball']) {
      const fx = state.effects[key];
      if (fx && fx.until <= state.time) state.effects[key] = null;
    }
    for (const p of state.players) {
      if (p.bot) pongAi(state, p.id, dt);
      movePaddle(state, p.id, dt);
    }
    const ball = state.ball;
    const slow = state.effects.slow ? 0.72 : 1;
    const speed = Math.hypot(ball.vx, ball.vy) || 1;
    const desired = ball.speed * slow;
    ball.vx = (ball.vx / speed) * desired;
    ball.vy = (ball.vy / speed) * desired;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    if (ball.y < BALL_R) {
      ball.y = BALL_R;
      ball.vy = Math.abs(ball.vy);
    }
    if (ball.y > PONG_H - BALL_R) {
      ball.y = PONG_H - BALL_R;
      ball.vy = -Math.abs(ball.vy);
    }
    // paddles
    for (const p of state.players) {
      const pad = state.paddles[p.id];
      const grow = state.effects.grow?.team === pad.side ? 1.5 : 1;
      const h = PADDLE_H * grow;
      const overlapsX = ball.x + BALL_R > pad.x && ball.x - BALL_R < pad.x + PADDLE_W;
      const overlapsY = ball.y + BALL_R > pad.y && ball.y - BALL_R < pad.y + h;
      const movingIn = pad.side === 'l' ? ball.vx < 0 : ball.vx > 0;
      if (overlapsX && overlapsY && movingIn) {
        const offset = (ball.y - (pad.y + h / 2)) / (h / 2);
        ball.vx = Math.abs(ball.vx) * (pad.side === 'l' ? 1 : -1);
        ball.vy += offset * 190;
        ball.speed = Math.min(720, ball.speed * 1.06);
        ball.x = pad.side === 'l' ? pad.x + PADDLE_W + BALL_R : pad.x - BALL_R;
        state.lastHit = pad.side;
        state.effects.ball = { team: pad.side, until: state.time + 0.9 };
      }
    }
    // pickups
    if (state.powerups) {
      state.pickupTimer -= dt;
      if (!state.pickup && state.pickupTimer <= 0) {
        state.pickup = { x: PONG_W * (0.3 + Math.random() * 0.4), y: 60 + Math.random() * (PONG_H - 120), kind: Math.random() < 0.5 ? 'grow' : 'slow' };
      }
      if (state.pickup) {
        if (Math.hypot(ball.x - state.pickup.x, ball.y - state.pickup.y) < 20) {
          state.effects[state.pickup.kind] = { team: state.lastHit || 'l', until: state.time + 7 };
          state.pickup = null;
          state.pickupTimer = 8 + Math.random() * 4;
          U.addLog(state, `${state.pickupText || ''}`, 'info');
        }
      }
    }
    // scoring
    if (ball.x < -12) {
      state.score.r++;
      serveBall(state, -1);
    } else if (ball.x > PONG_W + 12) {
      state.score.l++;
      serveBall(state, 1);
    }
    if (state.score.l >= state.target || state.score.r >= state.target) {
      const side = state.score.l >= state.target ? 'l' : 'r';
      state.winnerId = state.teams[side].slice();
      // The per-game score the arcade records: the winning side earns the
      // margin it won by, everyone else 0. It rides along in the snapshot as
      // `scores` (player id -> points), which is the shape the server reads
      // when it books the result - see recordGame in server/store.js.
      const margin = Math.abs(state.score.l - state.score.r);
      state.scores = Object.fromEntries(state.players.map((p) => [p.id, state.teams[side].includes(p.id) ? margin : 0]));
      state.summary = `Team ${side.toUpperCase()} takes the match ${state.score.l}-${state.score.r}!`;
      state.alive = Object.fromEntries(state.players.map((p) => [p.id, false]));
    }
  },
  act(state, playerId, action) {
    return realtimeAct(state, playerId, action, (s, dt, events) => {
      const res = pong.step(s, dt);
      if (s.winnerId && !s.summaryLogged) {
        s.summaryLogged = true;
        events.push(U.event(s.summary, 'win'));
      }
    });
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.time = state.time || 0;
    v.target = state.target;
    v.score = state.score;
    v.ball = state.ball;
    v.paddles = state.paddles;
    v.effects = state.effects;
    v.pickup = state.pickup || null;
    v.alive = state.alive;
    v.turn = realtimeTurn(state);
    return v;
  },
  bot(state) {
    return realtimeBot(state);
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, state, playerId, send, host }) {
    const stage = UI.realtimeStage({
      el,
      snapshot: state || view,
      width: PONG_W,
      height: PONG_H,
      draw: drawPong,
      hudText: (s) => `🟦 ${s.score?.l ?? 0} — ${s.score?.r ?? 0} 🟥 · first to ${s.target ?? 5}`,
    });
    const keys = blankInput();
    const { mode, cleanup } = UI.realtimeControls({ wrap: stage.wrap, host, state, playerId, keys, send });
    if (mode === 'local') {
      realtimeLoop({
        wrap: stage.wrap,
        box: stage.box,
        state,
        host,
        draw: () => stage.box.redraw(),
        stepWorld: (s, dt) => stepIncrements((st, slice) => pong.step(st, slice), s, dt),
        onEnd: () => host?.refresh?.(),
      });
    }
    const hint = 'Arrow keys / WASD to move. Power-ups: bigger paddle or a slower ball.';
    stage.wrap.appendChild(UI.muted(UI.realtimeHint(mode, hint, 'Watching the rally...')));
    return UI.withLive(cleanup, stage, { keys });
  },
};

function serveBall(state, dir) {
  state.ball.x = PONG_W / 2;
  state.ball.y = PONG_H / 2;
  state.ball.speed = 330;
  const angle = (Math.random() * 0.7 - 0.35);
  state.ball.vx = Math.cos(angle) * state.ball.speed * dir;
  state.ball.vy = Math.sin(angle) * state.ball.speed;
}

function movePaddle(state, id, dt) {
  const pad = state.paddles[id];
  if (!pad) return;
  const seat = state.players.find((p) => p.id === id);
  const input = readInput(state, id);
  const grow = state.effects.grow?.team === pad.side ? 1.5 : 1;
  const h = PADDLE_H * grow;
  const perSide = state.players.length > 2 ? 2 : 1;
  const top = perSide === 2 ? (PONG_H / 2) * pad.slot : 0;
  const bottom = perSide === 2 ? top + PONG_H / 2 : PONG_H;
  const dir = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  pad.y = U.clamp(pad.y + dir * PADDLE_SPEED * dt, top + 4, bottom - h - 4);
}

function pongAi(state, id, dt) {
  const pad = state.paddles[id];
  if (!pad) return;
  const level = U.byId(state, id)?.level ?? 2;
  const skill = U.botSkill(level);
  const ball = state.ball;
  const incoming = pad.side === 'l' ? ball.vx < 0 : ball.vx > 0;
  const grow = state.effects.grow?.team === pad.side ? 1.5 : 1;
  const h = PADDLE_H * grow;
  const target = incoming
    ? ball.y - h / 2 + (Math.random() - 0.5) * (1 - skill) * 90
    : PONG_H / 2 - h / 2 + (pad.slot === 0 ? -40 : 40);
  const center = pad.y + h / 2;
  const wish = target + h / 2 - center;
  const input = state.inputs[id];
  input.up = wish < -6;
  input.down = wish > 6;
}

function drawPong(ctx, w, h, snapshot) {
  // A neon arena behind the court rather than a flat wash, so the paddles and
  // the ball read as lights moving over a floor.
  UI.arenaBackdrop(ctx, w, h, { palette: 'arcade', horizon: 0.58, stars: 30 });
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.24)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 10]);
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  const paddles = snapshot.paddles || {};
  const players = snapshot.players || [];
  for (const p of players) {
    const pad = paddles[p.id];
    if (!pad) continue;
    const grow = snapshot.effects?.grow?.team === pad.side ? 1.5 : 1;
    const color = pad.side === 'l' ? '#22d3ee' : '#f472b6';
    UI.withGlow(ctx, color, 18, () => {
      const grad = ctx.createLinearGradient(pad.x, 0, pad.x + PADDLE_W, 0);
      grad.addColorStop(0, UI.shadeColor(color, 0.4));
      grad.addColorStop(1, UI.shadeColor(color, -0.15));
      ctx.fillStyle = grad;
      UI.roundRect(ctx, pad.x, pad.y, PADDLE_W, PADDLE_H * grow, PADDLE_W / 2);
      ctx.fill();
    });
  }
  if (snapshot.pickup) {
    const color = snapshot.pickup.kind === 'grow' ? '#facc15' : '#a855f7';
    UI.withGlow(ctx, color, 16, () => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(snapshot.pickup.x, snapshot.pickup.y, 11, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(snapshot.pickup.kind === 'grow' ? '↕' : '🐢', snapshot.pickup.x, snapshot.pickup.y + 4);
    ctx.textAlign = 'start';
  }
  const ball = snapshot.ball;
  if (ball) {
    UI.withGlow(ctx, '#f8fafc', 22, () => {
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.shadowColor = 'rgba(34,211,238,0.8)';
  ctx.shadowBlur = 12;
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillText(String(snapshot.score?.l ?? 0), w / 2 - 60, 52);
  ctx.shadowColor = 'rgba(244,114,182,0.8)';
  ctx.fillText(String(snapshot.score?.r ?? 0), w / 2 + 40, 52);
  ctx.restore();
}

/* ========================================================================= *
 * Invade
 * ========================================================================= */

const INV_W = 640;
const INV_H = 420;
const SHIP_Y = INV_H - 30;
const ALIEN_COLS = 8;
const ALIEN_W = 30;
const ALIEN_H = 22;
const ALIEN_GAP = 14;

export const invade = {
  meta: {
    id: 'invade',
    // Wave points banked with the ship's guns; higher is better.
    record: { best: 'high', label: 'points' },
    name: 'Invade',
    category: 'arcade',
    players: { min: 1, max: 4 },
    modes: RT_MODES,
    realtime: true,
    simultaneous: true,
    blurb: 'Space Invaders-style waves with escalating formations and boss ships.',
    tags: ['arcade', 'retro'],
    minutes: 8,
    status: 'playable',
    bots: true,
    maxBots: 3,
    rules: [
      'Move your ship left and right - cannons fire on their own.',
      'Aliens speed up as their numbers fall. Dodge their bombs.',
      'Clear three waves, then beat the boss ship. You have three lives.',
    ],
    options: [{ id: 'wave', label: 'Starting wave', type: 'select', values: [1, 2, 3], default: 1 }],
  },
  create({ players, seed, options = {} }) {
    const state = baseRealtime({ players, seed });
    state.wave = options.wave || 1;
    state.lives = {};
    state.ships = {};
    state.bullets = [];
    state.bombs = [];
    state.invaders = [];
    state.boss = null;
    state.fireTimer = 0;
    state.bombTimer = 1;
    state.scoreById = {};
    state.ships = {};
    state.players.forEach((p, i) => {
      state.lives[p.id] = 3;
      state.scoreById[p.id] = 0;
      state.ships[p.id] = {
        x: (INV_W / (state.players.length + 1)) * (i + 1),
        cooldown: 0,
        inv: 0,
      };
    });
    spawnWave(state);
    U.addLog(state, `Wave ${state.wave} incoming!`);
    return state;
  },
  step(state, dt) {
    state.time += dt;
    for (const p of state.players) {
      if (p.bot) invadeAi(state, p.id, dt);
      if (state.lives[p.id] > 0) moveShip(state, p.id, dt);
    }
    state.fireTimer -= dt;
    if (state.fireTimer <= 0) {
      state.fireTimer = 0.42;
      for (const p of state.players) {
        if (state.lives[p.id] <= 0) continue;
        state.bullets.push({ x: state.ships[p.id].x, y: SHIP_Y - 12, vy: -430, owner: p.id });
      }
    }
    // bullets
    for (const bullet of state.bullets) bullet.y += bullet.vy * dt;
    state.bullets = state.bullets.filter((b) => b.y > -20);
    // alien movement
    const aliveInvaders = state.invaders.filter((a) => a.alive);
    if (aliveInvaders.length) {
      const speed = Math.min(140, 20 + (state.invaders.length - aliveInvaders.length) * 3 + state.wave * 5);
      const dir = state.formationDir;
      let minX = Infinity;
      let maxX = -Infinity;
      for (const a of aliveInvaders) {
        a.x += dir * speed * dt;
        minX = Math.min(minX, a.x);
        maxX = Math.max(maxX, a.x + ALIEN_W);
      }
      if (minX < 20 || maxX > INV_W - 20) {
        state.formationDir = -dir;
        for (const a of aliveInvaders) a.y += 14;
      }
      const lowest = Math.max(...aliveInvaders.map((a) => a.y));
      if (lowest > SHIP_Y - 40) {
        state.winnerId = [];
        state.summary = 'The invasion reached the ground...';
        state.alive = Object.fromEntries(state.players.map((p) => [p.id, false]));
        return;
      }
    } else if (!state.boss && state.wave >= 3) {
      state.boss = { x: INV_W / 2, y: 70, vx: 60 + state.wave * 10, hp: 26 + state.wave * 5, maxHp: 26 + state.wave * 5, cooldown: 1.2 };
      U.addLog(state, 'BOSS SHIP incoming!', 'warn');
    } else if (!state.boss) {
      state.wave++;
      for (const p of state.players) {
        if (state.lives[p.id] > 0) state.lives[p.id] = Math.min(5, state.lives[p.id] + 1);
      }
      spawnWave(state);
      U.addLog(state, `Wave ${state.wave} incoming - everyone gets a spare life!`, 'win');
    }
    // boss
    if (state.boss) {
      const boss = state.boss;
      boss.x += boss.vx * dt;
      if (boss.x < 60 || boss.x > INV_W - 60) boss.vx *= -1;
      boss.cooldown -= dt;
      if (boss.cooldown <= 0) {
        boss.cooldown = 1.6;
        for (const offset of [-1, 0, 1]) {
          state.bombs.push({ x: boss.x + offset * 40, y: boss.y + 26, vy: 190, spread: offset * 30 });
        }
      }
    }
    // bombs
    state.bombTimer -= dt;
    if (!state.boss && state.bombTimer <= 0 && aliveInvaders.length) {
      state.bombTimer = Math.max(0.45, (state.players.length <= 1 ? 1.35 : 1.1) - state.wave * 0.18);
      const shooter = U.pick(aliveInvaders);
      state.bombs.push({ x: shooter.x + ALIEN_W / 2, y: shooter.y + ALIEN_H, vy: 170 + state.wave * 18 });
    }
    for (const bomb of state.bombs) {
      bomb.py = bomb.y;
      bomb.x += (bomb.spread || 0) * dt * 2;
      bomb.y += bomb.vy * dt;
    }
    state.bombs = state.bombs.filter((b) => b.y < INV_H + 20);
    // collisions
    for (const bullet of state.bullets) {
      for (const alien of state.invaders) {
        if (!alien.alive) continue;
        if (bullet.x > alien.x && bullet.x < alien.x + ALIEN_W && bullet.y > alien.y && bullet.y < alien.y + ALIEN_H) {
          alien.alive = false;
          bullet.dead = true;
          if (state.lives[bullet.owner] !== undefined) {
            state.scoreById[bullet.owner] = (state.scoreById[bullet.owner] || 0) + 10;
            U.addScore(state, bullet.owner, 10);
          }
          break;
        }
      }
      if (state.boss && !bullet.dead && Math.abs(bullet.x - state.boss.x) < 55 && Math.abs(bullet.y - state.boss.y) < 34) {
        state.boss.hp -= 1;
        bullet.dead = true;
        if (state.lives[bullet.owner] !== undefined) {
          U.addScore(state, bullet.owner, 5);
          state.scoreById[bullet.owner] += 5;
        }
        if (state.boss.hp <= 0) {
          U.addScore(state, bullet.owner, 150);
          state.scoreById[bullet.owner] += 150;
          state.boss = null;
          state.winnerId = state.players.filter((p) => state.lives[p.id] > 0).map((p) => p.id);
          state.summary = `Boss destroyed! ${U.byId(state, bullet.owner)?.name || 'Nobody'} lands the final blow.`;
        }
      }
    }
    state.bullets = state.bullets.filter((b) => !b.dead);
    for (const bomb of state.bombs) {
      for (const p of state.players) {
        if (state.lives[p.id] <= 0) continue;
        const ship = state.ships[p.id];
        if (ship.inv > 0) continue;
        const crossed = bomb.py !== undefined && bomb.py <= SHIP_Y + 10 && bomb.y >= SHIP_Y - 10;
        if (Math.abs(bomb.x - ship.x) < 20 && (Math.abs(bomb.y - SHIP_Y) < 16 || crossed)) {
          bomb.dead = true;
          state.lives[p.id]--;
          ship.inv = 1.6;
          U.addLog(state, `${p.name} was hit (${state.lives[p.id]} lives left).`, 'warn');
          if (state.lives[p.id] <= 0) U.addLog(state, `${p.name} is out.`, 'warn');
        }
      }
    }
    state.bombs = state.bombs.filter((b) => !b.dead);
    for (const p of state.players) state.ships[p.id].inv = Math.max(0, state.ships[p.id].inv - dt);
    if (state.players.every((p) => state.lives[p.id] <= 0) && !state.winnerId) {
      state.winnerId = [];
      state.summary = 'Every ship is down - the invasion wins.';
    }
  },
  act(state, playerId, action) {
    return realtimeAct(state, playerId, action, (s, dt, events) => {
      invade.step(s, dt);
      if (s.winnerId && !s.summaryLogged) {
        s.summaryLogged = true;
        events.push(U.event(s.summary || 'Game over', s.winnerId.length ? 'win' : 'warn'));
      }
    });
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.time = state.time || 0;
    v.wave = state.wave;
    v.lives = state.lives;
    v.ships = state.ships;
    v.invaders = state.invaders;
    v.bullets = state.bullets;
    v.bombs = state.bombs;
    v.boss = state.boss || null;
    v.alive = state.alive;
    v.turn = realtimeTurn(state);
    return v;
  },
  bot(state) {
    return realtimeBot(state);
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, state, playerId, send, host }) {
    const stage = UI.realtimeStage({
      el,
      snapshot: state || view,
      width: INV_W,
      height: INV_H,
      draw: drawInvade,
      viewerId: playerId,
      hudText: (s, id) => `Wave ${s.wave} · lives ${s.lives?.[id] ?? 0} · ${(s.invaders || []).filter((a) => a.alive).length + (s.boss ? 1 : 0)} targets left`,
    });
    const keys = blankInput();
    const { mode, cleanup } = UI.realtimeControls({ wrap: stage.wrap, host, state, playerId, keys, send });
    if (mode === 'local') {
      realtimeLoop({ wrap: stage.wrap, box: stage.box, state, host, draw: () => stage.box.redraw(), stepWorld: (s, dt) => stepIncrements((st, slice) => invade.step(st, slice), s, dt), onEnd: () => host?.refresh?.() });
    }
    const hint = 'Left / right arrows (or A / D) to steer. Your cannon fires itself.';
    stage.wrap.appendChild(UI.muted(UI.realtimeHint(mode, hint, 'Watching the invasion...')));
    return UI.withLive(cleanup, stage, { keys });
  },
};

function spawnWave(state) {
  state.invaders = [];
  // Solo ships face a smaller formation so one cannon can hold the line.
  const solo = state.players.length <= 1;
  const rows = Math.min(solo ? 4 : 5, (solo ? 1 : 2) + state.wave);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < ALIEN_COLS; col++) {
      state.invaders.push({
        x: 60 + col * (ALIEN_W + ALIEN_GAP),
        y: 50 + row * (ALIEN_H + 12),
        alive: true,
        kind: row % 3,
      });
    }
  }
  state.formationDir = 1;
}

function moveShip(state, id, dt) {
  const ship = state.ships[id];
  if (!ship) return;
  const input = readInput(state, id);
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  ship.x = U.clamp(ship.x + dir * 260 * dt, 30, INV_W - 30);
}

function invadeAi(state, id, dt) {
  if (state.lives[id] <= 0) return;
  const ship = state.ships[id];
  const input = state.inputs[id];
  const level = U.byId(state, id)?.level ?? 2;
  // dodge the nearest bomb heading for us, otherwise hunt the lowest alien
  const threat = state.bombs
    .filter((b) => b.y < SHIP_Y && Math.abs(b.x - ship.x) < 70 && b.vy > 0)
    .sort((a, b) => b.y - a.y)[0];
  let targetX = null;
  if (threat) targetX = threat.x > ship.x ? threat.x - 90 : threat.x + 90;
  else {
    const alive = state.invaders.filter((a) => a.alive);
    if (alive.length) {
      // Shoot the aliens closest to the ground first - they are the real threat.
      const target = level >= 2 ? alive.reduce((best, a) => (a.y > best.y ? a : best), alive[0]) : U.pick(alive);
      targetX = target.x + ALIEN_W / 2;
    } else if (state.boss) targetX = state.boss.x;
  }
  if (targetX === null) {
    input.left = false;
    input.right = false;
    return;
  }
  const error = (1 - U.botSkill(level)) * 40;
  const aim = targetX + (Math.random() - 0.5) * error;
  input.left = aim < ship.x - 6;
  input.right = aim > ship.x + 6;
}

function drawInvade(ctx, w, h, snapshot) {
  UI.arenaBackdrop(ctx, w, h, { palette: 'arcade', horizon: 0.86, stars: 60 });
  const stars = snapshot.stars || [];
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (const star of stars) ctx.fillRect(star.x, star.y, 2, 2);
  for (const alien of snapshot.invaders || []) {
    if (!alien.alive) continue;
    const color = ['#4ade80', '#facc15', '#f472b6'][alien.kind % 3];
    UI.withGlow(ctx, color, 10, () => {
      ctx.fillStyle = color;
      UI.roundRect(ctx, alien.x, alien.y, ALIEN_W, ALIEN_H, 5);
      ctx.fill();
    });
    ctx.fillStyle = '#050816';
    ctx.fillRect(alien.x + 6, alien.y + 7, 6, 6);
    ctx.fillRect(alien.x + ALIEN_W - 12, alien.y + 7, 6, 6);
  }
  if (snapshot.boss) {
    const boss = snapshot.boss;
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(boss.x - 55, boss.y - 30, 110, 60);
    ctx.fillStyle = '#fca5a5';
    for (let i = 0; i < 4; i++) ctx.fillRect(boss.x - 42 + i * 24, boss.y - 12, 12, 24);
    ctx.fillStyle = '#111827';
    ctx.fillRect(boss.x - 60, boss.y + 34, 120, 8);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(boss.x - 60, boss.y + 34, 120 * Math.max(0, boss.hp / boss.maxHp), 8);
  }
  ctx.fillStyle = '#facc15';
  UI.withGlow(ctx, '#facc15', 12, () => {
    for (const bullet of snapshot.bullets || []) ctx.fillRect(bullet.x - 2, bullet.y - 10, 4, 12);
  });
  ctx.fillStyle = '#fb7185';
  UI.withGlow(ctx, '#fb7185', 10, () => {
    for (const bomb of snapshot.bombs || []) {
      ctx.beginPath();
      ctx.arc(bomb.x, bomb.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  for (const p of snapshot.players || []) {
    const ship = snapshot.ships?.[p.id];
    if (!ship || (snapshot.lives?.[p.id] ?? 0) <= 0) continue;
    if (ship.inv > 0 && Math.floor(ship.inv * 10) % 2 === 0) continue;
    UI.withGlow(ctx, '#38bdf8', 16, () => {
      const grad = ctx.createLinearGradient(ship.x, SHIP_Y - 16, ship.x, SHIP_Y + 12);
      grad.addColorStop(0, UI.shadeColor('#38bdf8', 0.35));
      grad.addColorStop(1, UI.shadeColor('#38bdf8', -0.2));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(ship.x, SHIP_Y - 16);
      ctx.lineTo(ship.x - 18, SHIP_Y + 12);
      ctx.lineTo(ship.x + 18, SHIP_Y + 12);
      ctx.closePath();
      ctx.fill();
    });
  }
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = 'bold 16px system-ui, sans-serif';
  (snapshot.players || []).forEach((p, i) => {
    ctx.fillText(`${p.name}: ${snapshot.lives?.[p.id] ?? 0}❤`, 14, 24 + i * 20);
  });
}

/* ========================================================================= *
 * Rocket Bot Royale
 * ========================================================================= */

const ROY_W = 720;
const ROY_H = 440;
const ROCKET_DAMAGE = 34;
const SHIP_HP = 100;

export const rocketBotRoyale = {
  meta: {
    id: 'rocket-bot-royale',
    // Kills and surviving hull, the same number the results screen ranks.
    record: { best: 'high', label: 'points' },
    name: 'Rocket Bot Royale',
    category: 'arcade',
    players: { min: 2, max: 8 },
    modes: RT_MODES,
    realtime: true,
    simultaneous: true,
    blurb: 'Low-spec rocket arena: thrust, blast, last bot flying wins.',
    tags: ['shooter', 'low-spec'],
    minutes: 6,
    status: 'playable',
    bots: true,
    maxBots: 6,
    rules: [
      'Turn, thrust and fire rockets. Rockets push what they hit.',
      'The safe zone shrinks - outside it you take damage every second.',
      'Last pilot flying wins. Kills and remaining hull add to your score.',
    ],
    options: [{ id: 'zone', label: 'Zone shrinks', type: 'select', values: [1, 0], default: 1 }],
  },
  create({ players, seed, options = {} }) {
    const state = baseRealtime({ players, seed });
    state.ships = {};
    state.rockets = [];
    state.zone = { r: 420, shrinking: options.zone !== 0 };
    state.kills = {};
    state.ships = {};
    state.players.forEach((p, i) => {
      const angle = (i / state.players.length) * Math.PI * 2;
      state.ships[p.id] = {
        x: ROY_W / 2 + Math.cos(angle) * 150,
        y: ROY_H / 2 + Math.sin(angle) * 110,
        vx: 0,
        vy: 0,
        angle: angle + Math.PI / 2,
        hp: SHIP_HP,
        cooldown: 0,
      };
      state.kills[p.id] = 0;
    });
    state.summaryLogged = false;
    U.addLog(state, 'Engines hot. The zone is closing...');
    return state;
  },
  step(state, dt) {
    state.time += dt;
    if (state.zone.shrinking) {
      state.zone.r = Math.max(90, 420 - state.time * 3.1);
    }
    const cx = ROY_W / 2;
    const cy = ROY_H / 2;
    for (const p of state.players) {
      const ship = state.ships[p.id];
      if (!ship || state.alive[p.id] === false) continue;
      if (p.bot) royaleAi(state, p.id, dt);
      const input = readInput(state, p.id);
      const turn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      ship.angle += turn * 3.2 * dt;
      if (input.up) {
        ship.vx += Math.cos(ship.angle) * 165 * dt;
        ship.vy += Math.sin(ship.angle) * 165 * dt;
      }
      // drag
      ship.vx *= 1 - 0.55 * dt;
      ship.vy *= 1 - 0.55 * dt;
      const speed = Math.hypot(ship.vx, ship.vy);
      if (speed > 270) {
        ship.vx = (ship.vx / speed) * 270;
        ship.vy = (ship.vy / speed) * 270;
      }
      ship.x += ship.vx * dt;
      ship.y += ship.vy * dt;
      if (ship.x < 16 || ship.x > ROY_W - 16) {
        ship.vx *= -0.5;
        ship.x = U.clamp(ship.x, 16, ROY_W - 16);
      }
      if (ship.y < 16 || ship.y > ROY_H - 16) {
        ship.vy *= -0.5;
        ship.y = U.clamp(ship.y, 16, ROY_H - 16);
      }
      ship.cooldown = Math.max(0, ship.cooldown - dt);
      if (input.fire && ship.cooldown <= 0) {
        ship.cooldown = 1.1;
        const spread = (Math.random() - 0.5) * 0.05;
        state.rockets.push({
          x: ship.x + Math.cos(ship.angle) * 22,
          y: ship.y + Math.sin(ship.angle) * 22,
          vx: Math.cos(ship.angle + spread) * 300,
          vy: Math.sin(ship.angle + spread) * 300,
          owner: p.id,
          life: 2.6,
        });
      }
      // zone damage
      const dist = Math.hypot(ship.x - cx, ship.y - cy);
      if (dist > state.zone.r) {
        ship.hp -= 11 * dt;
        if (ship.hp <= 0) destroyShip(state, p.id, null);
      }
    }
    for (const rocket of state.rockets) {
      rocket.x += rocket.vx * dt;
      rocket.y += rocket.vy * dt;
      rocket.life -= dt;
      for (const p of state.players) {
        const ship = state.ships[p.id];
        if (!ship || state.alive[p.id] === false || p.id === rocket.owner) continue;
        if (Math.hypot(ship.x - rocket.x, ship.y - rocket.y) < 16) {
          ship.hp -= ROCKET_DAMAGE;
          ship.vx += rocket.vx * 0.35;
          ship.vy += rocket.vy * 0.35;
          rocket.dead = true;
          if (ship.hp <= 0) destroyShip(state, p.id, rocket.owner);
          break;
        }
      }
    }
    state.rockets = state.rockets.filter((r) => !r.dead && r.life > 0 && r.x > -20 && r.x < ROY_W + 20 && r.y > -20 && r.y < ROY_H + 20);
    const alive = state.players.filter((p) => state.alive[p.id] !== false);
    if (alive.length <= 1 || state.time > 150) {
      const ranked = [...state.players].sort((a, b) => {
        const sa = (state.kills[a.id] || 0) * 100 + Math.max(0, state.ships[a.id]?.hp || 0);
        const sb = (state.kills[b.id] || 0) * 100 + Math.max(0, state.ships[b.id]?.hp || 0);
        return sb - sa;
      });
      const best = ranked[0];
      const bestScore = (state.kills[best.id] || 0) * 100 + Math.max(0, state.ships[best.id]?.hp || 0);
      state.winnerId = ranked.filter((p) => ((state.kills[p.id] || 0) * 100 + Math.max(0, state.ships[p.id]?.hp || 0)) === bestScore).map((p) => p.id);
      state.summary = `${best.name} is the last bot flying!`;
      for (const p of state.players) {
        state.scores[p.id] = (state.kills[p.id] || 0) * 100 + Math.max(0, Math.round(state.ships[p.id]?.hp || 0));
      }
    }
  },
  act(state, playerId, action) {
    return realtimeAct(state, playerId, action, (s, dt, events) => {
      rocketBotRoyale.step(s, dt);
      if (s.winnerId && !s.summaryLogged) {
        s.summaryLogged = true;
        events.push(U.event(s.summary, 'win'));
      }
    });
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.time = state.time || 0;
    v.ships = state.ships;
    v.rockets = state.rockets;
    v.zone = state.zone;
    v.kills = state.kills;
    v.alive = state.alive;
    v.turn = realtimeTurn(state);
    return v;
  },
  bot(state) {
    return realtimeBot(state);
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, state, playerId, send, host }) {
    const stage = UI.realtimeStage({
      el,
      snapshot: state || view,
      width: ROY_W,
      height: ROY_H,
      draw: drawRoyale,
      viewerId: playerId,
      hudText: (s, id) => {
        const mine = s.ships?.[id];
        return `Hull ${Math.max(0, Math.round(mine?.hp ?? 0))} · ${(s.players || []).filter((p) => s.alive?.[p.id] !== false).length} bots left · zone ${Math.round(s.zone?.r ?? 0)}px`;
      },
    });
    const keys = blankInput();
    const { mode, cleanup } = UI.realtimeControls({ wrap: stage.wrap, host, state, playerId, keys, send });
    if (mode === 'local') {
      realtimeLoop({ wrap: stage.wrap, box: stage.box, state, host, draw: () => stage.box.redraw(), stepWorld: (s, dt) => stepIncrements((st, slice) => rocketBotRoyale.step(st, slice), s, dt), onEnd: () => host?.refresh?.() });
    }
    const hint = 'Left / right to turn, up to thrust, space to fire.';
    stage.wrap.appendChild(UI.muted(UI.realtimeHint(mode, hint, 'Watching the royale...')));
    return UI.withLive(cleanup, stage, { keys });
  },
};

function destroyShip(state, id, killerId) {
  state.alive[id] = false;
  if (killerId) {
    state.kills[killerId] = (state.kills[killerId] || 0) + 1;
    U.addLog(state, `${U.byId(state, killerId)?.name} blasted ${U.byId(state, id)?.name}!`, 'win');
  } else {
    U.addLog(state, `${U.byId(state, id)?.name} drifted into the fire.`, 'warn');
  }
}

function royaleAi(state, id, dt) {
  const ship = state.ships[id];
  const input = state.inputs[id];
  const level = U.byId(state, id)?.level ?? 2;
  const skill = U.botSkill(level);
  const foes = state.players.filter((p) => p.id !== id && state.alive[p.id] !== false && state.ships[p.id]);
  if (!foes.length) {
    input.up = false;
    input.fire = false;
    input.left = false;
    input.right = false;
    return;
  }
  const target = foes.sort((a, b) => Math.hypot(state.ships[a.id].x - ship.x, state.ships[a.id].y - ship.y) - Math.hypot(state.ships[b.id].x - ship.x, state.ships[b.id].y - ship.y))[0].id;
  const foe = state.ships[target];
  const dist = Math.hypot(foe.x - ship.x, foe.y - ship.y);
  let aim = Math.atan2(foe.y - ship.y, foe.x - ship.x);
  if (dist > 220) aim += (Math.random() - 0.5) * 0.6;
  else aim += (Math.random() - 0.5) * (1 - skill) * 0.5;
  let diff = ((aim - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  input.left = diff < -0.08;
  input.right = diff > 0.08;
  // thrust to keep some range, dodge the zone
  const cx = ROY_W / 2;
  const cy = ROY_H / 2;
  const outside = Math.hypot(ship.x - cx, ship.y - cy) > state.zone.r - 40;
  const tooClose = dist < 120;
  input.up = outside || tooClose || dist > 260 ? true : Math.random() < 0.15;
  if (outside) {
    const home = Math.atan2(cy - ship.y, cx - ship.x);
    diff = ((home - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    input.left = diff < 0;
    input.right = diff > 0;
    input.up = true;
  }
  input.fire = dist < 330 && Math.abs(diff) < 0.25 && Math.random() < 0.75;
}

function drawRoyale(ctx, w, h, snapshot) {
  UI.arenaBackdrop(ctx, w, h, { palette: 'arcade', horizon: 0.4, stars: 70, grid: false });
  ctx.save();
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, snapshot.zone?.r ?? 420, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(248,113,113,0.75)';
  ctx.lineWidth = 3;
  ctx.shadowColor = 'rgba(248,113,113,0.9)';
  ctx.shadowBlur = 18;
  ctx.stroke();
  ctx.restore();
  // Inside the ring the floor grid says "still safe"; outside stays empty space.
  ctx.save();
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, snapshot.zone?.r ?? 420, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(34,211,238,0.10)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.restore();
  for (const rocket of snapshot.rockets || []) {
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rocket.x - rocket.vx * 0.02, rocket.y - rocket.vy * 0.02);
    ctx.lineTo(rocket.x, rocket.y);
    ctx.stroke();
    ctx.fillStyle = '#fff7ed';
    ctx.fillRect(rocket.x - 2, rocket.y - 2, 4, 4);
  }
  for (const p of snapshot.players || []) {
    const ship = snapshot.ships?.[p.id];
    if (!ship || snapshot.alive?.[p.id] === false) continue;
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.angle);
    const hull = p.id === snapshot.__me ? '#22d3ee' : '#e879f9';
    UI.withGlow(ctx, hull, 14, () => {
      const grad = ctx.createLinearGradient(-14, 0, 18, 0);
      grad.addColorStop(0, UI.shadeColor(hull, -0.25));
      grad.addColorStop(1, UI.shadeColor(hull, 0.4));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(16, 0);
      ctx.lineTo(-12, 10);
      ctx.lineTo(-7, 0);
      ctx.lineTo(-12, -10);
      ctx.closePath();
      ctx.fill();
    });
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';

    ctx.fillRect(ship.x - 16, ship.y - 24, 32, 4);
    ctx.fillStyle = '#4ade80';
    ctx.fillRect(ship.x - 16, ship.y - 24, 32 * Math.max(0, ship.hp / SHIP_HP), 4);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(p.name, ship.x - 18, ship.y - 28);
  }
}

/* ========================================================================= *
 * Mini Golf
 * ========================================================================= */

const GOLF_W = 640;
const GOLF_H = 400;
const GOLF_BALL_R = 6;
const CUP_R = 11;
const MAX_STROKES = 8;

function hole({ tee, cup, par = 3, walls = [], spin = null }) {
  return { tee, cup, par, walls, spin };
}

const HOLES = [
  hole({ tee: [70, 340], cup: [560, 90], par: 2, walls: [[320, 40, 320, 250]] }),
  hole({ tee: [70, 340], cup: [540, 330], par: 3, walls: [[240, 20, 240, 250], [240, 250, 640, 250]] }),
  hole({ tee: [70, 60], cup: [560, 340], par: 3, walls: [[300, 20, 300, 260], [300, 260, 560, 260]] }),
  hole({ tee: [70, 340], cup: [560, 340], par: 3, walls: [[220, 140, 320, 40], [320, 40, 420, 140], [420, 140, 320, 240], [320, 240, 220, 140]] }),
  hole({ tee: [70, 340], cup: [560, 340], par: 3, spin: { x: 320, y: 200, len: 120, rate: 1.6 } }),
  hole({ tee: [320, 40], cup: [320, 350], par: 2, walls: [[120, 120, 240, 120], [400, 120, 520, 120], [120, 280, 240, 280], [400, 280, 520, 280]] }),
  hole({ tee: [70, 70], cup: [560, 70], par: 3, walls: [[200, 140, 200, 380], [440, 140, 440, 380]] }),
  hole({ tee: [70, 340], cup: [560, 60], par: 4, walls: [[180, 60, 180, 300], [180, 300, 360, 300], [360, 300, 360, 120], [360, 120, 560, 120]] }),
  hole({ tee: [80, 200], cup: [560, 200], par: 4, walls: [[240, 60, 240, 180], [240, 220, 240, 340], [420, 60, 420, 180], [420, 220, 420, 340], [240, 60, 420, 60], [240, 340, 420, 340]] }),
];

function borderWalls() {
  return [
    [0, 0, GOLF_W, 0], [GOLF_W, 0, GOLF_W, GOLF_H], [GOLF_W, GOLF_H, 0, GOLF_H], [0, GOLF_H, 0, 0],
  ];
}

function closestPointOnSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = U.clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  return { x: x1 + t * dx, y: y1 + t * dy };
}

function simulatePutt(state, id, angle, power, spinPhase = null) {
  const holeDef = HOLES[state.holeIndex];
  const ball = { x: state.ball[id].x, y: state.ball[id].y };
  const speed0 = U.clamp(power, 0.08, 1) * 470;
  const vel = { x: Math.cos(angle) * speed0, y: Math.sin(angle) * speed0 };
  const path = [[ball.x, ball.y]];
  const walls = borderWalls().concat(holeDef.walls || []);
  const dt = 1 / 120;
  let holed = false;
  // The windmill bar is frozen at the angle the player saw when they putted.
  let spinSeg = null;
  if (holeDef.spin) {
    const a = Number.isFinite(spinPhase) ? spinPhase : Math.random() * Math.PI * 2;
    const spin = holeDef.spin;
    spinSeg = [
      spin.x - Math.cos(a) * spin.len / 2, spin.y - Math.sin(a) * spin.len / 2,
      spin.x + Math.cos(a) * spin.len / 2, spin.y + Math.sin(a) * spin.len / 2,
    ];
  }
  for (let step = 0; step < 1500; step++) {
    if (spinSeg) resolveWall(ball, vel, spinSeg);
    for (const wall of walls) resolveWall(ball, vel, wall);
    ball.x += vel.x * dt;
    ball.y += vel.y * dt;
    state.time += dt;
    if (!Number.isFinite(ball.x) || !Number.isFinite(ball.y) || !Number.isFinite(vel.x) || !Number.isFinite(vel.y)) break;
    vel.x *= 0.9885;
    vel.y *= 0.9885;
    if (step % 4 === 0) path.push([Math.round(ball.x * 10) / 10, Math.round(ball.y * 10) / 10]);
    const cupDist = Math.hypot(ball.x - holeDef.cup[0], ball.y - holeDef.cup[1]);
    if (cupDist < CUP_R && Math.hypot(vel.x, vel.y) < 330) {
      holed = true;
      path.push([holeDef.cup[0], holeDef.cup[1]]);
      break;
    }
    if (Math.hypot(vel.x, vel.y) < 9) break;
  }
  return { ball, path: path.slice(0, 260), holed };
}

function resolveWall(ball, vel, [x1, y1, x2, y2]) {
  const close = closestPointOnSegment(ball.x, ball.y, [x1, y1, x2, y2]);
  const dx = ball.x - close.x;
  const dy = ball.y - close.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= GOLF_BALL_R || dist === 0) return;
  const nx = dx / dist;
  const ny = dy / dist;
  ball.x = close.x + nx * GOLF_BALL_R;
  ball.y = close.y + ny * GOLF_BALL_R;
  const dot = vel.x * nx + vel.y * ny;
  if (dot < 0) {
    vel.x = (vel.x - 2 * dot * nx) * 0.72;
    vel.y = (vel.y - 2 * dot * ny) * 0.72;
  }
}

export const miniGolf = {
  meta: {
    id: 'mini-golf',
    // Strokes: fewer is better, and the round is worth timing.  A round lasts
    // fifteen minutes, so the memory keeps where the player left off (resume).
    record: {
      best: 'low',
      label: 'strokes',
      time: 'short',
      timeLabel: 'fastest round',
      resume: true,
      progress: (view, state, seatId) => `Hole ${view.holeNumber}/${view.holes} · ${view.strokes?.[seatId] ?? 0} strokes`,
    },
    name: 'Mini Golf',
    category: 'arcade',
    players: { min: 1, max: 8 },
    modes: MODES,
    blurb: 'Nine handcrafted holes, windmills included. Fewest strokes takes the trophy.',
    tags: ['sports', 'turn-based'],
    minutes: 15,
    status: 'playable',
    bots: true,
    maxBots: 6,
    turnMs: 60000,
    rules: [
      'Drag from the ball to aim, release to putt. Longer drag, harder hit.',
      'Every stroke counts, and eight strokes is the limit per hole.',
      'Fewest strokes over nine holes wins.',
    ],
  },
  create({ players, seed }) {
    const state = U.baseState({ players, seed });
    state.holeIndex = 0;
    state.hole = HOLES[0];
    state.ball = {};
    state.strokes = {};
    state.holeStrokes = {};
    state.holed = {};
    state.shot = null;
    state.phase = 'aim';
    state.time = 0;
    for (const p of state.players) {
      state.ball[p.id] = { x: HOLES[0].tee[0], y: HOLES[0].tee[1] };
      state.strokes[p.id] = 0;
      state.holeStrokes[p.id] = 0;
      state.holed[p.id] = false;
    }
    state.turnId = state.players[0].id;
    U.addLog(state, `Hole 1 (par ${HOLES[0].par}) - ${state.players[0].name} tees off.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.holeIndex = state.holeIndex;
    v.holeNumber = state.holeIndex + 1;
    v.holes = HOLES.length;
    v.hole = state.hole;
    v.ball = state.ball;
    v.strokes = state.strokes;
    v.holeStrokes = state.holeStrokes;
    v.holed = state.holed;
    v.shot = state.shot;
    v.phase = state.phase;
    v.time = state.time || 0;
    v.turn = state.winnerId ? [] : state.players.filter((p) => !state.holed[p.id] || p.id === state.turnId).filter((p) => p.id === state.turnId).map((p) => p.id);
    if (!v.turn.length && !state.winnerId) v.turn = [state.turnId];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    if (action.type !== 'putt') return { ok: false, error: 'Unknown action.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn to putt.' };
    if (state.holed[playerId]) return { ok: false, error: 'You already holed out.' };
    const angle = Number(action.angle);
    const power = Number(action.power);
    if (!Number.isFinite(angle) || !Number.isFinite(power)) return { ok: false, error: 'Aim first.' };
    const events = [];
    const holeDef = HOLES[state.holeIndex];
    const result = simulatePutt(state, playerId, angle, power, Number(action.spinPhase));
    state.ball[playerId] = result.ball;
    state.shot = { by: playerId, path: result.path, holed: result.holed };
    state.holeStrokes[playerId]++;
    state.strokes[playerId]++;
    events.push(U.event(`${U.byId(state, playerId)?.name} putts (${state.holeStrokes[playerId]}/${MAX_STROKES}).`, 'info'));
    let holed = result.holed;
    if (!holed && state.holeStrokes[playerId] >= MAX_STROKES) {
      holed = true;
      events.push(U.event(`${U.byId(state, playerId)?.name} picks up after ${MAX_STROKES} strokes.`, 'warn'));
    }
    if (holed) {
      state.holed[playerId] = true;
      state.summary = state.summary || null;
      events.push(U.event(`${U.byId(state, playerId)?.name} holes out in ${state.holeStrokes[playerId]}.`, result.holed ? 'win' : 'info'));
      advanceGolf(state, events);
    }
    for (const e of events) U.addLog(state, e.text, e.kind);
    return { ok: true, events };
  },
  bot(state, playerId) {
    if (state.winnerId || playerId !== state.turnId || state.holed[playerId]) return null;
    const level = U.byId(state, playerId)?.level ?? 2;
    const skill = U.botSkill(level);
    const me = state.ball[playerId];
    const holeDef = HOLES[state.holeIndex];
    const dist = Math.hypot(holeDef.cup[0] - me.x, holeDef.cup[1] - me.y);
    let angle = Math.atan2(holeDef.cup[1] - me.y, holeDef.cup[0] - me.x);
    angle += (Math.random() - 0.5) * (1 - skill) * 0.35;
    const power = U.clamp(dist / 420 + 0.12 + (Math.random() - 0.5) * (1 - skill) * 0.2, 0.15, 1);
    const action = { type: 'putt', angle, power };
    if (holeDef.spin) action.spinPhase = bestSpinPhase(state, playerId, angle);
    return action;
  },
  timeout(state, playerId) {
    if (playerId !== state.turnId || state.holed[playerId]) return null;
    const action = { type: 'putt', angle: Math.random() * Math.PI * 2, power: 0.3 };
    if (HOLES[state.holeIndex].spin) action.spinPhase = bestSpinPhase(state, playerId, action.angle);
    return action;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send, host }) {
    const wrap = UI.h('div', { class: 'golf-wrap' });
    el.appendChild(wrap);
    const holeDef = view.hole;
    wrap.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Hole ${view.holeNumber}/${view.holes}`),
      UI.pill(`Par ${holeDef.par}`),
      UI.pill(`Strokes: ${view.strokes[playerId] ?? 0}`),
      UI.pill(`This hole: ${view.holeStrokes[playerId] ?? 0}/${MAX_STROKES}`)));
    let aim = null;
    let dragging = false;
    let spinPhase = Math.random() * Math.PI * 2;
    const box = UI.canvasBox(GOLF_W, GOLF_H, (ctx, w, h) => drawGolf(ctx, w, h, view, playerId, aim, state0(view, playerId), holeDef.spin ? spinPhase : null));
    const canvas = box.canvas;
    const toLocal = (ev) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ((ev.clientX - rect.left) / rect.width) * GOLF_W, y: ((ev.clientY - rect.top) / rect.height) * GOLF_H };
    };
    const myTurn = view.turn.includes(playerId) && !view.holed[playerId];
    if (myTurn) {
      canvas.style.cursor = 'crosshair';
      canvas.addEventListener('pointerdown', (ev) => {
        dragging = true;
        aim = toLocal(ev);
        box.redraw();
      });
      canvas.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        aim = toLocal(ev);
        box.redraw();
      });
      canvas.addEventListener('pointerup', (ev) => {
        if (!dragging) return;
        dragging = false;
        const target = toLocal(ev);
        const ball = view.ball[playerId];
        const dx = target.x - ball.x;
        const dy = target.y - ball.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 8) {
          aim = null;
          box.redraw();
          return;
        }
        const putt = { type: 'putt', angle: Math.atan2(dy, dx), power: U.clamp(dist / 220, 0.08, 1) };
        if (holeDef.spin) putt.spinPhase = spinPhase;
        send(putt);
        aim = null;
      });
    }
    wrap.appendChild(box.el);
    if (holeDef.spin) {
      UI.every(wrap, 50, () => {
        spinPhase += 0.05 * holeDef.spin.rate;
        box.redraw();
      });
    }
    wrap.appendChild(UI.muted(myTurn ? 'Drag from the ball and release to putt.' : `${view.players.find((p) => p.id === view.turn[0])?.name || 'Someone'} is lining up...`));
    wrap.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.holed[p.id] ? 'done' : ''}` }, `${p.name}: ${view.strokes[p.id]}${view.holed[p.id] ? ' ⛳' : ''}`))));
    return null;
  },
};

function state0(view, playerId) {
  return { ball: view.ball, shot: view.shot, me: playerId };
}

function advanceGolf(state, events) {
  const pending = state.players.filter((p) => !state.holed[p.id]);
  if (pending.length) {
    const currentIndex = state.players.findIndex((p) => p.id === state.turnId);
    let next = null;
    for (let step = 1; step <= state.players.length; step++) {
      const cand = state.players[(currentIndex + step) % state.players.length];
      if (!state.holed[cand.id]) {
        next = cand.id;
        break;
      }
    }
    state.turnId = next || pending[0].id;
    state.shot = null;
    return;
  }
  // hole finished
  if (state.holeIndex >= HOLES.length - 1) {
    const ranked = U.ranking({
      players: state.players,
      scores: Object.fromEntries(state.players.map((p) => [p.id, -state.strokes[p.id]])),
    });
    state.winnerId = ranked.filter((r) => r.score === ranked[0].score).map((r) => r.id);
    // The round's real score, in the positive: total strokes, fewest wins.  The
    // ranking above negates only to sort the winners; this is the number the
    // arcade's per-game record books (meta.record.best === 'low').
    state.scores = Object.fromEntries(state.players.map((p) => [p.id, state.strokes[p.id] || 0]));
    state.summary = `${ranked[0].name} wins the round with ${state.strokes[ranked[0].id]} strokes!`;
    events.push(U.event(state.summary, 'win'));
    return;
  }
  state.holeIndex++;
  state.hole = HOLES[state.holeIndex];
  state.holed = {};
  state.holeStrokes = {};
  state.shot = null;
  for (const p of state.players) {
    state.ball[p.id] = { x: state.hole.tee[0], y: state.hole.tee[1] };
    state.holed[p.id] = false;
    state.holeStrokes[p.id] = 0;
  }
  state.turnId = state.players[0].id;
  events.push(U.event(`Hole ${state.holeIndex + 1} (par ${state.hole.par}) - ${state.players[0].name} tees off.`, 'info'));
}

function bestSpinPhase(state, id, angle) {
  const holeDef = HOLES[state.holeIndex];
  const spin = holeDef.spin;
  if (!spin) return null;
  const me = state.ball[id];
  let best = 0;
  let bestClearance = -Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const seg = [
      spin.x - Math.cos(a) * spin.len / 2, spin.y - Math.sin(a) * spin.len / 2,
      spin.x + Math.cos(a) * spin.len / 2, spin.y + Math.sin(a) * spin.len / 2,
    ];
    let clearance = Infinity;
    for (let t = 0; t <= 20; t++) {
      const px = me.x + Math.cos(angle) * t * 12;
      const py = me.y + Math.sin(angle) * t * 12;
      const close = closestPointOnSegment(px, py, seg);
      clearance = Math.min(clearance, Math.hypot(px - close.x, py - close.y));
    }
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = a;
    }
  }
  return best;
}

function drawGolf(ctx, w, h, view, playerId, aim, live, spinPhase = null) {
  // The fairway: a green that falls off toward the edges with mown stripes over
  // it, so the ball reads as sitting on grass and not on a flat swatch.
  const grass = ctx.createLinearGradient(0, 0, 0, h);
  grass.addColorStop(0, '#166534');
  grass.addColorStop(0.55, '#15803d');
  grass.addColorStop(1, '#14532d');
  ctx.fillStyle = grass;
  ctx.fillRect(0, 0, w, h);
  const stripe = h / 9;
  for (let i = 0; i < 9; i += 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.fillRect(0, i * stripe, w, stripe);
  }
  const holeDef = view.hole || HOLES[0];
  // Each wall gets a soft shadow, a dark body and a lit edge - the classic
  // three-pass trick that turns a flat line into something with a face.
  const walls = borderWalls().concat(holeDef.walls || []);
  ctx.save();
  ctx.lineCap = 'round';
  const strokeWalls = (style, width) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    for (const [x1, y1, x2, y2] of walls) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  };
  strokeWalls('rgba(2,20,10,0.45)', 13);
  strokeWalls('#0b3b1e', 8);
  strokeWalls('rgba(190,242,100,0.3)', 2);
  ctx.restore();
  if (holeDef.spin) {
    const a = spinPhase !== null && spinPhase !== undefined ? spinPhase : (view.time || 0) * holeDef.spin.rate;
    UI.withGlow(ctx, '#f97316', 14, () => {
      const bar = ctx.createLinearGradient(
        holeDef.spin.x - Math.cos(a) * holeDef.spin.len / 2, holeDef.spin.y - Math.sin(a) * holeDef.spin.len / 2,
        holeDef.spin.x + Math.cos(a) * holeDef.spin.len / 2, holeDef.spin.y + Math.sin(a) * holeDef.spin.len / 2,
      );
      bar.addColorStop(0, '#fb923c');
      bar.addColorStop(1, '#ef4444');
      ctx.strokeStyle = bar;
      ctx.lineCap = 'round';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(holeDef.spin.x - Math.cos(a) * holeDef.spin.len / 2, holeDef.spin.y - Math.sin(a) * holeDef.spin.len / 2);
      ctx.lineTo(holeDef.spin.x + Math.cos(a) * holeDef.spin.len / 2, holeDef.spin.y + Math.sin(a) * holeDef.spin.len / 2);
      ctx.stroke();
    });
  }
  // The cup is a hole, not a dot: a dark well with a lit lip and a flag on a
  // straight pole, so a player can find the target at a glance.
  const cup = holeDef.cup;
  const well = ctx.createRadialGradient(cup[0], cup[1] - CUP_R * 0.4, 1, cup[0], cup[1], CUP_R * 1.15);
  well.addColorStop(0, '#020617');
  well.addColorStop(1, '#0b1220');
  ctx.fillStyle = well;
  ctx.beginPath();
  ctx.arc(cup[0], cup[1], CUP_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(248,250,252,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cup[0], cup[1], CUP_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cup[0], cup[1]);
  ctx.lineTo(cup[0], cup[1] - 48);
  ctx.stroke();
  const pennant = ctx.createLinearGradient(cup[0], 0, cup[0] + 26, 0);
  pennant.addColorStop(0, '#ef4444');
  pennant.addColorStop(1, '#f97316');
  ctx.fillStyle = pennant;
  ctx.beginPath();
  ctx.moveTo(cup[0], cup[1] - 48);
  ctx.lineTo(cup[0] + 26, cup[1] - 39);
  ctx.lineTo(cup[0], cup[1] - 30);
  ctx.closePath();
  ctx.fill();
  if (view.shot?.path?.length) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    view.shot.path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const p of view.players || []) {
    const ball = view.ball?.[p.id];
    if (!ball) continue;
    if (view.holed?.[p.id]) continue;
    const mine = p.id === playerId;
    const base = mine ? '#f8fafc' : '#fca5a5';
    ctx.fillStyle = 'rgba(2,20,10,0.4)';
    ctx.beginPath();
    ctx.ellipse(ball.x + 2, ball.y + 3, GOLF_BALL_R, GOLF_BALL_R * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    UI.withGlow(ctx, base, mine ? 12 : 6, () => {
      const face = ctx.createRadialGradient(ball.x - 2, ball.y - 3, 1, ball.x, ball.y, GOLF_BALL_R);
      face.addColorStop(0, '#ffffff');
      face.addColorStop(1, base);
      ctx.fillStyle = face;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, GOLF_BALL_R, 0, Math.PI * 2);
      ctx.fill();
    });
    if (mine) {
      ctx.strokeStyle = 'rgba(15,23,42,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, GOLF_BALL_R, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (aim && live?.me) {
    const ball = view.ball[live.me];
    const dx = aim.x - ball.x;
    const dy = aim.y - ball.y;
    const dist = Math.min(Math.hypot(dx, dy), 220);
    const angle = Math.atan2(dy, dx);
    ctx.save();
    ctx.strokeStyle = '#fde68a';
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 6]);
    ctx.beginPath();
    ctx.moveTo(ball.x, ball.y);
    ctx.lineTo(ball.x + Math.cos(angle) * dist, ball.y + Math.sin(angle) * dist);
    ctx.stroke();
    ctx.setLineDash([]);
    // A power ring at the ball: the dashed line says where, this says how hard.
    ctx.strokeStyle = UI.withAlpha('#fde68a', 0.35 + 0.55 * (dist / 220));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, GOLF_BALL_R + 4, 0, Math.PI * 2 * (dist / 220));
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fde68a';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText(`${Math.round((dist / 220) * 100)}%`, ball.x + Math.cos(angle) * (dist + 16) - 10, ball.y + Math.sin(angle) * (dist + 16));
  }
}

export default { pong, invade, rocketBotRoyale, miniGolf };
