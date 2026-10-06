/**
 * Meme Maker Battle - everyone gets the same procedurally generated template,
 * writes a caption, then the room votes.  (Deliberately self-contained: no
 * image assets, so it works offline and in every client version.)
 */
import * as U from './util.js';
import * as UI from './ui.js';

const TEMPLATE_CAPTIONS = [
  ['WHEN THE CODE WORKS', 'ON THE FIRST TRY'],
  ['NOBODY:', 'ME AT 3AM:'],
  ['ME EXPLAINING MY PLAN', 'ME WATCHING IT FAIL'],
  ['EXPECTATION', 'REALITY'],
];

const BOT_MEMES = [
  ['ME: I WILL SLEEP EARLY', 'ALSO ME: 4AM MEMES'],
  ['WHEN THE WIFI DROPS', 'DURING THE FINAL BOSS'],
  ['MY PLAN', 'MY PLAN AFTER COFFEE'],
  ['GAME: ONE MORE LEVEL', 'SUN: RISE AND SHINE'],
  ['ME: I AM FINE', 'ALSO ME: CRYING OVER A CAT VIDEO'],
];

export const memeMaker = {
  meta: {
    id: 'meme-maker',
    name: 'Meme Maker Battle',
    icon: '🖼️',
    category: 'drawing',
    players: { min: 2, max: 12 },
    modes: ['solo', 'local', 'online'],
    simultaneous: true,
    blurb: 'Same template, 90 seconds, then vote for the funniest caption.',
    tags: ['memes', 'party'],
    minutes: 10,
    status: 'playable',
    bots: true,
    maxBots: 6,
    rules: [
      'Everyone gets the same template and writes top/bottom text.',
      'All entries are revealed anonymously - vote for your favourite.',
      'Most votes wins the round; most points wins the match.',
    ],
    options: [
      { id: 'rounds', label: 'Rounds', type: 'select', values: [2, 3, 5], default: 3 },
      { id: 'votePoints', label: 'Points per vote', type: 'select', values: [1, 3, 5], default: 3 },
    ],
  },

  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.maxRounds = options.rounds || 3;
    state.votePoints = options.votePoints || 3;
    state.round = 1;
    state.template = { seed: Math.floor(rng() * 1e9), palette: U.pick(['neon', 'arcade', 'sunset', 'candy'], rng) };
    state.submissions = {};
    state.votes = {};
    state.entries = [];
    state.readies = [];
    state.phase = 'submit';
    U.addLog(state, 'Caption the template!');
    return state;
  },

  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.votePoints = state.votePoints;
    v.template = state.template;
    v.mySubmission = state.submissions[viewerId] || null;
    v.submittedIds = Object.keys(state.submissions);
    v.entries = state.phase === 'vote' ? state.entries.map((e) => ({ id: e.id, top: e.top, bottom: e.bottom })) : state.entries;
    v.myVote = state.votes[viewerId] ?? null;
    v.tally = state.phase === 'reveal' ? tally(state) : null;
    v.readies = state.readies;
    v.turn = [];
    if (state.phase === 'submit') v.turn = state.players.filter((p) => !state.submissions[p.id]).map((p) => p.id);
    else if (state.phase === 'vote') v.turn = state.players.filter((p) => state.votes[p.id] === undefined).map((p) => p.id);
    else if (state.phase === 'reveal') v.turn = state.players.filter((p) => !state.readies.includes(p.id)).map((p) => p.id);
    v.myTurn = v.turn.includes(viewerId);
    return v;
  },

  act(state, playerId, action) {
    if (action.type === 'submit') {
      if (state.phase !== 'submit') return { ok: false, error: 'Captions are closed.' };
      if (state.submissions[playerId]) return { ok: false, error: 'You already submitted.' };
      const top = clean(action.top, 60);
      const bottom = clean(action.bottom, 60);
      if (!top && !bottom) return { ok: false, error: 'Write at least one line.' };
      state.submissions[playerId] = { top, bottom };
      if (state.players.every((p) => state.submissions[p.id])) toVote(state);
      return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} submitted a meme.`, 'info')] };
    }
    if (action.type === 'vote') {
      if (state.phase !== 'vote') return { ok: false, error: 'Voting is closed.' };
      if (state.votes[playerId] !== undefined) return { ok: false, error: 'You already voted.' };
      const entry = state.entries.find((e) => e.id === action.target);
      if (!entry) return { ok: false, error: 'Pick an entry.' };
      if (entry.author === playerId) return { ok: false, error: 'No voting for yourself.' };
      state.votes[playerId] = action.target;
      if (state.players.every((p) => state.votes[p.id] !== undefined)) reveal(state);
      return { ok: true, events: [] };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      if (!state.readies.includes(playerId)) state.readies.push(playerId);
      if (state.players.every((p) => state.readies.includes(p.id))) {
        if (state.round >= state.maxRounds) {
          const ranked = U.ranking(state);
          state.winnerId = ranked.filter((r) => r.score === ranked[0]?.score).map((r) => r.id);
          state.summary = `${U.byId(state, state.winnerId[0])?.name} wins with ${ranked[0]?.score} points!`;
          return { ok: true, events: [U.event(state.summary, 'win')] };
        }
        state.round++;
        state.phase = 'submit';
        state.submissions = {};
        state.votes = {};
        state.entries = [];
        state.readies = [];
        state.template = { seed: Math.floor(Math.random() * 1e9), palette: U.pick(['neon', 'arcade', 'sunset', 'candy']) };
        return { ok: true, events: [U.event(`Round ${state.round} - new template!`, 'info')] };
      }
      return { ok: true, events: [] };
    }
    return { ok: false, error: 'Unknown action.' };
  },

  bot(state, playerId) {
    if (state.phase === 'submit' && !state.submissions[playerId]) {
      const [top, bottom] = BOT_MEMES[(state.round + state.players.indexOf(U.byId(state, playerId))) % BOT_MEMES.length];
      return { type: 'submit', top, bottom };
    }
    if (state.phase === 'vote' && state.votes[playerId] === undefined) {
      const options = state.entries.filter((e) => e.author !== playerId);
      if (!options.length) return null;
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
      UI.pill(view.phase === 'submit' ? 'Caption it' : view.phase === 'vote' ? 'Vote' : 'Results')));
    const template = (top, bottom) => UI.canvasBox(420, 260, (ctx, w, h) => {
      UI.paintScene(ctx, w, h, view.template.seed, { palette: view.template.palette, density: 14 });
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 4;
      ctx.font = 'bold 26px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      const line = (text, y) => {
        if (!text) return;
        ctx.strokeText(text.slice(0, 34), w / 2, y);
        ctx.fillText(text.slice(0, 34), w / 2, y);
      };
      line(top, 40);
      line(bottom, h - 20);
    }).el;

    if (view.phase === 'submit') {
      el.appendChild(template(view.mySubmission?.top || '', view.mySubmission?.bottom || ''));
      if (view.mySubmission) {
        el.appendChild(UI.spinnerRow('Meme submitted - waiting for the others...'));
      } else {
        const top = UI.h('input', { class: 'input', placeholder: 'TOP TEXT', maxLength: 60, value: ui.top || '' });
        const bottom = UI.h('input', { class: 'input', placeholder: 'bottom text', maxLength: 60, value: ui.bottom || '' });
        top.addEventListener('input', () => { ui.top = top.value; });
        bottom.addEventListener('input', () => { ui.bottom = bottom.value; });
        el.appendChild(UI.h('div', { class: 'meme-form' }, top, bottom,
          UI.btn('Submit meme', () => send({ type: 'submit', top: ui.top || '', bottom: ui.bottom || '' }), { variant: 'primary' })));
      }
      return;
    }

    if (view.phase === 'vote' || view.phase === 'reveal') {
      const revealing = view.phase === 'reveal';
      el.appendChild(UI.promptCard(revealing ? 'Results' : 'Vote for the funniest!', null));
      el.appendChild(UI.h('div', { class: 'entries' }, view.entries.map((entry) => {
        const votes = revealing ? view.tally?.[entry.id] || 0 : 0;
        return UI.h('div', { class: `entry meme ${revealing ? 'revealed' : ''}` },
          template(entry.top, entry.bottom),
          revealing ? UI.h('div', { class: 'entry-meta' }, UI.pill(entry.name), UI.pill(`${votes} vote(s)`, votes ? 'good' : '')) : null,
          !revealing ? UI.btn('Vote', () => send({ type: 'vote', target: entry.id }), { size: 'sm', disabled: view.myVote !== null }) : null);
      })));
      if (revealing) {
        el.appendChild(UI.scoreboard(view));
        el.appendChild(UI.btn(view.round >= view.maxRounds ? 'Finish' : 'Next round', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
      }
      return;
    }
  },
};

function tally(state) {
  const out = {};
  for (const target of Object.values(state.votes)) out[target] = (out[target] || 0) + 1;
  return out;
}

function toVote(state) {
  state.phase = 'vote';
  state.entries = state.players
    .map((p, i) => ({ id: `m${i}`, author: p.id, name: p.name, top: state.submissions[p.id]?.top || '', bottom: state.submissions[p.id]?.bottom || '' }))
    .filter((e) => e.top || e.bottom)
    .sort(() => Math.random() - 0.5);
  state.votes = {};
}

function reveal(state) {
  const counts = tally(state);
  for (const [id, count] of Object.entries(counts)) {
    const entry = state.entries.find((e) => e.id === id);
    if (entry) U.addScore(state, entry.author, count * state.votePoints);
  }
  state.phase = 'reveal';
  state.readies = [];
  U.addLog(state, 'Votes are in!', 'win');
}

function clean(text, max) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export default memeMaker;
