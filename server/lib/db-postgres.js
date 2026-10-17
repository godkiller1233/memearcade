/**
 * Postgres storage for the arcade's one document.
 *
 * The rest of the server was written against a synchronous JSON tree
 * (`db.data`), and every store call reads or mutates that tree. Rather than
 * turn hundreds of call sites async - and every engine's save path with them -
 * the whole tree is kept in one JSONB row and written behind the scenes. That
 * gives the accounts, ideas, rooms and bot memory a durable home on a host
 * whose filesystem is wiped, without changing what the store *is*.
 *
 * It is deliberately not a relational schema yet. The single row is a staging
 * step: `revision` and `updated_at` are there so a later migration to real
 * tables can tell which document version it started from.
 *
 * `pg` is imported only when a connection string exists, so a local checkout
 * with no npm install still runs against the JSON file.
 */
export const TABLE = 'memes_arcade_store';
export const ROW_ID = 'db';

/** Render hands out `sslmode=require` URLs; pg needs the flag spelled out. */
function sslFor(connectionString) {
  try {
    const mode = new URL(connectionString).searchParams.get('sslmode');
    if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') return undefined;
    // Render's certificate is managed by the platform; verifying it here would
    // need a CA bundle the project does not ship.
    return { rejectUnauthorized: false };
  } catch {
    return undefined;
  }
}

export class PostgresBackend {
  /**
   * @param {object} opts
   * @param {object} [opts.pool]  a pg Pool (or anything with .query/.end)
   * @param {(text: string, params: unknown[]) => Promise<object>} [opts.query]
   *   a bare query function - what the checks drive instead of a live database
   * @param {string} [opts.table]
   */
  constructor({ pool = null, query = null, table = TABLE } = {}) {
    this.pool = pool;
    this.queryFn = query;
    this.table = table;
    this.kind = 'postgres';
  }

  query(text, params = []) {
    if (this.queryFn) return this.queryFn(text, params);
    return this.pool.query(text, params);
  }

  /** Connect and create the one table this store needs, if it is not there. */
  static async open(connectionString, { log = () => {}, poolFactory = null } = {}) {
    let pool = poolFactory ? poolFactory(connectionString) : null;
    if (!pool) {
      const { default: pg } = await import('pg').catch(() => {
        throw new Error('the "pg" package is not installed - run npm install');
      });
      pool = new pg.Pool({ connectionString, ssl: sslFor(connectionString) });
      pool.on?.('error', (err) => log(`db: idle Postgres connection failed: ${err.message}`));
    }
    const backend = new PostgresBackend({ pool });
    await backend.migrate();
    return backend;
  }

  async migrate() {
    await this.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id text PRIMARY KEY,
         data jsonb NOT NULL,
         revision integer NOT NULL DEFAULT 1,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  }

  /** The stored document, or null on a fresh database. `pg` parses jsonb for us. */
  async read() {
    const result = await this.query(`SELECT data FROM ${this.table} WHERE id = $1`, [ROW_ID]);
    return result?.rows?.[0]?.data ?? null;
  }

  /** One upsert per write; `revision` counts how many times the document moved. */
  async write(json) {
    await this.query(
      `INSERT INTO ${this.table} (id, data, revision, updated_at)
       VALUES ($1, $2::jsonb, 1, now())
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             revision = ${this.table}.revision + 1,
             updated_at = now()`,
      [ROW_ID, json],
    );
  }

  async close() {
    if (this.pool?.end) await this.pool.end();
  }
}
