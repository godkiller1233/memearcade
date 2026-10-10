/**
 * Words family: Hangman and Guess the Story.
 *
 * Hangman is turn-based with a shared secret word (hidden from every view),
 * Guess the Story is simultaneous - three clues per mystery, scored by how
 * early you work out what really happened.
 */
import * as U from './util.js';
import * as UI from './ui.js';

const MODES = ['solo', 'local', 'online'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const MAX_STRIKES = 6;

/* ========================================================================= *
 * Hangman
 * ========================================================================= */

const HANGMAN_PACKS = {
  anime: 'Anime & manga',
  games: 'Games',
  science: 'Science-ish',
  chaos: 'Pure chaos',
};

const HANGMAN_WORDS = {
  anime: [
    { word: 'SHONEN', hint: 'Anime aimed at young boys' },
    { word: 'SENSEI', hint: 'What students call their teacher' },
    { word: 'KAIJU', hint: 'A giant monster' },
    { word: 'BENTO', hint: 'A packed lunch box' },
    { word: 'ONIGIRI', hint: 'A rice ball' },
    { word: 'NINJA', hint: 'A shadowy shinobi' },
    { word: 'MEOWTH', hint: 'The talking cat of Team Rocket' },
    { word: 'TOTORO', hint: 'A big fluffy forest spirit' },
  ],
  games: [
    { word: 'CREEPER', hint: 'It hisses before it goes boom' },
    { word: 'MINECRAFT', hint: 'Build, mine, survive' },
    { word: 'POKEBALL', hint: 'Catch them all in this' },
    { word: 'SPEEDRUN', hint: 'Finish the game as fast as possible' },
    { word: 'CHECKMATE', hint: 'The final move in chess' },
    { word: 'MULTIPLAYER', hint: 'More than one player' },
    { word: 'CONTROLLER', hint: 'A gamepad' },
    { word: 'TETRIS', hint: 'Blocks falling forever' },
  ],
  science: [
    { word: 'GRAVITY', hint: 'What keeps you on the floor' },
    { word: 'ELECTRON', hint: 'A tiny negative particle' },
    { word: 'PHOTOSYNTHESIS', hint: 'How plants eat sunlight' },
    { word: 'MOLECULE', hint: 'Two or more atoms bonded' },
    { word: 'VOLCANO', hint: 'Mountain that erupts' },
    { word: 'ASTRONAUT', hint: 'A space traveller' },
    { word: 'DINOSAUR', hint: 'Extinct giant reptile' },
    { word: 'MAGNET', hint: 'It attracts metal' },
  ],
  chaos: [
    { word: 'MEME', hint: 'You are playing a whole arcade of these' },
    { word: 'GOOSE', hint: 'Untitled and honking' },
    { word: 'PANCAKE', hint: 'Flat breakfast, often flipped' },
    { word: 'NUGGET', hint: 'A small golden fried snack' },
    { word: 'SNOOZE', hint: 'The button everyone abuses' },
    { word: 'WOBBLE', hint: 'What jelly does' },
    { word: 'PENGUIN', hint: 'A tuxedo bird' },
    { word: 'KARAOKE', hint: 'Singing badly, in public, on purpose' },
  ],
};

export const hangman = {
  meta: {
    id: 'hangman',
    // Solved words score, dud letters cost - so a good run is a high one.
    record: { best: 'high', label: 'points' },
    name: 'Hangman',
    category: 'board',
    players: { min: 1, max: 8 },
    modes: MODES,
    secret: true,
    blurb: 'Classic letter guessing with themed word packs and mercy hints.',
    tags: ['word', 'quick'],
    minutes: 8,
    status: 'playable',
    bots: true,
    maxBots: 6,
    turnMs: 30000,
    rules: [
      'Guess one letter at a time - correct letters score and keep your turn.',
      'Six wrong letters and the round is lost.',
      'Solve the word for a bonus. Most points after the last round wins.',
    ],
    options: [
      { id: 'pack', label: 'Word pack', type: 'select', values: Object.keys(HANGMAN_PACKS), default: 'chaos' },
      { id: 'rounds', label: 'Rounds', type: 'select', values: [1, 2, 3], default: 2 },
    ],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.pack = HANGMAN_PACKS[options.pack] ? options.pack : 'chaos';
    state.maxRounds = options.rounds || 2;
    state.round = 1;
    state.pool = U.shuffle(HANGMAN_WORDS[state.pack], rng);
    state.usedWords = [];
    loadWord(state);
    U.addLog(state, `Round 1: ${state.word.length} letters, pack: ${HANGMAN_PACKS[state.pack]}.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.packName = HANGMAN_PACKS[state.pack];
    v.masked = state.word.split('').map((ch) => (state.revealed.includes(ch) ? ch : '_'));
    v.hint = state.hint;
    v.guessed = state.guessed;
    v.wrong = state.wrong;
    v.strikes = state.strikes;
    v.maxStrikes = MAX_STRIKES;
    v.letters = LETTERS;
    v.solved = !!state.solved;
    v.failed = !!state.failed;
    // The word only becomes public once the round is decided.
    v.word = state.solved || state.failed ? state.word : null;
    v.readies = state.ready || [];
    v.turn = [];
    if (!state.solved && state.strikes < MAX_STRIKES) v.turn = [state.turnId];
    else v.turn = state.players.filter((p) => !(state.ready || []).includes(p.id)).map((p) => p.id);
    if (state.winnerId) v.turn = [];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    const events = [];
    if (action.type === 'guess') {
      if (state.solved || state.strikes >= MAX_STRIKES) return { ok: false, error: 'The round is over.' };
      if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
      const letter = String(action.letter || '').toUpperCase().slice(0, 1);
      if (!LETTERS.includes(letter)) return { ok: false, error: 'Pick a letter.' };
      if (state.guessed.includes(letter)) return { ok: false, error: 'Already guessed.' };
      state.guessed.push(letter);
      const hits = state.word.split('').filter((ch) => ch === letter).length;
      if (hits) {
        state.revealed.push(letter);
        const points = hits + 1;
        U.addScore(state, playerId, points);
        events.push(U.event(`${U.byId(state, playerId)?.name} found ${hits}× ${letter} (+${points}).`, 'win'));
        if (state.word.split('').every((ch) => state.revealed.includes(ch))) {
          state.solved = true;
          U.addScore(state, playerId, 5);
          state.summary = `${U.byId(state, playerId)?.name} solved it: ${state.word}!`;
          events.push(U.event(state.summary, 'win'));
          endRound(state);
        }
      } else {
        state.strikes++;
        state.wrong.push(letter);
        events.push(U.event(`${U.byId(state, playerId)?.name} guessed ${letter} - miss (${state.strikes}/${MAX_STRIKES}).`, 'warn'));
        if (state.strikes >= MAX_STRIKES) {
          state.solved = false;
          state.failed = true;
          state.summary = `Nobody solved ${state.word}.`;
          events.push(U.event(state.summary, 'warn'));
          endRound(state);
        } else {
          state.turnId = nextSeat(state, playerId);
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'hint') {
      if (state.solved || state.strikes >= MAX_STRIKES) return { ok: false, error: 'The round is over.' };
      if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
      if (state.hintUsed) return { ok: false, error: 'The hint is already used.' };
      const hidden = state.word.split('').filter((ch) => !state.revealed.includes(ch));
      if (!hidden.length) return { ok: false, error: 'Nothing left to hint.' };
      state.hintUsed = true;
      const letter = U.pick(hidden);
      state.guessed.push(letter);
      state.revealed.push(letter);
      events.push(U.event(`Hint revealed: ${letter}`, 'info'));
      state.turnId = nextSeat(state, playerId);
      if (state.word.split('').every((ch) => state.revealed.includes(ch))) {
        state.solved = true;
        state.summary = `${U.byId(state, playerId)?.name} finished the word: ${state.word}!`;
        events.push(U.event(state.summary, 'win'));
        endRound(state);
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'next') {
      if (!state.solved && !state.failed) return { ok: false, error: 'Keep guessing.' };
      if (!state.ready.includes(playerId)) state.ready.push(playerId);
      if (state.players.every((p) => state.ready.includes(p.id))) {
        if (state.round >= state.maxRounds) {
          const ranked = U.ranking(state);
          state.winnerId = ranked.filter((r) => r.score === ranked[0].score).map((r) => r.id);
          state.summary = `${ranked[0].name} wins the word games (+${ranked[0].score})!`;
          events.push(U.event(state.summary, 'win'));
        } else {
          state.round++;
          loadWord(state);
          events.push(U.event(`Round ${state.round}: ${state.word.length} letters.`, 'info'));
        }
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  timeout(state, playerId) {
    if (playerId !== state.turnId || state.solved || state.strikes >= MAX_STRIKES) return null;
    const spare = LETTERS.filter((l) => !state.guessed.includes(l));
    if (!spare.length) return null;
    return { type: 'guess', letter: U.pick(spare) };
  },
  bot(state, playerId) {
    if (state.solved || state.strikes >= MAX_STRIKES) {
      if (!state.ready.includes(playerId)) return { type: 'next' };
      return null;
    }
    if (playerId !== state.turnId) return null;
    const level = U.byId(state, playerId)?.level ?? 2;
    const hidden = state.word.split('').filter((ch) => !state.revealed.includes(ch));
    if (hidden.length && Math.random() < 0.25 + U.botSkill(level) * 0.7) return { type: 'guess', letter: U.pick(hidden) };
    const spare = LETTERS.filter((l) => !state.guessed.includes(l));
    if (!spare.length) return null;
    return { type: 'guess', letter: U.pick(spare) };
  },
  onLeave(state, playerId) {
    state.players = state.players.filter((p) => p.id !== playerId);
    state.order = state.order.filter((id) => id !== playerId);
    if (state.turnId === playerId) state.turnId = state.players[0]?.id || null;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Round ${view.round}/${view.maxRounds}`),
      UI.pill(view.packName),
      UI.pill(`Misses ${view.strikes}/${view.maxStrikes}`)));
    el.appendChild(UI.h('div', { class: 'hangman-word' }, view.masked.map((ch) => UI.h('span', { class: `hang-letter ${ch === '_' ? 'blank' : 'on'}`, text: ch === '_' ? '•' : ch }))));
    el.appendChild(UI.h('div', { class: 'muted', text: `Hint: ${view.hint}` }));
    const over = view.solved || view.strikes >= view.maxStrikes;
    if (!over) {
      el.appendChild(UI.h('div', { class: 'letter-grid' }, view.letters.map((letter) => UI.gridButton(letter, () => send({ type: 'guess', letter }), {
        className: `${view.guessed.includes(letter) ? (view.wrong.includes(letter) ? 'wrong' : 'hit') : ''}`,
        disabled: view.guessed.includes(letter) || !view.turn.includes(playerId),
      }))));
      el.appendChild(UI.row(
        UI.muted(view.turn.includes(playerId) ? 'Your turn - pick a letter.' : 'Waiting for the next guesser.'),
        UI.btn(view.hintUsed ? 'Hint used' : 'Mercy hint', () => send({ type: 'hint' }), { size: 'sm', disabled: view.hintUsed || !view.turn.includes(playerId) }),
      ));
      return;
    }
    el.appendChild(UI.promptCard(view.solved ? `Solved: ${view.word}` : `The word was ${view.word}`, view.solved ? 'Nice work.' : 'Better luck next round.'));
    el.appendChild(UI.scoreboard(view));
    el.appendChild(UI.btn(view.round >= view.maxRounds ? 'Finish' : 'Next word', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
  },
};

function endRound(state) {
  state.phase = 'reveal';
  state.ready = [];
  state.turnId = null;
  return state;
}

function nextSeat(state, playerId) {
  const order = state.players.map((p) => p.id);
  const i = order.indexOf(playerId);
  return order[(i + 1) % order.length];
}

function loadWord(state) {
  const word = state.pool[(state.round - 1) % state.pool.length];
  state.word = word.word;
  state.hint = word.hint;
  state.guessed = [];
  state.wrong = [];
  state.revealed = [];
  state.strikes = 0;
  state.solved = false;
  state.failed = false;
  state.hintUsed = false;
  state.ready = [];
  state.turnId = state.players[(state.round - 1) % state.players.length].id;
  return state;
}

/* ========================================================================= *
 * Guess the Story
 * ========================================================================= */

const STORIES = [
  {
    title: 'The lighthouse key',
    clues: [
      'A lighthouse keeper finds a second key that fits no door in the tower.',
      'The light starts turning a few seconds late every single night.',
      'The spare key is warm, even in winter.',
    ],
    options: [
      'Someone has been living in a hidden room inside the tower',
      'The lighthouse is haunted by a helpful ghost',
      'The key is a strange piece of meteorite',
      'The keeper has been sleepwalking again',
    ],
    answer: 0,
    reveal: 'There was a whole sealed room behind the lamp room - the "extra" keeper had been fixing the mechanism in secret for years.',
  },
  {
    title: 'The Tuesday statue',
    clues: [
      'The village statue changes colour only on Tuesdays.',
      'On Mondays the pigeons refuse to land on it.',
      'Paint flakes off it in perfect squares.',
    ],
    options: [
      'The statue is painted by the town\'s schoolchildren every Tuesday',
      'It is covered in colour-changing tiles that a vent hits on that day',
      'It is made of a rare mineral that reacts to the calendar',
      'The mayor repaints it at dawn and lies about it',
    ],
    answer: 1,
    reveal: 'A bakery vent opens every Tuesday morning and bathes the statue in warm, tinted steam - the tiles shift colour in the heat.',
  },
  {
    title: 'The train that was not there',
    clues: [
      'The last train stops at a station missing from every map.',
      'Nobody on the platform ever buys a ticket.',
      'The station clock shows the same minute all night.',
    ],
    options: [
      'It is a disused film set the train slows past',
      'The passengers are staff in costume',
      'It is an old halt with a broken clock and commuter regulars',
      'The train drivers take a wrong turn',
    ],
    answer: 2,
    reveal: 'It was a forgotten request-stop: the clock died in 1987 and the "mystery" passengers were night-shift workers who never needed tickets.',
  },
  {
    title: 'The extra chair',
    clues: [
      'Every birthday since the accident, one extra chair appears at the table.',
      'The chair is always the same one, and it is always cold.',
      'The family has moved house three times.',
    ],
    options: [
      'The family secretly keeps bringing the chair along',
      'The chair is a prank by the neighbours',
      'It is the seat of a relative who always arrives late',
      'The family never threw the original chair out - it travels with them in the moving van',
    ],
    answer: 0,
    reveal: 'Grandma\'s old chair was packed by mistake the first time - and after that somebody always put it out, just in case she turned up.',
  },
  {
    title: 'The arguing bookshop',
    clues: [
      'The books in the shop argue with the customers.',
      'The arguing stops whenever the owner walks past.',
      'The shop only argues on rainy afternoons.',
    ],
    options: [
      'A parrot lives in the rafters and repeats complaints',
      'The bookshelves hide speakers playing recordings',
      'The owner mutters and the customers imagine the rest',
      'The pipes in the wall rumble like voices when it rains',
    ],
    answer: 3,
    reveal: 'Old heating pipes ran behind every shelf - when rain cooled the roof, they groaned and banged, and the shop learned to blame itself.',
  },
  {
    title: 'The backwards clock',
    clues: [
      'The town clock ticks backwards only when someone tells the truth.',
      'It happened during one mayor\'s entire speech.',
      'The mechanic says the gears were never touched.',
    ],
    options: [
      'The mayor bribed the mechanic to lie',
      'A magnetic crane at the docks reversed the escapement',
      'It was a power cut and the clock genuinely ran backwards for a while',
      'The clock is connected to an old factory motor that reversed that day',
    ],
    answer: 1,
    reveal: 'A scrap crane\'s giant magnet swung past the tower and dragged the pendulum for a few minutes - the town still tells the story better than the truth.',
  },
  {
    title: 'The polite bear',
    clues: [
      'A bear knocks before entering the campsite shop.',
      'It always takes one jar of honey, never two.',
      'It leaves a fish on the step afterwards.',
    ],
    options: [
      'The bear was raised by the shopkeeper',
      'The bear is a person in a very good suit',
      'The bear learned the routine from watching hikers trade supplies',
      'The bear is actually a very large dog',
    ],
    answer: 2,
    reveal: 'It watched hundreds of hikers swap snacks at the counter and copied the ritual - knock, take one, pay in fish.',
  },
  {
    title: 'The glowing puddle',
    clues: [
      'A puddle behind the school glows blue after storms.',
      'It only glows on Fridays.',
      'The caretaker mops it up every Saturday like nothing happened.',
    ],
    options: [
      'Bioluminescent algae from the science lab dumped by mistake',
      'Glow-in-the-dark paint from a Friday art club',
      'A buried lightning rod feeding the puddle',
      'Fireflies trapped under the water',
    ],
    answer: 1,
    reveal: 'Friday art club rinsed glow paint into the drain for a whole term - the caretaker knew exactly what it was and kept quiet for the fun of it.',
  },
];

const STORY_POINTS = [10, 6, 3];

export const guessTheStory = {
  meta: {
    id: 'guess-the-story',
    // Earlier clues are worth more, so a high total means a sharp deduction.
    record: { best: 'high', label: 'points' },
    name: 'Guess the Story',
    category: 'party',
    players: { min: 1, max: 12 },
    modes: ['solo', 'local', 'online'],
    simultaneous: true,
    blurb: 'A strange story is revealed one piece at a time. Guess what actually happened.',
    tags: ['party', 'deduction'],
    minutes: 10,
    status: 'playable',
    bots: true,
    maxBots: 8,
    rules: [
      'Each mystery has three clues, revealed one round at a time.',
      'Everyone picks the explanation they believe at the same time.',
      'Answering early pays more: 10, then 6, then 3 points.',
    ],
    options: [{ id: 'stories', label: 'Mysteries', type: 'select', values: [2, 3, 4], default: 3 }],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.stories = U.shuffle(STORIES, rng).slice(0, options.stories || 3);
    state.perStory = 3;
    state.maxRounds = state.stories.length * state.perStory;
    state.round = 1;
    state.answers = {};
    state.ready = [];
    state.phase = 'ask';
    state.revealed = null;
    state.played = [];
    loadStoryClue(state, rng);
    U.addLog(state, `Mystery 1, clue 1: ${state.question.clues[0]}`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.question = state.question;
    v.clueIndex = state.clueIndex;
    v.myAnswer = state.answers[viewerId] ?? null;
    v.answered = Object.keys(state.answers);
    v.readies = state.ready || [];
    v.revealed = state.revealed;
    v.turn = state.phase === 'ask' ? state.players.filter((p) => state.answers[p.id] === undefined).map((p) => p.id) : state.players.filter((p) => !(state.ready || []).includes(p.id)).map((p) => p.id);
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
      if (!choice) return { ok: false, error: 'Pick one of the explanations.' };
      state.answers[playerId] = choice.id;
      state.answerOrder.push(playerId);
      if (state.players.every((p) => state.answers[p.id] !== undefined)) {
        state.phase = 'reveal';
        resolveStory(state, events);
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
          state.summary = `${ranked[0].name} cracked the most mysteries (+${ranked[0].score})!`;
          events.push(U.event(state.summary, 'win'));
        } else {
          state.round++;
          loadStoryClue(state);
          events.push(U.event(`Clue ${state.clueIndex + 1}: ${state.question.clues[state.clueIndex]}`, 'info'));
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
      const chance = [0.25, 0.45, 0.7][state.clueIndex] * (0.5 + U.botSkill(level));
      const correct = state.question.options.find((o) => o.id === state.question.correctId);
      if (correct && Math.random() < chance) return { type: 'answer', choice: correct.id };
      return { type: 'answer', choice: U.pick(state.question.options.filter((o) => o.id !== state.question.correctId)).id };
    }
    if (state.phase === 'reveal' && !state.ready.includes(playerId)) return { type: 'next' };
    return null;
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send }) {
    const storyIndex = Math.floor((view.round - 1) / 3) + 1;
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Mystery ${storyIndex}/${view.maxRounds / 3}`),
      UI.pill(`Clue ${view.clueIndex + 1}/3`),
      UI.pill(`${view.answered.length}/${view.players.length} guessed`)));
    el.appendChild(UI.panel(`Clues so far`, UI.h('div', { class: 'story' },
      view.question.clues.slice(0, view.clueIndex + 1).map((clue, i) => UI.h('div', { class: 'story-line' }, UI.h('span', { class: 'story-n', text: `${i + 1}.` }), UI.h('span', { class: 'story-text', text: clue }))))));
    if (view.phase === 'ask') {
      el.appendChild(UI.promptCard(`Worth ${STORY_POINTS[view.clueIndex]} points - what really happened?`));
      el.appendChild(UI.h('div', { class: 'option-grid' },
        view.question.options.map((opt) => UI.h('button', { class: 'option', onClick: () => send({ type: 'answer', choice: opt.id }) }, UI.h('strong', { text: opt.text })))));
      el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.answered.includes(p.id) ? 'done' : ''}` }, `${p.name}${view.answered.includes(p.id) ? ' ✓' : ''}`))));
      return;
    }
    const answerText = view.question.options.find((o) => o.id === view.question.correctId)?.text || '';
    el.appendChild(UI.promptCard(`Answer: ${answerText}`, view.revealed?.reveal || null));
    el.appendChild(UI.scoreboard(view));
    el.appendChild(UI.btn(view.round >= view.maxRounds ? 'Finish' : 'Next clue', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
  },
};

