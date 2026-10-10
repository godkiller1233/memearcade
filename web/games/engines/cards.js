/**
 * Card family: UNO, Go Fish (four deck themes) and 21/Blackjack.
 * Same engine contract as the board family - see board.js for the details.
 */
import * as U from './util.js';
import * as UI from './ui.js';
import * as Art from './art.js';

const MODES = ['solo', 'local', 'online'];
const COLORS = ['red', 'yellow', 'green', 'blue'];
const COLOR_HEX = { red: '#ef4444', yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', wild: '#7c3aed' };
const SYMBOL = { skip: '🚫', reverse: '⇄', draw2: '+2', wild: '🌈', wild4: '+4' };

/* ========================================================================= *
 * UNO
 * ========================================================================= */

function buildUnoDeck(rng) {
  const deck = [];
  let n = 0;
  for (const color of COLORS) {
    deck.push({ id: `c${n++}`, color, value: '0' });
    for (let v = 1; v <= 9; v++) {
      deck.push({ id: `c${n++}`, color, value: String(v) });
      deck.push({ id: `c${n++}`, color, value: String(v) });
    }
    for (const special of ['skip', 'reverse', 'draw2']) {
      deck.push({ id: `c${n++}`, color, value: special });
      deck.push({ id: `c${n++}`, color, value: special });
    }
  }
  for (let i = 0; i < 4; i++) deck.push({ id: `w${n++}`, color: 'wild', value: 'wild' });
  for (let i = 0; i < 4; i++) deck.push({ id: `w${n++}`, color: 'wild', value: 'wild4' });
  return U.shuffle(deck, rng);
}

function unoValueOf(card) {
  if (card.value === 'skip') return `${SYMBOL.skip}`;
  return SYMBOL[card.value] || card.value;
}

function canPlay(card, top, currentColor) {
  if (card.color === 'wild') return true;
  if (card.color === currentColor) return true;
  if (card.value === top.value) return true;
  return false;
}

export const uno = {
  meta: {
    id: 'uno',
    // A round won is a point banked.
    record: { best: 'high', label: 'rounds won' },
    name: 'UNO',
    category: 'cards',
    players: { min: 2, max: 10 },
    modes: MODES,
    secret: true,
    blurb: 'Match colour or number. Wilds, skips, reverses, +2 and the dreaded +4.',
    tags: ['cards', 'party'],
    minutes: 15,
    status: 'playable',
    bots: true,
    maxBots: 4,
    turnMs: 60000,
    rules: [
      'Play a card matching the colour or value of the discard pile.',
      'No playable card? Draw one - and play it if it fits.',
      'Skip and Reverse bend the turn order; +2 and +4 punish the next player.',
      'First player to empty their hand wins the round.',
    ],
    options: [
      { id: 'handSize', label: 'Starting hand', type: 'select', values: [5, 7, 10], default: 7 },
      { id: 'stacking', label: 'Stack draw cards', type: 'toggle', default: true },
    ],
  },
  create({ players, seed, rng, options = {} }) {
    const state = U.baseState({ players, seed });
    const deck = buildUnoDeck(rng);
    state.handSize = options.handSize || 7;
    state.stacking = options.stacking !== false;
    state.hands = {};
    for (const p of state.players) state.hands[p.id] = deck.splice(0, state.handSize);
    state.pile = deck; // draw pile (never call this `draw`: that name is a result flag)
    state.discard = [];
    state.pendingDraw = 0;
    state.direction = 1;
    // first non-wild card as the starter
    let starter = deck.shift();
    while (starter.color === 'wild' && deck.length) {
      deck.push(starter);
      starter = deck.shift();
    }
    state.discard.push(starter);
    state.currentColor = starter.color;
    state.turnId = state.players[0].id;
    U.addLog(state, `Starting card: ${unoValueOf(starter)} ${starter.color}.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.hand = state.hands[viewerId] || [];
    v.counts = Object.fromEntries(state.players.map((p) => [p.id, state.hands[p.id]?.length || 0]));
    v.top = state.discard[state.discard.length - 1];
    v.currentColor = state.currentColor;
    v.direction = state.direction;
    v.pendingDraw = state.pendingDraw;
    v.deckCount = state.pile.length;
    v.playable = (state.hands[viewerId] || []).filter((c) => canPlay(c, v.top, state.currentColor)).map((c) => c.id);
    v.turn = state.winnerId ? [] : [state.turnId];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Round over.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
    const top = state.discard[state.discard.length - 1];
    const hand = state.hands[playerId];

    if (action.type === 'draw') {
      if (state.pendingDraw > 0) {
        const cards = [];
        for (let i = 0; i < state.pendingDraw; i++) cards.push(drawCard(state));
        hand.push(...cards);
        const total = state.pendingDraw;
        state.pendingDraw = 0;
        U.addLog(state, `${U.byId(state, playerId)?.name} drew ${total}.`, 'info');
        advance(state, 1);
        return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} drew ${total} cards.`, 'move')] };
      }
      const card = drawCard(state);
      hand.push(card);
      state.hasDrawn = playerId;
      const playable = canPlay(card, top, state.currentColor);
      U.addLog(state, `${U.byId(state, playerId)?.name} drew a card.`, 'info');
      return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} drew a card${playable ? ' and may play it' : ''}.`, 'move')] };
    }

    if (action.type === 'pass') {
      if (state.hasDrawn !== playerId) return { ok: false, error: 'Draw a card first.' };
      state.hasDrawn = null;
      advance(state, 1);
      return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} passed.`, 'info')] };
    }

    if (action.type !== 'play') return { ok: false, error: 'Unknown move.' };
    const card = hand.find((c) => c.id === action.card);
    if (!card) return { ok: false, error: 'That card is not in your hand.' };
    if (state.pendingDraw > 0 && !(state.stacking && (card.value === 'draw2' || card.value === 'wild4'))) {
      return { ok: false, error: `You must respond to the +${state.pendingDraw} (draw or stack).` };
    }
    if (!canPlay(card, top, state.currentColor)) return { ok: false, error: 'That card does not match.' };
    if (card.color === 'wild') {
      const chosen = COLORS.includes(action.color) ? action.color : pickBestColor(hand);
      card.chosen = chosen;
    }

    hand.splice(hand.indexOf(card), 1);
    state.discard.push(card);
    state.currentColor = card.color === 'wild' ? card.chosen : card.color;
    state.hasDrawn = null;
    const events = [U.event(`${U.byId(state, playerId)?.name} played ${unoValueOf(card)}${card.color === 'wild' ? ` → ${card.chosen}` : ` (${card.color})`}.`, 'move')];

    if (hand.length === 0) {
      state.winnerId = playerId;
      state.summary = `${U.byId(state, playerId)?.name} emptied their hand and wins!`;
      U.addScore(state, playerId, 1);
      events.push(U.event(state.summary, 'win'));
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (hand.length === 1) events.push(U.event(`${U.byId(state, playerId)?.name} shouts UNO!`, 'info'));

    switch (card.value) {
      case 'skip':
        events.push(U.event('Next player is skipped.', 'info'));
        advance(state, 2);
        break;
      case 'reverse':
        state.direction *= -1;
        events.push(U.event('Turn order reversed.', 'info'));
        advance(state, 1);
        break;
      case 'draw2':
        state.pendingDraw += 2;
        advance(state, 1);
        events.push(U.event(`+2 is waiting - draw or stack.`, 'info'));
        break;
      case 'wild4':
        state.pendingDraw += 4;
        advance(state, 1);
        events.push(U.event(`+4 is waiting - draw or stack.`, 'info'));
        break;
      default:
        advance(state, 1);
    }
    for (const e of events) U.addLog(state, e.text, e.kind);
    return { ok: true, events };
  },
  bot(state, playerId) {
    if (playerId !== state.turnId) return null;
    const hand = state.hands[playerId] || [];
    const top = state.discard[state.discard.length - 1];
    const level = U.byId(state, playerId)?.level ?? 2;
    const legal = hand.filter((c) => canPlay(c, top, state.currentColor));
    if (state.pendingDraw > 0) {
      const stackable = legal.filter((c) => c.value === 'draw2' || c.value === 'wild4');
      if (state.stacking && stackable.length && level >= 2) {
        const card = stackable[0];
        return { type: 'play', card: card.id, color: card.color === 'wild' ? pickBestColor(hand) : undefined };
      }
      return { type: 'draw' };
    }
    if (!legal.length) return state.hasDrawn === playerId ? { type: 'pass' } : { type: 'draw' };
    if (state.hasDrawn === playerId) {
      const drawn = legal[legal.length - 1];
      return level >= 3 ? { type: 'play', card: drawn.id, color: drawn.color === 'wild' ? pickBestColor(hand) : undefined } : { type: 'pass' };
    }
    // prefer numbers/specials in our strongest colour, keep wilds for emergencies
    const scored = legal.map((card) => {
      let s = card.color === state.currentColor ? 3 : 1;
      if (card.value === 'draw2' || card.value === 'skip' || card.value === 'reverse') s += 4;
      if (card.value === 'wild' || card.value === 'wild4') s -= 6;
      const sameColor = hand.filter((c) => c.color === card.color).length;
      s += sameColor * 0.6;
      if (hand.length <= 2) s += 6;
      return { card, s };
    });
    scored.sort((a, b) => b.s - a.s);
    const choice = level <= 1 ? U.pick(legal) : scored[0].card;
    return { type: 'play', card: choice.id, color: choice.color === 'wild' ? pickBestColor(hand) : undefined };
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send, host }) {
    const ui = host?.uiState || (host ? (host.uiState = {}) : {});
    const myTurn = view.turn.includes(playerId);
    el.appendChild(UI.turnBanner(view));
    // The table and the hand are one scene, so they share one felt stage: the
    // pile in the middle of it and your cards laid out on the same cloth.
    el.appendChild(Art.boardStage('uno', { width: 940, height: 560 },
      UI.h('div', { class: 'uno-table' },
        UI.h('div', { class: 'uno-pile' },
          UI.h('div', { class: `uno-card back`, text: view.deckCount }),
          UI.h('div', {
            class: `uno-card big ${view.top.color === 'wild' ? 'wild' : view.top.color}`,
            style: ui.pendingColor && view.top.color === 'wild' ? { background: COLOR_HEX[view.currentColor] } : null,
            text: unoValueOf(view.top),
          }),
        ),
        UI.h('div', { class: 'uno-meta' },
          UI.pill(`Colour: ${view.currentColor}`, view.currentColor),
          UI.pill(view.direction === 1 ? 'Clockwise' : 'Counter-clockwise'),
          view.pendingDraw ? UI.pill(`+${view.pendingDraw} pending`, 'warn') : null,
        ),
      ),
      UI.h('div', { class: 'uno-hand' },
        view.hand.map((card) =>
          UI.h('button', {
            class: `uno-card ${card.color === 'wild' ? 'wild' : card.color} ${view.playable.includes(card.id) ? 'playable' : ''}`,
            disabled: !myTurn,
            onClick: () => {
              if (card.color === 'wild') {
                ui.picking = card.id;
                host?.refresh?.();
              } else send({ type: 'play', card: card.id });
            },
          }, unoValueOf(card)),
        ))));
    if (ui.picking) {
      el.appendChild(UI.h('div', { class: 'colour-picker' },
        UI.muted('Pick a colour:'),
        ...COLORS.map((c) => UI.btn(c, () => {
          send({ type: 'play', card: ui.picking, color: c });
          ui.picking = null;
          host?.refresh?.();
        }, { className: `swatch-btn ${c}` })),
      ));
    }
    if (myTurn) {
      el.appendChild(UI.row(
        UI.btn('Draw a card', () => send({ type: 'draw' }), { size: 'sm' }),
        view.hand.length && view.playable.length === 0 ? UI.btn('Pass', () => send({ type: 'pass' }), { size: 'sm' }) : null,
      ));
      if (view.pendingDraw) el.appendChild(UI.muted(`You owe ${view.pendingDraw} cards - draw them, or stack a +2/+4.`));
    }
    el.appendChild(UI.scoreboard(view, { showRank: false, unit: ' cards' }));
  },
};

