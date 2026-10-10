/**
 * Monopoly (trimmed and fast).
 *
 * A 24-tile ring instead of 40: eleven properties in four colour groups, two
 * rail lines, two utilities, chance, tax and the four corners.  No trading and
 * no houses - rent doubles when you own a whole group, and taxes feed the Free
 * Parking pot.  Dice come from a small deterministic PRNG stored in state so
 * online matches can be replayed from the same seed.
 */
import * as U from './util.js';
import * as UI from './ui.js';
import * as Art from './art.js';

const MODES = ['local', 'online'];

/** Where a die's pips sit in its 3x3 face, so 1..6 read without a font. */
const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

const GROUPS = {
  treat: { name: 'Sweet street', color: '#f472b6' },
  neon: { name: 'Neon row', color: '#22d3ee' },
  space: { name: 'Space belt', color: '#a78bfa' },
  castle: { name: 'Old town', color: '#fbbf24' },
};

const TILES = [
  { kind: 'go', name: 'GO' },
  { kind: 'property', name: 'Bakery Lane', group: 'treat', price: 60, rent: 6 },
  { kind: 'utility', name: 'Power Plant', price: 150 },
  { kind: 'property', name: 'Candy Court', group: 'treat', price: 70, rent: 8 },
  { kind: 'rail', name: 'Pixel Line', price: 200 },
  { kind: 'chance', name: 'Chance' },
  { kind: 'jail', name: 'Jail (visiting)' },
  { kind: 'property', name: 'Glow Blvd', group: 'neon', price: 100, rent: 10 },
  { kind: 'tax', name: 'Income tax', amount: 100 },
  { kind: 'property', name: 'Laser Lane', group: 'neon', price: 110, rent: 12 },
  { kind: 'chance', name: 'Chance' },
  { kind: 'property', name: 'Hologram Hill', group: 'neon', price: 120, rent: 14 },
  { kind: 'free', name: 'Free Parking' },
  { kind: 'property', name: 'Orbit Ave', group: 'space', price: 140, rent: 16 },
  { kind: 'rail', name: 'Warp Rail', price: 200 },
  { kind: 'property', name: 'Nebula Drive', group: 'space', price: 150, rent: 18 },
  { kind: 'utility', name: 'Water Works', price: 150 },
  { kind: 'property', name: 'Comet Close', group: 'space', price: 160, rent: 20 },
  { kind: 'gotojail', name: 'Go to jail' },
  { kind: 'property', name: 'Castle Gate', group: 'castle', price: 180, rent: 22 },
  { kind: 'chance', name: 'Chance' },
  { kind: 'property', name: 'Kings Road', group: 'castle', price: 200, rent: 24 },
  { kind: 'tax', name: 'Luxury tax', amount: 75 },
  { kind: 'property', name: 'Treasure Keep', group: 'castle', price: 220, rent: 26 },
];

const START_CASH = 1500;
const GO_SALARY = 200;
const BAIL = 50;

/* ------------------------------- dice ------------------------------------- */

function rollDie(state) {
  // xorshift32 stored in state keeps every roll part of the game record.
  let x = state.rngState || 88172645;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  state.rngState = x || 1;
  return (state.rngState % 6) + 1;
}

function groupCount(state, group) {
  return TILES.filter((t) => t.group === group && state.owner[TILES.indexOf(t)] !== undefined).length;
}

function ownedInGroup(state, owner, group) {
  let n = 0;
  for (let i = 0; i < TILES.length; i++) {
    const t = TILES[i];
    if (t.group === group && state.owner[i] === owner) n++;
  }
  return n;
}

