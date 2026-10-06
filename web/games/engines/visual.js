/**
 * Visual family: Spot the Difference and Guess the Zoomed Image.
 *
 * Both games draw their scenes procedurally from a seed, so a match never
 * repeats and nothing is downloaded.  Scene coordinates are normalised 0..1 so
 * the same data renders identically on a phone and a desktop canvas.
 */
import * as U from './util.js';
import * as UI from './ui.js';

const MODES = ['solo', 'local', 'online'];
const PALETTE_KEYS = ['neon', 'sunset', 'forest', 'arcade', 'candy', 'mono'];

function paletteColors(key) {
  return UI.PALETTES[key] || UI.PALETTES.neon;
}

/** Deterministic shape list in normalised 0..1 space. */
function makeScene(seed, density = 18) {
  const rng = U.makeRng(seed);
  const key = PALETTE_KEYS[Math.floor(rng() * PALETTE_KEYS.length)];
  const colors = paletteColors(key);
  const shapes = [];
  for (let i = 0; i < density; i++) {
    shapes.push({
      type: Math.floor(rng() * 5),
      x: 0.06 + rng() * 0.88,
      y: 0.08 + rng() * 0.84,
      size: 0.06 + rng() * 0.14,
      color: colors[1 + Math.floor(rng() * (colors.length - 1))],
      rot: Math.round(rng() * 6.283 * 100) / 100,
      alpha: 0.7 + rng() * 0.3,
    });
  }
  return { key, colors, shapes };
}

function paintShapes(ctx, w, h, scene) {
  const colors = scene.colors || paletteColors(scene.key);
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, w, h);
  for (const shape of scene.shapes) {
    UI.drawShape(ctx, shape.type, shape.x * w, shape.y * h, shape.size * Math.min(w, h) * 1.6, shape.color, shape.rot, shape.alpha ?? 1);
  }
}

/* ========================================================================= *
 * Spot the Difference
 * ========================================================================= */

const DIFF_POINTS_FIRST = 10;
const DIFF_POINTS_LATE = 4;

function buildScenePair(seed, rng, diffCount) {
  const base = makeScene(seed);
  const variant = { key: base.key, colors: base.colors, shapes: base.shapes.map((s) => ({ ...s })) };
  const indexes = U.shuffle(base.shapes.map((_, i) => i), rng).slice(0, Math.min(diffCount, base.shapes.length));
  const diffs = [];
  for (const i of indexes) {
    const kind = U.pick(['gone', 'recolor', 'move', 'size'], rng);
    const shape = variant.shapes[i];
    if (kind === 'gone') {
      shape.hidden = true;
    } else if (kind === 'recolor') {
      const colors = paletteColors(base.key);
      shape.color = colors[1 + Math.floor(rng() * (colors.length - 1))];
    } else if (kind === 'move') {
      shape.x = U.clamp(shape.x + (rng() < 0.5 ? -1 : 1) * (0.07 + rng() * 0.06), 0.04, 0.96);
      shape.y = U.clamp(shape.y + (rng() < 0.5 ? -1 : 1) * (0.06 + rng() * 0.06), 0.04, 0.96);
    } else {
      shape.size = U.clamp(shape.size * (rng() < 0.5 ? 0.5 : 1.7), 0.04, 0.3);
    }
    const spot = { i, kind, x: base.shapes[i].x, y: base.shapes[i].y, r: 0.075 };
    if (kind === 'move') {
      spot.x = (base.shapes[i].x + variant.shapes[i].x) / 2;
      spot.y = (base.shapes[i].y + variant.shapes[i].y) / 2;
    }
    diffs.push(spot);
  }
  return { sceneA: base, sceneB: variant, diffs };
}

