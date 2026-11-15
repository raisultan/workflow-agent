/** The effects dispatcher (`T7.7`): results back to the job in the settling transaction, retries, reconciliation, order, slots, cancel. */
import { expect, it } from 'vitest'
import type { EffectHandler, EffectResult } from '../src/kernel/effects.ts'
import { counterKernel, manifest } from './fixtures/kernel-decider.ts'

const timer = (id: string) => ({ kind: 'timer' as const, id })
/** A fake external system: writes per idempotency key, and a script of what each run reports. */
function external(script: (EffectResult | 'throw' | 'crash')[] = []) {
  const writes = new Map<string, number>()
  const handler: EffectHandler<{ text: string }> = {
    idempotent: false,
    limit: () => 2,
    async run(payload, key) {
      const step = script.shift() ?? { ok: { text: payload.text } }
      if (step === 'throw') throw new Error('connection reset')
      if (step === 'crash') { writes.set(key, (writes.get(key) ?? 0) + 1); return { unknown: 'timeout after the write' } }
      if ('ok' in step) writes.set(key, (writes.get(key) ?? 0) + 1)
      return step
    },
    async reconcile(payload, key) { return writes.has(key) ? { found: { text: payload.text } } : { absent: true } },
  }
  return { writes, handler }
}
const status = (db: ReturnType<typeof counterKernel>['db']) => db.all<{ status: string }>('SELECT status FROM effect ORDER BY seq').map(row => row.status)

it('runs a due effect and returns its result to the job in the transaction that settles it', async () => {
  const { engine, effects, db } = counterKernel()
  const { writes, handler } = external()
  effects.register('post', handler)
  engine.create('j1', manifest(), { kind: 'post', text: 'hello' }, timer('c'))
  await effects.dispatch()
  expect(status(db)).toEqual(['succeeded'])
  expect(engine.job('j1')!.state.posted).toEqual(['hello'])
  expect([...writes.values()]).toEqual([1])
  expect(db.get('SELECT kind, id FROM consumed_origin WHERE kind = ?', 'effect')).toMatchObject({ kind: 'effect' })
})

it('retries with backoff, and runs nothing before it is due', async () => {
  const { engine, effects, db, env } = counterKernel()
  const { handler } = external([{ retry: { reason: '429' } }])
  effects.register('post', handler)
  engine.create('j1', manifest(), { kind: 'post', text: 'later' }, timer('c'))
  await effects.dispatch()
  const due = db.get<{ due_at: number; status: string; attempts: number }>('SELECT due_at, status, attempts FROM effect')!
  expect(due).toMatchObject({ status: 'pending', attempts: 1 })
  expect(due.due_at - env.clock.now()).toBeGreaterThanOrEqual(500)
  expect(effects.health().post).toMatchObject({ retrying: 1, lastError: '429' })
  await effects.dispatch()
  expect(status(db)).toEqual(['pending'])
  env.clock.advance(due.due_at - env.clock.now())
  await effects.dispatch()
  expect(engine.job('j1')!.state.posted).toEqual(['later'])
})

it('reconciles an unknown write before running it again, so the external system records it once', async () => {
  const { engine, effects, db } = counterKernel()
  const { writes, handler } = external(['crash', 'throw'])
  effects.register('post', handler)
  engine.create('j1', manifest(), { kind: 'post', text: 'one', conversation: 'a' }, timer('c'))
  engine.submit('j1', { kind: 'post', text: 'two', conversation: 'b' }, timer('d'))
  await effects.dispatch()
  // `one` was written before the timeout: reconcile finds it. `two` threw before writing: reconcile finds nothing, so it runs again.
  expect(status(db)).toEqual(['succeeded', 'pending'])
  await effects.dispatch()
  expect(status(db)).toEqual(['succeeded', 'succeeded'])
  expect([...writes.values()]).toEqual([1, 1])
  expect(engine.job('j1')!.state.posted).toEqual(['one', 'two'])
})

