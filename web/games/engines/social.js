/**
 * Social deduction family: Mafia, Gecko (imposter) and Codenames.
 *
 * These are the only engines where whole parts of the state are private:
 * roles, the secret word and the Codenames key never reach `view()` for the
 * seats that should not see them.  Every phase lists exactly the seats that
 * still have something to send, so the server's bot loop always makes progress.
 */
import * as U from './util.js';
import * as UI from './ui.js';

const MODES = ['local', 'online'];

/* ========================================================================= *
 * Mafia
 * ========================================================================= */

const MAFIA_ROLE_INFO = {
  mafia: { name: 'Mafia', team: 'mafia', icon: '🔪', blurb: 'Each night, vote with the family on who to take out.' },
  doctor: { name: 'Doctor', team: 'village', icon: '💉', blurb: 'Each night, choose someone to protect.' },
  detective: { name: 'Detective', team: 'village', icon: '🔍', blurb: 'Each night, investigate one player and learn their team.' },
  villager: { name: 'Villager', team: 'village', icon: '🧑‍🌾', blurb: 'No night action - talk, accuse and vote during the day.' },
};

function assignRoles(players, rng) {
  const n = players.length;
  const mafiaCount = Math.max(1, Math.floor(n / 4));
  const deck = [];
  for (let i = 0; i < mafiaCount; i++) deck.push('mafia');
  if (n >= 6) {
    deck.push('doctor', 'detective');
  } else if (n >= 5) {
    deck.push('doctor');
  }
  while (deck.length < n) deck.push('villager');
  const shuffled = U.shuffle(deck, rng).slice(0, n);
  const roles = {};
  players.forEach((p, i) => {
    roles[p.id] = shuffled[i];
  });
  return roles;
}

