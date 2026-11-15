/**
 * Places (`D12`, `T14.1`): a workflow that declares where each kind of conversation happens opens its question and resume gates on
 * the job's chat thread, its plan approval on the job's ticket, and posts its outcome on the chat thread; a place the job has no
 * thread for falls back to the chat thread, then to the trigger's thread. Without places, every gate stays on the trigger's thread.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Actor } from '../src/domain/policy.ts'
import { ANNA, delivery, Harness, LEAD, THREAD } from './fixtures/domain-workflow.ts'

const TICKET = 'jira:ORD-1'
const JIRA_LEAD: Actor = { source: 'jira', id: 'lead' }
const placed = () => delivery(1, declaration => {
  declaration.places = { clarification: 'chat', plan: 'ticket', code: 'mergeRequest' }
  declaration.stages[0]!.tools = ['jira.link']
})

let h: Harness
afterEach(() => { h.cleanup() })

function harness(): Harness {
  const harness = new Harness({ workflows: [placed()] })
  harness.policy = { ...harness.policy, approvers: { delivery: { mattermost: ['lead'], jira: ['lead'] } } }
  return harness
}

/** Starts a job, links its ticket from inspect, and drives it to a posted plan approval. */
async function toApproval(link = true): Promise<string> {
  const job = await h.start()
  if (link) {
    expect(h.wb.action(job, h.attempt(job), { session: 's', id: 'link' }, 'jira.link', { issueKey: 'ORD-1' }).outcome.kind).toBe('decided')
    await h.settle()
  }
  await h.complete(job, { findings: 'ok' })
  await h.complete(job, {}, 'Plan r1')
  return job
}

const postsOf = (kind: string) => h.posts.filter(post => post.message.kind === kind).map(post => post.threadKey)

describe('places (D12)', () => {
  it('asks questions on the chat thread and puts the plan approval on the ticket', async () => {
    h = harness()
    const job = await h.start()
    h.wb.action(job, h.attempt(job), { session: 's', id: 'link' }, 'jira.link', { issueKey: 'ORD-1' })
    await h.settle()
    await h.report(job, { outcome: 'question', items: [{ text: 'TTL?' }] })
    expect(h.gate(job)).toMatchObject({ kind: 'question', threadKey: THREAD })
    await h.say(ANNA, 'one hour')
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, {}, 'Plan r1')
    expect(h.gate(job)).toMatchObject({ kind: 'approval', threadKey: TICKET })
    expect(postsOf('approval')).toEqual([TICKET])
    // The chat thread gets one line pointing to the ticket (T14.6).
    expect(h.posts.filter(post => post.message.kind === 'planPosted')).toEqual([expect.objectContaining({ threadKey: THREAD,
      message: expect.objectContaining({ ticket: 'ORD-1', subject: expect.objectContaining({ n: 1 }) }) })])
  })

  it('approves only on the ticket: an "ok" in the chat thread is a follow-up, not an approval', async () => {
    h = harness()
    const job = await toApproval()
    await h.say(LEAD, 'ok')
    expect(h.status(job)).toBe('awaiting_gate')
    await h.say(JIRA_LEAD, 'ok', { thread: TICKET })
    expect(h.state(job).attempt!.stageId).toBe('implement')
    expect(postsOf('approved')).toEqual([TICKET])
  })

  it('keeps the plan in the chat thread when the job has no ticket', async () => {
    h = harness()
    const job = await toApproval(false)
    expect(h.gate(job)).toMatchObject({ kind: 'approval', threadKey: THREAD })
  })

  it('posts the outcome and a blocked job\'s resume gate on the chat thread', async () => {
    h = harness()
    await toApproval()
    await h.say(JIRA_LEAD, 'ok', { thread: TICKET })
    await h.say(LEAD, 'stop')
    expect(postsOf('cancelled')).toEqual([THREAD])

    const second = await h.start('@workbench another', 'mattermost:ch1:p2')
    h.wb.action(second, h.attempt(second), { session: 's', id: 'link' }, 'jira.link', { issueKey: 'ORD-2' })
    await h.settle()
    await h.report(second, { outcome: 'blocked', reason: 'no access' })
    expect(h.gate(second)).toMatchObject({ kind: 'resume', threadKey: 'mattermost:ch1:p2' })
  })

  it('falls back to the trigger\'s thread for a job started in Jira (until it has a chat thread)', async () => {
    h = harness()
    const job = await h.start('@workbench do ORD-3', 'jira:ORD-3')
    await h.report(job, { outcome: 'question', items: [{ text: 'TTL?' }] })
    expect(h.gate(job)).toMatchObject({ kind: 'question', threadKey: 'jira:ORD-3' })
  })

  it('leaves a workflow without places on the trigger\'s thread', async () => {
    h = new Harness()
    h.policy = { ...h.policy, approvers: { delivery: { mattermost: ['lead'], jira: ['lead'] } } }
    const job = await h.start()
    h.wb.action(job, h.attempt(job), { session: 's', id: 'link' }, 'jira.link', { issueKey: 'ORD-1' })
    await h.settle()
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, {}, 'Plan r1')
    expect(h.gate(job)).toMatchObject({ kind: 'approval', threadKey: THREAD })
  })
})
