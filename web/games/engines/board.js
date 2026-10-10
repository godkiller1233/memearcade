/**
 * Board family: Tic-Tac-Toe, Ultimate Tic-Tac-Toe, Connect Four, Checkers,
 * Battleship.
 *
 * Every engine exposes the same contract used by the browser (solo/local) and
 * the Node server (authoritative online play):
 *   meta, create(), view(state, viewerId), act(state, seatId, action),
 *   bot(state, seatId) -> legal action, over(state), render({el, view, send})
 *
 * bot() must return a legal action for ANY seat - including a bot sitting in a
 * party game - because the server tick and the test harness both rely on it.
 */
import * as U from './util.js';
import * as UI from './ui.js';
import * as Art from './art.js';

const MODES = ['solo', 'local', 'online'];

/* ========================================================================= *
 * Tic-Tac-Toe
 * ========================================================================= */

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function tttWinner(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { mark: board[a], line: [a, b, c] };
  }
  return null;
}

function tttBest(board, mark, depth = 0, alpha = -Infinity, beta = Infinity) {
  const win = tttWinner(board);
  if (win) return { score: win.mark === mark ? 10 - depth : depth - 10, move: -1 };
  if (board.every(Boolean)) return { score: 0, move: -1 };
  const moves = [];
  for (let i = 0; i < 9; i++) {
    if (board[i]) continue;
    board[i] = mark;
    const res = tttBest(board, mark === 'X' ? 'O' : 'X', depth + 1, alpha, beta);
    board[i] = null;
    moves.push({ move: i, score: res.score });
    if (mark === 'X') alpha = Math.max(alpha, res.score);
    else beta = Math.min(beta, res.score);
    if (beta <= alpha) break;
  }
  moves.sort((a, b) => (mark === 'X' ? b.score - a.score : a.score - b.score));
  return moves[0] || { score: 0, move: -1 };
}

export const ticTacToe = {
  meta: {
    id: 'tic-tac-toe',
    name: 'Tic-Tac-Toe',
    category: 'board',
    players: { min: 2, max: 2 },
    modes: MODES,
    blurb: 'Three in a row. Bots above level 4 play perfectly.',
    tags: ['classic', 'quick'],
    minutes: 2,
    status: 'playable',
    bots: true,
    boardSize: 9,
    rules: ['Take turns claiming a square.', 'First to three in a row wins.', 'Full board with no line is a draw.'],
    options: [{ id: 'bestOf', label: 'Best of', type: 'select', values: [1, 3, 5], default: 1 }],
  },
  create({ players, seed, rng, options = {} }) {
    const state = U.baseState({ players, seed });
    state.board = Array(9).fill(null);
    state.marks = { [state.players[0].id]: 'X', [state.players[1].id]: 'O' };
    state.bestOf = options.bestOf || 1;
    state.roundWins = {};
    for (const p of state.players) state.roundWins[p.id] = 0;
    state.round = 1;
    state.turnId = state.players[0].id;
    U.addLog(state, 'Game on - X moves first.');
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.board = state.board;
    v.marks = state.marks;
    v.myMark = state.marks[viewerId] || null;
    v.winLine = state.winLine || null;
    v.round = state.round || 1;
    v.bestOf = state.bestOf || 1;
    v.roundWins = state.roundWins || {};
    v.turn = state.winnerId || state.draw ? [] : [state.turnId];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId || state.draw) return { ok: false, error: 'The round is already over.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
    if (action.type !== 'place') return { ok: false, error: 'Unknown move.' };
    const i = Number(action.i);
    if (!(i >= 0 && i < 9) || state.board[i]) return { ok: false, error: 'That square is taken.' };
    state.board[i] = state.marks[playerId];
    const win = tttWinner(state.board);
    const events = [];
    if (win) {
      state.winnerId = playerId;
      state.winLine = win.line;
      state.roundWins[playerId] = (state.roundWins[playerId] || 0) + 1;
      state.summary = `${U.byId(state, playerId)?.name} wins round ${state.round}!`;
      state.turnId = null;
      events.push(U.event(state.summary, 'win'));
    } else if (state.board.every(Boolean)) {
      state.draw = true;
      state.turnId = null;
      state.summary = 'Draw - board full.';
      events.push(U.event(state.summary, 'draw'));
    } else {
      state.turnId = otherId(state, playerId);
      events.push(U.event(`${U.byId(state, playerId)?.name} played ${asciiSquare(i)}.`, 'move'));
    }
    U.addLog(state, events[events.length - 1].text);
    return { ok: true, events };
  },
  bot(state, playerId) {
    if (playerId !== state.turnId) return null;
    const empty = state.board.map((c, i) => (c ? null : i)).filter((i) => i !== null);
    if (!empty.length) return null;
    const level = U.byId(state, playerId)?.level ?? 2;
    if (level <= 1 || state.board.filter(Boolean).length < 2) return { type: 'place', i: U.pick(empty) };
    if (level >= 4) {
      const best = tttBest(state.board.slice(), state.marks[playerId]);
      return { type: 'place', i: best.move >= 0 ? best.move : U.pick(empty) };
    }
    // mid difficulty: take a win, block a loss, otherwise random-ish
    const mark = state.marks[playerId];
    const foe = mark === 'X' ? 'O' : 'X';
    for (const i of empty) {
      const test = state.board.slice();
      test[i] = mark;
      if (tttWinner(test)) return { type: 'place', i };
    }
    for (const i of empty) {
      const test = state.board.slice();
      test[i] = foe;
      if (tttWinner(test)) return { type: 'place', i };
    }
    if (state.board[4] === null) return { type: 'place', i: 4 };
    return { type: 'place', i: U.pick(empty) };
  },
  over(state) {
    if (state.winnerId || state.draw) {
      const wins = state.roundWins || {};
      const target = Math.ceil((state.bestOf || 1) / 2);
      const leaderId = Object.keys(wins).sort((a, b) => wins[b] - wins[a])[0];
      const seriesOver = (state.bestOf || 1) === 1 || (leaderId && wins[leaderId] >= target);
      if (seriesOver) {
        return { over: true, winners: state.winnerId ? [state.winnerId] : [], scores: seriesScore(state), summary: state.summary };
      }
      // next round
      state.round++;
      state.board = Array(9).fill(null);
      state.winnerId = null;
      state.draw = false;
      state.winLine = null;
      state.turnId = state.players[(state.round - 1) % 2].id;
      U.addLog(state, `Round ${state.round} - ${U.byId(state, state.turnId)?.name} starts.`);
      return { over: false };
    }
    return { over: false };
  },
  render({ el, view, playerId, send, host }) {
    const interactive = !view.turn.includes(playerId) || host?.role === 'spectator';
    el.appendChild(UI.turnBanner(view, { label: view.winLine ? view.summary || 'Round over' : null }));
    if (view.bestOf > 1) el.appendChild(UI.row(...view.players.map((p) => UI.pill(`${p.name}: ${view.roundWins?.[p.id] || 0}`))));
    el.appendChild(
      Art.boardStage('tic-tac-toe', { width: 620, height: 620 },
        UI.gridBoard(3, 3, (x, y) => {
          const i = y * 3 + x;
          const mark = view.board[i];
          const inLine = view.winLine?.includes(i);
          // X and O take opposite ends of the palette, the way the canvas
          // sprites are lit: one warm, one cold, so the board reads at a
          // glance whose square is whose.
          return UI.gridButton(mark || '', () => send({ type: 'place', i }), {
            className: `${mark ? `filled mark-${mark === 'X' ? 'x' : 'o'}` : ''} ${inLine ? 'win' : ''}`,
            disabled: interactive || !!mark,
          });
        }, { className: 'ttt' })),
    );
  },
};

