import crypto from 'node:crypto';
import { db } from './db.js';
import { config, serverSecret } from '../config.js';
import { id as newId, token as newToken, now, code as makeCode, clampInt } from './ids.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ------------------------------------------------------------------ *
 * Passwords - scrypt with per-password salt, constant-time compare.
 * ------------------------------------------------------------------ */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const key = crypto.scryptSync(String(password), salt, hash.length / 2, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    const expected = Buffer.from(hash, 'hex');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Tokens / sessions
 * ------------------------------------------------------------------ */

export function createSession(userId, { kind = 'web', ttlDays = config.sessionTtlDays, ip = '' } = {}) {
  const tok = newToken(32);
  db.data.sessions[tok] = {
    userId,
    kind,
    created: now(),
    expires: now() + ttlDays * 86400000,
    ip,
  };
  db.touch();
  return tok;
}

export function sessionUser(tok) {
  if (!tok) return null;
  const s = db.data.sessions[tok];
  if (!s) return null;
  if (s.expires && s.expires < now()) {
    delete db.data.sessions[tok];
    db.touch();
    return null;
  }
  const user = db.data.users[s.userId];
  if (!user) return null;
  return { user, session: s, token: tok };
}

export function revokeSession(tok) {
  if (tok && db.data.sessions[tok]) {
    delete db.data.sessions[tok];
    db.touch();
  }
}

export function revokeUserSessions(userId, except) {
  for (const [tok, s] of Object.entries(db.data.sessions)) {
    if (s.userId === userId && tok !== except) delete db.data.sessions[tok];
  }
  db.touch();
}

/** Signed short-lived token used for bot account linking and invite links. */
export function signPayload(payload, ttlMs = 3600000) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', serverSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPayload(tok) {
  try {
    const [body, sig] = String(tok).split('.');
    const expect = crypto.createHmac('sha256', serverSecret()).update(body).digest('base64url');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const RESERVED = new Set(['admin', 'root', 'system', 'server', 'null', 'undefined', 'memes', 'arcade', 'mod', 'moderator']);

export function validateUsername(name) {
  const n = String(name ?? '').trim();
  if (n.length < 3 || n.length > 20) return { ok: false, error: 'Username must be 3-20 characters.' };
  if (!/^[A-Za-z0-9_.\- ]+$/.test(n)) return { ok: false, error: 'Letters, numbers, space, _ . - only.' };
  if (/^\s|\s$/.test(n)) return { ok: false, error: 'No leading or trailing space.' };
  if (RESERVED.has(n.toLowerCase())) return { ok: false, error: 'That name is reserved.' };
  return { ok: true, value: n };
}

export function validatePassword(pw) {
  const p = String(pw ?? '');
  if (p.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
  if (p.length > 200) return { ok: false, error: 'Password is too long.' };
  return { ok: true, value: p };
}

export function isValidDiscriminator() {
  return makeCode(4);
}

/* ------------------------------------------------------------------ *
 * Roles & permissions
 * ------------------------------------------------------------------ */

export const ROLES = {
  guest: 0,
  user: 1,
  vip: 2,
  mod: 3,
  admin: 4,
  owner: 5,
};

export function roleLevel(role) {
  return ROLES[role] ?? 0;
}

export function canManage(actor, target) {
  if (!actor || !target) return false;
  if (actor.id === target.id) return false;
  return roleLevel(actor.role) > roleLevel(target.role);
}

export function isStaff(user) {
  return !!user && roleLevel(user.role) >= ROLES.mod;
}

/* ------------------------------------------------------------------ *
 * Rate limiting - tiny token bucket, per key, in memory.
 * ------------------------------------------------------------------ */

const buckets = new Map();

export function rateLimit(key, max, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || t > b.reset) {
    b = { count: 0, reset: t + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (t > v.reset) buckets.delete(k);
  }
  return { ok: b.count <= max, remaining: Math.max(0, max - b.count), retryAfter: Math.max(0, b.reset - t) };
}

export function clampPage(v, def = 0, max = 200) {
  return clampInt(v ?? def, 0, max, def);
}
