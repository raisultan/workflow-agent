/**
 * The effects dispatcher. It claims due `pending` effects in a transaction, runs their handlers, and
 * brings each result back to its job as a command in the same transaction that settles the effect row. Concurrency is limited per
 * kind; effects sharing an `ordering_key` run one after another, in order. A write whose outcome is unknown is reconciled before
 * it is run again, so an external system records it at most once.
 */
import type { KernelDb } from './db.ts'
import type { KernelCommand, Origin, Submitted } from './engine.ts'
import type { Env } from './env.ts'

export type EffectResult =
  | { ok: unknown }
  | { retry: { afterMs?: number; reason: string } }
  | { fail: string }
  | { unknown: string }

/** Performs one kind of effect. A handler that throws is treated as `unknown`: the write may or may not have happened. */
export interface EffectHandler<P = unknown> {
  run(payload: P, key: string, attempt: number): Promise<EffectResult>
  /** A repeated run with the same key writes once. A kind that is not idempotent must provide `reconcile`. */
  readonly idempotent: boolean
  /** Finds whether the write keyed `key` happened: `found` with its result, or `absent`. */
  reconcile?(payload: P, key: string): Promise<{ found: unknown } | { absent: true }>
  /** A long kind stays `running` for the whole work (a stage attempt); `cancel` stops that work, and `run` then settles. */
  readonly long?: boolean
  cancel?(payload: P, key: string): Promise<void>
  /** How many effects of the kind may run at once; for a long kind, its slots. */
  limit(): number
}

/** What the dispatcher needs from the engine: submitting a kernel command with work that commits alongside it. */
export interface CommandSink {
  submit(jobId: string, command: KernelCommand, origin: Origin, within?: () => void): Submitted
}

interface Row {
  id: string; job_id: string | null; kind: string; idempotency_key: string; ordering_key: string | null; payload: string
  status: string; attempts: number; due_at: number; result: string | null; seq: number
}

export interface EffectsOptions {
  readonly db: KernelDb
  readonly env: Env
  readonly jobs: CommandSink
  /** The first retry waits about this long; each later one doubles it, with jitter, up to `maxBackoffMs`. */
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
}

/** What a caller waiting on an effect learns: its result, its failure, or that it has not settled yet. */
export type EffectOutcome = { ok: unknown } | { fail: string } | { pending: true }

export interface KindHealth { running: number; waiting: number; retrying: number; unknown: number; lastError?: string }

/** Registers handlers and dispatches effects; `dispatch` runs what is due now, and `idle` waits for everything in flight. */
export class Effects {
  private readonly handlers = new Map<string, EffectHandler>()
  /** Running work, and whether it is a long kind's (which a shutdown does not wait for). */
  private readonly inFlight = new Map<Promise<void>, boolean>()
  private readonly lastError = new Map<string, string>()
  /** Set by a shutdown: a long effect that ends afterwards leaves its row `running`, and recovery settles it after the restart. */
  private stopped = false
  /** Callers waiting for an effect's outcome, by effect id. */
  private readonly waiters = new Map<string, ((outcome: EffectOutcome) => void)[]>()

  private readonly options: EffectsOptions
  constructor(options: EffectsOptions) { this.options = options }

  register<P>(kind: string, handler: EffectHandler<P>): () => void {
    if (this.handlers.has(kind)) throw new Error(`Effect kind ${kind} has a handler already`)
    if (!handler.idempotent && !handler.reconcile) throw new Error(`Effect kind ${kind} is not idempotent, so it needs reconcile`)
    if (handler.long && !handler.cancel) throw new Error(`Effect kind ${kind} is long-running, so it needs cancel`)
    this.handlers.set(kind, handler as EffectHandler)
    return () => { if (this.handlers.get(kind) === handler) this.handlers.delete(kind) }
  }

