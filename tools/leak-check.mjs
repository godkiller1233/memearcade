#!/usr/bin/env node
/**
 * Stray-state check.
 *
 *   npm run leakcheck
 *
 * Every suite boots its own scratch arcade and writes scratch data, and every
 * suite is supposed to take both away again when it exits.  Run right after a
 * suite on the same runner (see the "No stray state" step in ci.yml), this
 * fails the build if anything of ours is still alive or still on disk:
 *
 *   processes  a scratch server or bot that outlived its suite (Linux: found by
 *              the MEMES_PLATFORM marker it was started with, or by running one
 *              of our server/bot entry points from this checkout)
 *   ports      anything still listening in a suite's scratch port band
 *   data       a scratch data dir under data/ that a suite failed to remove
 *   temp       a browser or desktop profile left behind in the temp dir
 *
 * It only ever looks at *our* scratch resources: a developer's real data/ (the
 * accounts and saves of a locally run arcade) is not a scratch dir and is left
 * alone, as is any port outside the scratch bands.
 *
 * The names it looks for are read out of the suites themselves - the data dir
 * each one joins under data/, the port base each one adds a random offset to,
 * the temp prefix each one makes, the platform marker each one injects - so a
 * new suite is covered the moment it exists instead of when someone remembers
 * to register it here.  PORT_BANDS is the one hand-written part: it is the
 * span every scratch port must fall inside, and the check fails if a suite's
 * base strays outside it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');
const DATA_ROOT = path.join(ROOT, 'data');

/**
 * Every scratch listener a suite may open must fall inside one of these bands.
 * Right now: smoke 8791-8830, the bot check's arcade 8811-8850 and fake Discord
 * 9411-9450, realtime 8831-8870, browser 8871-8910, desktop 8911-8930,
 * permission matrix 8931-8970.
 */
export const PORT_BANDS = [
  { from: 8791, to: 8970, what: 'scratch arcades (smoke, bot, realtime, browser, desktop, perm)' },
  { from: 9411, to: 9450, what: "the bot check's fake Discord" },
];

/**
 * In CI the report also goes where a red run can be read without opening the
 * raw log: every failure becomes a workflow annotation (the error panel beside
 * the failed step) and the whole report lands on the run's summary page, so a
 * leak names itself instead of hiding in a log nobody is signed in to read.
 * Both are output only - neither changes what the check decides.
 */
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';
const reportLines = [];

/** Console, plus the report body when a summary file was handed to us. */
const write = (text = '') => {
  console.log(text);
  if (SUMMARY_FILE) reportLines.push(text);
};
/** Workflow command escaping, so a `%` or newline in a path cannot break one. */
const esc = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

