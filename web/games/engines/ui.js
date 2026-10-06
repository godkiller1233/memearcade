/**
 * Browser-side UI helpers shared by every engine.
 *
 * Node imports engine modules too (for authoritative online play), so nothing
 * in this file may touch `document` at module scope - only inside functions.
 */
import { makeRng, clamp } from './util.js';

export const isBrowser = typeof document !== 'undefined' && typeof window !== 'undefined';

/* --------------------------- element construction -------------------------- */

export function isNode(x) {
  return !!x && typeof x === 'object' && typeof x.nodeType === 'number';
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (isNode(child)) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style' && typeof value === 'object') applyStyle(el, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'readOnly') el[key] = !!value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(el, children);
  return el;
}

/**
 * Apply a style object to a node. Object.assign(el.style, ...) silently drops
 * CSS custom properties (--cols, --rows, ...), so those go through setProperty.
 */
export function applyStyle(node, style) {
  for (const [key, value] of Object.entries(style || {})) {
    if (value === null || value === undefined) continue;
    if (key.startsWith('--')) node.style.setProperty(key, String(value));
    else node.style[key] = value;
  }
  return node;
}

export function clear(el) {
  if (!el) return el;
  cleanupIntervals(el);
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

/* ------------------------------ interval bookkeeping ---------------------- */

const intervals = new WeakMap();

export function every(el, ms, fn) {
  const id = setInterval(fn, ms);
  const list = intervals.get(el) || [];
  list.push(id);
  intervals.set(el, list);
  return id;
}

function cleanupIntervals(el) {
  const list = intervals.get(el);
  if (!list) return;
  for (const id of list) clearInterval(id);
  intervals.delete(el);
}

/** Stop timers/animation frames started by a render pass. */
export function cleanupTree(el) {
  cleanupIntervals(el);
  if (el && typeof el.__cleanup === 'function') {
    try {
      el.__cleanup();
    } catch {}
    el.__cleanup = null;
  }
}

/* -------------------------------- primitives ------------------------------- */

export function card(...children) {
  return h('div', { class: 'card' }, ...children);
}

export function panel(title, ...children) {
  return h('section', { class: 'panel' }, title ? h('h3', { class: 'panel-title', text: title }) : null, h('div', { class: 'panel-body' }, ...children));
}

export function row(...children) {
  return h('div', { class: 'row' }, ...children);
}

export function col(...children) {
  return h('div', { class: 'col' }, ...children);
}

export function btn(label, onClick, { variant = '', disabled = false, title = '', size = '', className = '' } = {}) {
  return h('button', {
    class: `btn ${variant} ${size} ${className}`.trim(),
    disabled,
    title,
    onClick: disabled ? null : onClick,
  }, label);
}

export function pill(text, kind = '') {
  return h('span', { class: `pill ${kind}`, text });
}

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}`, text });
}

export function muted(text) {
  return h('span', { class: 'muted', text });
}

export function title(text, level = 3) {
  return h(`h${level}`, { class: 'game-title', text });
}

export function avatarBubble(name, emoji, { size = 34, active = false } = {}) {
  return h('span', {
    class: `avatar ${active ? 'active' : ''}`,
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.5)}px` },
    title: name,
    text: emoji || '👾',
  });
}

export function list(items, render) {
  return h('ul', { class: 'stack-list' }, items.map((item, i) => h('li', {}, render(item, i))));
}

export function choice(options, value, onChange, { vertical = false } = {}) {
  return h(
    'div',
    { class: `choice ${vertical ? 'vertical' : ''}` },
    options.map((opt) =>
      h('button', {
        class: `choice-item ${opt.value === value ? 'on' : ''}`,
        title: opt.desc || '',
        onClick: () => onChange(opt.value),
      }, opt.label),
    ),
  );
}

export function inputRow(placeholder, onSubmit, { submitLabel = 'Send', maxLength = 300 } = {}) {
  const input = h('input', { class: 'input', placeholder, maxLength, autocomplete: 'off' });
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    onSubmit(text);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  return h('div', { class: 'input-row' }, input, btn(submitLabel, submit, { variant: 'primary' }));
}

export function textareaRow(placeholder, onSubmit, { submitLabel = 'Submit', maxLength = 400, rows = 3 } = {}) {
  const area = h('textarea', { class: 'input area', placeholder, maxLength, rows });
  return h('div', { class: 'input-row col' }, area, btn(submitLabel, () => {
    const text = area.value.trim();
    if (!text) return;
    area.disabled = true;
    onSubmit(text);
  }, { variant: 'primary' }));
}

/* -------------------------------- scoreboard ------------------------------- */

