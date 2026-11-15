/**
 * The kernel assembled: one database, the inbox, the engine over a decider, effects, timers, projections, blobs and the registry,
 * plus recovery after a restart and the loops that dispatch effects and fire timers.
 */
import { KernelDb, type SchemaOwner } from './db.ts'
import { Effects } from './effects.ts'
import { Engine, type Decider, type JobEvent } from './engine.ts'
import { systemEnv, type Env } from './env.ts'
import { Inbox, type InboxEvent } from './inbox.ts'
import { Blobs, Projections } from './projections.ts'
import { Registry } from './registry.ts'
import { Timers } from './timers.ts'

export interface KernelOptions<S, C, E extends JobEvent> {
  /** `<stateDir>/workbench.sqlite`, or `:memory:`. */
  readonly path: string
  readonly decider: Decider<S, C, E>
  /** Other owners' migrations (the domain's), applied after the kernel's. */
  readonly owners?: readonly SchemaOwner[]
  readonly env?: Env
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  /** How often the dispatcher looks for effects whose retry fell due (default one second). */
  readonly pollMs?: number
}

export interface RecoveryReport {
  /** Running long effects (stage attempts) that returned to their jobs as interrupted. */
  readonly interrupted: number
  /** Running short effects whose outcome is now unknown, to be reconciled before they run again. */
  readonly unknown: number
  /** Overdue timers that fired. */
  readonly firedTimers: number
  /** Inbox events still waiting, handed to `route`. */
  readonly routed: number
  /** Jobs still active whose manifest names a guard that is not registered; they park until it is. */
  readonly parked: readonly string[]
}

/** A started or stopped kernel; `recover` runs once after open, before `start`. */
export class Kernel<S, C, E extends JobEvent> {
  readonly db: KernelDb
  readonly env: Env
  readonly inbox: Inbox
  readonly engine: Engine<S, C, E>
  readonly effects: Effects
  readonly timers: Timers
  readonly projections: Projections<E>
  readonly blobs: Blobs
  readonly registry: Registry
  private poll: ReturnType<typeof setInterval> | undefined
  private started = false
  private stopped = false
  private dispatchError: string | undefined
  private readonly options: KernelOptions<S, C, E>

  constructor(options: KernelOptions<S, C, E>) {
    this.options = options
    this.env = options.env ?? systemEnv()
    this.db = KernelDb.open(options.path, options.owners)
    this.inbox = new Inbox(this.db, this.env)
    this.projections = new Projections<E>(this.db)
    this.blobs = new Blobs(this.db)
    this.registry = new Registry(this.db, this.env)
    this.engine = new Engine<S, C, E>({
      db: this.db, env: this.env, decider: options.decider, projections: this.projections,
      onCommit: () => this.wake(),
      onCancelRunning: ids => { void this.effects.cancelRunning(ids) },
    })
    this.effects = new Effects({ db: this.db, env: this.env, jobs: this.engine,
      ...options.baseBackoffMs !== undefined ? { baseBackoffMs: options.baseBackoffMs } : {},
      ...options.maxBackoffMs !== undefined ? { maxBackoffMs: options.maxBackoffMs } : {} })
    this.timers = new Timers({ db: this.db, env: this.env, jobs: this.engine })
  }

  /**
   * After a restart, in order: running effects are settled (a long one fails as interrupted, a short one becomes unknown and is
   * reconciled when dispatched); overdue timers fire; inbox events still waiting go to `route`; and active jobs missing a guard are
   * reported. Pending effects and armed timers need nothing: `start` dispatches and schedules them. Handlers, guards and
   * definitions must be registered first.
   */
  recover({ route, active = () => true }: { route?: (event: InboxEvent) => void; active?: (status: string) => boolean } = {}): RecoveryReport {
    const { interrupted, unknown } = this.effects.recover()
    const firedTimers = this.timers.fireDue()
    // Each waiting event is offered to the router once, in arrival order; one it leaves waiting is offered again next time.
    const waiting = route ? this.inbox.received(Number.MAX_SAFE_INTEGER) : []
    for (const event of waiting) route!(event)
    const parked = this.db.all<{ id: string; status: string; manifest_id: string }>('SELECT id, status, manifest_id FROM job ORDER BY id')
      .filter(job => active(job.status))
      .filter(job => { const manifest = this.engine.manifest(job.manifest_id); return manifest !== undefined && this.registry.missingGuards(manifest).length > 0 })
      .map(job => job.id)
    return { interrupted, unknown, firedTimers, routed: waiting.length, parked }
  }

  /** The last error from a background dispatch pass, for health; the pass is tried again on the next wake or poll. */
  get lastError(): string | undefined { return this.dispatchError }

  /** Starts dispatching effects and firing timers. A stopped kernel is closed and opened again, not restarted. */
  start(): void {
    if (this.stopped) throw new Error('A stopped kernel cannot start again; open a new one on the same database')
    if (this.started) return
    this.started = true
    this.timers.start()
    this.poll = setInterval(() => { this.dispatch() }, this.options.pollMs ?? 1000)
    this.poll.unref?.()
    this.dispatch()
  }

  /** Wakes the dispatcher and the scheduler after a commit. */
  wake(): void {
    if (!this.started) return
    this.timers.wake()
    this.dispatch()
  }

  /** A background dispatch pass; its error is recorded, not left unhandled. */
  private dispatch(): void {
    this.effects.dispatch().catch((error: unknown) => { this.dispatchError = error instanceof Error ? error.message : String(error) })
  }

  /** Stops the loops and waits for short work in flight; a running stage attempt is left to return as interrupted after a restart. */
  async stop(): Promise<void> {
    this.started = false
    this.stopped = true
    this.effects.stop()
    this.timers.stop()
    if (this.poll) clearInterval(this.poll)
    this.poll = undefined
    await this.effects.idle({ long: false })
  }

  close(): void { this.db.close() }
}
