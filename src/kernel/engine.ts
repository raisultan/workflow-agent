/**
 * The engine: one writer per job, every change in one transaction. Each input (an inbox event, an effect result, a timer, a tool
 * call) is an origin that is consumed exactly once. Within one transaction the engine checks the origin, runs the decider,
 * appends the events, applies the projections, inserts effects and timers, updates the job and stores the outcome. A redelivered
 * origin returns its stored outcome. `node:sqlite` is synchronous, so a decision cannot interleave with another: the
 * transaction is the job's mailbox.
 */
import type { KernelDb } from './db.ts'
import type { Env } from './env.ts'
import { Inbox } from './inbox.ts'
import type { Projections } from './projections.ts'

/** Where an input came from; each is consumed once. */
export type Origin =
  | { kind: 'inbox'; id: string }
  | { kind: 'effect'; id: string; attempt: number }
  | { kind: 'timer'; id: string }
  | { kind: 'tool'; session: string; id: string }

/** The `consumed_origin` key of an origin: an effect result per attempt, a tool call per session. */
export function originKey(origin: Origin): { kind: Origin['kind']; id: string } {
  switch (origin.kind) {
    case 'effect': return { kind: 'effect', id: `${origin.id}#${origin.attempt}` }
    case 'tool': return { kind: 'tool', id: `${origin.session}#${origin.id}` }
    default: return { kind: origin.kind, id: origin.id }
  }
}

/**
 * Commands the kernel sends to a job about its own effects and timers. An effect's result carries the payload the job asked for, so
 * the job can tell what the result is about without trusting the handler's output.
 */
export type KernelCommand =
  | { kind: 'effect.succeeded'; effectId: string; effect: string; payload: unknown; result: unknown }
  | { kind: 'effect.failed'; effectId: string; effect: string; payload: unknown; reason: string; interrupted?: boolean }
  | { kind: 'timer.fired'; timerId: string; timer: string; subject: string }

export interface JobEvent { readonly type: string }
/** An effect a decision asks for. The kernel makes its idempotency key from the job, the origin and its place in the decision. */
export interface EffectSpec { readonly kind: string; readonly payload: unknown; readonly orderingKey?: string; readonly dueAt?: number }
/**
 * Cancels this job's unfinished effects of `kind` on `orderingKey` (for example, a stage attempt). A pending one is cancelled in
 * the decision's transaction; a running long one is stopped through its handler after commit, and its result still comes back.
 */
export interface EffectCancel { readonly cancel: { readonly kind: string; readonly orderingKey: string } }
/** Arms a timer (replacing an armed one of the same kind and subject) or cancels one. */
export type TimerSpec =
  | { readonly arm: { readonly kind: string; readonly subject: string; readonly dueAt: number } }
  | { readonly cancel: { readonly kind: string; readonly subject: string } }
/** The frozen inputs a job runs on; immutable once stored. */
export interface RunManifest {
  readonly id: string
  readonly definitionId: string
  readonly definitionVersion: number
  readonly definitionHash: string
  readonly data: unknown
}
export interface DecideContext { readonly jobId: string; readonly now: number; readonly origin: Origin }
export interface Rejection { readonly rejected: string }

/** A job's rules as pure functions. They must not read the clock, the database or anything else outside their arguments. */
export interface Decider<S, C, E extends JobEvent> {
  initial(jobId: string, manifest: RunManifest): S
  decide(command: C | KernelCommand, state: S, context: DecideContext): readonly E[] | Rejection
  evolve(state: S, event: E): S
  effects(event: E, state: S): readonly (EffectSpec | EffectCancel)[]
  timers(event: E, state: S): readonly TimerSpec[]
  /** The job's status column, for listing; the kernel's own `faulted` overrides it. */
  status(state: S): string
  /** Commands a faulted job still takes (such as cancel); none when absent. */
  acceptsWhenFaulted?(command: C | KernelCommand): boolean
}

export type Outcome =
  | { kind: 'decided'; jobId: string; version: number; events: number; effects: string[] }
  | { kind: 'rejected'; jobId: string; reason: string }
  | { kind: 'faulted'; jobId: string; error: string }
/** An outcome, and whether it was stored by an earlier delivery of the same origin. */
export interface Submitted { outcome: Outcome; replayed: boolean }

/** The kernel's status for a job whose decider threw; it takes only commands the decider accepts when faulted. */
export const FAULTED = 'faulted'

/** An error thrown by decider or projection code: a bug in the rules, which faults the job instead of retrying the input. */
class DeciderFault extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'DeciderFault'
  }
}
const guard = <T>(fn: () => T): T => {
  try { return fn() } catch (error) { throw new DeciderFault(error) }
}

interface JobRow { id: string; manifest_id: string; status: string; state: string; version: number }

export interface EngineOptions<S, C, E extends JobEvent> {
  readonly db: KernelDb
  readonly env: Env
  readonly decider: Decider<S, C, E>
  readonly projections?: Projections<E>
  /** Called after each new commit, to wake the effect dispatcher and the timer scheduler. */
  readonly onCommit?: () => void
  /** Called after a commit that asked to cancel running effects, so their handlers can stop them. */
  readonly onCancelRunning?: (effectIds: readonly string[]) => void
}

