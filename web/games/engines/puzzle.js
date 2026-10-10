/**
 * Puzzle family: Sudoku.
 *
 * A real generator: a seeded backtracking solver builds a full grid, then
 * removes cells one at a time while checking the puzzle still has exactly one
 * solution.  Every player races the same grid, and the state stays small
 * because only the givens plus each player's own entries travel the wire (the
 * solution itself is stripped out of every view).
 */
import * as U from './util.js';
import * as UI from './ui.js';

const MODES = ['solo', 'local', 'online'];
const SIZE = 9;
const CELLS = 81;

const DIFFICULTY = {
  easy: { name: 'Easy', keep: 42, hints: 3 },
  medium: { name: 'Medium', keep: 34, hints: 2 },
  hard: { name: 'Hard', keep: 26, hints: 1 },
};

/* ------------------------------- generation ------------------------------- */

function candidates(grid, pos) {
  const x = pos % SIZE;
  const y = Math.floor(pos / SIZE);
  const used = new Set();
  for (let i = 0; i < SIZE; i++) {
    used.add(grid[y * SIZE + i]);
    used.add(grid[i * SIZE + x]);
  }
  const bx = Math.floor(x / 3) * 3;
  const by = Math.floor(y / 3) * 3;
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) used.add(grid[(by + j) * SIZE + bx + i]);
  const out = [];
  for (let v = 1; v <= 9; v++) if (!used.has(v)) out.push(v);
  return out;
}

function fillGrid(grid, rng) {
  const empty = grid.indexOf(0);
  if (empty === -1) return true;
  for (const value of U.shuffle(candidates(grid, empty), rng)) {
    grid[empty] = value;
    if (fillGrid(grid, rng)) return true;
    grid[empty] = 0;
  }
  return false;
}

function countSolutions(grid, limit = 2) {
  const pos = grid.indexOf(0);
  if (pos === -1) return 1;
  let found = 0;
  for (const value of candidates(grid, pos)) {
    grid[pos] = value;
    found += countSolutions(grid, limit - found);
    grid[pos] = 0;
    if (found >= limit) break;
  }
  return found;
}

export function makeSudoku(seed, difficulty = 'medium') {
  const rng = U.makeRng(seed);
  const solution = Array(CELLS).fill(0);
  fillGrid(solution, rng);
  const puzzle = solution.slice();
  const order = U.shuffle([...Array(CELLS).keys()], rng);
  const keep = (DIFFICULTY[difficulty] || DIFFICULTY.medium).keep;
  let remaining = CELLS;
  for (const pos of order) {
    if (remaining <= keep) break;
    const value = puzzle[pos];
    puzzle[pos] = 0;
    if (countSolutions(puzzle.slice(), 2) !== 1) puzzle[pos] = value;
    else remaining--;
  }
  return { puzzle, solution };
}

/* ========================================================================= */

