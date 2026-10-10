/**
 * Drawing family.
 *
 *  - gartic-phone  : telephone chains (classic, exquisite corpse, blind, speed,
 *                    story corpse) - prompts, drawings and guesses rotate.
 *  - charades-draw : one artist draws a secret word while the room guesses.
 *  - meme-maker    : same template, everyone writes a caption, then votes.
 *  - bad-drawing   : draw with a sabotaged brush, then vote for the worst-best.
 *
 * Strokes are always normalised 0..1 point lists so they render identically at
 * any size and serialise cleanly over the wire.
 */
import * as U from './util.js';
import * as UI from './ui.js';

const MODES = ['local', 'online'];
const DRAW_MODES = MODES;

/* ------------------------------------------------------------------ *
 * shared helpers
 * ------------------------------------------------------------------ */

/**
 * Normalise whatever a client sent into storable strokes.
 *
 * Points go through UI.pointXY, so a pair, a {x, y} object or garbage all land
 * as a clamped 0..1 pair instead of silently collapsing to a 0,0 dot.
 */
export function cleanStrokes(strokes, maxStrokes = 260, maxPoints = 900) {
  if (!Array.isArray(strokes)) return [];
  const out = [];
  for (const stroke of strokes.slice(0, maxStrokes)) {
    if (!stroke || !Array.isArray(stroke.pts)) continue;
    const pts = stroke.pts.slice(0, maxPoints).map(UI.pointXY);
    if (!pts.length) continue;
    out.push({ color: String(stroke.color || '#111827').slice(0, 16), width: U.clamp(Number(stroke.width) || 5, 1, 40), pts });
  }
  return out;
}

export function strokeCount(strokes) {
  return (strokes || []).reduce((n, s) => n + (s.pts?.length || 0), 0);
}

/**
 * The strokes of the pad in `host.uiState`, scoped to one seat of one round.
 *
 * A pad is rebuilt on every re-render while `uiState` lives for the whole
 * session, so without the key the next player of a hot-seat round opened a
 * canvas already full of the previous player's drawing - and submitted it as
 * their own on top.  Changing the key (or a rematch, which keys on a new seed)
 * starts them on an empty page.
 */
function padStrokes(ui, view, playerId, what) {
  const key = `${view.seed ?? 0}:${what}:${view.roundIndex ?? view.round ?? 0}:${playerId}`;
  if (ui.padKey !== key) {
    ui.padKey = key;
    ui.strokes = [];
  }
  return ui.strokes || (ui.strokes = []);
}

const PROMPTS = [
  'A cat running a bakery', 'A dragon afraid of heights', 'A robot walking a dog',
  'A shark in a bathtub', 'An astronaut on a bike', 'A pigeon with a briefcase',
  'A haunted fridge', 'A wizard shopping for groceries', 'A bear riding a train',
  'A detective duck', 'A volcano with a hat', 'A very small elephant on a very big chair',
  'A pizza delivery to the moon', 'A penguin surfing', 'Two llamas having a chat',
  'A snail winning a race', 'A ghost eating toast', 'A knight fighting a lawnmower',
  'A monkey teaching maths', 'A robot chef burning soup', 'A giraffe hiding behind a lamppost',
  'A frog in a tiny car', 'A superhero with a shopping trolley', 'An owl doing homework',
];

const CORPSE_SLOTS = ['head', 'right-arm', 'left-arm', 'right-leg', 'left-leg'];

const CORPSE_GUIDE = {
  head: { x: 0.28, y: 0.03, w: 0.44, h: 0.26, hint: 'Draw the HEAD' },
  'right-arm': { x: 0.6, y: 0.3, w: 0.36, h: 0.3, hint: 'Draw the RIGHT ARM' },
  'left-arm': { x: 0.04, y: 0.3, w: 0.36, h: 0.3, hint: 'Draw the LEFT ARM' },
  'right-leg': { x: 0.52, y: 0.61, w: 0.4, h: 0.36, hint: 'Draw the RIGHT LEG' },
  'left-leg': { x: 0.08, y: 0.61, w: 0.4, h: 0.36, hint: 'Draw the LEFT LEG' },
};

const PRESETS = {
  classic: { name: 'Classic', drawRounds: 2, guessRounds: 2, blind: false, speed: false },
  'exquisite-corpse': { name: 'Exquisite Corpse', corpse: true },
  blind: { name: 'Blind Draw', drawRounds: 2, guessRounds: 2, blind: true, peek: 300 },
  speed: { name: 'Speedrun', drawRounds: 2, guessRounds: 2, speed: true },
  'story-corpse': { name: 'Story Corpse', drawRounds: 1, guessRounds: 1, story: true },
};

function chainSlot(state, playerIndex) {
  const n = state.players.length;
  return (playerIndex - state.roundIndex + n * 4) % n;
}

/* ========================================================================= *
 * Gartic Phone (all presets)
 * ========================================================================= */

