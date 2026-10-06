/**
 * Guest sign-in that waits out a target's shared guest quota.
 *
 * `POST /api/auth/guest` is rate-limited per client IP: six sign-ins per five
 * minutes (server/api.js - `authRate(ctx, 'guest', 6, 300000)`).  A scratch
 * server hands every run a fresh bucket, so the limit is invisible there; a
 * deployed target shares one bucket across every client, which makes re-running
 * a suite against the same staging build the ordinary way to meet it.  Failing
 * on that turns a perfectly healthy build red, so this waits it out instead.
 *
 * The 429 carries no Retry-After today (the limiter computes one, but authRate
 * drops it), so the schedule below is sized to outlast the server's five-minute
 * window on its own.  A Retry-After header is honoured if one ever appears.
 *
 * Callers keep their own idea of what a non-ok response means - this only
 * handles the wait, and hands back the last response either way.
 */
import { setTimeout as sleep } from 'node:timers/promises';

/** The window authRate() gives the guest endpoint, in ms. */
export const GUEST_QUOTA_WINDOW_MS = 300000;

/** Waits that together outlast that window: ~6 minutes across 11 retries. */
export const GUEST_BACKOFF = { baseMs: 5000, factor: 2, capMs: 40000, attempts: 12 };

/** The delays between attempts, in order.  `attempts - 1` of them. */
export function guestBackoff({ baseMs = 5000, factor = 2, capMs = 40000, attempts = 12 } = {}) {
  const waits = [];
  for (let i = 0; i < Math.max(0, attempts - 1); i++) {
    waits.push(Math.min(capMs, Math.round(baseMs * factor ** i)));
  }
  return waits;
}

/** One line describing a wait, for whichever log the caller keeps. */
export function describeGuestWait({ attempt, attempts, delay, waitedMs }) {
  return `guest sign-in is rate limited — waiting ${Math.round(delay / 1000)}s, then retry ${attempt + 1}/${attempts} (${Math.round(waitedMs / 1000)}s so far)`;
}

/**
 * POST a guest sign-in, retrying while the target says 429.
 *
 * @returns {Promise<{status:number, ok:boolean, json:any, waitedMs:number, attempts:number}>}
 *   the last response, however many attempts it took to get it.
 */
export async function signInGuest(base, body = {}, { headers = {}, onWait, ...backoff } = {}) {
  const waits = guestBackoff(backoff);
  const total = waits.length + 1;
  let waitedMs = 0;

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${base}/api/auth/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => null);
    if (res.status !== 429 || attempt >= total) {
      return { status: res.status, ok: res.ok, json, waitedMs, attempts: attempt };
    }
    const hinted = Number(res.headers.get('retry-after'));
    const delay = Number.isFinite(hinted) && hinted > 0 ? hinted * 1000 + 500 : waits[attempt - 1];
    waitedMs += delay;
    onWait?.({ attempt, attempts: total, delay, waitedMs });
    await sleep(delay);
  }
}