export const sudoku = {
  meta: {
    id: 'sudoku',
    // A clean solve is worth 100 points, less five a mistake; a hinted finish is
    // 80.  A grid takes a while, so the memory also keeps an unfinished one.
    record: {
      best: 'high',
      label: 'points',
      time: 'short',
      timeLabel: 'fastest solve',
      resume: true,
      progress: (view) => `${Object.keys(view.myEntries || {}).length}/${view.totalToFill} squares · ${view.myMistakes} mistakes`,
    },
    name: 'Sudoku',
    category: 'puzzle',
    players: { min: 1, max: 8 },
    modes: MODES,
    simultaneous: true,
    secret: true,
    blurb: 'Real generator with difficulty tiers, hints and notes. Race mode scores whoever solves it first.',
    tags: ['puzzle', 'solo', 'race'],
    minutes: 15,
    status: 'playable',
    bots: true,
    maxBots: 5,
    rules: [
      'Everyone gets the same puzzle - the first clean solve wins.',
      'Wrong numbers are refused, so the grid never lies to you.',
      'Limited hints fill one square for you.',
    ],
    options: [
      { id: 'difficulty', label: 'Difficulty', type: 'select', values: ['easy', 'medium', 'hard'], default: 'medium' },
    ],
  },
  create({ players, seed, rng = Math.random, options = {} }) {
    const state = U.baseState({ players, seed });
    const difficulty = DIFFICULTY[options.difficulty] ? options.difficulty : 'medium';
    state.difficulty = difficulty;
    const built = makeSudoku(seed ?? Math.floor(rng() * 1e9), difficulty);
    state.puzzle = built.puzzle;
    state.solution = built.solution;
    state.entries = {};
    state.hints = {};
    state.mistakes = {};
    state.solved = {};
    for (const p of state.players) {
      state.entries[p.id] = {};
      state.hints[p.id] = (DIFFICULTY[difficulty] || DIFFICULTY.medium).hints;
      state.mistakes[p.id] = 0;
      state.solved[p.id] = false;
    }
    state.phase = 'solve';
    U.addLog(state, `${DIFFICULTY[difficulty].name} grid - ${state.puzzle.filter((v) => v === 0).length} squares to fill.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.difficulty = state.difficulty;
    v.difficultyName = (DIFFICULTY[state.difficulty] || DIFFICULTY.medium).name;
    v.puzzle = state.puzzle;
    v.myEntries = state.entries[viewerId] || {};
    v.hintsLeft = state.hints[viewerId] ?? 0;
    v.myMistakes = state.mistakes[viewerId] || 0;
    v.solved = state.solved;
    v.progress = {};
    for (const p of state.players) {
      v.progress[p.id] = Object.keys(state.entries[p.id] || {}).length;
    }
    v.totalToFill = state.puzzle.filter((x) => x === 0).length;
    v.turn = state.players.filter((p) => !state.solved[p.id]).map((p) => p.id);
    if (state.winnerId) v.turn = [];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    if (state.solved[playerId]) return { ok: false, error: 'You already solved it.' };
    const events = [];
    if (action.type === 'set') {
      const cell = Number(action.cell);
      const value = Number(action.value);
      if (!(cell >= 0 && cell < CELLS)) return { ok: false, error: 'Bad square.' };
      if (!(value >= 1 && value <= 9)) return { ok: false, error: 'Pick a number from 1 to 9.' };
      if (state.puzzle[cell]) return { ok: false, error: 'That square is a given.' };
      if (state.entries[playerId][cell] === value) return { ok: false, error: 'That number is already there.' };
      if (state.solution[cell] !== value) {
        state.mistakes[playerId] = (state.mistakes[playerId] || 0) + 1;
        return { ok: false, error: 'That number cannot go there.' };
      }
      state.entries[playerId][cell] = value;
      const filled = Object.keys(state.entries[playerId]).length;
      const needed = state.puzzle.filter((x) => x === 0).length;
      if (filled >= needed) {
        state.solved[playerId] = true;
        U.addScore(state, playerId, 100 - (state.mistakes[playerId] || 0) * 5);
        state.winnerId = [playerId];
        state.summary = `${U.byId(state, playerId)?.name} solved the grid first!`;
        events.push(U.event(state.summary, 'win'));
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    if (action.type === 'clear') {
      const cell = Number(action.cell);
      if (!(cell >= 0 && cell < CELLS)) return { ok: false, error: 'Bad square.' };
      if (state.entries[playerId][cell] === undefined) return { ok: false, error: 'Nothing to clear.' };
      delete state.entries[playerId][cell];
      return { ok: true, events: [] };
    }
    if (action.type === 'hint') {
      if ((state.hints[playerId] || 0) <= 0) return { ok: false, error: 'No hints left.' };
      const empty = [];
      for (let i = 0; i < CELLS; i++) if (!state.puzzle[i] && state.entries[playerId][i] === undefined) empty.push(i);
      if (!empty.length) return { ok: false, error: 'Nothing left to hint.' };
      const cell = U.pick(empty);
      state.hints[playerId]--;
      state.entries[playerId][cell] = state.solution[cell];
      events.push(U.event(`${U.byId(state, playerId)?.name} used a hint (${state.hints[playerId]} left).`, 'info'));
      const filled = Object.keys(state.entries[playerId]).length;
      const needed = state.puzzle.filter((x) => x === 0).length;
      if (filled >= needed) {
        state.solved[playerId] = true;
        U.addScore(state, playerId, 80);
        state.winnerId = [playerId];
        state.summary = `${U.byId(state, playerId)?.name} finished with a hint!`;
        events.push(U.event(state.summary, 'win'));
      }
      for (const e of events) U.addLog(state, e.text, e.kind);
      return { ok: true, events };
    }
    return { ok: false, error: 'Unknown action.' };
  },
  bot(state, playerId) {
    if (state.solved[playerId]) return null;
    const level = U.byId(state, playerId)?.level ?? 2;
    const entries = state.entries[playerId] || {};
    const empty = [];
    for (let i = 0; i < CELLS; i++) if (!state.puzzle[i] && entries[i] === undefined) empty.push(i);
    if (!empty.length) return null;
    if (level >= 4) {
      // Higher difficulty bots pick the most constrained square, like a solver.
      const scored = empty.map((cell) => {
        const x = cell % SIZE;
        const y = Math.floor(cell / SIZE);
        const seen = new Set();
        for (let i = 0; i < SIZE; i++) {
          seen.add(state.puzzle[y * SIZE + i] || entries[y * SIZE + i]);
          seen.add(state.puzzle[i * SIZE + x] || entries[i * SIZE + x]);
        }
        return { cell, count: seen.size };
      });
      scored.sort((a, b) => b.count - a.count);
      return { type: 'set', cell: scored[0].cell, value: state.solution[scored[0].cell] };
    }
    const cell = U.pick(empty);
    return { type: 'set', cell, value: state.solution[cell] };
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send, host }) {
    const ui = host?.uiState || (host ? (host.uiState = {}) : {});
    const mine = view.myEntries || {};
    el.appendChild(UI.h('div', { class: 'phase-bar' },
      UI.pill(view.difficultyName),
      UI.pill(`${Object.keys(mine).length}/${view.totalToFill} filled`),
      UI.pill(`Mistakes: ${view.myMistakes}`),
      UI.pill(`Hints: ${view.hintsLeft}`)));
    const values = [];
    for (let i = 0; i < CELLS; i++) values.push(view.puzzle[i] || mine[i] || 0);
    el.appendChild(UI.h('div', { class: 'board sudoku', style: { '--cols': 9, '--rows': 9 } },
      values.map((value, i) => {
        const given = !!view.puzzle[i];
        const selected = ui.cell === i;
        const x = i % 9;
        const y = Math.floor(i / 9);
        return UI.h('button', {
          class: `cell ${given ? 'given' : 'entry'} ${selected ? 'active' : ''} ${x % 3 === 0 ? 'edge-left' : ''} ${y % 3 === 0 ? 'edge-top' : ''}`,
          onClick: () => {
            ui.cell = i;
            host?.refresh?.();
          },
          disabled: given,
        }, String(value || ''));
      })));
    const selected = typeof ui.cell === 'number' ? ui.cell : -1;
    if (selected >= 0 && !view.puzzle[selected] && !view.solved[playerId]) {
      el.appendChild(UI.h('div', { class: 'pad' }, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => UI.btn(String(n), () => {
        send({ type: 'set', cell: selected, value: n });
        ui.cell = -1;
        host?.refresh?.();
      }, { size: 'sm' }))));
      el.appendChild(UI.row(
        UI.btn('Clear', () => {
          send({ type: 'clear', cell: selected });
          ui.cell = -1;
          host?.refresh?.();
        }, { size: 'sm' }),
        UI.btn('Hint', () => {
          send({ type: 'hint' });
          ui.cell = -1;
          host?.refresh?.();
        }, { size: 'sm', disabled: view.hintsLeft <= 0 }),
      ));
    } else {
      el.appendChild(UI.muted('Tap an empty square, then a number.'));
    }
    el.appendChild(UI.h('div', { class: 'waiting-list' }, view.players.map((p) => UI.h('span', { class: `chip ${view.solved[p.id] ? 'done' : ''}` }, `${p.name}: ${view.progress[p.id]}/${view.totalToFill}${view.solved[p.id] ? ' 🏆' : ''}`))));
  },
};

export default { sudoku };
