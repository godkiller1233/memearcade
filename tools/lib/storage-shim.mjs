/**
 * Deterministic client storage for headless suites.
 *
 * The browser classes under web/ (store, realtime, netcode, host) keep their
 * persisted state in localStorage.  Node has none today, but the ambient
 * environment must not decide what a headless suite sees: installStorageShim()
 * puts an explicit in-memory store in its place - seeded with the same empty
 * state a fresh browser has - and counts every access, so a suite can both run
 * those modules and prove they never touch persisted state at all.
 *
 * Importing this module installs nothing; call installStorageShim() once,
 * before the first import of a web/ module that reads localStorage:
 *
 *   import { installStorageShim } from './lib/storage-shim.mjs';
 *   const storage = installStorageShim();   // must run before those imports
 *   ...
 *   check(storage.log.reads === 0 && storage.log.writes === 0,
 *     'the headless client modules never touch persisted state',
 *     `${storage.log.reads} reads, ${storage.log.writes} writes`);
 *
 * A suite whose point is import safety (tools/check.mjs) deliberately does not
 * install this: with no localStorage present, a module that reaches for it at
 * import time throws and the check fails loudly, which is the behaviour we
 * want there.  The browser suite (tools/browser-reload-check.mjs) has its own
 * concern - a live app whose writes are debounced ~200ms would race any seed,
 * so it seeds from a parked page whose client never boots instead.
 */

/** The key web/js/store.js persists under. */
export const STORAGE_KEY = 'memes-arcade:state';

/** A fresh browser's saved state: the key exists, holding an empty object. */
export const EMPTY_STATE = { [STORAGE_KEY]: '{}' };

/**
 * Install the shim on `target` (default globalThis).
 *
 * @param {object}  [options]
 * @param {Record<string,string>} [options.seed]   key -> stored value, as it
 *   would already be in a browser; defaults to EMPTY_STATE.
 * @param {object}  [options.target]               where to install it.
 * @returns {{ log: {reads:number,writes:number}, store: Map<string,string>,
 *             seed: Record<string,string>, shim: object,
 *             reset(): void, uninstall(): void }}
 * @throws {Error} when neither defineProperty nor assignment can install it.
 */
export function installStorageShim({ seed = EMPTY_STATE, target = globalThis } = {}) {
  const store = new Map(Object.entries(seed));
  const log = { reads: 0, writes: 0 };

  const shim = {
    getItem: (k) => { log.reads++; return store.has(String(k)) ? store.get(String(k)) : null; },
    setItem: (k, v) => { log.writes++; store.set(String(k), String(v)); },
    removeItem: (k) => { log.writes++; store.delete(String(k)); },
    clear: () => { log.writes++; store.clear(); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };

  // Restore whatever was there (usually nothing in Node) if a suite uninstalls.
  const previous = Object.getOwnPropertyDescriptor(target, 'localStorage');
  try {
    Object.defineProperty(target, 'localStorage', { configurable: true, value: shim });
  } catch (err) {
    try {
      target.localStorage = shim;
    } catch (inner) {
      throw new Error(`cannot install the deterministic storage shim: ${inner.message || err.message}`);
    }
  }

  return {
    /** Access counters: both zero after a hermetic run. */
    log,
    /** The backing Map, for inspecting or seeding values mid-run. */
    store,
    seed,
    shim,
    /** Zero the counters, e.g. between phases of one suite. */
    reset() { log.reads = 0; log.writes = 0; },
    /** Put the previous localStorage back (or remove ours entirely). */
    uninstall() {
      if (previous) Object.defineProperty(target, 'localStorage', previous);
      else delete target.localStorage;
    },
  };
}
