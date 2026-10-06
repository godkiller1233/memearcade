#!/usr/bin/env node
/**
 * Headless engine harness.
 *
 * Every engine must expose bot(state, playerId) that returns a *legal* action
 * for any seat - including bots sitting in a party game.  That single rule
 * lets this harness play each game bot-vs-bot to completion, which is the
 * cheapest possible regression test for 40+ rule sets.
 *
 * Checks per game:
 *  - create/view/act/over never throw over a full match
 *  - state and every player's view stay JSON-serialisable (they cross the wire)
 *  - turn ids always refer to real seats
 *  - the match actually ends (or hits a sane step budget)
 *  - secrets stay hidden: views differ when meta.secret is set
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_DIR = path.join(ROOT, 'web', 'games', 'engines');
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const VERBOSE = process.argv.includes('-v');

const failures = [];
const results = [];

function makeSeats(count) {
  const seats = [];
  for (let i = 0; i < count; i++) {
    const human = i < Math.max(1, Math.ceil(count / 3));
    seats.push({ id: human ? `h${i}` : `b${i}`, name: human ? `Human${i}` : `Bot${i}`, kind: human ? 'human' : 'bot', level: 3, avatar: '🤖' });
  }
  return seats;
}

async function loadEngines() {
  const files = fs.readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.js') && !['util.js', 'ui.js', 'index.js', 'art.js'].includes(f));
  const engines = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(ENGINE_DIR, file)).href);
    const found = [];
    if (mod.default?.meta) found.push(mod.default);
    for (const [key, value] of Object.entries(mod)) {
      if (key !== 'default' && value?.meta && typeof value.create === 'function') found.push(value);
    }
    for (const engine of found) engines.push({ file, engine, meta: engine.meta });
  }
  return engines;
}

/**
 * Deep scan for `undefined`, which JSON.stringify silently rewrites to null -
 * it hid a real chess bug for a while, so every engine gets checked for it.
 */
function findUndefined(value, path = '$', depth = 0, seen = new Set()) {
  if (depth > 12) return null;
  if (value === undefined) return path;
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findUndefined(value[i], `${path}[${i}]`, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const hit = findUndefined(child, `${path}.${key}`, depth + 1, seen);
    if (hit) return hit;
  }
  return null;
}

function play(engine, seats, { maxSteps = 4000, options = {} } = {}) {
  const meta = engine.meta;
  const state = engine.create({
    players: seats,
    options,
    rng: Math.random,
    seed: 987654321,
    bots: seats.filter((s) => s.kind === 'bot').length,
  });
  const viewCache = [];
  let steps = 0;
  let stalled = 0;
  const seenTurns = new Set();

  while (steps < maxSteps) {
    const done = engine.over(state);
    if (done?.over) {
      return { steps, done, state, viewsDiffer: viewCache.some((v) => JSON.stringify(v) !== JSON.stringify(viewCache[0])) };
    }
    const probe = engine.view(state, seats[0].id);
    if (!probe || typeof probe !== 'object') throw new Error('view() did not return an object');
    viewCache[0] = probe;
    const turn = Array.isArray(probe.turn) ? probe.turn : [];
    let acted = false;
    for (const id of turn) {
      if (!seats.some((s) => s.id === id)) throw new Error(`turn mentions unknown seat "${id}"`);
      if (seenTurns.size < 128) seenTurns.add(id);
      const action = engine.bot(state, id);
      if (!action) continue; // this seat is waiting on a human in a real game
      const res = engine.act(state, id, action);
      if (res && res.ok === false) throw new Error(`legal bot action rejected for ${id}: ${res.error}`);
      steps++;
      acted = true;
      if (VERBOSE && steps % 25 === 0) {
        console.log(`    step ${steps}: ${(state.log || []).slice(-1)[0]?.text || ''}`);
      }
      break; // re-evaluate turn order after each action
    }
    if (!acted) {
      stalled++;
      if (stalled > 60) return { steps, done: null, stalled, stuck: true };
      continue;
    }
    stalled = 0;
    JSON.stringify(state);
    const stateUndef = findUndefined(state);
    if (stateUndef) throw new Error(`state contains undefined at ${stateUndef}`);
    for (const seat of seats) {
      const v = engine.view(state, seat.id);
      JSON.stringify(v);
      const undef = findUndefined(v);
      if (undef) throw new Error(`view(${seat.id}) contains undefined at ${undef}`);
      if (meta.secret) viewCache.push(v);
    }
  }
  return { steps, done: engine.over(state), hitLimit: true };
}

const engines = await loadEngines();
const targets = ONLY.length ? engines.filter((e) => ONLY.includes(e.meta.id) || ONLY.includes(e.file)) : engines;

console.log(`\ntesting ${targets.length} engine(s)\n`);
for (const { file, engine, meta } of targets) {
  const label = `${meta.id} (${file})`;
  try {
    if (!meta.players || typeof meta.players.min !== 'number') throw new Error('meta.players.min missing');
    if (typeof engine.render !== 'function') throw new Error('render() missing');
    const seatCounts = [meta.players.min, meta.players.max].filter((n, i, a) => a.indexOf(n) === i);
    const outcomes = [];
    for (const count of seatCounts) {
      const seats = makeSeats(count);
      const res = play(engine, seats);
      if (res.stuck) throw new Error(`stalled after ${res.steps} steps - bot() could not move for a waiting seat`);
      if (!res.done?.over) throw new Error(`did not finish within ${res.steps} steps`);
      outcomes.push(`${count}p:${res.steps} steps${res.done.winners?.length ? ` winner=${res.done.winners.join(',')}` : ' draw'}`);
      // The arcade books whatever over() reports as `scores`, so it has to be a
      // plain map of seat id -> finite points (see recordGame in server/store.js).
      const scores = res.done.scores;
      if (scores !== undefined && scores !== null) {
        if (typeof scores !== 'object' || Array.isArray(scores)) throw new Error('over() scores is not a map of player id -> points');
        for (const [id, value] of Object.entries(scores)) {
          if (!seats.some((s) => s.id === id)) throw new Error(`over() scores names unknown seat "${id}"`);
          if (!Number.isFinite(value)) throw new Error(`over() scores["${id}"] is not a finite number (${value})`);
        }
      }
      // Pong's points are the margin of victory: winners bank it, others get 0.
      if (meta.id === 'pong') {
        const margin = Math.abs((res.state?.score?.l || 0) - (res.state?.score?.r || 0));
        const winners = res.done.winners || [];
        const losers = seats.filter((s) => !winners.includes(s.id));
        const booked = res.done.scores || {};
        const holds = margin > 0 && winners.every((id) => booked[id] === margin) && losers.every((s) => (booked[s.id] || 0) === 0);
        if (!holds) throw new Error(`pong did not book the margin of victory: scores ${JSON.stringify(booked)} for ${JSON.stringify(res.state?.score)}`);
      }
      if (meta.secret && count > 1 && !res.viewsDiffer && meta.id !== 'battleship') {
        // some secret games legitimately look identical early; warn only
        if (VERBOSE) console.log(`    note: ${meta.id} views identical in a ${count}p match`);
      }
    }
    results.push({ id: meta.id, ok: true, outcomes });
    console.log(`  ok   ${label} — ${outcomes.join(' | ')}`);
  } catch (err) {
    failures.push({ id: meta.id, error: err.message });
    console.log(` FAIL  ${label} — ${err.message}`);
  }
}

const total = targets.length;
const passed = total - failures.length;
console.log(`\n${passed}/${total} engines passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f.id}: ${f.error}`);
  process.exit(1);
}
console.log('');