function seriesScore(state) {
  const out = {};
  for (const p of state.players) out[p.id] = state.roundWins?.[p.id] || 0;
  return out;
}

function asciiSquare(i) {
  return `${'ABC'[i % 3]}${Math.floor(i / 3) + 1}`;
}

/** The other seat in a two-player game. */
function otherId(state, id) {
  return state.players.find((p) => p.id !== id)?.id || null;
}

/* ========================================================================= *
 * Ultimate Tic-Tac-Toe
 * ========================================================================= */

export const ultimateTtt = {
  meta: {
    id: 'ultimate-ttt',
    name: 'Ultimate Tic-Tac-Toe',
    category: 'board',
    players: { min: 2, max: 2 },
    modes: MODES,
    blurb: 'Win small boards to claim the big one - but your move sends your rival to a specific board.',
    tags: ['strategy'],
    minutes: 12,
    status: 'playable',
    bots: true,
    rules: [
      'Nine mini-boards; winning a mini-board claims it on the macro board.',
      'The square you play decides which mini-board your opponent must play in next.',
      'If that board is finished, they may play anywhere.',
      'Win three macro cells in a row to win the game.',
    ],
  },
  create({ players, seed }) {
    const state = U.baseState({ players, seed });
    state.boards = Array.from({ length: 9 }, () => Array(9).fill(null));
    state.macro = Array(9).fill(null);
    state.marks = { [state.players[0].id]: 'X', [state.players[1].id]: 'O' };
    state.active = null; // null => free choice
    state.turnId = state.players[0].id;
    state.macroLines = null;
    U.addLog(state, 'Ultimate Tic-Tac-Toe - X starts anywhere.');
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.boards = state.boards;
    v.macro = state.macro;
    v.marks = state.marks;
    v.active = state.active;
    v.macroLines = state.macroLines;
    v.myMark = state.marks[viewerId];
    v.turn = state.winnerId || state.draw ? [] : [state.turnId];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId || state.draw) return { ok: false, error: 'Game is over.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
    const b = Number(action.board);
    const c = Number(action.cell);
    if (!(b >= 0 && b < 9) || !(c >= 0 && c < 9)) return { ok: false, error: 'Bad cell.' };
    if (state.active !== null && b !== state.active) return { ok: false, error: `You must play in board ${state.active + 1}.` };
    if (state.macro[b]) return { ok: false, error: 'That board is already won.' };
    if (state.boards[b][c]) return { ok: false, error: 'Taken.' };
    state.boards[b][c] = state.marks[playerId];
    const events = [U.event(`${U.byId(state, playerId)?.name} played board ${b + 1}, cell ${c + 1}.`, 'move')];
    const localWin = tttWinner(state.boards[b]);
    if (localWin) {
      state.macro[b] = state.marks[playerId];
      events.push(U.event(`Board ${b + 1} claimed by ${U.byId(state, playerId)?.name}.`, 'win'));
    } else if (state.boards[b].every(Boolean)) {
      state.macro[b] = 'D';
      events.push(U.event(`Board ${b + 1} is a draw.`, 'draw'));
    }
    const macroWin = tttWinner(state.macro.map((m) => (m === 'D' ? null : m)));
    if (macroWin) {
      state.winnerId = playerId;
      state.macroLines = macroWin.line;
      state.summary = `${U.byId(state, playerId)?.name} wins the macro board!`;
      events.push(U.event(state.summary, 'win'));
    } else if (state.macro.every(Boolean)) {
      state.draw = true;
      state.summary = 'Every board filled - draw.';
    } else {
      const next = state.macro[c] ? null : c;
      state.active = next;
      state.turnId = otherId(state, playerId);
      events.push(U.event(next === null ? 'Target board finished - free move next.' : `Next: play in board ${next + 1}.`, 'info'));
    }
    for (const e of events) U.addLog(state, e.text, e.kind);
    return { ok: true, events };
  },
  bot(state, playerId) {
    if (playerId !== state.turnId) return null;
    const mark = state.marks[playerId];
    const foe = mark === 'X' ? 'O' : 'X';
    const legal = [];
    const boardsToScan = state.active === null ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : [state.active];
    for (const b of boardsToScan) {
      if (state.macro[b]) continue;
      for (let c = 0; c < 9; c++) if (!state.boards[b][c]) legal.push({ b, c });
    }
    if (!legal.length) return null;
    const level = U.byId(state, playerId)?.level ?? 2;
    if (level <= 2 && Math.random() < 0.7) return { type: 'play', board: U.pick(legal).b, cell: U.pick(legal).c };
    const score = ({ b, c }) => {
      let s = 0;
      const test = state.boards[b].slice();
      test[c] = mark;
      if (tttWinner(test)) s += 100;
      if (state.macro[c] === undefined) s += 0;
      if (!state.macro[c]) s += 12; // send them somewhere useful for us
      const test2 = state.boards[b].slice();
      test2[c] = foe;
      if (tttWinner(test2)) s += 60;
      if (U.byId(state, state.turnId) === undefined) s += 0;
      const centreBonus = [4, 0, 2, 6, 8, 1, 3, 5, 7].indexOf(c);
      s += (8 - centreBonus) * 0.5;
      return s;
    };
    legal.sort((a, b) => score(b) - score(a));
    return { type: 'play', board: legal[0].b, cell: legal[0].c };
  },
  over(state) {
    if (state.winnerId || state.draw) return U.simpleOver(state, { draw: !!state.draw });
    return { over: false };
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.turnBanner(view));
    el.appendChild(
      Art.boardStage('ultimate-ttt', { width: 720, height: 720 },
        UI.h('div', { class: 'macro-grid' },
        view.boards.map((board, b) => {
          const claimed = view.macro[b];
          const forced = view.active === null || view.active === b;
          const box = UI.gridBoard(3, 3, (x, y) => {
            const c = y * 3 + x;
            const mark = board[c];
            return UI.gridButton(mark || '', () => send({ type: 'play', board: b, cell: c }), {
              className: `${mark ? `filled mark-${mark === 'X' ? 'x' : 'o'}` : ''} ${view.macroLines?.includes(b) ? 'win' : ''}`,
              disabled: !forced || !!mark || !!claimed || !view.turn.includes(playerId),
            });
          }, { className: `mini ${forced ? 'allowed' : 'blocked'} ${claimed ? 'claimed' : ''}` });
          return UI.h('div', { class: 'mini-wrap' }, box, claimed ? UI.h('span', { class: 'stamp', text: claimed === 'D' ? '=' : claimed }) : null);
        }))),
    );
  },
};