function rentFor(state, index, dice) {
  const tile = TILES[index];
  const owner = state.owner[index];
  if (tile.kind === 'rail') {
    let count = 0;
    for (let i = 0; i < TILES.length; i++) if (TILES[i].kind === 'rail' && state.owner[i] === owner) count++;
    return 25 * 2 ** Math.max(0, count - 1);
  }
  if (tile.kind === 'utility') {
    let count = 0;
    for (let i = 0; i < TILES.length; i++) if (TILES[i].kind === 'utility' && state.owner[i] === owner) count++;
    return dice * (count > 1 ? 10 : 4);
  }
  const fullGroup = ownedInGroup(state, owner, tile.group) === TILES.filter((t) => t.group === tile.group).length;
  return tile.rent * (fullGroup ? 2 : 1);
}

/* ------------------------------ chance deck ------------------------------- */

const CHANCE = [
  { text: 'Bank error in your favour: +100', apply: (state, id) => pay(state, id, 100, 'bank') },
  { text: 'Birthday! Everyone pays you 50', apply: (state, id) => { for (const p of state.players) if (p.id !== id && !state.out[p.id]) pay(state, p.id, -50, id); } },
  { text: 'Speeding fine: -50', apply: (state, id) => pay(state, id, -50, 'pot') },
  { text: 'Advance to GO (+200)', apply: (state, id) => { state.pos[id] = 0; pay(state, id, GO_SALARY, 'bank'); } },
  { text: 'Caught loitering - go to jail', apply: (state, id) => putInJail(state, id) },
  { text: 'You won a talent show: +50', apply: (state, id) => pay(state, id, 50, 'bank') },
  { text: 'Repairs: pay 40 per property you own', apply: (state, id) => { const owned = state.ownerOf[id]?.length || 0; pay(state, id, -40 * owned, 'pot'); } },
  { text: 'Free holiday - collect the Free Parking pot', apply: (state, id) => takePot(state, id) },
  { text: 'Mystery stock bump: +150', apply: (state, id) => pay(state, id, 150, 'bank') },
  { text: 'Wrong bus: go back 3 tiles', apply: (state, id) => { state.pos[id] = (state.pos[id] + TILES.length - 3) % TILES.length; } },
  { text: 'It is your lucky day: +80', apply: (state, id) => pay(state, id, 80, 'bank') },
  { text: 'Charity run: pay 30 to the pot', apply: (state, id) => pay(state, id, -30, 'pot') },
];

function pay(state, id, amount, to) {
  if (amount >= 0) {
    if (to && to !== 'bank' && to !== 'pot') state.cash[to] = (state.cash[to] || 0) + amount;
    else if (to === 'pot') state.pot = (state.pot || 0) + amount;
    state.cash[id] += amount;
  } else {
    const cost = Math.min(Math.abs(amount), state.cash[id]);
    state.cash[id] -= cost;
    if (to === 'pot') state.pot = (state.pot || 0) + cost;
    else if (to && to !== 'bank' && to !== 'pot') state.cash[to] = (state.cash[to] || 0) + cost;
  }
  syncCash(state);
  if (state.cash[id] < 0) bankrupt(state, id);
}

function takePot(state, id) {
  state.cash[id] += state.pot || 0;
  state.pot = 0;
  syncCash(state);
}

function syncCash(state) {
  for (const p of state.players) state.scores[p.id] = state.cash[p.id] || 0;
}

function putInJail(state, id) {
  state.pos[id] = 6;
  state.jailed[id] = true;
  U.addLog(state, `${U.byId(state, id)?.name} is sent to jail.`);
}

function bankrupt(state, id) {
  state.out[id] = true;
  state.jailed[id] = false;
  state.cash[id] = 0;
  for (const [index, owner] of Object.entries(state.owner)) {
    if (owner === id) {
      delete state.owner[index];
      state.ownerOf[id] = (state.ownerOf[id] || []).filter((i) => Number(i) !== Number(index));
    }
  }
  U.addLog(state, `${U.byId(state, id)?.name} is bankrupt and out of the game!`);
  syncCash(state);
  const alive = state.players.filter((p) => !state.out[p.id]);
  if (alive.length <= 1) {
    state.winnerId = alive.map((p) => p.id);
    state.summary = alive.length ? `${alive[0].name} owns the whole board!` : 'Everyone went bankrupt - nobody wins.';
  }
}

