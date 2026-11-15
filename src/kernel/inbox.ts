/**
 * The durable inbox: every input from outside (a source event) is appended here before anything acts on it. Appending is
 * idempotent on `(source, externalId)`, so a source may deliver the same event again after a crash; the engine later consumes
 * each received event exactly once, inside its own transaction.
 */
import { z } from 'zod'
import type { KernelDb } from './db.ts'
import type { Env } from './env.ts'

export const InboxInputSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  threadKey: z.string().min(1).optional(),
  actor: z.object({ source: z.string().min(1), id: z.string().min(1) }).strict().optional(),
  human: z.boolean(),
  occurredAt: z.number().int().optional(),
  /** The event as the source gave it: untrusted, stored as JSON and never interpreted by the kernel. */
  payload: z.unknown(),
}).strict()
export type InboxInput = z.input<typeof InboxInputSchema>

export type InboxStatus = 'received' | 'routed' | 'ignored'
export interface InboxEvent {
  id: string
  source: string
  externalId: string
  threadKey?: string
  actor?: { source: string; id: string }
  human: boolean
  occurredAt?: number
  receivedAt: number
  payload: unknown
  status: InboxStatus
  outcome?: unknown
}

interface Row {
  id: string; source: string; external_id: string; thread_key: string | null; actor_source: string | null; actor_id: string | null
  human: number; occurred_at: number | null; received_at: number; payload: string; status: InboxStatus; outcome: string | null
}

/** The `inbox_event` table: append, list what is waiting, and settle an event once. */
export class Inbox {
  private readonly db: KernelDb
  private readonly env: Env
  constructor(db: KernelDb, env: Env) { this.db = db; this.env = env }

  /**
   * Appends an event, or finds the one already appended with the same `(source, externalId)`; the first copy wins, so a
   * redelivery cannot change what was received.
   */
  append(input: InboxInput): { event: InboxEvent; duplicate: boolean } {
    const event = InboxInputSchema.parse(input)
    const payload = JSON.stringify(event.payload ?? null)
    const { changes } = this.db.run(`INSERT INTO inbox_event (id, source, external_id, thread_key, actor_source, actor_id, human,
      occurred_at, received_at, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received') ON CONFLICT (source, external_id) DO NOTHING`,
    this.env.ids.next('in_'), event.source, event.externalId, event.threadKey ?? null, event.actor?.source ?? null,
    event.actor?.id ?? null, event.human ? 1 : 0, event.occurredAt ?? null, this.env.clock.now(), payload)
    const row = this.db.get<Row>('SELECT * FROM inbox_event WHERE source = ? AND external_id = ?', event.source, event.externalId)!
    return { event: toEvent(row), duplicate: changes === 0 }
  }

  get(id: string): InboxEvent | undefined {
    const row = this.db.get<Row>('SELECT * FROM inbox_event WHERE id = ?', id)
    return row && toEvent(row)
  }

  /** Events not yet consumed, in the order they were received. */
  received(limit = 100): InboxEvent[] {
    return this.db.all<Row>("SELECT * FROM inbox_event WHERE status = 'received' ORDER BY received_at, id LIMIT ?", limit).map(toEvent)
  }

  /**
   * Marks a received event `routed` or `ignored` with its outcome. Runs only inside a kernel transaction, so it commits together
   * with whatever the event caused. Returns `false` when the event was already settled, so the caller can skip it.
   */
  settle(id: string, status: Exclude<InboxStatus, 'received'>, outcome: unknown): boolean {
    if (!this.db.inTransaction) throw new Error('An inbox event is settled only inside a kernel transaction')
    const { changes } = this.db.run("UPDATE inbox_event SET status = ?, outcome = ? WHERE id = ? AND status = 'received'",
      status, JSON.stringify(outcome ?? null), id)
    if (changes === 0 && !this.get(id)) throw new Error(`No inbox event ${id}`)
    return changes === 1
  }
}

function toEvent(row: Row): InboxEvent {
  return {
    id: row.id, source: row.source, externalId: row.external_id,
    ...row.thread_key !== null ? { threadKey: row.thread_key } : {},
    ...row.actor_source !== null && row.actor_id !== null ? { actor: { source: row.actor_source, id: row.actor_id } } : {},
    human: row.human === 1,
    ...row.occurred_at !== null ? { occurredAt: row.occurred_at } : {},
    receivedAt: row.received_at,
    payload: JSON.parse(row.payload) as unknown,
    status: row.status,
    ...row.outcome !== null ? { outcome: JSON.parse(row.outcome) as unknown } : {},
  }
}
