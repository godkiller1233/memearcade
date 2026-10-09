/**
 * A fingerprint of the assets this process is serving.
 *
 * A browser tab (and the desktop shell, which loads the same site) keeps the
 * JavaScript and CSS it booted with until something reloads it. Ships a new
 * game, a redraw of the art or an ordinary bug fix and every open tab is still
 * running the old bundle - the live `config` push cannot reach code that was
 * never loaded. So every client is told which build it booted from, watches for
 * a different one, and offers the reload itself - see web/js/build-watch.js.
 *
 * The stamp hashes each asset's path, size and mtime rather than its bytes.
 * The web tree is about a megabyte of engines and stylesheets, and re-reading
 * all of it on every poll would be pure waste when size+mtime already moves for
 * any real edit. A deploy that can rewrite identical files should also set
 * MEMES_REVISION (the commit sha is ideal) - see docs/DEPLOY.md.
 */
import crypto from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(HERE, '..', '..', 'web');
const EXTENSIONS = new Set(['.js', '.css', '.html', '.svg', '.json']);
// Long enough that a polling client never stats the tree per request, short
// enough that whoever just deployed sees the new stamp on their first check.
const TTL_MS = 2000;

let cache = { at: 0, stamp: '' };

/** MEMES_ASSET_DIR points the stamp at the tree you actually deploy. */
function assetDir() {
  const fromEnv = String(process.env.MEMES_ASSET_DIR || '').trim();
  return fromEnv ? path.resolve(fromEnv) : DEFAULT_DIR;
}

function walk(dir, prefix, out, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a missing tree contributes nothing rather than throwing on a poll
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, `${prefix}${entry.name}/`, out, depth + 1);
      continue;
    }
    if (!EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const stat = statSync(full);
      out.push(`${prefix}${entry.name}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    } catch {
      // A file removed mid-walk simply drops out of the fingerprint.
    }
  }
}

/** The current stamp, e.g. `a1b2c3d4e5`. Stable between deploys. */
export function buildStamp({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.stamp && now - cache.at < TTL_MS) return cache.stamp;
  const files = [];
  walk(assetDir(), '', files);
  const hash = crypto.createHash('sha1');
  hash.update(files.join('\n'));
  const revision = String(process.env.MEMES_REVISION || '').trim();
  if (revision) hash.update(`|${revision}`);
  const stamp = hash.digest('hex').slice(0, 10);
  cache = { at: now, stamp };
  return stamp;
}