/* ========================================================================= */

export const monopoly = {
  meta: {
    id: 'monopoly',
    name: 'Monopoly',
    category: 'cards',
    players: { min: 2, max: 6 },
    modes: MODES,
    blurb: 'A trimmed, fast-playing board: buy, rent, go to jail, bankrupt your friends.',
    tags: ['dice', 'long', 'beta'],
    minutes: 45,
    status: 'beta',
    playable: true,
    bots: true,
    maxBots: 4,
    turnMs: 45000,
    rules: [
      'Roll, move, and buy what you land on.',
      'Rent doubles when the owner holds every property in a colour group.',
      'Taxes fill the Free Parking pot - land there to take it all.',
      'Last player standing - or the richest after the round limit - wins.',
    ],
    options: [{ id: 'rounds', label: 'Round limit', type: 'select', values: [0, 15, 25], default: 15 }],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    state.rngState = Math.max(1, Math.floor((seed ?? rng() * 1e9) % 2147483647));
    state.maxRounds = options.rounds ?? 15;
    state.cash = {};
    state.pos = {};
    state.owner = {};
    state.ownerOf = {};
    state.jailed = {};
    state.out = {};
    state.pot = 0;
    state.round = 1;
    state.phase = 'roll';
    state.dice = null;
    state.pendingBuy = null;
    state.lastCard = null;
    for (const p of state.players) {
      state.cash[p.id] = START_CASH;
      state.pos[p.id] = 0;
      state.jailed[p.id] = false;
      state.out[p.id] = false;
      state.ownerOf[p.id] = [];
    }
    syncCash(state);
    U.addLog(state, `${state.players[0].name} rolls first.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.tiles = TILES.map((t, i) => ({ ...t, index: i, owner: state.owner[i] ?? null }));
    v.cash = state.cash;
    v.pos = state.pos;
    v.owner = state.owner;
    v.jailed = state.jailed;
    v.out = state.out;
    v.pot = state.pot || 0;
    v.round = state.round;
    v.maxRounds = state.maxRounds;
    v.dice = state.dice || null;
    v.pendingBuy = state.pendingBuy || null;
    v.lastCard = state.lastCard || null;
    v.groups = GROUPS;
    v.myProps = state.ownerOf[viewerId] || [];
    v.turn = state.winnerId ? [] : [state.turnId];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    if (state.out[playerId]) return { ok: false, error: 'You are out of the game.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
    const events = [];
    if (action.type === 'roll') {
      if (state.phase !== 'roll') return { ok: false, error: 'Finish this move first.' };
      if (state.jailed[playerId] && action.wait) {
        state.jailed[playerId] = false;
        events.push(U.event(`${U.byId(state, playerId)?.name} waits out the jail turn.`, 'info'));
        advance(state, events);
        for (const e of events) U.addLog(state, e.text, e.kind);
        return { ok: true, events };
      }
      if (state.jailed[playerId]) {
        if (state.cash[playerId] < BAIL) return { ok: false, error: 'You cannot afford bail - wait it out.' };
        pay(state, playerId, -BAIL, 'pot');
        state.jailed[playerId] = false;
        events.push(U.event(`${U.byId(state, playerId)?.name} pays ${BAIL} to get out of jail.`, 'info'));
      }
      const a = rollDie(state);
      const b = rollDie(state);
      state.dice = { a, b };
      const total = a + b;
      const doubles = a === b;
      let pos = (state.pos[playerId] + total) % TILES.length;
      if (pos < state.pos[playerId]) {
        pay(state, playerId, GO_SALARY, 'bank');
        events.push(U.event(`${U.byId(state, playerId)?.name} passes GO (+${GO_SALARY}).`, 'info'));
      }
      state.pos[playerId] = pos;
      events.push(U.event(`${U.byId(state, playerId)?.name} rolls ${a}+${b} = ${total}.`, 'info'));
      if (state.winnerId) { for (const e of events) U.addLog(state, e.text, e.kind); return { ok: true, events }; }
      landOn(state, playerId, pos, total, events, doubles);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'buy' || action.type === 'pass') {
      if (state.phase !== 'buy' || !state.pendingBuy) return { ok: false, error: 'Nothing to buy.' };
      const { index } = state.pendingBuy;
      state.phase = 'roll';
      state.pendingBuy = null;
      if (action.type === 'buy') {
        const tile = TILES[index];
        if (state.cash[playerId] < tile.price) return { ok: false, error: 'Not enough cash.' };
        pay(state, playerId, -tile.price, 'bank');
        state.owner[index] = playerId;
        state.ownerOf[playerId] = (state.ownerOf[playerId] || []).concat(index);
        events.push(U.event(`${U.byId(state, playerId)?.name} buys ${tile.name} for ${tile.price}.`, 'win'));
      } else {
        events.push(U.event(`${U.byId(state, playerId)?.name} passes on ${TILES[index].name}.`, 'info'));
      }
      advance(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'end') {
      if (state.phase !== 'end') return { ok: false, error: 'Nothing to end.' };
      advance(state, events);
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    if (state.winnerId || state.out[playerId] || playerId !== state.turnId) return null;
    if (state.phase === 'buy' && state.pendingBuy) {
      const tile = TILES[state.pendingBuy.index];
      const level = U.byId(state, playerId)?.level ?? 2;
      const groupDone = ownedInGroup(state, playerId, tile.group) === TILES.filter((t) => t.group === tile.group).length - 1;
      const reserve = level >= 3 ? 200 : 80;
      if (state.cash[playerId] - tile.price >= reserve || groupDone) return { type: 'buy' };
      return { type: 'pass' };
    }
    if (state.phase === 'end') return { type: 'end' };
    if (state.phase === 'roll') {
      if (state.jailed[playerId] && state.cash[playerId] >= 500) return { type: 'roll' };
      if (state.jailed[playerId]) return { type: 'roll', wait: true };
      return { type: 'roll' };
    }
    return null;
  },
  timeout(state, playerId) {
    if (state.phase === 'roll') return state.jailed[playerId] ? { type: 'roll', wait: true } : { type: 'roll' };
    if (state.phase === 'buy') return { type: 'pass' };
    if (state.phase === 'end') return { type: 'end' };
    return null;
  },
  over(state) {
    return U.simpleOver(state, { draw: !!state.draw });
  },
  render({ el, view, playerId, send }) {
    const me = view.players.find((p) => p.id === playerId);
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(`Round ${view.round}${view.maxRounds ? `/${view.maxRounds}` : ''}`),
      UI.pill(`💰 ${view.cash[playerId] ?? 0}`),
      UI.pill(`Free Parking pot: ${view.pot}`)));
    // The dice ride on the board's own stage (below), so the roll is part of
    // the table rather than another row of chrome under it.
    const dice = view.dice ? UI.h('div', { class: 'dice' }, die(view.dice.a), die(view.dice.b)) : null;
    if (view.lastCard) el.appendChild(UI.h('div', { class: 'prompt-card' }, UI.h('div', { class: 'prompt-text', text: view.lastCard })));
    const cells = view.tiles.map((tile) => {
      const owners = view.players.filter((p) => view.pos[p.id] === tile.index && !view.out[p.id]);
      const ownerSeat = tile.owner ? view.players.find((p) => p.id === tile.owner) : null;
      const label = tile.kind === 'property' || tile.kind === 'rail' || tile.kind === 'utility'
        ? `${tile.name}${tile.price ? ` (${tile.price})` : ''}`
        : tile.name;
      return UI.h('div', {
        class: `cell tile ${tile.kind} ${ownerSeat ? 'owned' : ''}`,
        style: tile.group ? { borderTop: `4px solid ${view.groups[tile.group].color}` } : {},
        title: ownerSeat ? `Owned by ${ownerSeat.name}` : '',
      },
        UI.h('span', { class: 'tile-name', text: label }),
        ownerSeat ? UI.h('span', { class: 'tile-owner', text: `${ownerSeat.avatar || ''} ${ownerSeat.name}` }) : null,
        owners.length ? UI.h('span', { class: 'tokens', text: owners.map((p) => p.avatar || '👾').join('') }) : null);
    });
    el.appendChild(Art.boardStage('monopoly', { width: 1000, height: 680 },
      dice,
      UI.h('div', { class: 'board monopoly', style: { '--cols': 6, '--rows': 4 } }, cells)));
    if (view.phase === 'buy' && view.pendingBuy) {
      const tile = view.tiles[view.pendingBuy.index];
      el.appendChild(UI.row(
        UI.btn(`Buy ${tile.name} (${tile.price})`, () => send({ type: 'buy' }), { variant: 'primary', disabled: view.turn.includes(playerId) === false }),
        UI.btn('Pass', () => send({ type: 'pass' }), { disabled: view.turn.includes(playerId) === false }),
      ));
    } else if (view.phase === 'roll' && view.turn.includes(playerId)) {
      el.appendChild(UI.btn(view.jailed[playerId] ? 'Sit in jail (or pay bail on the way)' : 'Roll the dice', () => send({ type: 'roll' }), { variant: 'primary' }));
      if (view.jailed[playerId]) el.appendChild(UI.btn('Wait out the turn', () => send({ type: 'roll', wait: true }), { size: 'sm' }));
    } else if (view.phase === 'end' && view.turn.includes(playerId)) {
      el.appendChild(UI.btn('End turn', () => send({ type: 'end' }), { variant: 'primary' }));
    } else {
      el.appendChild(UI.muted(`${view.players.find((p) => p.id === view.turn[0])?.name || 'Someone'} is playing...`));
    }
    el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.out[p.id] ? 'out' : ''}`, text: `${p.avatar || ''} ${p.name}: ${view.cash[p.id] ?? 0}${view.out[p.id] ? ' 💀' : view.jailed[p.id] ? ' 🔒' : ''}` }))));
    if (me && view.myProps?.length) {
      el.appendChild(UI.h('div', { class: 'waiting-list' }, view.myProps.map((i) => UI.h('span', { class: 'chip', text: view.tiles[i].name }))));
    }
    el.appendChild(UI.logView(view, { limit: 6 }));
  },
};

