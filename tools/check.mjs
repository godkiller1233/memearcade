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
 *  5. verifies the feature-switch descriptors and the scheduled-window
 *     resolver (an over-midnight or day-of-week bug there would close a
 *     feature at the wrong hour everywhere at once)
 *  6. verifies the build stamp: stable while nothing ships, and moved by any
 *     served asset or MEMES_REVISION (it is what tells an open tab to reload)
 *
 * Exit code is non-zero when anything fails, so it doubles as CI.
 */
import fs from 'node:fs';
import os from 'node:os';
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

console.log('\n[1/6] syntax check');
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

console.log('\n[2/6] engine modules import cleanly in Node');
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

console.log('\n[3/6] catalog ↔ engine wiring');
const registry = await import(pathToFileURL(path.join(ROOT, 'web', 'games', 'registry.js')).href);
const listed = registry.GAMES.filter((g) => g.engine);
const missing = listed.filter((g) => !loaded.has(g.engine));
const orphan = [...loaded.keys()].filter((id) => !registry.GAMES.some((g) => g.engine === id || g.id === id));
report(true, `${registry.GAMES.length} catalog entries, ${loaded.size} engines implemented`);
if (missing.length) console.log(`  note  ${missing.length} catalog games await their engine: ${missing.map((g) => g.id).join(', ')}`);
if (orphan.length) report(false, 'engines with no catalog entry', orphan.join(', '));

console.log('\n[4/6] client ↔ server version agreement');
const shared = await import(pathToFileURL(path.join(ROOT, 'shared', 'version.js')).href);
const webStore = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'store.js')).href);
report(webStore.CLIENT_VERSION === shared.APP_VERSION, 'web client version matches the app version', `${webStore.CLIENT_VERSION} vs ${shared.APP_VERSION}`);
report(Number(webStore.API_VERSION) === Number(shared.API_VERSION), 'web client API version matches the server API', `v${webStore.API_VERSION} vs v${shared.API_VERSION}`);

// Feature switches: the markup names the switch that owns each nav entry, and
// a typo there would silently leave a hidden feature visible (or hide the wrong
// tab), so the ids are checked against the server's descriptor list.
const featureMod = await import(pathToFileURL(path.join(ROOT, 'shared', 'features.js')).href);
const indexHtml = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const marked = [...indexHtml.matchAll(/data-feature="([^"]+)"/g)].map((m) => m[1]);
const unknownFeatures = [...new Set(marked)].filter((id) => !featureMod.FEATURE_IDS.includes(id));
report(unknownFeatures.length === 0, 'every data-feature in index.html is a real feature switch', unknownFeatures.join(', '));
report(marked.length > 0, 'the client marks feature-owned elements in index.html', 'no data-feature attribute found');
const badGroups = featureMod.FEATURES.filter((f) => !featureMod.FEATURE_GROUPS.includes(f.group));
report(badGroups.length === 0, 'every feature belongs to a declared group', badGroups.map((f) => f.id).join(', '));
const dupes = featureMod.FEATURE_IDS.filter((id, i) => featureMod.FEATURE_IDS.indexOf(id) !== i);
report(dupes.length === 0, 'feature ids are unique', dupes.join(', '));

console.log('\n[5/6] scheduled feature windows and role keep-floors');