export const mafia = {
  meta: {
    id: 'mafia',
    name: 'Mafia',
    category: 'social',
    players: { min: 5, max: 14 },
    modes: MODES,
    secret: true,
    blurb: 'Night kills, day accusations, doctor saves and a detective with a hunch. Full role deck.',
    tags: ['deduction', 'party', 'flagship'],
    minutes: 25,
    status: 'playable',
    bots: true,
    maxBots: 8,
    rules: [
      'Mafia pick a victim each night; the doctor may save someone and the detective learns a team.',
      'At dawn the town hears what happened, then everyone votes to lynch a suspect.',
      'The village wins when every mafia member is gone; the mafia win when they equal or outnumber the rest.',
    ],
    options: [{ id: 'days', label: 'Day limit', type: 'select', values: [0, 8, 12], default: 0 }],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.roles = assignRoles(players, rng);
    state.alive = {};
    state.dead = [];
    for (const p of state.players) state.alive[p.id] = true;
    state.round = 1;
    state.dayLimit = options.days || 0;
    state.phase = 'night';
    state.nightReady = [];
    state.night = { kills: {}, saves: {}, checks: {}, ready: [] };
    state.checks = {};
    state.votes = {};
    state.lynchHistory = [];
    state.lastNight = null;
    state.lastLynch = null;
    U.addLog(state, `Night ${state.round} falls. Everyone, close your eyes.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.round = state.round;
    v.phase = state.phase;
    v.alive = state.alive;
    v.dead = state.dead;
    v.deadCount = state.dead.length;
    v.myRole = state.roles[viewerId] || null;
    v.roleInfo = MAFIA_ROLE_INFO[state.roles[viewerId]] || null;
    v.lastNight = state.lastNight || null;
    v.lastLynch = state.lastLynch || null;
    v.votes = state.phase === 'vote' ? state.votes : {};
    v.voteCount = Object.keys(state.votes || {}).length;
    v.myVote = state.votes?.[viewerId] ?? null;
    v.myChecks = state.checks[viewerId] || [];
    v.nightDone = state.night?.ready || [];
    v.ended = !!state.winnerId;
    // Roles are revealed for the dead (and everyone once the game is over).
    const reveal = !state.alive[viewerId] || !!state.winnerId;
    v.roster = state.players.map((p) => ({
      ...p,
      alive: !!state.alive[p.id],
      role: reveal ? state.roles[p.id] : null,
      roleName: reveal ? MAFIA_ROLE_INFO[state.roles[p.id]]?.name || '' : '',
    }));
    v.turn = [];
    if (state.winnerId) v.turn = [];
    else if (state.phase === 'night') v.turn = state.players.filter((p) => state.alive[p.id] && !(state.night.ready || []).includes(p.id)).map((p) => p.id);
    else if (state.phase === 'vote') v.turn = state.players.filter((p) => state.alive[p.id] && state.votes[p.id] === undefined).map((p) => p.id);
    else if (state.phase === 'reveal') v.turn = state.players.filter((p) => state.alive[p.id] && !(state.ready || []).includes(p.id)).map((p) => p.id);
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    if (!state.alive[playerId]) return { ok: false, error: 'The dead do not act.' };
    const events = [];
    if (state.phase === 'night') {
      if ((state.night.ready || []).includes(playerId)) return { ok: false, error: 'You are done for the night.' };
      const role = state.roles[playerId];
      const target = action.target ? String(action.target) : null;
      if (action.type === 'ready') {
        // Villagers (and anyone with nothing to do) simply wait.
      } else if (action.type === 'kill') {
        if (role !== 'mafia') return { ok: false, error: 'Only the mafia choose a victim.' };
        if (!target || !state.alive[target] || state.roles[target] === 'mafia') return { ok: false, error: 'Pick a living outsider.' };
        state.night.kills[playerId] = target;
      } else if (action.type === 'save') {
        if (role !== 'doctor') return { ok: false, error: 'Only the doctor protects.' };
        if (!target || !state.alive[target]) return { ok: false, error: 'Pick someone who is still breathing.' };
        state.night.saves[playerId] = target;
      } else if (action.type === 'check') {
        if (role !== 'detective') return { ok: false, error: 'Only the detective investigates.' };
        if (!target || !state.alive[target]) return { ok: false, error: 'Pick a living player.' };
        state.night.checks[playerId] = target;
      } else {
        return { ok: false, error: 'Unknown night action.' };
      }
      state.night.ready.push(playerId);
      if (state.players.filter((p) => state.alive[p.id]).every((p) => state.night.ready.includes(p.id))) {
        resolveNight(state, events);
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (state.phase === 'vote') {
      if (state.votes[playerId] !== undefined) return { ok: false, error: 'You already voted.' };
      const target = String(action.target || '');
      if (action.type !== 'vote') return { ok: false, error: 'Vote for someone.' };
      if (!state.alive[target]) return { ok: false, error: 'They are already gone.' };
      if (target === playerId) return { ok: false, error: 'You cannot vote for yourself.' };
      state.votes[playerId] = target;
      events.push(U.event(`${U.byId(state, playerId)?.name} voted.`, 'info'));
      if (state.players.filter((p) => state.alive[p.id]).every((p) => state.votes[p.id] !== undefined)) {
        resolveVote(state, events);
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (state.phase === 'reveal') {
      if (!state.ready.includes(playerId)) state.ready.push(playerId);
      if (state.players.filter((p) => state.alive[p.id]).every((p) => state.ready.includes(p.id))) {
        startNight(state, events);
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    if (state.winnerId || !state.alive[playerId]) return null;
    const role = state.roles[playerId];
    const living = state.players.filter((p) => state.alive[p.id]);
    const level = U.byId(state, playerId)?.level ?? 2;
    if (state.phase === 'night' && !(state.night.ready || []).includes(playerId)) {
      if (role === 'mafia') {
        const prey = living.filter((p) => state.roles[p.id] !== 'mafia' && p.id !== state.night.kills[playerId]);
        if (!prey.length) return { type: 'ready' };
        // The detective is the biggest threat: higher-level mafia hunt them first.
        const detective = prey.find((p) => state.roles[p.id] === 'detective');
        const target = level >= 3 && detective ? detective : U.pick(prey);
        return { type: 'kill', target: target.id };
      }
      if (role === 'doctor') {
        if (!living.length) return { type: 'ready' };
        return { type: 'save', target: U.pick(living).id };
      }
      if (role === 'detective') {
        const suspects = living.filter((p) => p.id !== playerId && !(state.checks[playerId] || []).some((c) => c.target === p.id));
        if (!suspects.length) return { type: 'ready' };
        return { type: 'check', target: U.pick(suspects).id };
      }
      return { type: 'ready' };
    }
    if (state.phase === 'vote' && state.votes[playerId] === undefined) {
      const suspects = living.filter((p) => p.id !== playerId);
      if (!suspects.length) return null;
      if (role === 'mafia') {
        // Mafia try not to vote for each other.
        const outsiders = suspects.filter((p) => state.roles[p.id] !== 'mafia');
        if (outsiders.length) return { type: 'vote', target: U.pick(outsiders).id };
      }
      const suspicious = state.lastLynch?.accused?.find((id) => suspects.some((p) => p.id === id));
      if (level >= 3 && suspicious) return { type: 'vote', target: suspicious };
      return { type: 'vote', target: U.pick(suspects).id };
    }
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'ready' };
    return null;
  },
  onLeave(state, playerId) {
    state.alive[playerId] = false;
    if (!state.dead.includes(playerId)) state.dead.push(playerId);
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    const role = view.roleInfo;
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Night ${view.round}`),
      UI.pill(view.phase === 'night' ? '🌙 Night' : view.phase === 'vote' ? '🗳️ Vote' : '☀️ Day'),
      UI.pill(`${view.players.filter((p) => view.alive[p.id]).length} alive`)));
    if (role) {
      el.appendChild(UI.panel('Your role', UI.row(UI.pill(`${role.icon} ${role.name}`, role.team), UI.muted(role.blurb))));
    }
    if (view.lastNight) {
      el.appendChild(UI.h('div', { class: 'prompt-card' }, UI.h('div', { class: 'prompt-text', text: view.lastNight.text })));
    }
    if (view.lastLynch) el.appendChild(UI.h('div', { class: 'prompt-card' }, UI.h('div', { class: 'prompt-text', text: view.lastLynch.text })));

    const living = view.players.filter((p) => view.alive[p.id]);
    if (view.phase === 'night') {
      const me = stateMafiaSelf(view, playerId);
      el.appendChild(UI.h('div', { class: 'waiting-list' }, living.map((p) => {
        const done = view.nightDone?.includes(p.id);
        return UI.h('span', { class: `chip ${done ? 'done' : ''}` }, `${p.avatar || ''} ${p.name}${done ? ' 🌙' : ''}`);
      })));
      if (me === 'mafia') {
        el.appendChild(UI.muted('Pick tonight\'s victim together:'));
        el.appendChild(UI.h('div', { class: 'waiting-list' }, living.filter((p) => p.id !== playerId).map((p) => UI.h('button', {
          class: 'chip',
          onClick: () => send({ type: 'kill', target: p.id }),
          disabled: view.nightDone?.includes(playerId),
        }, p.name))));
      } else if (me === 'doctor') {
        el.appendChild(UI.h('div', { class: 'waiting-list' }, living.map((p) => UI.h('button', {
          class: 'chip',
          onClick: () => send({ type: 'save', target: p.id }),
          disabled: view.nightDone?.includes(playerId),
        }, p.name))));
      } else if (me === 'detective') {
        el.appendChild(UI.h('div', { class: 'waiting-list' }, living.filter((p) => p.id !== playerId).map((p) => UI.h('button', {
          class: 'chip',
          onClick: () => send({ type: 'check', target: p.id }),
          disabled: view.nightDone?.includes(playerId),
        }, p.name))));
      } else {
        el.appendChild(UI.btn(view.nightDone?.includes(playerId) ? 'Waiting...' : 'Go to sleep', () => send({ type: 'ready' }), { variant: 'primary', disabled: view.nightDone?.includes(playerId) }));
      }
    } else if (view.phase === 'vote') {
      el.appendChild(UI.muted('Vote to lynch a suspect.'));
      el.appendChild(UI.h('div', { class: 'waiting-list' }, living.filter((p) => p.id !== playerId).map((p) => UI.h('button', {
        class: `chip ${view.myVote === p.id ? 'done' : ''}`,
        onClick: () => send({ type: 'vote', target: p.id }),
        disabled: view.myVote !== null,
      }, p.name))));
      el.appendChild(UI.muted(`${view.voteCount} vote(s) in.`));
    } else if (view.phase === 'reveal') {
      if (view.myChecks?.length) {
        el.appendChild(UI.panel('Your investigations', UI.list(view.myChecks, (c) => UI.h('span', { text: `${c.name}: ${c.team === 'mafia' ? 'MAFIA' : 'not mafia'}` }))));
      }
      el.appendChild(UI.btn('Continue', () => send({ type: 'ready' }), { variant: 'primary' }));
    }
    el.appendChild(UI.scoreboard(view));
    el.appendChild(UI.list(view.players.filter((p) => !view.alive[p.id]), (p) => UI.h('span', { text: `${p.name}${p.roleName ? ` (${p.roleName})` : ''} 💀` })));
    if (view.ended) el.appendChild(UI.h('div', { class: 'prompt-card' }, UI.h('div', { class: 'prompt-text', text: view.summary || 'Game over' })));
  },
};