function loadStoryClue(state, rng = Math.random) {
  const storyIndex = Math.floor((state.round - 1) / 3);
  const story = state.stories[storyIndex];
  const clueIndex = (state.round - 1) % 3;
  state.clueIndex = clueIndex;
  const options = U.shuffle(story.options.map((text, i) => ({ id: String.fromCharCode(97 + i), text })), rng);
  const correct = options.find((o) => o.text === story.options[story.answer]);
  state.answers = {};
  state.answerOrder = [];
  state.ready = [];
  state.revealed = null;
  state.phase = 'ask';
  state.question = {
    title: story.title,
    clues: story.clues,
    options,
    correctId: correct.id,
    reveal: clueIndex >= 2 ? story.reveal : null,
  };
}

function resolveStory(state, events) {
  const points = STORY_POINTS[state.clueIndex] ?? 3;
  const results = [];
  for (const [id, value] of Object.entries(state.answers)) {
    const correct = value === state.question.correctId;
    if (correct) {
      U.addScore(state, id, points);
      events.push(U.event(`${U.byId(state, id)?.name} worked it out (+${points}).`, 'win'));
    }
    results.push({ id, correct, points: correct ? points : 0 });
  }
  if (!results.some((r) => r.correct)) events.push(U.event('Nobody cracked it - the next clue might help.', 'warn'));
  state.revealed = { correctId: state.question.correctId, results, reveal: state.question.reveal };
}

/* ========================================================================= */

export default { hangman, guessTheStory };
