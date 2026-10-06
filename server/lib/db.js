import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { now } from './ids.js';
import { log } from '../config.js';

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
    },
  };
}

function migrate(data) {
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

class Db {
  constructor() {
    this.file = path.join(config.dataDir, 'db.json');
    this.backup = path.join(config.dataDir, 'db.backup.json');
    this._data = defaultData();
    this._dirty = false;
    this._timer = null;
    this._writing = false;
  }

  load() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this._data = migrate(raw);
      } catch (err) {
        log('db: main file unreadable, trying backup:', err.message);
        if (fs.existsSync(this.backup)) {
          this._data = migrate(JSON.parse(fs.readFileSync(this.backup, 'utf8')));
        } else {
          this._data = defaultData();
        }
      }
    } else {
      this._data = defaultData();
      this.flush();
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
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 1200);
    if (this._timer.unref) this._timer.unref();
  }

  /** Atomic write: temp file + rename, so a crash can never truncate the db. */
  flush() {
    if (!this._dirty || this._writing) return;
    this._dirty = false;
    this._writing = true;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 0));
      try {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backup);
      } catch {}
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log('db: write failed:', err.message);
      this._dirty = true;
    } finally {
      this._writing = false;
    }
  }

  close() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._dirty = true;
    this.flush();
  }
}

export const db = new Db();
