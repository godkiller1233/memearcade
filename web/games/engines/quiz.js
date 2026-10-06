/**
 * Quiz family: Trivia, Quiz Rush, Jeopardy, Guess the Character and Prompt
 * Guessing.
 *
 * All five share the same "ask -> answer -> reveal -> next" flow; the engines
 * differ in how questions are built, how points are awarded and what extra
 * systems sit on top (Quiz Rush game modes, Jeopardy's steal window, the
 * prompt-guessing keyword grader).
 *
 * Everything is generated offline from content packs - no API keys, no network.
 */
import * as U from './util.js';
import * as UI from './ui.js';

const MODES = ['solo', 'local', 'online'];

/* ========================================================================= *
 * Content
 * ========================================================================= */

const TRIVIA = [
  { q: 'Which creature in Minecraft explodes when it gets close to you?', a: ['Creeper', 'Zombie', 'Enderman', 'Slime'], c: 0, cat: 'games' },
  { q: 'In chess, what is the only piece that can jump over others?', a: ['Knight', 'Bishop', 'Rook', 'Queen'], c: 0, cat: 'games' },
  { q: 'What colour is the "? block" in Super Mario Bros.?', a: ['Yellow', 'Blue', 'Green', 'Red'], c: 0, cat: 'games' },
  { q: 'Which game series features the Triforce?', a: ['The Legend of Zelda', 'Metroid', 'Fire Emblem', 'Kirby'], c: 0, cat: 'games' },
  { q: 'In Among Us, what does a Gecko-style imposter pretend to do?', a: ['The same tasks as everyone else', 'Fly the ship', 'Sell snacks', 'Guard the door'], c: 0, cat: 'games' },
  { q: 'What is the best-selling video game of all time (by units)?', a: ['Minecraft', 'Tetris (mobile)', 'GTA V', 'Wii Sports'], c: 0, cat: 'games' },
  { q: 'Which cheat code famously gives 30 extra lives?', a: ['The Konami Code', 'IDDQD', 'HESOYAM', 'Rosebud'], c: 0, cat: 'games' },
  { q: 'In UNO, which card forces the next player to draw four?', a: ['Wild Draw Four', 'Skip', 'Reverse', 'Draw Two'], c: 0, cat: 'games' },

  { q: 'In Dragon Ball, what do the seven balls summon?', a: ['Shenron the dragon', 'A giant robot', 'A magical sword', 'A portal home'], c: 0, cat: 'anime' },
  { q: 'What is the name of the notebook in Death Note?', a: ['Death Note', 'Soul Book', 'Kill Note', 'Black Ledger'], c: 0, cat: 'anime' },
  { q: 'Which anime is about pirates hunting a legendary treasure?', a: ['One Piece', 'Bleach', 'Naruto', 'Fairy Tail'], c: 0, cat: 'anime' },
  { q: 'What does a Titan in Attack on Titan famously lack?', a: ['A digestive system', 'A head', 'Legs', 'Eyes'], c: 0, cat: 'anime' },
  { q: 'In Pokémon, what type is super effective against Water?', a: ['Electric', 'Fire', 'Normal', 'Steel'], c: 0, cat: 'anime' },
  { q: 'What is the Japanese word for "special move" used in fighting anime?', a: ['Hissatsu', 'Bento', 'Onigiri', 'Tatami'], c: 0, cat: 'anime' },
  { q: 'In Sailor Moon, what does the team protect?', a: ['The Moon Kingdom / Earth', 'A pizza shop', 'A tennis club', 'The stock market'], c: 0, cat: 'anime' },
  { q: 'What does "shonen" roughly mean in anime categories?', a: ['For young boys', 'For adults only', 'Musical', 'Silent'], c: 0, cat: 'anime' },

  { q: 'What planet is closest to the Sun?', a: ['Mercury', 'Venus', 'Mars', 'Earth'], c: 0, cat: 'science' },
  { q: 'What is the chemical symbol for gold?', a: ['Au', 'Gd', 'Go', 'Ag'], c: 0, cat: 'science' },
  { q: 'How many bones are in the adult human body?', a: ['206', '186', '246', '300'], c: 0, cat: 'science' },
  { q: 'What gas do plants absorb from the air?', a: ['Carbon dioxide', 'Oxygen', 'Helium', 'Neon'], c: 0, cat: 'science' },
  { q: 'What is the hardest natural substance?', a: ['Diamond', 'Steel', 'Quartz', 'Obsidian'], c: 0, cat: 'science' },
  { q: 'How long does light take to reach Earth from the Sun?', a: ['About 8 minutes', 'About 8 seconds', 'About 8 hours', 'Instantly'], c: 0, cat: 'science' },
  { q: 'What do you call a group of crows?', a: ['A murder', 'A gaggle', 'A pride', 'A swarm'], c: 0, cat: 'science' },
  { q: 'What is the largest organ in the human body?', a: ['Skin', 'Liver', 'Lungs', 'Brain'], c: 0, cat: 'science' },

  { q: 'How many sides does a circle have?', a: ['One, technically', 'Two', 'Zero', 'Infinite'], c: 0, cat: 'nonsense' },
  { q: 'What is the correct way to eat a KitKat according to the internet?', a: ['Bite the whole thing, no snapping', 'Snap first', 'Freeze it', 'With a fork'], c: 0, cat: 'nonsense' },
  { q: 'What does a rubber duck do best?', a: ['Float silently in judgement', 'Fly', 'Sing opera', 'Do taxes'], c: 0, cat: 'nonsense' },
  { q: 'Which is the most powerful item in any kitchen?', a: ['The humble spoon', 'A fork', 'A whisk', 'The kettle'], c: 0, cat: 'nonsense' },
  { q: 'What sound does a great idea make?', a: ['A lightbulb "ding"', 'A car alarm', 'A duck quack', 'Silence'], c: 0, cat: 'nonsense' },
  { q: 'What is the safest way to open a bag of crisps?', a: ['With scissors and false confidence', 'Rip it wide open', 'Bite the corner', 'Stare at it'], c: 0, cat: 'nonsense' },
  { q: 'How long is "five more minutes" in real time?', a: ['Negotiable', 'Exactly five minutes', 'One hour', 'Depends on the alarm'], c: 0, cat: 'nonsense' },
  { q: 'What is the national animal of the internet?', a: ['The cat', 'The pigeon', 'The goose', 'The frog'], c: 0, cat: 'nonsense' },
];