export const garticPhone = {
  meta: {
    id: 'gartic-phone',
    name: 'Gartic Phone',
    icon: '📞',
    category: 'drawing',
    players: { min: 3, max: 16 },
    modes: DRAW_MODES,
    secret: true,
    blurb: 'Write, draw, guess, repeat - then watch the telephone chain fall apart.',
    tags: ['drawing', 'party', 'flagship'],
    minutes: 20,
    status: 'playable',
    bots: true,
    maxBots: 6,
    turnMs: 90000,
    rules: [
      'Round 1: everyone writes a prompt.',
      'Each round after that you either draw what you were given, or guess what was drawn.',
      'Work is passed along between rounds, so the final reveal is gloriously wrong.',
      'Exquisite Corpse: each player draws one body part blind - we assemble the creature at the end.',
    ],
    options: [
      { id: 'preset', label: 'Preset', type: 'select', values: Object.keys(PRESETS), default: 'classic' },
      { id: 'rounds', label: 'Chain length', type: 'select', values: [2, 3, 4], default: 2 },
      { id: 'timer', label: 'Seconds per round', type: 'select', values: [45, 90, 180], default: 90 },
    ],
  },

  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    const presetId = PRESETS[options.preset] ? options.preset : 'classic';
    state.presetId = presetId;
    state.preset = PRESETS[presetId];
    state.promptPool = U.shuffle(PROMPTS, rng);
    state.books = {};
    for (const p of state.players) state.books[p.id] = [];
    state.corpse = { creatures: [], parts: {} };
    if (state.preset.corpse) {
      const n = state.players.length;
      state.corpse.creatures = Array.from({ length: n }, (_, i) => ({ id: `creature${i}`, parts: {}, authors: {} }));
      state.slots = CORPSE_SLOTS;
      state.roundIndex = 0;
      state.phase = 'draw';
      state.taskLabel = CORPSE_GUIDE[CORPSE_SLOTS[0]].hint;
    } else {
      state.chainRounds = [];
      const draws = state.preset.story ? 1 : state.preset.drawRounds ?? 2;
      state.chainRounds.push('prompt');
      for (let i = 0; i < draws; i++) {
        state.chainRounds.push('draw');
        state.chainRounds.push('guess');
      }
      state.roundIndex = 0;
      state.phase = 'prompt';
    }
    state.submittedRound = [];
    state.timer = (options.timer || 90) * 1000;
    state.reaction = {}; // guesses-to-artist mapping for scoring
    state.revealIndex = 0;
    state.turnId = state.players[0].id;
    U.addLog(state, `Preset: ${state.preset.name}. Round 1 - ${state.phase}.`);
    return state;
  },

  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    const myIndex = state.players.findIndex((p) => p.id === viewerId);
    v.presetId = state.presetId;
    v.seed = state.seed;
    v.phase = state.phase;
    v.roundIndex = state.roundIndex;
    v.chainRounds = state.chainRounds;
    v.corpseMode = !!state.preset.corpse;
    v.blind = !!state.preset.blind;
    v.story = !!state.preset.story;
    v.submitted = state.submittedRound.includes(viewerId);
    v.submittedIds = state.submittedRound;
    v.myBook = state.books[viewerId] || [];
    v.deadline = state.turnDeadline || 0;

    if (state.phase === 'reveal') {
      v.books = state.books;
      v.creatures = state.corpse.creatures;
      // The reveal is the end of the chain: without these the phase bar reads
      // "NaN/undefined" over the finished books.
      v.roundsTotal = state.preset.corpse ? CORPSE_SLOTS.length : state.chainRounds.length;
      v.roundsDone = v.roundsTotal;
      v.spectator = false;
      v.turn = state.players.filter((p) => !(state.readyForNext || []).includes(p.id)).map((p) => p.id);
      v.myTurn = v.turn.includes(viewerId);
      return v;
    }
    if (state.preset.corpse) {
      const slot = CORPSE_SLOTS[state.roundIndex % CORPSE_SLOTS.length];
      const creatureIndex = (myIndex - state.roundIndex + state.players.length * 4) % state.players.length;
      v.slot = slot;
      v.guide = CORPSE_GUIDE[slot];
      v.creatureIndex = creatureIndex;
      v.creatureId = state.corpse.creatures[creatureIndex]?.id;
      v.myStrokes = state.corpse.parts[`${creatureIndex}:${slot}`]?.strokes || [];
      v.turn = waitingSeats(state);
      v.myTurn = v.turn.includes(viewerId);
      v.roundsTotal = CORPSE_SLOTS.length;
      v.roundsDone = state.roundIndex;
      return v;
    }

    // classic / blind / story / speed chains
    const sourceIndex = myIndex;
    const slot = (sourceIndex - state.roundIndex + state.players.length * 4) % state.players.length;
    const source = state.players[slot];
    v.sourceName = source?.name || '???';
    const chain = state.books[source?.id] || [];
    const prev = chain[chain.length - 1] || null;
    v.prev = prev
      ? state.preset.blind && prev.kind === 'draw'
        ? { ...prev, strokes: prev.strokes.slice(-6) }
        : prev
      : null;
    v.roundsTotal = state.chainRounds.length;
    v.roundsDone = state.roundIndex;
    // Everyone still to act, so bots (and the turn timer) see the whole board.
    v.turn = state.phase === 'prompt'
      ? state.players.filter((p) => !state.books[p.id].length || state.books[p.id][0].kind !== 'prompt').map((p) => p.id)
      : waitingSeats(state);
    v.myTurn = v.turn.includes(viewerId);
    return v;
  },

  act(state, playerId, action) {
    if (state.phase === 'reveal') {
      if (action.type !== 'ready') return { ok: false, error: 'The reveal has started - mark yourself ready to finish.' };
      if ((state.readyForNext || []).includes(playerId)) return { ok: false, error: 'You are already ready.' };
      state.readyForNext = [...new Set([...(state.readyForNext || []), playerId])];
      return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} is ready to finish.`, 'info')] };
    }

    if (state.preset.corpse) {
      if (state.submittedRound.includes(playerId)) return { ok: false, error: 'You already drew your part.' };
      if (action.type !== 'draw') return { ok: false, error: 'Draw your part and submit.' };
      const myIndex = state.players.findIndex((p) => p.id === playerId);
      const slot = CORPSE_SLOTS[state.roundIndex % CORPSE_SLOTS.length];
      const creatureIndex = ((myIndex - state.roundIndex) % state.players.length + state.players.length) % state.players.length;
      const strokes = cleanStrokes(action.strokes);
      if (!strokes.length) return { ok: false, error: 'The canvas is empty.' };
      const key = `${creatureIndex}:${slot}`;
      state.corpse.parts[key] = { slot, strokes, by: playerId, name: U.byId(state, playerId)?.name };
      state.corpse.creatures[creatureIndex].parts[slot] = strokes;
      state.corpse.creatures[creatureIndex].authors[slot] = U.byId(state, playerId)?.name;
      state.submittedRound.push(playerId);
      const events = [U.event(`${U.byId(state, playerId)?.name} drew the ${slot.replace('-', ' ')}.`, 'move')];
      if (state.players.every((p) => state.submittedRound.includes(p.id))) advanceCorpse(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }

    if (state.phase === 'prompt') {
      if (action.type !== 'prompt') return { ok: false, error: 'Write a prompt first.' };
      if (state.books[playerId].length) return { ok: false, error: 'You already sent a prompt.' };
      const text = String(action.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
      if (!text) return { ok: false, error: 'Write a prompt first.' };
      state.books[playerId].push({ kind: 'prompt', by: playerId, name: U.byId(state, playerId)?.name, text });
      state.submittedRound.push(playerId);
      U.addLog(state, `${U.byId(state, playerId)?.name} wrote a prompt.`, 'info');
      const events = [];
      if (state.players.every((p) => state.submittedRound.includes(p.id))) advanceChain(state, events);
      return { ok: true, events };
    }

    if (state.phase === 'draw') {
      if (action.type !== 'draw') return { ok: false, error: 'Submit your drawing.' };
      const strokes = cleanStrokes(action.strokes);
      if (!strokes.length) return { ok: false, error: 'The canvas is empty.' };
      const slot = (state.players.findIndex((p) => p.id === playerId) - state.roundIndex + state.players.length * 4) % state.players.length;
      const source = state.players[slot];
      state.books[source.id].push({ kind: 'draw', by: playerId, name: U.byId(state, playerId)?.name, strokes });
      state.submittedRound.push(playerId);
      state.drawingCache = null;
      const events = [U.event(`${U.byId(state, playerId)?.name} finished drawing.`, 'info')];
      if (state.players.every((p) => state.submittedRound.includes(p.id))) advanceChain(state, events);
      return { ok: true, events };
    }

    if (state.phase === 'guess') {
      if (action.type !== 'guess') return { ok: false, error: 'Type your guess.' };
      const text = String(action.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
      if (!text) return { ok: false, error: 'Type your guess.' };
      const slot = (state.players.findIndex((p) => p.id === playerId) - state.roundIndex + state.players.length * 4) % state.players.length;
      const source = state.players[slot];
      state.books[source.id].push({ kind: 'guess', by: playerId, name: U.byId(state, playerId)?.name, text });
      state.submittedRound.push(playerId);
      const events = [U.event(`${U.byId(state, playerId)?.name} guessed something.`, 'info')];
      if (state.players.every((p) => state.submittedRound.includes(p.id))) advanceChain(state, events);
      return { ok: true, events };
    }

    return { ok: false, error: 'Nothing to do right now.' };
  },

  bot(state, playerId) {
    // In the reveal everyone just has to acknowledge it; bots do it instantly.
    // (Returning null once ready stops the harness/realtime loop re-acting.)
    if (state.phase === 'reveal') return (state.readyForNext || []).includes(playerId) ? null : { type: 'ready' };
    if (state.submittedRound.includes(playerId)) return null;
    if (state.preset.corpse) {
      const myIndex = state.players.findIndex((p) => p.id === playerId);
      const slot = CORPSE_SLOTS[state.roundIndex % CORPSE_SLOTS.length];
      const guide = CORPSE_GUIDE[slot];
      const strokes = botBodyPart(guide, slot, myIndex + state.roundIndex);
      return { type: 'draw', strokes };
    }
    if (state.phase === 'prompt') {
      const text = state.promptPool.pop() || U.pick(PROMPTS);
      return { type: 'prompt', text };
    }
    if (state.phase === 'draw') {
      const slot = (state.players.findIndex((p) => p.id === playerId) - state.roundIndex + state.players.length * 4) % state.players.length;
      const chain = state.books[state.players[slot].id];
      const prev = chain[chain.length - 1];
      return { type: 'draw', strokes: sketchFromText(prev?.text || prev?.kind || 'thing', state.roundIndex + (prev?.text?.length || 3)) };
    }
    if (state.phase === 'guess') {
      const slot = (state.players.findIndex((p) => p.id === playerId) - state.roundIndex + state.players.length * 4) % state.players.length;
      const chain = state.books[state.players[slot].id];
      const prev = chain[chain.length - 1];
      return { type: 'guess', text: guessForDrawing(prev?.strokes) };
    }
    return null;
  },

  over(state) {
    if (state.phase !== 'reveal') return { over: false };
    const botIds = state.players.filter((p) => p.bot).map((p) => p.id);
    const ready = state.readyForNext || [];
    if (state.players.every((p) => ready.includes(p.id) || botIds.includes(p.id))) {
      const ranked = U.ranking(state);
      return {
        over: true,
        winners: ranked.filter((r) => r.score === ranked[0]?.score).map((r) => r.id),
        scores: state.scores,
        summary: state.summary || 'Chain complete - best chain wins!',
      };
    }
    return { over: false };
  },

  render({ el, view, playerId, send, host }) {
    const ui = host?.uiState || (host ? (host.uiState = {}) : {});
    const phaseLabel = view.phase === 'prompt' ? 'Write a prompt' : view.phase === 'draw' ? 'Draw it' : view.phase === 'guess' ? 'Guess it' : 'The reveal';
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(String(view.presetId || '').replace(/-/g, ' ')),
      UI.pill(`${Math.min(view.roundsDone + 1, view.roundsTotal)}/${view.roundsTotal}`),
      UI.pill(phaseLabel),
      view.blind ? UI.pill('blind', 'warn') : null,
    ));
    if (view.turn.length && !view.turn.includes(playerId) && view.phase !== 'reveal') el.appendChild(UI.spinnerRow('Waiting for the others...'));

    if (view.phase === 'reveal') {
      if (view.corpseMode) {
        el.appendChild(UI.h('div', { class: 'corpse-grid' }, (view.creatures || []).map((creature, i) =>
          UI.h('div', { class: 'creature' },
            UI.canvasBox(260, 340, (ctx, w, h) => {
              ctx.fillStyle = '#fffdf7';
              ctx.fillRect(0, 0, w, h);
              for (const slot of CORPSE_SLOTS) {
                const strokes = creature.parts[slot];
                if (strokes) UI.drawStrokes(ctx, strokes, w, h);
              }
            }).el,
            UI.h('div', { class: 'creature-meta' }, ...CORPSE_SLOTS.map((slot) => UI.pill(`${slot}: ${creature.authors[slot] || '—'}`))),
            UI.muted(`Creature ${i + 1}`),
          ))));
      } else {
        el.appendChild(UI.h('div', { class: 'chains' }, Object.entries(view.books || {}).map(([ownerId, chain], ci) =>
          UI.h('div', { class: 'chain' },
            UI.h('div', { class: 'chain-title', text: `Chain ${ci + 1} — started by ${chain[0]?.name || '???'}` }),
            chain.map((entry) => entry.kind === 'prompt'
              ? UI.h('div', { class: 'chain-item' }, UI.pill('prompt'), UI.h('span', { class: 'entry-text', text: entry.text }), UI.h('span', { class: 'story-by', text: entry.name }))
              : entry.kind === 'guess'
                ? UI.h('div', { class: 'chain-item' }, UI.pill('guess'), UI.h('span', { class: 'entry-text', text: entry.text }), entry.matched ? UI.pill(`${entry.matched} match`, 'good') : null, UI.h('span', { class: 'story-by', text: entry.name }))
                : UI.h('div', { class: 'chain-item draw' }, UI.pill('drawing'), UI.canvasBox(300, 200, (ctx, w, h) => {
                  ctx.fillStyle = '#fffdf7';
                  ctx.fillRect(0, 0, w, h);
                  UI.drawStrokes(ctx, entry.strokes, w, h);
                }).el, UI.h('span', { class: 'story-by', text: entry.name })),
            )))));
        el.appendChild(UI.scoreboard(view));
      }
      el.appendChild(UI.btn('Ready to finish', () => send({ type: 'ready' }), { variant: 'primary' }));
      el.appendChild(UI.muted(view.summary || ''));
      return;
    }

    if (view.corpseMode) {
      const guide = view.guide || { x: 0.3, y: 0.1, w: 0.4, h: 0.3 };
      el.appendChild(UI.promptCard(guide.hint, 'Only your part - the rest is a surprise.'));
      el.appendChild(UI.h('div', { class: 'corpse-stage' },
        UI.h('div', {
          class: 'guide-box',
          style: { left: `${guide.x * 100}%`, top: `${guide.y * 100}%`, width: `${guide.w * 100}%`, height: `${guide.h * 100}%` },
        }),
        UI.drawingPad({
          strokes: padStrokes(ui, view, playerId, 'corpse'),
          height: 380,
          color: ui.color || '#111827',
          width: ui.width || 6,
        }).el,
      ));
      el.appendChild(UI.paletteRow((c) => { ui.color = c; host?.refresh?.(); }, ui.color || '#111827'));
      el.appendChild(UI.row(
        UI.btn('Undo', () => { ui.strokes.pop(); host?.refresh?.(); }, { size: 'sm' }),
        UI.btn('Clear', () => { ui.strokes.length = 0; host?.refresh?.(); }, { size: 'sm' }),
        UI.btn('Submit part', () => {
          send({ type: 'draw', strokes: ui.strokes });
          ui.strokes = [];
        }, { variant: 'primary' }),
      ));
      return;
    }

    if (view.phase === 'prompt') {
      el.appendChild(UI.promptCard('Write something ridiculous to draw', 'It gets passed along the chain - nobody sees where it started.'));
      if (view.submitted) el.appendChild(UI.spinnerRow('Prompt sent - waiting for the others...'));
      else el.appendChild(UI.textareaRow('e.g. a dragon afraid of heights', (text) => send({ type: 'prompt', text }), { submitLabel: 'Send prompt' }));
      renderSubmittedChips(el, view);
      return;
    }

    if (view.phase === 'draw') {
      if (view.prev?.kind === 'prompt') el.appendChild(UI.promptCard(view.prev.text, `From ${view.prev.name}`));
      else if (view.prev?.kind === 'draw') el.appendChild(UI.promptCard('Copy what you see (blind draw!)', `From ${view.prev.name} - only a sliver is visible.`));
      else if (view.prev?.kind === 'guess') el.appendChild(UI.promptCard(view.prev.text, `Draw this guess from ${view.prev.name}`));
      else el.appendChild(UI.promptCard('Draw something!', null));
      if (view.prev?.kind === 'draw') {
        el.appendChild(UI.canvasBox(320, 220, (ctx, w, h) => {
          ctx.fillStyle = '#fffdf7';
          ctx.fillRect(0, 0, w, h);
          UI.drawStrokes(ctx, view.prev.strokes, w, h);
        }).el);
      }
      if (view.submitted) {
        el.appendChild(UI.spinnerRow('Drawing sent - waiting for the others...'));
      } else {
        el.appendChild(UI.drawingPad({ strokes: padStrokes(ui, view, playerId, 'draw'), height: 340, color: ui.color || '#111827', width: ui.width || 6 }).el);
        el.appendChild(UI.paletteRow((c) => { ui.color = c; host?.refresh?.(); }, ui.color || '#111827'));
        el.appendChild(UI.widthPicker((w) => { ui.width = w; host?.refresh?.(); }, ui.width || 6));
        el.appendChild(UI.row(
          UI.btn('Undo', () => { ui.strokes.pop(); host?.refresh?.(); }, { size: 'sm' }),
          UI.btn('Clear', () => { ui.strokes.length = 0; host?.refresh?.(); }, { size: 'sm' }),
          UI.btn('Submit drawing', () => {
            send({ type: 'draw', strokes: ui.strokes });
            ui.strokes = [];
          }, { variant: 'primary' }),
        ));
      }
      renderSubmittedChips(el, view);
      return;
    }

    if (view.phase === 'guess') {
      el.appendChild(UI.promptCard('What is this?', `Drawn by ${view.prev?.name || 'someone'}`));
      if (view.prev?.strokes) {
        el.appendChild(UI.canvasBox(360, 240, (ctx, w, h) => {
          ctx.fillStyle = '#fffdf7';
          ctx.fillRect(0, 0, w, h);
          UI.drawStrokes(ctx, view.prev.strokes, w, h);
        }).el);
      }
      if (view.submitted) el.appendChild(UI.spinnerRow('Guess sent - waiting for the others...'));
      else el.appendChild(UI.inputRow('What does it show?', (text) => send({ type: 'guess', text }), { submitLabel: 'Guess' }));
      renderSubmittedChips(el, view);
      return;
    }
  },
};

function renderSubmittedChips(el, view) {
  const done = new Set(view.submittedIds || []);
  el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) =>
    UI.h('span', { class: `chip ${done.has(p.id) ? 'done' : ''}` }, `${p.avatar || ''} ${p.name}${done.has(p.id) ? ' ✓' : ''}`))));
}

/* ------------------------------------------------------------------ *
 * round flow
 * ------------------------------------------------------------------ */

function advanceChain(state, events) {
  state.submittedRound = [];
  state.roundIndex++;
  if (state.roundIndex >= state.chainRounds.length) {
    startReveal(state, events);
    return;
  }
  state.phase = state.chainRounds[state.roundIndex];
  state.turnDeadline = state.timer ? Date.now() + state.timer : 0;
  events.push(U.event(`Round ${state.roundIndex + 1}: ${state.phase === 'draw' ? 'draw it!' : 'guess it!'}`, 'info'));
}

function advanceCorpse(state, events) {
  state.submittedRound = [];
  state.roundIndex++;
  if (state.roundIndex >= CORPSE_SLOTS.length) {
    startReveal(state, events);
    return;
  }
  const slot = CORPSE_SLOTS[state.roundIndex];
  state.taskLabel = CORPSE_GUIDE[slot].hint;
  state.turnDeadline = state.timer ? Date.now() + state.timer : 0;
  events.push(U.event(`Next part: ${CORPSE_GUIDE[slot].hint.toLowerCase()}.`, 'info'));
}

function startReveal(state, events) {
  state.phase = 'reveal';
  state.turnDeadline = 0;
  state.readyForNext = [];
  const scored = state.preset.corpse ? scoreCorpse(state) : scoreChains(state);
  events.push(U.event(scored, 'win'));
  U.addLog(state, scored, 'win');
}

/** Seats that still owe this round an answer. */
function waitingSeats(state) {
  return state.players.filter((p) => !state.submittedRound.includes(p.id)).map((p) => p.id);
}

/** Points for finishing rounds, plus a bonus when a guess survives the chain. */
function scoreChains(state) {
  let lines = 0;
  for (const [ownerId, book] of Object.entries(state.books)) {
    for (const entry of book) {
      if (entry.by) U.addScore(state, entry.by, 1);
      lines++;
    }
    const original = book.find((e) => e.kind === 'prompt')?.text || '';
    const finalGuess = [...book].reverse().find((e) => e.kind === 'guess');
    if (original && finalGuess) {
      const words = keywords(original);
      const hit = keywords(finalGuess.text).filter((w) => words.includes(w)).length;
      if (hit) {
        U.addScore(state, finalGuess.by, hit * 3);
        finalGuess.matched = hit;
      }
    }
    void ownerId;
  }
  const ranked = U.ranking(state);
  state.summary = `${U.byId(state, ranked[0]?.id)?.name || 'Nobody'} leads with ${ranked[0]?.score ?? 0} points after ${lines} entries.`;
  return 'Reveal time! Scroll the chains - then mark ready.';
}

function scoreCorpse(state) {
  let parts = 0;
  for (const creature of state.corpse.creatures) {
    for (const [slot, strokes] of Object.entries(creature.parts)) {
      const author = Object.entries(state.corpse.parts).find(([, p]) => p.strokes === strokes)?.[1]?.by;
      if (author) U.addScore(state, author, Math.max(1, Math.round(strokeCount(strokes) / 40)));
      void slot;
      parts++;
    }
  }
  const ranked = U.ranking(state);
  state.summary = `${parts} body parts assembled across ${state.corpse.creatures.length} creatures. ${U.byId(state, ranked[0]?.id)?.name || 'Nobody'} leads with ${ranked[0]?.score ?? 0}.`;
  return state.summary;
}

function keywords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

/* ------------------------------------------------------------------ *
 * bot artwork
 * ------------------------------------------------------------------ */

/** Deterministic doodle standing in for a real drawing. */
function sketchFromText(text, seed) {
  const rng = U.makeRng(U.hashSeed ? U.hashSeed(String(text)) : `${text}`.length + seed);
  const strokes = [];
  const colors = ['#111827', '#ef4444', '#3b82f6', '#22c55e', '#a855f7', '#f97316'];
  const cx = 0.5;
  const cy = 0.5;
  const size = 0.2 + ((seed % 5) * 0.02);
  // body blob
  const pts = [];
  for (let i = 0; i <= 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    const r = size * (0.75 + rng() * 0.5);
    pts.push([U.clamp(cx + Math.cos(a) * r, 0.02, 0.98), U.clamp(cy + Math.sin(a) * r * 0.85, 0.02, 0.98)]);
  }
  strokes.push({ color: colors[seed % colors.length], width: 6, pts });
  strokes.push({ color: '#111827', width: 5, pts: [[cx - 0.08, cy - 0.06], [cx - 0.04, cy - 0.06]] });
  strokes.push({ color: '#111827', width: 5, pts: [[cx + 0.05, cy - 0.06], [cx + 0.09, cy - 0.06]] });
  strokes.push({ color: '#111827', width: 4, pts: [[cx - 0.07, cy + 0.09], [cx - 0.02, cy + 0.13], [cx + 0.03, cy + 0.1], [cx + 0.08, cy + 0.14]] });
  const arms = 2 + (seed % 3);
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + 0.4;
    strokes.push({
      color: colors[(seed + i) % colors.length],
      width: 5,
      pts: [
        [cx + Math.cos(a) * 0.14, cy + Math.sin(a) * 0.14],
        [cx + Math.cos(a) * 0.28, cy + Math.sin(a) * 0.26 + (rng() - 0.5) * 0.1],
      ],
    });
  }
  return strokes;
}

function botBodyPart(guide, slot, seed) {
  const rng = U.makeRng(`${slot}${seed}`);
  const strokes = [];
  const cx = guide.x + guide.w / 2;
  const cy = guide.y + guide.h / 2;
  if (slot === 'head') {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * guide.w * 0.34, cy + Math.sin(a) * guide.h * 0.4]);
    }
    strokes.push({ color: '#f59e0b', width: 7, pts });
    strokes.push({ color: '#111827', width: 4, pts: [[cx - 0.05, cy - 0.02], [cx - 0.015, cy - 0.02]] });
    strokes.push({ color: '#111827', width: 4, pts: [[cx + 0.02, cy - 0.02], [cx + 0.055, cy - 0.02]] });
    strokes.push({ color: '#111827', width: 3, pts: [[cx - 0.05, cy + 0.06], [cx, cy + 0.09], [cx + 0.05, cy + 0.06]] });
  } else if (slot.includes('arm')) {
    const dir = slot.startsWith('right') ? 1 : -1;
    strokes.push({ color: '#22c55e', width: 8, pts: [[cx - dir * guide.w * 0.3, cy], [cx + dir * guide.w * 0.28, cy + (rng() - 0.5) * 0.06]] });
    strokes.push({ color: '#22c55e', width: 8, pts: [[cx - dir * guide.w * 0.3, cy], [cx - dir * guide.w * 0.22, cy + guide.h * 0.3]] });
  } else {
    const dir = slot.startsWith('right') ? 1 : -1;
    strokes.push({ color: '#3b82f6', width: 9, pts: [[cx - dir * guide.w * 0.12, cy - guide.h * 0.4], [cx - dir * guide.w * 0.02, cy + guide.h * 0.2]] });
    strokes.push({ color: '#3b82f6', width: 9, pts: [[cx + dir * guide.w * 0.14, cy - guide.h * 0.4], [cx + dir * guide.w * 0.05, cy + guide.h * 0.22]] });
  }
  return strokes;
}

function guessForDrawing(strokes) {
  const count = strokeCount(strokes || []) || 1;
  const guesses = ['a very confused cat', 'a dragon doing chores', 'a robot at a party', 'a shark on a bike', 'an astronaut eating soup', 'a dinosaur in a hat', 'a snail racing', 'a haunted toaster'];
  return guesses[count % guesses.length];
}

/* ========================================================================= *
 * Charades (Draw)
 * ========================================================================= */

const CHARADE_WORDS = [
  ['fireworks', 'objects'], ['penguin', 'animals'], ['lighthouse', 'places'], ['spaghetti', 'food'],
  ['volcano', 'places'], ['sunglasses', 'objects'], ['octopus', 'animals'], ['birthday cake', 'food'],
  ['skateboard', 'objects'], ['rainbow', 'nature'], ['vampire', 'people'], ['traffic jam', 'places'],
  ['robot vacuum', 'objects'], ['hot air balloon', 'places'], ['cactus', 'nature'], ['detective', 'people'],
  ['pancake stack', 'food'], ['thunderstorm', 'nature'], ['mermaid', 'people'], ['submarine', 'objects'],
  ['snowman', 'nature'], ['karaoke', 'people'], ['popcorn', 'food'], ['windmill', 'places'],
];

function normaliseGuess(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export const charadesDraw = {
  meta: {
    id: 'charades-draw',
    name: 'Charades (Draw)',
    icon: '✏️',
    category: 'drawing',
    players: { min: 2, max: 10 },
    modes: MODES,
    secret: true,
    blurb: 'One player draws a secret word, everyone else races to guess it.',
    tags: ['drawing', 'party'],
    minutes: 15,
    status: 'playable',
    bots: true,
    maxBots: 5,
    turnMs: 90000,
    rules: [
      'The artist sees a secret word and draws it - strokes stream live.',
      'Everyone else types guesses in the box until someone nails it.',
      'Faster guesses score more, and the artist scores too. The artist rotates each round.',
    ],
    options: [
      { id: 'rounds', label: 'Rounds', type: 'select', values: [3, 5, 8], default: 5 },
      { id: 'difficulty', label: 'Word difficulty', type: 'select', values: ['easy', 'mixed', 'hard'], default: 'mixed' },
    ],
  },

  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.round = 1;
    state.maxRounds = options.rounds || 5;
    state.sabotage = false;
    state.artistIndex = 0;
    state.usedWords = [];
    state.drawings = [];
    state.roomMessages = [];
    startCharadeRound(state, rng);
    return state;
  },

  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    const isArtist = state.artistId === viewerId;
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.seed = state.seed;
    v.artistId = state.artistId;
    v.artistName = U.byId(state, state.artistId)?.name || '???';
    v.strokes = state.strokes;
    v.word = isArtist || state.phase === 'reveal' ? state.word : null;
    v.wordLength = state.word ? state.word.length : 0;
    v.category = state.phase === 'reveal' || isArtist ? state.category : null;
    v.hint = state.phase === 'reveal' ? null : maskWord(state.word);
    v.guesses = state.guesses;
    v.drawings = state.drawings;
    v.revealed = state.phase === 'reveal';
    v.startedAt = state.startedAt;
    v.turn = [];
    // Artist first (so the turn timer can rescue a stalled round), then every
    // guesser - everyone who can still act must show up in `turn`.
    if (state.phase === 'draw') v.turn = [state.artistId, ...state.players.filter((p) => p.id !== state.artistId).map((p) => p.id)];
    if (state.phase === 'reveal') v.turn = state.players.filter((p) => !(state.readyForNext || []).includes(p.id)).map((p) => p.id);
    v.myTurn = v.turn.includes(viewerId);
    return v;
  },

  act(state, playerId, action) {
    if (state.phase === 'reveal') {
      if (action.type === 'next') {
        state.readyForNext = [...new Set([...(state.readyForNext || []), playerId])];
        const bots = state.players.filter((p) => p.bot).map((p) => p.id);
        if (state.players.every((p) => state.readyForNext.includes(p.id) || bots.includes(p.id))) {
          if (state.round >= state.maxRounds) {
            const ranked = U.ranking(state);
            state.summary = `${U.byId(state, ranked[0]?.id)?.name} wins with ${ranked[0]?.score} points!`;
            state.winnerId = ranked.filter((r) => r.score === ranked[0]?.score).map((r) => r.id);
            return { ok: true, events: [U.event(state.summary, 'win')] };
          }
          state.round++;
          startCharadeRound(state, Math.random);
          return { ok: true, events: [U.event(`Round ${state.round} - ${U.byId(state, state.artistId)?.name} draws!`, 'info')] };
        }
        return { ok: true, events: [] };
      }
      return { ok: false, error: 'The round is over.' };
    }

    if (action.type === 'guess') {
      if (playerId === state.artistId) return { ok: false, error: 'You are the artist!' };
      const text = String(action.text || '').slice(0, 80);
      if (!text.trim()) return { ok: false, error: 'Type a guess.' };
      const correct = normaliseGuess(text) === normaliseGuess(state.word);
      state.guesses.push({ by: playerId, name: U.byId(state, playerId)?.name, text, correct, at: Date.now() });
      if (!correct) return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name}: ${text}`, 'miss')] };
      const seconds = Math.max(1, (Date.now() - state.startedAt) / 1000);
      const points = Math.max(1, Math.round(10 - seconds / 12));
      U.addScore(state, playerId, points);
      U.addScore(state, state.artistId, 3);
      const result = endCharadeRound(state, playerId, `${U.byId(state, playerId)?.name} guessed it in ${Math.round(seconds)}s (+${points})!`);
      return result;
    }

    if (playerId !== state.artistId) return { ok: false, error: 'Only the artist can do that.' };
    if (action.type === 'stroke') {
      state.strokes = cleanStrokes(action.strokes, 400, 1200);
      return { ok: true, events: [] };
    }
    if (action.type === 'clear') {
      state.strokes = [];
      return { ok: true, events: [] };
    }
    if (action.type === 'finish') {
      state.artistDone = true;
      return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} finished drawing.`, 'info')] };
    }
    if (action.type === 'give-up') {
      return endCharadeRound(state, null, 'Nobody guessed in time.');
    }
    return { ok: false, error: 'Unknown action.' };
  },

  /** Server turn timer: finish the drawing, then give up on a silent room. */
  timeout(state, playerId) {
    if (playerId !== state.artistId) return null;
    return state.artistDone ? { type: 'give-up' } : { type: 'finish' };
  },

  bot(state, playerId) {
    if (state.phase === 'reveal') {
      if (!(state.readyForNext || []).includes(playerId)) return { type: 'next' };
      return null;
    }
    if (playerId === state.artistId) {
      if (state.artistDone) return null;
      const full = sketchFromText(state.word, state.round + state.word.length);
      state.botStrokeIndex = state.botStrokeIndex || 0;
      const step = Math.min(full.length, state.botStrokeIndex + 1);
      state.botStrokeIndex = step;
      if (step >= full.length) return { type: 'finish' };
      return { type: 'stroke', strokes: full.slice(0, step) };
    }
    const attempts = state.guesses.filter((g) => g.by === playerId).length;
    if (attempts >= 3) return { type: 'guess', text: state.word };
    const wrong = ['a very tall sandwich', 'a confused washing machine', 'my last exam result', 'that one dream again'];
    return { type: 'guess', text: wrong[attempts % wrong.length] };
  },

  over(state) {
    const botIds = state.players.filter((p) => p.bot).map((p) => p.id);
    const ready = state.readyForNext || [];
    if (state.phase === 'reveal' && state.round >= state.maxRounds && state.players.every((p) => ready.includes(p.id) || botIds.includes(p.id))) {
      const ranked = U.ranking(state);
      return {
        over: true,
        winners: state.winnerId || ranked.filter((r) => r.score === ranked[0]?.score).map((r) => r.id),
        scores: state.scores,
        summary: state.summary || 'Charades complete!',
      };
    }
    return { over: false };
  },

  render({ el, view, playerId, send, host }) {
    const ui = host?.uiState || (host ? (host.uiState = {}) : {});
    const isArtist = view.artistId === playerId;
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Round ${view.round}/${view.maxRounds}`),
      UI.pill(isArtist ? 'You are drawing' : `${view.artistName} is drawing`),
      view.category ? UI.pill(`category: ${view.category}`) : null,
      view.hint ? UI.pill(`word: ${view.hint}`) : null,
    ));
    if (view.revealed) {
      el.appendChild(UI.promptCard(`The word was: ${view.word}`, `drawn by ${view.artistName}`));
      el.appendChild(UI.canvasBox(420, 280, (ctx, w, h) => {
        ctx.fillStyle = '#fffdf7';
        ctx.fillRect(0, 0, w, h);
        UI.drawStrokes(ctx, view.strokes, w, h);
      }).el);
      el.appendChild(UI.scoreboard(view));
      el.appendChild(UI.btn(view.round >= view.maxRounds ? 'Finish' : 'Next round', () => send({ type: 'next' }), { variant: 'primary' }));
      if (view.drawings?.length) {
        el.appendChild(UI.h('div', { class: 'gallery' }, view.drawings.map((d) =>
          UI.h('div', { class: 'gallery-item' }, UI.canvasBox(220, 150, (ctx, w, h) => {
            ctx.fillStyle = '#fffdf7';
            ctx.fillRect(0, 0, w, h);
            UI.drawStrokes(ctx, d.strokes, w, h);
          }).el, UI.muted(`${d.word} - ${d.guesserName} in ${d.seconds}s`)))));
      }
      return;
    }
    if (isArtist) {
      el.appendChild(UI.promptCard(`Draw: ${view.word}`, 'Strokes stream to the room as you draw.'));
      el.appendChild(UI.drawingPad({
        strokes: padStrokes(ui, view, playerId, 'artist'),
        height: 340,
        color: ui.color || '#111827',
        width: ui.width || 6,
        onCommit: (strokes) => send({ type: 'stroke', strokes }),
      }).el);
      el.appendChild(UI.paletteRow((c) => { ui.color = c; host?.refresh?.(); }, ui.color || '#111827'));
      el.appendChild(UI.row(
        UI.btn('Clear', () => { ui.strokes = []; send({ type: 'clear' }); }, { size: 'sm' }),
        UI.btn("I'm done", () => send({ type: 'finish' }), { variant: 'primary', disabled: view.turn.length === 0 }),
      ));
    } else {
      el.appendChild(UI.canvasBox(460, 320, (ctx, w, h) => {
        ctx.fillStyle = '#fffdf7';
        ctx.fillRect(0, 0, w, h);
        UI.drawStrokes(ctx, view.strokes, w, h);
      }).el);
      el.appendChild(UI.inputRow('Type your guess...', (text) => send({ type: 'guess', text }), { submitLabel: 'Guess' }));
    }
    el.appendChild(UI.h('div', { class: 'chat-list compact' }, (view.guesses || []).slice(-8).reverse().map((g) =>
      UI.h('div', { class: `chat-line ${g.correct ? 'good' : ''}` }, UI.h('b', { class: 'chat-name', text: g.name }), UI.h('span', { class: 'chat-text', text: g.text })))));
    el.appendChild(UI.scoreboard(view));
  },
};