/**
 * One die face: nine pip slots with this face's own sitting lit.
 *
 * Dice were two emoji pills, which told you the number and nothing else - a
 * rolled pair is the thing every eye on a Monopoly table is following, so it
 * gets the same treatment the canvas games give a ball or a paddle.
 */
function die(n) {
  const on = new Set(PIPS[n] || []);
  return UI.h('span', { class: `die face-${n}`, title: String(n) },
    Array.from({ length: 9 }, (_, i) => UI.h('i', { class: `pip ${on.has(i) ? 'on' : ''}` })));
}

function landOn(state, playerId, pos, total, events, doubles) {
  const tile = TILES[pos];
  const name = U.byId(state, playerId)?.name;
  if (tile.kind === 'property' || tile.kind === 'rail' || tile.kind === 'utility') {
    const owner = state.owner[pos];
    if (owner === undefined) {
      if (state.cash[playerId] >= tile.price) {
        state.phase = 'buy';
        state.pendingBuy = { index: pos };
        events.push(U.event(`${name} may buy ${tile.name}.`, 'info'));
        return;
      }
      events.push(U.event(`${name} cannot afford ${tile.name}.`, 'info'));
      endTurn(state, events, doubles);
      return;
    }
    if (owner === playerId) {
      events.push(U.event(`${name} is home at ${tile.name}.`, 'info'));
      endTurn(state, events, doubles);
      return;
    }
    const rent = rentFor(state, pos, total);
    pay(state, playerId, -rent, owner);
    events.push(U.event(`${name} pays ${rent} rent to ${U.byId(state, owner)?.name} at ${tile.name}.`, 'warn'));
    endTurn(state, events, doubles);
    return;
  }
  if (tile.kind === 'tax') {
    pay(state, playerId, -tile.amount, 'pot');
    events.push(U.event(`${name} pays ${tile.amount} ${tile.name.toLowerCase()} into the pot.`, 'warn'));
    endTurn(state, events, doubles);
    return;
  }
  if (tile.kind === 'chance') {
    const card = CHANCE[Math.floor((state.rngState / 2147483647) * CHANCE.length) % CHANCE.length];
    state.lastCard = card.text;
    events.push(U.event(`Chance: ${card.text}`, 'info'));
    card.apply(state, playerId);
    endTurn(state, events, doubles);
    return;
  }
  if (tile.kind === 'gotojail') {
    putInJail(state, playerId);
    events.push(U.event(`${name} goes to jail!`, 'warn'));
    endTurn(state, events, doubles);
    return;
  }
  if (tile.kind === 'free') {
    if (state.pot) {
      const pot = state.pot;
      takePot(state, playerId);
      events.push(U.event(`${name} takes the ${pot} Free Parking pot!`, 'win'));
    } else {
      events.push(U.event(`${name} parks for free.`, 'info'));
    }
    endTurn(state, events, doubles);
    return;
  }
  if (tile.kind === 'go') {
    pay(state, playerId, GO_SALARY, 'bank');
    events.push(U.event(`${name} lands on GO (+${GO_SALARY}).`, 'win'));
    endTurn(state, events, doubles);
    return;
  }
  events.push(U.event(`${name} lands on ${tile.name}.`, 'info'));
  endTurn(state, events, doubles);
}

