import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader (no dependency, never overwrites real env vars). */
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
/**
 * True when we are running on a hosting platform (Render, Fly, Railway, ...).
 * Platforms inject PORT and expect the process to bind exactly that port - we
 * must not fall back to a different one, and there is no "same wifi" to join.
 */
export const onPlatform = !!env.RENDER || env.NODE_ENV === 'production' || !!env.MEMES_PLATFORM;
/** Hosting platforms set PORT; treat 0/empty as "not set" so we never bind a random port locally. */
const portEnv = num(env.MEMES_PORT, NaN);
const port = Number.isFinite(portEnv) ? portEnv : num(env.PORT, 8787);

/** Render sets RENDER_EXTERNAL_URL; MEMES_PUBLIC_URL always wins when set. */
const publicUrl = (env.MEMES_PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

export const config = {
  host: env.MEMES_HOST || '0.0.0.0',
  port: port > 0 ? port : 8787,
  /** A platform expects the exact PORT - never pick a different port there. */
  strictPort: !!env.PORT || !!env.MEMES_PORT || onPlatform,
  onPlatform,
  dataDir: path.resolve(ROOT, env.MEMES_DATA || 'data'),
  /** True when the data dir is mounted outside the repo (a Render persistent disk). */
  dataOnDisk: !!env.MEMES_DATA && path.isAbsolute(env.MEMES_DATA),
  webDir: path.join(ROOT, 'web'),
  publicUrl,

  /** Seeded administrator: the account named in the project brief. */
  admin: {
    username: env.MEMES_ADMIN_USER || 'memegodmidas',
    password: env.MEMES_ADMIN_PASS || '', // empty -> generated on first boot
  },

  registrationsOpen: env.MEMES_REGISTRATIONS !== 'closed',
  cors: env.MEMES_CORS !== 'off',
  /** Comma separated origins; '*' allows everything (fine for LAN play). */
  corsOrigins: (env.MEMES_CORS_ORIGINS || '*').split(',').map((s) => s.trim()),

  /** Discord bot bridge. */
  discord: {
    token: env.DISCORD_TOKEN || '',
    appId: env.DISCORD_APP_ID || '',
    guildId: env.DISCORD_GUILD_ID || '',
    enabled: !!env.DISCORD_TOKEN,
  },

  sessionTtlDays: num(env.MEMES_SESSION_DAYS, 30),
  maxWsMessage: num(env.MEMES_MAX_WS, 6 * 1024 * 1024),
  /** How long a disconnected party member keeps their seat before cleanup. */
  partyGraceMs: num(env.MEMES_PARTY_GRACE_MS, 20000),
  /** How long a disconnected room seat (or viewer) is kept before cleanup. */
  roomGraceMs: num(env.MEMES_ROOM_GRACE_MS, 20000),
  /**
   * How often the server checks whether a scheduled feature window opened or
   * closed and pushes the change to everybody online.  The floor keeps a bad
   * value from turning into a busy loop.
   */
  scheduleTickMs: Math.max(250, num(env.MEMES_SCHEDULE_TICK_MS, 20000)),
  logLevel: env.MEMES_LOG || 'info',
  /** Optional shared secret so a public server can keep /api/admin private. */
  adminToken: env.MEMES_ADMIN_TOKEN || '',
  /**
   * Public instances get a stable bot secret from the environment, because the
   * data directory (data/bot-secret.txt) is wiped on every Render redeploy.
   */
  botSecret: env.MEMES_BOT_SECRET || '',
  version: '1.0.0',
};

export function ensureDirs() {
  for (const dir of [config.dataDir, path.join(config.dataDir, 'saves'), path.join(config.dataDir, 'logs')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let cachedSecret = null;
/** Persisted signing secret so sessions survive restarts without .env edits. */
export function serverSecret() {
  if (cachedSecret) return cachedSecret;
  const file = path.join(config.dataDir, 'secret.key');
  try {
    if (fs.existsSync(file)) {
      cachedSecret = fs.readFileSync(file, 'utf8').trim();
      if (cachedSecret.length >= 32) return cachedSecret;
    }
  } catch {}
  cachedSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  } catch {}
  return cachedSecret;
}

export function log(...args) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}]`, ...args);
}

/**
 * True when the app's data (JSON db, secret.key) is wiped on redeploy. Render's
 * data dir is ephemeral unless a persistent disk is mounted at config.dataDir,
 * which the Blueprint does by setting MEMES_DATA to an absolute mount path.
 */
export function dataIsEphemeral() {
  return onPlatform && !config.dataOnDisk;
}