it('keeps an unknown effect unknown while reconcile fails, and checks again after a backoff', async () => {
  const { engine, effects, db, env } = counterKernel()
  const { handler } = external(['crash'])
  let reachable = false
  effects.register('post', { ...handler, reconcile: async (payload, key) => {
    if (!reachable) throw new Error('still down')
    return handler.reconcile!(payload, key)
  } })
  engine.create('j1', manifest(), { kind: 'post', text: 'x' }, timer('c'))
  await effects.dispatch()
  expect(status(db)).toEqual(['unknown'])
  reachable = true
  env.clock.advance(400_000)
  await effects.dispatch()
  expect(status(db)).toEqual(['succeeded'])
})

it('fails an effect to its job without holding back the next one on the same ordering key, and runs one key in order', async () => {
  const { engine, effects, db } = counterKernel()
  const order: string[] = []
  const { handler } = external([{ fail: '403 forbidden' }])
  effects.register('post', { ...handler, run: async (payload, key, attempt) => { order.push(payload.text); return handler.run(payload, key, attempt) } })
  engine.create('j1', manifest(), { kind: 'post', text: 'first', conversation: 'mm:1' }, timer('c'))
  engine.submit('j1', { kind: 'post', text: 'second', conversation: 'mm:1' }, timer('d'))
  await effects.dispatch()
  expect(order).toEqual(['first'])
  expect(engine.job('j1')!.state.failed).toEqual(['403 forbidden'])
  await effects.dispatch()
  expect(order).toEqual(['first', 'second'])
  expect(status(db)).toEqual(['failed', 'succeeded'])
})

it('holds at most `limit()` long effects running, cancels a pending one in the decision, and stops a running one', async () => {
  const { engine, effects, db, cancelled } = counterKernel()
  const stops = new Map<string, () => void>()
  effects.register<{ text: string }>('work', {
    idempotent: true, long: true, limit: () => 1,
    run: payload => new Promise<EffectResult>(resolve => { stops.set(payload.text, () => resolve({ ok: { text: `${payload.text} stopped` } })) }),
    cancel: async payload => { stops.get(payload.text)?.() },
  })
  engine.create('j1', manifest(), { kind: 'work', id: 'att-1' }, timer('c'))
  engine.submit('j1', { kind: 'work', id: 'att-2' }, timer('d'))
  const first = effects.dispatch()
  await Promise.resolve()
  expect(status(db)).toEqual(['running', 'pending'])
  // A pending effect is cancelled inside the decision; the running one is stopped by its handler after commit.
  engine.submit('j1', { kind: 'stop', effect: 'work', key: 'att-2' }, timer('e'))
  expect(status(db)).toEqual(['running', 'cancelled'])
  engine.submit('j1', { kind: 'stop', effect: 'work', key: 'att-1' }, timer('f'))
  expect(cancelled).toEqual([[db.get<{ id: string }>("SELECT id FROM effect WHERE ordering_key = 'att-1'")!.id]])
  await first
  await effects.idle()
  expect(status(db)).toEqual(['succeeded', 'cancelled'])
  expect(engine.job('j1')!.state.posted).toEqual(['att-1 stopped'])
})

it('after a restart, fails a long effect as interrupted and makes a short one unknown, to be reconciled', async () => {
  const { engine, effects, db } = counterKernel()
  const { writes, handler } = external()
  effects.register('post', handler)
  effects.register<{ text: string }>('work', { idempotent: true, long: true, limit: () => 1, run: () => new Promise(() => {}), cancel: async () => {} })
  engine.create('j1', manifest(), { kind: 'work', id: 'att-1' }, timer('c'))
  engine.submit('j1', { kind: 'post', text: 'p' }, timer('d'))
  // Simulate a crash with both running: the rows say `running`, but no handler is.
  db.run("UPDATE effect SET status = 'running', attempts = 1")
  writes.set(db.get<{ idempotency_key: string }>("SELECT idempotency_key FROM effect WHERE kind = 'post'")!.idempotency_key, 1)
  effects.recover()
  expect(status(db)).toEqual(['failed', 'unknown'])
  expect(engine.job('j1')!.state.failed).toEqual(['interrupted by a restart'])
  expect(engine.events('j1').at(-1)).toMatchObject({ type: 'postFailed' })
  await effects.dispatch()
  expect(status(db)).toEqual(['failed', 'succeeded'])
  expect([...writes.values()]).toEqual([1])
})