function pickBestColor(hand) {
  const tally = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand) if (c.color !== 'wild') tally[c.color] += 1;
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
}

function drawCard(state) {
  if (!state.pile.length) {
    const top = state.discard.pop();
    const rest = state.discard.splice(0, state.discard.length);
    for (const card of rest) {
      if (card.color === 'wild') delete card.chosen;
      state.pile.push(card);
    }
    state.pile = U.shuffle(state.pile, Math.random);
    state.discard = [top];
    U.addLog(state, 'Discard pile reshuffled.', 'info');
  }
  return state.pile.shift() || { id: `x${Math.random()}`, color: 'wild', value: 'wild' };
}

function advance(state, steps) {
  const order = state.players.map((p) => p.id);
  const dir = state.direction || 1;
  let i = order.indexOf(state.turnId);
  for (let s = 0; s < Math.abs(steps); s++) i = (i + dir + order.length) % order.length;
  state.turnId = order[i];
  state.turnCount = (state.turnCount || 0) + 1;
}

/* ========================================================================= *
 * Go Fish (classic / anime / drawn / humans decks)
 * ========================================================================= */

const ANIME_RANKS = ['Luffy', 'Naruto', 'Goku', 'Rimuru', 'Light', 'Levi', 'Tanjiro', 'Saitama', 'Sailor Moon', 'Ichigo', 'Eren', 'Gojo', 'Asuka'];
const CLASSIC_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const DRAWN_RANKS = ['Blob', 'Wobble', 'Sprout', 'Cactus', 'Crown', 'Ghostie', 'Mushroom', 'Robot', 'Rocket', 'Star', 'Teacup', 'Cloud', 'Sock'];

