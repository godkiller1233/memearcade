/**
 * Stopping a scratch child, and waiting until it is really gone.
 *
 * Every suite boots a scratch server (the bot check boots a bot as well) and
 * takes it away again before removing its scratch data dir.  A bare
 * `child.kill()` does not do that: it only delivers a signal, and the arcade
 * answers SIGTERM with a real shutdown - server/index.js closes the store,
 * which flushes db.json and mkdirSync's the data dir back into existence
 * (server/lib/db.js).  A suite that removes its data dir straight after kill()
 * is therefore racing a live writer: the directory it just deleted comes back,
 * the stray-state check finds it, and bot-check even died on ENOTEMPTY when
 * rmSync met a file that had reappeared underneath.
 *
 * Windows hides all of this - there is no SIGTERM a process can handle there,
 * so the first kill() terminates it on the spot and it never writes again -
 * which is exactly why it only ever failed on CI's Linux runners.
 *
 * stopChild() resolves only once the child has actually exited, and escalates
 * to a hard kill (SIGKILL, or taskkill /T /F on Windows so anything the child
 * spawned goes with it) if the polite signal is ignored.  It never rejects:
 * cleanup must not be the thing that fails an otherwise green suite.
 *
 * Importing this module has no side effects.
 */
import { spawn } from 'node:child_process';

/** How long a child gets to honour SIGTERM before it is taken out. */
export const STOP_GRACE_MS = 5000;
/** How long a hard-killed child gets to report its exit before we stop waiting. */
export const STOP_FORCE_MS = 3000;

/** SIGKILL on POSIX, taskkill /T /F on Windows (which also reaches the tree). */
function forceKill(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {}
}

/**
 * Stop `child` and wait for its exit event, escalating if it ignores SIGTERM.
 * @param {import('node:child_process').ChildProcess | null} [child]
 * @param {{graceMs?: number, forceMs?: number}} [opts]
 * @returns {Promise<void>} resolves when the child is gone (or, at worst, once
 *   the force window has passed without an exit to wait for).
 */
export function stopChild(child, { graceMs = STOP_GRACE_MS, forceMs = STOP_FORCE_MS } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);
    timer = setTimeout(() => {
      forceKill(child);
      // A kill nobody can observe is still no reason to hang the suite.
      timer = setTimeout(done, forceMs);
    }, graceMs);
    try {
      child.kill();
    } catch {
      done();
    }
  });
}