// Fixed local dates: 2026-10-07 is a Wednesday, so these never depend on when
// CI runs or which timezone it runs in.
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const sched = (over = {}) => ({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '08:00', ...over });
report(featureMod.parseClock('22:00') === 79200 && featureMod.parseClock('7:05:09') === 25509 && featureMod.parseClock('24:00') === null && featureMod.parseClock('nope') === null, 'clock parsing accepts HH:MM[:SS] and rejects nonsense');
report(featureMod.clockText(25509) === '07:05:09' && featureMod.clockText(79200) === '22:00', 'clock text round-trips, seconds only when they matter');
report(featureMod.scheduleActive(sched(), at(2026, 10, 7, 21, 59)) === false, 'a schedule is open before its window');
report(featureMod.scheduleActive(sched(), at(2026, 10, 7, 22, 0)) === true, 'a schedule closes at its start minute');
report(featureMod.scheduleActive(sched(), at(2026, 10, 8, 7, 59, 59)) === true, 'an over-midnight window is still closed in the morning');
report(featureMod.scheduleActive(sched(), at(2026, 10, 8, 8, 0)) === false, 'an over-midnight window reopens at its end minute');
report(featureMod.scheduleActive(sched({ days: [1, 2, 3] }), at(2026, 10, 8, 7, 0)) === true, 'the morning after a selected day is covered');
report(featureMod.scheduleActive(sched({ days: [1, 2, 3] }), at(2026, 10, 9, 7, 0)) === false, 'the morning after an unselected day is open');
report(featureMod.scheduleActive(sched({ enabled: false }), at(2026, 10, 7, 23, 0)) === false, 'a paused schedule never closes anything');
report(featureMod.scheduleActive(sched({ from: '00:00', to: '00:00' }), at(2026, 10, 7, 13, 0)) === true, 'equal times mean the whole day');
report(featureMod.normalizeSchedule({ enabled: true, days: [], from: '', to: '' }).days.length === 7, 'a schedule with no days defaults to every day');
report(featureMod.normalizeSchedule(null) === null, 'no schedule stays no schedule');
const nextOpen = featureMod.nextScheduleChange(sched(), at(2026, 10, 7, 23, 0));
report(nextOpen?.getHours() === 8 && nextOpen.getDate() === 8, 'nextScheduleChange() points at the reopening', String(nextOpen));
report(featureMod.nextScheduleChange(sched(), at(2026, 10, 7, 12, 0))?.getHours() === 22, 'nextScheduleChange() points at the next closing when open');

// The effective view: a scheduled close must look like a manual off to every
// consumer, plus the reason and the reopen stamp the client shows.
const schedConfig = { features: { chat: { on: true, hidden: false, schedule: sched() }, rooms: { on: true, hidden: true } } };
report(featureMod.featureOn(schedConfig, 'chat', at(2026, 10, 7, 23, 0)) === false, 'featureOn() refuses a feature inside its window');
report(featureMod.featureOn(schedConfig, 'chat', at(2026, 10, 7, 12, 0)) === true, 'featureOn() serves it outside the window');
report(featureMod.featureClosed(schedConfig, 'chat', at(2026, 10, 7, 23, 0)) === true && featureMod.featureClosed(schedConfig, 'rooms', at(2026, 10, 7, 23, 0)) === false, 'featureClosed() only answers for features with a window');
const closedFlags = featureMod.featureFlags(schedConfig, at(2026, 10, 7, 23, 0));
report(closedFlags.chat.on === false && closedFlags.chat.hidden === true && closedFlags.chat.scheduled === true, 'featureFlags() reports a scheduled close as off and hidden');
report(typeof closedFlags.chat.until === 'string' && new Date(closedFlags.chat.until) > at(2026, 10, 7, 23, 0), 'featureFlags() stamps when the feature reopens', String(closedFlags.chat.until));
report(closedFlags.rooms.on === true && closedFlags.rooms.hidden === true, 'a manual hidden stays hidden while open');
report(featureMod.featureFlags(schedConfig, at(2026, 10, 7, 12, 0)).chat.scheduled === undefined, 'an open schedule changes nothing');
report(featureMod.featureFlags({ features: { chat: { on: false, schedule: sched() } } }, at(2026, 10, 7, 23, 0)).chat.scheduled === undefined, 'a manually switched-off feature is not reported as scheduled');

// A schedule must survive a trip through storage and a manual switch edit.
const roundTrip = featureMod.normalizeFeatures({ chat: { on: false, schedule: sched({ days: [5], from: '23:30', to: '01:00' }) } });
report(roundTrip.chat.schedule?.days?.[0] === 5 && roundTrip.chat.on === false, 'normalizeFeatures keeps a schedule, including over-midnight times');
report(featureMod.normalizeFeatures({ chat: { on: true } }).chat.schedule === undefined, 'a feature without a schedule stores none');
report(featureMod.normalizeFeatures({ chat: { on: true, schedule: { enabled: true, days: [9, -1, 'x'], from: 'garbage', to: '' } } }).chat.schedule.days.length === 7, 'junk days and clocks are repaired, not stored');