export const goFish = {
  meta: {
    id: 'go-fish',
    // Books collected across the match.
    record: { best: 'high', label: 'books' },
    name: 'Go Fish',
    category: 'cards',
    players: { min: 2, max: 8 },
    modes: MODES,
    secret: true,
    blurb: 'Ask for cards, collect books. Four deck themes including your own party avatars.',
    tags: ['cards', 'chill'],
    minutes: 10,
    status: 'playable',
    bots: true,
    maxBots: 4,
    turnMs: 90000,
    rules: [
      'Ask one player for a card rank you already hold.',
      'If they have it, you receive every matching card and ask again.',
      'If they do not, they say "Go fish" and you draw from the pond.',
      'Collect all four of a rank to make a book. Most books wins.',
    ],
    options: [
      { id: 'deck', label: 'Deck theme', type: 'select', values: ['classic', 'anime', 'drawn', 'humans'], default: 'classic' },
      { id: 'books', label: 'Winning books', type: 'select', values: [3, 5, 7], default: 5 },
    ],
  },
  create({ players, seed, rng, options = {} }) {
    const state = U.baseState({ players, seed });
    const theme = ['classic', 'anime', 'drawn', 'humans'].includes(options.deck) ? options.deck : 'classic';
    state.theme = theme;
    state.ranks = theme === 'anime' ? ANIME_RANKS : theme === 'drawn' ? DRAWN_RANKS : CLASSIC_RANKS;
    if (theme === 'humans') {
      state.ranks = [...state.players.map((p) => p.name), 'Spectator', 'Referee', 'Cameraman'].slice(0, 13);
      while (state.ranks.length < 13) state.ranks.push(`Fan ${state.ranks.length}`);
    }
    const deck = [];
    for (const rank of state.ranks) for (let i = 0; i < 4; i++) deck.push({ id: `${rank}-${i}-${Math.random().toString(36).slice(2, 6)}`, rank });
    state.pond = U.shuffle(deck, rng);
    state.hands = {};
    for (const p of state.players) state.hands[p.id] = [];
    const perPlayer = U.clamp(Math.floor(state.pond.length / state.players.length) - 1, 4, 8);
    for (let i = 0; i < perPlayer; i++) for (const p of state.players) state.hands[p.id].push(state.pond.pop());
    state.books = {};
    for (const p of state.players) state.books[p.id] = 0;
    state.bookList = {};
    for (const p of state.players) state.bookList[p.id] = [];
    state.booksToWin = options.books || 5;
    state.denied = {}; // "asker|target" -> ranks that target said no to
    state.idleTurns = 0;
    state.turnId = state.players[0].id;
    U.addLog(state, `Deck theme: ${theme}. ${state.players[0].name} starts.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.hand = groupByRank(state.hands[viewerId] || []);
    v.ranksInHand = [...new Set((state.hands[viewerId] || []).map((c) => c.rank))];
    v.counts = Object.fromEntries(state.players.map((p) => [p.id, state.hands[p.id].length]));
    v.books = state.books;
    v.bookList = state.bookList;
    v.pondCount = state.pond.length;
    v.booksToWin = state.booksToWin;
    v.theme = state.theme;
    v.lastAsk = state.lastAsk || null;
    v.turn = state.winnerId ? [] : [state.turnId];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
    const hand = state.hands[playerId];
    if (action.type === 'ask') {
      const target = state.players.find((p) => p.id === action.target);
      if (!target || target.id === playerId) return { ok: false, error: 'Pick another player.' };
      const rank = String(action.rank || '');
      if (!hand.some((c) => c.rank === rank)) return { ok: false, error: 'You can only ask for ranks you hold.' };
      const stolen = state.hands[target.id].filter((c) => c.rank === rank);
      state.lastAsk = { from: playerId, to: target.id, rank, got: stolen.length };
      const events = [];
      if (stolen.length) {
        state.hands[target.id] = state.hands[target.id].filter((c) => c.rank !== rank);
        hand.push(...stolen);
        state.idleTurns = 0;
        events.push(U.event(`${U.byId(state, playerId)?.name} took ${stolen.length} × ${rank} from ${target.name}.`, 'move'));
        const book = maybeBook(state, playerId, rank, events);
        if (state.winnerId) return { ok: true, events };
        if (!book) state.turnId = playerId; // keep asking
        else if (!state.hands[playerId].length) {
          // we booked our last cards - hand the turn over instead of hanging
          advanceFish(state);
          events.push(U.event(`${U.byId(state, playerId)?.name} has no cards left and passes.`, 'info'));
        }
      } else {
        const key = `${playerId}|${target.id}`;
        state.denied[key] = [...new Set([...(state.denied[key] || []), rank])];
        events.push(U.event(`${U.byId(state, playerId)?.name} asked ${target.name} for ${rank} - Go fish!`, 'miss'));
        const card = state.pond.pop();
        if (card) {
          hand.push(card);
          state.idleTurns = 0;
          maybeBook(state, playerId, card.rank, events);
          if (card.rank === rank) {
            events.push(U.event(`Fished a ${rank} - lucky, ask again!`, 'win'));
            state.turnId = playerId;
          } else {
            advanceFish(state);
          }
        } else {
          state.idleTurns = (state.idleTurns || 0) + 1;
          events.push(U.event('The pond is empty.', 'info'));
          advanceFish(state);
        }
      }
      checkFishEnd(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'auto') {
      if (!state.pond.length) {
        advanceFish(state);
        return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} has no cards and the pond is empty - pass.`, 'info')] };
      }
      const cards = state.pond.splice(0, Math.min(5, state.pond.length));
      hand.push(...cards);
      if (state.pond.length === 0) state.idleTurns = 0;
      return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} drew ${cards.length} from the pond.`, 'info')] };
    }
    if (action.type === 'pass') {
      advanceFish(state);
      return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} passes.`, 'info')] };
    }
    return { ok: false, error: 'Unknown move.' };
  },
  bot(state, playerId) {
    if (playerId !== state.turnId) return null;
    const hand = state.hands[playerId] || [];
    if (!hand.length) return state.pond.length ? { type: 'auto' } : { type: 'pass' };
    const counts = {};
    for (const c of hand) counts[c.rank] = (counts[c.rank] || 0) + 1;
    const myRanks = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([rank]) => rank);
    const foes = state.players.filter((p) => p.id !== playerId && state.hands[p.id].length);
    if (!foes.length) return null;
    // Ask someone who has cards and has not denied this rank already; when the
    // pond is dry this is what keeps the table moving towards a finish.
    const options = [];
    for (const foe of foes) {
      const denied = state.denied?.[`${playerId}|${foe.id}`] || [];
      for (const rank of myRanks) {
        if (denied.includes(rank)) continue;
        options.push({ target: foe.id, rank, weight: state.hands[foe.id].length + counts[rank] * 0.2 + Math.random() },);
      }
    }
    if (!options.length) {
      const foe = U.pick(foes);
      return { type: 'ask', target: foe.id, rank: U.pick(myRanks) };
    }
    options.sort((a, b) => b.weight - a.weight);
    const lvl = U.byId(state, playerId)?.level ?? 2;
    const pick = lvl <= 1 ? U.pick(options) : options[0];
    return { type: 'ask', target: pick.target, rank: pick.rank };
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send, host }) {
    const ui = host?.uiState || (host ? (host.uiState = {}) : {});
    const myTurn = view.turn.includes(playerId);
    el.appendChild(UI.turnBanner(view));
    el.appendChild(Art.boardStage('go-fish', { width: 900, height: 460 },
      UI.h('div', { class: 'fish-row' },
        UI.panel('Your hand', UI.h('div', { class: 'fish-hand' },
          Object.entries(view.hand).map(([rank, n]) =>
            UI.h('button', {
              class: `fish-card ${ui.pickRank === rank ? 'on' : ''}`,
              disabled: !myTurn,
              onClick: () => {
                ui.pickRank = rank;
                host?.refresh?.();
              },
            }, UI.h('strong', { text: rank }), UI.h('span', { class: 'count', text: `×${n}` }))),
        )),
        UI.panel('Pond', UI.h('div', { class: 'pond' }, UI.h('div', { class: 'fish-card back', text: `${view.pondCount}` }))),
      )));
    const others = view.players.filter((p) => p.id !== playerId);
    el.appendChild(UI.h('div', { class: 'ask-targets' },
      UI.muted('Ask:'),
      ...others.map((p) =>
        UI.btn(`${p.avatar || ''} ${p.name} (${view.counts[p.id]})`, () => {
          if (!ui.pickRank) return;
          send({ type: 'ask', target: p.id, rank: ui.pickRank });
          ui.pickRank = null;
          host?.refresh?.();
        }, { size: 'sm', disabled: !myTurn || !ui.pickRank })),
    ));
    el.appendChild(UI.h('div', { class: 'books' }, ...view.players.map((p) =>
      UI.pill(`${p.name}: ${view.books[p.id] || 0} books${view.bookList[p.id]?.length ? ` (${view.bookList[p.id].join(', ')})` : ''}`, view.books[p.id] ? 'good' : ''))));
    if (view.lastAsk) {
      el.appendChild(UI.muted(`${view.lastAsk.from === playerId ? 'You' : 'They'} asked for ${view.lastAsk.rank} - ${view.lastAsk.got ? 'got it!' : 'go fish'}`));
    }
    el.appendChild(UI.h('div', { class: 'fish-hand mine' }, view.ranksInHand.length ? [] : []));
  },
};