it('refuses a handler that could write twice or could not be stopped', () => {
  const { effects } = counterKernel()
  const run = async () => ({ ok: null })
  expect(() => effects.register('x', { idempotent: false, limit: () => 1, run })).toThrow(/needs reconcile/)
  expect(() => effects.register('y', { idempotent: true, long: true, limit: () => 1, run })).toThrow(/needs cancel/)
  effects.register('z', { idempotent: true, limit: () => 1, run })
  expect(() => effects.register('z', { idempotent: true, limit: () => 1, run })).toThrow(/has a handler/)
})

it('lets a caller await an effect\'s outcome: its result, its failure, or pending after the timeout', async () => {
  const { engine, effects, db } = counterKernel()
  let finish!: (result: { ok: unknown } | { fail: string }) => void
  effects.register<{ text: string }>('post', { idempotent: true, limit: () => 1, run: () => new Promise(resolve => { finish = resolve }) })
  db.run("INSERT INTO inbox_event (id, source, external_id, human, received_at, payload, status) VALUES ('e1', 'test', 'e1', 1, 0, '{}', 'received')")
  const { outcome } = engine.create('j1', manifest(), { kind: 'post', text: 'hello' }, { kind: 'inbox', id: 'e1' })
  const id = outcome.kind === 'decided' ? outcome.effects[0]! : ''
  expect(await effects.awaitResult(id, 10)).toEqual({ pending: true })
  const dispatched = effects.dispatch()
  const waiting = effects.awaitResult(id, 5000)
  finish({ ok: { postId: 'p1' } })
  await dispatched
  expect(await waiting).toEqual({ ok: { postId: 'p1' } })
  expect(await effects.awaitResult(id, 10)).toEqual({ ok: { postId: 'p1' } })
  expect(await effects.awaitResult('ef_none', 10)).toEqual({ fail: 'No effect ef_none' })
  db.close()
})

it('runs a notice, an effect with no job, once per key; its result goes to no job, and a failure is recorded on its row (T11.1)', async () => {
  const { engine, effects, db } = counterKernel()
  const { writes, handler } = external([{ ok: {} }, { fail: 'channel gone' }])
  effects.register('notice', handler)
  engine.create('j1', manifest(), { kind: 'add', by: 1 }, timer('c'))
  const first = db.tx(() => effects.notify('notice', { text: 'no repository' }, 'notice:in_1', 'post:t'))
  expect(db.tx(() => effects.notify('notice', { text: 'no repository' }, 'notice:in_1', 'post:t'))).toEqual({ id: first.id, duplicate: true })
  db.tx(() => effects.notify('notice', { text: 'second' }, 'notice:in_2'))
  await effects.dispatch()
  expect(db.all('SELECT job_id, status FROM effect WHERE kind = ? ORDER BY seq', 'notice')).toEqual([{ job_id: null, status: 'succeeded' },
    { job_id: null, status: 'failed' }])
  expect([...writes.keys()]).toEqual(['notice:in_1'])
  expect(await effects.awaitResult(first.id, 10)).toEqual({ ok: {} })
  // The job saw none of it.
  expect(engine.events('j1').map(event => event.type)).not.toContain('posted')
  expect(db.get<{ n: number }>("SELECT count(*) AS n FROM consumed_origin WHERE kind = 'effect'")!.n).toBe(0)
})

it('reconciles a notice whose outcome is unknown, and posts it at most once', async () => {
  const { effects, db } = counterKernel()
  const { writes, handler } = external(['crash'])
  effects.register('notice', handler)
  db.tx(() => effects.notify('notice', { text: 'no repository' }, 'notice:in_1'))
  await effects.dispatch()
  await effects.dispatch()
  expect(db.get('SELECT job_id, status FROM effect')).toEqual({ job_id: null, status: 'succeeded' })
  expect(writes.get('notice:in_1')).toBe(1)
})