export const spotDifference = {
  meta: {
    id: 'spot-difference',
    name: 'Spot the Difference',
    icon: '🔍',
    category: 'puzzle',
    players: { min: 1, max: 8 },
    modes: MODES,
    simultaneous: true,
    secret: true,
    blurb: 'Scenes are generated on the fly with sneaky differences. Click them before your rivals.',
    tags: ['puzzle', 'race'],
    minutes: 8,
    status: 'playable',
    bots: true,
    maxBots: 6,
    rules: [
      'Two versions of the same scene are drawn side by side.',
      'Click every difference - the first to find one takes the big points.',
      'Clear all differences, then the next scene starts. Most points wins.',
    ],
    options: [
      { id: 'rounds', label: 'Scenes', type: 'select', values: [2, 3, 5], default: 3 },
      { id: 'diffs', label: 'Differences', type: 'select', values: [3, 5, 7], default: 5 },
    ],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.maxRounds = options.rounds || 3;
    state.perScene = options.diffs || 5;
    state.round = 1;
    state.botMisses = 0;
    state.rounds = [];
    for (let i = 0; i < state.maxRounds; i++) {
      state.rounds.push(buildScenePair(Math.floor(rng() * 1e9), rng, state.perScene));
    }
    loadScene(state);
    U.addLog(state, `Scene 1 - find ${state.rounds[0].diffs.length} differences!`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    const scene = state.rounds[state.round - 1];
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.sceneA = scene.sceneA;
    v.sceneB = scene.sceneB;
    v.totalDiffs = scene.diffs.length;
    v.found = state.found; // { diffIndex: [playerIds] }
    // Positions stay private until someone finds them.
    v.diffSpots = {};
    for (const [i, ids] of Object.entries(state.found || {})) {
      if (ids.length && scene.diffs[Number(i)]) v.diffSpots[i] = { x: scene.diffs[Number(i)].x, y: scene.diffs[Number(i)].y };
    }
    v.foundCount = Object.keys(state.found || {}).length;
    v.myFound = Object.entries(state.found || {}).filter(([, ids]) => ids.includes(viewerId)).map(([i]) => Number(i));
    v.readies = state.ready || [];
    v.miss = state.miss?.[viewerId] || 0;
    v.turn = state.phase === 'hunt' ? state.players.map((p) => p.id) : (state.ready ? state.players.filter((p) => !state.ready.includes(p.id)).map((p) => p.id) : []);
    if (state.winnerId) v.turn = [];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    const events = [];
    if (action.type === 'find') {
      if (state.phase !== 'hunt') return { ok: false, error: 'This scene is finished.' };
      const x = U.clamp(Number(action.x), 0, 1);
      const y = U.clamp(Number(action.y), 0, 1);
      const scene = state.rounds[state.round - 1];
      let best = null;
      let bestDist = Infinity;
      for (const [i, diff] of scene.diffs.entries()) {
        const d = Math.hypot(diff.x - x, diff.y - y);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      if (best === null || bestDist > 0.08) {
        state.miss[playerId] = (state.miss[playerId] || 0) + 1;
        return { ok: false, error: 'Nothing there - look again.' };
      }
      const finders = state.found[best] || [];
      if (finders.includes(playerId)) return { ok: false, error: 'You already found that one.' };
      const first = finders.length === 0;
      const points = first ? DIFF_POINTS_FIRST : DIFF_POINTS_LATE;
      finders.push(playerId);
      state.found[best] = finders;
      U.addScore(state, playerId, points);
      events.push(U.event(`${U.byId(state, playerId)?.name} spotted a difference${first ? ' first' : ''} (+${points}).`, first ? 'win' : 'info'));
      if (Object.keys(state.found).length >= scene.diffs.length) {
        state.phase = 'reveal';
        state.ready = [];
        events.push(U.event('Scene cleared!', 'win'));
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Keep hunting.' };
      if (!state.ready.includes(playerId)) state.ready.push(playerId);
      if (state.players.every((p) => state.ready.includes(p.id))) {
        if (state.round >= state.maxRounds) {
          const ranked = U.ranking(state);
          state.winnerId = ranked.filter((r) => r.score === ranked[0].score).map((r) => r.id);
          state.summary = `${ranked[0].name} has the sharpest eyes (+${ranked[0].score})!`;
          events.push(U.event(state.summary, 'win'));
        } else {
          state.round++;
          loadScene(state);
          events.push(U.event(`Scene ${state.round} - ${state.rounds[state.round - 1].diffs.length} differences this time.`, 'info'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    const scene = state.rounds[state.round - 1];
    if (state.phase === 'hunt') {
      const level = U.byId(state, playerId)?.level ?? 2;
      const skill = U.botSkill(level);
      const unfound = scene.diffs.map((d, i) => ({ d, i })).filter(({ i }) => !(state.found[i] || []).includes(playerId));
      if (!unfound.length) return null;
      // Prefer a difference nobody has taken yet; the jitter shrinks as level rises.
      const fresh = unfound.filter(({ i }) => !(state.found[i] || []).length);
      const target = (fresh.length ? fresh : unfound)[0];
      const error = (1 - skill) * 0.06;
      return { type: 'find', x: U.clamp(target.d.x + (Math.random() - 0.5) * error, 0.02, 0.98), y: U.clamp(target.d.y + (Math.random() - 0.5) * error, 0.02, 0.98) };
    }
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Scene ${view.round}/${view.maxRounds}`),
      UI.pill(`${view.foundCount}/${view.totalDiffs} found`),
      UI.pill(`Misses: ${view.miss}`)));
    const variants = [
      { label: 'Original', data: { key: view.sceneA.key, colors: view.sceneA.colors, shapes: view.sceneA.shapes } },
      { label: 'Changed', data: { key: view.sceneB.key, colors: view.sceneB.colors, shapes: view.sceneB.shapes } },
    ];
    const canClick = view.phase === 'hunt';
    el.appendChild(UI.h('div', { class: 'two-up' }, variants.map((variant) => {
      const box = UI.canvasBox(420, 300, (ctx, w, h) => {
        paintShapes(ctx, w, h, variant.data);
        for (const [i, ids] of Object.entries(view.found || {})) {
          if (!ids.length) continue;
          const diff = view.diffSpots?.[i];
          if (!diff) continue;
          ctx.beginPath();
          ctx.arc(diff.x * w, diff.y * h, 16, 0, Math.PI * 2);
          ctx.strokeStyle = ids.includes(playerId) ? '#22c55e' : '#facc15';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }, { className: 'spot-canvas' });
      if (canClick) {
        box.canvas.style.cursor = 'crosshair';
        box.canvas.addEventListener('click', (ev) => {
          const rect = box.canvas.getBoundingClientRect();
          send({ type: 'find', x: (ev.clientX - rect.left) / rect.width, y: (ev.clientY - rect.top) / rect.height });
        });
      }
      return UI.panel(variant.label, box.el);
    })));
    if (view.phase === 'reveal') {
      el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.readies.includes(p.id) ? 'done' : ''}` }, `${p.name}${view.readies.includes(p.id) ? ' ✓' : ''}`))));
      el.appendChild(UI.btn(view.round >= view.maxRounds ? 'Finish' : 'Next scene', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
    } else {
      el.appendChild(UI.h('div', { class: 'keyboard-hint', text: 'Click a difference on either picture.' }));
    }
  },
};

function loadScene(state) {
  const scene = state.rounds[state.round - 1];
  state.found = {};
  state.ready = [];
  state.miss = {};
  state.phase = 'hunt';
  state.diffSpots = scene.diffs.map((d) => ({ x: d.x, y: d.y }));
  for (const player of state.players) state.miss[player.id] = 0;
  return state;
}

/* ========================================================================= *
 * Guess the Zoomed Image
 * ========================================================================= */

const ZOOM_LEVELS = [7, 4.5, 2.6, 1.4];
const ZOOM_POINTS = [8, 6, 4, 2];

const SCENE_LABELS = [
  'Underwater party', 'Space station', 'Deep forest', 'Neon city', 'Desert carnival',
  'Sky islands', 'Volcano lab', 'Frozen lake', 'Robot workshop', 'Candy kingdom',
  'Ghost town', 'Jungle ruins', 'Thunderstorm', 'Bubble ocean', 'Mushroom village',
  'Crystal cave',
];

function zoomPick(label, rng) {
  return { label, seed: Math.floor(rng() * 1e9), fx: 0.3 + rng() * 0.4, fy: 0.3 + rng() * 0.4 };
}

export const zoomedImage = {
  meta: {
    id: 'zoomed-image',
    name: 'Guess the Zoomed Image',
    icon: '🔬',
    category: 'puzzle',
    players: { min: 1, max: 12 },
    modes: MODES,
    simultaneous: true,
    blurb: 'A scene is zoomed way in. It zooms out every round - guess before it is obvious.',
    tags: ['quiz', 'visual'],
    minutes: 8,
    status: 'playable',
    bots: true,
    maxBots: 8,
    rules: [
      'Each round the camera zooms out a little more.',
      'Everyone picks from the same four scene names at the same time.',
      'Earlier correct guesses are worth more points.',
    ],
    options: [{ id: 'rounds', label: 'Scenes', type: 'select', values: [2, 3, 5], default: 3 }],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.maxRounds = (options.rounds || 3) * ZOOM_LEVELS.length;
    state.scenes = U.shuffle(SCENE_LABELS, rng).slice(0, options.rounds || 3).map((label) => zoomPick(label, rng));
    state.round = 1;
    state.pool = U.shuffle(SCENE_LABELS, rng);
    beginZoom(state);
    U.addLog(state, 'Zoomed in - what are you looking at?');
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.question = {
      seed: state.question.seed,
      palette: state.question.palette,
      fx: state.question.fx,
      fy: state.question.fy,
      options: state.question.options,
    };
    v.zoomIndex = state.zoomIndex;
    v.zoom = ZOOM_LEVELS[state.zoomIndex];
    v.myAnswer = state.answers[viewerId] ?? null;
    v.answered = Object.keys(state.answers);
    v.readies = state.ready || [];
    v.revealed = state.revealed;
    v.turn = state.phase === 'ask' ? state.players.filter((p) => state.answers[p.id] === undefined).map((p) => p.id) : state.players.filter((p) => !state.ready.includes(p.id)).map((p) => p.id);
    if (state.winnerId) v.turn = [];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    const events = [];
    if (action.type === 'answer') {
      if (state.phase !== 'ask') return { ok: false, error: 'Answers are closed.' };
      if (state.answers[playerId] !== undefined) return { ok: false, error: 'You already guessed.' };
      const choice = state.question.options.find((o) => o.id === action.choice);
      if (!choice) return { ok: false, error: 'Pick one of the scenes.' };
      state.answers[playerId] = choice.id;
      state.answerOrder.push(playerId);
      if (state.players.every((p) => state.answers[p.id] !== undefined)) {
        state.phase = 'reveal';
        resolveZoom(state, events);
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      if (!state.ready.includes(playerId)) state.ready.push(playerId);
      if (state.players.every((p) => state.ready.includes(p.id))) {
        if (state.round >= state.maxRounds) {
          const ranked = U.ranking(state);
          state.winnerId = ranked.filter((r) => r.score === ranked[0].score).map((r) => r.id);
          state.summary = `${ranked[0].name} recognised the most scenes (+${ranked[0].score})!`;
          events.push(U.event(state.summary, 'win'));
        } else {
          state.round++;
          beginZoom(state);
          events.push(U.event(`Scene ${Math.floor((state.round - 1) / ZOOM_LEVELS.length) + 1}, zoom ${ZOOM_LEVELS[0]}x...`, 'info'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    if (state.phase === 'ask' && state.answers[playerId] === undefined) {
      const level = U.byId(state, playerId)?.level ?? 2;
      const skill = U.botSkill(level);
      // The later the round, the easier it is to recognise the scene.
      const chance = [0.15, 0.35, 0.6, 0.85][state.zoomIndex] * (0.4 + skill * 0.9);
      const options = state.question.options;
      const correct = options.find((o) => o.id === state.question.correctId);
      if (correct && Math.random() < chance) return { type: 'answer', choice: correct.id };
      return { type: 'answer', choice: U.pick(options.filter((o) => o.id !== state.question.correctId)).id };
    }
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Scene ${Math.floor((view.round - 1) / ZOOM_LEVELS.length) + 1}/${view.maxRounds / ZOOM_LEVELS.length}`),
      UI.pill(`Zoom ${view.zoom}x`),
      UI.pill(`${view.answered.length}/${view.players.length} guessed`)));
    if (view.phase === 'ask') {
      const art = UI.canvasBox(520, 300, (ctx, w, h) => {
        ctx.save();
        ctx.scale(view.zoom, view.zoom);
        ctx.translate(-view.question.fx * w, -view.question.fy * h);
        UI.paintScene(ctx, w, h, view.question.seed, { palette: view.question.palette, density: 24 });
        ctx.restore();
      }, { className: 'zoomed-canvas' });
      el.appendChild(UI.h('div', { class: 'prompt-card art' }, art.el, UI.h('div', { class: 'prompt-sub', text: 'Zooming out...' })));
      el.appendChild(UI.h('div', { class: 'option-grid' },
        view.question.options.map((opt) => UI.h('button', { class: 'option', onClick: () => send({ type: 'answer', choice: opt.id }) }, UI.h('strong', { text: opt.text })))));
      el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.answered.includes(p.id) ? 'done' : ''}` }, `${p.name}${view.answered.includes(p.id) ? ' ✓' : ''}`))));
      return;
    }
    el.appendChild(UI.promptCard(`It was ${view.revealed?.label}!`, `Worth ${view.revealed?.points}`));
    el.appendChild(UI.scoreboard(view));
    el.appendChild(UI.btn(view.round >= view.maxRounds ? 'Finish' : 'Next scene', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
  },
};

function beginZoom(state) {
  const sceneIndex = Math.floor((state.round - 1) / ZOOM_LEVELS.length);
  const scene = state.scenes[sceneIndex];
  state.zoomIndex = (state.round - 1) % ZOOM_LEVELS.length;
  const decoys = state.pool.filter((l) => l !== scene.label).slice(0, 3);
  const options = U.shuffle([scene.label, ...decoys]).map((text, i) => ({ id: String.fromCharCode(97 + i), text }));
  const correct = options.find((o) => o.text === scene.label);
  state.answers = {};
  state.answerOrder = [];
  state.ready = [];
  state.revealed = null;
  state.phase = 'ask';
  state.question = {
    seed: scene.seed,
    palette: PALETTE_KEYS[sceneIndex % PALETTE_KEYS.length],
    fx: scene.fx,
    fy: scene.fy,
    label: scene.label,
    options,
    correctId: correct.id,
  };
}

function resolveZoom(state, events) {
  const points = ZOOM_POINTS[state.zoomIndex] ?? 2;
  const results = [];
  for (const [id, value] of Object.entries(state.answers)) {
    const correct = value === state.question.correctId;
    if (correct) {
      U.addScore(state, id, points);
      events.push(U.event(`${U.byId(state, id)?.name} got it (+${points}).`, 'win'));
    }
    results.push({ id, correct, points: correct ? points : 0 });
  }
  if (!results.some((r) => r.correct)) events.push(U.event('Nobody guessed it - it just gets easier from here.', 'warn'));
  state.revealed = { label: state.question.label, correctId: state.question.correctId, points, results };
}

export default { spotDifference, zoomedImage };