function groupByRank(cards) {
  const out = {};
  for (const c of cards) out[c.rank] = (out[c.rank] || 0) + 1;
  return out;
}

function maybeBook(state, playerId, rank, events) {
  const matching = state.hands[playerId].filter((c) => c.rank === rank);
  if (matching.length < 4) return false;
  state.hands[playerId] = state.hands[playerId].filter((c) => c.rank !== rank);
  state.books[playerId] = (state.books[playerId] || 0) + 1;
  state.bookList[playerId].push(rank);
  events.push(U.event(`${U.byId(state, playerId)?.name} completed a book of ${rank}!`, 'win'));
  if (state.books[playerId] >= state.booksToWin) {
    state.winnerId = playerId;
    state.summary = `${U.byId(state, playerId)?.name} reached ${state.booksToWin} books!`;
    U.addScore(state, playerId, 1);
    events.push(U.event(state.summary, 'win'));
  }
  return true;
}

function advanceFish(state) {
  const order = state.players.map((p) => p.id);
  let i = order.indexOf(state.turnId);
  for (let s = 0; s < order.length; s++) {
    i = (i + 1) % order.length;
    if (state.hands[order[i]].length) break;
  }
  state.turnId = order[i];
  state.turnCount = (state.turnCount || 0) + 1;
}