export function scoreboard(view, { highlight = [], showRank = true, unit = '' } = {}) {
  const players = view.players || [];
  const ranked = showRank
    ? [...players].sort((a, b) => (view.scores?.[b.id] || 0) - (view.scores?.[a.id] || 0))
    : players;
  return h(
    'div',
    { class: 'scoreboard' },
    ranked.map((p, i) =>
      h('div', {
        class: `score-row ${highlight.includes(p.id) ? 'active' : ''} ${p.bot ? 'bot' : ''}`,
      },
        showRank ? h('span', { class: 'rank', text: `#${i + 1}` }) : null,
        avatarBubble(p.name, p.avatar, { active: highlight.includes(p.id) }),
        h('span', { class: 'name', text: p.name }),
        p.bot ? badge('BOT', 'bot') : null,
        h('span', { class: 'score', text: `${view.scores?.[p.id] ?? 0}${unit}` }),
      ),
    ),
  );
}

export function turnBanner(view, { label = null, players = null } = {}) {
  const ids = view.turn || [];
  const seats = players || view.players || [];
  const names = ids.map((id) => seats.find((p) => p.id === id)?.name || seatName(id));
  const text = label || (names.length ? `${names.join(' & ')} to play` : 'Waiting...');
  return h('div', { class: 'turn-banner' }, h('span', { class: 'dot' }), text);
}

function seatName(id) {
  if (String(id).startsWith('bot_')) return 'Bot';
  if (id === 'local') return 'You';
  return 'Player';
}

export function logView(view, { limit = 8 } = {}) {
  const entries = (view.log || []).slice(-limit).reverse();
  return h('div', { class: 'game-log' }, entries.map((e) => h('div', { class: `log-line ${e.kind || ''}`, text: e.text })));
}

/* --------------------------------- grids ---------------------------------- */

export function gridBoard(cols, rows, renderCell, { className = '' } = {}) {
  const board = h('div', { class: `board ${className}`, style: { '--cols': cols, '--rows': rows } });
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = renderCell(x, y);
      if (cell) board.appendChild(cell);
      else board.appendChild(h('div', { class: 'cell empty' }));
    }
  }
  return board;
}

export function gridButton(content, onClick, { className = '', disabled = false, title = '' } = {}) {
  return h('button', { class: `cell ${className}`, disabled, title, onClick }, content);
}

/* --------------------------------- canvas --------------------------------- */

export function canvasBox(width, height, drawFn, { className = '', scale = 1 } = {}) {
  const canvas = h('canvas', {
    class: `game-canvas ${className}`,
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  });
  canvas.style.width = '100%';
  canvas.style.maxWidth = `${width}px`;
  canvas.style.aspectRatio = `${width} / ${height}`;
  const ctx = canvas.getContext('2d');
  if (ctx && scale !== 1) ctx.scale(scale, scale);
  const api = {
    el: canvas,
    canvas,
    ctx,
    width,
    height,
    redraw() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (scale !== 1) ctx.scale(scale, scale);
      drawFn?.(ctx, width, height);
    },
  };
  queueMicrotask(() => api.redraw());
  return api;
}

/**
 * Canvas + HUD scaffolding for the realtime (host-authoritative) games.
 *
 * The snapshot lives in a mutable slot so one render can keep drawing new
 * worlds without rebuilding the DOM: `redraw()` repaints from whatever snapshot
 * is current, and `live(next)` adopts a streamed snapshot and repaints.  The
 * online host drives both whenever a tick arrives.
 *
 * The stage also carries an empty `.net-hud` line: online rooms fill it with
 * ping/snapshot-rate/buffer stats (see host.js), and it stays hidden for solo
 * and hot-seat play, which have no network to report on.
 */
export function realtimeStage({ el, snapshot, width, height, draw, hudText = null, viewerId = null }) {
  const wrap = h('div', { class: 'realtime-wrap' });
  el.appendChild(wrap);
  const hud = h('div', { class: 'phase-bar' });
  wrap.appendChild(hud);
  let current = snapshot;
  const box = canvasBox(width, height, (ctx, w, hh) => draw(ctx, w, hh, current));
  const paint = () => {
    if (hudText) hud.textContent = hudText(current, viewerId);
    box.redraw();
  };
  wrap.appendChild(box.el);
  const net = h('div', { class: 'net-hud', title: 'Live connection stats' });
  net.hidden = true;
  wrap.appendChild(net);
  paint();
  // Registered on `wrap` so clearing the render tree stops it too.
  every(wrap, 250, paint);
  const cleanup = () => {};
  cleanup.redraw = paint;
  cleanup.live = (next) => {
    if (next && typeof next === 'object') current = next;
    paint();
  };
  return { wrap, hud, net, box, cleanup, paint };
}

