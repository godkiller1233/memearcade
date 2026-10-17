import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { now } from './ids.js';
import { log } from '../config.js';
import { PostgresBackend } from './db-postgres.js';

const SCHEMA = 1;

/** A brand new database.  Every collection is a plain JSON-safe structure. */
export function defaultData() {
  return {
    schema: SCHEMA,
    createdAt: now(),
    users: {}, // id -> user record
    names: {}, // lowercase username -> id  (uniqueness index)
    sessions: {}, // token -> { userId, kind, created, expires, ip }
    friends: [], // { a, b, status, by, at }  status: pending|accepted|blocked
    parties: {}, // id -> party
    rooms: {}, // id -> room snapshot (live state is held in memory by games.js)
    dms: {}, // pairKey -> [message]
    messages: {}, // scope key -> [message]
    invites: {}, // code -> { party, by, expires }
    botLinks: {}, // discord user id -> arcade user id
    linkCodes: {}, // short code shown by the bot -> { full signed token, discordId, exp }
    // Last server list the Discord bot reported: { at, appId, username, guilds }.
    // Only the bot can read Discord, so this is the console's one source for it.
    botPresence: null,
    // The bot's memory of every server it has been in: guild id -> { id, name,
    // icon, owner, channels, firstSeen, lastSeen, leftAt }. A report updates the
    // rows it names and marks a missing one as left instead of forgetting it, so
    // a server the bot was removed from stays in the console's history.
    botGuilds: {},
    reports: [], // { id, at, from, fromName, kind, text, status, resolvedBy, resolvedAt }
    suggestions: [], // { id, at, from, fromName, title, text, category, status, votes, adminNote }
    audit: [], // { at, actor, action, target, meta }
    stats: {
      gamesPlayed: 0,
      logins: 0,
      registrations: 0,
      peakOnline: 0,
      byGame: {}, // gameId -> plays
    },
    config: {
      registrationsOpen: config.registrationsOpen,
      maintenance: false,
      motd: 'Welcome to Memes Arcade - pick a game, grab a party, go.',
      featured: ['gartic-phone', 'memes-smash', 'codenames', 'quiplash'],
      announcement: '',
      maxRooms: 200,
      maxPartySize: 16,
      // Admin-controlled visibility, edited in the console's Features tab.
      // feature id -> { on, hidden, minRole, schedule? }; empty means
      // "everything on, shown and kept for staff", which shared/features.js
      // fills in (and prunes unknown ids from).
      features: {},
      // game id -> { on, hidden, minRole }, same meaning for one catalog entry.
      games: {},
    },
  };
}

export function migrate(data) {
  const out = { ...defaultData(), ...data };
  // keep collections that might be missing after an upgrade
  const base = defaultData();
  for (const key of Object.keys(base)) {
    if (out[key] === undefined || out[key] === null) out[key] = base[key];
    if (typeof base[key] === 'object' && !Array.isArray(base[key]) && base[key] !== null) {
      out[key] = { ...base[key], ...out[key] };
    }
  }
  out.schema = SCHEMA;
  return out;
}

/**
 * The JSON-file backend: a temp file and a rename, so a crash can never
 * truncate the store, with the previous write kept as a backup. Used when there
 * is no DATABASE_URL, and as the fallback when Postgres cannot be reached.
 */
export class FileBackend {
  constructor({ file, backup }) {
    this.file = file;
    this.backup = backup;
    this.kind = 'file';
  }

  /** The parsed file, or null when there is nothing readable to load. */
  read() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {}
    if (!fs.existsSync(this.file)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      log('db: main file unreadable, trying backup:', err.message);
      if (!fs.existsSync(this.backup)) return null;
      try {
        return JSON.parse(fs.readFileSync(this.backup, 'utf8'));
      } catch {
        return null;
      }
    }
  }

  /** Atomic write: temp file + rename, so a crash can never truncate the db. */
  write(json) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json);
    try {
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backup);
    } catch {}
    fs.renameSync(tmp, this.file);
  }

  async close() {}
}