function checkFishEnd(state, events) {
  if (state.winnerId) return;    const pondEmpty = state.pond.length === 0;
    const handsEmpty = state.players.every((p) => state.hands[p.id].length === 0);
    const allBooks = state.players.reduce((n, p) => n + (state.books[p.id] || 0), 0) >= state.ranks.length;
    // Nobody can ask anyone for anything any more -> the table is dead.
    const deadlock = pondEmpty && state.players.every((p) =>
      !state.players.some((o) => o.id !== p.id && state.hands[o.id].some((c) => state.hands[p.id].some((x) => x.rank === c.rank))));
    // Dry pond with no successful trades for a full pass around the table: stop.
    const stalled = pondEmpty && (state.idleTurns || 0) >= state.players.length * 3;
    if (handsEmpty || allBooks || deadlock || stalled) {
      const maxBooks = Math.max(...Object.values(state.books));
      const best = state.players.filter((p) => state.books[p.id] === maxBooks).map((p) => p.id);
    state.winnerId = best.length === 1 ? best[0] : null;
    state.draw = best.length !== 1;
    state.summary = best.length === 1 ? `${U.byId(state, best[0])?.name} wins with ${maxBooks} books!` : 'Tie - shared books.';
    for (const id of best) U.addScore(state, id, maxBooks);
    events.push(U.event(state.summary, 'win'));
  }
}