  /**
   * Claims every effect that may run now and runs it. Resolves when the short ones, and the reconciliations, have settled; a long
   * effect (a stage attempt) keeps running and is tracked for `idle`.
   */
  async dispatch(): Promise<void> {
    const { claimed, unknown } = this.options.db.tx(() => ({ claimed: this.claim(), unknown: this.dueUnknown() }))
    const short: Promise<void>[] = []
    for (const row of claimed) {
      const long = this.handlers.get(row.kind)?.long ?? false
      const work = this.track(this.execute(row, long), long, row.kind)
      if (!long) short.push(work)
    }
    for (const row of unknown) short.push(this.track(this.resolveUnknown(row), false, row.kind))
    await Promise.all(short)
  }

  /**
   * Waits until no handler is running. With `long: false` it waits only for short work: a long effect (a stage attempt) does not end
   * for a shutdown, and after a restart it returns to its job as interrupted.
   */
  async idle({ long = true }: { long?: boolean } = {}): Promise<void> {
    const pending = () => [...this.inFlight].filter(([, isLong]) => long || !isLong).map(([work]) => work)
    for (let work = pending(); work.length > 0; work = pending()) await Promise.allSettled(work)
  }

  /**
   * Waits up to `timeoutMs` for effect `effectId` to settle: its result, its failure (a cancelled effect fails), or `pending` when it
   * has not settled by then. A safe-output tool uses it to return a write's result to the model.
   */
  awaitResult(effectId: string, timeoutMs: number): Promise<EffectOutcome> {
    const settled = this.outcomeOf(effectId)
    if (!('pending' in settled)) return Promise.resolve(settled)
    return new Promise(resolve => {
      const waiting = this.waiters.get(effectId) ?? []
      const timer = setTimeout(() => {
        this.waiters.set(effectId, (this.waiters.get(effectId) ?? []).filter(item => item !== done))
        resolve({ pending: true })
      }, timeoutMs)
      timer.unref?.()
      const done = (outcome: EffectOutcome) => { clearTimeout(timer); resolve(outcome) }
      waiting.push(done)
      this.waiters.set(effectId, waiting)
    })
  }

  private outcomeOf(effectId: string): EffectOutcome {
    const row = this.options.db.get<{ status: string; result: string | null }>('SELECT status, result FROM effect WHERE id = ?', effectId)
    if (!row) return { fail: `No effect ${effectId}` }
    const result = row.result ? JSON.parse(row.result) as { ok?: unknown; fail?: string } : {}
    if (row.status === 'succeeded') return { ok: result.ok ?? null }
    if (row.status === 'failed') return { fail: result.fail ?? 'failed' }
    if (row.status === 'cancelled') return { fail: 'cancelled' }
    return { pending: true }
  }

  private wakeWaiters(effectId: string): void {
    const waiting = this.waiters.get(effectId)
    if (!waiting) return
    this.waiters.delete(effectId)
    const outcome = this.outcomeOf(effectId)
    for (const resolve of waiting) resolve(outcome)
  }

