/**
 * The job's threads at start (`D12`, `T14.2`): a job started in Jira or by a direct message opens a thread in its repository's
 * Mattermost channel for its questions, and its first attempt waits for it; a job started in a channel thread keeps it. A ticket key
 * in the trigger is linked at the start, and a trigger outside Jira must name one. A repository with no channel cannot take a job
 * started in Jira or by a direct message.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Actor } from '../src/domain/policy.ts'
import { renderNotice } from '../src/adapters/messages.ts'
import { firstMessage } from '../src/adapters/stage-runner.ts'
import { ticketIn } from '../src/domain/router.ts'
import { ANNA, basePolicy, delivery, EVE, Harness, THREAD } from './fixtures/domain-workflow.ts'

const JIRA_ANNA: Actor = { source: 'jira', id: 'anna' }
const workflow = () => delivery(1, declaration => {
  declaration.repository = true
  declaration.places = { clarification: 'chat', plan: 'ticket', code: 'mergeRequest' }
})
const REPOSITORY = { name: 'app', project: 'group/app', testCommand: 'npm test', default: true, match: { mattermost: ['chrepo'] } }

let h: Harness
afterEach(() => { h.cleanup() })

function harness(repository: Record<string, unknown> = REPOSITORY): Harness {
  const harness = new Harness({ workflows: [workflow()], repositories: [repository as never] })
  harness.policy = { ...basePolicy(), senders: { mattermost: ['anna', 'lead'], jira: ['anna'] } }
  return harness
}

async function startAs(actor: Actor, text: string, thread: string, addressed: 'mention' | 'direct' = 'mention'): Promise<string> {
  const handled = await h.say(actor, text, { thread, addressed })
  if (handled.route.kind !== 'newJob' || handled.submitted?.outcome.kind !== 'decided') throw new Error(`no job: ${JSON.stringify(handled.route)}`)
  return handled.submitted.outcome.jobId
}

const posts = (kind: string) => h.posts.filter(post => post.message.kind === kind)

describe('the job\'s threads at start (D12)', () => {
  it('opens a thread in the repository\'s channel for a job started in Jira, and asks its questions there', async () => {
    h = harness()
    const job = await startAs(JIRA_ANNA, '@workbench do it', 'jira:ORD-3')
    expect(posts('started')).toEqual([expect.objectContaining({ threadKey: 'jira:ORD-3', message: expect.objectContaining({ chatIn: 'app' }) })])
    const chat = posts('chat')
    expect(chat).toEqual([expect.objectContaining({ threadKey: 'mattermost:chrepo:', message: expect.objectContaining({ ticket: 'ORD-3', requester: JIRA_ANNA }) })])
    const thread = h.state(job).chatThread!
    expect(thread).toMatch(/^mattermost:chrepo:post-\d+$/u)
    expect(h.state(job).bindings).toContainEqual({ threadKey: thread, role: 'origin' })
    expect(h.state(job).attempt?.stageId).toBe('inspect')
    // Its request is only "@workbench do it": each stage is told which ticket is the job's (the code may name others).
    const attempt = h.state(job).attempt!
    expect(firstMessage(h.state(job), h.running.get(attempt.id)!.payload, 'Inspect', () => undefined))
      .toContain('# Ticket\nORD-3 is this job\'s Jira issue')

    await h.report(job, { outcome: 'question', items: [{ text: 'TTL?' }] })
    expect(h.gate(job)).toMatchObject({ kind: 'question', threadKey: thread })
    // Anyone in the thread may answer (D12): Eve is neither a sender nor an approver.
    await h.say(EVE, 'one hour', { thread })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'inspect', entry: 'answer' })
  })

  it('moves a job started by a direct message to the repository\'s channel', async () => {
    h = harness()
    const job = await startAs(ANNA, 'do ORD-4', 'mattermost:dm1:p9', 'direct')
    expect(posts('chat')).toEqual([expect.objectContaining({ threadKey: 'mattermost:chrepo:' })])
    await h.report(job, { outcome: 'question', items: [{ text: 'TTL?' }] })
    expect(h.gate(job)!.threadKey).toBe(h.state(job).chatThread)
  })

  it('keeps a channel thread, and links the ticket its trigger names', async () => {
    h = harness()
    const job = await startAs(ANNA, '@workbench сделай ORD-5, пожалуйста', THREAD)
    expect(posts('chat')).toEqual([])
    expect(h.actions).toContainEqual(expect.objectContaining({ action: 'jira.link', payload: { issueKey: 'ORD-5' } }))
    expect(h.state(job).bindings).toContainEqual({ threadKey: 'jira:ORD-5', role: 'artifact' })
    await h.report(job, { outcome: 'question', items: [{ text: 'TTL?' }] })
    expect(h.gate(job)!.threadKey).toBe(THREAD)
  })

  it('refuses a job started in Jira when the repository has no channel', async () => {
    h = harness({ ...REPOSITORY, match: { mattermost: [] } })
    const handled = await h.say(JIRA_ANNA, '@workbench do it', { thread: 'jira:ORD-6', addressed: 'mention' })
    expect(handled.route).toMatchObject({ kind: 'notice', notice: { kind: 'no_chat_channel', repository: 'app' } })
    // A channel thread still starts one.
    await startAs(ANNA, '@workbench do ORD-7', THREAD)
  })

  it('refuses a job whose trigger outside Jira names no ticket: the plan lives in the ticket (owner\'s choice, 2026-11-13)', async () => {
    h = harness()
    for (const [text, thread, addressed] of [['@workbench do it', THREAD, 'mention'], ['do it please', 'mattermost:dm1:p9', 'direct']] as const) {
      const handled = await h.say(ANNA, text, { thread, addressed })
      expect(handled.route).toMatchObject({ kind: 'notice', threadKey: thread, notice: { kind: 'no_ticket' }, reason: 'the trigger names no Jira ticket for the plan' })
    }
    expect(h.notices.map(notice => notice.notice.kind)).toEqual(['no_ticket', 'no_ticket'])
    // It says the job did not start; with no Jira project mapped, the example's key is a neutral one.
    expect(renderNotice({ kind: 'no_ticket' }, 'ru', 1000)).toBe('⚠️ Не начал работу: нужна задача Jira — в ней живут план и его одобрение.\n\n'
      + '👉 Назовите задачу, например «@workbench сделай ABC-123», или упомяните меня в самой задаче.')
    expect(renderNotice({ kind: 'no_ticket' }, 'en', 1000, 'devbot')).toContain('"@devbot do ABC-123"')
    // A lower-case key is no key; the same thread starts a job once a trigger names one.
    expect((await h.say(ANNA, '@workbench do ord-8', { thread: THREAD, addressed: 'mention' })).route).toMatchObject({ notice: { kind: 'no_ticket' } })
    await startAs(ANNA, '@workbench do ORD-8', THREAD)
  })

  it('takes only a key of the repository\'s Jira projects for the ticket, when it maps any', async () => {
    h = harness({ ...REPOSITORY, match: { mattermost: ['chrepo'], jira: ['ORD'] } })
    const handled = await h.say(ANNA, '@workbench почини UTF-8 в PAY-1', { thread: THREAD, addressed: 'mention' })
    expect(handled.route).toMatchObject({ kind: 'notice', notice: { kind: 'no_ticket', projects: ['ORD'] } })
    // The reply names the projects that count, and its example is a key of the repository's project, with the bot's own name.
    const reply = renderNotice({ kind: 'no_ticket', projects: ['ORD'] }, 'ru', 1000, 'devbot')
    expect(reply).toContain('\nПодходят задачи проекта ORD.\n')
    expect(reply).toContain('«@devbot сделай ORD-123»')
    expect(renderNotice({ kind: 'no_ticket', projects: ['ORD', 'PAY'] }, 'en', 1000)).toContain('\nIssues of projects ORD, PAY count.\n')
    const job = await startAs(ANNA, '@workbench как в PAY-1, сделай ORD-9', THREAD)
    expect(h.actions).toContainEqual(expect.objectContaining({ action: 'jira.link', payload: { issueKey: 'ORD-9' } }))
    expect(h.state(job).bindings).toContainEqual({ threadKey: 'jira:ORD-9', role: 'artifact' })
  })

  it('fails a job whose ticket cannot be linked, rather than planning outside Jira', async () => {
    h = harness()
    h.missingIssues.add('ORD-404')
    const job = await startAs(ANNA, '@workbench сделай ORD-404', THREAD)
    expect(h.status(job)).toBe('failed')
    expect(h.state(job).status).toMatchObject({ kind: 'failed', reason: expect.stringContaining('the ticket ORD-404 could not be linked') })
  })

  it('finds the first issue key in a trigger', () => {
    expect(ticketIn('see PAY-1 and ORD-2', ['ORD'])).toBe('ORD-2')
    expect(ticketIn('UTF-8', ['ORD'])).toBeUndefined()
    expect(ticketIn('UTF-8', ['*'])).toBe('UTF-8')
    expect(ticketIn('@workbench сделай ORD-300')).toBe('ORD-300')
    expect(ticketIn('see ORD-1 and ORD-2')).toBe('ORD-1')
    expect(ticketIn('xORD-1 or ord-2 or ORD-x')).toBeUndefined()
  })
})