/* ========================================================================= *
 * Connect Four
 * ========================================================================= */

export const connectFour = {
  meta: {
    id: 'connect-four',
    name: 'Connect Four',
    category: 'board',
    players: { min: 2, max: 2 },
    modes: MODES,
    blurb: 'Drop a disc, build a line of four. Watch out for diagonal setups.',
    tags: ['classic'],
    minutes: 5,
    status: 'playable',
    bots: true,
    rules: ['Discs fall to the lowest free slot.', 'Line of four horizontally, vertically or diagonally wins.'],
    options: [{ id: 'width', label: 'Columns', type: 'select', values: [7, 8], default: 7 }],
  },
  create({ players, seed, options = {} }) {
    const state = U.baseState({ players, seed });
    state.w = options.width === 8 ? 8 : 7;
    state.h = 6;
    state.grid = Array.from({ length: state.h }, () => Array(state.w).fill(null));
    state.colors = { [state.players[0].id]: 'red', [state.players[1].id]: 'yellow' };
    state.turnId = state.players[0].id;
    U.addLog(state, 'Red starts.');
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.grid = state.grid;
    v.w = state.w;
    v.h = state.h;
    v.colors = state.colors;
    v.myColor = state.colors[viewerId];
    v.winCells = state.winCells || null;
    v.turn = state.winnerId || state.draw ? [] : [state.turnId];
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId || state.draw) return { ok: false, error: 'Game over.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
    const col = Number(action.col);
    if (!(col >= 0 && col < state.w)) return { ok: false, error: 'Bad column.' };
    const row = dropRow(state, col);
    if (row < 0) return { ok: false, error: 'That column is full.' };
    state.grid[row][col] = state.colors[playerId];
    const win = findFour(state.grid, state.w, state.h);
    const events = [U.event(`${U.byId(state, playerId)?.name} dropped in column ${col + 1}.`, 'move')];
    if (win) {
      state.winnerId = playerId;
      state.winCells = win;
      state.summary = `${U.byId(state, playerId)?.name} connects four!`;
      events.push(U.event(state.summary, 'win'));
      U.addScore(state, playerId, 1);
    } else if (state.grid[0].every(Boolean)) {
      state.draw = true;
      state.summary = 'Board full - draw.';
    } else {
      state.turnId = otherId(state, playerId);
    }
    for (const e of events) U.addLog(state, e.text, e.kind);
    return { ok: true, events };
  },
  bot(state, playerId) {
    if (playerId !== state.turnId) return null;
    const legal = [];
    for (let c = 0; c < state.w; c++) if (dropRow(state, c) >= 0) legal.push(c);
    if (!legal.length) return null;
    const level = U.byId(state, playerId)?.level ?? 2;
    const me = state.colors[playerId];
    const foe = state.colors[otherId(state, playerId)];
    if (level <= 1) return { type: 'drop', col: U.pick(legal) };
    for (const c of legal) if (simulateWin(state, c, me)) return { type: 'drop', col: c };
    for (const c of legal) if (simulateWin(state, c, foe)) return { type: 'drop', col: c };
    if (level >= 3) {
      const scored = legal.map((c) => {
        const row = dropRow(state, c);
        let s = 6 - Math.abs(3 - c);
        s += (5 - Math.abs(5 - row)) * 0.7;
        return { c, s };
      });
      scored.sort((a, b) => b.s - a.s);
      return { type: 'drop', col: scored[0].c };
    }
    return { type: 'drop', col: legal[Math.floor(legal.length / 2)] };
  },
  over(state) {
    return U.simpleOver(state, { draw: !!state.draw });
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.turnBanner(view));
    const canPlay = view.turn.includes(playerId);
    el.appendChild(
      Art.boardStage('connect-four', { width: 760, height: 680 },
        UI.gridBoard(view.w, view.h, (x, y) => {
          const disc = view.grid[y][x];
          const isWin = view.winCells?.some(([wy, wx]) => wy === y && wx === x);
          return UI.gridButton('', () => send({ type: 'drop', col: x }), {
            className: `disc ${disc || ''} ${isWin ? 'win' : ''}`,
            disabled: !canPlay || !!view.grid[0][x],
          });
        }, { className: 'connect4' })),
    );
  },
};

