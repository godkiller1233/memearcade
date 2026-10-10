/**
 * Chess.
 *
 * Complete legal move generation (castling rights and path checks, en passant,
 * promotion, pin/check filtering), plus checkmate, stalemate, insufficient
 * material, threefold repetition and the 50-move rule.  Bots use alpha-beta
 * negamax over material + a light positional evaluation.
 *
 * Board is a flat 64 array of `null` or two-letter codes: "wp", "bk", ...
 * y = 0 is the top row (rank 8), x = 0 is file a.  White starts at the bottom.
 */
import * as U from './util.js';
import * as UI from './ui.js';
import * as Art from './art.js';

const FILES = 'abcdefgh';
const PIECES = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const START = [
  'br', 'bn', 'bb', 'bq', 'bk', 'bb', 'bn', 'br',
  'bp', 'bp', 'bp', 'bp', 'bp', 'bp', 'bp', 'bp',
  ...Array(8).fill(null).map(() => null), ...Array(8).fill(null).map(() => null),
  ...Array(8).fill(null).map(() => null), ...Array(8).fill(null).map(() => null),
  'wp', 'wp', 'wp', 'wp', 'wp', 'wp', 'wp', 'wp',
  'wr', 'wn', 'wb', 'wq', 'wk', 'wb', 'wn', 'wr',
];

const idx = (x, y) => y * 8 + x;
const onBoard = (x, y) => x >= 0 && y >= 0 && x < 8 && y < 8;
const colorOf = (piece) => (piece ? piece[0] : null);
const typeOf = (piece) => (piece ? piece[1] : null);
const enemy = (color) => (color === 'w' ? 'b' : 'w');

const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_DELTAS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

function squareName(x, y) {
  return `${FILES[x]}${8 - y}`;
}

function parseSquare(name) {
  const m = /^([a-h])([1-8])$/.exec(String(name || ''));
  if (!m) return null;
  return { x: FILES.indexOf(m[1]), y: 8 - Number(m[2]) };
}

/* ------------------------------------------------------------------ *
 * Move generation
 * ------------------------------------------------------------------ */

function slideMoves(state, x, y, dirs, color, out, from) {
  for (const [dx, dy] of dirs) {
    let cx = x + dx;
    let cy = y + dy;
    while (onBoard(cx, cy)) {
      const target = state.board[idx(cx, cy)];
      if (!target) {
        out.push({ from, to: idx(cx, cy), piece: state.board[from], capture: null });
      } else {
        if (colorOf(target) !== color) out.push({ from, to: idx(cx, cy), piece: state.board[from], capture: target });
        break;
      }
      cx += dx;
      cy += dy;
    }
  }
}

