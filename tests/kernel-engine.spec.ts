/** The engine (`T7.5`, `T7.6`) and projections (`T7.13`): one transaction per decision, each origin consumed once. */
import { expect, it } from 'vitest'
import { Blobs } from '../src/kernel/projections.ts'
import { Inbox } from '../src/kernel/inbox.ts'
import { counterKernel, manifest } from './fixtures/kernel-decider.ts'

const inbox = (id: string) => ({ kind: 'inbox' as const, id })

it('creates a job, decides commands into events, and keeps state equal to the fold of its events', () => {
  const { engine, db, env } = counterKernel()
  const event = new Inbox(db, env).append({ source: 'test', externalId: 'e1', human: true, payload: {} }).event
  const created = engine.create('j1', manifest(), { kind: 'add', by: 2 }, inbox(event.id))
  expect(created).toEqual({ outcome: { kind: 'decided', jobId: 'j1', version: 1, events: 1, effects: [] }, replayed: false })
  expect(new Inbox(db, env).get(event.id)).toMatchObject({ status: 'routed', outcome: { jobId: 'j1', outcome: 'decided' } })
  engine.submit('j1', { kind: 'add', by: 3 }, { kind: 'timer', id: 't1' })
  expect(engine.job('j1')).toMatchObject({ status: 'open', version: 2, state: { n: 5 } })
  expect(engine.events('j1')).toEqual([{ type: 'added', by: 2 }, { type: 'added', by: 3 }])
  expect(engine.foldedState('j1')).toEqual(engine.job('j1')!.state)
  expect(db.all('SELECT seq, causation FROM job_event WHERE job_id = ? ORDER BY seq', 'j1'))
    .toEqual([{ seq: 1, causation: `inbox:${event.id}` }, { seq: 2, causation: 'timer:t1' }])
})

it('returns the stored outcome for a redelivered origin without deciding again; each effect attempt and tool session is its own origin', () => {
  const { engine, commits } = counterKernel()
  engine.create('j1', manifest(), { kind: 'add', by: 1 }, { kind: 'timer', id: 'c' })
  const first = engine.submit('j1', { kind: 'add', by: 10 }, { kind: 'effect', id: 'ef1', attempt: 1 })
  const again = engine.submit('j1', { kind: 'add', by: 99 }, { kind: 'effect', id: 'ef1', attempt: 1 })
  expect(again).toEqual({ outcome: first.outcome, replayed: true })
  expect(engine.submit('j1', { kind: 'add', by: 100 }, { kind: 'effect', id: 'ef1', attempt: 2 }).replayed).toBe(false)
  // A tool call repeated by a resumed session returns the stored result; the same call id in another session is a new call.
  const tool = engine.submit('j1', { kind: 'add', by: 1000 }, { kind: 'tool', session: 's1', id: 'call_1' })
  expect(engine.submit('j1', { kind: 'add', by: 1000 }, { kind: 'tool', session: 's1', id: 'call_1' })).toEqual({ outcome: tool.outcome, replayed: true })
  expect(engine.submit('j1', { kind: 'add', by: 1000 }, { kind: 'tool', session: 's2', id: 'call_1' }).replayed).toBe(false)
  expect(engine.job('j1')!.state.n).toBe(2111)
  expect(commits()).toBe(5)
})

it('consumes a rejected input with its reason, so it never retries, and rejects commands for a missing or existing job', () => {
  const { engine } = counterKernel()
  engine.create('j1', manifest(), { kind: 'close' }, { kind: 'timer', id: 'c' })
  const rejected = engine.submit('j1', { kind: 'add', by: 1 }, { kind: 'timer', id: 'late' })
  expect(rejected.outcome).toEqual({ kind: 'rejected', jobId: 'j1', reason: 'job is closed' })
  expect(engine.submit('j1', { kind: 'add', by: 1 }, { kind: 'timer', id: 'late' })).toEqual({ outcome: rejected.outcome, replayed: true })
  expect(engine.job('j1')!.version).toBe(1)
  expect(engine.create('j1', manifest(), { kind: 'add', by: 1 }, { kind: 'timer', id: 'dup' }).outcome).toMatchObject({ reason: 'job exists' })
  expect(engine.submit('nope', { kind: 'add', by: 1 }, { kind: 'timer', id: 'x' }).outcome).toMatchObject({ reason: 'no such job' })
})

it('faults a job whose rules throw, consumes the input, and then takes only cancel', () => {
  const { engine, db } = counterKernel()
  engine.create('j1', manifest(), { kind: 'add', by: 1 }, { kind: 'timer', id: 'c' })
  const faulted = engine.submit('j1', { kind: 'boom' }, { kind: 'timer', id: 'b' })
  expect(faulted.outcome).toEqual({ kind: 'faulted', jobId: 'j1', error: 'the rules have a bug' })
  expect(engine.submit('j1', { kind: 'boom' }, { kind: 'timer', id: 'b' }).replayed).toBe(true)
  expect(engine.job('j1')).toMatchObject({ status: 'faulted', version: 2, state: { n: 1 } })
  expect(engine.submit('j1', { kind: 'add', by: 1 }, { kind: 'timer', id: 'a' }).outcome).toMatchObject({ reason: 'job is faulted' })
  expect(engine.submit('j1', { kind: 'cancel' }, { kind: 'timer', id: 'x' }).outcome.kind).toBe('decided')
  expect(engine.job('j1')).toMatchObject({ status: 'cancelled', version: 3 })
  expect(db.get<{ n: number }>("SELECT count(*) AS n FROM consumed_origin WHERE id = 'b'")!.n).toBe(1)
})