function stateMafiaSelf(view, playerId) {
  // The view keeps roles private but the client still needs to render the right controls.
  if (!view.roleInfo) return null;
  return view.roleInfo.team === 'mafia' ? 'mafia' : view.roleInfo.name.toLowerCase();
}

function resolveNight(state, events) {
  const kills = Object.values(state.night.kills || {});
  const saves = Object.values(state.night.saves || {});
  const checks = state.night.checks || {};
  let victim = null;
  if (kills.length) {
    const tally = {};
    for (const id of kills) tally[id] = (tally[id] || 0) + 1;
    victim = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
  }
  for (const [detId, target] of Object.entries(checks)) {
    state.checks[detId] = state.checks[detId] || [];
    state.checks[detId].push({ target, name: U.byId(state, target)?.name || target, team: state.roles[target] === 'mafia' ? 'mafia' : 'village' });
  }
  const saved = victim && saves.includes(victim);
  let text;
  if (victim && !saved) {
    state.alive[victim] = false;
    state.dead.push(victim);
    text = `${U.byId(state, victim)?.name} was found dead at dawn.`;
    events.push(U.event(text, 'warn'));
  } else if (victim && saved) {
    text = `Someone was attacked, but the doctor saved them.`;
    events.push(U.event(text, 'win'));
  } else {
    text = 'A quiet night - nobody was attacked.';
    events.push(U.event(text, 'info'));
  }
  state.lastNight = { text, victim: victim || null, saved: !!saved, round: state.round };
  state.night = { kills: {}, saves: {}, checks: {}, ready: [] };
  state.nightReady = [];
  state.votes = {};
  state.ready = [];
  if (checkWin(state, events)) return;
  state.phase = 'vote';
  events.push(U.event('Day breaks - vote for a suspect.', 'info'));
}

function resolveVote(state, events) {
  const tally = {};
  for (const target of Object.values(state.votes)) tally[target] = (tally[target] || 0) + 1;
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const tie = ranked.length > 1 && ranked[1][1] === top[1];
  let text;
  if (!top || tie) {
    text = 'The town could not agree - nobody was lynched.';
    events.push(U.event(text, 'warn'));
  } else {
    const target = top[0];
    state.alive[target] = false;
    state.dead.push(target);
    text = `${U.byId(state, target)?.name} was voted out (${top[1]} votes).`;
    events.push(U.event(text, 'warn'));
  }
  state.lastLynch = { text, accused: ranked.map(([id]) => id), round: state.round };
  state.lynchHistory.push({ round: state.round, accused: ranked.map(([id]) => id) });
  state.votes = {};
  state.ready = [];
  state.phase = 'reveal';
  checkWin(state, events);
  if (!state.winnerId) events.push(U.event('Press continue for the next night.', 'info'));
}

function startNight(state, events) {
  state.round++;
  state.phase = 'night';
  state.night = { kills: {}, saves: {}, checks: {}, ready: [] };
  state.votes = {};
  state.ready = [];
  state.lastNight = null;
  state.lastLynch = null;
  if (state.dayLimit && state.round > state.dayLimit) {
    const mafiaAlive = state.players.filter((p) => state.alive[p.id] && state.roles[p.id] === 'mafia');
    state.winnerId = mafiaAlive.length ? mafiaAlive.map((p) => p.id) : state.players.filter((p) => state.alive[p.id]).map((p) => p.id);
    state.summary = 'The town ran out of days - the mafia slip away with it.';
    events.push(U.event(state.summary, 'win'));
    for (const id of state.winnerId) U.addScore(state, id, 1);
    return;
  }
  events.push(U.event(`Night ${state.round} falls.`, 'info'));
}