let failures = 0;
let passed = 0;
const check = (ok, label, detail = '') => {
  if (ok) passed++;
  else failures++;
  write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok && IN_ACTIONS) console.log(`::error title=stray state::${esc(label)}${detail ? ` — ${esc(detail)}` : ''}`);
  return ok;
};
const note = (text) => write(`  note  ${text}`);
/** Keep a report to a line: a leak is often dozens of paths. */
const list = (items, max = 6) => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} (+${items.length - max} more)`);

/* ------------------------------------------------------------------ *
 * what the suites declare (read from their sources)
 * ------------------------------------------------------------------ */

/** Source text of every suite, keyed by file name. */
export function suiteSources() {
  const sources = new Map();
  for (const file of fs.readdirSync(TOOLS).filter((f) => f.endsWith('.mjs') && f !== 'leak-check.mjs')) {
    sources.set(file, fs.readFileSync(path.join(TOOLS, file), 'utf8'));
  }
  return sources;
}

const collect = (sources, re) => {
  const out = new Set();
  for (const text of sources.values()) {
    for (const m of text.matchAll(re)) out.add(m[1]);
  }
  return [...out];
};

/** data/<name> dirs the suites create and must remove. */
export function scratchDataDirs(sources) {
  return collect(sources, /path\.join\(ROOT,\s*'data',\s*'([^']+)'\)/g).sort();
}

/** Temp dir prefixes the suites create and must remove. */
export function scratchTempPrefixes(sources) {
  return collect(sources, /mkdtempSync\(path\.join\(os\.tmpdir\(\),\s*'([^']+)'\)/g).sort();
}

/** MEMES_PLATFORM markers that mean "a scratch server of ours". */
export function scratchPlatforms(sources) {
  return collect(sources, /MEMES_PLATFORM:\s*'([^']+)'/g).sort();
}

/** The base of every scratch port, in start (and end) form, for the band guard. */
export function scratchPortSpans(sources) {
  const spans = [];
  for (const text of sources.values()) {
    for (const m of text.matchAll(/(\d{4,5})\s*\+\s*Math\.floor\(\s*Math\.random\(\)\s*\*\s*(\d+)\s*\)/g)) {
      spans.push({ from: Number(m[1]), to: Number(m[1]) + Number(m[2]) - 1 });
    }
    for (const m of text.matchAll(/\{\s*start:\s*(\d{4,5}),\s*span:\s*(\d+)\s*\}/g)) {
      spans.push({ from: Number(m[1]), to: Number(m[1]) + Number(m[2]) - 1 });
    }
  }
  return spans;
}

/* ------------------------------------------------------------------ *
 * reading the OS
 * ------------------------------------------------------------------ */

/**
 * Ports that are listening, from `netstat -ano` (Windows) or `ss -ltnH` /
 * `netstat -ltn` (elsewhere).  Pure, so it can be exercised on any platform.
 */
export function parseListeners(text, platform = process.platform) {
  const ports = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (platform === 'win32') {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.match(/:(\d{2,5})\s/);
      if (m) ports.add(Number(m[1]));
      continue;
    }
    // ss/netstat both put the local address:port in the column after Send-Q.
    const addr = line.trim().split(/\s+/)[3];
    const m = addr && addr.match(/:(\d{2,5})$/);
    if (m) ports.add(Number(m[1]));
  }
  return ports;
}

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Listening ports, or null when this platform has no tool we can drive. */
function listeningPorts() {
  const win = process.platform === 'win32';
  const primary = tryRun(win ? 'netstat' : 'ss', win ? ['-ano'] : ['-ltnH']);
  if (primary !== null) return parseListeners(primary, process.platform);
  if (!win) {
    const fallback = tryRun('netstat', ['-ltn']);
    if (fallback !== null) return parseListeners(fallback, process.platform);
  }
  return null;
}

/**
 * Processes from this checkout that are still running a suite-owned role.
 * Linux only - /proc is how we can see a command line at all - and null when
 * that is not available.
 */
export function scratchProcesses(platforms, selfPid = process.pid) {
  if (process.platform !== 'linux') return null;
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch {
      continue; // exited while we looked, or not ours to see
    }
    if (!cmdline.includes(ROOT)) continue;
    if (/server[\\/]index\.js|bot[\\/]index\.js/.test(cmdline)) {
      found.push({ pid, cmdline, why: 'a scratch server or bot is still running' });
      continue;
    }
    let env = '';
    try {
      env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue;
    }
    const marker = env.split('\0').find((kv) => kv.startsWith('MEMES_PLATFORM='));
    if (marker && platforms.includes(marker.slice('MEMES_PLATFORM='.length))) {
      found.push({ pid, cmdline, why: `a scratch server (${marker.slice('MEMES_PLATFORM='.length)}) is still running` });
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * the check
 * ------------------------------------------------------------------ */

export function runChecks() {
  const sources = suiteSources();
  const dataDirs = scratchDataDirs(sources);
  const tempPrefixes = scratchTempPrefixes(sources);
  const platforms = scratchPlatforms(sources);
  const spans = scratchPortSpans(sources);

  write('\n[1/4] the suites still describe what to look for');
  check(spans.length > 0 && dataDirs.length > 0, 'the suites were scanned', `${dataDirs.length} data dirs, ${spans.length} port spans`);
  const outside = spans.filter((s) => !PORT_BANDS.some((band) => s.from >= band.from && s.to <= band.to));
  check(outside.length === 0, 'every scratch port stays inside a checked band',
    outside.length ? `${outside.map((s) => `${s.from}-${s.to}`).join(', ')} — widen PORT_BANDS in tools/leak-check.mjs` : `${spans.map((s) => `${s.from}-${s.to}`).join(', ')}`);

  write('\n[2/4] no scratch process outlived its suite');
  const processes = scratchProcesses(platforms);
  if (processes === null) {
    note(`command lines are not readable on ${process.platform}, so only the port scan below can spot a leftover process`);
  } else {
    check(processes.length === 0, 'no scratch server or bot is still running',
      processes.length ? list(processes.map((p) => `pid ${p.pid}: ${p.why}`)) : `checked ${platforms.length} platform markers`);
  }

  write('\n[3/4] no scratch port is still listening');
  const open = listeningPorts();
  if (open === null) {
    note('neither ss nor netstat is available here, so the scratch ports could not be scanned');
  } else {
    const leaked = [...open].filter((p) => PORT_BANDS.some((band) => p >= band.from && p <= band.to)).sort((a, b) => a - b);
    check(leaked.length === 0, 'no scratch port is held by a leftover server',
      leaked.length ? `still listening: ${list(leaked)}` : `${PORT_BANDS.map((b) => `${b.from}-${b.to}`).join(', ')} clear`);
  }

  write('\n[4/4] no scratch data or temp dir was left behind');
  const leftDirs = dataDirs.filter((name) => fs.existsSync(path.join(DATA_ROOT, name)));
  check(leftDirs.length === 0, 'the suites removed their scratch data dirs',
    leftDirs.length ? `still on disk: ${list(leftDirs.map((n) => `data/${n}`))}` : `checked ${dataDirs.map((n) => `data/${n}`).join(', ')}`);
  const tempLeft = [];
  for (const prefix of tempPrefixes) {
    let entries = [];
    try {
      entries = fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith(prefix));
    } catch {}
    tempLeft.push(...entries.map((e) => path.join(os.tmpdir(), e)));
  }
  check(tempLeft.length === 0, 'the suites removed their temp profiles',
    tempLeft.length ? `still on disk: ${list(tempLeft)}` : `${tempPrefixes.join(', ')} clear`);

  return failures;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    runChecks();
  } catch (err) {
    failures++;
    console.error(`\nLeak check crashed: ${err.stack || err.message}`);
    reportLines.push(`Leak check crashed: ${err.message}`);
  }
  const verdict = failures
    ? `✗ ${failures} stray-state failure(s), ${passed} passed`
    : `✓ no stray state: ${passed} checks passed`;
  write(`\n${verdict}\n`);
  if (SUMMARY_FILE) {
    try {
      fs.appendFileSync(SUMMARY_FILE, ['## Stray state', '', verdict, '', '```', ...reportLines, '```', ''].join('\n'));
    } catch (err) {
      console.error(`could not write the step summary: ${err.message}`);
    }
  }
  process.exit(failures ? 1 : 0);
}