it('inserts effects with keys made from the job, origin and position, and arms, replaces and cancels timers', () => {
  const { engine, db } = counterKernel()
  engine.create('j1', manifest(), { kind: 'post', text: 'hello', conversation: 'mm:1' }, { kind: 'timer', id: 'c' })
  expect(db.all('SELECT kind, idempotency_key, ordering_key, payload, status FROM effect ORDER BY seq')).toEqual([
    { kind: 'post', idempotency_key: 'j1:timer:c:0', ordering_key: 'mm:1', payload: '{"text":"hello"}', status: 'pending' }])
  engine.submit('j1', { kind: 'remind', at: 1000 }, { kind: 'timer', id: 'r1' })
  engine.submit('j1', { kind: 'remind', at: 2000 }, { kind: 'timer', id: 'r2' })
  expect(db.all("SELECT due_at, status FROM timer ORDER BY due_at")).toEqual([{ due_at: 1000, status: 'cancelled' }, { due_at: 2000, status: 'armed' }])
  engine.submit('j1', { kind: 'close' }, { kind: 'timer', id: 'z' })
  expect(db.all("SELECT status FROM timer WHERE status = 'armed'")).toEqual([])
})

it('commits the work passed as `within` with the decision, rolls it back with it, and keeps it when the decision faults', () => {
  const { engine, db } = counterKernel()
  engine.create('j1', manifest(), { kind: 'add', by: 1 }, { kind: 'timer', id: 'c' })
  engine.submit('j1', { kind: 'add', by: 1 }, { kind: 'timer', id: 'w1' }, () => { db.run("INSERT INTO kv VALUES ('w1', 'x')") })
  engine.submit('j1', { kind: 'boom' }, { kind: 'timer', id: 'w2' }, () => { db.run("INSERT INTO kv VALUES ('w2', 'x')") })
  expect(() => engine.submit('j1', { kind: 'add', by: 1 }, { kind: 'inbox', id: 'not-appended' }, () => { db.run("INSERT INTO kv VALUES ('w3', 'x')") }))
    .toThrow(/No inbox event/)
  expect(db.all('SELECT key FROM kv ORDER BY key')).toEqual([{ key: 'w1' }, { key: 'w2' }])
  expect(engine.job('j1')!.state.n).toBe(2)
})

it('applies projections in the decision\'s transaction, rebuilds them from job events, and faults the job when one throws', () => {
  const { engine, db, projections } = counterKernel()
  engine.create('j1', manifest(), { kind: 'add', by: 2 }, { kind: 'timer', id: 'a' })
  engine.create('j2', manifest(), { kind: 'add', by: 5 }, { kind: 'timer', id: 'b' })
  engine.submit('j1', { kind: 'add', by: 3 }, { kind: 'timer', id: 'c' })
  const view = () => db.all('SELECT job_id, n FROM counter_view ORDER BY job_id')
  expect(view()).toEqual([{ job_id: 'j1', n: 5 }, { job_id: 'j2', n: 5 }])
  db.run('UPDATE counter_view SET n = 0')
  projections.rebuild('counter_view')
  expect(view()).toEqual([{ job_id: 'j1', n: 5 }, { job_id: 'j2', n: 5 }])
  projections.register({ name: 'broken', tables: [], apply: () => { throw new Error('projection bug') } })
  expect(engine.submit('j1', { kind: 'add', by: 1 }, { kind: 'timer', id: 'd' }).outcome).toMatchObject({ kind: 'faulted', error: 'projection bug' })
  expect(view()).toEqual([{ job_id: 'j1', n: 5 }, { job_id: 'j2', n: 5 }])
})

it('keeps a run manifest immutable and stores blobs once per digest', () => {
  const { engine, db } = counterKernel()
  engine.create('j1', manifest('m1'), { kind: 'add', by: 1 }, { kind: 'timer', id: 'a' })
  engine.create('j2', manifest('m1'), { kind: 'add', by: 1 }, { kind: 'timer', id: 'b' })
  expect(() => engine.create('j3', manifest('m1', { stages: ['changed'] }), { kind: 'add', by: 1 }, { kind: 'timer', id: 'c' })).toThrow(/immutable/)
  expect(engine.job('j3')).toBeUndefined()
  const blobs = new Blobs(db)
  const digest = blobs.put('artifact text')
  expect(blobs.put('artifact text')).toBe(digest)
  expect(digest).toMatch(/^[0-9a-f]{64}$/)
  expect(blobs.text(digest)).toBe('artifact text')
  expect(db.get<{ n: number }>('SELECT count(*) AS n FROM blob')!.n).toBe(1)
})