function dropRow(state, col) {
  for (let r = state.h - 1; r >= 0; r--) if (!state.grid[r][col]) return r;
  return -1;
}

function simulateWin(state, col, color) {
  const row = dropRow(state, col);
  if (row < 0) return false;
  const grid = state.grid.map((r) => r.slice());
  grid[row][col] = color;
  return !!findFour(grid, state.w, state.h);
}

function findFour(grid, w, h) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const color = grid[y][x];
      if (!color) continue;
      for (const [dx, dy] of dirs) {
        const cells = [[y, x]];
        for (let k = 1; k < 4; k++) {
          const nx = x + dx * k;
          const ny = y + dy * k;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || grid[ny][nx] !== color) break;
          cells.push([ny, nx]);
        }
        if (cells.length === 4) return cells;
      }
    }
  }
  return null;
}

/* ========================================================================= *
 * Checkers (draughts with forced captures)
 * ========================================================================= */

export const checkers = {
  meta: {
    id: 'checkers',
    name: 'Checkers',
    category: 'board',
    players: { min: 2, max: 2 },
    modes: MODES,
    blurb: 'Forced captures, chained multi-jumps and king promotion.',
    tags: ['classic'],
    minutes: 15,
    status: 'playable',
    bots: true,
    rules: [
      'Men move one diagonal step forward; kings move one step any direction.',
      'Captures are mandatory, and a capture chain must be finished in one turn.',
      'Reaching the far row promotes a king.',
      'You win when your opponent has no pieces or no legal moves.',
    ],
  },
  create({ players, seed }) {
    const state = U.baseState({ players, seed });
    state.board = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (let y = 0; y < 3; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2 === 1) state.board[y][x] = { owner: state.players[0].id, king: false };
    for (let y = 5; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2 === 1) state.board[y][x] = { owner: state.players[1].id, king: false };
    state.turnId = state.players[0].id;
    state.chain = null; // {x,y} when a multi-jump is mid-flight
    state.quietMoves = 0;
    U.addLog(state, `${state.players[0].name} (dark) moves first.`);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.board = state.board;
    v.chain = state.chain;
    v.moves = state.turnId && !state.winnerId && !state.draw ? allMoves(state, state.turnId) : [];
    v.turn = state.winnerId || state.draw ? [] : [state.turnId];
    v.side = state.players[0].id === viewerId ? 'dark' : 'light';
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId || state.draw) return { ok: false, error: 'Game over.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
    const from = state.chain || { x: Number(action.x), y: Number(action.y) };
    // During a chain only continuations from that square count; otherwise the
    // full move list (jumps-only when a capture is available) applies - which
    // is what makes captures mandatory.
    const moves = state.chain ? legalMoves(state, playerId, from) : allMoves(state, playerId);
    const move = moves.find((m) => m.from.x === from.x && m.from.y === from.y && m.to.x === Number(action.tx) && m.to.y === Number(action.ty));
    if (!move) return { ok: false, error: 'Illegal move (captures are mandatory).' };
    const piece = state.board[from.y][from.x];
    state.board[from.y][from.x] = null;
    state.board[move.to.y][move.to.x] = piece;
    if (move.jump && move.over) state.board[move.over.y][move.over.x] = null; // captured piece leaves the board
    const events = [U.event(`${U.byId(state, playerId)?.name} ${move.jump ? 'jumped' : 'moved'} ${coord(from)}→${coord(move.to)}.`, 'move')];
    let promoted = false;
    const homeRow = state.players[0].id === playerId ? 7 : 0;
    if (!piece.king && move.to.y === homeRow) {
      piece.king = true;
      promoted = true;
      events.push(U.event(`King promoted at ${coord(move.to)}!`, 'win'));
    }
    // 40-move rule: without it two roving kings can circle each other forever.
    state.quietMoves = move.jump || promoted ? 0 : (state.quietMoves || 0) + 1;
    const chained = move.jump ? legalMoves(state, playerId, move.to).filter((m) => m.jump) : [];
    if (chained.length && !promoted) {
      state.chain = { x: move.to.x, y: move.to.y };
      events.push(U.event('Chain jump available - keep going.', 'info'));
    } else {
      state.chain = null;
      state.turnId = otherId(state, playerId);
      checkEnd(state, events);
      if (!state.winnerId && (state.quietMoves || 0) >= 80) {
        state.draw = true;
        state.summary = 'Draw - 40 moves without a capture.';
        events.push(U.event(state.summary, 'draw'));
      }
    }
    for (const e of events) U.addLog(state, e.text, e.kind);
    return { ok: true, events };
  },
  bot(state, playerId) {
    const from = state.chain;
    if (!from && playerId !== state.turnId) return null;
    const moves = from ? legalMoves(state, playerId, from) : allMoves(state, playerId);
    if (!moves.length) return null;
    const scored = moves.map((m) => {
      let s = m.jump ? 10 : 1;
      const piece = state.board[m.from.y][m.from.x];
      if (piece && !piece.king) {
        const homeRow = state.players[0].id === playerId ? 7 : 0;
        if (m.to.y === homeRow) s += 8;
        else s -= Math.abs(homeRow - m.to.y) * 0.2;
      }
      // prefer moves that are not immediately capturable
      const board = state.board.map((row) => row.map((c) => (c ? { ...c } : null)));
      board[m.from.y][m.from.x] = null;
      board[m.to.y][m.to.x] = piece;
      const foeMoves = allMovesOn(state, board, otherId(state, playerId));
      if (foeMoves.some((fm) => fm.jump && fm.to.x === m.to.x && fm.to.y === m.to.y)) s -= 6;
      s += Math.random() * 0.5;
      return { m, s };
    });
    scored.sort((a, b) => b.s - a.s);
    const level = U.byId(state, playerId)?.level ?? 2;
    const best = level >= 3 ? scored[0].m : U.pick(moves);
    return { type: 'move', x: best.from.x, y: best.from.y, tx: best.to.x, ty: best.to.y };
  },
  over(state) {
    return U.simpleOver(state, { draw: !!state.draw });
  },
  render({ el, view, playerId, send }) {
    el.appendChild(UI.turnBanner(view));
    const selected = view.chain;
    const moves = view.moves || [];
    el.appendChild(Art.boardStage('checkers', { width: 760, height: 820 },
      UI.h('div', { class: 'checkers-wrap' },
        UI.gridBoard(8, 8, (x, y) => {
          const piece = view.board[y][x];
          const dark = (x + y) % 2 === 1;
          const isMine = piece && piece.owner === playerId;
          const canGo = moves.some((m) => !view.chain && m.from.x === x && m.from.y === y) || (view.chain && view.chain.x === x && view.chain.y === y);
          // A landing square is lit, and a piece that owes a mandatory jump
          // carries its own rim: the same "this is the one" cue the canvas
          // sprites get from their rim light.
          const jump = moves.some((m) => m.from.x === x && m.from.y === y && m.jump);
          const isTarget = moves.some((m) => m.to.x === x && m.to.y === y);
          return UI.gridButton(
            piece ? UI.h('span', { class: `piece ${piece.owner === view.players[0].id ? 'dark' : 'light'} ${piece.king ? 'king' : ''}` }) : '',
            () => {
              if (isMine && !view.chain) send({ type: 'select', x, y });
            },
            { className: `${dark ? 'dark-square' : 'light-square'} ${canGo ? 'selectable' : ''} ${isMine ? 'mine' : ''} ${jump ? 'jump' : ''} ${isTarget ? 'target' : ''}` },
          );
        }, { className: 'checkers' }),
        UI.h('div', { class: 'hint-block' },
          selected ? UI.pill(`Chained from ${coord(selected)} - pick a landing square`) : UI.muted('Tap a piece, then a highlighted target.'),
          UI.h('div', { class: 'targets' },
            moves.map((m) => UI.btn(`${coord(m.from)}→${coord(m.to)}${m.jump ? ' (jump)' : ''}`, () => send({ type: 'move', x: m.from.x, y: m.from.y, tx: m.to.x, ty: m.to.y }), { size: 'sm' })),
          ),
        ))));
  },
};