const REALTIME_KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right', Space: 'fire',
};

/** Bind arrows / WASD / space to a blank input map; returns a cleanup fn. */
export function keyboardControls(playerId, keys) {
  const applied = {};
  const onDown = (e) => {
    const action = REALTIME_KEYS[e.code];
    if (!action) return;
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (applied[action]) return;
    applied[action] = true;
    keys[action] = true;
  };
  const onUp = (e) => {
    const action = REALTIME_KEYS[e.code];
    if (!action) return;
    applied[action] = false;
    keys[action] = false;
  };
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  return () => {
    window.removeEventListener('keydown', onDown);
    window.removeEventListener('keyup', onUp);
  };
}

/**
 * Wire a seat's keyboard for whichever mode a realtime game is in:
 *
 *   local  - solo / hot-seat: the world is ours, keys go straight into it and
 *            the engine steps it here.
 *   host   - online room host: same controls, but the world streams out as
 *            snapshots (the room host steps it).
 *   remote - an online seat on somebody else's host: keys are forwarded to the
 *            server, which hands them to the room host.
 *   watch  - spectator (or a seat this build does not know): no controls.
 */
export function realtimeControls({ wrap, host, state, playerId, keys, send }) {
  const role = host?.role;
  const online = role === 'online';
  const seated = !!state && state.players?.some((p) => p.id === playerId);
  // The engine world only arrives with the first streamed tick, so an online
  // seat also counts as playing from the room roster alone - otherwise a player
  // who renders before that first tick would never get controls at all.
  const rostered = online && !!host?.players?.some((p) => p.id === playerId);
  if (role === 'spectator' || !(seated || rostered)) return { mode: 'watch', cleanup: null };
  const cleanup = keyboardControls(playerId, keys);
  if (!online) {
    every(wrap, 90, () => {
      if (state?.inputs?.[playerId]) Object.assign(state.inputs[playerId], keys);
    });
    return { mode: 'local', cleanup };
  }
  // Online seat: only changes travel, plus an occasional keep-alive so a
  // dropped message cannot leave the host holding a key we already released.
  let lastSig = '';
  let lastAt = 0;
  every(wrap, 66, () => {
    const sig = `${+!!keys.up}${+!!keys.down}${+!!keys.left}${+!!keys.right}${+!!keys.fire}`;
    // A held key is re-sent occasionally in case a message was dropped; while
    // every key is up there is nothing to lose, so we stay quiet.
    const stale = sig !== '00000' && Date.now() - lastAt > 1200;
    if (sig === lastSig && !stale) return;
    lastSig = sig;
    lastAt = Date.now();
    send?.({ type: 'input', up: !!keys.up, down: !!keys.down, left: !!keys.left, right: !!keys.right, fire: !!keys.fire });
  });
  return { mode: host?.isHost ? 'host' : 'remote', cleanup };
}

/** Hint line under a realtime canvas, by mode. */
export function realtimeHint(mode, playing, watching) {
  if (mode === 'local') return playing;
  if (mode === 'host') return `${playing} You are the host - this browser simulates the match for everyone.`;
  if (mode === 'remote') return `Live from the room host. ${playing}`;
  return watching;
}

/**
 * Attach the online host's in-place repaint hooks to a render cleanup fn, plus
 * the seat's live key map (read by the netcode predictor every frame) and the
 * stage's network readout element.
 */
export function withLive(cleanup, stage, extra = {}) {
  const fn = typeof cleanup === 'function' ? cleanup : () => {};
  fn.redraw = stage.cleanup.redraw;
  fn.live = stage.cleanup.live;
  if (stage.net) fn.net = stage.net;
  if (extra.keys) fn.keys = extra.keys;
  return fn;
}

