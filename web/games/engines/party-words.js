/**
 * Party & writing family.
 *
 * Ten games share one prompt-round engine:
 *   submit -> vote -> reveal -> (next round)
 * plus a "chain" mode used by the story games (each player adds to the previous
 * player's text, then it is passed along).  Bots submit and vote from canned
 * packs, so a two-player lobby still runs a full show - and the test harness
 * can play every game to completion headlessly.
 */
import * as U from './util.js';
import * as UI from './ui.js';

const MODES = ['local', 'online'];

/* ========================================================================= *
 * Content packs
 * ========================================================================= */

const QUIZLASH = [
  'A terrible name for a pirate ship', 'The worst thing to hear during surgery',
  'What the queen says when the wifi drops', 'A rejected slogan for a cereal brand',
  'The last thing a villain says before losing', 'Something you should never say at a wedding',
  'A terrible superpower for a superhero', 'The worst theme for a birthday party',
  'What your cat is actually thinking', 'A bad excuse for being late to work',
  'The next big fitness trend', 'A phrase that ruins any first date',
  'What aliens think humans do all day', 'The title of your autobiography',
  'The worst possible thing to win in a raffle', 'Something you would not want to hear from your GPS',
  'A terrible name for a restaurant', 'The new Olympic sport nobody asked for',
  'A completely useless warning label', 'What the moon is grumpy about',
  'A bad name for a rock band', 'The worst pizza topping',
  'Something a robot would say to sound human', 'The slogan for your imaginary country',
  'A terrible gift for a billionaire', 'What your phone would say if it could talk',
  'The most cursed sandwich', 'A bad fortune cookie message',
  'The worst name for a polite dragon', 'Something you should never shout in a library',
];

const HOT_TAKES = [
  'Cereal is a soup.', 'Pineapple belongs on everything.', 'Socks with sandals is peak fashion.',
  'Cinema snacks should be banned.', 'Breakfast food is an all-day food.', 'The snooze button is a trap.',
  'Winter is the best season.', 'Pizza should never be cut into triangles.', 'Tea beats coffee.',
  'Video game music is real music.', 'Cats are better teammates than dogs.', 'Homework should be optional.',
  'Maths class should teach taxes instead.', 'A hot dog is a sandwich.', 'Aliens are already here, being coy.',
  'Cartoons are not just for kids.', 'One long holiday beats many short ones.', 'Being 20 minutes early is rude.',
  'The book is always better than the film.', 'Dessert first is a valid life strategy.',
];

const FAKE_WORDS = [
  { word: 'grommet', real: 'a ring or eyelet used to reinforce a hole in fabric' },
  { word: 'borborygmus', real: 'the rumbling sound your stomach makes' },
  { word: 'tintinnabulation', real: 'the ringing sound of bells' },
  { word: 'defenestration', real: 'the act of throwing something out of a window' },
  { word: 'susurrus', real: 'a soft whispering or rustling sound' },
  { word: 'zugzwang', real: 'a chess position where any move makes things worse' },
  { word: 'petrichor', real: 'the earthy smell after rain' },
  { word: 'kerfuffle', real: 'a noisy commotion' },
  { word: 'widdershins', real: 'turning anticlockwise, against the sun' },
  { word: 'spaghettification', real: 'being stretched into a long thin shape by gravity' },
  { word: 'floccinaucinihilipilification', real: 'the habit of judging things as worthless' },
  { word: 'apophenia', real: 'seeing patterns in random data' },
  { word: 'numinous', real: 'having a strong spiritual or mysterious quality' },
  { word: 'quiddity', real: 'the basic nature of a thing' },
  { word: 'macaronic', real: 'mixing languages together in one text' },
  { word: 'velleity', real: 'a wish so weak you never act on it' },
];

const EMOJI_SEEDS = [
  'Your morning routine', 'How the group chat feels at 3am', 'The plot of your favourite film in five emojis or fewer',
  'How you felt during the last exam', 'The perfect holiday', 'Your cooking skills', 'What Monday does to you',
  'A very bad day at work', 'How the party ended', 'Buying something you did not need', 'Your gym progress',
  'Traffic on the way home', 'The weather this week', 'Your sleep schedule',
];

