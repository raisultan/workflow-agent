/**
 * Question rounds read item by item (`D12`, `T14.4`): a reply answers some items, from anyone in the thread; the workbench says what
 * this reply changed and what is open, asks a person named in a redirect, says when it could not read a reply (and nothing to talk
 * unrelated to the questions), and closes the round only when every item has an answer, passing each answer on with who gave it and
 * which answer a later one replaced.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ANSWER_MARKS, ANSWER_MARKS_BY_LOCALE, firstMessage } from '../src/adapters/stage-runner.ts'
import type { Actor } from '../src/domain/policy.ts'
import { ANNA, delivery, EVE, Harness, LEAD, THREAD } from './fixtures/domain-workflow.ts'

const BOB: Actor = { source: 'mattermost', id: 'bob' }
const placed = () => delivery(1, declaration => { declaration.places = { clarification: 'chat', plan: 'ticket', code: 'mergeRequest' } })

let h: Harness
afterEach(() => { h.cleanup() })

async function round(): Promise<string> {
  h = new Harness({ workflows: [placed()] })
  const job = await h.start()
  await h.report(job, { outcome: 'question', items: [{ text: 'Store?' }, { text: 'TTL?' }, { text: 'Limit?' }] })
  return job
}
const recorded = () => h.outbound('answersRecorded')

describe('question rounds (D12)', () => {
  it('records partial answers from several people and closes when every item has one', async () => {
    const job = await round()
    h.readings.set('1: redis; ask @bob about 3', { answers: [{ item: 1, text: 'redis' }], redirects: [{ item: 3, to: '@bob' }] })
    h.readings.set('ttl is one hour', { answers: [{ item: 2, text: 'one hour' }] })
    h.readings.set('limit: не знаю, решай сам', { answers: [{ item: 3, text: 'решение за исполнителем' }] })

    await h.say(ANNA, '1: redis; ask @bob about 3')
    expect(h.status(job)).toBe('awaiting_gate')
    expect(recorded().at(-1)).toMatchObject({ answered: [1], remaining: [2, 3], redirects: [{ item: 3, to: 'bob', text: 'Limit?' }] })
    await h.say(EVE, 'ttl is one hour')
    // Each post says what that reply changed, not what was accepted before (trial finding 2).
    expect(recorded().at(-1)).toMatchObject({ answered: [2], remaining: [3], redirects: [] })
    // The reading of each reply sees what earlier ones answered, and whom a question was redirected to (so Bob's unnumbered reply
    // can be read as about item 3).
    expect(h.reads.at(-1)!.items.map(item => item.answered)).toEqual([true, false, false])
    expect(h.reads.at(-1)!.items.map(item => item.askedOf)).toEqual([undefined, undefined, ['bob']])
    await h.say(BOB, 'limit: не знаю, решай сам')
    expect(recorded().at(-1)).toMatchObject({ answered: [3], remaining: [] })

    const attempt = h.state(job).attempt!
    expect(attempt).toMatchObject({ stageId: 'inspect', entry: 'answer' })
    const input = h.running.get(attempt.id)!.payload.inputs.find(candidate => candidate.kind === 'answers')!
    expect(input.answers).toEqual([{ item: 1, text: 'redis', by: ANNA }, { item: 2, text: 'one hour', by: EVE }, { item: 3, text: 'решение за исполнителем', by: BOB }])
    const message = firstMessage(h.state(job), h.running.get(attempt.id)!.payload, 'Inspect', () => undefined, actor => `@${actor.id}`)
    expect(message).toContain('2. TTL?\n   — one hour (@eve)\n3.')
    // Without a name function a person is still `@id`, never `source:id` (trial finding 10).
    expect(firstMessage(h.state(job), h.running.get(attempt.id)!.payload, 'Inspect', () => undefined)).toContain('— redis (@anna)')
  })

  it('a reply that only redirects says whom the question went to and what is still awaited', async () => {
    await round()
    h.readings.set('2: one hour', { answers: [{ item: 2, text: 'one hour' }] })
    h.readings.set('про 1 спросите @bob', { answers: [], redirects: [{ item: 1, to: 'bob' }] })
    await h.say(ANNA, '2: one hour')
    await h.say(EVE, 'про 1 спросите @bob')
    expect(recorded().at(-1)).toMatchObject({ answered: [], remaining: [1, 3], redirects: [{ item: 1, to: 'bob', text: 'Store?' }] })
  })

  it('marks an answer its author corrected as replaced, and keeps the answers of different people', async () => {
    const job = await round()
    h.readings.set('2: да, стандартной 422 хватит', { answers: [{ item: 2, text: 'стандартной 422 хватит' }] })
    h.readings.set('поправка ко 2: лучше свой код ошибки', { answers: [{ item: 2, text: 'свой код ошибки' }] })
    h.readings.set('1: redis', { answers: [{ item: 1, text: 'redis' }] })
    h.readings.set('1: sql; 3: 100', { answers: [{ item: 1, text: 'sql' }, { item: 3, text: '100' }] })
    await h.say(ANNA, '2: да, стандартной 422 хватит')
    await h.say(ANNA, 'поправка ко 2: лучше свой код ошибки')
    expect(recorded().at(-1)).toMatchObject({ answered: [2], remaining: [1, 3] })
    await h.say(ANNA, '1: redis')
    await h.say(BOB, '1: sql; 3: 100')
    const attempt = h.state(job).attempt!
    const message = firstMessage(h.state(job), h.running.get(attempt.id)!.payload, 'Inspect', () => undefined)
    expect(message).toContain(`2. TTL?\n   — стандартной 422 хватит (@anna) ${ANSWER_MARKS.replaced}\n   — свой код ошибки (@anna) ${ANSWER_MARKS.current}\n3.`)
    expect(message).toContain(`1. Store?\n   — redis (@anna)\n   — sql (@bob)\n   ${ANSWER_MARKS.several}\n2.`)
    expect(message).toContain('3. Limit?\n   — 100 (@bob)\n')
    // An English job (D14) gets the marks its English prompts name.
    const english = firstMessage(h.state(job), h.running.get(attempt.id)!.payload, 'Inspect', () => undefined, undefined, 'en')
    expect(english).toContain(`— свой код ошибки (@anna) ${ANSWER_MARKS_BY_LOCALE.en.current}\n3.`)
    expect(english).toContain(`   ${ANSWER_MARKS_BY_LOCALE.en.several}\n2.`)
  })

  it('posts nothing about talk unrelated to the questions, and records nothing', async () => {
    const job = await round()
    h.readings.set('кстати, кто-нибудь видел, почему упал ночной билд?', { answers: [], redirects: [], unrelated: true })
    const before = h.posts.length
    await h.say(EVE, 'кстати, кто-нибудь видел, почему упал ночной билд?')
    expect(h.posts).toHaveLength(before)
    expect(h.status(job)).toBe('awaiting_gate')
    expect(h.gate(job)).toMatchObject({ interpreting: [] })
    expect(h.gate(job)!.answers).toBeUndefined()
    expect(h.gate(job)!.responses.at(-1)).toMatchObject({ accepted: false, reason: 'unrelated to the questions' })
    // A reading that claims both is an answer: what it answers is recorded.
    h.readings.set('1: redis, а билд кто чинит?', { answers: [{ item: 1, text: 'redis' }], unrelated: true })
    await h.say(EVE, '1: redis, а билд кто чинит?')
    expect(recorded().at(-1)).toMatchObject({ answered: [1], remaining: [2, 3] })
  })

  it('redirects only to someone the reply mentions, never to a ticket key the reading took for a person', async () => {
    const job = await round()
    h.readings.set('2: не трогаем, это ORD-201; про 3 спросите @bob', { answers: [{ item: 1, text: 'redis' }],
      redirects: [{ item: 2, to: 'ORD-201' }, { item: 3, to: 'bob' }] })
    await h.say(ANNA, '2: не трогаем, это ORD-201; про 3 спросите @bob')
    expect(h.status(job)).toBe('awaiting_gate')
    expect(recorded().at(-1)).toMatchObject({ answered: [1], remaining: [2, 3] })
    expect(recorded().at(-1)).toHaveProperty('redirects', [expect.objectContaining({ item: 3, to: 'bob' })])
  })

  it('says when it could not read a reply, and keeps the round open', async () => {
    const job = await round()
    h.readings.set('hmm', { answers: [], redirects: [] })
    h.readings.set('later', 'unavailable')
    await h.say(ANNA, 'hmm')
    await h.say(LEAD, 'later')
    expect(h.outbound('unread')).toHaveLength(2)
    expect(h.status(job)).toBe('awaiting_gate')
    expect(h.gate(job)!.responses.map(response => response.reason)).toEqual(['it answered no item', 'no reading: model unavailable'])
  })

  it('takes a question back without recording an answer', async () => {
    const job = await round()
    h.readings.set('what do you mean by limit?', { answers: [], redirects: [], question: 'what do you mean by limit?' })
    await h.say(ANNA, 'what do you mean by limit?')
    expect(h.outbound('unread')).toHaveLength(0)
    expect(h.gate(job)!.responses.at(-1)).toMatchObject({ accepted: false, reason: 'a question back' })
    expect(h.gate(job)!.answers).toBeUndefined()
  })

  it('keeps the old single-reply rounds for a workflow without places', async () => {
    h = new Harness()
    const job = await h.start()
    await h.report(job, { outcome: 'question', items: [{ text: 'Store?' }, { text: 'TTL?' }] })
    await h.say(ANNA, 'redis')
    expect(h.reads).toHaveLength(0)
    expect(h.state(job).attempt).toMatchObject({ entry: 'answer' })
    expect(h.posts.filter(post => post.threadKey === THREAD).map(post => post.message.kind)).toEqual(['started', 'question'])
  })
})