/* ========================================================================= *
 * Blackjack / 21
 * ========================================================================= */

export const blackjack = {
  meta: {
    id: 'blackjack',
    // The bankroll you closed the table with.
    record: { best: 'high', label: 'chips' },
    name: '21 / Blackjack',
    category: 'cards',
    players: { min: 1, max: 7 },
    modes: MODES,
    simultaneous: true,
    blurb: 'Hit, stand or double. Closest to 21 without busting beats the dealer.',
    tags: ['cards', 'quick'],
    minutes: 5,
    status: 'playable',
    bots: true,
    maxBots: 5,
    rules: [
      'Get closer to 21 than the dealer without going over.',
      'Number cards are face value, face cards are 10, aces are 1 or 11.',
      'Double doubles your bet but gives exactly one more card.',
      'Dealer draws to 17 and stands. Blackjack pays 3:2.',
    ],
    options: [
      { id: 'rounds', label: 'Rounds', type: 'select', values: [3, 5, 10], default: 5 },
      { id: 'bankroll', label: 'Starting bankroll', type: 'select', values: [200, 500, 1000], default: 500 },
    ],
  },
  create({ players, seed, rng, options = {} }) {
    const state = U.baseState({ players, seed });
    state.deck = makeShoe(6, rng);
    state.rounds = options.rounds || 5;
    state.round = 1;
    state.bank = {};
    state.bets = {};
    for (const p of state.players) state.bank[p.id] = options.bankroll || 500;
    state.dealer = [];
    state.hands = {};
    state.status = {};
    state.results = {};
    state.handLog = [];
    dealRound(state, rng);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.hand = state.hands[viewerId] || [];
    v.total = handTotal(v.hand);
    v.dealer = state.dealer.map((c, i) => (i === 0 && !state.dealerRevealed ? { hidden: true } : c));
    v.dealerTotal = state.dealerRevealed ? handTotal(state.dealer) : handTotal(state.dealer.slice(1));
    v.dealerRevealed = !!state.dealerRevealed;
    v.bank = state.bank;
    v.bets = state.bets;
    v.status = state.status;
    v.results = state.results;
    v.round = state.round;
    v.rounds = state.rounds;
    v.counts = Object.fromEntries(state.players.map((p) => [p.id, (state.hands[p.id] || []).length]));
    v.handLog = state.handLog.slice(-10);
    v.turn = state.phase === 'betting' ? state.players.filter((p) => !state.status[p.id]?.done).map((p) => p.id) : [];
    return v;
  },
  act(state, playerId, action) {
    const myStatus = state.status[playerId];
    if (!myStatus || myStatus.done) return { ok: false, error: 'You already finished this hand.' };
    const hand = state.hands[playerId];
    const events = [];
    switch (action.type) {
      case 'hit': {
        hand.push(state.deck.pop());
        const total = handTotal(hand);
        events.push(U.event(`${U.byId(state, playerId)?.name} hits (${total}).`, 'move'));
        if (total > 21) {
          myStatus.done = true;
          myStatus.result = 'bust';
          events.push(U.event(`${U.byId(state, playerId)?.name} busts with ${total}!`, 'miss'));
        } else if (total === 21) {
          myStatus.done = true;
          myStatus.result = 'stand';
        }
        break;
      }
      case 'stand':
        myStatus.done = true;
        myStatus.result = 'stand';
        events.push(U.event(`${U.byId(state, playerId)?.name} stands on ${handTotal(hand)}.`, 'move'));
        break;
      case 'double': {
        if (hand.length !== 2) return { ok: false, error: 'Double only on the first two cards.' };
        if (state.bank[playerId] < state.bets[playerId]) return { ok: false, error: 'Not enough chips to double.' };
        state.bank[playerId] -= state.bets[playerId];
        state.bets[playerId] *= 2;
        hand.push(state.deck.pop());
        myStatus.done = true;
        myStatus.result = handTotal(hand) > 21 ? 'bust' : 'stand';
        myStatus.doubled = true;
        events.push(U.event(`${U.byId(state, playerId)?.name} doubles down for ${state.bets[playerId]}.`, 'win'));
        break;
      }
      default:
        return { ok: false, error: 'Unknown action.' };
    }
    for (const e of events) U.addLog(state, e.text, e.kind);
    settleIfDone(state, events);
    return { ok: true, events };
  },
  bot(state, playerId) {
    const myStatus = state.status[playerId];
    if (!myStatus || myStatus.done) return null;
    const hand = state.hands[playerId];
    const total = handTotal(hand);
    const level = U.byId(state, playerId)?.level ?? 2;
    const dealerUp = cardValue(state.dealer[1] || { value: '10' });
    const risky = dealerUp >= 7;
    const target = risky ? 17 : 14;
    if (hand.length === 2 && level >= 3 && state.bank[playerId] >= state.bets[playerId] * 2 && (total === 10 || total === 11)) {
      return { type: 'double' };
    }
    if (total < target) return { type: 'hit' };
    if (total === target && level <= 1) return { type: 'hit' };
    return { type: 'stand' };
  },
  over(state) {
    if (state.phase === 'done') {
      const ranked = state.players.map((p) => ({ id: p.id, score: state.bank[p.id] || 0 }));
      ranked.sort((a, b) => b.score - a.score);
      return { over: true, winners: ranked.filter((r) => r.score === ranked[0].score).map((r) => r.id), scores: Object.fromEntries(ranked.map((r) => [r.id, r.score])), summary: 'Table closed' };
    }
    return { over: false };
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.turnBanner(view, { label: view.dealerRevealed ? `Dealer ${view.dealerTotal}` : `Round ${view.round}/${view.rounds} - dealer shows ${cardLabel(view.dealer[1])}` }));
    el.appendChild(Art.boardStage('blackjack', { width: 900, height: 420 },
      UI.h('div', { class: 'table-row' },
        UI.panel('Dealer', UI.h('div', { class: 'hand' }, view.dealer.map((c) => cardEl(c, true)))),
        UI.panel('You', UI.h('div', { class: 'hand' }, view.hand.map((c) => cardEl(c, false))), UI.h('div', { class: 'hand-total' }, `Total: ${view.total}${view.status[playerId]?.result ? ` (${view.status[playerId].result})` : ''}`)),
      )));
    if (view.turn.includes(playerId)) {
      el.appendChild(UI.row(
        UI.btn('Hit', () => send({ type: 'hit' }), { variant: 'primary' }),
        UI.btn('Stand', () => send({ type: 'stand' })),
        UI.btn('Double', () => send({ type: 'double' })),
      ));
    } else {
      el.appendChild(UI.spinnerRow('Waiting for the table...'));
    }
    el.appendChild(UI.h('div', { class: 'table-players' }, view.players.map((p) =>
      UI.h('div', { class: `seat ${view.status[p.id]?.done ? 'done' : ''}` },
        UI.avatarBubble(p.name, p.avatar),
        UI.h('span', { class: 'name', text: p.name }),
        UI.pill(`${view.counts[p.id]} cards`),
        UI.pill(`${view.bank[p.id]} 🪙`),
        view.status[p.id]?.result ? UI.badge(view.status[p.id].result.toUpperCase(), view.status[p.id].result) : null,
      ))));
    if (view.handLog?.length) el.appendChild(UI.logView({ log: view.handLog }));
  },
};