export function animLoop(ownerEl, step) {
  let raf = null;
  let last = performance.now();
  let running = true;
  const frame = (t) => {
    if (!running) return;
    const dt = Math.min(64, t - last);
    last = t;
    try {
      step(dt, t);
    } catch (err) {
      running = false;
      throw err;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
  };
  if (ownerEl) {
    ownerEl.__cleanup = () => {
      stop();
      if (ownerEl.__cleanup_prev) ownerEl.__cleanup_prev();
    };
  }
  return stop;
}

/* ------------------------------ drawing canvas ---------------------------- */

/**
 * Freehand drawing pad.  Strokes are stored in normalised 0..1 coordinates so
 * the same data renders identically on any screen size and serialises cleanly.
 */
export function drawingPad({
  strokes = [],
  onCommit = null,
  color = '#111827',
  width = 6,
  readOnly = false,
  height = 340,
  background = '#ffffff',
  wobble = 0,
  onStroke = null,
} = {}) {
  const wrap = h('div', { class: 'pad-wrap' });
  const board = canvasBox(640, height, (ctx, w, hh) => {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, hh);
    drawStrokes(ctx, strokes, w, hh);
    if (live) drawStrokes(ctx, [{ color, width, pts: live }], w, hh);
  });
  const canvas = board.canvas;
  let live = null;
  let drawing = false;

  const toLocal = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
    return {
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    };
  };

  const start = (ev) => {
    if (readOnly) return;
    ev.preventDefault();
    drawing = true;
    live = [toLocal(ev)];
    board.redraw();
  };
  const move = (ev) => {
    if (!drawing || readOnly) return;
    ev.preventDefault();
    const p = toLocal(ev);
    const last = live[live.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.004) return;
    if (wobble) {
      p.x = clamp(p.x + (Math.random() - 0.5) * wobble, 0, 1);
      p.y = clamp(p.y + (Math.random() - 0.5) * wobble, 0, 1);
    }
    live.push(p);
    if (onStroke) onStroke(live);
    board.redraw();
  };
  const end = (ev) => {
    if (!drawing || readOnly) return;
    if (ev?.preventDefault) ev.preventDefault();
    drawing = false;
    if (live && live.length > 1) {
      const stroke = { color, width, pts: live };
      strokes.push(stroke);
      onCommit?.(strokes.slice());
    }
    live = null;
    board.redraw();
  };

  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  canvas.addEventListener('pointerleave', end);
  wrap.__cleanup = () => window.removeEventListener('pointerup', end);

  wrap.appendChild(board.el);
  return {
    el: wrap,
    strokes,
    undo() {
      strokes.pop();
      board.redraw();
      onCommit?.(strokes.slice());
    },
    clearAll() {
      strokes.length = 0;
      board.redraw();
      onCommit?.([]);
    },
    redraw: board.redraw,
    setStrokes(next) {
      strokes.length = 0;
      strokes.push(...(next || []));
      board.redraw();
    },
    cleanup: () => window.removeEventListener('pointerup', end),
  };
}

export function drawStrokes(ctx, strokes, w, h) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    if (!stroke?.pts?.length) continue;
    ctx.strokeStyle = stroke.color || '#111827';
    ctx.lineWidth = (stroke.width || 5) * Math.min(w, h) / 420;
    if (stroke.fill) {
      ctx.fillStyle = stroke.fill;
    }
    ctx.beginPath();
    ctx.moveTo(stroke.pts[0][0] * w, stroke.pts[0][1] * h);
    for (const [x, y] of stroke.pts.slice(1)) ctx.lineTo(x * w, y * h);
    if (stroke.pts.length === 1) {
      ctx.arc(stroke.pts[0][0] * w, stroke.pts[0][1] * h, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2);
      ctx.fillStyle = stroke.color || '#111827';
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
}

