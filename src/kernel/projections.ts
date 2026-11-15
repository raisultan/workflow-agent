/**
 * Inline projections and the blob store. A projection keeps its own read tables up to date from job events, inside the same
 * transaction that appends the events, and can be rebuilt by replaying `job_event`. The blob store holds large content (artifact
 * text, logs) once per SHA-256 digest.
 */
import { createHash } from 'node:crypto'
import type { KernelDb } from './db.ts'

/** A read model over job events. Its tables are created by its owner's migrations; `apply` must only write to them. */
export interface Projection<E = unknown> {
  readonly name: string
  readonly tables: readonly string[]
  apply(event: E, jobId: string, db: KernelDb): void
}

/** The registered projections. Applying and rebuilding run in kernel transactions; a projection's error is the caller's to handle. */
export class Projections<E = unknown> {
  private readonly byName = new Map<string, Projection<E>>()
  private readonly db: KernelDb
  constructor(db: KernelDb) { this.db = db }

  register(projection: Projection<E>): () => void {
    if (this.byName.has(projection.name)) throw new Error(`Projection ${projection.name} is registered twice`)
    this.byName.set(projection.name, projection)
    return () => { if (this.byName.get(projection.name) === projection) this.byName.delete(projection.name) }
  }

  /** Runs every projection on one event; called by the engine inside its transaction. */
  apply(event: E, jobId: string): void {
    if (!this.db.inTransaction) throw new Error('Projections are applied only inside a kernel transaction')
    for (const projection of this.byName.values()) projection.apply(event, jobId, this.db)
  }

  /** Empties a projection's tables and replays every job event into them, in the order they were appended. */
  rebuild(name: string): void {
    const projection = this.byName.get(name)
    if (!projection) throw new Error(`No projection ${name}`)
    this.db.tx(() => {
      for (const table of projection.tables) this.db.run(`DELETE FROM "${table.replaceAll('"', '""')}"`)
      for (const row of this.db.all<{ job_id: string; data: string }>('SELECT job_id, data FROM job_event ORDER BY rowid')) {
        projection.apply(JSON.parse(row.data) as E, row.job_id, this.db)
      }
    })
  }
}

/** The hex SHA-256 digest of `content` (text as UTF-8), as the blob store keys it. */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content).digest('hex')
}

/** Content stored once per SHA-256 digest. */
export class Blobs {
  private readonly db: KernelDb
  constructor(db: KernelDb) { this.db = db }

  /** Stores `content` (text is stored as UTF-8) and returns its hex digest; storing the same content again changes nothing. */
  put(content: string | Uint8Array): string {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const digest = sha256Hex(bytes)
    this.db.run('INSERT INTO blob (sha256, content, size) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING', digest, bytes, bytes.length)
    return digest
  }
  get(digest: string): Uint8Array | undefined {
    return this.db.get<{ content: Uint8Array }>('SELECT content FROM blob WHERE sha256 = ?', digest)?.content
  }
  text(digest: string): string | undefined {
    const bytes = this.get(digest)
    return bytes && Buffer.from(bytes).toString('utf8')
  }
}