const STORY_SEEDS = [
  'The lighthouse keeper found a second key that fitted no known door.',
  'Nobody in the village remembered who built the statue, only that it changed colour on Tuesdays.',
  'The last train of the night stopped at a station that was not on any map.',
  'She traded her reflection for a map that only worked when it was raining.',
  'The robot gardener insisted the roses were plotting something.',
  'Every birthday since the accident, one extra chair appeared at the table.',
  'The town clock ticked backwards only when someone told the truth.',
  'He inherited a bookshop where the books argued with the customers.',
];

const STORY_TWISTS = [
  '...and then the gravity switched off.', '...but it turned out to be a training simulation.',
  '...and everyone suddenly spoke in rhyme.', '...until a very polite bear arrived.',
  '...then the lights went out for eleven years.', '...and the moon filed a complaint.',
  '...but they were a thousand tiny robots in a coat.', '...and time started running at half speed.',
  '...because someone had swapped the labels.', '...and the sea remembered everything.',
];

const VOTE_SUBMITS = [
  'I would like to formally apologise to that pigeon.', 'This is fine. Everything is fine.',
  'Instructions unclear, now I own a goat.', 'The vibes were immaculate but the plan was not.',
  'It was the best of times, it was the "who scheduled this" of times.',
  'I have made a decision and it is everyone else\'s problem now.',
  'Bold of you to assume I know what I am doing.', 'Somehow, this is all the microwave\'s fault.',
  'Ten out of ten, would panic again.', 'I am not lost, I am just early for somewhere else.',
  'The plan has evolved into a riddle.', 'Yes, and also no, but mostly "please stop asking".',
  'I brought snacks, therefore I am in charge.', 'Behold: my worst idea yet, lovingly maintained.',
  'Narrator: it did not, in fact, work out.', 'I am legally required to have one more go.',
];

const STORY_BOT_LINES = [
  'The corridor smelled faintly of birthday candles and regret.',
  'Nobody could explain why the sofa was now in orbit.',
  'A small dog officiated the whole thing with limited enthusiasm.',
  'The map disagreed with the mountain, and the mountain won.',
  'All seven of them said "hmm" in perfect unison.',
  'It began raining indoors, which everyone agreed was rude.',
  'The cat produced a receipt nobody remembered signing.',
  'Somewhere a kettle boiled with unmistakable menace.',
  'They decided to ask the neighbour, who was definitely a wizard.',
  'At that exact moment, the toast caught fire.',
];

/* ========================================================================= *
 * The prompt-round engine factory
 * ========================================================================= */

function uniqueFrom(list, used, rng) {
  const pool = list.filter((x) => !used.has(typeof x === 'string' ? x : x.word));
  const pick = pool.length ? U.pick(pool, rng) : U.pick(list, rng);
  used.add(typeof pick === 'string' ? pick : pick.word);
  return pick;
}

function tallyVotes(votes) {
  const tally = {};
  for (const target of Object.values(votes)) {
    if (!target) continue;
    tally[target] = (tally[target] || 0) + 1;
  }
  return tally;
}

/**
 * Build one prompt game.
 * config: { meta, kind: 'simultaneous'|'chain', prompts | promptFn, botLines,
 *           submitLabel, placeholder, votePrompt, rounds, chainLength }
 */