/**
 * The store every caller already knows: `db.data` is a live object and writes
 * are coalesced behind it.
 *
 * `open()` decides where the object comes from and goes to. With a
 * DATABASE_URL the whole document is one JSONB row in Postgres (see
 * db-postgres.js) and every write is an upsert; without one it is the JSON file
 * that local play and every check suite use. The in-memory tree and the
 * synchronous `data` getter stay the same either way, which is what keeps the
 * hundred store call sites untouched.
 */
export class Db {
  constructor({ file = path.join(config.dataDir, 'db.json'), backup = path.join(config.dataDir, 'db.backup.json'), backend = null } = {}) {
    this.file = file;
    this.backup = backup;
    this._backend = backend;
    this.kind = backend?.kind || 'file';
    this._data = defaultData();
    this._dirty = false;
    this._timer = null;
    this._queue = Promise.resolve();
    this.closed = false;
    this.failed = false;
  }

  /**
   * Load the store. Async because a database has to be opened and read, but
   * every caller after this point keeps using `db.data` synchronously.
   *
   * A configured Postgres that cannot be reached does not stop the arcade: it
   * logs loudly and falls back to the file, so a database outage is a
   * durability problem rather than a dead site. The banner and /api/health say
   * which store is live.
   */
  async open({ databaseUrl = config.databaseUrl, logFn = log, openDatabase = PostgresBackend.open } = {}) {
    this.closed = false;
    this.failed = false;
    let backend = this._backend;
    let kind = backend?.kind || null;

    if (!backend && databaseUrl) {
      try {
        backend = await openDatabase(databaseUrl, { log: logFn });
        kind = 'postgres';
      } catch (err) {
        logFn(`db: Postgres unavailable (${err.message}) - falling back to the JSON file; accounts will not survive a restart until this is fixed`);
        backend = new FileBackend({ file: this.file, backup: this.backup });
        kind = 'file-fallback';
      }
    }
    if (!backend) {
      backend = new FileBackend({ file: this.file, backup: this.backup });
      kind = 'file';
    }
    this._backend = backend;
    this.kind = kind;

    const stored = await backend.read();
    if (stored) {
      this._data = migrate(stored);
    } else {
      // A fresh database still imports an existing file once, so switching a
      // running arcade to Postgres keeps the accounts it already has.
      const fromFile = kind === 'postgres' ? new FileBackend({ file: this.file, backup: this.backup }).read() : null;
      this._data = migrate(fromFile || defaultData());
      this._dirty = true;
      await this.flush();
    }
    this.prune();
    return this._data;
  }

  /** Drop expired sessions and stale ephemeral records. */
  prune() {
    const t = now();
    for (const [tok, s] of Object.entries(this._data.sessions)) {
      if (!s || (s.expires && s.expires < t)) delete this._data.sessions[tok];
    }
    for (const [code, inv] of Object.entries(this._data.invites)) {
      if (!inv || (inv.expires && inv.expires < t)) delete this._data.invites[code];
    }
    this.touch();
  }

  get data() {
    return this._data;
  }

  /** Mark dirty; writes are coalesced so hot paths stay cheap. */
  touch() {
    this._dirty = true;
    if (this.closed || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 1200);
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * Write the current document. Writes are serialised: a change made while one
   * is in flight lands in the next one, never in the same row out of order.
   */
  flush() {
    if (this.closed || !this._dirty) return this._queue;
    this._dirty = false;
    const payload = JSON.stringify(this._data);
    this._queue = this._queue
      .then(() => this._backend.write(payload))
      .catch((err) => {
        this._dirty = true;
        this.failed = true;
        log('db: write failed:', err.message);
      });
    return this._queue;
  }

  /** Final write, then release the connection. Awaited by shutdown. */
  async close() {
    this.closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    await this._queue;
    try {
      await this._backend.write(JSON.stringify(this._data));
    } catch (err) {
      log('db: final write failed:', err.message);
    }
    await this._backend.close?.();
  }
}

export const db = new Db();
