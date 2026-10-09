/**
 * MEME - the Smash-style platform fighter.
 *
 * Realtime and host-authoritative like the arcade engines: act({}) accepts
 * input actions and `{ type: 'tick', dt }` advances the fight in fixed 1/60s
 * slices.  Fighters build up damage percent; the higher the percent, the
 * further they fly, and flying past a blast zone costs a stock.  Last fighter
 * with stocks left wins.
 *
 * Roster flavour: eight original fighters (the "manga misc" cast) plus room for
 * custom sketches to be added later - colours and emoji stand in for sprites.
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

const STAGE = {
  platforms: [
    { x1: 170, y1: 330, x2: 550, y2: 330, main: true },
    { x1: 250, y1: 232, x2: 400, y2: 232 },
    { x1: 460, y1: 170, x2: 600, y2: 170 },
  ],
};

const FIGHTERS = [
  { id: 'kettle', name: 'Kettle', emoji: '🥋', color: '#f87171', special: 'Ramen Rush' },
  { id: 'mira', name: 'Mira Static', emoji: '⚡', color: '#facc15', special: 'Naptime Bolt' },
  { id: 'vex', name: 'Vex', emoji: '📓', color: '#a78bfa', special: 'Name Drop' },
  { id: 'bramble', name: 'Bramble', emoji: '🐾', color: '#4ade80', special: 'Map Mishap' },
  { id: 'nao', name: 'Neon Nao', emoji: '🔧', color: '#22d3ee', special: 'Vending Bomb' },
  { id: 'crumbs', name: 'Sir Crumbs', emoji: '🛡️', color: '#fbbf24', special: 'Butter Knife' },
  { id: 'yuki', name: 'Yuki Frostbyte', emoji: '❄️', color: '#93c5fd', special: 'Blizzard Step' },
  { id: 'noodle', name: 'Noodle', emoji: '🍜', color: '#fb923c', special: 'Snack Toss' },
];

function pickFighters(count, rng) {
  return U.shuffle(FIGHTERS, rng).slice(0, Math.max(2, Math.min(FIGHTERS.length, count)));
}

function blankInput() {
  return { left: false, right: false, up: false, down: false, fire: false };
}

function spawnPoint(state, index) {
  const slots = [
    { x: 250, y: 250 },
    { x: 470, y: 250 },
    { x: 200, y: 120 },
    { x: 520, y: 120 },
  ];
  return slots[index % slots.length];
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
    blurb: 'Platform fighter with original manga-misc fighters - and room for your own sketches.',
    tags: ['fighter', 'flagship', 'custom-art'],
    minutes: 6,
    status: 'playable',
    bots: true,
    maxBots: 3,
    rules: [
      'Build damage with punches and blasts - higher percent means a bigger launch.',
      'Knocked past the screen edge? That costs a stock.',
      'Last fighter with stocks left wins; if time runs out, most stocks (then least damage) wins.',
    ],
    options: [
      { id: 'stocks', label: 'Stocks', type: 'select', values: [1, 2, 3], default: 2 },
      { id: 'blast', label: 'Blast zones', type: 'select', values: [1, 0], default: 1 },
    ],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.time = 0;
    state.inputs = {};
    state.stocks = options.stocks || 2;
    state.limit = 150;
    state.out = {};
    state.customBlast = options.blast !== 0;
    const cast = pickFighters(players.length, rng);
    state.fighters = {};
    state.projectiles = [];
    state.hits = {};
    state.platforms = STAGE.platforms;
    state.players.forEach((p, i) => {
      state.inputs[p.id] = blankInput();
      state.out[p.id] = false;
      state.hits[p.id] = 0;
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
        skin: cast[i % cast.length],
      };
    });
    U.addLog(state, `${state.stocks} stocks each - fight!`);
    return state;
  },
  step(state, dt) {
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
        if (fighter.stocks <= 0) {
          state.out[p.id] = true;
          U.addLog(state, `${U.byId(state, p.id)?.name} is out of stocks!`, 'warn');
        } else {
          U.addLog(state, `${U.byId(state, p.id)?.name} loses a stock (${fighter.stocks} left).`, 'warn');
        }
      }
    }
    const remaining = state.players.filter((p) => !state.out[p.id]);
    const timedOut = state.time > state.limit;
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
      return { ok: true, events: [] };
    }
    if (action.type === 'tick') {
      const events = [];
      let remaining = U.clamp(Number(action.dt) || 1 / 30, SUBSTEP, 0.1);
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
  bot(state) {
    if (state.winnerId) return null;
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
    v.turn = state.players.filter((p) => !state.out[p.id]).map((p) => p.id);
    return v;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, state, playerId, send, host }) {
    const stage = UI.realtimeStage({
      el,
      snapshot: state || view,
      width: W,
      height: H,
      draw: (ctx, w, h, snap) => drawSmash(ctx, w, h, snap, playerId),
      hudText: (s) => (s.players || [])
        .map((p) => {
          const fighter = s.fighters?.[p.id];
          if (!fighter) return p.name;
          return `${p.name} ${s.out?.[p.id] ? '💀' : `×${fighter.stocks} ${Math.round(fighter.percent)}%`}`;
        })
        .join(' · '),
    });
    const keys = blankInput();
    const { mode, cleanup } = UI.realtimeControls({ wrap: stage.wrap, host, state, playerId, keys, send });
    if (mode === 'local') {
      let ended = false;
      UI.every(stage.wrap, 33, () => {
        if (state.winnerId) {
          if (!ended) {
            ended = true;
            host?.refresh?.();
          }
          return;
        }
        let remaining = 1 / 30;
        let guard = 0;
        while (remaining > 0 && !state.winnerId && guard++ < 4) {
          const slice = Math.min(SUBSTEP, remaining);
          memesSmash.step(state, slice);
          remaining -= slice;
        }
        stage.box.redraw();
      });
    }
    const hint = 'Arrows / WASD to move and jump, space to punch, down to blast.';
    stage.wrap.appendChild(UI.muted(UI.realtimeHint(mode, hint, 'Spectating the brawl...')));
    return UI.withLive(cleanup, stage, { keys });
  },
};

function applyFighterInput(state, id, dt) {
  const fighter = state.fighters[id];
  const input = state.inputs[id] || blankInput();
  if (!fighter || fighter.respawn > 0) return;
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
      fighter.vx += dir * ACCEL * dt * (fighter.onGround ? 1 : 0.75);
    } else if (fighter.onGround) {
      fighter.vx *= 1 - 8 * dt;
    } else {
      // Air drag stays light so launches actually carry people off stage.
      fighter.vx *= 1 - 0.45 * dt;
    }
    fighter.vx = U.clamp(fighter.vx, -MAX_HS * 1.6, MAX_HS * 1.6);
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
      .filter(({ target }) => Math.abs(target.x - fighter.x) < 56 && Math.abs(target.y - fighter.y) < 42)
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
      vx: fighter.facing * 300,
      vy: -20,
      owner: id,
      life: 1.8,
      color: fighter.skin.color,
    });
  }
  // physics
  fighter.vy += GRAVITY * dt;
  fighter.x += fighter.vx * dt;
  fighter.y += fighter.vy * dt;
  const wasFalling = fighter.vy >= 0;
  fighter.onGround = false;
  for (const platform of STAGE.platforms) {
    if (fighter.x < platform.x1 - 6 || fighter.x > platform.x2 + 6) continue;
    if (wasFalling && fighter.y >= platform.y1 - 18 && fighter.y <= platform.y1 + 14 && fighter.vy >= 0) {
      fighter.y = platform.y1 - 18;
      fighter.vy = 0;
      fighter.onGround = true;
      fighter.jumps = 2;
    }
  }
  if (fighter.onGround) fighter.jumps = 2;
}

function hitFighter(state, targetId, attackerId, damage, dir, scale) {
  const target = state.fighters[targetId];
  const attacker = state.fighters[attackerId];
  if (!target || target.invuln > 0) return;
  target.percent = Math.min(999, target.percent + damage);
  const knock = (65 + target.percent * 2.4) * scale;
  target.vx = dir * knock * 0.75 + (attacker?.vx || 0) * 0.25;
  target.vy = -knock * 0.42;
  target.stun = 0.22;
  target.onGround = false;
  state.hits[attackerId] = (state.hits[attackerId] || 0) + 1;
  U.addScore(state, attackerId, 1);
}

function respawnFighter(state, id) {
  const fighter = state.fighters[id];
  if (!fighter || fighter.stocks <= 0) return;
  const index = state.players.findIndex((p) => p.id === id);
  const point = spawnPoint(state, index);
  fighter.x = point.x;
  fighter.y = point.y - 60;
  fighter.vx = 0;
  fighter.vy = 0;
  fighter.percent = 0;
  fighter.invuln = 2;
  fighter.respawn = 0;
  fighter.onGround = false;
  fighter.jumps = 2;
}

function smashAi(state, id, dt) {
  const me = state.fighters[id];
  if (!me || me.respawn > 0) return;
  const input = state.inputs[id];
  const level = U.byId(state, id)?.level ?? 2;
  const skill = U.botSkill(level);
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
      const plat = STAGE.platforms.find((pl) => me.onGround && Math.abs(me.y - (pl.y1 - 18)) < 6 && me.x > pl.x1 - 16 && me.x < pl.x2 + 16);
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
  input.fire = dist < 56 && Math.random() < 0.6 + skill * 0.35;
  input.down = me.onGround && dist > 220 && dist < 460 && Math.random() < 0.01 + skill * 0.02;
}

function drawSmash(ctx, w, h, snapshot, playerId) {
  // The same neon arena language as the other action games, so the brawl has a
  // lit floor to happen over instead of a bare gradient.
  UI.arenaBackdrop(ctx, w, h, { palette: 'neon', horizon: 0.72, stars: 34 });
  for (const platform of snapshot.platforms || []) {
    const pw = platform.x2 - platform.x1;
    ctx.save();
    // A drop shadow under the deck sells the height the fighters jump from.
    ctx.fillStyle = 'rgba(2,6,23,0.5)';
    UI.roundRect(ctx, platform.x1 + 3, platform.y1 + 6, pw, 14, 6);
    ctx.fill();
    const deck = ctx.createLinearGradient(0, platform.y1, 0, platform.y1 + 14);
    deck.addColorStop(0, '#64748b');
    deck.addColorStop(1, '#1e293b');
    UI.withGlow(ctx, '#38bdf8', 10, () => {
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
    ctx.fillText(fighter.skin?.emoji || '🥊', fighter.x - 8, fighter.y + 4);
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(`${Math.round(fighter.percent)}%`, fighter.x - 14, fighter.y - 28);
    if (p.id === playerId) {
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(fighter.x, fighter.y, 21, 24, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

export default { memesSmash };
