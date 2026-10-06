import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 - readable codes

export function id(size = 16) {
  return crypto.randomBytes(size).toString('base64url');
}

export function token(size = 32) {
  return crypto.randomBytes(size).toString('base64url');
}

/** Human-friendly room code, e.g. "ARCADE-7Q4K" or "7Q4K". */
export function code(len = 4, prefix = '') {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return prefix ? `${prefix}-${out}` : out;
}

export function inviteCode() {
  return code(6);
}

export function now() {
  return Date.now();
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * mulberry32 - small deterministic RNG.  Used by game engines so that a match
 * can be replayed/verified from an action log, and so the server and clients
 * never disagree about a "random" outcome.
 */
export function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(String(seed ?? Date.now()));
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pick(arr, r) {
  return arr[Math.floor((r ?? Math.random)() * arr.length)];
}

export function shuffle(arr, r) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Clamp + coerce a number coming from a client. */
export function clampInt(v, min, max, fallback = min) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