function maskWord(word) {
  if (!word) return '';
  return word.split('').map((ch, i) => (ch === ' ' ? ' ' : i === 0 ? ch : '\u2022')).join('');
}

/** Close the current charade round (correct guess or timeout). */
function endCharadeRound(state, guesserId, reason) {
  state.phase = 'reveal';
  state.readyForNext = [];
  state.drawings.push({
    round: state.round,
    word: state.word,
    strokes: state.strokes,
    artist: state.artistId,
    artistName: U.byId(state, state.artistId)?.name,
    guesser: guesserId,
    guesserName: guesserId ? U.byId(state, guesserId)?.name : 'nobody',
    seconds: Math.round((Date.now() - state.startedAt) / 1000),
  });
  return { ok: true, events: [U.event(`${reason} It was "${state.word}".`, 'miss')] };
}

function startCharadeRound(state, rng) {
  const pool = CHARADE_WORDS.filter(([w]) => !state.usedWords.includes(w));
  const [word, category] = U.pick(pool.length ? pool : CHARADE_WORDS, rng);
  state.usedWords.push(word);
  state.word = word;
  state.category = category;
  state.artistId = state.players[state.artistIndex % state.players.length].id;
  state.artistIndex++;
  state.artistDone = false;
  state.botStrokeIndex = 0;
  state.strokes = [];
  state.guesses = [];
  state.readyForNext = [];
  state.phase = 'draw';
  state.startedAt = Date.now();
  state.turnId = state.artistId;
  U.addLog(state, `Round ${state.round}: ${U.byId(state, state.artistId)?.name} must draw a ${category} thing.`);
}
/* ========================================================================= *
 * Bad Drawing Challenge
 * ========================================================================= */