/** Pseudo-legal moves for one square (king safety is filtered separately). */
export function movesFrom(state, from) {
  const piece = state.board[from];
  if (!piece) return [];
  const color = colorOf(piece);
  const type = typeOf(piece);
  const x = from % 8;
  const y = Math.floor(from / 8);
  const out = [];

  if (type === 'p') {
    const dir = color === 'w' ? -1 : 1;
    const startRow = color === 'w' ? 6 : 1;
    const promoRow = color === 'w' ? 0 : 7;
    const oneY = y + dir;
    if (onBoard(x, oneY) && !state.board[idx(x, oneY)]) {
      pushPawn(out, from, idx(x, oneY), piece, oneY === promoRow);
      const twoY = y + dir * 2;
      if (y === startRow && !state.board[idx(x, twoY)]) out.push({ from, to: idx(x, twoY), piece, capture: null, double: true });
    }
    for (const dx of [-1, 1]) {
      const cx = x + dx;
      const cy = y + dir;
      if (!onBoard(cx, cy)) continue;
      const target = state.board[idx(cx, cy)];
      if (target && colorOf(target) !== color) pushPawn(out, from, idx(cx, cy), piece, cy === promoRow, target);
      else if (!target && state.ep && state.ep.x === cx && state.ep.y === cy) {
        out.push({ from, to: idx(cx, cy), piece, capture: `${enemy(color)}p`, enPassant: true });
      }
    }
    return out;
  }

  if (type === 'n') {
    for (const [dx, dy] of KNIGHT_DELTAS) {
      const cx = x + dx;
      const cy = y + dy;
      if (!onBoard(cx, cy)) continue;
      const target = state.board[idx(cx, cy)];
      if (!target || colorOf(target) !== color) out.push({ from, to: idx(cx, cy), piece, capture: target || null });
    }
    return out;
  }

  if (type === 'k') {
    for (const [dx, dy] of KING_DELTAS) {
      const cx = x + dx;
      const cy = y + dy;
      if (!onBoard(cx, cy)) continue;
      const target = state.board[idx(cx, cy)];
      if (!target || colorOf(target) !== color) out.push({ from, to: idx(cx, cy), piece, capture: target || null });
    }
    // castling
    const rights = state.castling[color];
    const homeRow = color === 'w' ? 7 : 0;
    if (y === homeRow && x === 4 && !isAttacked(state, idx(4, homeRow), enemy(color))) {
      if (rights.includes('k') && !state.board[idx(5, homeRow)] && !state.board[idx(6, homeRow)] && state.board[idx(7, homeRow)] === `${color}r`) {
        if (!isAttacked(state, idx(5, homeRow), enemy(color)) && !isAttacked(state, idx(6, homeRow), enemy(color))) {
          out.push({ from, to: idx(6, homeRow), piece, capture: null, castle: 'k' });
        }
      }
      if (rights.includes('q') && !state.board[idx(3, homeRow)] && !state.board[idx(2, homeRow)] && !state.board[idx(1, homeRow)] && state.board[idx(0, homeRow)] === `${color}r`) {
        if (!isAttacked(state, idx(3, homeRow), enemy(color)) && !isAttacked(state, idx(2, homeRow), enemy(color))) {
          out.push({ from, to: idx(2, homeRow), piece, capture: null, castle: 'q' });
        }
      }
    }
    return out;
  }

  slideMoves(state, x, y, type === 'r' ? ROOK_DIRS : type === 'b' ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS], color, out, from);
  return out;
}

function pushPawn(out, from, to, piece, promote, capture = null) {
  if (promote) {
    for (const promo of ['q', 'r', 'b', 'n']) out.push({ from, to, piece, capture, promo });
  } else {
    out.push({ from, to, piece, capture });
  }
}

/** Is the given square attacked by `byColor`? */
function isAttacked(state, square, byColor) {
  const x = square % 8;
  const y = Math.floor(square / 8);
  // pawns
  const pawnDir = byColor === 'w' ? 1 : -1; // pawn sits *below* the square for white attacks
  for (const dx of [-1, 1]) {
    const cx = x + dx;
    const cy = y + pawnDir;
    if (onBoard(cx, cy) && state.board[idx(cx, cy)] === `${byColor}p`) return true;
  }
  for (const [dx, dy] of KNIGHT_DELTAS) {
    const cx = x + dx;
    const cy = y + dy;
    if (onBoard(cx, cy) && state.board[idx(cx, cy)] === `${byColor}n`) return true;
  }
  for (const [dx, dy] of KING_DELTAS) {
    const cx = x + dx;
    const cy = y + dy;
    if (onBoard(cx, cy) && state.board[idx(cx, cy)] === `${byColor}k`) return true;
  }
  for (const [dx, dy] of ROOK_DIRS) {
    let cx = x + dx;
    let cy = y + dy;
    while (onBoard(cx, cy)) {
      const p = state.board[idx(cx, cy)];
      if (p) {
        if (colorOf(p) === byColor && (typeOf(p) === 'r' || typeOf(p) === 'q')) return true;
        break;
      }
      cx += dx;
      cy += dy;
    }
  }
  for (const [dx, dy] of BISHOP_DIRS) {
    let cx = x + dx;
    let cy = y + dy;
    while (onBoard(cx, cy)) {
      const p = state.board[idx(cx, cy)];
      if (p) {
        if (colorOf(p) === byColor && (typeOf(p) === 'b' || typeOf(p) === 'q')) return true;
        break;
      }
      cx += dx;
      cy += dy;
    }
  }
  return false;
}

