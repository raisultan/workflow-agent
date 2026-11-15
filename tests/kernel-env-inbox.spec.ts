/** The kernel environment (`T7.3`) and the durable inbox (`T7.4`). */
import { expect, it } from 'vitest'
import { KernelDb } from '../src/kernel/db.ts'
import { TestClock, seededRandom, sortableIds, testEnv } from '../src/kernel/env.ts'
import { Inbox } from '../src/kernel/inbox.ts'

it('makes ids that sort in creation order, within a millisecond and when the clock is set back', () => {
  const clock = new TestClock(Date.UTC(2026, 10, 11))
  const ids = sortableIds(clock, seededRandom(7))
  const made = [ids.next('j_'), ids.next('j_')]
  clock.advance(5); made.push(ids.next('j_'))
  clock.advance(-60_000); made.push(ids.next('j_'))
  expect(new Set(made).size).toBe(made.length)
  expect([...made].sort()).toEqual(made)
  expect(made.every(id => /^j_[0-9a-z]{19}$/.test(id))).toBe(true)
})

it('repeats a seeded sequence in [0, 1)', () => {
  const a = seededRandom(42), b = seededRandom(42)
  const first = Array.from({ length: 50 }, () => a.next())
  expect(Array.from({ length: 50 }, () => b.next())).toEqual(first)
  expect(first.every(value => value >= 0 && value < 1)).toBe(true)
  expect(new Set(first).size).toBe(50)
})

const setup = () => { const env = testEnv(); const db = KernelDb.open(':memory:'); return { env, db, inbox: new Inbox(db, env) } }
const event = (externalId: string, text = externalId) => ({ source: 'mattermost', externalId, threadKey: 'mm:ch:root', human: true,
  actor: { source: 'mattermost', id: 'u1' }, occurredAt: 1, payload: { text } })

it('appends an event once per source and external id, keeping the first copy', () => {
  const { inbox } = setup()
  const first = inbox.append(event('p1', 'first'))
  expect(first.duplicate).toBe(false)
  const again = inbox.append(event('p1', 'changed on redelivery'))
  expect(again).toEqual({ event: first.event, duplicate: true })
  expect(again.event.payload).toEqual({ text: 'first' })
  // The same external id from another source is another event.
  expect(inbox.append({ ...event('p1'), source: 'jira' }).duplicate).toBe(false)
})

it('lists received events in arrival order and settles each exactly once, only inside a transaction', () => {
  const { env, db, inbox } = setup()
  const ids = ['a', 'b', 'c'].map((name, index) => { env.clock.advance(index === 2 ? 0 : 10); return inbox.append(event(name)).event.id })
  expect(inbox.received().map(item => item.id)).toEqual(ids)
  expect(() => inbox.settle(ids[0]!, 'routed', { job: 'j1' })).toThrow(/inside a kernel transaction/)
  expect(db.tx(() => inbox.settle(ids[0]!, 'routed', { job: 'j1' }))).toBe(true)
  expect(db.tx(() => inbox.settle(ids[0]!, 'ignored', { reason: 'late' }))).toBe(false)
  expect(inbox.get(ids[0]!)).toMatchObject({ status: 'routed', outcome: { job: 'j1' } })
  expect(inbox.received().map(item => item.id)).toEqual(ids.slice(1))
  // A settle that rolls back leaves the event waiting.
  expect(() => db.tx(() => { inbox.settle(ids[1]!, 'ignored', {}); throw new Error('crash') })).toThrow('crash')
  expect(inbox.received().map(item => item.id)).toEqual(ids.slice(1))
  expect(() => db.tx(() => inbox.settle('missing', 'ignored', {}))).toThrow(/No inbox event/)
})

it('refuses an event that is not well formed', () => {
  const { inbox } = setup()
  expect(() => inbox.append({ ...event('x'), externalId: '' })).toThrow()
  expect(() => inbox.append({ ...event('x'), extra: 1 } as never)).toThrow()
})
