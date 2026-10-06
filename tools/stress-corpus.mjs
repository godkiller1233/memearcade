#!/usr/bin/env node
/**
 * The stress regression corpus.
 *
 *   npm run stress:corpus                # replay every entry, in order
 *   node tools/stress-corpus.mjs --json  # the corpus as a CI matrix (stdout only)
 *
 * `--stress` keeps one match playing while a seeded PRNG decides when the host
 * goes quiet, and that schedule is a pure function of (seed, stall count) - so
 * a timing that once went wrong can be pinned for good by adding its pair here.
 * That is the whole point of this file: the nightly run replays every entry on
 * a matrix (and this command replays them locally), so a fixed timing is never
 * quietly dropped from coverage again.
 *
 * The nightly workflow reads `--json` to build its matrix, so adding an entry
 * here is all it takes for the nightly to start covering it - there is no
 * second list to keep in step.
 *
 * When you add an entry because a run failed, put what happened in `why`, along
 * with the replay command the failure printed, e.g.
 *   { seed: 20260505, stalls: 8, why: 'refill took 640ms after a frozen stall' }
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Fixed schedules the stress run must always replay.  Keep them cheap enough
 * for a nightly: each entry is a full realtime match (roughly 5-8s per stall).
 */
export const STRESS_CORPUS = [
  {
    seed: 20261004,
    stalls: 5,
    why: 'the schedule every push runs (ci.yml) - the baseline the corpus must never lose',
  },
  {
    seed: 20260101,
    stalls: 3,
    why: 'a sparse schedule: few short stalls, so recovery follows long healthy stretches',
  },
  {
    seed: 20260505,
    stalls: 8,
    why: 'a dense schedule: many stalls in one match, so recoveries must not accumulate state',
  },
  {
    seed: 20260901,
    stalls: 5,
    why: 'a fourth timeline at the baseline load, for a different stall order and freeze mix',
  },
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = path.join(ROOT, 'tools', 'realtime-check.mjs');

/** One entry, replayed exactly as the failure message would tell you to. */
function replay({ seed, stalls }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SUITE, '--stress', '--seed', String(seed), '--stalls', String(stalls)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes('--json')) {
    // stdout carries the matrix and nothing else: the workflow captures it
    // straight into fromJSON(), so a stray log line would break the matrix.
    const matrix = STRESS_CORPUS.map(({ seed, stalls }) => ({ seed, stalls }));
    // Trailing newline included: the workflow captures this through a heredoc,
    // and without it the closing delimiter would be glued to the JSON.
    process.stdout.write(`${JSON.stringify(matrix)}\n`);
    process.exit(0);
  }

  let failed = 0;
  for (const [index, entry] of STRESS_CORPUS.entries()) {
    console.log(`\n──── ${index + 1}/${STRESS_CORPUS.length} · seed ${entry.seed}, ${entry.stalls} stalls ────`);
    console.log(`  ${entry.why}`);
    const code = await replay(entry);
    if (code === 0) {
      console.log(`  ok    seed ${entry.seed} passed`);
    } else {
      failed++;
      console.log(`  FAIL  seed ${entry.seed} failed — replay with: npm run stress -- --seed ${entry.seed} --stalls ${entry.stalls}`);
    }
  }

  console.log(`\n${failed ? `✗ ${failed} of ${STRESS_CORPUS.length} stress schedules failed` : `✓ all ${STRESS_CORPUS.length} stress schedules passed`}\n`);
  process.exit(failed ? 1 : 0);
}
