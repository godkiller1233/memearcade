#!/usr/bin/env node
/**
 * Store check.
 *
 * The arcade keeps its whole database in one JSON tree. This proves the two
 * backends behind that tree behave the same where it matters:
 *
 *   - the JSON file still seeds, writes atomically, reloads, and falls back to
 *     the backup when the main file is unreadable
 *   - the Postgres backend creates its one table, reads a missing row as a
 *     fresh database, and writes the document as a single upsert
 *   - a Db on Postgres seeds a fresh row, reloads what it wrote, serialises two
 *     writes made in a row, and flushes on close
 *   - a configured Postgres that cannot be reached falls back to the file
 *     instead of refusing to start, and says which store is live
 *
 * It drives the Postgres backend with a fake `query` - no server, no network -
 * so it tests our SQL and our load/save logic, not Postgres itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db, FileBackend, defaultData, migrate } from '../server/lib/db.js';
import { PostgresBackend, ROW_ID, TABLE } from '../server/lib/db-postgres.js';

let failures = 0;
let passed = 0;
const check = (ok, label, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(` FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memes-db-'));
}

/**
 * A Postgres stand-in: enough of `query` to run the store's three statements.
 * `rows` stores parsed jsonb, exactly how pg hands it back.
 */
function fakePostgres({ delayMs = 0 } = {}) {
  const rows = new Map();
  const calls = [];
  const query = async (text, params = []) => {
    calls.push({ text, params });
    if (delayMs) await sleep(delayMs);
    const sql = text.trim();
    if (sql.startsWith('CREATE TABLE')) return { rows: [] };
    if (sql.startsWith('SELECT data')) return { rows: rows.has(params[0]) ? [{ data: rows.get(params[0]) }] : [] };
    if (sql.startsWith('INSERT INTO')) {
      rows.set(params[0], JSON.parse(params[1]));
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  return { query, rows, calls };
}

async function main() {
  /* 1. the JSON file: seed, write, reload */
  {
    const dir = tempDir();
    const file = path.join(dir, 'db.json');
    const backup = path.join(dir, 'db.backup.json');
    const first = new Db({ file, backup });
    await first.open({ databaseUrl: '' });
    check(first.kind === 'file', 'with no database URL the store is the JSON file', first.kind);
    check(fs.existsSync(file), 'a fresh store writes its file');
    check(Object.keys(first.data.users).length === 0, 'a fresh store has no accounts');

    first.data.config.motd = 'test motd';
    first.touch();
    await first.flush();
    await first.close();

    const second = new Db({ file, backup });
    await second.open({ databaseUrl: '' });
    check(second.data.config.motd === 'test motd', 'a reopened store reads what it wrote', second.data.config.motd);
    check(second.data.schema === defaultData().schema, 'a reopened store keeps the schema stamp');

    // A corrupt main file must not lose the last good write.
    fs.writeFileSync(file, '{ this is not json');
    const third = new Db({ file, backup });
    await third.open({ databaseUrl: '' });
    check(third.data.config.motd === 'test motd', 'a corrupt file falls back to the backup', third.data.config.motd);
    await third.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 2. the file's atomic write: no partial file, previous one kept */
  {
    const dir = tempDir();
    const file = path.join(dir, 'db.json');
    const backup = path.join(dir, 'db.backup.json');
    const backend = new FileBackend({ file, backup });
    backend.write(JSON.stringify(migrate({ config: { motd: 'one' } })));
    check(JSON.parse(fs.readFileSync(file, 'utf8')).config.motd === 'one', 'the file backend writes the document');
    backend.write(JSON.stringify(migrate({ config: { motd: 'two' } })));
    check(JSON.parse(fs.readFileSync(backup, 'utf8')).config.motd === 'one',
      'the previous write is kept as the backup');
    check(!fs.readdirSync(dir).some((name) => name.endsWith('.tmp')),
      'no temp file is left behind');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 3. the Postgres SQL: create, read, upsert */
  {
    const pg = fakePostgres();
    const backend = new PostgresBackend({ query: pg.query });
    await backend.migrate();
    check(pg.calls[0].text.includes(`CREATE TABLE IF NOT EXISTS ${TABLE}`),
      'the backend creates its one table if it is missing', pg.calls[0].text.slice(0, 60));
    check((await backend.read()) === null, 'a missing row reads as a fresh database');

    await backend.write(JSON.stringify(migrate({ config: { motd: 'pg one' } })));
    const insert = pg.calls.find((call) => call.text.trim().startsWith('INSERT INTO'));
    check(!!insert && insert.params[0] === ROW_ID && JSON.parse(insert.params[1]).config.motd === 'pg one',
      'the document is written as one row', JSON.stringify(insert?.params?.[0]));
    check(insert.text.includes('ON CONFLICT (id) DO UPDATE') && insert.text.includes('revision + 1'),
      'a write is an upsert that bumps the revision, not a duplicate insert');
    check((await backend.read())?.config?.motd === 'pg one', 'the written document reads back');

    await backend.write(JSON.stringify(migrate({ config: { motd: 'pg two' } })));
    check(pg.rows.size === 1 && (await backend.read())?.config?.motd === 'pg two',
      'a second write replaces the same row', `${pg.rows.size} row(s)`);
  }

  /* 4. a Db on Postgres: seed, reload, serialise, close */
  {
    const dir = tempDir();
    const pg = fakePostgres({ delayMs: 15 });
    const backend = new PostgresBackend({ query: pg.query });
    const first = new Db({ file: path.join(dir, 'db.json'), backup: path.join(dir, 'db.backup.json'), backend });
    await first.open();
    check(first.kind === 'postgres', 'a database backend is reported as Postgres', first.kind);
    check(pg.rows.has(ROW_ID), 'a fresh database is seeded with the default document');
    check(!fs.existsSync(path.join(dir, 'db.json')), 'nothing falls through to the JSON file');
    const seededWrites = pg.calls.filter((call) => call.text.trim().startsWith('INSERT INTO')).length;

    first.data.config.motd = 'first';
    first.touch();
    await first.flush();
    first.data.config.motd = 'second';
    first.touch();
    const queued = first.flush();
    const during = first.data.config.motd;
    await queued;
    check(during === 'second' && pg.rows.get(ROW_ID).config.motd === 'second',
      'a write made while another is in flight wins', `stored ${pg.rows.get(ROW_ID).config.motd}`);
    const queuedWrites = pg.calls.filter((call) => call.text.trim().startsWith('INSERT INTO')).length - seededWrites;
    check(queuedWrites === 2, 'writes are not dropped when they are queued', `${queuedWrites} write(s)`);

    first.data.config.motd = 'before close';
    first.touch();
    await first.close();
    check(pg.rows.get(ROW_ID).config.motd === 'before close', 'close writes the last change');

    const second = new Db({ file: path.join(dir, 'db.json'), backup: path.join(dir, 'db.backup.json'), backend: new PostgresBackend({ query: pg.query }) });
    await second.open();
    check(second.data.config.motd === 'before close', 'a new process reads the stored document', second.data.config.motd);
    check(JSON.stringify(second.data.users) === '{}', 'collections come back as they were stored');
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 5. an unreachable database falls back to the file instead of dying */
  {
    const dir = tempDir();
    const db = new Db({ file: path.join(dir, 'db.json'), backup: path.join(dir, 'db.backup.json') });
    await db.open({
      databaseUrl: 'postgres://user:pass@127.0.0.1:1/arcade',
      openDatabase: async () => {
        throw new Error('connection refused');
      },
    });
    check(db.kind === 'file-fallback', 'an unreachable database falls back to the file', db.kind);
    check(fs.existsSync(path.join(dir, 'db.json')), 'the fallback still writes a usable store');
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures ? `✗ ${failures} failure(s)` : `✓ all ${passed} store checks passed`}\n`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error('store check crashed:', err?.stack || err);
  process.exitCode = 1;
});