function coord(p) {
  return `${'abcdefgh'[p.x]}${8 - p.y}`;
}

/**
 * All moves available to a player, applying the mandatory-capture rule:
 * if any piece can jump, only jumps are legal this turn.
 */
function allMoves(state, playerId) {
  const moves = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const piece = state.board[y][x];
      if (piece && piece.owner === playerId) moves.push(...legalMoves(state, playerId, { x, y }));
    }
  }
  const jumps = moves.filter((m) => m.jump);
  return jumps.length ? jumps : moves;
}

function allMovesOn(state, board, playerId) {
  const realBoard = state.board;
  state.board = board;
  const moves = allMoves(state, playerId);
  state.board = realBoard;
  return moves;
}

export function legalMoves(state, playerId, from = null) {
  const out = [];
  const dirsFor = (piece) => (piece.king ? [[1, 1], [1, -1], [-1, 1], [-1, -1]] : state.players[0].id === piece.owner ? [[1, 1], [1, -1]] : [[-1, 1], [-1, -1]]);
  const scan = (x, y) => {
    const piece = state.board[y][x];
    if (!piece || piece.owner !== playerId) return;
    const dirs = dirsFor(piece);
    for (const [dx, dy] of dirs) {
      const stepX = x + dx;
      const stepY = y + dy;
      if (stepX < 0 || stepY < 0 || stepX > 7 || stepY > 7) continue;
      const target = state.board[stepY][stepX];
      if (!target) {
        out.push({ from: { x, y }, to: { x: stepX, y: stepY }, jump: false });
        continue;
      }
      if (target.owner === playerId) continue;
      const jumpX = x + dx * 2;
      const jumpY = y + dy * 2;
      if (jumpX < 0 || jumpY < 0 || jumpX > 7 || jumpY > 7) continue;
      if (!state.board[jumpY][jumpX]) out.push({ from: { x, y }, to: { x: jumpX, y: jumpY }, jump: true, over: { x: stepX, y: stepY } });
    }
  };
  if (from) scan(from.x, from.y);
  else for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) scan(x, y);
  const jumps = out.filter((m) => m.jump);
  return jumps.length ? jumps : out;
}