export function paletteRow(onPick, current, colors = null) {
  const palette = colors || ['#111827', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899', '#78350f', '#9ca3af', '#ffffff'];
  return h(
    'div',
    { class: 'palette' },
    palette.map((c) => h('button', {
      class: `swatch ${c === current ? 'on' : ''}`,
      style: { background: c },
      title: c,
      onClick: () => onPick(c),
    })),
  );
}

export function widthPicker(onPick, current) {
  return h(
    'div',
    { class: 'widths' },
    [3, 6, 12, 24].map((w) =>
      h('button', {
        class: `width-btn ${w === current ? 'on' : ''}`,
        onClick: () => onPick(w),
      }, h('span', { style: { height: `${Math.min(10, w / 2)}px`, width: `${w + 14}px` } })),
    ),
  );
}

/* ------------------------------- misc widgets ----------------------------- */

export function promptCard(text, sub = null) {
  return h('div', { class: 'prompt-card' }, h('div', { class: 'prompt-text', text }), sub ? h('div', { class: 'prompt-sub', text: sub }) : null);
}

export function optionGrid(options, onPick, { disabled = false, picked = [] } = {}) {
  return h(
    'div',
    { class: 'option-grid' },
    options.map((opt) =>
      h('button', {
        class: `option ${picked.includes(opt.id) ? 'picked' : ''}`,
        disabled,
        title: opt.desc || '',
        onClick: () => onPick(opt.id),
      }, h('strong', { text: opt.name }), opt.desc ? h('span', { class: 'option-desc', text: opt.desc }) : null),
    ),
  );
}

export function voteBar(counts, total, { label = '' } = {}) {
  const pct = total ? Math.round((counts / total) * 100) : 0;
  return h('div', { class: 'vote-bar', title: `${counts} vote(s)` },
    h('div', { class: 'vote-fill', style: { width: `${pct}%` } }),
    h('span', { class: 'vote-label', text: label || `${counts}` }));
}

export function chatBox(view, { onSend = null, scope = 'room', placeholder = 'Message' } = {}) {
  const messages = view.messages || [];
  const listEl = h('div', { class: 'chat-list' },
    messages.slice(-40).map((m) =>
      h('div', { class: `chat-line ${m.kind || ''}` },
        m.kind === 'system' ? null : h('b', { class: 'chat-name', text: m.name || '???' }),
        h('span', { class: 'chat-text', text: m.text })),
    ));
  queueMicrotask(() => {
    listEl.scrollTop = listEl.scrollHeight;
  });
  return h('div', { class: 'chat' }, listEl, onSend ? inputRow(placeholder, onSend, { submitLabel: 'Send' }) : null);
}

export function spinnerRow(text = 'Waiting for players...') {
  return h('div', { class: 'waiting' }, h('span', { class: 'spinner' }), text);
}

export function keyHint(text) {
  return h('div', { class: 'key-hint', text });
}

/* --------------------------- procedural art helpers ------------------------ */

export const PALETTES = {
  neon: ['#0f172a', '#ff2fb0', '#22d3ee', '#facc15', '#a855f7'],
  sunset: ['#2b1055', '#ff6b6b', '#feca57', '#ff9f43', '#48dbfb'],
  forest: ['#0b3d2e', '#2ecc71', '#f9ca24', '#e67e22', '#1abc9c'],
  arcade: ['#12002b', '#ff006e', '#00f5d4', '#fee440', '#8338ec'],
  mono: ['#111827', '#374151', '#6b7280', '#9ca3af', '#e5e7eb'],
  candy: ['#ffd6e0', '#ff85a1', '#fbb1bd', '#b8f2e6', '#aed9e0'],
};

/**
 * Deterministic procedural scene painter.  Used by Spot the Difference,
 * Zoomed Image, Prompt Guessing and the drawing game backgrounds.
 */
export function paintScene(ctx, w, h, seed, { palette = 'neon', density = 22, subject = null } = {}) {
  const rng = makeRng(seed);
  const colors = PALETTES[palette] || PALETTES.neon;
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, w, h);

  // soft background blobs
  for (let i = 0; i < 5; i++) {
    const grd = ctx.createRadialGradient(rng() * w, rng() * h, 4, rng() * w, rng() * h, w * 0.5);
    grd.addColorStop(0, colors[1 + Math.floor(rng() * (colors.length - 1))]);
    grd.addColorStop(1, 'transparent');
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalAlpha = 1;

  const shapes = [];
  for (let i = 0; i < density; i++) {
    const type = Math.floor(rng() * 5);
    const cx = rng() * w;
    const cy = rng() * h;
    const size = 8 + rng() * (w * 0.16);
    const color = colors[1 + Math.floor(rng() * (colors.length - 1))];
    const rot = rng() * Math.PI;
    shapes.push({ type, cx, cy, size, color, rot, alpha: 0.65 + rng() * 0.35 });
    drawShape(ctx, type, cx, cy, size, color, rot, 0.8);
  }
  return { shapes, colors, seed };
}

export function drawShape(ctx, type, cx, cy, size, color, rot = 0, alpha = 1) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, size * 0.12);
  switch (type) {
    case 0:
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 1:
      ctx.fillRect(-size / 2, -size / 2, size, size * (0.5 + 0.5 * Math.abs(Math.sin(rot))));
      break;
    case 2:
      ctx.beginPath();
      ctx.moveTo(0, -size / 2);
      ctx.lineTo(size / 2, size / 2);
      ctx.lineTo(-size / 2, size / 2);
      ctx.closePath();
      ctx.fill();
      break;
    case 3:
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(a) * size * 0.8;
        const y = Math.sin(a) * size * 0.8;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      break;
    default:
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 1.5);
      ctx.stroke();
      break;
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

export default {
  h, btn, card, panel, row, col, clear, frag, applyStyle, gridBoard, gridButton, canvasBox, realtimeStage,
  keyboardControls, realtimeControls, realtimeHint, withLive, animLoop,
  drawingPad, drawStrokes, scoreboard, turnBanner, logView, chatBox, inputRow, textareaRow,
  paintScene, PALETTES, pill, badge, muted, promptCard, spinnerRow, choice, avatarBubble,
};