const CHARACTERS = [
  { name: 'Kettle the Unbothered', clues: ['Wears a headband that never comes off', 'Cooks for the entire crew in a tiny galley', 'Shouts every attack name at full volume', 'Is the captain, obviously'] },
  { name: 'Mira Static', clues: ['Falls asleep mid-sentence', 'Is secretly the strongest in the room', 'Carries a paper fan everywhere', 'Wakes at exactly the wrong moment'] },
  { name: 'Professor Nine', clues: ['Owns a lab with far too many beakers', 'Says "fascinating" once per minute', 'Has been hit by lightning twice', 'Makes medicine out of mushrooms'] },
  { name: 'Vex the Notetaker', clues: ['Always carries a black notebook', 'Sits at the back of every class', 'Is unnervingly good at tennis', 'Says a name and everyone gasps'] },
  { name: 'Bramble Boots', clues: ['Runs everywhere, never walks', 'Has a map for a place that does not exist', 'Jumps off cliffs for fun', 'Talks to animals like equals'] },
  { name: 'Neon Nao', clues: ['Hair changes colour with mood', 'Builds gadgets out of vending machine parts', 'Refuses to fight before 10am', 'Owns seven identical jackets'] },
  { name: 'Sir Crumbs', clues: ['A tiny knight in dented armour', 'Fights a dragon with a butter knife', 'Never removes the helmet', 'Squeaks when nervous'] },
  { name: 'Yuki Frostbyte', clues: ['Arrives in a blizzard for dramatic effect', 'Cold hands, warm heart', 'Only eats shaved ice', 'Freezes puddles on purpose'] },
  { name: 'Hollis Gatekeeper', clues: ['Guards a door nobody needs', 'Knows everyone by name', 'Keeps a list of the rules', 'Has never lost a staring contest'] },
  { name: 'Noodle the Intern', clues: ['Hired by accident', 'Saves the day at the worst moment', 'Keeps snacks in every pocket', 'Has no idea what is going on'] },
  { name: 'Captain Two-Suns', clues: ['Sails a ship through the sky', 'Has one eye and two coats', 'Never gives up the helm', 'Yells orders at clouds'] },
  { name: 'Goro Nightlight', clues: ['Only appears after dark', 'Magics with a lantern', 'Speaks in riddles at breakfast', 'Terrible at hiding, great at vanishing'] },
];

const PROMPTS = [
  { label: 'Neon cat city', keywords: ['cat', 'neon', 'city'], palette: 'neon' },
  { label: 'Sunset pirate ship', keywords: ['pirate', 'ship', 'sunset'], palette: 'sunset' },
  { label: 'Forest wizard tower', keywords: ['wizard', 'forest', 'tower'], palette: 'forest' },
  { label: 'Arcade dragon battle', keywords: ['dragon', 'arcade', 'battle'], palette: 'arcade' },
  { label: 'Candy robot picnic', keywords: ['robot', 'picnic', 'candy'], palette: 'candy' },
  { label: 'Moonlit space whale', keywords: ['whale', 'space', 'moon'], palette: 'neon' },
  { label: 'Desert cactus rodeo', keywords: ['cactus', 'desert', 'rodeo'], palette: 'sunset' },
  { label: 'Underwater volcano party', keywords: ['volcano', 'underwater', 'party'], palette: 'arcade' },
  { label: 'Frozen pizza palace', keywords: ['pizza', 'frozen', 'palace'], palette: 'mono' },
  { label: 'Rainy robot parade', keywords: ['rain', 'robot', 'parade'], palette: 'forest' },
  { label: 'Ghost train at midnight', keywords: ['ghost', 'train', 'midnight'], palette: 'mono' },
  { label: 'Bubble tea mountain', keywords: ['bubble', 'tea', 'mountain'], palette: 'candy' },
  { label: 'Thunder bee marathon', keywords: ['thunder', 'bee', 'marathon'], palette: 'sunset' },
  { label: 'Cozy ghost library', keywords: ['ghost', 'library', 'cozy'], palette: 'forest' },
];

const FILLER_WORDS = ['landscape', 'pattern', 'abstract', 'colourful', 'shapes', 'dream', 'abstract art', 'chaos', 'vibes', 'geometry', 'noise', 'gradient', 'circles', 'squares'];

/* ========================================================================= *
 * Small shared helpers
 * ========================================================================= */

function pending(state, list) {
  const map = list || state.answers || {};
  return state.players.filter((p) => map[p.id] === undefined).map((p) => p.id);
}

function pendingReady(state) {
  const done = state.ready || [];
  return state.players.filter((p) => !done.includes(p.id)).map((p) => p.id);
}

function freshQuestion(state, question) {
  state.question = question;
  state.answers = {};
  state.answerOrder = [];
  state.ready = [];
  state.revealed = null;
  state.phase = 'ask';
}

function recordAnswer(state, playerId, value) {
  state.answers[playerId] = value;
  state.answerOrder.push(playerId);
  if (state.players.every((p) => state.answers[p.id] !== undefined)) state.phase = 'reveal';
}

function readyUp(state, playerId) {
  if (!state.ready.includes(playerId)) state.ready.push(playerId);
  return state.players.every((p) => state.ready.includes(p.id));
}

function cleanAnswer(text, max = 140) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function shuffleOptions(options, rng) {
  return U.shuffle(options, rng);
}

function speedBonus(orderIndex, players) {
  return Math.max(0, players.length - orderIndex - 1);
}

/** Standard "ask" render: question card, options, who is waiting. */
function renderAsk({ el, view, playerId, send, extra = null, promptCard = null, placeholder = null }) {
  el.appendChild(promptCard || UI.promptCard(view.question.text));
  if (extra) el.appendChild(extra);
  if (view.myAnswer !== null && view.myAnswer !== undefined) {
    el.appendChild(UI.panel('Your answer', UI.h('div', { class: 'entry-text', text: String(view.myAnswerText ?? view.myAnswer) })));
  } else if (view.answerType === 'text') {
    el.appendChild(UI.inputRow(placeholder || 'Type your guess...', (text) => send({ type: 'answer', text }), { submitLabel: 'Lock in' }));
  } else {
    el.appendChild(UI.h('div', { class: 'option-grid' },
      view.question.options.map((opt) => UI.h('button', {
        class: 'option',
        onClick: () => send({ type: 'answer', choice: opt.id }),
      }, UI.h('strong', { text: opt.text })))));
  }
  el.appendChild(waitingChips(view));
}