  /**
   * Inside the caller's transaction: queues a notice, an effect that belongs to no job (a reply to an inbox event that starts none,
   * `T11.1`). It runs like any short effect, once per `key`; its result is recorded on its row and goes to no job. A long kind
   * cannot be a notice.
   */
  notify(kind: string, payload: unknown, key: string, orderingKey?: string): { id: string; duplicate: boolean } {
    const { db, env } = this.options
    const existing = db.get<{ id: string }>('SELECT id FROM effect WHERE idempotency_key = ?', key)
    if (existing) return { id: existing.id, duplicate: true }
    const id = env.ids.next('ef_')
    const seq = (db.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM effect')?.seq ?? 0) + 1
    db.run(`INSERT INTO effect (id, job_id, kind, idempotency_key, ordering_key, payload, status, attempts, due_at, result, seq)
      VALUES (?, NULL, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?)`, id, kind, key, orderingKey ?? null, JSON.stringify(payload ?? null), env.clock.now(), seq)
    return { id, duplicate: false }
  }

  /** Stops settling long effects that end from now on, for good: the database is about to close. */
  stop(): void { this.stopped = true }

  /** Asks the handlers of running long effects to stop; their `run` settles and the result returns to the job as usual. */
  async cancelRunning(effectIds: readonly string[]): Promise<void> {
    for (const id of effectIds) {
      const row = this.options.db.get<Row>("SELECT * FROM effect WHERE id = ? AND status = 'running'", id)
      const handler = row && this.handlers.get(row.kind)
      if (row && handler?.long && handler.cancel) await handler.cancel(JSON.parse(row.payload) as unknown, row.idempotency_key)
    }
  }

  /**
   * After a restart, nothing is running: a long effect's work did not survive, so it fails as `interrupted` and its job decides;
   * any other running effect becomes `unknown` and is reconciled before it runs again.
   */
  recover(): { interrupted: number; unknown: number } {
    const { db } = this.options
    const counts = { interrupted: 0, unknown: 0 }
    for (const row of db.all<Row>("SELECT * FROM effect WHERE status = 'running' ORDER BY seq")) {
      if (this.handlers.get(row.kind)?.long) { this.settleFailed(row, 'interrupted by a restart', true); counts.interrupted++ } else {
        db.run("UPDATE effect SET status = 'unknown', due_at = ? WHERE id = ? AND status = 'running'", this.options.env.clock.now(), row.id)
        counts.unknown++
      }
    }
    return counts
  }

  health(): Record<string, KindHealth> {
    const out: Record<string, KindHealth> = {}
    for (const row of this.options.db.all<{ kind: string; status: string; retried: number; n: number }>(`SELECT kind, status, attempts > 0 AS retried,
      count(*) AS n FROM effect WHERE status IN ('pending', 'running', 'unknown') GROUP BY kind, status, retried`)) {
      const kind = out[row.kind] ??= { running: 0, waiting: 0, retrying: 0, unknown: 0 }
      if (row.status === 'running') kind.running += row.n
      else if (row.status === 'unknown') kind.unknown += row.n
      else if (row.retried) kind.retrying += row.n
      else kind.waiting += row.n
    }
    for (const [kind, error] of this.lastError) (out[kind] ??= { running: 0, waiting: 0, retrying: 0, unknown: 0 }).lastError = error
    return out
  }

  /**
   * Tracks running work for `idle`. Nothing awaits a long effect's work, so an error settling it (a closing database) is recorded
   * rather than left unhandled; its row stays `running`, and recovery settles it after the restart.
   */
  private track(work: Promise<void>, long: boolean, kind: string): Promise<void> {
    const settled = long ? work.catch((error: unknown) => { this.lastError.set(kind, error instanceof Error ? error.message : String(error)) }) : work
    const tracked = settled.finally(() => { this.inFlight.delete(tracked) })
    this.inFlight.set(tracked, long)
    return tracked
  }

  /** Inside a transaction: pending, due effects whose kind has a handler and a free slot, and that are first on their ordering key. */
  private claim(): Row[] {
    const { db, env } = this.options
    const running = new Map(db.all<{ kind: string; n: number }>("SELECT kind, count(*) AS n FROM effect WHERE status = 'running' GROUP BY kind")
      .map(row => [row.kind, row.n]))
    const claimed: Row[] = []
    for (const row of db.all<Row>("SELECT * FROM effect WHERE status = 'pending' AND due_at <= ? ORDER BY seq", env.clock.now())) {
      const handler = this.handlers.get(row.kind)
      if (!handler || (running.get(row.kind) ?? 0) >= handler.limit()) continue
      if (row.ordering_key !== null && db.get(`SELECT 1 FROM effect WHERE ordering_key = ? AND seq < ?
        AND status IN ('pending', 'running', 'unknown') LIMIT 1`, row.ordering_key, row.seq)) continue
      db.run("UPDATE effect SET status = 'running', attempts = attempts + 1 WHERE id = ?", row.id)
      running.set(row.kind, (running.get(row.kind) ?? 0) + 1)
      claimed.push({ ...row, status: 'running', attempts: row.attempts + 1 })
    }
    return claimed
  }

  private dueUnknown(): Row[] {
    return this.options.db.all<Row>("SELECT * FROM effect WHERE status = 'unknown' AND due_at <= ? ORDER BY seq", this.options.env.clock.now())
      .filter(row => this.handlers.has(row.kind))
  }

  private async execute(row: Row, long: boolean): Promise<void> {
    const handler = this.handlers.get(row.kind)!
    let result: EffectResult
    try {
      result = await handler.run(JSON.parse(row.payload) as unknown, row.idempotency_key, row.attempts)
    } catch (error) {
      result = { unknown: error instanceof Error ? error.message : String(error) }
    }
    if (long && this.stopped) return
    if ('ok' in result) this.settleSucceeded(row, result.ok)
    else if ('fail' in result) this.settleFailed(row, result.fail, false)
    else if ('retry' in result) this.retry(row, result.retry.reason, result.retry.afterMs)
    else {
      this.lastError.set(row.kind, result.unknown)
      this.options.db.run("UPDATE effect SET status = 'unknown', result = ? WHERE id = ? AND status = 'running'", JSON.stringify({ unknown: result.unknown }), row.id)
      await this.resolveUnknown({ ...row, status: 'unknown' })
    }
  }

  /** Finds out whether an `unknown` write happened: found succeeds, absent runs again, and a failed check is tried again later. */
  private async resolveUnknown(row: Row): Promise<void> {
    const handler = this.handlers.get(row.kind)!
    if (!handler.reconcile) { this.retry(row, 'outcome unknown; the kind is idempotent, so it runs again'); return }
    let found: { found: unknown } | { absent: true }
    try {
      found = await handler.reconcile(JSON.parse(row.payload) as unknown, row.idempotency_key)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.lastError.set(row.kind, reason)
      this.options.db.run("UPDATE effect SET due_at = ? WHERE id = ? AND status = 'unknown'", this.options.env.clock.now() + this.backoff(row.attempts), row.id)
      return
    }
    if ('found' in found) this.settleSucceeded(row, found.found)
    else this.retry(row, 'not found by reconcile; runs again', 0)
  }

  private retry(row: Row, reason: string, afterMs?: number): void {
    this.lastError.set(row.kind, reason)
    this.options.db.run("UPDATE effect SET status = 'pending', due_at = ?, result = ? WHERE id = ? AND status IN ('running', 'unknown')",
      this.options.env.clock.now() + (afterMs ?? this.backoff(row.attempts)), JSON.stringify({ retry: reason }), row.id)
  }

  private backoff(attempt: number): number {
    const base = this.options.baseBackoffMs ?? 1000
    const max = this.options.maxBackoffMs ?? 300_000
    return Math.min(max, Math.round(base * 2 ** Math.max(0, attempt - 1) * (0.5 + this.options.env.random.next())))
  }

  private settleSucceeded(row: Row, value: unknown): void {
    const payload = JSON.parse(row.payload) as unknown
    if (row.job_id === null) {
      this.options.db.run("UPDATE effect SET status = 'succeeded', result = ? WHERE id = ?", JSON.stringify({ ok: value ?? null }), row.id)
      this.wakeWaiters(row.id)
      return
    }
    this.options.jobs.submit(row.job_id, { kind: 'effect.succeeded', effectId: row.id, effect: row.kind, payload, result: value },
      { kind: 'effect', id: row.id, attempt: row.attempts },
      () => { this.options.db.run("UPDATE effect SET status = 'succeeded', result = ? WHERE id = ?", JSON.stringify({ ok: value ?? null }), row.id) })
    this.wakeWaiters(row.id)
  }

  private settleFailed(row: Row, reason: string, interrupted: boolean): void {
    this.lastError.set(row.kind, reason)
    const payload = JSON.parse(row.payload) as unknown
    if (row.job_id === null) {
      this.options.db.run("UPDATE effect SET status = 'failed', result = ? WHERE id = ?", JSON.stringify({ fail: reason }), row.id)
      this.wakeWaiters(row.id)
      return
    }
    this.options.jobs.submit(row.job_id, { kind: 'effect.failed', effectId: row.id, effect: row.kind, payload, reason, ...interrupted ? { interrupted } : {} },
      { kind: 'effect', id: row.id, attempt: row.attempts },
      () => { this.options.db.run("UPDATE effect SET status = 'failed', result = ? WHERE id = ?", JSON.stringify({ fail: reason }), row.id) })
    this.wakeWaiters(row.id)
  }
}