const SABOTAGE_COLORS = ['#e11d48', '#7c3aed', '#0891b2', '#65a30d', '#d97706', '#db2777', '#4b5563', '#b91c1c'];

const BAD_PROMPTS = [
  'A cat running a bakery', 'A dragon afraid of heights', 'A robot walking a dog',
  'A shark in a bathtub', 'A haunted fridge', 'A wizard shopping for groceries',
  'A bear riding a train', 'A detective duck', 'A volcano with a hat',
  'A pizza delivery to the moon', 'A penguin surfing', 'A snail winning a race',
  'A ghost eating toast', 'A giraffe hiding behind a lamppost', 'A frog in a tiny car',
];

function botScribble(seed, strokes = 3) {
  const rng = U.makeRng(seed);
  const out = [];
  for (let s = 0; s < strokes; s++) {
    const cx = 0.2 + rng() * 0.6;
    const cy = 0.2 + rng() * 0.6;
    const points = [];
    for (let i = 0; i < 12; i++) {
      points.push([
        U.clamp(cx + (rng() - 0.5) * 0.5, 0.02, 0.98),
        U.clamp(cy + (rng() - 0.5) * 0.5, 0.02, 0.98),
      ]);
    }
    out.push({ color: SABOTAGE_COLORS[Math.floor(rng() * SABOTAGE_COLORS.length)], width: 4 + Math.floor(rng() * 8), pts: points });
  }
  return out;
}