function promptGame(config) {
  const isChain = config.kind === 'chain';

  return {
    meta: {
      ...config.meta,
      players: config.meta.players || { min: 2, max: 14 },
      modes: MODES,
      simultaneous: !isChain,
      bots: true,
      maxBots: 8,
      rules: config.rules || [
        'Everyone writes their answer at the same time.',
        'Answers are shown anonymously - vote for your favourite.',
        'Most votes wins the round. Most points at the end wins the game.',
      ],
      options: [
        { id: 'rounds', label: 'Rounds', type: 'select', values: [2, 3, 5], default: 3 },
        { id: 'votePoints', label: 'Points per vote', type: 'select', values: [1, 3, 5], default: 3 },
      ],
    },

    create({ players, seed, rng = Math.random, options = {} }) {
      const state = U.baseState({ players, seed });
      state.kind = config.kind;
      state.useSeeds = !!config.useSeeds;
      state.round = 1;
      state.maxRounds = isChain ? 1 : (options.rounds || 3);
      state.votePoints = options.votePoints || 3;
      state.submissions = {};
      state.votes = {};
      state.readies = [];
      state.history = [];
      state.chain = [];
      state.usedPrompts = [];
      state.phase = isChain ? 'chain' : 'submit';
      state.chainTurns = isChain ? (config.chainLength || 1) * state.players.length : 0;
      state.chainIndex = 0;
      state.prompt = config.useSeeds ? seedFor(state, rng) : uniqueFrom(config.prompts, new Set(), rng);
      // Remaining prompts for later rounds, shuffled so no session repeats.
      state.pool = (config.prompts || []).filter((p) => p !== state.prompt);
      state.pool = U.shuffle(state.pool, rng).slice();
      state.entries = [];
      state.story = [];
      if (isChain) {
        state.prompt = uniqueFrom(config.prompts || STORY_SEEDS, new Set(), rng);
        state.turnId = state.players[0].id;
        U.addLog(state, `${state.players[0].name} starts the story.`);
      } else {
        U.addLog(state, `Round 1: ${promptText(state.prompt)}`);
      }
      state.botLineIndex = {};
      return state;
    },

    view(state, viewerId) {
      const v = U.baseView(state, viewerId);
      v.kind = state.kind;
      v.round = state.round;
      v.maxRounds = state.maxRounds;
      v.votePoints = state.votePoints;
      v.prompt = state.prompt;
      // Anonymous while voting: only ids and text travel to clients.
      v.entries = state.phase === 'vote' ? state.entries.map((e) => ({ id: e.id, text: e.text })) : state.entries;
      v.story = state.story;
      v.readies = state.readies;
      v.submitted = Object.keys(state.submissions);
      v.mySubmission = state.submissions[viewerId] ?? null;
      v.myVote = state.votes[viewerId] ?? null;
      v.votedCount = Object.keys(state.votes).length;
      v.chain = state.chain;
      v.history = state.history;
      v.tally = state.phase === 'reveal' ? tallyVotes(state.votes) : null;
      v.turn = [];
      if (state.phase === 'submit') v.turn = state.players.filter((p) => state.submissions[p.id] === undefined).map((p) => p.id);
      else if (state.phase === 'vote') v.turn = state.players.filter((p) => state.votes[p.id] === undefined).map((p) => p.id);
      else if (state.phase === 'reveal') v.turn = state.players.filter((p) => !state.readies.includes(p.id)).map((p) => p.id);
      else if (state.phase === 'chain') v.turn = [state.turnId];
      if (state.winnerId || state.draw) v.turn = [];
      v.myTurn = v.turn.includes(viewerId);
      return v;
    },

    act(state, playerId, action) {
      if (state.winnerId || state.draw) return { ok: false, error: 'Game over.' };
      const events = [];

      if (action.type === 'submit') {
        if (state.phase !== 'submit') return { ok: false, error: 'Submissions are closed.' };
        if (state.submissions[playerId] !== undefined) return { ok: false, error: 'You already answered.' };
        const text = cleanText(action.text, config.maxLength || 160, config.emojiOnly);
        if (!text) return { ok: false, error: config.emojiOnly ? 'Use at least one emoji.' : 'Write something first.' };
        state.submissions[playerId] = text;
        events.push(U.event(`${U.byId(state, playerId)?.name} answered.`, 'info'));
        if (state.players.every((p) => state.submissions[p.id] !== undefined)) startVote(state, events);
        for (const e of events) U.addLog(state, e.text, e.kind);
        return { ok: true, events };
      }

      if (action.type === 'vote') {
        if (state.phase !== 'vote') return { ok: false, error: 'Voting is closed.' };
        if (state.votes[playerId] !== undefined) return { ok: false, error: 'You already voted.' };
        const entry = state.entries.find((e) => e.id === action.target);
        if (!entry) return { ok: false, error: 'Pick an entry from the list.' };
        if (entry.author === playerId && !config.allowSelfVote) return { ok: false, error: 'No voting for yourself!' };
        state.votes[playerId] = action.target;
        events.push(U.event(`${U.byId(state, playerId)?.name} voted.`, 'info'));
        if (state.players.every((p) => state.votes[p.id] !== undefined)) revealRound(state, events);
        for (const e of events) U.addLog(state, e.text, e.kind);
        return { ok: true, events };
      }

      if (action.type === 'next') {
        if (state.phase !== 'reveal') return { ok: false, error: 'Nothing to advance.' };
        if (!state.readies.includes(playerId)) state.readies.push(playerId);
        if (state.players.every((p) => state.readies.includes(p.id))) {
          if (state.round >= state.maxRounds) {
            finish(state, events);
          } else {
            nextRound(state);
            events.push(U.event(`Round ${state.round}: ${promptText(state.prompt)}`, 'info'));
          }
        }
        for (const e of events) U.addLog(state, e.text, e.kind);
        return { ok: true, events };
      }

      if (action.type === 'story') {
        if (state.phase !== 'chain') return { ok: false, error: 'The story has finished.' };
        if (playerId !== state.turnId) return { ok: false, error: 'Not your turn to write.' };
        const limit = config.kind === 'chain' && config.wordOnly ? 20 : (config.lineLength || 220);
        const text = cleanText(action.text, limit, false, config.wordOnly);
        if (!text) return { ok: false, error: 'Write something first.' };
        state.story.push({ by: playerId, name: U.byId(state, playerId)?.name, text });
        state.chainIndex++;
        events.push(U.event(`${U.byId(state, playerId)?.name} wrote: "${U.truncate(text, 60)}"`, 'move'));
        if (state.chainIndex >= state.chainTurns) {
          state.phase = 'reveal';
          state.turnId = null;
          events.push(U.event('The story is finished - read it and weep.', 'win'));
        } else {
          const order = state.players.map((p) => p.id);
          state.turnId = order[state.chainIndex % order.length];
          if (config.twistEvery && state.chainIndex % (config.playersPerTwist || 1) === 0) {
            state.twist = U.pick(STORY_TWISTS);
            events.push(U.event(`PLOT TWIST: ${state.twist}`, 'warn'));
          }
        }
        for (const e of events) U.addLog(state, e.text, e.kind);
        return { ok: true, events };
      }

      return { ok: false, error: 'Unknown action.' };
    },

    bot(state, playerId) {
      if (state.phase === 'submit' && state.submissions[playerId] === undefined) {
        return { type: 'submit', text: botText(state, playerId, config) };
      }
      if (state.phase === 'vote' && state.votes[playerId] === undefined) {
        const options = state.entries.filter((e) => e.author !== playerId || config.allowSelfVote);
        if (!options.length) return null;
        const level = U.byId(state, playerId)?.level ?? 2;
        if (level >= 3) {
          // vote for the longest answer (a decent proxy for effort)
          const sorted = options.slice().sort((a, b) => b.text.length - a.text.length);
          const choice = Math.random() < 0.7 ? sorted[0] : U.pick(options);
          return { type: 'vote', target: choice.id };
        }
        return { type: 'vote', target: U.pick(options).id };
      }
      if (state.phase === 'reveal' && !state.readies.includes(playerId)) return { type: 'next' };
      if (state.phase === 'chain' && state.turnId === playerId) {
        return { type: 'story', text: chainBotText(state, config) };
      }
      return null;
    },

    over(state) {
      return U.simpleOver(state, { draw: !!state.draw });
    },

    render({ el, view, playerId, send, host }) {
      const ui = host?.uiState || (host ? (host.uiState = {}) : {});
      el.appendChild(UI.h('div', { class: 'phase-bar' },
        UI.pill(`Round ${view.round}/${view.maxRounds}`),
        UI.pill(view.phase === 'submit' ? 'Write' : view.phase === 'vote' ? 'Vote' : view.phase === 'chain' ? 'Story time' : 'Results'),
        view.phase === 'vote' ? UI.pill(`${Object.keys(view.votes || {}).length}/${view.players.length} voted`) : null,
      ));

      if (view.kind === 'chain') {
        renderChain({ el, view, playerId, send, ui, host, config });
        return;
      }

      if (view.phase === 'submit') {
        renderPrompt(view, config, el);
        if (view.mySubmission === null) {
          el.appendChild(UI.textareaRow(config.placeholder || 'Your answer...', (text) => send({ type: 'submit', text }), { submitLabel: config.submitLabel || 'Submit' }));
        } else {
          el.appendChild(UI.panel('Your answer', UI.h('div', { class: 'entry-text', text: view.mySubmission })));
        }
        el.appendChild(UI.h('div', { class: 'waiting-list' },
          view.players.map((p) => UI.h('span', { class: `chip ${view.submitted.includes(p.id) ? 'done' : ''}` }, `${p.avatar || ''} ${p.name}${view.submitted.includes(p.id) ? ' ✓' : ''}`))));
        return;
      }

      if (view.phase === 'vote' || view.phase === 'reveal') {
        const revealing = view.phase === 'reveal';
        el.appendChild(UI.promptCard(
          revealing ? `Results: ${promptText(view.prompt)}` : config.votePrompt || 'Vote for the best one!',
          revealing ? null : promptText(view.prompt),
        ));
        el.appendChild(UI.h('div', { class: 'entries' },
          view.entries.map((entry) => {
            const votes = view.tally?.[entry.id] || 0;
            const isMine = entry.author === playerId;
            return UI.h('div', { class: `entry ${revealing ? 'revealed' : ''} ${isMine ? 'mine' : ''} ${view.myVote === entry.id ? 'voted' : ''}` },
              host?.assetFor?.(entry) || null,
              UI.h('div', { class: 'entry-text', text: entry.text }),
              revealing ? UI.h('div', { class: 'entry-meta' }, UI.pill(entry.name), UI.pill(`${votes} vote${votes === 1 ? '' : 's'}`, votes ? 'good' : '')) : null,
              !revealing ? UI.btn(view.myVote === entry.id ? 'Voted' : 'Vote', () => send({ type: 'vote', target: entry.id }), { size: 'sm', disabled: view.myVote !== null || (isMine && !config.allowSelfVote) }) : null,
            );
          })));
        if (revealing) {
          el.appendChild(UI.scoreboard(view, { highlight: [] }));
          el.appendChild(UI.btn(view.round >= view.maxRounds ? 'Finish' : 'Next round', () => send({ type: 'next' }), { variant: 'primary', disabled: view.readies.includes(playerId) }));
        }
        return;
      }
    },
  };
}

