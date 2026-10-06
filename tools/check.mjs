#!/usr/bin/env node
/**
 * Static health check for the whole repo:
 *  1. syntax-checks every .js/.mjs file (Node treats them per package type)
 *  2. imports every browser-shared engine module in Node to prove it stays
 *     DOM-free and uses only valid helpers
 *  3. verifies the catalog references only engine ids that exist (or are
 *     explicitly planned)
 *  4. verifies the web client advertises the same versions as shared/version.js
 *     (a drift there makes the server flag every client as degraded)
 *
 * Exit code is non-zero when anything fails, so it doubles as CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', '.freebuff']);
const ENGINE_DIR = path.join(ROOT, 'web', 'games', 'engines');

let failures = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(m?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

console.log('\n[1/4] syntax check');
const files = walk(ROOT);
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures++;
    console.log(` FAIL  ${path.relative(ROOT, file)}`);
    console.log(String(err.stderr || err.stdout || err.message).split('\n').slice(0, 8).join('\n'));
  }
}
report(true, `${files.length} javascript files parsed`);

console.log('\n[2/4] engine modules import cleanly in Node');
const engineFiles = fs.existsSync(ENGINE_DIR)
  ? fs.readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.js') && !['util.js', 'ui.js', 'index.js', 'art.js'].includes(f))
  : [];
const loaded = new Map();
for (const file of engineFiles) {
  try {
    const mod = await import(pathToFileURL(path.join(ENGINE_DIR, file)).href);
    const engines = [];
    if (mod.default?.meta) engines.push(mod.default);
    for (const [key, value] of Object.entries(mod)) {
      if (key !== 'default' && value?.meta && typeof value.create === 'function') engines.push(value);
    }
    for (const engine of engines) {
      loaded.set(engine.meta.id, { file, engine });
      // sanity: a state must be JSON-serialisable (it crosses the wire)
      const state = engine.create({
        players: [
          { id: 'a', name: 'A', kind: 'human' },
          { id: 'b', name: 'B', kind: 'bot', level: 2 },
        ],
        options: {},
        rng: Math.random,
        seed: 1234,
        bots: 1,
      });
      JSON.stringify(state);
      const view = engine.view(state, 'a');
      JSON.stringify(view);
      if (typeof engine.act !== 'function') throw new Error('missing act()');
      if (typeof engine.over !== 'function') throw new Error('missing over()');
      if (typeof engine.render !== 'function') throw new Error('missing render()');
    }
    report(true, `${file} → ${engines.length} engine(s)`);
  } catch (err) {
    report(false, file, err.message);
  }
}
if (!engineFiles.length) console.log('  (no engine files yet)');

console.log('\n[3/4] catalog ↔ engine wiring');
const registry = await import(pathToFileURL(path.join(ROOT, 'web', 'games', 'registry.js')).href);
const listed = registry.GAMES.filter((g) => g.engine);
const missing = listed.filter((g) => !loaded.has(g.engine));
const orphan = [...loaded.keys()].filter((id) => !registry.GAMES.some((g) => g.engine === id || g.id === id));
report(true, `${registry.GAMES.length} catalog entries, ${loaded.size} engines implemented`);
if (missing.length) console.log(`  note  ${missing.length} catalog games await their engine: ${missing.map((g) => g.id).join(', ')}`);
if (orphan.length) report(false, 'engines with no catalog entry', orphan.join(', '));

console.log('\n[4/4] client ↔ server version agreement');
const shared = await import(pathToFileURL(path.join(ROOT, 'shared', 'version.js')).href);
const webStore = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'store.js')).href);
report(webStore.CLIENT_VERSION === shared.APP_VERSION, 'web client version matches the app version', `${webStore.CLIENT_VERSION} vs ${shared.APP_VERSION}`);
report(Number(webStore.API_VERSION) === Number(shared.API_VERSION), 'web client API version matches the server API', `v${webStore.API_VERSION} vs v${shared.API_VERSION}`);

console.log(`\n${failures ? `✗ ${failures} failure(s)` : '✓ all checks passed'}\n`);
process.exit(failures ? 1 : 0);
