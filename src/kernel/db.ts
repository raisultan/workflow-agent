/**
 * The kernel's SQLite database: one connection, synchronous transactions, and forward-only migrations registered per owner (the
 * kernel's own first, then each owner's, such as the domain's), so an owner adds its tables without the kernel importing it.
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

/** One forward step of an owner's schema: `version` counts up from 1, and `up` is the SQL that takes the schema there. */
export interface Migration { readonly version: number; readonly up: string }
/** The tables one owner keeps, as its migrations in order. */
export interface SchemaOwner { readonly owner: string; readonly migrations: readonly Migration[] }

/** Thrown when an owner's schema in the database is newer than this build knows; the database is left unchanged. */
export class NewerSchemaError extends Error {
  readonly owner: string
  readonly stored: number
  readonly known: number
  constructor(owner: string, stored: number, known: number) {
    super(`The database's ${owner} schema is at version ${stored}, newer than this build's ${known}; it was written by a newer build`)
    this.name = 'NewerSchemaError'
    this.owner = owner
    this.stored = stored
    this.known = known
  }
}

/** The kernel's schema. Untrusted text (inbox payloads) is stored as JSON and never interpreted here. */
export const KERNEL_SCHEMA: SchemaOwner = {
  owner: 'kernel',
  migrations: [{
    version: 1,
    up: `
CREATE TABLE inbox_event (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL,
  thread_key TEXT, actor_source TEXT, actor_id TEXT, human INTEGER NOT NULL,
  occurred_at INTEGER, received_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','routed','ignored')),
  outcome TEXT,
  UNIQUE (source, external_id));
CREATE INDEX inbox_received ON inbox_event(received_at, id) WHERE status = 'received';

CREATE TABLE definition_version (
  id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
  registered_at INTEGER NOT NULL, PRIMARY KEY (id, version));

CREATE TABLE run_manifest (id TEXT PRIMARY KEY, definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL, definition_hash TEXT NOT NULL,
  data TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE job (
  id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL REFERENCES run_manifest(id),
  status TEXT NOT NULL, state TEXT NOT NULL,
  version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE job_event (
  job_id TEXT NOT NULL REFERENCES job(id), seq INTEGER NOT NULL,
  type TEXT NOT NULL, type_version INTEGER NOT NULL,
  causation TEXT NOT NULL,
  at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (job_id, seq));

CREATE TABLE consumed_origin (
  kind TEXT NOT NULL, id TEXT NOT NULL,
  job_id TEXT, outcome TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (kind, id));

CREATE TABLE effect (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES job(id),
  kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  ordering_key TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','unknown','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL,
  result TEXT, seq INTEGER NOT NULL);
CREATE INDEX effect_due ON effect(status, due_at, seq);

CREATE TABLE timer (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES job(id),
  kind TEXT NOT NULL, subject TEXT NOT NULL, due_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('armed','fired','cancelled')));
CREATE INDEX timer_due ON timer(due_at) WHERE status = 'armed';

CREATE TABLE blob (sha256 TEXT PRIMARY KEY, content BLOB NOT NULL, size INTEGER NOT NULL);

CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  }, {
    // An effect may belong to no job: a notice the workbench posts about an inbox event that starts none (`T11.1`).
    version: 2,
    up: `
CREATE TABLE effect_v2 (
  id TEXT PRIMARY KEY, job_id TEXT REFERENCES job(id),
  kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  ordering_key TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','unknown','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL,
  result TEXT, seq INTEGER NOT NULL);
INSERT INTO effect_v2 SELECT id, job_id, kind, idempotency_key, ordering_key, payload, status, attempts, due_at, result, seq FROM effect;
DROP TABLE effect;
ALTER TABLE effect_v2 RENAME TO effect;
CREATE INDEX effect_due ON effect(status, due_at, seq);
`,
  }],
}

/**
 * The kernel's connection to `<stateDir>/workbench.sqlite` (`WAL`, `synchronous=FULL`, `foreign_keys=ON`).
 * Writes that must hang together run in `tx`, which is synchronous: nothing else can run on the connection until it commits.
 */
export class KernelDb {
  private readonly statements = new Map<string, StatementSync>()
  private readonly db: DatabaseSync

  private constructor(db: DatabaseSync) { this.db = db }

  /**
   * Opens or creates the database at `path` (or `:memory:`) and brings the kernel's schema, then each owner's, up to date.
   * @throws NewerSchemaError when an owner's stored schema is newer than this build's; nothing is changed and the handle is closed.
   */
  static open(path: string, owners: readonly SchemaOwner[] = []): KernelDb {
    const all = [KERNEL_SCHEMA, ...owners]
    checkOwners(all)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
      db.exec('CREATE TABLE IF NOT EXISTS schema_version (owner TEXT PRIMARY KEY, version INTEGER NOT NULL)')
      const kernel = new KernelDb(db)
      const stored = new Map(kernel.all<{ owner: string; version: number }>('SELECT owner, version FROM schema_version')
        .map(row => [row.owner, row.version]))
      for (const { owner, migrations } of all) {
        const known = migrations.at(-1)?.version ?? 0
        const at = stored.get(owner) ?? 0
        if (at > known) throw new NewerSchemaError(owner, at, known)
      }
      for (const { owner, migrations } of all) {
        for (const migration of migrations.filter(step => step.version > (stored.get(owner) ?? 0))) {
          kernel.tx(() => {
            db.exec(migration.up)
            kernel.run('INSERT INTO schema_version (owner, version) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET version = excluded.version',
              owner, migration.version)
          })
        }
      }
      if (path !== ':memory:') chmodSync(path, 0o600)
      return kernel
    } catch (error) {
      db.close()
      throw error
    }
  }

  /** Whether a transaction is open on the connection. */
  get inTransaction(): boolean { return this.db.isTransaction }

  /**
   * Runs `fn` in one `BEGIN IMMEDIATE … COMMIT` transaction and returns its result; a throw rolls everything back.
   * `fn` must be synchronous: a returned promise is refused (rolled back), because work after an `await` would run outside the
   * transaction. A transaction inside another is refused rather than flattened.
   */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) throw new Error('A kernel transaction cannot be nested')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      if (typeof (result as { then?: unknown } | null)?.then === 'function') {
        throw new Error('A kernel transaction must be synchronous; it returned a promise')
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const { changes } = this.statement(sql).run(...params)
    return { changes: Number(changes) }
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.statement(sql).all(...params) as T[]
  }
  /** The value of a pragma, for checks and diagnostics. */
  pragma(name: string): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
    return row ? Object.values(row)[0] : undefined
  }
  close(): void {
    this.statements.clear()
    this.db.close()
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement) }
    return statement
  }
}

function checkOwners(owners: readonly SchemaOwner[]): void {
  const names = new Set<string>()
  for (const { owner, migrations } of owners) {
    if (names.has(owner)) throw new Error(`Schema owner ${owner} is registered twice`)
    names.add(owner)
    migrations.forEach((migration, index) => {
      if (migration.version !== index + 1) throw new Error(`Schema owner ${owner}'s migrations must be numbered 1, 2, 3… in order`)
    })
  }
}