// Role keep-floors: the same switches resolved for one role.  A feature kept
// for a rung stays available to that rung and stays refused below it, which is
// what lets an owner keep a feature for VIPs while players lose it.
const roleConfig = {
  features: {
    chat: { on: false, minRole: 'vip' },
    friends: { on: true, hidden: true, minRole: 'admin' },
    dm: { on: false },
  },
  games: { pong: { on: false, minRole: 'vip' }, chess: { on: false } },
};
report(featureMod.normalizeKeepRole('vip') === 'vip' && featureMod.normalizeKeepRole('root') === 'mod' && featureMod.normalizeKeepRole(undefined) === 'mod', 'a keep-floor is a known rung or the staff default');
report(featureMod.roleRank('owner') > featureMod.roleRank('admin') && featureMod.roleRank('admin') > featureMod.roleRank('mod') && featureMod.roleRank('mod') > featureMod.roleRank('vip') && featureMod.roleRank('vip') > featureMod.roleRank('user') && featureMod.roleRank('guest') === 0, 'the role ladder runs guest < user < vip < mod < admin < owner');
report(featureMod.featureKept(roleConfig, 'chat', 'vip') && featureMod.featureKept(roleConfig, 'chat', 'mod') && !featureMod.featureKept(roleConfig, 'chat', 'user') && !featureMod.featureKept(roleConfig, 'chat', 'guest'), 'a feature is kept for its rung and above, never below');
report(featureMod.featureAllowed(roleConfig, 'chat', { role: 'vip' }) === true && featureMod.featureAllowed(roleConfig, 'chat', { role: 'user' }) === false, 'featureAllowed() answers for one role');
report(featureMod.featureAllowed(roleConfig, 'dm', { role: 'mod' }) === true && featureMod.featureAllowed(roleConfig, 'dm', { role: 'user' }) === false, 'the default keep-floor keeps staff and refuses players');
report(featureMod.featureKept(roleConfig, 'friends', 'admin') === true && featureMod.featureKept(roleConfig, 'friends', 'mod') === false, 'a hidden feature honours an admin floor over a moderator');
const vipFlags = featureMod.featureFlags(roleConfig, at(2026, 10, 7, 12, 0), { role: 'vip' });
report(vipFlags.chat.on === true && vipFlags.chat.hidden === false, 'featureFlags() lifts both switches for a kept role', JSON.stringify(vipFlags.chat));
report(featureMod.featureFlags(roleConfig, at(2026, 10, 7, 12, 0), { role: 'admin' }).friends.hidden === false, 'a kept role sees a hidden feature as shown');
report(featureMod.featureFlags(roleConfig, at(2026, 10, 7, 12, 0), { role: 'user' }).chat.on === false, 'featureFlags() still refuses a role below the floor');
report(featureMod.featureFlags(roleConfig, at(2026, 10, 7, 12, 0)).chat.on === false, 'featureFlags() defaults to the strictest viewer (guest)');
const keptWindow = { features: { chat: { on: true, minRole: 'vip', schedule: sched({ from: '00:00', to: '00:00' }) } } };
report(featureMod.featureAllowed(keptWindow, 'chat', { role: 'vip', date: at(2026, 10, 7, 23, 0) }) === true, 'the keep-floor also covers a scheduled window');
report(featureMod.featureAllowed(keptWindow, 'chat', { role: 'user', date: at(2026, 10, 7, 23, 0) }) === false, 'a window still closes the feature for roles below the floor');
report(featureMod.featureFlags(keptWindow, at(2026, 10, 7, 23, 0), { role: 'vip' }).chat.scheduled === undefined, 'a kept role is never told the feature is scheduled shut');
report(/turned off on this arcade/.test(featureMod.featureRefusal({ features: { chat: { on: false } } }, 'chat')), 'the default floor keeps the arcade-wide refusal wording');
report(/kept for VIPs/.test(featureMod.featureRefusal(roleConfig, 'chat')), 'a role-kept feature names who keeps it', featureMod.featureRefusal(roleConfig, 'chat'));