function renderPrompt(view, config, el) {
  if (view.prompt && typeof view.prompt === 'object' && view.prompt.seed !== undefined) {
    const art = UI.canvasBox(520, 300, (ctx, w, h) => UI.paintScene(ctx, w, h, view.prompt.seed, { palette: view.prompt.palette, density: 20 }));
    el.appendChild(UI.h('div', { class: 'prompt-card art' }, art.el, UI.h('div', { class: 'prompt-sub', text: config.promptLabel || 'Caption this!' })));
    return;
  }
  el.appendChild(UI.promptCard(promptText(view.prompt), config.promptLabel || null));
}

function renderChain({ el, view, playerId, send, ui, host, config }) {
  if (view.phase === 'reveal') {
    el.appendChild(UI.h('h3', { class: 'game-title', text: config.title }));
    el.appendChild(UI.h('div', { class: 'story' }, view.story.map((line, i) =>
      UI.h('div', { class: 'story-line' }, UI.h('span', { class: 'story-n', text: `${i + 1}.` }), UI.h('span', { class: 'story-text', text: line.text }), UI.h('span', { class: 'story-by', text: line.name })))));
    el.appendChild(UI.row(UI.btn('Play again', () => send({ type: 'next' }), { variant: 'primary' })));
    return;
  }
  const last = view.story[view.story.length - 1];
  const me = view.turn.includes(playerId);
  el.appendChild(UI.promptCard(config.showFullStory ? config.seedLabel || 'Keep the story going' : 'You only see the previous line!',
    config.showFullStory ? null : 'Write a sentence that continues it - you will not see the rest.'));
  if (view.twist) el.appendChild(UI.h('div', { class: 'twist', text: `PLOT TWIST: ${view.twist}` }));
  if (config.showFullStory) {
    el.appendChild(UI.h('div', { class: 'story' }, view.story.map((line, i) =>
      UI.h('div', { class: 'story-line' }, UI.h('span', { class: 'story-n', text: `${i + 1}.` }), UI.h('span', { class: 'story-text', text: line.text }), UI.h('span', { class: 'story-by', text: line.name })))));
  } else if (last) {
    el.appendChild(UI.h('div', { class: 'story' }, UI.h('div', { class: 'story-line last' }, UI.h('span', { class: 'story-text', text: last.text }), UI.h('span', { class: 'story-by', text: `— ${last.name}` }))));
  } else {
    el.appendChild(UI.h('div', { class: 'story' }, UI.h('div', { class: 'story-line' }, UI.h('span', { class: 'story-text', text: promptText(view.prompt) }), UI.h('span', { class: 'story-by', text: '— the seed' }))));
  }
  if (me) {
    el.appendChild(UI.inputRow(config.wordOnly ? 'One word...' : 'Your sentence...', (text) => send({ type: 'story', text }), { submitLabel: 'Add' }));
  } else {
    el.appendChild(UI.spinnerRow(`${view.players.find((p) => p.id === view.turn[0])?.name || 'Someone'} is writing...`));
  }
  el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) =>
    UI.h('span', { class: `chip ${view.story.some((s) => s.by === p.id) ? 'done' : ''}` }, `${p.avatar || ''} ${p.name}`))));
  void host;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function promptText(prompt) {
  if (!prompt) return '';
  if (typeof prompt === 'string') return prompt;
  if (prompt.word) return `Invent a definition for: ${prompt.word.toUpperCase()}`;
  if (prompt.text) return prompt.text;
  return '';
}