function cardLabel(card) {
  return card?.hidden ? '??' : card ? `${card.value}${card.suit}` : '';
}

/**
 * One playing card: the index at the left, the suit big beside it.
 *
 * The face used to be the string "7♦" in a white box; a card you can read at
 * arm's length from the suit shape is the whole point of a card face, so the
 * two parts are separate elements now (and the stylesheet gives them depth).
 */
function cardEl(card, hiddenSheet) {
  if (!card) return UI.h('span', { class: 'pcard empty' });
  if (card.hidden) return UI.h('span', { class: 'pcard back', text: '?' });
  const red = card.suit === '♥' || card.suit === '♦';
  return UI.h('span', { class: `pcard ${red ? 'red' : 'black'}` },
    UI.h('b', { class: 'pcard-index', text: card.value }),
    UI.h('i', { class: 'pcard-suit', text: card.suit }));
}

function makeShoe(decks, rng) {
  const cards = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of ['♠', '♥', '♦', '♣']) {
      for (const value of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) cards.push({ value, suit });
    }
  }
  return U.shuffle(cards, rng);
}

function cardValue(card) {
  if (!card) return 0;
  if (card.value === 'A') return 11;
  if (['J', 'Q', 'K'].includes(card.value)) return 10;
  return Number(card.value);
}

