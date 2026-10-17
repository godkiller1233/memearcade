/**
 * Starts the Discord bot together with the website.
 *
 * The bot stays a separate process - it holds the Discord gateway, and a crash
 * or a bad token there must not take the arcade down - but it is part of the
 * product, not a second thing to remember to run. This supervisor starts it
 * once the HTTP server is listening, hands it the address and bot secret this
 * server actually uses, restarts it if it falls over, and stops it with the
 * site.
 *
 * A token is read from the same two places as before: the environment (which
 * already includes the root .env) or bot/.env. No token means nothing starts,
 * and MEMES_BOT_AUTOSTART=off disables it entirely - the test suites set that
 * so a developer's real token is never spent on a scratch arcade.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';

const ENTRY = path.join(ROOT, 'bot', 'index.js');
const ENV_FILE = path.join(ROOT, 'bot', '.env');

/** A bot that dies faster than this did not really get going. */
const STABLE_MS = 60000;
/**
 * Wait before each retry: it grows to a five-minute ceiling and stays there.
 *
 * The supervisor never gives up while the site is up. "The website works but
 * the bot is offline" is the one state this exists to prevent, and it is what
 * happened when it used to stop after five failures - a Discord blip, a restart
 * that raced the gateway, or a token fixed five minutes later all left the site
 * healthy and the bot gone until someone restarted the whole service. The
 * ceiling is what keeps that promise honest: a hopeless configuration (a
 * rejected token) retries about once every five minutes instead of hammering.
 */
const RESTART_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000, 300000];

/** The wait before attempt N (0-based), capped at the last delay. */
export function botRetryDelay(attempt) {
  const n = Number.isFinite(Number(attempt)) ? Math.max(0, Math.trunc(Number(attempt))) : 0;
  return RESTART_DELAYS[Math.min(n, RESTART_DELAYS.length - 1)];
}

/** How long the bot gets to answer SIGTERM before it is taken out. */
const STOP_GRACE_MS = 4000;

/**
 * Exit codes the bot uses for failures it knows about (bot/index.js), so a
 * restart reason on /api/health says "Discord rejected the token" instead of
 * just "exited with code 3".
 */
const EXIT_NOTES = new Map([
  [2, 'the bot refused its configuration (a missing or malformed setting)'],
  [3, 'Discord rejected the token'],
]);

/** Human words for a child exit, for the banner and /api/health. */
export function describeBotExit(code, signal = null) {
  if (signal) return `stopped by ${signal}`;
  const note = EXIT_NOTES.get(code);
  return `exited with code ${code}${note ? ` - ${note}` : ''}`;
}