function seedFor(state, rng) {
  const palette = U.pick(['neon', 'sunset', 'arcade', 'candy', 'forest', 'mono'], rng);
  return { seed: Math.floor(rng() * 1e9), palette };
}

function startVote(state, events) {
  state.entries = state.players
    .map((p, i) => ({ id: `e${i}`, author: p.id, name: p.name, text: state.submissions[p.id] }))
    .filter((e) => e.text)
    .sort(() => Math.random() - 0.5);
  state.phase = 'vote';
  state.votes = {};
  events.push(U.event('Answers are in - time to vote!', 'info'));
}

function revealRound(state, events) {
  const tally = tallyVotes(state.votes);
  for (const [id, count] of Object.entries(tally)) {
    const entry = state.entries.find((e) => e.id === id);
    if (!entry) continue;
    U.addScore(state, entry.author, count * state.votePoints);
  }
  state.phase = 'reveal';
  state.readies = [];
  state.history.push({
    prompt: promptText(state.prompt),
    entries: state.entries.map((e) => ({ ...e, votes: tally[e.id] || 0 })),
  });
  const best = state.entries.slice().sort((a, b) => (tally[b.id] || 0) - (tally[a.id] || 0))[0];
  if (best && tally[best.id]) events.push(U.event(`${best.name} wins the round with ${tally[best.id]} votes!`, 'win'));
  else events.push(U.event('Nobody voted - awkward.', 'info'));
}