function handTotal(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand || []) {
    const v = cardValue(card);
    total += v;
    if (card.value === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function dealRound(state, rng) {
  state.phase = 'betting';
  state.dealerRevealed = false;
  state.hands = {};
  state.status = {};
  state.results = {};
  for (const p of state.players) {
    const bet = Math.min(25, Math.max(5, Math.floor((state.bank[p.id] || 0) / 10)));
    state.bets[p.id] = Math.max(5, bet);
    state.bank[p.id] = (state.bank[p.id] || 0) - state.bets[p.id];
    state.hands[p.id] = [state.deck.pop(), state.deck.pop()];
    state.status[p.id] = { done: false, result: null };
  }
  state.dealer = [state.deck.pop(), state.deck.pop()];
  if (state.deck.length < 30) state.deck = makeShoe(6, rng);
}

function settleIfDone(state, events) {
  const pending = state.players.some((p) => !state.status[p.id]?.done);
  if (pending) return;
  state.dealerRevealed = true;
  let dealerTotal = handTotal(state.dealer);
  while (dealerTotal < 17) {
    state.dealer.push(state.deck.pop());
    dealerTotal = handTotal(state.dealer);
  }
  events.push(U.event(`Dealer finishes on ${dealerTotal}.`, 'info'));
  for (const p of state.players) {
    const status = state.status[p.id];
    const total = handTotal(state.hands[p.id]);
    const bet = state.bets[p.id];
    let payout = 0;
    let result = 'lose';
    const natural = total === 21 && state.hands[p.id].length === 2;
    if (status.result === 'bust' || total > 21) result = 'bust';
    else if (dealerTotal > 21 || total > dealerTotal) {
      result = natural ? 'blackjack' : 'win';
      payout = natural ? Math.floor(bet * 2.5) : bet * 2;
    } else if (total === dealerTotal) {
      result = 'push';
      payout = bet;
    }
    state.bank[p.id] = (state.bank[p.id] || 0) + payout;
    state.results[p.id] = { result, delta: payout - bet, total, dealerTotal };
    events.push(U.event(`${U.byId(state, p.id)?.name}: ${result} (${payout - bet >= 0 ? '+' : ''}${payout - bet})`, result === 'lose' || result === 'bust' ? 'miss' : 'win'));
  }
  for (const e of events) state.handLog.push({ text: e.text, kind: e.kind });
  if (state.round >= state.rounds) {
    state.phase = 'done';
    state.summary = 'Final chip counts ready.';
  } else {
    state.round++;
    dealRound(state, Math.random);
    U.addLog(state, `Round ${state.round} - cards dealt.`);
  }
}

export default { uno, goFish, blackjack };
