/**
 * Model-based property tests of the kernel with crash injection (`T7.12`, `G7`). Each run drives a real kernel on a temporary file
 * through random steps (inbox events and redeliveries, commands with repeated tool-call ids, effect passes with every handler
 * outcome, clock jumps, crashes and clean restarts) and checks the `G7` invariants after every step and after a final drain.
 * A crash can be armed at the points PLAN names: before commit, after commit before dispatch, inside a handler (after its write),
 * after a handler before its result commits, during recovery, and inside intake's transaction for an event that starts no job
 * (`T11.1`: the event is settled and a job-less notice queued together). When it fires, the process is dead: every later call on its
 * database fails, and a new kernel opens the same file and recovers.
 */
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { EffectHandler } from '../src/kernel/effects.ts'
import { originKey, type Decider } from '../src/kernel/engine.ts'
import { testEnv } from '../src/kernel/env.ts'
import type { InboxEvent } from '../src/kernel/inbox.ts'
import { Kernel } from '../src/kernel/kernel.ts'
import { counterDecider, counterProjection, counterView, manifest, type CounterCommand, type CounterEvent, type CounterState } from './fixtures/kernel-decider.ts'

type Point = 'beforeCommit' | 'afterCommit' | 'inHandler' | 'afterHandler' | 'duringRecovery' | 'inIntake'
type Run = 'ok' | 'retry' | 'fail' | 'unknown' | 'throw'
type Step =
  | { t: 'inbox'; job: number; command: CounterCommand; externalId: number; routeNow: boolean }
  /** An event that starts no job: intake settles it and queues a job-less notice in one transaction (`T11.1`). */
  | { t: 'notice'; externalId: number; routeNow: boolean }
  | { t: 'tool'; job: number; command: CounterCommand; session: number; call: number }
  | { t: 'dispatch'; runs: Run[] }
  | { t: 'advance'; ms: number }
  | { t: 'crash'; point: Point }
  | { t: 'restart' }

const JOBS = 3
const command: fc.Arbitrary<CounterCommand> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 3 }).map(by => ({ kind: 'add' as const, by })) },
  { weight: 4, arbitrary: fc.constantFrom('a', 'b').map(conversation => ({ kind: 'post' as const, text: `m-${conversation}`, conversation })) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 20_000 }).map(at => ({ kind: 'remind' as const, at: Date.UTC(2026, 0, 1) + at })) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 2 }).map(n => ({ kind: 'work' as const, id: `att-${n}` })) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 2 }).map(n => ({ kind: 'stop' as const, effect: 'work', key: `att-${n}` })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'close' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'cancel' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'boom' as const }) },
)
const run: fc.Arbitrary<Run> = fc.oneof({ weight: 5, arbitrary: fc.constant('ok' as const) }, fc.constantFrom('retry', 'fail', 'unknown', 'throw') as fc.Arbitrary<Run>)
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant('inbox' as const), job: fc.nat(JOBS - 1), command, externalId: fc.nat(30), routeNow: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('tool' as const), job: fc.nat(JOBS - 1), command, session: fc.nat(1), call: fc.nat(10) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('notice' as const), externalId: fc.nat(10), routeNow: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('dispatch' as const), runs: fc.array(run, { maxLength: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 15_000 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('crash' as const), point: fc.constantFrom<Point>('beforeCommit', 'afterCommit', 'inHandler', 'afterHandler', 'duringRecovery', 'inIntake') }) },
  { weight: 1, arbitrary: fc.constant({ t: 'restart' as const }) },
)

/** Thrown when an armed crash fires, and by every call on a dead process's database. */
class Crash extends Error {}
/** How often each crash point fired across all runs, so the suite fails if a point stops being exercised. */
const fired: Record<Point, number> = { beforeCommit: 0, afterCommit: 0, inHandler: 0, afterHandler: 0, duringRecovery: 0, inIntake: 0 }