function waitingChips(view) {
  const answered = view.answered || [];
  return UI.h('div', { class: 'waiting-list' },
    view.players.map((p) => UI.h('span', { class: `chip ${answered.includes(p.id) ? 'done' : ''}` }, `${p.avatar || ''} ${p.name}${answered.includes(p.id) ? ' ✓' : ''}`)));
}

function renderReveal({ el, view, playerId, send, revealExtra = null }) {
  el.appendChild(UI.h('div', { class: 'phase-bar' }, UI.pill(`Question ${view.round}/${view.maxRounds}`), UI.pill('Results')));
  el.appendChild(UI.scoreboard(view));
  if (revealExtra) el.appendChild(revealExtra);
  el.appendChild(UI.btn(view.round >= view.maxRounds || view.finalRound ? 'Finish' : 'Next question', () => send({ type: 'next' }), {
    variant: 'primary',
    disabled: (view.readies || []).includes(playerId),
  }));
}

function freshExtras(state, extras) {
  Object.assign(state, extras);
}

/* ========================================================================= *
 * Trivia
 * ========================================================================= */

function prepareQuestion(entry, rng, qid) {
  const options = shuffleOptions(entry.a.map((text, i) => ({ id: String.fromCharCode(97 + i), text })), rng);
  const correctOption = options.find((o) => o.text === entry.a[entry.c]) || options[0];
  return { id: qid, text: entry.q, options, correctId: correctOption.id, cat: entry.cat, answerText: entry.a[entry.c] };
}

function pickQuestions(bank, count, rng, cat = 'mixed') {
  const pool = cat && cat !== 'mixed' ? bank.filter((q) => q.cat === cat) : bank.slice();
  const source = pool.length >= count ? pool : bank.slice();
  return U.shuffle(source, rng).slice(0, count).map((entry, i) => prepareQuestion(entry, rng, i));
}

function triviaScore(state, playerId, orderIndex) {
  return 6 + speedBonus(orderIndex, state.players);
}