function checkWin(state, events) {
  const living = state.players.filter((p) => state.alive[p.id]);
  const mafiaAlive = living.filter((p) => state.roles[p.id] === 'mafia');
  const others = living.filter((p) => state.roles[p.id] !== 'mafia');
  if (!mafiaAlive.length) {
    state.winnerId = others.map((p) => p.id);
    state.summary = 'The village roots out every mafia member and wins!';
    events.push(U.event(state.summary, 'win'));
    for (const id of state.winnerId) U.addScore(state, id, 1);
    return true;
  }
  if (mafiaAlive.length >= others.length) {
    state.winnerId = mafiaAlive.map((p) => p.id);
    state.summary = 'The mafia equal the town - they win!';
    events.push(U.event(state.summary, 'win'));
    for (const id of state.winnerId) U.addScore(state, id, 1);
    return true;
  }
  return false;
}

/* ========================================================================= *
 * Gecko (imposter)
 * ========================================================================= */

const GECKO_WORDS = [
  { word: 'Pizza', cat: 'a food', clues: ['cheese', 'slice', 'oven', 'pepperoni', 'dough'] },
  { word: 'Astronaut', cat: 'a job', clues: ['space', 'helmet', 'rocket', 'gravity', 'moon'] },
  { word: 'Trampoline', cat: 'a thing in a garden', clues: ['bounce', 'jump', 'spring', 'net', 'kids'] },
  { word: 'Volcano', cat: 'a place', clues: ['lava', 'erupt', 'mountain', 'ash', 'hot'] },
  { word: 'Chess', cat: 'a game', clues: ['board', 'king', 'pawn', 'checkmate', 'knight'] },
  { word: 'Piano', cat: 'an instrument', clues: ['keys', 'music', 'black', 'notes', 'strings'] },
  { word: 'Library', cat: 'a place', clues: ['books', 'quiet', 'shelf', 'read', 'card'] },
  { word: 'Sushi', cat: 'a food', clues: ['rice', 'raw', 'roll', 'seaweed', 'wasabi'] },
  { word: 'Snowman', cat: 'a thing you build', clues: ['carrot', 'cold', 'melt', 'scarf', 'round'] },
  { word: 'Vampire', cat: 'a monster', clues: ['fangs', 'night', 'blood', 'cape', 'bat'] },
  { word: 'Guitar', cat: 'an instrument', clues: ['strings', 'pick', 'band', 'chord', 'rock'] },
  { word: 'Hospital', cat: 'a place', clues: ['doctor', 'nurse', 'bed', 'sick', 'ambulance'] },
];

const VAGUE_CLUES = ['thing', 'stuff', 'yes', 'maybe', 'idk', 'stuff', 'normal', 'fine', 'obvious', 'same', 'whatever', 'sure'];
const MAX_GECKO_ROUNDS = 3;

