/**
 * The clock behind scheduled feature switches.
 *
 * A schedule is enforced on every request - featureOn()/featureFlags() take a
 * date, so REST routes and the welcome handshake are right without any timer.
 * The sweep exists only so an *already open* client follows along when a
 * window opens or closes: a tab sitting on the Chat view should get its
 * turned-off notice without a reload.
 *
 * It is deliberately dumb.  Every interval it recomputes which features a
 * schedule closes, and broadcasts only when that set changed.  At the default
 * 20s interval a 22:00 curfew lands within 20 seconds, which nobody can
 * notice, and there is no math left to get wrong across daylight saving, a
 * clock jump or a laptop waking from sleep.
 */
import { db } from './db.js';
import { FEATURE_IDS, featureClosed } from '../../shared/features.js';

export function createScheduleSweeper({ hub, intervalMs = 20000, now = () => new Date() } = {}) {
  // Only the closed-set is compared: a manual switch change is already pushed
  // by the admin route that made it, and re-pushing identical flags would just
  // be noise on the wire.
  const closedSet = (date) => FEATURE_IDS.map((id) => (featureClosed(db.data.config, id, date) ? 1 : 0)).join('');
  let last = closedSet(now());

  function sweep(date = now()) {
    const next = closedSet(date);
    if (next === last) return false;
    last = next;
    hub?.broadcastConfig();
    return true;
  }

  const timer = setInterval(() => sweep(), Math.max(250, Number(intervalMs) || 20000));
  timer.unref?.(); // a timer must never keep the process (or a test) alive
  return { sweep, stop: () => clearInterval(timer) };
}