// The same keep-floor for one catalog entry.
report(featureMod.gameKept(roleConfig, 'pong', 'vip') && !featureMod.gameKept(roleConfig, 'pong', 'user'), 'a game is kept for its rung and above');
report(featureMod.gameAllowed(roleConfig, 'pong', { role: 'vip' }) === true && featureMod.gameAllowed(roleConfig, 'pong', { role: 'user' }) === false, 'gameAllowed() answers for one role');
report(featureMod.visibleGames(roleConfig, [{ id: 'pong' }, { id: 'chess' }], { role: 'vip' }).length === 1, 'a kept role gets a switched-off game back in the list');
report(featureMod.visibleGames(roleConfig, [{ id: 'pong' }, { id: 'chess' }], { role: 'user' }).length === 0, 'everyone below the floor loses it');
report(featureMod.normalizeGames({ pong: { on: false, minRole: 'vip' } }).pong.minRole === 'vip' && featureMod.normalizeGames({ pong: { on: false, minRole: 'x' } }).pong.minRole === 'mod', 'game keep-floors normalize like feature ones');
report(/kept for VIPs/.test(featureMod.gameRefusal(roleConfig, 'pong', 'Ping Pong')), 'a kept game names who keeps it', featureMod.gameRefusal(roleConfig, 'pong', 'Ping Pong'));
report(featureMod.KEEP_ROLES.includes('user') && featureMod.KEEP_ROLES.includes('owner') && !featureMod.KEEP_ROLES.includes('guest'), 'the offered rungs run user..owner, never guest');
report(featureMod.featureKeepRole({}, 'not-a-feature') === 'mod' && featureMod.featureKept({}, 'not-a-feature', 'guest') === false, 'an unknown id reads as the staff default, never as a raised floor');
report(Object.keys(featureMod.KEEP_ROLE_LABELS).length === featureMod.KEEP_ROLES.length, 'every rung has a console label');

console.log('\n[6/6] build stamp');

// The stamp is what tells an open tab that a new build is being served.  It
// must stay put while nothing changes (or every client would reload for no
// reason) and move for any shipped asset (or nobody would ever reload).
const buildMod = await import(pathToFileURL(path.join(ROOT, 'server', 'lib', 'build.js')).href);
const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memes-stamp-'));
const realAssetDir = process.env.MEMES_ASSET_DIR;
const realRevision = process.env.MEMES_REVISION;
try {
  delete process.env.MEMES_REVISION;
  process.env.MEMES_ASSET_DIR = assetDir;
  fs.writeFileSync(path.join(assetDir, 'app.js'), 'one');
  fs.mkdirSync(path.join(assetDir, 'css'));
  fs.writeFileSync(path.join(assetDir, 'css', 'app.css'), 'two');
  fs.writeFileSync(path.join(assetDir, 'notes.txt'), 'not an asset');
  const first = buildMod.buildStamp({ force: true });
  report(/^[0-9a-f]{8,}$/.test(first), 'the stamp is a short hex id', first);
  report(buildMod.buildStamp({ force: true }) === first, 'the same assets stamp the same build');
  report(buildMod.buildStamp() === first, 'the memo answers with the same stamp inside its window');
  fs.writeFileSync(path.join(assetDir, 'notes.txt'), 'still not an asset');
  report(buildMod.buildStamp({ force: true }) === first, 'a file that is not served does not move the stamp');
  fs.writeFileSync(path.join(assetDir, 'app.js'), 'one, but edited');
  const edited = buildMod.buildStamp({ force: true });
  report(edited !== first, 'editing a served asset moves the stamp');
  fs.mkdirSync(path.join(assetDir, 'deeper'));
  fs.writeFileSync(path.join(assetDir, 'deeper', 'engine.js'), 'three');
  const added = buildMod.buildStamp({ force: true });
  report(added !== edited, 'a new engine moves the stamp');
  fs.rmSync(path.join(assetDir, 'deeper'), { recursive: true, force: true });
  report(buildMod.buildStamp({ force: true }) === edited, 'deleting it puts the stamp back');
  process.env.MEMES_REVISION = 'abc123';
  const revised = buildMod.buildStamp({ force: true });
  report(revised !== edited, 'MEMES_REVISION moves the stamp even when no file changed');
  delete process.env.MEMES_REVISION;
  report(buildMod.buildStamp({ force: true }) === edited, 'clearing MEMES_REVISION puts it back');
  delete process.env.MEMES_ASSET_DIR;
  const live = buildMod.buildStamp({ force: true });
  report(/^[0-9a-f]{8,}$/.test(live) && live !== edited, 'the real web tree stamps its own build', live);
  report(live === buildMod.buildStamp({ force: true }), 'the real tree is stable between reads');
} finally {
  if (realAssetDir === undefined) delete process.env.MEMES_ASSET_DIR;
  else process.env.MEMES_ASSET_DIR = realAssetDir;
  if (realRevision === undefined) delete process.env.MEMES_REVISION;
  else process.env.MEMES_REVISION = realRevision;
  fs.rmSync(assetDir, { recursive: true, force: true });
}

console.log(`\n${failures ? `✗ ${failures} failure(s)` : '✓ all checks passed'}\n`);
process.exit(failures ? 1 : 0);