export const trivia = {
  meta: {
    id: 'trivia',
    name: 'Trivia',
    category: 'quiz',
    players: { min: 1, max: 16 },
    modes: MODES,
    simultaneous: true,
    blurb: 'Hundreds of questions across games, anime, science and pure nonsense. Speed matters.',
    tags: ['quiz', 'party'],
    minutes: 12,
    status: 'playable',
    bots: true,
    maxBots: 8,
    rules: [
      'A question appears - everyone answers at the same time.',
      'Correct answers score, and the quicker you lock in the bigger the bonus.',
      'Most points after the last question wins.',
    ],
    options: [
      { id: 'rounds', label: 'Questions', type: 'select', values: [3, 5, 8], default: 5 },
      { id: 'cat', label: 'Category', type: 'select', values: ['mixed', 'games', 'anime', 'science', 'nonsense'], default: 'mixed' },
    ],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.maxRounds = options.rounds || 5;
    state.cat = options.cat || 'mixed';
    state.pool = pickQuestions(TRIVIA, state.maxRounds, rng, state.cat);
    state.round = 1;
    state.answerType = 'choice';
    freshQuestion(state, state.pool[0]);
    state.results = {};
    U.addLog(state, `Question 1 of ${state.maxRounds}: ${state.question.text}`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.answerType = state.answerType;
    v.question = state.question;
    v.myAnswer = state.answers[viewerId] ?? null;
    v.answered = Object.keys(state.answers);
    v.readies = state.ready || [];
    v.revealed = state.revealed;
    v.turn = [];
    if (state.phase === 'ask') v.turn = pending(state, state.answers);
    else v.turn = pendingReady(state);
    if (state.winnerId || state.draw) v.turn = [];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId || state.draw) return { ok: false, error: 'Game over.' };
    if (action.type === 'answer') {
      if (state.phase !== 'ask') return { ok: false, error: 'Answers are closed.' };
      if (state.answers[playerId] !== undefined) return { ok: false, error: 'You already answered.' };
      const choice = state.question.options.find((o) => o.id === action.choice);
      if (!choice) return { ok: false, error: 'Pick one of the answers.' };
      const orderIndex = state.answerOrder.length;
      recordAnswer(state, playerId, choice.id);
      const events = [];
      if (state.phase === 'reveal') {
        state.revealed = { correctId: state.question.correctId, results: [] };
        const correcters = state.answers;
        for (const [id, value] of Object.entries(correcters)) {
          const seat = U.byId(state, id);
          if (value === state.question.correctId) {
            const idx = state.answerOrder.indexOf(id);
            const pts = triviaScore(state, id, idx);
            U.addScore(state, id, pts);
            state.revealed.results.push({ id, correct: true, points: pts, text: state.question.answerText });
            events.push(U.event(`${seat?.name} answered correctly (+${pts}).`, 'win'));
          } else {
            state.revealed.results.push({ id, correct: false, points: 0, text: state.question.answerText });
          }
        }
        if (!state.revealed.results.some((r) => r.correct)) events.push(U.event('Nobody got it right!', 'warn'));
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      const allReady = readyUp(state, playerId);
      const events = [];
      if (allReady) {
        if (state.round >= state.maxRounds) {
          const ranked = U.ranking(state);
          state.winnerId = ranked.filter((r) => r.score === ranked[0].score).map((r) => r.id);
          state.summary = `${ranked[0].name} wins the quiz with ${ranked[0].score}!`;
          events.push(U.event(state.summary, 'win'));
        } else {
          state.round++;
          freshQuestion(state, state.pool[state.round - 1]);
          events.push(U.event(`Question ${state.round}: ${state.question.text}`, 'info'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    if (state.phase === 'ask' && state.answers[playerId] === undefined) {
      return { type: 'answer', choice: botChoice(state, playerId) };
    }
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    if (state.winnerId) {
      return { over: true, winners: Array.isArray(state.winnerId) ? state.winnerId : [state.winnerId], scores: state.scores, summary: state.summary };
    }
    return { over: false };
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.h('div', { class: 'phase-bar' }, UI.pill(`Q${view.round}/${view.maxRounds}`), UI.pill(`Category: ${state0Label(view)}`), UI.pill(`${view.answered.length}/${view.players.length} answered`)));
    if (view.phase === 'ask') {
      renderAsk({ el, view, playerId, send });
      return;
    }
    renderReveal({ el, view, playerId, send, revealExtra: renderQuizReveal(view) });
  },
};

function state0Label(view) {
  return view.question?.cat || 'mixed';
}

function renderQuizReveal(view) {
  const results = view.revealed?.results || [];
  const correct = view.question.options.find((o) => o.id === view.revealed?.correctId);
  return UI.h('div', { class: 'reveal-box' },
    UI.promptCard(`Answer: ${correct?.text || ''}`, null),
    UI.h('div', { class: 'waiting-list' }, results.map((r) => UI.h('span', { class: `chip ${r.correct ? 'done' : ''}` }, `${U.truncate(String(U.byId({ players: view.players }, r.id)?.name || r.id), 14)} ${r.correct ? `+${r.points}` : '✗'}`))));
}

/** Bot's multiple-choice pick: level scales accuracy, speed jitters a little. */
export function botChoice(state, playerId, question = null) {
  const seat = U.byId(state, playerId);
  const level = seat?.level ?? 2;
  const q = question || state.question;
  const options = q.options || [];
  const correctId = q.correctId;
  const skill = U.botSkill(level);
  if (correctId && Math.random() < 0.35 + skill * 0.55) return correctId;
  return U.pick(options.map((o) => o.id));
}

/* ========================================================================= *
 * Quiz Rush (Classic / Coin Rush / Hack Attack / Royale)
 * ========================================================================= */

const RUSH_MODES = {
  classic: { name: 'Classic', desc: 'Answer fast, score points, climb the podium.' },
  'coin-rush': { name: 'Coin Rush', desc: 'Steal a share of coins from whoever is leading.' },
  'hack-attack': { name: 'Hack Attack', desc: 'Freeze, swap or double an opponent\'s score.' },
  royale: { name: 'Royale', desc: 'Miss three and you are eliminated. Last one standing wins.' },
};

export const quizRush = {
  meta: {
    id: 'quiz-rush',
    name: 'Quiz Rush',
    category: 'quiz',
    players: { min: 1, max: 16 },
    modes: MODES,
    simultaneous: true,
    blurb: 'Blooket-style chaos: pick a mode, answer fast and sabotage everyone else.',
    tags: ['quiz', 'party'],
    minutes: 10,
    status: 'playable',
    bots: true,
    maxBots: 8,
    rules: [
      'Everyone answers the same question at the same time.',
      'Each mode adds its own twist: coins, hacks or elimination.',
      'Most points (or last player standing) wins.',
    ],
    options: [
      { id: 'mode', label: 'Mode', type: 'select', values: Object.keys(RUSH_MODES), default: 'classic' },
      { id: 'rounds', label: 'Questions', type: 'select', values: [5, 8, 12], default: 8 },
    ],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.mode = RUSH_MODES[options.mode] ? options.mode : 'classic';
    state.maxRounds = options.rounds || 8;
    state.pool = pickQuestions(TRIVIA, state.maxRounds, rng);
    state.round = 1;
    state.answerType = 'choice';
    state.lives = {};
    state.coins = {};
    state.hacks = [];
    for (const p of state.players) {
      state.lives[p.id] = 3;
      state.coins[p.id] = 10;
    }
    freshQuestion(state, state.pool[0]);
    U.addLog(state, `${RUSH_MODES[state.mode].name} mode - question 1!`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.mode = state.mode;
    v.modeName = RUSH_MODES[state.mode].name;
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.answerType = 'choice';
    v.question = state.question;
    v.myAnswer = state.answers[viewerId] ?? null;
    v.answered = Object.keys(state.answers);
    v.readies = state.ready || [];
    v.revealed = state.revealed;
    v.lives = state.lives;
    v.coins = state.coins;
    v.eliminated = state.players.filter((p) => (state.lives[p.id] ?? 1) <= 0).map((p) => p.id);
    v.turn = [];
    if (state.phase === 'ask') v.turn = pending(state, state.answers).filter((id) => (state.lives[id] ?? 1) > 0);
    else v.turn = pendingReady(state);
    if (state.winnerId || state.draw) v.turn = [];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId || state.draw) return { ok: false, error: 'Game over.' };
    if ((state.lives[playerId] ?? 1) <= 0) return { ok: false, error: 'You are eliminated - spectate the chaos.' };
    if (action.type === 'answer') {
      if (state.phase !== 'ask') return { ok: false, error: 'Answers are closed.' };
      if (state.answers[playerId] !== undefined) return { ok: false, error: 'You already answered.' };
      const choice = state.question.options.find((o) => o.id === action.choice);
      if (!choice) return { ok: false, error: 'Pick one of the answers.' };
      recordAnswer(state, playerId, choice.id);
      const events = [];
      if (state.phase === 'reveal') resolveRush(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      const allReady = readyUp(state, playerId);
      const events = [];
      if (allReady) {
        const alive = state.players.filter((p) => (state.lives[p.id] ?? 1) > 0);
        const outOfQuestions = state.round >= state.maxRounds;
        const royaleDone = state.mode === 'royale' && alive.length <= 1;
        if (royaleDone || outOfQuestions) {
          finishRush(state, alive, events, outOfQuestions);
        } else {
          state.round++;
          freshQuestion(state, state.pool[(state.round - 1) % state.pool.length]);
          events.push(U.event(`Question ${state.round}: ${state.question.text}`, 'info'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    if ((state.lives[playerId] ?? 1) <= 0) {
      if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
      return null;
    }
    if (state.phase === 'ask' && state.answers[playerId] === undefined) return { type: 'answer', choice: botChoice(state, playerId) };
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    if (state.winnerId) {
      return { over: true, winners: Array.isArray(state.winnerId) ? state.winnerId : [state.winnerId], scores: state.scores, summary: state.summary };
    }
    return { over: false };
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(view.modeName),
      UI.pill(`Q${view.round}/${view.maxRounds}`),
      UI.pill(`${view.answered.length}/${view.players.filter((p) => !view.eliminated.includes(p.id)).length} answered`),
      view.mode === 'royale' ? UI.pill(`❤️ ${view.lives[playerId] ?? 0}`) : null,
      view.mode !== 'royale' ? UI.pill(`${view.mode === 'coin-rush' ? '🪙' : '⭐'} ${view.scores[playerId] ?? 0}`) : null,
    ));
    if (view.mode === 'royale') {
      el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.eliminated.includes(p.id) ? 'out' : 'done'}` }, `${p.name} ${view.eliminated.includes(p.id) ? '💀' : '❤️'.repeat(Math.max(0, view.lives[p.id] ?? 0))}`))));
    }
    if (view.phase === 'ask') {
      renderAsk({ el, view, playerId, send });
      return;
    }
    renderReveal({ el, view, playerId, send, revealExtra: renderQuizReveal(view) });
  },
};

function resolveRush(state, events) {
  state.revealed = { correctId: state.question.correctId, results: [], hacks: [] };
  const correcters = Object.entries(state.answers).filter(([, value]) => value === state.question.correctId).map(([id]) => id);
  const wrongers = Object.entries(state.answers).filter(([, value]) => value !== state.question.correctId).map(([id]) => id);
  if (!correcters.length) events.push(U.event('Nobody got it right!', 'warn'));

  for (const id of correcters) {
    const idx = state.answerOrder.indexOf(id);
    let points = 5 + speedBonus(idx, state.players);
    if (state.mode === 'coin-rush') {
      const others = state.players.filter((p) => p.id !== id && (state.lives[p.id] ?? 1) > 0);
      const leader = others.sort((a, b) => (state.coins[b.id] || 0) - (state.coins[a.id] || 0))[0];
      const stolen = leader ? Math.max(1, Math.round((state.coins[leader.id] || 0) * 0.15)) : 0;
      if (leader) state.coins[leader.id] = Math.max(0, (state.coins[leader.id] || 0) - stolen);
      state.coins[id] = (state.coins[id] || 0) + 8 + stolen;
      points = 6;
      if (stolen) events.push(U.event(`${U.byId(state, id)?.name} stole ${stolen} coins from ${leader.name}!`, 'win'));
    }
    if (state.mode === 'hack-attack' && Math.random() < 0.5) {
      const hack = U.pick(['freeze', 'swap', 'double']);
      const others = state.players.filter((p) => p.id !== id && (state.lives[p.id] ?? 1) > 0);
      const target = others.length ? U.pick(others) : null;
      if (hack === 'double') {
        points *= 2;
        state.revealed.hacks.push({ by: id, target: id, kind: 'double', text: 'DOUBLE POINTS!' });
        events.push(U.event(`${U.byId(state, id)?.name} doubled their points!`, 'win'));
      } else if (hack === 'freeze' && target) {
        U.addScore(state, target.id, -4);
        state.revealed.hacks.push({ by: id, target: target.id, kind: 'freeze', text: 'frozen (-4)' });
        events.push(U.event(`${U.byId(state, id)?.name} froze ${target.name} (-4).`, 'warn'));
      } else if (hack === 'swap' && target) {
        const mine = state.scores[id] || 0;
        const theirs = state.scores[target.id] || 0;
        state.scores[id] = theirs;
        state.scores[target.id] = mine;
        points = 0;
        state.revealed.hacks.push({ by: id, target: target.id, kind: 'swap', text: 'swapped scores' });
        events.push(U.event(`${U.byId(state, id)?.name} swapped scores with ${target.name}!`, 'warn'));
      }
    }
    if (points) U.addScore(state, id, points);
    state.revealed.results.push({ id, correct: true, points, name: U.byId(state, id)?.name });
    events.push(U.event(`${U.byId(state, id)?.name} answered correctly (+${points}).`, 'win'));
  }
  for (const id of wrongers) {
    if (state.mode === 'royale') {
      state.lives[id] = Math.max(0, (state.lives[id] || 1) - 1);
      if (state.lives[id] <= 0) events.push(U.event(`${U.byId(state, id)?.name} is eliminated!`, 'warn'));
    }
    state.revealed.results.push({ id, correct: false, points: 0, name: U.byId(state, id)?.name });
  }
}

function finishRush(state, alive, events, outOfQuestions) {
  if (state.mode === 'royale' && alive.length <= 1 && !outOfQuestions) {
    state.winnerId = alive.map((p) => p.id);
    state.summary = alive.length ? `${alive[0].name} is the last one standing!` : 'Everyone fell - nobody wins!';
  } else {
    const ranked = U.ranking(state).filter((r) => alive.some((p) => p.id === r.id));
    const best = ranked[0];
    const winners = ranked.filter((r) => r.score === best?.score).map((r) => r.id);
    state.winnerId = winners;
    state.summary = best ? `${best.name} wins with ${best.score}!` : 'No winner.';
  }
  events.push(U.event(state.summary, 'win'));
}

/* ========================================================================= *
 * Jeopardy
 * ========================================================================= */

const JEOPARDY_CATS = [
  { name: 'Games', clues: [
    { q: 'This blocky sandbox game lets you build with cubes.', a: 'Minecraft' },
    { q: 'Nintendo\'s plumber mascot has this first name.', a: 'Mario' },
    { q: 'This battle royale drops 100 players on an island.', a: 'Fortnite' },
    { q: 'The blue hedgehog who runs very fast.', a: 'Sonic' },
  ] },
  { name: 'Anime', clues: [
    { q: 'The notebook that kills anyone whose name is written in it.', a: 'Death Note' },
    { q: 'This series follows pirates hunting the One Piece.', a: 'One Piece' },
    { q: 'Giant humanoid monsters that eat people.', a: 'Titans' },
    { q: 'A ninja from the Hidden Leaf Village.', a: 'Naruto' },
  ] },
  { name: 'Science', clues: [
    { q: 'The closest planet to the Sun.', a: 'Mercury' },
    { q: 'The gas plants breathe in.', a: 'Carbon dioxide' },
    { q: 'The hardest natural substance.', a: 'Diamond' },
    { q: 'The number of bones in an adult human.', a: '206' },
  ] },
  { name: 'Meme History', clues: [
    { q: 'The phrase a surprised Pikachu says.', a: 'Nothing - it just stares' },
    { q: 'This dog is "fine" while sitting in a burning room.', a: 'This is fine' },
    { q: 'The dance that swept 2019 in gaming lobbies.', a: 'Floss' },
    { q: 'A goat screams at this number of seconds.', a: 'Ten' },
  ] },
];

const JEOPARDY_VALUES = [200, 400, 600, 800];

export const jeopardy = {
  meta: {
    id: 'jeopardy',
    name: 'Jeopardy',
    category: 'quiz',
    players: { min: 1, max: 8 },
    modes: MODES,
    blurb: 'Pick a category and a value, answer in the form of a question, steal on the rebound.',
    tags: ['quiz', 'long'],
    minutes: 25,
    status: 'playable',
    bots: true,
    maxBots: 5,
    rules: [
      'The current picker chooses a category and value.',
      'Right answer: points. Wrong answer: the value is deducted and everyone else can steal.',
      'First correct steal takes the value. Highest score wins.',
    ],
  },
  create({ players, seed, rng = Math.random }) {
    const state = U.baseState({ players, seed });
    state.cells = [];
    for (const cat of JEOPARDY_CATS) {
      for (const [i, clue] of cat.clues.entries()) {
        const options = shuffleOptions([clue.a, ...U.pickMany(JEOPARDY_CATS.flatMap((c) => c.clues.map((x) => x.a)).filter((a) => a !== clue.a), 3, rng)], rng)
          .map((text, idx) => ({ id: String.fromCharCode(97 + idx), text }));
        const correct = options.find((o) => o.text === clue.a);
        state.cells.push({ cat: cat.name, value: JEOPARDY_VALUES[i], q: clue.q, options, correctId: correct.id, used: false });
      }
    }
    state.pickerId = state.players[0].id;
    state.phase = 'pick';
    state.streak = {};
    U.addLog(state, `${state.players[0].name} picks first.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.cells = state.cells;
    v.pickerId = state.pickerId;
    v.current = state.current || null;
    v.myAnswer = state.answers?.[viewerId] ?? null;
    v.answers = state.answers || {};
    v.answered = Object.keys(state.answers || {});
    v.readies = state.ready || [];
    v.revealed = state.revealed || null;
    v.steal = !!state.steal;
    v.turn = [];
    if (state.phase === 'pick' || state.phase === 'answer') v.turn = [state.pickerId];
    else if (state.phase === 'steal') v.turn = pending(state, state.answers).filter((id) => id !== state.pickerId);
    else if (state.phase === 'reveal') v.turn = pendingReady(state);
    if (state.winnerId) v.turn = [];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    const events = [];
    if (action.type === 'pick') {
      if (state.phase !== 'pick') return { ok: false, error: 'Not the picking phase.' };
      if (playerId !== state.pickerId) return { ok: false, error: 'Wait your turn to pick.' };
      const idx = Number(action.cell);
      const cell = state.cells[idx];
      if (!cell) return { ok: false, error: 'Pick a category and value.' };
      if (cell.used) return { ok: false, error: 'That clue is gone.' };
      cell.used = true;
      state.current = { index: idx, ...cell };
      state.answers = {};
      state.answerOrder = [];
      state.ready = [];
      state.steal = false;
      state.revealed = null;
      state.phase = 'answer';
      events.push(U.event(`${U.byId(state, playerId)?.name} picked ${cell.cat} for ${cell.value}.`, 'info'));
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'answer') {
      if (state.phase !== 'answer') return { ok: false, error: 'Answers are closed.' };
      if (playerId !== state.pickerId) return { ok: false, error: 'This one is the picker\'s.' };
      const choice = state.current.options.find((o) => o.id === action.choice);
      if (!choice) return { ok: false, error: 'Pick one of the answers.' };
      const correct = choice.id === state.current.correctId;
      if (correct) {
        U.addScore(state, playerId, state.current.value);
        state.revealed = { correctId: state.current.correctId, answerText: state.current.options.find((o) => o.id === state.current.correctId)?.text, results: [{ id: playerId, correct: true, points: state.current.value }] };
        state.phase = 'reveal';
        state.ready = [];
        events.push(U.event(`Correct for ${state.current.value}!`, 'win'));
      } else {
        U.addScore(state, playerId, -state.current.value);
        state.revealed = { correctId: state.current.correctId, answerText: state.current.options.find((o) => o.id === state.current.correctId)?.text, results: [{ id: playerId, correct: false, points: -state.current.value }] };
        state.answers = {};
        state.answerOrder = [];
        const others = state.players.filter((p) => p.id !== playerId);
        if (others.length) {
          state.steal = true;
          state.phase = 'steal';
          events.push(U.event(`Wrong (-${state.current.value}). Everyone else can steal!`, 'warn'));
        } else {
          state.steal = false;
          state.phase = 'reveal';
          state.ready = [];
          events.push(U.event(`Wrong (-${state.current.value}). Nobody left to steal.`, 'warn'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'steal') {
      if (state.phase !== 'steal') return { ok: false, error: 'Nothing to steal.' };
      if (playerId === state.pickerId) return { ok: false, error: 'The picker already had a go.' };
      if (state.answers[playerId] !== undefined) return { ok: false, error: 'You already answered.' };
      const choice = state.current.options.find((o) => o.id === action.choice);
      if (!choice) return { ok: false, error: 'Pick one of the answers.' };
      state.answers[playerId] = choice.id;
      state.answerOrder.push(playerId);
      const others = state.players.filter((p) => p.id !== state.pickerId);
      if (others.every((p) => state.answers[p.id] !== undefined)) {
        const winnerId = state.answerOrder.find((id) => state.answers[id] === state.current.correctId);
        if (winnerId) {
          U.addScore(state, winnerId, state.current.value);
          state.revealed.results.push({ id: winnerId, correct: true, points: state.current.value });
          events.push(U.event(`${U.byId(state, winnerId)?.name} steals it for ${state.current.value}!`, 'win'));
        } else {
          events.push(U.event('Nobody stole it - the answer goes to the void.', 'warn'));
        }
        state.phase = 'reveal';
        state.ready = [];
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      const allReady = readyUp(state, playerId);
      if (allReady) {
        const unused = state.cells.filter((c) => !c.used).length;
        if (!unused) {
          const ranked = U.ranking(state);
          const winners = ranked.filter((r) => r.score === ranked[0]?.score).map((r) => r.id);
          state.winnerId = winners;
          state.summary = `${ranked[0].name} wins Jeopardy with ${ranked[0].score}!`;
          events.push(U.event(state.summary, 'win'));
        } else {
          const lastCorrect = state.revealed?.results?.find((r) => r.correct);
          state.pickerId = lastCorrect?.id || state.pickerId;
          state.phase = 'pick';
          state.current = null;
          events.push(U.event(`${U.byId(state, state.pickerId)?.name} picks next.`, 'info'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    if (state.phase === 'pick' && playerId === state.pickerId) {
      const remaining = state.cells.map((c, i) => ({ c, i })).filter(({ c }) => !c.used);
      if (!remaining.length) return null;
      const level = U.byId(state, playerId)?.level ?? 2;
      const sorted = remaining.sort((a, b) => b.c.value - a.c.value);
      const choice = level >= 3 ? sorted[0] : U.pick(remaining);
      return { type: 'pick', cell: choice.i };
    }
    if (state.phase === 'answer' && playerId === state.pickerId) return { type: 'answer', choice: botChoice(state, playerId, state.current) };
    if (state.phase === 'steal' && state.answers[playerId] === undefined && playerId !== state.pickerId) {
      return { type: 'steal', choice: botChoice(state, playerId, state.current) };
    }
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    const cats = [...new Set(view.cells.map((c) => c.cat))];
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Picker: ${view.players.find((p) => p.id === view.pickerId)?.name || '?'}`),
      UI.pill(view.phase === 'steal' ? 'Steal window!' : view.phase === 'answer' ? 'Answering' : view.phase === 'pick' ? 'Pick a clue' : 'Results')));
    el.appendChild(UI.h('div', { class: 'board jeopardy-board', style: { '--cols': cats.length, '--rows': JEOPARDY_VALUES.length + 1 } },
      cats.map((cat) => UI.h('div', { class: 'cell head', text: cat })),
      JEOPARDY_VALUES.flatMap((value) =>
        cats.map((cat) => {
          const idx = view.cells.findIndex((c) => c.cat === cat && c.value === value);
          const cell = view.cells[idx];
          return UI.gridButton(cell?.used ? '' : String(value), () => send({ type: 'pick', cell: idx }), {
            className: `${cell?.used ? 'used' : ''} ${view.current?.index === idx ? 'active' : ''}`,
            disabled: view.phase !== 'pick' || cell?.used || playerId !== view.pickerId,
          });
        }))));

    if (view.phase === 'answer' || view.phase === 'steal') {
      el.appendChild(UI.promptCard(view.current.q, `For ${view.current.value} - ${view.steal ? 'STEAL!' : 'answer or lose the points'}`));
      const mine = view.steal ? view.myAnswer : null;
      if (view.steal && mine) {
        el.appendChild(UI.h('div', { class: 'muted', text: 'Answer locked - waiting for the rest.' }));
      } else if (!view.steal || playerId !== view.pickerId) {
        el.appendChild(UI.h('div', { class: 'option-grid' },
          view.current.options.map((opt) => UI.h('button', {
            class: 'option',
            disabled: view.phase === 'answer' && playerId !== view.pickerId,
            onClick: () => send({ type: view.phase === 'steal' ? 'steal' : 'answer', choice: opt.id }),
          }, UI.h('strong', { text: opt.text })))));
      }
      if (view.phase === 'steal') el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.answered.includes(p.id) || p.id === view.pickerId ? 'done' : ''}` }, `${p.name}${p.id === view.pickerId ? ' (had a go)' : view.answered.includes(p.id) ? ' ✓' : ''}`))));
      return;
    }
    if (view.phase === 'reveal') {
      el.appendChild(UI.promptCard(`Answer: ${view.revealed?.answerText || ''}`, view.current ? `Worth ${view.current.value}` : null));
      el.appendChild(UI.scoreboard(view));
      el.appendChild(UI.btn('Next clue', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
      return;
    }
    el.appendChild(UI.scoreboard(view));
    if (view.phase === 'pick') el.appendChild(UI.muted(playerId === view.pickerId ? 'Pick a category and value above.' : `Waiting for ${view.players.find((p) => p.id === view.pickerId)?.name} to pick.`));
  },
};

/* ========================================================================= *
 * Guess the Character
 * ========================================================================= */

const CLUE_POINTS = [10, 7, 4, 2];

export const guessCharacter = {
  meta: {
    id: 'guess-character',
    name: 'Guess the Character',
    category: 'quiz',
    players: { min: 1, max: 12 },
    modes: MODES,
    simultaneous: true,
    blurb: 'Clues revealed one at a time - the earlier you answer, the more you score.',
    tags: ['quiz', 'anime'],
    minutes: 10,
    status: 'playable',
    bots: true,
    maxBots: 8,
    rules: [
      'Each character gets four clues, revealed one per round.',
      'Everyone guesses from three candidates at the same time.',
      'Answer on clue 1 for 10 points, down to 2 points on clue 4.',
    ],
    options: [
      { id: 'characters', label: 'Characters', type: 'select', values: [2, 3, 4], default: 3 },
    ],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.queue = U.shuffle(CHARACTERS, rng).slice(0, options.characters || 3);
    state.perChar = 4;
    state.maxRounds = state.queue.length * state.perChar;
    state.round = 1;
    state.answerType = 'choice';
    beginCharacterRound(state, rng);
    U.addLog(state, 'Clue one - who is it?');
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.answerType = 'choice';
    v.question = state.question;
    v.clueIndex = state.clueIndex;
    v.myAnswer = state.answers[viewerId] ?? null;
    v.answered = Object.keys(state.answers);
    v.readies = state.ready || [];
    v.revealed = state.revealed;
    v.turn = state.phase === 'ask' ? pending(state, state.answers) : pendingReady(state);
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
      if (!choice) return { ok: false, error: 'Pick one of the candidates.' };
      recordAnswer(state, playerId, choice.id);
      if (state.phase === 'reveal') resolveCharacter(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      const allReady = readyUp(state, playerId);
      if (allReady) {
        if (state.round >= state.maxRounds) {
          const ranked = U.ranking(state);
          state.winnerId = ranked.filter((r) => r.score === ranked[0].score).map((r) => r.id);
          state.summary = `${ranked[0].name} has the sharpest eye (+${ranked[0].score})!`;
          events.push(U.event(state.summary, 'win'));
        } else {
          state.round++;
          state.clueIndex = (state.round - 1) % state.perChar;
          beginCharacterRound(state);
          events.push(U.event(`Clue ${state.clueIndex + 1} of 4: ${state.question.clues[state.clueIndex]}`, 'info'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    if (state.phase === 'ask' && state.answers[playerId] === undefined) return { type: 'answer', choice: botChoice(state, playerId) };
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Clue ${view.clueIndex + 1}/4`),
      UI.pill(`Character ${Math.floor((view.round - 1) / 4) + 1}/${view.maxRounds / 4}`)));
    if (view.phase === 'ask') {
      const clues = view.question.clues.slice(0, view.clueIndex + 1);
      el.appendChild(UI.panel(`Clue ${view.clueIndex + 1}`, UI.h('div', { class: 'story' },
        clues.map((c, i) => UI.h('div', { class: 'story-line' }, UI.h('span', { class: 'story-n', text: `${i + 1}.` }), UI.h('span', { class: 'story-text', text: c }))))));
      el.appendChild(UI.promptCard(`Worth ${CLUE_POINTS[view.clueIndex]} points - who is it?`));
      renderAsk({ el, view, playerId, send, promptCard: UI.h('span') });
      return;
    }
    el.appendChild(UI.promptCard(`It was ${view.question.name}!`, null));
    renderReveal({ el, view, playerId, send, revealExtra: renderQuizReveal(view) });
  },
};

function beginCharacterRound(state, rng = Math.random) {
  const entry = state.queue[Math.floor((state.round - 1) / state.perChar)];
  const decoys = U.shuffle(CHARACTERS.filter((c) => c.name !== entry.name), rng).slice(0, 2).map((c) => c.name);
  const options = shuffleOptions([entry.name, ...decoys].map((text, i) => ({ id: String.fromCharCode(97 + i), text })), rng);
  const correct = options.find((o) => o.text === entry.name);
  freshQuestion(state, { id: entry.name, name: entry.name, clues: entry.clues, options, correctId: correct.id });
  state.clueIndex = (state.round - 1) % state.perChar;
}

function resolveCharacter(state, events) {
  const points = CLUE_POINTS[state.clueIndex] ?? 2;
  const results = [];
  for (const [id, value] of Object.entries(state.answers)) {
    const correct = value === state.question.correctId;
    if (correct) {
      U.addScore(state, id, points);
      events.push(U.event(`${U.byId(state, id)?.name} nailed it for ${points}.`, 'win'));
    }
    results.push({ id, correct, points: correct ? points : 0, text: state.question.name });
  }
  state.revealed = { correctId: state.question.correctId, results, answerText: state.question.name };
}

/* ========================================================================= *
 * Prompt Guessing (procedural art -> hidden prompt keywords)
 * ========================================================================= */

export const guessThePrompt = {
  meta: {
    id: 'guess-the-prompt',
    name: 'Prompt Guessing',
    category: 'puzzle',
    players: { min: 1, max: 12 },
    modes: MODES,
    simultaneous: true,
    blurb: 'Abstract art generated from a hidden prompt - guess the words that made it.',
    tags: ['quiz', 'visual', 'ai-flavoured'],
    minutes: 8,
    status: 'playable',
    bots: true,
    maxBots: 8,
    rules: [
      'A picture is generated from a hidden prompt of two or three words.',
      'Type guesses - every prompt word you match scores.',
      'Most points after the last image wins.',
    ],
    options: [{ id: 'rounds', label: 'Images', type: 'select', values: [3, 5, 8], default: 5 }],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.maxRounds = options.rounds || 5;
    state.pool = U.shuffle(PROMPTS, rng).slice(0, state.maxRounds).map((p, i) => ({ ...p, seed: Math.floor(rng() * 1e9), id: i }));
    state.round = 1;
    state.answerType = 'text';
    freshQuestion(state, state.pool[0]);
    state.guesses = {};
    U.addLog(state, 'Image 1 - what was the prompt?');
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.answerType = 'text';
    v.question = { id: state.question.id, seed: state.question.seed, palette: state.question.palette, text: 'What prompt made this?' };
    v.myAnswer = state.answers[viewerId] ?? null;
    v.myAnswerText = state.answers[viewerId] ?? null;
    v.answered = Object.keys(state.answers);
    v.readies = state.ready || [];
    v.revealed = state.revealed;
    v.turn = state.phase === 'ask' ? pending(state, state.answers) : pendingReady(state);
    if (state.winnerId) v.turn = [];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    const events = [];
    if (action.type === 'answer') {
      if (state.phase !== 'ask') return { ok: false, error: 'Guesses are closed.' };
      if (state.answers[playerId] !== undefined) return { ok: false, error: 'You already guessed.' };
      const text = cleanAnswer(action.text, 120);
      if (!text) return { ok: false, error: 'Type a guess first.' };
      recordAnswer(state, playerId, text);
      if (state.phase === 'reveal') resolvePromptRound(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
      const allReady = readyUp(state, playerId);
      if (allReady) {
        if (state.round >= state.maxRounds) {
          const ranked = U.ranking(state);
          state.winnerId = ranked.filter((r) => r.score === ranked[0].score).map((r) => r.id);
          state.summary = `${ranked[0].name} read the art best (+${ranked[0].score})!`;
          events.push(U.event(state.summary, 'win'));
        } else {
          state.round++;
          freshQuestion(state, state.pool[state.round - 1]);
          events.push(U.event(`Image ${state.round} is up!`, 'info'));
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
      const words = state.question.keywords;
      const hits = words.filter(() => Math.random() < 0.25 + skill * 0.6);
      const text = (hits.length ? hits : U.pickMany(FILLER_WORDS, 2)).join(' ');
      return { type: 'answer', text };
    }
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.h('div', { class: 'phase-bar' }, UI.pill(`Image ${view.round}/${view.maxRounds}`), UI.pill(`${view.answered.length}/${view.players.length} guessed`)));
    const art = UI.canvasBox(520, 300, (ctx, w, h) => UI.paintScene(ctx, w, h, view.question.seed, { palette: view.question.palette, density: 26 }), { className: 'prompt-art' });
    el.appendChild(UI.h('div', { class: 'prompt-card art' }, art.el, UI.h('div', { class: 'prompt-sub', text: view.phase === 'ask' ? 'Generated from a hidden prompt' : `Prompt: ${view.revealed?.prompt || ''}` })));
    if (view.phase === 'ask') {
      renderAsk({ el, view, playerId, send, promptCard: UI.h('span'), placeholder: 'Type the words you think made this...' });
      return;
    }
    renderReveal({ el, view, playerId, send, revealExtra: UI.h('div', { class: 'reveal-box' },
      UI.h('div', { class: 'waiting-list' }, (view.revealed?.results || []).map((r) => UI.h('span', { class: `chip ${r.correct ? 'done' : ''}` }, `${view.players.find((p) => p.id === r.id)?.name || r.id}: ${r.hits}/${r.total} +${r.points}`)))) });
  },
};

function resolvePromptRound(state, events) {
  const keywords = state.question.keywords;
  const results = [];
  for (const [id, text] of Object.entries(state.answers)) {
    const lower = ` ${String(text).toLowerCase()} `;
    const hits = keywords.filter((k) => lower.includes(` ${k} `) || lower.includes(`${k},`) || lower.includes(`${k}.`) || lower.split(/\s+/).includes(k));
    const points = hits.length * 5;
    if (points) U.addScore(state, id, points);
    results.push({ id, hits: hits.length, total: keywords.length, points, correct: hits.length > 0, words: hits });
    if (points) events.push(U.event(`${U.byId(state, id)?.name} matched ${hits.join(', ')} (+${points}).`, 'win'));
  }
  if (!results.some((r) => r.points)) events.push(U.event('Nobody cracked the prompt!', 'warn'));
  state.revealed = { prompt: keywords.join(' '), keywords, results };
}

/* ========================================================================= */

export default { trivia, quizRush, jeopardy, guessCharacter, guessThePrompt };