function nextRound(state) {
  state.round++;
  state.phase = 'submit';
  state.submissions = {};
  state.votes = {};
  state.entries = [];
  state.readies = [];
  if (state.pool?.length) state.prompt = state.pool.shift();
  else if (state.useSeeds) state.prompt = { seed: Math.floor(Math.random() * 1e9), palette: U.pick(['neon', 'arcade', 'sunset', 'candy']) };
}

function finish(state, events) {
  const ranked = U.ranking(state);
  state.winnerId = ranked.filter((r) => r.score === ranked[0]?.score).map((r) => r.id);
  if (state.winnerId.length > 1) state.winnerId = state.winnerId.slice(0, 1);
  state.summary = `${U.byId(state, state.winnerId[0])?.name} wins with ${ranked[0]?.score} points!`;
  events.push(U.event(state.summary, 'win'));
}

function cleanText(text, max, emojiOnly, wordOnly) {
  let out = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (wordOnly) out = out.split(/\s+/)[0] || '';
  if (emojiOnly) {
    out = [...out].filter((ch) => /\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u200d\ufe0f]/u.test(ch)).join('');
  }
  return out.slice(0, max);
}

function botText(state, playerId, config) {
  const index = state.botLineIndex[playerId] || 0;
  state.botLineIndex[playerId] = index + 1;
  const lines = config.botLines || VOTE_SUBMITS;
  return lines[index % lines.length];
}

function chainBotText(state, config) {
  const lines = config.botLines || STORY_BOT_LINES;
  const seedKey = state.chainIndex % lines.length;
  const line = lines[seedKey];
  if (config.wordOnly) return line.split(' ')[0];
  return line;
}

/* ========================================================================= *
 * The ten games
 * ========================================================================= */

