/**
 * Durable timers. A decision arms or cancels them (`TimerSpec`); when one falls due it fires as a `timer.fired` command to its job,
 * marked `fired` in the same transaction. The job decides whether its subject is still current, so a stale timer does nothing.
 * One scheduler waits for the next due timer; it is re-armed whenever a commit may have armed an earlier one.
 */
import type { KernelDb } from './db.ts'
import type { CommandSink } from './effects.ts'
import type { Env } from './env.ts'

interface Row { id: string; job_id: string; kind: string; subject: string; due_at: number }

/** The longest a scheduler waits in one step (the most `setTimeout` accepts). */
const MAX_WAIT_MS = 2 ** 31 - 1

/** Fires due timers, and schedules itself at the next one while started. */
export class Timers {
  private handle: ReturnType<typeof setTimeout> | undefined
  private running = false
  /** A firing pass is under way; a wake during it (a fired timer's own commit) asks for another pass instead of recursing. */
  private firing = false
  private again = false

  private readonly options: { readonly db: KernelDb; readonly env: Env; readonly jobs: CommandSink }
  constructor(options: { readonly db: KernelDb; readonly env: Env; readonly jobs: CommandSink }) { this.options = options }

  /** Fires every armed timer due by now, earliest first; returns how many fired. */
  fireDue(): number {
    const { db, env, jobs } = this.options
    const due = db.all<Row>("SELECT id, job_id, kind, subject, due_at FROM timer WHERE status = 'armed' AND due_at <= ? ORDER BY due_at, id", env.clock.now())
    for (const timer of due) {
      jobs.submit(timer.job_id, { kind: 'timer.fired', timerId: timer.id, timer: timer.kind, subject: timer.subject }, { kind: 'timer', id: timer.id },
        () => { db.run("UPDATE timer SET status = 'fired' WHERE id = ? AND status = 'armed'", timer.id) })
    }
    return due.length
  }

  /** When the next armed timer is due (epoch ms), if any. */
  nextDue(): number | undefined {
    return this.options.db.get<{ due: number | null }>("SELECT min(due_at) AS due FROM timer WHERE status = 'armed'")?.due ?? undefined
  }

  /** Starts scheduling: fires what is due, then waits for the next timer. */
  start(): void {
    this.running = true
    this.schedule()
  }

  /** Re-arms the scheduler, for example after a commit that armed a timer. */
  wake(): void {
    if (this.running) this.schedule()
  }

  stop(): void {
    this.running = false
    if (this.handle) clearTimeout(this.handle)
    this.handle = undefined
  }

  private schedule(): void {
    if (this.handle) clearTimeout(this.handle)
    this.handle = undefined
    if (!this.running) return
    if (this.firing) { this.again = true; return }
    this.firing = true
    try {
      do { this.again = false; this.fireDue() } while (this.again)
    } finally { this.firing = false }
    const next = this.nextDue()
    if (next === undefined) return
    this.handle = setTimeout(() => { this.handle = undefined; this.schedule() },
      Math.min(MAX_WAIT_MS, Math.max(0, next - this.options.env.clock.now())))
    this.handle.unref?.()
  }
}
