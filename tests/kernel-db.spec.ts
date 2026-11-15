/** The kernel database (`T7.2`): pragmas, per-owner migrations, refusing a newer schema, and synchronous, non-nested transactions. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { KERNEL_SCHEMA, KernelDb, NewerSchemaError, type SchemaOwner } from '../src/kernel/db.ts'

let dir: string
const opened: KernelDb[] = []
const open = (owners: SchemaOwner[] = [], path = join(dir, 'workbench.sqlite')) => { const db = KernelDb.open(path, owners); opened.push(db); return db }
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kernel-db-')) })
afterEach(() => { for (const db of opened.splice(0)) { try { db.close() } catch { /* already closed */ } } rmSync(dir, { recursive: true, force: true }) })

const tables = (db: KernelDb) => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(row => row.name)
const domain = (versions: number): SchemaOwner => ({ owner: 'domain', migrations: [
  { version: 1, up: 'CREATE TABLE binding (thread TEXT PRIMARY KEY, job_id TEXT NOT NULL)' },
  { version: 2, up: 'ALTER TABLE binding ADD COLUMN role TEXT' },
].slice(0, versions) })

it('opens with WAL, full sync and foreign keys, creates the kernel schema, and keeps the file private', () => {
  const db = open()
  expect(db.pragma('journal_mode')).toBe('wal')
  expect(db.pragma('synchronous')).toBe(2)
  expect(db.pragma('foreign_keys')).toBe(1)
  expect(tables(db)).toEqual(['blob', 'consumed_origin', 'definition_version', 'effect', 'inbox_event', 'job', 'job_event', 'kv',
    'run_manifest', 'schema_version', 'timer'])
  expect(db.get('SELECT version FROM schema_version WHERE owner = ?', 'kernel')).toEqual({ version: KERNEL_SCHEMA.migrations.length })
  expect(statSync(join(dir, 'workbench.sqlite')).mode & 0o777).toBe(0o600)
})

it('migrates each owner forward from where it stands, the kernel first', () => {
  const first = open([domain(1)])
  expect(first.get('SELECT version FROM schema_version WHERE owner = ?', 'domain')).toEqual({ version: 1 })
  first.run('INSERT INTO binding (thread, job_id) VALUES (?, ?)', 'mm:1', 'job_1')
  first.close()
  const second = open([domain(2)])
  expect(second.get('SELECT version FROM schema_version WHERE owner = ?', 'domain')).toEqual({ version: 2 })
  expect(second.get('SELECT thread, job_id, role FROM binding')).toEqual({ thread: 'mm:1', job_id: 'job_1', role: null })
})

it('refuses a database whose schema is newer than this build, and changes nothing', () => {
  open([domain(2)]).close()
  const path = join(dir, 'workbench.sqlite')
  const before = readFileSync(path)
  expect(() => KernelDb.open(path, [domain(1)])).toThrow(NewerSchemaError)
  expect(readFileSync(path).equals(before)).toBe(true)
  // The refused handle was closed, so the same process can open the database again.
  expect(open([domain(2)]).get('SELECT version FROM schema_version WHERE owner = ?', 'domain')).toEqual({ version: 2 })
})

it('refuses owners registered twice or migrations out of order', () => {
  expect(() => KernelDb.open(':memory:', [domain(1), domain(1)])).toThrow(/registered twice/)
  expect(() => KernelDb.open(':memory:', [{ owner: 'x', migrations: [{ version: 2, up: '' }] }])).toThrow(/numbered/)
})

it('rolls a transaction back when it throws, refuses nesting, and refuses an async body', () => {
  const db = open()
  const count = () => db.get<{ n: number }>('SELECT count(*) AS n FROM kv')!.n
  expect(() => db.tx(() => { db.run('INSERT INTO kv VALUES (?, ?)', 'a', '1'); throw new Error('boom') })).toThrow('boom')
  expect(count()).toBe(0)
  expect(() => db.tx(() => db.tx(() => 1))).toThrow(/nested/)
  expect(db.inTransaction).toBe(false)
  expect(() => db.tx(() => { db.run('INSERT INTO kv VALUES (?, ?)', 'b', '1'); return Promise.resolve() })).toThrow(/synchronous/)
  expect(count()).toBe(0)
  expect(db.tx(() => { db.run('INSERT INTO kv VALUES (?, ?)', 'c', '1'); return 'done' })).toBe('done')
  expect(count()).toBe(1)
})

it('migrates a version 1 kernel to version 2, where an effect may belong to no job, keeping every effect row (T11.1)', async () => {
  const path = join(dir, 'workbench.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(path)
  raw.exec('CREATE TABLE schema_version (owner TEXT PRIMARY KEY, version INTEGER NOT NULL)')
  raw.exec(KERNEL_SCHEMA.migrations[0]!.up)
  raw.exec("INSERT INTO schema_version (owner, version) VALUES ('kernel', 1)")
  raw.exec("INSERT INTO run_manifest VALUES ('m1', 'w', 1, 'h', '{}', 1)")
  raw.exec("INSERT INTO job VALUES ('job_1', 'm1', 'running', '{}', 1, 1, 1)")
  raw.exec("INSERT INTO effect VALUES ('ef_1', 'job_1', 'post', 'k1', 'post:t', '{}', 'pending', 0, 5, NULL, 1)")
  expect(() => raw.exec("INSERT INTO effect VALUES ('ef_2', NULL, 'notice', 'k2', NULL, '{}', 'pending', 0, 5, NULL, 2)")).toThrow(/NOT NULL/)
  raw.close()
  const db = open()
  expect(db.get('SELECT version FROM schema_version WHERE owner = ?', 'kernel')).toEqual({ version: 2 })
  expect(db.get('SELECT id, job_id, kind, idempotency_key, ordering_key, status, due_at, seq FROM effect')).toEqual({ id: 'ef_1', job_id: 'job_1', kind: 'post',
    idempotency_key: 'k1', ordering_key: 'post:t', status: 'pending', due_at: 5, seq: 1 })
  db.run("INSERT INTO effect VALUES ('ef_2', NULL, 'notice', 'k2', NULL, '{}', 'pending', 0, 5, NULL, 2)")
  // The job reference and the due index are still there.
  expect(() => db.run("INSERT INTO effect VALUES ('ef_3', 'job_missing', 'post', 'k3', NULL, '{}', 'pending', 0, 5, NULL, 3)")).toThrow(/FOREIGN KEY/)
  expect(db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'effect_due'")).toEqual({ name: 'effect_due' })
})