/** Runs a decider over durable inputs, one transaction per input. */
export class Engine<S, C, E extends JobEvent> {
  private readonly inbox: Inbox
  /** Running effects the current decision asked to cancel; reported after it commits. */
  private cancelRunning: string[] = []
  private readonly options: EngineOptions<S, C, E>
  constructor(options: EngineOptions<S, C, E>) {
    this.options = options
    this.inbox = new Inbox(options.db, options.env)
  }

  /**
   * Creates job `jobId` on `manifest` and decides its first command. A job that already exists rejects the command.
   * @param within - Work that must commit with this decision, such as settling what produced it; it also runs when the decision faults.
   */
  create(jobId: string, manifest: RunManifest, command: C | KernelCommand, origin: Origin, within?: () => void): Submitted {
    return this.run(jobId, command, origin, manifest, within)
  }

  /** Decides `command` for job `jobId`; see `create` for `within`. */
  submit(jobId: string, command: C | KernelCommand, origin: Origin, within?: () => void): Submitted {
    return this.run(jobId, command, origin, undefined, within)
  }

  /** The stored outcome of an origin, if it was consumed. */
  outcome(origin: Origin): Outcome | undefined {
    const key = originKey(origin)
    return this.storedOutcome(key.kind, key.id)
  }

  job(jobId: string): { status: string; state: S; version: number; manifestId: string } | undefined {
    const row = this.options.db.get<JobRow>('SELECT * FROM job WHERE id = ?', jobId)
    return row && { status: row.status, state: JSON.parse(row.state) as S, version: row.version, manifestId: row.manifest_id }
  }

  events(jobId: string): E[] {
    return this.options.db.all<{ data: string }>('SELECT data FROM job_event WHERE job_id = ? ORDER BY seq', jobId)
      .map(row => JSON.parse(row.data) as E)
  }

  manifest(id: string): RunManifest | undefined {
    const row = this.options.db.get<{ id: string; definition_id: string; definition_version: number; definition_hash: string; data: string }>(
      'SELECT * FROM run_manifest WHERE id = ?', id)
    return row && { id: row.id, definitionId: row.definition_id, definitionVersion: row.definition_version,
      definitionHash: row.definition_hash, data: JSON.parse(row.data) as unknown }
  }

  /** The job's state rebuilt from its initial state and its events; equal to the stored state unless the kernel has a bug. */
  foldedState(jobId: string): S | undefined {
    const job = this.job(jobId)
    const manifest = job && this.manifest(job.manifestId)
    if (!job || !manifest) return undefined
    return this.events(jobId).reduce((state, event) => this.options.decider.evolve(state, event), this.options.decider.initial(jobId, manifest))
  }

  private run(jobId: string, command: C | KernelCommand, origin: Origin, manifest: RunManifest | undefined, within?: () => void): Submitted {
    const { db } = this.options
    const key = originKey(origin)
    let submitted: Submitted
    this.cancelRunning = []
    try {
      submitted = db.tx(() => this.decide(jobId, command, origin, key, manifest, within))
    } catch (error) {
      // What the rolled-back decision asked to cancel did not happen.
      this.cancelRunning = []
      if (!(error instanceof DeciderFault)) throw error
      submitted = db.tx(() => {
        const stored = this.storedOutcome(key.kind, key.id)
        if (stored) return { outcome: stored, replayed: true }
        within?.()
        const outcome: Outcome = { kind: 'faulted', jobId, error: error.message }
        db.run('UPDATE job SET status = ?, version = version + 1, updated_at = ? WHERE id = ?', FAULTED, this.options.env.clock.now(), jobId)
        this.consume(key, origin, jobId, outcome)
        return { outcome, replayed: false }
      })
    }
    const running = this.cancelRunning
    this.cancelRunning = []
    if (!submitted.replayed) {
      if (running.length > 0) this.options.onCancelRunning?.(running)
      this.options.onCommit?.()
    }
    return submitted
  }