function endTurn(state, events, doubles) {
  if (state.winnerId) return;
  if (state.phase === 'buy') return;
  // Doubles give one extra roll, but only when the player is safe and solvent.
  if (doubles && !state.out[state.turnId]) {
    state.phase = 'roll';
    events.push(U.event('Doubles - roll again!', 'win'));
    return;
  }
  advance(state, events);
}

function advance(state, events) {
  if (state.winnerId) return;
  state.phase = 'roll';
  state.pendingBuy = null;
  state.lastCard = null;
  const alive = state.players.filter((p) => !state.out[p.id]);
  if (alive.length <= 1) {
    state.winnerId = alive.map((p) => p.id);
    state.summary = alive.length ? `${alive[0].name} owns the whole board!` : 'Everyone went bankrupt - nobody wins.';
    events.push(U.event(state.summary, 'win'));
    return;
  }
  const order = state.players.filter((p) => !state.out[p.id]).map((p) => p.id);
  let i = order.indexOf(state.turnId);
  if (i === -1) i = 0;
  const next = order[(i + 1) % order.length];
  if (next === order[0] && state.turnId !== next) {
    state.round++;
    if (state.maxRounds && state.round > state.maxRounds) {
      const ranked = U.ranking(state);
      const best = ranked[0];
      state.winnerId = ranked.filter((r) => r.score === best.score).map((r) => r.id);
      state.summary = `Round limit reached - ${best.name} is richest with ${best.score}!`;
      events.push(U.event(state.summary, 'win'));
      return;
    }
  }
  state.turnId = next;
  state.dice = null;
  // Skipping happens inside 'roll' when the seat is jailed.
  events.push(U.event(`${U.byId(state, next)?.name}'s turn.`, 'info'));
}

export default { monopoly };