export const quiplash = promptGame({
  meta: {
    id: 'quiplash',
    name: 'Quiplash',
    icon: '💬',
    category: 'party',
    blurb: 'Everyone writes a punchline to the same prompt, then the room votes.',
    tags: ['party', 'writing'],
    minutes: 15,
    status: 'playable',
  },
  kind: 'simultaneous',
  prompts: QUIZLASH,
  botLines: VOTE_SUBMITS,
  placeholder: 'Your best punchline...',
  submitLabel: 'Lock it in',
  votePrompt: 'Which answer made you laugh?',
  maxLength: 140,
});

export const funnyAnswers = promptGame({
  meta: {
    id: 'funny-answers',
    name: 'Answer!',
    icon: '🤪',
    category: 'party',
    blurb: 'We ask something daft. You answer in the funniest way you can.',
    tags: ['party', 'writing'],
    minutes: 12,
    status: 'playable',
  },
  kind: 'simultaneous',
  prompts: [
    'What did the teacher whisper to the photocopier?',
    'Explain your internet search history like it is a nature documentary.',
    'A dragon knocks on your door. What does it want?',
    'Invent an excuse that would absolutely not work.',
    'What is the worst possible fortune to find in a cookie?',
    'Give a two-word review of the last week.',
    'What is your pet\'s secret job?',
    'The villain explains their plan. It is oddly relatable. What is it?',
    'Describe the sound of Monday in one phrase.',
    'What did the moon say to the tide?',
    'The new Olympic sport is... what?',
    'What is the last thing you should write in a group chat?',
  ],
  botLines: VOTE_SUBMITS,
  placeholder: 'Say something funny...',
  votePrompt: 'Which answer wins?',
  maxLength: 120,
});

export const captionBattle = promptGame({
  meta: {
    id: 'caption-battle',
    name: 'Caption Battle',
    icon: '📸',
    category: 'party',
    blurb: 'Same picture for everyone, anonymous captions, then the vote.',
    tags: ['party', 'memes'],
    minutes: 12,
    status: 'playable',
  },
  kind: 'simultaneous',
  useSeeds: true,
  prompts: [{}],
  botLines: [
    'This is the face of someone who peaked in a group project.',
    'Mum said it was my turn with the brain cell.',
    'Artist\'s impression of me pretending to understand the meeting.',
    'When the vibe check comes back negative.',
    'Me, arriving confidently to the wrong location.',
    'POV: you said "one more game" nine hours ago.',
    'That moment the WiFi knows you need it most.',
    'The look of a person who just deleted the file.',
  ],
  placeholder: 'Write a caption...',
  votePrompt: 'Best caption wins your vote:',
  promptLabel: 'Caption this scene!',
  maxLength: 140,
});

export const hotTake = promptGame({
  meta: {
    id: 'hot-take',
    name: 'Hot Take',
    icon: '🔥',
    category: 'party',
    blurb: 'Take a side on a ridiculous take, then defend it with one line.',
    tags: ['party', 'debate'],
    minutes: 10,
    status: 'playable',
    rules: [
      'A ridiculous opinion appears - write your most persuasive one-liner.',
      'Everyone votes for the take that made them laugh.',
      'Boldest defence wins the round.',
    ],
  },
  kind: 'simultaneous',
  prompts: HOT_TAKES.map((text) => ({ text })),
  botLines: [
    'I will die on this hill and the hill knows it.',
    'Historically, I am right and also louder.',
    'The data is just vibes, and the vibes agree with me.',
    'You are all wrong and I am passionate about it.',
    'I ran a survey of one very confident person.',
    'This is not an opinion, it is a prophecy.',
    'My lawyer advised me not to say more.',
    'I have prepared a 40-slide deck for this one sentence.',
  ],
  placeholder: 'Defend it in one line...',
  votePrompt: 'Whose take is the hottest?',
  maxLength: 150,
});

