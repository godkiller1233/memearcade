/**
 * The shared art layer for the DOM board games.
 *
 * The canvas family paints itself with ui.js - arenaBackdrop() behind the
 * arena games, paintScene() behind the puzzle ones, drawShape()'s light from
 * the top left and withGlow()'s neon rim on the sprites - while chess,
 * checkers, battleship, Monopoly and the card games draw DOM nodes and could
 * not use any of it.  This module hands them the same art: boardStage() paints
 * the identical procedural backdrop onto a canvas (at the device pixel ratio,
 * exactly like canvasBox() does) and stacks the board over it, and the palette
 * it painted with is published as CSS variables so the pieces in app.css can
 * take their glass tint from the same colours.
 *
 * Like ui.js, nothing here touches `document` at module scope: Node imports
 * the engine modules for authoritative online play, and every DOM call sits
 * inside a function that only render() reaches.
 */
import * as UI from './ui.js';

/**
 * One art direction per board - palette and backdrop shape.
 *
 * These are ui.PALETTES keys, the same set the canvas games draw from, so a
 * chess board reads as a sibling of the arena rather than as a different game.
 * `grid` is the perspective floor grid arenaBackdrop() can lay down: on where
 * the board is open enough to show it, off where a calmer table reads better.
 */
export const BOARDS = {
  'tic-tac-toe': { palette: 'neon', horizon: 0.56, grid: true },
  'ultimate-ttt': { palette: 'candy', horizon: 0.5, grid: true },
  'connect-four': { palette: 'arcade', horizon: 0.6, grid: true },
  checkers: { palette: 'forest', horizon: 0.62, grid: false },
  chess: { palette: 'sunset', horizon: 0.6, grid: false },
  battleship: { palette: 'neon', horizon: 0.68, grid: false },
  monopoly: { palette: 'candy', horizon: 0.55, grid: false },
  uno: { palette: 'arcade', variant: 'felt', grid: false },
  'go-fish': { palette: 'neon', variant: 'felt', grid: false },
  blackjack: { palette: 'forest', variant: 'felt', grid: false },
};

/** Deterministic 0..1 noise - the same hash arenaBackdrop() uses internally. */
function noise(i, salt) {
  const n = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * A card table: felt lit from above, fabric fleck, a neon rail and a vignette.
 *
 * The flecks come from the hash rather than Math.random, so a table that
 * repaints (a re-render, a reconnect) does not shimmer.  Returns the palette
 * it used, like the other painters here.
 */
export function feltTable(ctx, w, h, { palette = 'forest', speckle = 260, rail = true } = {}) {
  const colors = UI.PALETTES[palette] || UI.PALETTES.forest;
  const felt = UI.shadeColor(colors[0], -0.16);

  const pool = ctx.createRadialGradient(w * 0.5, h * 0.42, Math.min(w, h) * 0.06, w * 0.5, h * 0.5, Math.max(w, h) * 0.74);
  pool.addColorStop(0, UI.shadeColor(colors[0], 0.24));
  pool.addColorStop(0.55, felt);
  pool.addColorStop(1, UI.shadeColor(colors[0], -0.46));
  ctx.fillStyle = pool;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < speckle; i++) {
    const s = noise(i, 9) < 0.85 ? 1 : 2;
    ctx.globalAlpha = 0.03 + noise(i, 7) * 0.09;
    ctx.fillStyle = noise(i, 8) < 0.5 ? '#ffffff' : '#000000';
    ctx.fillRect(noise(i, 5) * w, noise(i, 6) * h, s, s);
  }
  ctx.globalAlpha = 1;

  if (rail) {
    // The lit inner edge of the rails: without it the felt runs off the panel.
    const inset = Math.max(3, Math.min(w, h) * 0.014);
    ctx.save();
    ctx.lineWidth = inset;
    ctx.strokeStyle = UI.withAlpha(colors[2] || colors[1], 0.4);
    UI.roundRect(ctx, inset, inset, w - inset * 2, h - inset * 2, Math.min(w, h) * 0.07);
    UI.withGlow(ctx, colors[1], 20, () => ctx.stroke());
    ctx.restore();
  }

  const vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.34, w / 2, h / 2, Math.max(w, h) * 0.8);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
  return colors;
}

/**
 * Paint one board backdrop.  `variant` picks the painter, so a board can wear
 * the arena look, a procedural scene, or a felt table without a second helper.
 */
export function boardBackdrop(ctx, w, h, { variant = 'arena', palette = 'arcade', seed = 0, grid = true, horizon = 0.6, density = 22 } = {}) {
  if (variant === 'felt') return feltTable(ctx, w, h, { palette });
  if (variant === 'scene') return UI.paintScene(ctx, w, h, seed, { palette, density });
  return UI.arenaBackdrop(ctx, w, h, { palette, grid, stars: 54, horizon });
}

/**
 * A board on its art.
 *
 * Builds `.art-stage` — the painted backdrop, then `.art-stage-layer` holding
 * the board itself — and hands back the element to append to a game's render
 * tree.  The canvas is painted once, at mount, from the same seed every time:
 * the art is scenery, and no board needs a repaint loop for it.  It is scaled
 * by the device pixel ratio (capped at 2, because a scrim sits over it and the
 * extra fill rate would buy pixels nobody can see).
 *
 * The options that matter to CSS are published as custom properties:
 * `--art-base` is the palette's backdrop colour, `--art-glow` its first
 * accent, `--art-accent` its second and `--art-ink` a dark wash of the base.
 */
export function boardStage(gameId, { width = 880, height = 560, seed = 0, className = '', scrim = true, variant = null, palette = null, grid = null, horizon = null } = {}, ...children) {
  const art = BOARDS[gameId] || {};
  const back = variant || art.variant || 'arena';
  const key = palette || art.palette || 'arcade';
  const colors = UI.PALETTES[key] || UI.PALETTES.arcade;
  const dpr = Math.min(2, UI.pixelRatio());
  const el = UI.h('div', {
    class: `art-stage stage-${gameId} ${className}`.trim(),
    style: {
      '--art-base': colors[0],
      '--art-glow': colors[1],
      '--art-accent': colors[2] || colors[1],
      '--art-ink': UI.shadeColor(colors[0], -0.45),
    },
  });
  const canvas = UI.h('canvas', { class: 'art-stage-backdrop', width: Math.round(width * dpr), height: Math.round(height * dpr), 'aria-hidden': 'true' });
  canvas.style.aspectRatio = `${width} / ${height}`;
  const layer = UI.h('div', { class: `art-stage-layer ${scrim ? 'scrim' : ''}`.trim() }, ...children);
  el.appendChild(canvas);
  el.appendChild(layer);
  // Same deferral as canvasBox(): the element is built synchronously for the
  // render pass to keep working with, painted on the next microtask.
  queueMicrotask(() => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    boardBackdrop(ctx, width, height, {
      variant: back,
      palette: key,
      seed,
      grid: grid === null ? art.grid !== false : grid,
      horizon: horizon ?? art.horizon ?? 0.6,
    });
  });
  return el;
}

export default { BOARDS, boardStage, boardBackdrop, feltTable };