export const gecko = {
  meta: {
    id: 'gecko',
    name: 'Gecko (Imposter)',
    category: 'social',
    players: { min: 4, max: 12 },
    modes: MODES,
    secret: true,
    simultaneous: true,
    blurb: 'Everyone shares a secret word except the Gecko, who must bluff their way through.',
    tags: ['deduction', 'party'],
    minutes: 15,
    status: 'playable',
    bots: true,
    maxBots: 8,
    rules: [
      'Everyone gets the same secret word - except one player, the Gecko, who only gets the category.',
      'Each round everyone gives a one-word clue about the word.',
      'Then vote: catch the Gecko and the crew wins. Survive three rounds and the Gecko wins.',
      'The Gecko can also steal the win by typing the exact word.',
    ],
    options: [{ id: 'rounds', label: 'Rounds', type: 'select', values: [2, 3, 4], default: 3 }],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    const entry = U.pick(GECKO_WORDS, rng);
    state.word = entry.word;
    state.cat = entry.cat;
    state.clueBank = entry.clues;
    state.geckoId = U.pick(players, rng).id;
    state.maxRounds = options.rounds || MAX_GECKO_ROUNDS;
    state.round = 1;
    state.clueRound = 1;
    state.clues = {};
    state.votes = {};
    state.ready = [];
    state.lastRound = null;
    state.phase = 'clue';
    U.addLog(state, `Round 1 - category: ${state.cat}. Give a one-word clue.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    const isGecko = viewerId === state.geckoId;
    v.round = state.clueRound;
    v.maxRounds = state.maxRounds;
    v.cat = state.cat;
    v.word = isGecko ? null : state.word;
    v.iAmGecko = isGecko;
    v.clues = state.clues;
    v.myClue = state.clues[viewerId] ?? null;
    v.clueCount = Object.keys(state.clues || {}).length;
    v.votes = state.phase === 'reveal' ? state.votes : {};
    v.myVote = state.votes?.[viewerId] ?? null;
    v.votedCount = Object.keys(state.votes || {}).length;
    v.readies = state.ready || [];
    v.lastRound = state.lastRound || null;
    v.revealedGecko = state.winnerId ? state.geckoId : null;
    v.turn = [];
    if (!state.winnerId) {
      if (state.phase === 'clue') v.turn = state.players.filter((p) => state.clues[p.id] === undefined).map((p) => p.id);
      else if (state.phase === 'vote') v.turn = state.players.filter((p) => state.votes[p.id] === undefined).map((p) => p.id);
      else if (state.phase === 'reveal') v.turn = state.players.filter((p) => !(state.ready || []).includes(p.id)).map((p) => p.id);
    }
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    const events = [];
    if (action.type === 'clue') {
      if (state.phase !== 'clue') return { ok: false, error: 'Clues are closed.' };
      if (state.clues[playerId] !== undefined) return { ok: false, error: 'You already gave a clue.' };
      const text = String(action.text || '').trim().split(/\s+/)[0]?.slice(0, 24) || '';
      if (!text) return { ok: false, error: 'One word, please.' };
      state.clues[playerId] = text;
      events.push(U.event(`${U.byId(state, playerId)?.name} says: "${text}"`, 'info'));
      if (state.players.every((p) => state.clues[p.id] !== undefined)) {
        state.phase = 'vote';
        state.votes = {};
        events.push(U.event('Vote for the Gecko!', 'info'));
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'guess') {
      // The Gecko can try to steal the word instead of voting.
      if (state.phase !== 'vote') return { ok: false, error: 'Nothing to guess right now.' };
      if (playerId !== state.geckoId) return { ok: false, error: 'Only the Gecko guesses the word.' };
      const attempt = String(action.text || '').trim().toLowerCase();
      if (!attempt) return { ok: false, error: 'Type your guess.' };
      if (attempt === state.word.toLowerCase()) {
        finishGecko(state, state.geckoId, events, 'The Gecko guessed the word - impossible!');
      } else {
        events.push(U.event('The Gecko guessed wrong...', 'warn'));
        state.geckoGuessedWrong = true;
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'vote') {
      if (state.phase !== 'vote') return { ok: false, error: 'Voting is closed.' };
      if (state.votes[playerId] !== undefined) return { ok: false, error: 'You already voted.' };
      const target = String(action.target || '');
      if (target === playerId) return { ok: false, error: 'You cannot vote for yourself.' };
      if (!state.players.some((p) => p.id === target)) return { ok: false, error: 'Pick a player.' };
      state.votes[playerId] = target;
      events.push(U.event(`${U.byId(state, playerId)?.name} voted.`, 'info'));
      if (state.players.every((p) => state.votes[p.id] !== undefined)) resolveGeckoVote(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      if (!state.ready.includes(playerId)) state.ready.push(playerId);
      if (state.players.every((p) => state.ready.includes(p.id))) {
        state.clueRound++;
        if (state.clueRound > state.maxRounds) {
          finishGecko(state, state.geckoId, events, 'Three rounds survived - the Gecko wins!');
        } else {
          state.clues = {};
          state.votes = {};
          state.ready = [];
          state.lastRound = null;
          state.phase = 'clue';
          events.push(U.event(`Round ${state.clueRound} - category: ${state.cat}.`, 'info'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    const isGecko = playerId === state.geckoId;
    const level = U.byId(state, playerId)?.level ?? 2;
    if (state.phase === 'clue' && state.clues[playerId] === undefined) {
      if (isGecko) return { type: 'clue', text: U.pick(VAGUE_CLUES) };
      const bank = state.clueBank.filter((c) => !Object.values(state.clues).includes(c));
      return { type: 'clue', text: U.pick(bank.length ? bank : state.clueBank) };
    }
    if (state.phase === 'vote' && state.votes[playerId] === undefined) {
      const others = state.players.filter((p) => p.id !== playerId);
      if (!others.length) return null;
      const scored = others.map((p) => {
        const clue = state.clues[p.id] || '';
        const overlap = state.clueBank.filter((c) => c === clue || c.includes(clue) || clue.includes(c)).length;
        return { id: p.id, score: overlap + Math.random() };
      });
      scored.sort((a, b) => a.score - b.score);
      if (level >= 3) return { type: 'vote', target: scored[0].id };
      return { type: 'vote', target: U.pick(others).id };
    }
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Round ${view.round}/${view.maxRounds}`),
      UI.pill(`Category: ${view.cat}`),
      view.phase === 'clue' ? UI.pill(`${view.clueCount}/${view.players.length} clues`) : UI.pill(`${view.votedCount}/${view.players.length} votes`)));
    if (view.iAmGecko) {
      el.appendChild(UI.panel('You are the GECKO 🦎', UI.muted('You do not know the word - bluff, and vote for someone else. You may guess the exact word during a vote to steal the win.')));
    } else {
      el.appendChild(UI.panel('Your secret word', UI.h('div', { class: 'prompt-card' }, UI.h('div', { class: 'prompt-text', text: view.word }))));
    }
    if (view.phase === 'clue') {
      if (view.myClue === null) {
        el.appendChild(UI.inputRow('One word clue...', (text) => send({ type: 'clue', text }), { submitLabel: 'Say it' }));
      } else {
        el.appendChild(UI.h('div', { class: 'waiting-list' },
          view.players.map((p) => UI.h('span', { class: `chip ${view.clues[p.id] ? 'done' : ''}` }, `${p.name}${view.clues[p.id] ? `: ${view.clues[p.id]}` : ' …'}`))));
      }
      return;
    }
    if (view.phase === 'vote') {
      el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.clues[p.id] ? 'done' : ''}` }, `${p.name}: ${view.clues[p.id] || '—'}`))));
      el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.filter((p) => p.id !== playerId).map((p) => UI.h('button', {
        class: `chip ${view.myVote === p.id ? 'done' : ''}`,
        onClick: () => send({ type: 'vote', target: p.id }),
        disabled: view.myVote !== null,
      }, `Vote ${p.name}`))));
      if (view.iAmGecko) el.appendChild(UI.inputRow('Guess the secret word...', (text) => send({ type: 'guess', text }), { submitLabel: 'Steal the win' }));
      return;
    }
    if (view.lastRound) {
      el.appendChild(UI.promptCard(view.lastRound.text, `The word was: ${view.lastRound.word}`));
    }
    if (view.revealedGecko) el.appendChild(UI.panel('Reveal', UI.muted(`The Gecko was ${view.players.find((p) => p.id === view.revealedGecko)?.name}`)));
    el.appendChild(UI.scoreboard(view));
    el.appendChild(UI.btn(view.round >= view.maxRounds ? 'Finish' : 'Next round', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
  },
};

function resolveGeckoVote(state, events) {
  const tally = {};
  for (const target of Object.values(state.votes)) tally[target] = (tally[target] || 0) + 1;
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const caught = ranked[0] && ranked[0][0] === state.geckoId && (ranked.length === 1 || ranked[1][1] < ranked[0][1]);
  const text = caught
    ? `The crew caught the Gecko - it was ${U.byId(state, state.geckoId)?.name}!`
    : ranked[0]
      ? `${U.byId(state, ranked[0][0])?.name} was voted out... but they were innocent!`
      : 'Nobody voted - the Gecko breathes a sigh of relief.';
  state.lastRound = { text, word: state.word, round: state.clueRound };
  state.phase = 'reveal';
  state.ready = [];
  events.push(U.event(text, caught ? 'win' : 'warn'));
  if (caught) {
    const crewWins = state.players.filter((p) => p.id !== state.geckoId).map((p) => p.id);
    finishGecko(state, crewWins, events, text, true);
  } else {
    events.push(U.event('One more round to catch them.', 'info'));
  }
}

function finishGecko(state, winnerIds, events, text, quiet = false) {
  state.winnerId = Array.isArray(winnerIds) ? winnerIds : [winnerIds];
  for (const id of state.winnerId) U.addScore(state, id, 2);
  state.summary = text;
  if (!quiet) events.push(U.event(text, 'win'));
  state.phase = 'reveal';
  state.ready = [];
  state.lastRound = { text, word: state.word, round: state.clueRound };
}

/* ========================================================================= *
 * Codenames
 * ========================================================================= */

const CODEWORDS = [
  { w: 'OCEAN', tags: ['water', 'blue', 'deep'] }, { w: 'ROCKET', tags: ['space', 'fast', 'fire'] },
  { w: 'PANDA', tags: ['animal', 'black', 'bamboo'] }, { w: 'PIANO', tags: ['music', 'keys', 'black'] },
  { w: 'DESERT', tags: ['sand', 'dry', 'hot'] }, { w: 'IGLOO', tags: ['ice', 'cold', 'home'] },
  { w: 'BANANA', tags: ['fruit', 'yellow', 'peel'] }, { w: 'GHOST', tags: ['spooky', 'white', 'night'] },
  { w: 'TIGER', tags: ['animal', 'orange', 'stripes'] }, { w: 'GUITAR', tags: ['music', 'strings', 'rock'] },
  { w: 'VOLCANO', tags: ['fire', 'mountain', 'hot'] }, { w: 'MIRROR', tags: ['glass', 'reflect', 'home'] },
  { w: 'CROWN', tags: ['royal', 'gold', 'head'] }, { w: 'PIZZA', tags: ['food', 'round', 'cheese'] },
  { w: 'NURSE', tags: ['job', 'help', 'white'] }, { w: 'CASTLE', tags: ['royal', 'stone', 'old'] },
  { w: 'COMET', tags: ['space', 'fast', 'ice'] }, { w: 'PANCAKE', tags: ['food', 'round', 'breakfast'] },
  { w: 'SUBMARINE', tags: ['water', 'deep', 'metal'] }, { w: 'PARROT', tags: ['animal', 'talk', 'fly'] },
  { w: 'LIGHTHOUSE', tags: ['light', 'sea', 'home'] }, { w: 'SPIDER', tags: ['animal', 'web', 'creepy'] },
  { w: 'DIAMOND', tags: ['gem', 'hard', 'shiny'] }, { w: 'SANDWICH', tags: ['food', 'hand', 'lunch'] },
  { w: 'TORNADO', tags: ['wind', 'spin', 'danger'] }, { w: 'CACTUS', tags: ['plant', 'spiky', 'dry'] },
  { w: 'ANCHOR', tags: ['sea', 'heavy', 'metal'] }, { w: 'CLOCK', tags: ['time', 'round', 'old'] },
  { w: 'BUBBLE', tags: ['round', 'light', 'water'] }, { w: 'TRAIN', tags: ['fast', 'travel', 'metal'] },
  { w: 'MUSHROOM', tags: ['plant', 'food', 'red'] }, { w: 'ROBOT', tags: ['metal', 'future', 'talk'] },
  { w: 'PENGUIN', tags: ['animal', 'cold', 'black'] }, { w: 'HONEY', tags: ['food', 'gold', 'sticky'] },
  { w: 'STORM', tags: ['wind', 'danger', 'water'] }, { w: 'PIANO', tags: ['music', 'keys', 'white'] },
  { w: 'LANTERN', tags: ['light', 'old', 'fire'] }, { w: 'DETECTIVE', tags: ['job', 'clue', 'hat'] },
  { w: 'BALLOON', tags: ['round', 'light', 'party'] }, { w: 'CAMPFIRE', tags: ['fire', 'hot', 'night'] },
  { w: 'MAP', tags: ['travel', 'old', 'paper'] }, { w: 'WAFFLE', tags: ['food', 'squares', 'breakfast'] },
  { w: 'SPACESHIP', tags: ['space', 'metal', 'fast'] }, { w: 'JELLYFISH', tags: ['water', 'creepy', 'light'] },
  { w: 'SNOWMAN', tags: ['cold', 'white', 'round'] }, { w: 'DRAGON', tags: ['fire', 'old', 'danger'] },
];

export const codenames = {
  meta: {
    id: 'codenames',
    name: 'Codenames',
    category: 'social',
    players: { min: 4, max: 12 },
    modes: MODES,
    secret: true,
    blurb: 'Two spymasters, 25 words, one assassin. Give one-word clues that dodge your opponents\' agents.',
    tags: ['deduction', 'team', 'flagship'],
    minutes: 20,
    status: 'playable',
    bots: true,
    maxBots: 8,
    rules: [
      'Each team has a spymaster who can see the key, and field agents who guess.',
      'The spymaster gives one word and a number: it points at that many friendly words.',
      'Guess a wrong word and the turn passes. Hit the assassin and you lose instantly.',
    ],
  },
  create({ players, seed, rng = Math.random }) {
    const state = U.baseState({ players, seed });
    const words = U.shuffle(CODEWORDS, rng).slice(0, 25).map((entry) => ({ ...entry }));
    const colors = [];
    colors.push(...Array(9).fill('a'), ...Array(8).fill('b'), ...Array(7).fill('n'), 'x');
    const shuffledColors = U.shuffle(colors, rng);
    state.grid = words.map((entry, i) => ({ word: entry.w, tags: entry.tags, color: shuffledColors[i], revealed: false }));
    // Seats alternate between the two teams; the first of each is the spymaster.
    state.teams = { a: [], b: [] };
    state.players.forEach((p, i) => {
      state.teams[i % 2 === 0 ? 'a' : 'b'].push(p.id);
    });
    state.spymasters = { a: state.teams.a[0] || null, b: state.teams.b[0] || null };
    state.team = 'a';
    state.phase = 'clue';
    state.clue = null;
    state.guessesLeft = 0;
    state.ready = [];
    state.log = state.log || [];
    U.addLog(state, 'Team A gives the first clue.');
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.team = state.team;
    v.teams = state.teams;
    v.myTeam = state.teams.a.includes(viewerId) ? 'a' : state.teams.b.includes(viewerId) ? 'b' : null;
    v.iAmSpymaster = state.spymasters.a === viewerId || state.spymasters.b === viewerId;
    // Who is giving the clue right now - the board names them while everyone
    // waits, and a spymaster only gets the clue box when this is them.  The
    // whole spymasters map stays out of the view (see the header).
    v.spymasterNow = state.spymasters[state.team] || null;
    v.key = v.iAmSpymaster || state.winnerId ? state.grid.map((cell) => cell.color) : null;
    v.grid = state.grid.map((cell) => ({ word: cell.word, revealed: cell.revealed, color: cell.revealed ? cell.color : null }));
    v.clue = state.clue;
    v.guessesLeft = state.guessesLeft;
    v.remaining = { a: state.grid.filter((c) => c.color === 'a' && !c.revealed).length, b: state.grid.filter((c) => c.color === 'b' && !c.revealed).length };
    v.readies = state.ready || [];
    v.ended = !!state.winnerId;
    v.turn = [];
    if (!state.winnerId) {
      if (state.phase === 'clue') v.turn = state.spymasters[state.team] ? [state.spymasters[state.team]] : [];
      else if (state.phase === 'guess') v.turn = state.teams[state.team].filter((id) => id !== state.spymasters[state.team]);
      else if (state.phase === 'reveal') v.turn = state.players.filter((p) => !(state.ready || []).includes(p.id)).map((p) => p.id);
    }
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    const events = [];
    const myTeam = state.teams.a.includes(playerId) ? 'a' : state.teams.b.includes(playerId) ? 'b' : null;
    if (action.type === 'clue') {
      if (state.phase !== 'clue') return { ok: false, error: 'Not the clue phase.' };
      if (playerId !== state.spymasters[state.team]) return { ok: false, error: 'Only the spymaster gives the clue.' };
      const word = String(action.word || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 18);
      const count = U.clamp(Number(action.count) || 1, 1, 4);
      if (!word) return { ok: false, error: 'Give a one-word clue.' };
      if (word.includes(' ')) return { ok: false, error: 'One word only.' };
      if (state.grid.some((cell) => cell.word === word)) return { ok: false, error: 'That word is on the board.' };
      state.clue = { word, count, team: state.team, by: playerId };
      state.guessesLeft = count + 1;
      state.phase = 'guess';
      events.push(U.event(`${U.byId(state, playerId)?.name} clues "${word}" for ${count}.`, 'info'));
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'guess') {
      if (state.phase !== 'guess') return { ok: false, error: 'No clue on the table.' };
      if (myTeam !== state.team) return { ok: false, error: 'It is not your turn.' };
      if (playerId === state.spymasters[state.team]) return { ok: false, error: 'The spymaster stays quiet.' };
      const cell = state.grid.find((c) => c.word === String(action.word || '').toUpperCase() && !c.revealed);
      if (!cell) return { ok: false, error: 'Pick an unrevealed word.' };
      cell.revealed = true;
      const teamName = state.team.toUpperCase();
      if (cell.color === 'x') {
        state.winnerId = state.teams[state.team === 'a' ? 'b' : 'a'].map((id) => id);
        state.summary = `${U.byId(state, playerId)?.name} found the assassin - ${state.team === 'a' ? 'B' : 'A'} wins!`;
        events.push(U.event(state.summary, 'win'));
        for (const id of state.winnerId) U.addScore(state, id, 1);
        state.phase = 'reveal';
        state.ready = [];
      } else if (cell.color === state.team) {
        const left = state.grid.filter((c) => c.color === state.team && !c.revealed).length;
        events.push(U.event(`"${cell.word}" is ${teamName}! (${left} left)`, 'win'));
        if (!left) {
          state.winnerId = state.teams[state.team].slice();
          state.summary = `${teamName} reveals every agent and wins!`;
          events.push(U.event(state.summary, 'win'));
          for (const id of state.winnerId) U.addScore(state, id, 1);
          state.phase = 'reveal';
          state.ready = [];
        } else {
          state.guessesLeft--;
          if (state.guessesLeft <= 0) endCodeTurn(state, events);
        }
      } else {
        events.push(U.event(`"${cell.word}" is not yours - turn passes.`, 'warn'));
        endCodeTurn(state, events);
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'pass') {
      if (state.phase !== 'guess') return { ok: false, error: 'Nothing to pass.' };
      if (myTeam !== state.team) return { ok: false, error: 'It is not your turn.' };
      events.push(U.event(`${U.byId(state, playerId)?.name} ends the turn.`, 'info'));
      endCodeTurn(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      if (!state.ready.includes(playerId)) state.ready.push(playerId);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    if (state.winnerId) return null;
    const myTeam = state.teams.a.includes(playerId) ? 'a' : state.teams.b.includes(playerId) ? 'b' : null;
    if (state.phase === 'clue' && playerId === state.spymasters[state.team]) {
      const team = state.team;
      const mine = state.grid.filter((c) => c.color === team && !c.revealed);
      if (!mine.length) return null;
      const foeColors = team === 'a' ? ['b', 'n', 'x'] : ['a', 'n', 'x'];
      const tagScore = (tag, words) => words.filter((c) => c.tags.includes(tag)).length;
      let best = null;
      for (const cell of mine) {
        for (const tag of cell.tags) {
          const hits = tagScore(tag, mine);
          const risk = tagScore(tag, state.grid.filter((c) => foeColors.includes(c.color) && !c.revealed));
          const score = hits * 3 - risk * 5 + (hits > 1 ? 2 : 0) + Math.random();
          if (!best || score > best.score) best = { tag, hits, score };
        }
      }
      if (!best) return null;
      return { type: 'clue', word: best.tag, count: Math.min(3, Math.max(1, best.hits)) };
    }
    if (state.phase === 'guess' && myTeam === state.team && playerId !== state.spymasters[state.team]) {
      const clue = state.clue?.word?.toLowerCase() || '';
      const candidates = state.grid.filter((c) => !c.revealed);
      if (!candidates.length) return null;
      const scored = candidates.map((c) => ({
        word: c.word,
        score: c.tags.filter((t) => t === clue).length * 10 + (c.tags.some((t) => t.includes(clue) || clue.includes(t)) ? 4 : 0) + Math.random(),
      }));
      scored.sort((a, b) => b.score - a.score);
      if (scored[0].score < 4) return { type: 'pass' };
      return { type: 'guess', word: scored[0].word };
    }
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    const team = view.myTeam;
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Turn: Team ${view.team.toUpperCase()}`),
      UI.pill(`🟦 ${view.remaining.a} left`),
      UI.pill(`🟥 ${view.remaining.b} left`),
      view.clue ? UI.pill(`Clue: ${view.clue.word} × ${view.clue.count}`) : null));
    if (view.ended) el.appendChild(UI.h('div', { class: 'prompt-card' }, UI.h('div', { class: 'prompt-text', text: view.summary || 'Game over' })));
    if (view.clue && view.clue.team !== view.team) el.appendChild(UI.h('div', { class: 'muted', text: `"${view.clue.word}" was for the other team - you are still guessing the clue from when you were up.` }));
    const myTeamColor = team || 'a';
    el.appendChild(UI.h('div', { class: 'board codenames', style: { '--cols': 5, '--rows': 5 } },
      view.grid.map((cell, i) => {
        const key = view.key?.[i] || null;
        const cls = ['cell', 'word'];
        if (cell.revealed) cls.push(`revealed ${cell.color}`);
        else if (key) cls.push(`keyed ${key}`);
        return UI.gridButton(cell.word, () => send({ type: 'guess', word: cell.word }), {
          className: cls.join(' '),
          // A spymaster never guesses - they only give clues (the server
          // refuses them too), so their board stays read-only.
          disabled: cell.revealed || view.phase !== 'guess' || team !== view.team || view.iAmSpymaster || !!view.winnerId,
        });
      })));
    if (view.iAmSpymaster && view.phase === 'clue' && view.myTeam === view.team) {
      const mine = view.grid.map((c, i) => ({ c, i })).filter(({ c, i }) => view.key[i] === 'a' || view.key[i] === 'b');
      el.appendChild(UI.muted(`You are the spymaster for Team ${view.team.toUpperCase()} (${myTeamColor === 'a' ? 'blue' : 'red'}). Words with a dot are yours.`));
      el.appendChild(UI.inputRow('One-word clue...', (text) => send({ type: 'clue', word: text, count: 2 }), { submitLabel: 'Give clue (×2)' }));
    } else if (view.phase === 'guess' && team === view.team) {
      el.appendChild(UI.row(UI.muted(`Guess the ${view.clue?.word || ''} words (${view.guessesLeft} left).`), UI.btn('Stop guessing', () => send({ type: 'pass' }), { size: 'sm' })));
    } else if (view.phase === 'clue') {
      el.appendChild(UI.muted(`Waiting for ${view.players.find((p) => p.id === view.spymasterNow)?.name || 'the spymaster'}...`));
    }
    if (view.phase === 'reveal') el.appendChild(UI.btn('Continue', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
    el.appendChild(UI.scoreboard(view));
  },
};

function endCodeTurn(state, events) {
  const next = state.team === 'a' ? 'b' : 'a';
  state.team = next;
  state.clue = null;
  state.guessesLeft = 0;
  state.phase = 'clue';
  events.push(U.event(`Team ${next.toUpperCase()} is up.`, 'info'));
}

export default { mafia, gecko, codenames };