/** One property run: the outside world (writes per key) survives restarts; each kernel instance is one process. */
async function check(steps: readonly Step[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-props-'))
  const path = join(dir, 'workbench.sqlite')
  const env = testEnv(7)
  const writes = new Map<string, number>()
  const violations: string[] = []
  const runs: Run[] = []
  let armed: Point | undefined
  let dead = false
  const crashAt = (point: Point) => { if (armed === point) { armed = undefined; dead = true; fired[point]++; throw new Crash(point) } }

  let rawGet: (sql: string, ...params: string[]) => unknown = () => undefined
  const decider: Decider<CounterState, CounterCommand, CounterEvent> = {
    ...counterDecider,
    decide(cmd, state, context) {
      const key = originKey(context.origin)
      if (rawGet('SELECT 1 FROM consumed_origin WHERE kind = ? AND id = ?', key.kind, key.id)) violations.push(`decided ${key.kind}:${key.id} again after its outcome was stored`)
      return counterDecider.decide(cmd, state, context)
    },
  }

  const open = () => {
    dead = false
    const kernel = new Kernel<CounterState, CounterCommand, CounterEvent>({ path, decider, owners: [counterView], env, baseBackoffMs: 100 })
    const { db } = kernel
    const run = db.run.bind(db), get = db.get.bind(db), all = db.all.bind(db), tx = db.tx.bind(db)
    rawGet = (sql, ...params) => get(sql, ...params)
    const alive = () => { if (dead) throw new Crash('dead') }
    Object.assign(db, {
      run: (sql: string, ...params: never[]) => {
        alive()
        if (sql.startsWith('INSERT INTO consumed_origin')) crashAt('beforeCommit')
        if (sql.startsWith("UPDATE effect SET status = 'succeeded'")) crashAt('afterHandler')
        return run(sql, ...params)
      },
      get: (sql: string, ...params: never[]) => { alive(); return get(sql, ...params) },
      all: (sql: string, ...params: never[]) => { alive(); return all(sql, ...params) },
      tx: <T>(fn: () => T) => { alive(); return tx(fn) },
    })
    const wake = kernel.wake.bind(kernel)
    kernel.wake = () => { crashAt('afterCommit'); wake() }
    kernel.projections.register(counterProjection)
    const post: EffectHandler<{ text: string }> = {
      idempotent: false,
      limit: () => 2,
      async run(payload, key) {
        const outcome = runs.shift() ?? 'ok'
        if (outcome === 'retry') return { retry: { reason: 'busy', afterMs: 100 } }
        if (outcome === 'fail') return { fail: 'refused' }
        if (outcome === 'throw') throw new Error('connection reset before the write')
        writes.set(key, (writes.get(key) ?? 0) + 1)
        crashAt('inHandler')
        return outcome === 'unknown' ? { unknown: 'timeout after the write' } : { ok: { text: payload.text } }
      },
      async reconcile(payload, key) { return writes.has(key) ? { found: { text: payload.text } } : { absent: true } },
    }
    const stops = new Map<string, () => void>()
    kernel.effects.register('post', post)
    kernel.effects.register('notice', post)
    kernel.effects.register<{ text: string }>('work', {
      idempotent: true, long: true, limit: () => 1,
      run: payload => new Promise(resolve => { stops.set(payload.text, () => resolve({ ok: { text: `${payload.text} stopped` } })) }),
      cancel: async payload => { stops.get(payload.text)?.() },
    })
    return kernel
  }
  const route = (kernel: Kernel<CounterState, CounterCommand, CounterEvent>) => (event: InboxEvent) => {
    if ((event.payload as { notice?: string }).notice !== undefined) {
      // As intake does for a trigger that matches no repository: the event settled and the notice queued in one transaction.
      kernel.db.tx(() => {
        kernel.inbox.settle(event.id, 'ignored', { reason: 'no repository' })
        crashAt('inIntake')
        kernel.effects.notify('notice', { text: (event.payload as { notice: string }).notice }, `notice:${event.id}`, 'post:notices')
      })
      return
    }
    const { job, command: cmd } = event.payload as { job: string; command: CounterCommand }
    const origin = { kind: 'inbox' as const, id: event.id }
    if (kernel.engine.job(job)) kernel.engine.submit(job, cmd, origin)
    else kernel.engine.create(job, manifest(`m-${job}`), cmd, origin)
  }
  /** Opens a new process on the file and recovers it, again if it dies during recovery. */
  const restart = (previous?: Kernel<CounterState, CounterCommand, CounterEvent>) => {
    previous?.close()
    for (;;) {
      const kernel = open()
      try {
        kernel.recover({ route: event => { crashAt('duringRecovery'); route(kernel)(event) }, active: status => status === 'open' })
        return kernel
      } catch (error) {
        if (!(error instanceof Crash)) throw error
        kernel.close()
      }
    }
  }

  const seen = new Map<string, { version: number; events: number }>()
  const observe = (kernel: Kernel<CounterState, CounterCommand, CounterEvent>) => {
    const rows = kernel.db.all<{ id: string; version: number; events: number }>(
      'SELECT id, version, (SELECT count(*) FROM job_event WHERE job_id = job.id) AS events FROM job')
    for (const row of rows) {
      const before = seen.get(row.id) ?? { version: 0, events: 0 }
      if (row.version < before.version) violations.push(`job ${row.id} version went back from ${before.version} to ${row.version}`)
      if (row.events > before.events && row.version <= before.version) violations.push(`job ${row.id} gained events without a new version`)
      seen.set(row.id, { version: row.version, events: row.events })
    }
    for (const [key, count] of writes) if (count > 1) violations.push(`effect ${key} was written ${count} times`)
    const running = kernel.db.get<{ n: number }>("SELECT count(*) AS n FROM effect WHERE kind = 'work' AND status = 'running'")!.n
    if (running > 1) violations.push(`${running} long effects running with one slot`)
  }

  let kernel = restart()
  try {
    for (const current of steps) {
      try {
        switch (current.t) {
          case 'inbox': {
            const appended = kernel.inbox.append({ source: 'test', externalId: `e${current.externalId}`, human: true,
              payload: { job: `j${current.job}`, command: current.command } })
            if (current.routeNow && !appended.duplicate && appended.event.status === 'received') route(kernel)(appended.event)
            break
          }
          case 'notice': {
            const appended = kernel.inbox.append({ source: 'test', externalId: `n${current.externalId}`, human: true, payload: { notice: `names-${current.externalId}` } })
            if (current.routeNow && !appended.duplicate && appended.event.status === 'received') route(kernel)(appended.event)
            break
          }
          case 'tool': {
            const job = `j${current.job}`
            kernel.engine.submit(job, current.command, { kind: 'tool', session: `s${current.session}`, id: `c${current.call}` })
            break
          }
          case 'dispatch': runs.push(...current.runs); await kernel.effects.dispatch(); break
          case 'advance': env.clock.advance(current.ms); kernel.timers.fireDue(); break
          case 'crash': armed = current.point; break
          case 'restart': kernel = restart(kernel); break
        }
      } catch (error) {
        if (!(error instanceof Crash)) throw error
        kernel = restart(kernel)
      }
      if (!dead) observe(kernel)
    }
    // Final drain: no more crashes, every write succeeds, time moves on until nothing is left to do.
    armed = undefined
    runs.length = 0
    kernel = restart(kernel)
    for (let pass = 0; pass < 25; pass++) {
      env.clock.advance(400_000)
      kernel.timers.fireDue()
      await kernel.effects.dispatch()
    }
    observe(kernel)
    const { db, engine } = kernel
    // A stage attempt may still run (nothing stopped it), and another may wait while it holds the only slot; nothing else is left.
    const left = db.all<{ kind: string; status: string }>(`SELECT kind, status FROM effect WHERE (kind <> 'work' AND status IN ('pending', 'running', 'unknown'))
      OR (kind = 'work' AND status = 'unknown')`)
    if (left.length > 0) violations.push(`unfinished effects after the drain: ${JSON.stringify(left)}`)
    const work = (status: string) => db.get<{ n: number }>("SELECT count(*) AS n FROM effect WHERE kind = 'work' AND status = ?", status)!.n
    if (work('pending') > 0 && work('running') === 0) violations.push('a stage attempt waits although its slot is free')
    if (db.get("SELECT 1 FROM timer WHERE status = 'armed' AND due_at <= ?", env.clock.now())) violations.push('a due timer is still armed')
    if (db.get("SELECT 1 FROM inbox_event WHERE status = 'received'")) violations.push('an inbox event was never consumed')
    for (const row of db.all<{ id: string; status: string; job_id: string | null }>("SELECT id, status, job_id FROM effect WHERE status IN ('succeeded', 'failed')")) {
      const n = db.get<{ n: number }>("SELECT count(*) AS n FROM consumed_origin WHERE kind = 'effect' AND id LIKE ?", `${row.id}#%`)!.n
      // A notice belongs to no job, so its result goes to none.
      if (n !== (row.job_id === null ? 0 : 1)) violations.push(`${row.status} effect ${row.id} returned to a job ${n} times`)
    }
    // Every event that starts no job is settled with exactly one notice, and a notice is never a job's.
    for (const row of db.all<{ id: string; status: string }>("SELECT id, status FROM inbox_event WHERE external_id LIKE 'n%'")) {
      const notices = db.get<{ n: number }>("SELECT count(*) AS n FROM effect WHERE kind = 'notice' AND idempotency_key = ?", `notice:${row.id}`)!.n
      if (row.status !== 'ignored' || notices !== 1) violations.push(`event ${row.id} is ${row.status} with ${notices} notices`)
    }
    if (db.get("SELECT 1 FROM effect WHERE kind = 'notice' AND job_id IS NOT NULL")) violations.push('a notice belongs to a job')
    for (const row of db.all<{ idempotency_key: string }>("SELECT idempotency_key FROM effect WHERE kind = 'notice' AND status = 'succeeded'")) {
      if (writes.get(row.idempotency_key) !== 1) violations.push(`succeeded notice ${row.idempotency_key} has ${writes.get(row.idempotency_key) ?? 0} writes`)
    }
    for (const row of db.all<{ id: string }>("SELECT id FROM timer WHERE status = 'fired'")) {
      if (!db.get("SELECT 1 FROM consumed_origin WHERE kind = 'timer' AND id = ?", row.id)) violations.push(`fired timer ${row.id} never reached its job`)
    }
    for (const row of db.all<{ idempotency_key: string }>("SELECT idempotency_key FROM effect WHERE kind = 'post' AND status = 'succeeded'")) {
      if (writes.get(row.idempotency_key) !== 1) violations.push(`succeeded effect ${row.idempotency_key} has ${writes.get(row.idempotency_key) ?? 0} writes`)
    }
    for (const { id } of db.all<{ id: string }>('SELECT id FROM job')) {
      if (JSON.stringify(engine.foldedState(id)) !== JSON.stringify(engine.job(id)!.state)) violations.push(`job ${id} state differs from the fold of its events`)
    }
    const view = () => JSON.stringify(db.all('SELECT job_id, n FROM counter_view ORDER BY job_id'))
    const before = view()
    kernel.projections.rebuild('counter_view')
    if (view() !== before) violations.push('rebuilding the projection changed it')
  } finally {
    kernel.close()
    rmSync(dir, { recursive: true, force: true })
  }
  expect(violations).toEqual([])
}

it('keeps every G7 invariant over 200 seeded runs of 50+ steps with random crashes', async () => {
  await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 50, maxLength: 80 }), check), { numRuns: 200, seed: 20261111, endOnFailure: true })
  for (const [point, count] of Object.entries(fired)) expect(count, `crashes fired ${point}`).toBeGreaterThanOrEqual(10)
}, 300_000)
