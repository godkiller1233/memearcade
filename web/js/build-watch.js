/**
 * Watch the server's build stamp, so a shipped change reaches open tabs.
 *
 * The socket already pushes config, feature switches and the catalog the moment
 * an owner changes them. It cannot push a new engine, a redrawn canvas or a fix
 * to a bug in this very file: that code was loaded once and will not run again
 * until the page reloads. So a page remembers the build it booted from (the
 * server sends it in the config - see server/lib/build.js), watches for a
 * different one, and hands the page over to whatever wants to do about it.
 *
 * Deliberately tiny and dependency-free: one no-store request on an interval,
 * plus a check whenever the tab comes back to the front or the network returns,
 * because that is exactly when a stale page is about to be noticed.
 */

/** A minute is often enough for a long-lived tab to be a version behind. */
export const BUILD_CHECK_MS = 60000;

export function watchBuilds({
  build = '',
  url = '/api/build',
  intervalMs = BUILD_CHECK_MS,
  onNew = null,
  fetchImpl = null,
  doc = typeof document === 'undefined' ? null : document,
  win = typeof window === 'undefined' ? null : window,
} = {}) {
  let seen = String(build || '');
  let stopped = false;
  let inFlight = false;
  const read = fetchImpl || ((target) => fetch(target, { cache: 'no-store' }));

  async function check() {
    if (stopped || inFlight) return null;
    inFlight = true;
    try {
      const res = await read(url);
      if (!res || !res.ok) return null;
      const data = await res.json().catch(() => null);
      const next = String((data && data.build) || '');
      if (!next || next === seen) return null;
      const from = seen;
      seen = next;
      // A page that booted without a stamp adopts the first answer instead of
      // announcing a build it never ran.
      if (!from) return null;
      onNew?.({ build: next, from });
      return next;
    } catch {
      return null; // a dropped request is not a new build
    } finally {
      inFlight = false;
    }
  }

  const onVisible = () => {
    if (doc?.visibilityState === 'visible') check();
  };
  const timer = setInterval(check, Math.max(5000, Number(intervalMs) || BUILD_CHECK_MS));
  win?.addEventListener('focus', check);
  win?.addEventListener('online', check);
  doc?.addEventListener('visibilitychange', onVisible);

  return {
    check,
    stamp: () => seen,
    stop() {
      stopped = true;
      clearInterval(timer);
      win?.removeEventListener('focus', check);
      win?.removeEventListener('online', check);
      doc?.removeEventListener('visibilitychange', onVisible);
    },
  };
}