/** The same one `KEY=value` per line contract the server and bot both read. */
export function readBotEnv(file = ENV_FILE) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/** `MEMES_BOT_AUTOSTART=off` (or 0/false/no) keeps the site from starting it. */
export function autoStartEnabled(env = process.env) {
  const flag = String(env.MEMES_BOT_AUTOSTART ?? '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(flag);
}

/** Where a bot on this machine reaches this server - never the bind wildcard. */
export function botConnectionUrl(port, host = '') {
  const raw = String(host || '').trim();
  let name = raw;
  if (!raw || raw === '0.0.0.0' || raw === '::' || raw === '[::]' || raw === '*') name = '127.0.0.1';
  else name = name.replace(/^\[|\]$/g, '');
  return `http://${name.includes(':') ? `[${name}]` : name}:${port}`;
}

/**
 * @returns {{running: boolean, reason: string, pid: number|null, url: string, stop: () => Promise<void>}}
 *   Always an object: the banner and the shutdown both use it, and "not
 *   running" is a normal answer, not an error.
 */
export function startBot({ port, secret, host = config.host, log = () => {}, env = process.env } = {}) {
  const stopped = Promise.resolve();
  const notRunning = (reason) => {
    log(`Discord bot: not started - ${reason}`);
    return { running: false, reason, pid: null, url: '', stop: () => stopped };
  };

  if (!fs.existsSync(ENTRY)) return notRunning('bot/index.js is missing');

  const fileEnv = readBotEnv();
  // Real environment and the root .env (already merged into it) win over
  // bot/.env, exactly as the bot's own loader does.
  const merged = { ...fileEnv, ...env };
  // Read from the merged view too, so the switch works where people keep the
  // rest of the bot's settings: bot/.env.
  if (!autoStartEnabled(merged)) return notRunning('MEMES_BOT_AUTOSTART is off');
  // A dashboard value pasted with a trailing newline or space is a token
  // Discord rejects, and it looks identical to a correct one in the UI - so it
  // is trimmed here, and the trimmed value is what the child is handed.
  const rawToken = String(merged.DISCORD_TOKEN ?? '');
  const token = rawToken.trim();
  if (!token) return notRunning('no DISCORD_TOKEN in bot/.env or the environment');
  if (rawToken !== token) {
    log('Discord bot: DISCORD_TOKEN had surrounding whitespace (a pasted newline?) - using the trimmed value');
  }
  if (typeof WebSocket !== 'function') {
    return notRunning(`Node ${process.version} has no built-in WebSocket (the bot needs Node 22+)`);
  }
  if (!secret) return notRunning('this server has no bot secret to hand it');

  const url = botConnectionUrl(port, host);
  const childEnv = {
    ...merged,
    // The trimmed token, so a newline pasted into the dashboard cannot make
    // Discord answer 401 for a value that looks right in the UI.
    DISCORD_TOKEN: token,
    // The site's own values, not whatever a stale bot/.env remembers: the
    // secret may have been rotated and the port is only known now.
    ARCADE_URL: url,
    ARCADE_BOT_SECRET: secret,
    // If this process is killed without a chance to stop it (SIGKILL, a crash,
    // node --watch), the bot notices and exits instead of staying online as a
    // duplicate answering every command twice.
    BOT_PARENT_PID: String(process.pid),
  };

  let child = null;
  let stopping = false;
  let restartTimer = null;
  let attempts = 0;
  let startedAt = 0;
  /** What /api/health and the banner report as the current state. */
  let status = 'started with the site';

  const schedule = (reason) => {
    if (stopping || restartTimer) return;
    // A run that lasted counts as a fresh start: the next failure begins the
    // quick first retries again instead of starting at five minutes.
    const lifespan = Date.now() - startedAt;
    if (lifespan >= STABLE_MS) attempts = 0;
    attempts += 1;
    const delay = botRetryDelay(attempts - 1);
    status = `restarting in ${Math.round(delay / 1000)}s: ${reason}`;
    log(`Discord bot: ${reason} - retrying in ${Math.round(delay / 1000)}s (attempt ${attempts})`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, delay);
    restartTimer.unref?.();
  };

  const start = () => {
    if (stopping) return;
    startedAt = Date.now();
    let proc;
    try {
      proc = spawn(process.execPath, [ENTRY], {
        cwd: ROOT,
        env: childEnv,
        // Inherit stdout/stderr: the bot's own [bot] lines already say who is
        // talking, and it writes straight to this terminal - no wrapper to add
        // a second prefix or to lose the last line of a crash.
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (err) {
      schedule(`could not spawn it: ${err.message}`);
      return;
    }
    child = proc;
    status = 'started with the site';
    log(`Discord bot: started (pid ${proc.pid}) against ${url}`);
    proc.once('error', (err) => {
      if (child === proc) child = null;
      schedule(`could not start: ${err.message}`);
    });
    proc.once('exit', (code, signal) => {
      if (child === proc) child = null;
      if (stopping) return;
      schedule(describeBotExit(code, signal));
    });
  };

  const stop = () => {
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const proc = child;
    child = null;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let killTimer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      proc.once('exit', done);
      killTimer = setTimeout(() => {
        log(`Discord bot: did not stop in ${Math.round(STOP_GRACE_MS / 1000)}s - killing it`);
        try {
          proc.kill('SIGKILL');
        } catch {}
        done();
      }, STOP_GRACE_MS);
      killTimer.unref?.();
      try {
        proc.kill('SIGTERM');
      } catch {
        done();
      }
    });
  };

  start();

  return {
    get running() {
      return !!child && !stopping;
    },
    get reason() {
      return status;
    },
    get pid() {
      return child?.pid ?? null;
    },
    /** How many times it has been restarted since the last stable run. */
    get attempts() {
      return attempts;
    },
    url,
    stop,
  };
}