  private decide(jobId: string, command: C | KernelCommand, origin: Origin, key: { kind: string; id: string },
    manifest: RunManifest | undefined, within?: () => void): Submitted {
    const { db, env, decider, projections } = this.options
    const stored = this.storedOutcome(key.kind, key.id)
    if (stored) return { outcome: stored, replayed: true }
    within?.()
    const now = env.clock.now()
    const reject = (reason: string): Submitted => {
      const outcome: Outcome = { kind: 'rejected', jobId, reason }
      this.consume(key, origin, jobId, outcome)
      return { outcome, replayed: false }
    }
    const row = db.get<JobRow>('SELECT * FROM job WHERE id = ?', jobId)
    let state: S
    if (manifest) {
      if (row) return reject('job exists')
      this.storeManifest(manifest, now)
      state = guard(() => decider.initial(jobId, manifest))
    } else {
      if (!row) return reject('no such job')
      if (row.status === FAULTED && !guard(() => decider.acceptsWhenFaulted?.(command) ?? false)) return reject('job is faulted')
      state = JSON.parse(row.state) as S
    }
    const decided = guard(() => decider.decide(command, state, { jobId, now, origin }))
    if (!Array.isArray(decided)) return reject((decided as Rejection).rejected)
    const events = decided as readonly E[]
    if (manifest) {
      db.run('INSERT INTO job (id, manifest_id, status, state, version, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        jobId, manifest.id, guard(() => decider.status(state)), JSON.stringify(state), now, now)
    }
    let seq = db.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM job_event WHERE job_id = ?', jobId)?.seq ?? 0
    let effectSeq = db.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM effect')?.seq ?? 0
    const effects: string[] = []
    for (const event of events) {
      state = guard(() => decider.evolve(state, event))
      db.run('INSERT INTO job_event (job_id, seq, type, type_version, causation, at, data) VALUES (?, ?, ?, 1, ?, ?, ?)',
        jobId, ++seq, event.type, `${key.kind}:${key.id}`, now, JSON.stringify(event))
      if (projections) guard(() => projections.apply(event, jobId))
      for (const spec of guard(() => decider.effects(event, state))) {
        if ('cancel' in spec) { this.cancelEffects(jobId, spec.cancel.kind, spec.cancel.orderingKey); continue }
        const id = env.ids.next('ef_')
        db.run(`INSERT INTO effect (id, job_id, kind, idempotency_key, ordering_key, payload, status, attempts, due_at, result, seq)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?)`, id, jobId, spec.kind, `${jobId}:${key.kind}:${key.id}:${effects.length}`,
        spec.orderingKey ?? null, JSON.stringify(spec.payload ?? null), spec.dueAt ?? now, ++effectSeq)
        effects.push(id)
      }
      for (const timer of guard(() => decider.timers(event, state))) this.applyTimer(jobId, timer)
    }
    const status = guard(() => decider.status(state))
    const version = (row?.version ?? 0) + (events.length > 0 ? 1 : 0)
    if (events.length > 0 || manifest) {
      const { changes } = db.run('UPDATE job SET status = ?, state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?',
        status, JSON.stringify(state), version, now, jobId, row?.version ?? 0)
      if (changes !== 1) throw new Error(`Job ${jobId} changed under its own transaction`)
    }
    const outcome: Outcome = { kind: 'decided', jobId, version, events: events.length, effects }
    this.consume(key, origin, jobId, outcome)
    return { outcome, replayed: false }
  }

  private cancelEffects(jobId: string, kind: string, orderingKey: string): void {
    const { db } = this.options
    db.run("UPDATE effect SET status = 'cancelled' WHERE job_id = ? AND kind = ? AND ordering_key = ? AND status = 'pending'", jobId, kind, orderingKey)
    for (const row of db.all<{ id: string }>("SELECT id FROM effect WHERE job_id = ? AND kind = ? AND ordering_key = ? AND status = 'running'",
      jobId, kind, orderingKey)) this.cancelRunning.push(row.id)
  }

  private applyTimer(jobId: string, timer: TimerSpec): void {
    const { db, env } = this.options
    const { kind, subject } = 'arm' in timer ? timer.arm : timer.cancel
    db.run("UPDATE timer SET status = 'cancelled' WHERE job_id = ? AND kind = ? AND subject = ? AND status = 'armed'", jobId, kind, subject)
    if ('arm' in timer) {
      db.run("INSERT INTO timer (id, job_id, kind, subject, due_at, status) VALUES (?, ?, ?, ?, ?, 'armed')",
        env.ids.next('tm_'), jobId, kind, subject, timer.arm.dueAt)
    }
  }

  private storeManifest(manifest: RunManifest, now: number): void {
    const data = JSON.stringify(manifest.data ?? null)
    const existing = this.options.db.get<{ definition_hash: string; data: string }>('SELECT definition_hash, data FROM run_manifest WHERE id = ?', manifest.id)
    if (existing) {
      if (existing.definition_hash !== manifest.definitionHash || existing.data !== data) throw new Error(`Run manifest ${manifest.id} is immutable`)
      return
    }
    this.options.db.run(`INSERT INTO run_manifest (id, definition_id, definition_version, definition_hash, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, manifest.id, manifest.definitionId, manifest.definitionVersion, manifest.definitionHash, data, now)
  }

  private storedOutcome(kind: string, id: string): Outcome | undefined {
    const row = this.options.db.get<{ outcome: string }>('SELECT outcome FROM consumed_origin WHERE kind = ? AND id = ?', kind, id)
    return row && JSON.parse(row.outcome) as Outcome
  }

  private consume(key: { kind: string; id: string }, origin: Origin, jobId: string, outcome: Outcome): void {
    this.options.db.run('INSERT INTO consumed_origin (kind, id, job_id, outcome, at) VALUES (?, ?, ?, ?, ?)',
      key.kind, key.id, jobId, JSON.stringify(outcome), this.options.env.clock.now())
    if (origin.kind === 'inbox' && !this.inbox.settle(origin.id, 'routed', { jobId, outcome: outcome.kind })) {
      throw new Error(`Inbox event ${origin.id} was already settled`)
    }
  }
}