function kingSquare(state, color) {
  const target = `${color}k`;
  for (let i = 0; i < 64; i++) if (state.board[i] === target) return i;
  return -1;
}

function inCheck(state, color) {
  const k = kingSquare(state, color);
  return k >= 0 && isAttacked(state, k, enemy(color));
}

/** All fully legal moves for a colour. */
export function legalMovesFor(state, color) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (!piece || colorOf(piece) !== color) continue;
    for (const move of movesFrom(state, i)) {
      const undo = applyMove(state, move);
      const illegal = inCheck(state, color);
      undoMove(state, move, undo);
      if (!illegal) out.push(move);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Apply / undo
 * ------------------------------------------------------------------ */

export function applyMove(state, move) {
  const undo = {
    captured: state.board[move.to],
    ep: state.ep,
    castling: { w: [...state.castling.w], b: [...state.castling.b] },
    halfmove: state.halfmove,
    epCapturedAt: null,
  };
  const color = colorOf(move.piece);
  const type = typeOf(move.piece);

  if (move.enPassant) {
    const capY = Math.floor(move.to / 8) + (color === 'w' ? 1 : -1);
    const capIdx = idx(move.to % 8, capY);
    undo.epCapturedAt = capIdx;
    undo.captured = state.board[capIdx];
    state.board[capIdx] = null;
  }

  state.board[move.to] = move.promo ? `${color}${move.promo}` : move.piece;
  state.board[move.from] = null;

  if (move.castle === 'k') {
    const row = color === 'w' ? 7 : 0;
    state.board[idx(5, row)] = state.board[idx(7, row)];
    state.board[idx(7, row)] = null;
  } else if (move.castle === 'q') {
    const row = color === 'w' ? 7 : 0;
    state.board[idx(3, row)] = state.board[idx(0, row)];
    state.board[idx(0, row)] = null;
  }

  state.ep = move.double ? { x: move.from % 8, y: (Math.floor(move.from / 8) + Math.floor(move.to / 8)) / 2 } : null;

  const rights = state.castling[color];
  if (type === 'k') {
    state.castling[color] = [];
  } else if (type === 'r') {
    const fromX = move.from % 8;
    state.castling[color] = rights.filter((r) => (r === 'k' ? fromX !== 7 : fromX !== 0));
  }
  // A rook moving off its home corner (or being captured there) kills that
  // side's castling right.  a1/h1 belong to white, a8/h8 to black.
  if (move.to === idx(0, 7)) state.castling.w = state.castling.w.filter((r) => r !== 'q');
  if (move.to === idx(7, 7)) state.castling.w = state.castling.w.filter((r) => r !== 'k');
  if (move.to === idx(0, 0)) state.castling.b = state.castling.b.filter((r) => r !== 'q');
  if (move.to === idx(7, 0)) state.castling.b = state.castling.b.filter((r) => r !== 'k');

  state.halfmove = (type === 'p' || undo.captured) ? 0 : state.halfmove + 1;
  return undo;
}

export function undoMove(state, move, undo) {
  const color = colorOf(move.piece);
  state.board[move.from] = move.piece;
  // `undo.captured` holds whatever stood on the target square (or the pawn we
  // took en passant) - never read it off the move or the board grows holes.
  state.board[move.to] = move.enPassant ? null : (undo.captured ?? null);
  if (undo.epCapturedAt !== null && undo.epCapturedAt !== undefined) state.board[undo.epCapturedAt] = undo.captured;
  if (move.castle === 'k') {
    const row = color === 'w' ? 7 : 0;
    state.board[idx(7, row)] = state.board[idx(5, row)];
    state.board[idx(5, row)] = null;
  } else if (move.castle === 'q') {
    const row = color === 'w' ? 7 : 0;
    state.board[idx(0, row)] = state.board[idx(3, row)];
    state.board[idx(3, row)] = null;
  }
  state.ep = undo.ep;
  state.castling = undo.castling;
  state.halfmove = undo.halfmove;
}

/* ------------------------------------------------------------------ *
 * Notation
 * ------------------------------------------------------------------ */

export function moveName(state, move) {
  if (move.castle === 'k') return 'O-O';
  if (move.castle === 'q') return 'O-O-O';
  const type = typeOf(move.piece);
  const target = move.capture ? 'x' : '';
  const named = type === 'p' ? '' : PIECES[type];
  const fromFile = type === 'p' && move.capture ? FILES[move.from % 8] : '';
  const promo = move.promo ? `=${move.promo.toUpperCase()}` : '';
  return `${named}${fromFile}${target}${squareName(move.to % 8, Math.floor(move.to / 8))}${promo}`;
}

/* ------------------------------------------------------------------ *
 * Bot
 * ------------------------------------------------------------------ */

const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const CENTER_BONUS = [0, 1, 2, 3, 3, 2, 1, 0];

function evaluate(state, color) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (!piece) continue;
    const type = typeOf(piece);
    const sign = colorOf(piece) === color ? 1 : -1;
    const x = i % 8;
    const y = Math.floor(i / 8);
    let value = VALUES[type] || 0;
    if (type !== 'k') {
      value += (CENTER_BONUS[x] + CENTER_BONUS[y]) * 2;
      const advance = colorOf(piece) === 'w' ? 6 - y : y - 1;
      if (type === 'p') value += advance * 6;
    }
    score += sign * value;
  }
  return score;
}