function checkEnd(state, events) {
  for (const p of state.players) {
    const foe = state.players.find((x) => x.id !== p.id);
    const pieces = countPieces(state, p.id);
    const foePieces = countPieces(state, foe.id);
    if (foePieces === 0 || (state.turnId === foe.id && allMoves(state, foe.id).length === 0)) {
      state.winnerId = p.id;
      state.summary = `${p.name} wins checkers!`;
      U.addScore(state, p.id, 1);
      events.push(U.event(state.summary, 'win'));
      return;
    }
    if (pieces === 0) {
      state.winnerId = foe.id;
      state.summary = `${foe.name} wins checkers!`;
      U.addScore(state, foe.id, 1);
      events.push(U.event(state.summary, 'win'));
      return;
    }
  }
}

function countPieces(state, owner) {
  let n = 0;
  for (const row of state.board) for (const cell of row) if (cell && cell.owner === owner) n++;
  return n;
}

/* ========================================================================= *
 * Battleship
 * ========================================================================= */

const FLEET = [
  { id: 'carrier', name: 'Carrier', size: 5 },
  { id: 'battleship', name: 'Battleship', size: 4 },
  { id: 'cruiser', name: 'Cruiser', size: 3 },
  { id: 'submarine', name: 'Submarine', size: 3 },
  { id: 'destroyer', name: 'Destroyer', size: 2 },
];

