/**
 * Free-port probing for scratch servers.
 *
 * Several suites boot a scratch arcade on a random port.  Random alone is not
 * enough: a server left over from an earlier run (or a crashed one) can already
 * hold the port, and a suite that boots onto it would silently test that stale
 * process - old code, foreign data - instead of its own.
 *
 * Binding the port is the only honest test: a stale server, another suite, and
 * an unrelated process all show up the same way (EADDRINUSE), and the OS frees
 * the probe the moment it closes.  pickFreePort() binds each candidate and only
 * returns one it actually got.
 *
 * Importing this module has no side effects.
 */
import net from 'node:net';

/**
 * True when `port` can be bound on `host` right now.
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen({ port, host });
  });
}

/**
 * The first free port among `span` values starting at `start`, scanning from a
 * random offset so concurrent suites rarely race for the same candidate.
 * @param {{start:number, span:number, host?:string}} range
 * @returns {Promise<number>}
 * @throws {Error} when every candidate is taken.
 */
export async function pickFreePort({ start, span, host = '127.0.0.1' }) {
  const offset = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = start + ((offset + i) % span);
    if (await portFree(port, host)) return port;
  }
  throw new Error(`no free port among ${start}..${start + span - 1} on ${host} - stop whatever holds them and re-run`);
}