export const fakeDefinition = promptGame({
  meta: {
    id: 'fake-definition',
    name: 'Fake Definition',
    icon: '📚',
    category: 'party',
    blurb: 'Invent a definition convincing enough to fool the room.',
    tags: ['party', 'bluff'],
    minutes: 12,
    status: 'playable',
    rules: [
      'A real but obscure word appears.',
      'Everyone writes a fake definition.',
      'Votes decide who sounded the most convincing - the real meaning is shown at the end.',
    ],
  },
  kind: 'simultaneous',
  prompts: FAKE_WORDS.map((entry) => ({ word: entry.word, text: `Invent a definition for ${entry.word.toUpperCase()}` })),
  botLines: [
    'A small brass fitting used only by left-handed clockmakers.',
    'The official term for a horse clearing its throat politely.',
    'A unit of measurement for disappointing weather.',
    'Someone who claps when the plane lands, professionally.',
    'The noise a plastic chair makes in an empty hall.',
    'A polite way to describe a terrible plan.',
    'The practice of reading the last page first, guiltily.',
    'A tiny bread-based legal dispute.',
  ],
  placeholder: 'Your convincing definition...',
  votePrompt: 'Which definition sounds the most real?',
  maxLength: 160,
});

export const emojiStory = promptGame({
  meta: {
    id: 'emoji-story',
    name: 'Emoji Story',
    icon: '😂',
    category: 'party',
    blurb: 'Tell an entire story using nothing but emojis.',
    tags: ['party', 'quick'],
    minutes: 8,
    status: 'playable',
  },
  kind: 'simultaneous',
  prompts: EMOJI_SEEDS.map((text) => ({ text })),
  emojiOnly: true,
  botLines: ['🚀😬🌮🔥🎉', '🛌⏰😴🏃💨', '👀💬📱😅🤝', '🍕🍕🍕😌🛋️', '🐈📦🧶😼', '☕️😐📚😵', '🏖️☀️🍦😎🌅', '🧠💡✨🏆😄'],
  placeholder: 'Emojis only :)',
  votePrompt: 'Which emoji story is best?',
  promptLabel: 'Tell this as emojis:',
  maxLength: 60,
});

export const telephoneStory = promptGame({
  meta: {
    id: 'telephone-story',
    name: 'Telephone Story',
    icon: '☎️',
    category: 'party',
    players: { min: 3, max: 14 },
    blurb: 'One sentence each, passed along the chain. Nobody sees the whole story.',
    tags: ['party', 'writing'],
    minutes: 12,
    status: 'playable',
  },
  kind: 'chain',
  prompts: STORY_SEEDS,
  botLines: STORY_BOT_LINES,
  chainLength: 1,
  showFullStory: false,
  lineLength: 220,
});

export const storyBuilder = promptGame({
  meta: {
    id: 'story-builder',
    name: 'Story Builder',
    icon: '📖',
    category: 'party',
    players: { min: 2, max: 14 },
    blurb: 'Everyone adds one sentence to a shared story you can all see.',
    tags: ['party', 'writing'],
    minutes: 12,
    status: 'playable',
  },
  kind: 'chain',
  prompts: STORY_SEEDS,
  botLines: STORY_BOT_LINES,
  chainLength: 2,
  showFullStory: true,
  lineLength: 220,
});

export const oneWordStory = promptGame({
  meta: {
    id: 'one-word-story',
    name: 'One Word Story',
    icon: '🔤',
    category: 'party',
    players: { min: 2, max: 16 },
    blurb: 'Each player contributes exactly one word. Chaos ensues.',
    tags: ['party', 'quick'],
    minutes: 8,
    status: 'playable',
  },
  kind: 'chain',
  prompts: STORY_SEEDS,
  botLines: STORY_BOT_LINES,
  chainLength: 4,
  wordOnly: true,
  showFullStory: true,
});

export const plotTwist = promptGame({
  meta: {
    id: 'plot-twist',
    name: 'Plot Twist',
    icon: '🌀',
    category: 'party',
    players: { min: 2, max: 12 },
    blurb: 'Build a story where every round forces a random twist you must write in.',
    tags: ['party', 'writing'],
    minutes: 15,
    status: 'playable',
  },
  kind: 'chain',
  prompts: STORY_SEEDS,
  botLines: STORY_BOT_LINES,
  chainLength: 2,
  twistEvery: true,
  showFullStory: true,
  lineLength: 240,
});

/* Guess the Story lives in quiz.js - it is a multiple-choice reveal. */

export default {
  quiplash,
  funnyAnswers,
  captionBattle,
  hotTake,
  fakeDefinition,
  emojiStory,
  telephoneStory,
  storyBuilder,
  oneWordStory,
  plotTwist,
};