export const battleship = {
  meta: {
    id: 'battleship',
    name: 'Battleship',
    category: 'board',
    players: { min: 2, max: 2 },
    modes: MODES,
    secret: true,
    blurb: 'Place your fleet in secret, then trade shots until one navy is sunk.',
    tags: ['naval'],
    minutes: 15,
    status: 'playable',
    bots: true,
    rules: [
      'Each player hides five ships on a 10x10 grid.',
      'Fire one shot per turn: hit, miss or sunk.',
      'Your own grid is private - opponents only see the shots they fired.',
    ],
    options: [{ id: 'size', label: 'Grid', type: 'select', values: [8, 10], default: 10 }],
  },
  create({ players, seed, options = {} }) {
    const state = U.baseState({ players, seed });
    state.size = options.size === 8 ? 8 : 10;
    state.fleetSize = state.size === 8 ? 4 : 5;
    state.boards = {};
    state.shots = {};
    state.placed = {};
    for (const p of state.players) {
      state.boards[p.id] = [];
      state.shots[p.id] = [];
      state.placed[p.id] = false;
    }
    state.phase = 'place';
    state.turnId = null;
    U.addLog(state, 'Place your fleet, then fire away.');
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    const foe = state.players.find((p) => p.id !== viewerId)?.id;
    v.size = state.size;
    v.phase = state.phase;
    v.myBoard = state.boards[viewerId] || null;
    v.myShots = state.shots[viewerId] || [];
    v.enemyShots = state.shots[foe] || [];
    v.placed = state.placed[viewerId] || false;
    v.enemyPlaced = state.placed[foe] || false;
    v.enemySunk = state.boards[foe] ? state.boards[foe].filter((s) => s.sunk).map((s) => ({ id: s.id, name: s.name })) : [];
    v.placedCount = Object.values(state.placed).filter(Boolean).length;
    v.fleet = FLEET.slice(0, state.fleetSize);
    v.turn = state.phase === 'battle' && !state.winnerId ? [state.turnId] : state.phase === 'place' ? state.players.filter((p) => !state.placed[p.id]).map((p) => p.id) : [];
    return v;
  },
  act(state, playerId, action) {
    if (state.phase === 'place') {
      if (state.placed[playerId]) return { ok: false, error: 'You already locked in your fleet.' };
      if (action.type === 'place-ship') {
        const ship = FLEET.slice(0, state.fleetSize).find((f) => f.id === action.ship);
        if (!ship) return { ok: false, error: 'Unknown ship.' };
        const placed = state.boards[playerId];
        if (placed.some((s) => s.id === ship.id)) return { ok: false, error: 'That ship is already placed.' };
        const cells = shipCells(ship, Number(action.x), Number(action.y), action.dir === 'v' ? 'v' : 'h', state.size);
        if (!cells) return { ok: false, error: 'It does not fit there.' };
        if (cells.some(([x, y]) => placed.some((s) => s.cells.some(([cx, cy]) => cx === x && cy === y)))) {
          return { ok: false, error: 'Ships cannot overlap.' };
        }
        placed.push({ ...ship, cells, hits: [], sunk: false });
        return { ok: true, events: [U.event(`${U.byId(state, playerId)?.name} placed ${ship.name}.`, 'info')] };
      }
      if (action.type === 'auto-place') {
        state.boards[playerId] = randomFleet(state, playerId);
        return { ok: true, events: [U.event('Fleet auto-placed.', 'info')] };
      }
      if (action.type === 'clear') {
        state.boards[playerId] = [];
        return { ok: true, events: [] };
      }
      if (action.type === 'ready') {
        if (state.boards[playerId].length < state.fleetSize) return { ok: false, error: `Place all ${state.fleetSize} ships first.` };
        state.placed[playerId] = true;
        const events = [U.event(`${U.byId(state, playerId)?.name} is ready.`, 'info')];
        if (state.players.every((p) => state.placed[p.id])) {
          state.phase = 'battle';
          state.turnId = state.players[0].id;
          events.push(U.event('Battle stations!', 'win'));
        }
        return { ok: true, events };
      }
      return { ok: false, error: 'Unknown placement action.' };
    }
    if (state.winnerId) return { ok: false, error: 'Game over.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
    if (action.type !== 'fire') return { ok: false, error: 'Unknown battle action.' };
    const x = Number(action.x);
    const y = Number(action.y);
    if (!(x >= 0 && x < state.size && y >= 0 && y < state.size)) return { ok: false, error: 'Out of bounds.' };
    const foe = state.players.find((p) => p.id !== playerId).id;
    if (state.shots[playerId].some((s) => s.x === x && s.y === y)) return { ok: false, error: 'Already fired there.' };
    const board = state.boards[foe];
    const hitShip = board.find((s) => s.cells.some(([cx, cy]) => cx === x && cy === y));
    const result = { x, y, hit: !!hitShip, at: U.byId(state, playerId)?.name };
    if (hitShip) {
      hitShip.hits.push([x, y]);
      if (hitShip.hits.length >= hitShip.cells.length) {
        hitShip.sunk = true;
        result.sunk = hitShip.name;
      }
    }
    state.shots[playerId].push(result);
    const events = [U.event(`${result.at} fired ${coord10(x, y)}: ${hitShip ? (result.sunk ? `SUNK the ${hitShip.name}!` : 'HIT') : 'miss'}`, hitShip ? 'win' : 'miss')];
    if (board.every((s) => s.sunk)) {
      state.winnerId = playerId;
      state.summary = `${result.at} destroyed the enemy fleet!`;
      U.addScore(state, playerId, 1);
      events.push(U.event(state.summary, 'win'));
    } else {
      state.turnId = foe;
    }
    for (const e of events) U.addLog(state, e.text, e.kind);
    return { ok: true, events };
  },
  bot(state, playerId) {
    if (state.phase === 'place') {
      if (state.placed[playerId]) return null;
      if (state.boards[playerId].length < state.fleetSize) {
        const remaining = FLEET.slice(0, state.fleetSize).find((f) => !state.boards[playerId].some((s) => s.id === f.id));
        for (let tries = 0; tries < 80; tries++) {
          const dir = Math.random() < 0.5 ? 'h' : 'v';
          const x = Math.floor(Math.random() * state.size);
          const y = Math.floor(Math.random() * state.size);
          const cells = shipCells(remaining, x, y, dir, state.size);
          if (!cells) continue;
          if (cells.some(([cx, cy]) => state.boards[playerId].some((s) => s.cells.some(([sx, sy]) => sx === cx && sy === cy)))) continue;
          return { type: 'place-ship', ship: remaining.id, x, y, dir };
        }
        return { type: 'auto-place' };
      }
      return { type: 'ready' };
    }
    if (state.turnId !== playerId) return null;
    const foe = state.players.find((p) => p.id !== playerId).id;
    const taken = new Set(state.shots[playerId].map((s) => `${s.x},${s.y}`));
    const size = state.size;
    const free = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!taken.has(`${x},${y}`)) free.push({ x, y });
    if (!free.length) return null;
    const hits = state.shots[playerId].filter((s) => s.hit);
    for (const hit of hits) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = hit.x + dx;
        const y = hit.y + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        if (!taken.has(`${x},${y}`)) return { type: 'fire', x, y };
      }
    }
    if (U.byId(state, playerId)?.level <= 1) return { type: 'fire', ...U.pick(free) };
    const parity = free.filter((f) => (f.x + f.y) % 2 === 0);
    const pool = parity.length ? parity : free;
    return { type: 'fire', ...U.pick(pool) };
  },
  over(state) {
    return U.simpleOver(state);
  },
  render({ el, view, playerId, send, host }) {
    const size = view.size;
    if (view.phase === 'place') {
      const ui = host?.uiState || {};
      el.appendChild(UI.h('div', { class: 'turn-banner' }, 'Place your fleet'));
      const remaining = view.fleet.filter((f) => !(view.myBoard || []).some((s) => s.id === f.id));
      const dir = ui.dir === 'v' ? 'v' : 'h';
      el.appendChild(UI.row(
        UI.btn(`Rotate (now: ${dir === 'h' ? 'horizontal' : 'vertical'})`, () => {
          ui.dir = dir === 'h' ? 'v' : 'h';
          host?.refresh?.();
        }, { size: 'sm' }),
        UI.btn('Auto place', () => send({ type: 'auto-place' }), { size: 'sm' }),
        UI.btn('Clear', () => send({ type: 'clear' }), { size: 'sm' }),
        UI.btn('I\'m ready', () => send({ type: 'ready' }), { variant: 'primary', size: 'sm', disabled: (view.myBoard || []).length < view.fleet.length }),
      ));
      el.appendChild(UI.h('div', { class: 'fleet-list' }, remaining.map((f) => UI.pill(`${f.name} (${f.size})`))));
      el.appendChild(
        Art.boardStage('battleship', { width: 660, height: 660 },
          UI.gridBoard(size, size, (x, y) => {
            const ship = (view.myBoard || []).find((s) => s.cells.some(([cx, cy]) => cx === x && cy === y));
            const hit = ship?.hits?.some(([hx, hy]) => hx === x && hy === y);
            return UI.gridButton(ship ? '🚢' : '', () => {
              if (!remaining.length) return;
              send({ type: 'place-ship', ship: remaining[0].id, x, y, dir });
            }, { className: `ship ${ship ? 'occupied' : ''} ${hit ? 'hit' : ''}` });
          }, { className: 'battleship' })),
      );
      return;
    }

    const myGrid = UI.gridBoard(size, size, (x, y) => {
      const ship = (view.myBoard || []).find((s) => s.cells.some(([cx, cy]) => cx === x && cy === y));
      const incoming = (view.enemyShots || []).find((s) => s.x === x && s.y === y);
      // `ship` marks the grid, `occupied` marks the hull: the stylesheet plates
      // only what is really there, so a miss on open water stays water.
      return UI.gridButton(incoming ? (incoming.hit ? '✳️' : '•') : ship ? '🚢' : '', () => {}, {
        className: `ship ${ship ? 'occupied' : ''} ${incoming?.hit ? 'hit' : incoming ? 'miss' : ''} ${ship?.sunk ? 'sunk' : ''}`,
      });
    }, { className: 'battleship' });

    const targetGrid = UI.gridBoard(size, size, (x, y) => {
      const shot = (view.myShots || []).find((s) => s.x === x && s.y === y);
      return UI.gridButton(shot ? (shot.sunk ? '💥' : shot.hit ? '🔥' : '·') : '', () => send({ type: 'fire', x, y }), {
        className: `target ${shot ? (shot.hit ? 'hit' : 'miss') : ''}`,
        disabled: !!shot || !view.turn.includes(playerId),
      });
    }, { className: 'battleship target-grid' });

    el.appendChild(UI.turnBanner(view));
    el.appendChild(Art.boardStage('battleship', { width: 980, height: 640 },
      UI.h('div', { class: 'two-up' },
        UI.panel('Your waters', myGrid),
        UI.panel('Enemy waters', targetGrid),
      )));
    if (view.enemySunk?.length) el.appendChild(UI.row(UI.muted('Enemy losses:'), ...view.enemySunk.map((s) => UI.pill(s.name, 'sunk'))));
  },
};

function shipCells(ship, x, y, dir, size) {
  const cells = [];
  for (let i = 0; i < ship.size; i++) {
    const cx = dir === 'h' ? x + i : x;
    const cy = dir === 'h' ? y : y + i;
    if (cx >= size || cy >= size) return null;
    cells.push([cx, cy]);
  }
  return cells;
}

function randomFleet(state, owner) {
  const placed = [];
  for (const ship of FLEET.slice(0, state.fleetSize)) {
    for (let tries = 0; tries < 200; tries++) {
      const dir = Math.random() < 0.5 ? 'h' : 'v';
      const x = Math.floor(Math.random() * state.size);
      const y = Math.floor(Math.random() * state.size);
      const cells = shipCells(ship, x, y, dir, state.size);
      if (!cells) continue;
      if (cells.some(([cx, cy]) => placed.some((s) => s.cells.some(([sx, sy]) => sx === cx && sy === cy)))) continue;
      placed.push({ ...ship, cells, hits: [], sunk: false });
      break;
    }
  }
  return placed;
}

function coord10(x, y) {
  return `${'ABCDEFGHIJ'[x]}${y + 1}`;
}

export default { ticTacToe, ultimateTtt, connectFour, checkers, battleship };