function search(state, color, depth, alpha, beta) {
  if (depth === 0) return { score: evaluate(state, color), move: null };
  const moves = legalMovesFor(state, color);
  if (!moves.length) {
    return { score: inCheck(state, color) ? -100000 - depth : 0, move: null };
  }
  // order captures first
  moves.sort((a, b) => (b.capture ? VALUES[typeOf(b.capture)] || 0 : 0) - (a.capture ? VALUES[typeOf(a.capture)] || 0 : 0));
  let best = { score: -Infinity, move: moves[0] };
  for (const move of moves) {
    const undo = applyMove(state, move);
    const result = search(state, enemy(color), depth - 1, -beta, -alpha);
    undoMove(state, move, undo);
    const score = -result.score;
    if (score > best.score) best = { score, move };
    alpha = Math.max(alpha, score);
    if (alpha >= beta) break;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

function positionKey(state) {
  return `${state.board.map((c) => c || '.').join('')}|${state.turn}|${state.castling.w.join('')}${state.castling.b.join('')}|${state.ep ? `${state.ep.x}${state.ep.y}` : '-'}`;
}

function refreshStatus(state, events) {
  const mover = state.turn;
  const moves = legalMovesFor(state, mover);
  if (!moves.length) {
    if (inCheck(state, mover)) {
      state.winnerId = state.players.find((p) => state.sides[p.id] === enemy(mover))?.id || null;
      state.summary = `Checkmate - ${U.byId(state, state.winnerId)?.name} wins!`;
      if (state.winnerId) U.addScore(state, state.winnerId, 1);
    } else {
      state.draw = true;
      state.summary = 'Stalemate - draw.';
    }
    events.push(U.event(state.summary, 'win'));
    return;
  }
  if (inCheck(state, mover)) events.push(U.event(`${U.byId(state, state.players.find((p) => state.sides[p.id] === mover)?.id)?.name} is in check!`, 'warn'));

  if (state.halfmove >= 100) {
    state.draw = true;
    state.summary = 'Draw by the 50-move rule.';
    events.push(U.event(state.summary, 'draw'));
    return;
  }
  if (insufficientMaterial(state)) {
    state.draw = true;
    state.summary = 'Draw - insufficient material.';
    events.push(U.event(state.summary, 'draw'));
    return;
  }
  const key = positionKey(state);
  state.repetition = state.repetition || {};
  state.repetition[key] = (state.repetition[key] || 0) + 1;
  if (state.repetition[key] >= 3) {
    state.draw = true;
    state.summary = 'Draw by threefold repetition.';
    events.push(U.event(state.summary, 'draw'));
  }
}

function insufficientMaterial(state) {
  const pieces = state.board.filter(Boolean).map((p) => typeOf(p));
  if (pieces.includes('p') || pieces.includes('q') || pieces.includes('r')) return false;
  const minors = pieces.filter((t) => t === 'b' || t === 'n').length;
  return minors <= 1;
}

/**
 * How a finished game ended, as a stable code the record-keeping can group by.
 *
 * A resignation also ends with a `winnerId`, so the summary is read first: it is
 * the engine's own sentence and the only place a resignation and a checkmate
 * differ.
 */
function endReason(state) {
  const summary = String(state.summary || '');
  if (/resign/i.test(summary)) return 'resignation';
  if (state.winnerId) return 'checkmate';
  if (/50-move|fifty/i.test(summary)) return 'fifty-move';
  if (/insufficient/i.test(summary)) return 'insufficient-material';
  if (/threefold|repetition/i.test(summary)) return 'repetition';
  if (state.draw) return 'stalemate';
  return 'unknown';
}

export const chess = {
  meta: {
    id: 'chess',
    name: 'Chess',
    category: 'board',
    players: { min: 2, max: 2 },
    modes: ['solo', 'local', 'online'],
    blurb: 'Real chess: castling, en passant, promotion, checkmate, draws and all.',
    tags: ['strategy', 'classic'],
    minutes: 25,
    status: 'playable',
    bots: true,
    turnMs: 180000,
    rules: [
      'Standard chess rules with full legal move checking.',
      'Click a piece, then a highlighted square. Promotion asks which piece you want.',
      'Checkmate wins; stalemate, threefold repetition, 50-move rule and insufficient material are draws.',
    ],
    options: [
      { id: 'botDepth', label: 'Bot thinking', type: 'select', values: [1, 2, 3], default: 2 },
      { id: 'time', label: 'Clock', type: 'select', values: [0, 300, 600], default: 0 },
    ],
    /**
     * What a finished match leaves behind for review - the server records this
     * with the result (see finish() in server/games.js), and the admin console's
     * chess analysis groups by it: how the game ended, which seat played which
     * colour, how long the game ran and how it opened.  Small on purpose: it
     * travels into the database and is never replayed, only counted.
     */
    review(state) {
      const moveList = state.moveList || [];
      const seatOf = (side) => state.players.find((p) => state.sides[p.id] === side)?.id || null;
      return {
        end: endReason(state),
        white: seatOf('w'),
        black: seatOf('b'),
        plies: moveList.length,
        captures: { w: (state.captured?.w || []).length, b: (state.captured?.b || []).length },
        opening: moveList.slice(0, 6),
        lastMove: moveList[moveList.length - 1] || null,
      };
    },
  },
  create({ players, seed, options = {} }) {
    const state = U.baseState({ players, seed });
    state.board = START.slice();
    state.turn = 'w';
    state.sides = { [state.players[0].id]: 'w', [state.players[1].id]: 'b' };
    state.castling = { w: ['k', 'q'], b: ['k', 'q'] };
    state.ep = null;
    state.halfmove = 0;
    state.fulls = 1;
    state.moveList = [];
    state.captured = { w: [], b: [] };
    state.repetition = {};
    state.botDepth = options.botDepth || 2;
    state.turnId = state.players[0].id;
    const white = state.players[0];
    U.addLog(state, `${white.name} plays white and moves first.`);
    refreshStatus(state, []);
    return state;
  },
  view(state, viewerId) {
    const v = U.baseView(state, viewerId);
    v.board = state.board;
    v.turn = state.winnerId || state.draw ? [] : [state.turnId];
    v.side = state.sides[viewerId] || 'w';
    v.white = state.players.find((p) => state.sides[p.id] === 'w')?.id;
    v.castling = state.castling;
    v.ep = state.ep;
    v.moveList = state.moveList.slice(-14);
    v.captured = state.captured;
    v.inCheck = inCheck(state, state.turn);
    v.checkSquare = v.inCheck ? kingSquare(state, state.turn) : -1;
    v.lastMove = state.lastMove || null;
    v.legal = state.winnerId || state.draw ? {} : legalForViewer(state, state.sides[viewerId]);
    return v;
  },
  act(state, playerId, action) {
    if (state.winnerId || state.draw) return { ok: false, error: 'Game over.' };
    if (playerId !== state.turnId) return { ok: false, error: 'Not your turn.' };
    if (action.type === 'resign') {
      const foe = state.players.find((p) => p.id !== playerId);
      state.winnerId = foe.id;
      state.summary = `${U.byId(state, playerId)?.name} resigned - ${foe.name} wins.`;
      U.addScore(state, foe.id, 1);
      U.addLog(state, state.summary, 'win');
      return { ok: true, events: [U.event(state.summary, 'win')] };
    }
    if (action.type !== 'move') return { ok: false, error: 'Unknown move.' };
    const color = state.sides[playerId];
    const moves = legalMovesFor(state, color);
    const from = typeof action.from === 'number' ? action.from : squareToIndex(action.from);
    const to = typeof action.to === 'number' ? action.to : squareToIndex(action.to);
    const candidates = moves.filter((m) => m.from === from && m.to === to);
    if (!candidates.length) return { ok: false, error: 'Illegal move.' };
    let move = candidates[0];
    if (candidates.length > 1 && candidates.some((m) => m.promo)) {
      const wanted = ['q', 'r', 'b', 'n'].includes(action.promo) ? action.promo : 'q';
      move = candidates.find((m) => m.promo === wanted) || candidates[0];
    }
    applyMove(state, move);
    state.lastMove = { from: move.from, to: move.to };
    state.moveList.push(`${moveName(state, move)}${inCheck(state, enemy(color)) ? '+' : ''}`);
    if (move.capture) state.captured[color].push(move.capture);
    state.turn = enemy(color);
    state.fulls++;
    const foeSeat = state.players.find((p) => state.sides[p.id] === state.turn);
    state.turnId = foeSeat ? foeSeat.id : null;
    const events = [U.event(`${U.byId(state, playerId)?.name}: ${state.moveList[state.moveList.length - 1]}`, 'move')];
    refreshStatus(state, events);
    for (const e of events) U.addLog(state, e.text, e.kind);
    return { ok: true, events };
  },
  bot(state, playerId) {
    if (playerId !== state.turnId) return null;
    const color = state.sides[playerId];
    const level = U.byId(state, playerId)?.level ?? 2;
    const moves = legalMovesFor(state, color);
    if (!moves.length) return null;
    if (level <= 1) return toAction(U.pick(moves));
    const depth = U.clamp(Math.max(state.botDepth, level >= 4 ? 3 : 2), 1, 3);
    const result = search(state, color, depth, -Infinity, Infinity);
    return toAction(result.move || moves[0]);
  },
  over(state) {
    return U.simpleOver(state, { draw: !!state.draw });
  },
  render({ el, view, playerId, send, host }) {
    const ui = host?.uiState || (host ? (host.uiState = {}) : {});
    const mySide = view.side;
    const myTurn = view.turn.includes(playerId);
    const legal = view.legal || {};
    const flipped = mySide === 'b';
    const promote = ui.promote;
    el.appendChild(UI.turnBanner(view, { label: view.inCheck && view.turn.length ? 'CHECK!' : null }));
    el.appendChild(UI.h('div', { class: 'chess-wrap' },
      Art.boardStage('chess', { width: 760, height: 760 },
        UI.gridBoard(8, 8, (bx, by) => {
        const x = flipped ? 7 - bx : bx;
        const y = flipped ? 7 - by : by;
        const i = idx(x, y);
        const piece = view.board[i];
        const dark = (x + y) % 2 === 1;
        // `legal` is keyed by destination for every piece of the viewer's colour,
        // so a square is only a target for the piece actually selected.  Lighting
        // up the whole colour's move set let a rook click on a bishop's square
        // send a move the engine then refused ("Illegal move.").
        const selected = ui.selected ?? null;
        const movesHere = selected === null ? [] : (legal[i] || []).filter((m) => m.from === selected);
        const isTarget = movesHere.length > 0;
        const isSelected = ui.selected === i;
        const isLast = view.lastMove && (view.lastMove.from === i || view.lastMove.to === i);
        const isCheck = view.checkSquare === i;
        return UI.gridButton(
          piece ? UI.h('span', { class: `cp ${colorOf(piece) === 'w' ? 'white' : 'black'}`, text: PIECES[typeOf(piece)] }) : '',
          () => {
            if (!myTurn) return;
            if (isTarget) {
              if (movesHere.some((m) => m.promo)) {
                ui.promote = { from: selected, to: i };
                host?.refresh?.();
                return;
              }
              send({ type: 'move', from: selected, to: i });
              ui.selected = null;
              host?.refresh?.();
              return;
            }
            if (piece && colorOf(piece) === mySide) {
              ui.selected = i;
              host?.refresh?.();
            } else {
              ui.selected = null;
              host?.refresh?.();
            }
          },
          // `occupied` lets the stylesheet draw a capture ring on a target
          // square with a piece on it and a plain move dot on an empty one -
          // the difference a player is looking for at a glance.
          { className: `${dark ? 'dark-square' : 'light-square'} ${piece ? 'occupied' : ''} ${isTarget ? 'target' : ''} ${isSelected ? 'selected' : ''} ${isLast ? 'last' : ''} ${isCheck ? 'in-check' : ''}` },
        );
      }, { className: 'chess' })),
      UI.h('div', { class: 'chess-side' },
        UI.h('div', { class: 'captured' }, (view.captured[mySide === 'w' ? 'b' : 'w'] || []).map((p) => PIECES[typeOf(p)]).join(' ')),
        UI.h('ol', { class: 'movelist' }, view.moveList.map((m) => UI.h('li', { text: m }))),
        myTurn ? UI.btn('Resign', () => send({ type: 'resign' }), { size: 'sm' }) : null,
        !myTurn && view.turn.length ? UI.muted('Opponent is thinking...') : null,
      )));
    if (promote) {
      el.appendChild(UI.h('div', { class: 'promo' },
        UI.muted('Promote to:'),
        ...['q', 'r', 'b', 'n'].map((p) => UI.btn(PIECES[p], () => {
          send({ type: 'move', from: promote.from, to: promote.to, promo: p });
          ui.promote = null;
          host?.refresh?.();
        }, { size: 'lg' }))));
    }
    if (view.ep) el.appendChild(UI.muted('En passant is available this turn.'));
  },
};

function toAction(move) {
  return { type: 'move', from: move.from, to: move.to, promo: move.promo };
}

function squareToIndex(name) {
  const sq = parseSquare(name);
  return sq ? idx(sq.x, sq.y) : -1;
}

/** legal[toIndex] = list of allowed moves into that square (for the UI). */
function legalForViewer(state, side) {
  const out = {};
  if (!side) return out;
  for (const move of legalMovesFor(state, side)) {
    (out[move.to] ||= []).push(move);
  }
  return out;
}

export default chess;