export const badDrawing = {
  meta: {
    id: 'bad-drawing',
    name: 'Bad Drawing Challenge',
    icon: '😵',
    category: 'drawing',
    players: { min: 3, max: 12 },
    modes: MODES,
    simultaneous: true,
    secret: true,
    blurb: 'Draw with a wobbly brush, wrong colours and no undo. Worst drawing wins votes.',
    tags: ['drawing', 'comedy'],
    minutes: 12,
    status: 'playable',
    bots: true,
    maxBots: 6,
    turnMs: 90000,
    rules: [
      'Everyone gets the same ridiculous prompt.',
      'The brush wobbles and picks its own colour - no undo, no clear, no mercy.',
      'All drawings are judged anonymously. Most votes wins the round.',
    ],
    options: [
      { id: 'rounds', label: 'Rounds', type: 'select', values: [1, 2, 3], default: 2 },
      { id: 'votePoints', label: 'Points per vote', type: 'select', values: [1, 3, 5], default: 3 },
    ],
  },

  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.maxRounds = options.rounds || 2;
    state.votePoints = options.votePoints || 3;
    state.round = 1;
    state.prompt = U.pick(BAD_PROMPTS, rng);
    state.pool = U.shuffle(BAD_PROMPTS.filter((p) => p !== state.prompt), rng);
    state.strokes = {};
    state.done = [];
    state.entries = [];
    state.votes = {};
    state.readies = [];
    state.phase = 'draw';
    U.addLog(state, `Round 1: ${state.prompt} - good luck with that brush.`);
    return state;
  },

  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.seed = state.seed;
    v.votePoints = state.votePoints;
    v.prompt = state.prompt;
    v.myStrokes = state.strokes[viewerId] || [];
    v.doneIds = state.done;
    v.done = state.done.includes(viewerId);
    v.entries = state.phase === 'vote'
      ? state.entries.map((e) => ({ id: e.id, strokes: e.strokes }))
      : state.entries;
    v.myVote = state.votes[viewerId] ?? null;
    v.tally = state.phase === 'reveal' ? badTally(state) : null;
    v.readies = state.readies;
    v.turn = [];
    if (state.phase === 'draw') v.turn = state.players.filter((p) => !state.done.includes(p.id)).map((p) => p.id);
    else if (state.phase === 'vote') v.turn = state.players.filter((p) => state.votes[p.id] === undefined).map((p) => p.id);
    else if (state.phase === 'reveal') v.turn = state.players.filter((p) => !state.readies.includes(p.id)).map((p) => p.id);
    if (state.winnerId) v.turn = [];
    return v;
  },

  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    const events = [];
    if (action.type === 'draw') {
      if (state.phase !== 'draw') return { ok: false, error: 'Drawing is closed.' };
      if (state.done.includes(playerId)) return { ok: false, error: 'You are finished.' };
      const strokes = cleanStrokes(action.strokes, 200, 700);
      if (!strokes.length) return { ok: false, error: 'Draw something first.' };
      state.strokes[playerId] = strokes;
      events.push(U.event(`${U.byId(state, playerId)?.name} is doodling...`, 'info'));
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'done') {
      if (state.phase !== 'draw') return { ok: false, error: 'Drawing is closed.' };
      if (state.done.includes(playerId)) return { ok: false, error: 'You are already done.' };
      if (!(state.strokes[playerId] || []).length) return { ok: false, error: 'Draw something first.' };
      state.done.push(playerId);
      events.push(U.event(`${U.byId(state, playerId)?.name} is done.`, 'info'));
      if (state.players.every((p) => state.done.includes(p.id))) toBadVote(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'vote') {
      if (state.phase !== 'vote') return { ok: false, error: 'Voting is closed.' };
      if (state.votes[playerId] !== undefined) return { ok: false, error: 'You already voted.' };
      const entry = state.entries.find((e) => e.id === action.target);
      if (!entry) return { ok: false, error: 'Pick a drawing.' };
      if (entry.author === playerId) return { ok: false, error: 'No voting for yourself.' };
      state.votes[playerId] = action.target;
      if (state.players.every((p) => state.votes[p.id] !== undefined)) revealBad(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      if (!state.readies.includes(playerId)) state.readies.push(playerId);
      if (state.players.every((p) => state.readies.includes(p.id))) {
        if (state.round >= state.maxRounds) {
          const ranked = U.ranking(state);
          state.winnerId = ranked.filter((r) => r.score === ranked[0].score).map((r) => r.id);
          state.summary = `${ranked[0].name} wins the worst-drawing contest (+${ranked[0].score})!`;
          events.push(U.event(state.summary, 'win'));
        } else {
          state.round++;
          state.prompt = state.pool[(state.round - 1) % state.pool.length];
          state.strokes = {};
          state.done = [];
          state.entries = [];
          state.votes = {};
          state.readies = [];
          state.phase = 'draw';
          events.push(U.event(`Round ${state.round}: ${state.prompt}`, 'info'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },

  timeout(state, playerId) {
    if (state.phase === 'draw' && !state.done.includes(playerId)) {
      return (state.strokes[playerId] || []).length ? { type: 'done' } : null;
    }
    if (state.phase === 'vote' && state.votes[playerId] === undefined) {
      const options = state.entries.filter((e) => e.author !== playerId);
      return options.length ? { type: 'vote', target: U.pick(options).id } : null;
    }
    if (state.phase === 'reveal' && !state.readies.includes(playerId)) return { type: 'next' };
    return null;
  },

  bot(state, playerId) {
    if (state.phase === 'draw' && !state.done.includes(playerId)) {
      if (!(state.strokes[playerId] || []).length) {
        return { type: 'draw', strokes: botScribble(`${state.seed}:${playerId}:${state.round}`, 2 + (U.byId(state, playerId)?.level ?? 2)) };
      }
      return { type: 'done' };
    }
    if (state.phase === 'vote' && state.votes[playerId] === undefined) {
      const options = state.entries.filter((e) => e.author !== playerId);
      if (!options.length) return null;
      const level = U.byId(state, playerId)?.level ?? 2;
      if (level >= 3) {
        // "worst wins": vote for the drawing with the most strokes (maximum chaos)
        const sorted = options.slice().sort((a, b) => (b.strokes?.length || 0) - (a.strokes?.length || 0));
        return { type: 'vote', target: (Math.random() < 0.6 ? sorted[0] : U.pick(options)).id };
      }
      return { type: 'vote', target: U.pick(options).id };
    }
    if (state.phase === 'reveal' && !state.readies.includes(playerId)) return { type: 'next' };
    return null;
  },

  over(state) {
    return U.simpleOver(state, { draw: !!state.draw });
  },

  render({ el, view, playerId, send, host }) {
    const ui = host?.uiState || (host ? (host.uiState = {}) : {});
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Round ${view.round}/${view.maxRounds}`),
      UI.pill(view.phase === 'draw' ? 'Draw it badly' : view.phase === 'vote' ? 'Vote' : 'Results'),
      UI.pill(`${view.doneIds.length}/${view.players.length} done`)));
    if (view.phase === 'draw') {
      el.appendChild(UI.promptCard(view.prompt, 'Cursed brush: it wobbles, it picks its own colour, and there is no undo.'));
      if (view.done) {
        el.appendChild(UI.spinnerRow('Drawing locked in - waiting for the others...'));
      } else {
        const pad = UI.drawingPad({
          strokes: padStrokes(ui, view, playerId, 'bad'),
          height: 360,
          color: ui.color || SABOTAGE_COLORS[0],
          width: ui.width || 6,
          wobble: 0.018,
          onCommit: (strokes) => {
            // Every stroke changes the brush colour behind your back.
            ui.color = SABOTAGE_COLORS[Math.floor(Math.random() * SABOTAGE_COLORS.length)];
            ui.width = 3 + Math.floor(Math.random() * 10);
            ui.strokes = strokes;
            host?.refresh?.();
          },
        });
        el.appendChild(pad.el);
        el.appendChild(UI.muted('The brush already chose your next colour. Good luck.'));
        el.appendChild(UI.row(
          UI.btn('Send drawing', () => {
            send({ type: 'draw', strokes: ui.strokes });
            send({ type: 'done' });
            ui.strokes = [];
          }, { variant: 'primary' }),
        ));
      }
      el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.doneIds.includes(p.id) ? 'done' : ''}` }, `${p.avatar || ''} ${p.name}${view.doneIds.includes(p.id) ? ' ✓' : ' ✏️'}`))));
      return;
    }
    const revealing = view.phase === 'reveal';
    el.appendChild(UI.promptCard(revealing ? `Results: ${view.prompt}` : `Vote for the best disaster: ${view.prompt}`, null));
    el.appendChild(UI.h('div', { class: 'entries' }, view.entries.map((entry) => {
      const votes = revealing ? view.tally?.[entry.id] || 0 : 0;
      return UI.h('div', { class: `entry ${revealing ? 'revealed' : ''} ${view.myVote === entry.id ? 'voted' : ''}` },
        UI.canvasBox(320, 220, (ctx, w, h) => {
          ctx.fillStyle = '#fffdf7';
          ctx.fillRect(0, 0, w, h);
          UI.drawStrokes(ctx, entry.strokes, w, h);
        }).el,
        revealing ? UI.h('div', { class: 'entry-meta' }, UI.pill(entry.name), UI.pill(`${votes} vote${votes === 1 ? '' : 's'}`, votes ? 'good' : '')) : null,
        !revealing ? UI.btn(view.myVote === entry.id ? 'Voted' : 'Vote', () => send({ type: 'vote', target: entry.id }), { size: 'sm', disabled: view.myVote !== null || entry.author === playerId }) : null);
    })));
    if (revealing) {
      el.appendChild(UI.scoreboard(view));
      el.appendChild(UI.btn(view.round >= view.maxRounds ? 'Finish' : 'Next round', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
    }
  },
};

function badTally(state) {
  const out = {};
  for (const target of Object.values(state.votes || {})) out[target] = (out[target] || 0) + 1;
  return out;
}

function toBadVote(state, events) {
  state.phase = 'vote';
  state.entries = state.players
    .map((p, i) => ({ id: `b${i}`, author: p.id, name: p.name, strokes: state.strokes[p.id] || [] }))
    .filter((e) => e.strokes.length)
    .sort(() => Math.random() - 0.5);
  state.votes = {};
  events.push(U.event('All drawings in - vote for the best disaster!', 'info'));
}

function revealBad(state, events) {
  for (const [entryId, count] of Object.entries(badTally(state))) {
    const entry = state.entries.find((e) => e.id === entryId);
    if (entry) U.addScore(state, entry.author, count * state.votePoints);
  }
  state.phase = 'reveal';
  state.readies = [];
  events.push(U.event('Votes are in!', 'win'));
}
