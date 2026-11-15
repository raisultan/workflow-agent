/**
 * Answer turns and merge request conversations (`D12`, `T14.5`, `T14.7`): a question to the workbench, on a question round, on the
 * plan in its ticket, in its chat thread or on its merge request, gets an answer where it was asked, without moving the job; a change
 * request on the merge request is never steered into implement, and one kept until implement completes reopens review.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Actor } from '../src/domain/policy.ts'
import { ANNA, delivery, Harness, LEAD, THREAD } from './fixtures/domain-workflow.ts'

const TICKET = 'jira:ORD-1'
const MR = 'gitlab:group/app!1'
const JIRA_LEAD: Actor = { source: 'jira', id: 'lead' }
const REVIEWER: Actor = { source: 'gitlab', id: 'lead' }
const placed = () => delivery(1, declaration => {
  declaration.places = { clarification: 'chat', plan: 'ticket', code: 'mergeRequest' }
  declaration.stages[0]!.tools = ['jira.link']
  // As in standard-delivery: implement completes the job, and merge request feedback reopens it at review.
  declaration.transitions = declaration.transitions.map(transition => transition.from === 'implement' ? { from: 'implement', to: '$complete' } : transition)
})

let h: Harness
afterEach(() => { h.cleanup() })

async function start(): Promise<string> {
  h = new Harness({ workflows: [placed()] })
  h.policy = { ...h.policy, approvers: { delivery: { mattermost: ['lead'], jira: ['lead'], gitlab: ['lead'] } } }
  const job = await h.start()
  h.wb.action(job, h.attempt(job), { session: 's', id: 'link' }, 'jira.link', { issueKey: 'ORD-1' })
  await h.settle()
  return job
}
async function toImplement(job: string): Promise<void> {
  await h.complete(job, { findings: 'ok' })
  await h.complete(job, {}, 'Plan r1')
  await h.say(JIRA_LEAD, 'ok', { thread: TICKET })
  h.wb.action(job, h.attempt(job), { session: 's', id: 'mr' }, 'gitlab.createMr', {})
  await h.settle()
}
const answersOn = (thread: string) => h.posts.filter(post => post.threadKey === thread && post.message.kind === 'answer').map(post => (post.message as { text: string }).text)

describe('answer turns (D12)', () => {
  it('answers a question back on a round in the thread, keeping the round open, and counts its tokens', async () => {
    const job = await start()
    await h.report(job, { outcome: 'question', items: [{ text: 'TTL?' }] })
    const tokens = h.state(job).usage.tokens
    h.readings.set('what TTL do you mean?', { answers: [], redirects: [], question: 'what TTL do you mean?' })
    await h.say(ANNA, 'what TTL do you mean?')
    expect(answersOn(THREAD)).toEqual(['Ответ: what TTL do you mean?'])
    expect(h.status(job)).toBe('awaiting_gate')
    expect(h.state(job).usage.tokens).toBe(tokens + 100)
    expect(h.answers.at(-1)).toMatchObject({ threadKey: THREAD, question: 'what TTL do you mean?', model: 'deepseek-verdict' })
  })

  it('answers a question about the plan in the ticket, in the asker\'s own words, with no new revision', async () => {
    const job = await start()
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, {}, 'Plan r1')
    h.verdicts.set('why redis?', { verdict: 'question', notes: 'Asks why Redis was chosen.', confidence: 0.95 })
    await h.say(JIRA_LEAD, 'why redis?', { thread: TICKET })
    expect(answersOn(TICKET)).toEqual(['Ответ: why redis?'])
    expect(h.answers.at(-1)).toMatchObject({ threadKey: TICKET, question: 'why redis?' })
    expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open', subject: { n: 1 } })
    expect(h.running.size).toBe(0)
    await h.say(JIRA_LEAD, 'ok', { thread: TICKET })
    expect(h.state(job).attempt!.stageId).toBe('implement')
  })

  it('answers a question in the chat thread instead of steering the attempt with it', async () => {
    const job = await start()
    h.followUps.set('why do you read the cache module?', 'question')
    await h.say(ANNA, 'why do you read the cache module?')
    expect(answersOn(THREAD)).toEqual(['Ответ: why do you read the cache module?'])
    expect(h.steers).toEqual([])
    await h.say(ANNA, 'also look at logout')
    expect(h.steers).toEqual([expect.objectContaining({ attemptId: h.attempt(job), text: 'also look at logout' })])
  })

  it('says so when it could not answer, and takes an unreadable follow-up as a follow-up', async () => {
    const job = await start()
    h.followUps.set('why?', 'question')
    h.answerFails = true
    await h.say(ANNA, 'why?')
    expect(h.posts.filter(post => post.message.kind === 'answerFailed').map(post => post.threadKey)).toEqual([THREAD])
    h.followUps.set('hm', 'unavailable')
    await h.say(ANNA, 'hm')
    expect(h.steers).toEqual([expect.objectContaining({ attemptId: h.attempt(job), text: 'hm' })])
  })
})

describe('merge request conversations (D12)', () => {
  it('answers a question on the merge request while implement runs, and keeps a change request for review', async () => {
    const job = await start()
    await toImplement(job)
    h.followUps.set('why a new table?', 'question')
    await h.say(REVIEWER, 'why a new table?', { thread: MR, source: 'gitlab' })
    expect(answersOn(MR)).toEqual(['Ответ: why a new table?'])
    await h.say(REVIEWER, 'rename the column to ttl_ms', { thread: MR, source: 'gitlab' })
    expect(h.steers).toEqual([])
    // Implement completes, but the kept change request reopens the job at review instead (re-check item 7).
    await h.complete(job)
    expect(h.status(job)).toBe('running')
    expect(h.state(job).attempt).toMatchObject({ stageId: 'review', entry: 'reopen' })
    expect(h.running.get(h.attempt(job))!.payload.inputs).toEqual([
      expect.objectContaining({ kind: 'follow_up', text: 'rename the column to ttl_ms', thread: MR })])
    // In review, a comment on the merge request steers the attempt.
    await h.say(REVIEWER, 'and add an index', { thread: MR, source: 'gitlab' })
    expect(h.steers).toEqual([expect.objectContaining({ text: 'and add an index' })])
  })

  it('keeps a change request for review across a retry of implement after a red check', async () => {
    const job = await start()
    await toImplement(job)
    await h.say(REVIEWER, 'rename the column to ttl_ms', { thread: MR, source: 'gitlab' })
    h.checks.set('tests', false)
    await h.complete(job)
    expect(h.state(job).attempt).toMatchObject({ stageId: 'implement', entry: 'retry' })
    expect(h.running.get(h.attempt(job))!.payload.inputs).not.toContainEqual(expect.objectContaining({ kind: 'follow_up' }))
    h.checks.set('tests', true)
    await h.complete(job)
    expect(h.state(job).attempt).toMatchObject({ stageId: 'review', entry: 'reopen' })
    expect(h.running.get(h.attempt(job))!.payload.inputs).toEqual([
      expect.objectContaining({ kind: 'follow_up', text: 'rename the column to ttl_ms', thread: MR })])
  })

  it('takes no feedback on a completed job\'s ticket: only its merge request reopens it', async () => {
    const job = await start()
    await toImplement(job)
    await h.complete(job)
    const handled = await h.say(JIRA_LEAD, 'спасибо', { thread: TICKET })
    expect(handled.route).toMatchObject({ kind: 'ignore', reason: 'not addressed to the workbench' })
    expect(h.status(job)).toBe('completed')
  })

  it('answers a question about the plan from someone who may not approve, and takes nothing else they say there (A24)', async () => {
    const job = await start()
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, {}, 'Plan r1')
    const JIRA_ANNA: Actor = { source: 'jira', id: 'anna' }
    h.followUps.set('why redis?', 'question')
    await h.say(JIRA_ANNA, 'why redis?', { thread: TICKET })
    expect(answersOn(TICKET)).toEqual(['Ответ: why redis?'])
    await h.say(JIRA_ANNA, 'ok', { thread: TICKET })
    expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open' })
    expect(h.gate(job)!.responses.map(response => response.reason)).toEqual(['not an eligible approver', 'not an eligible approver'])
    expect(h.state(job).inputs).toEqual([])
    expect(answersOn(TICKET)).toHaveLength(1)
  })

  it('answers a question on a completed job\'s merge request without reopening it', async () => {
    const job = await start()
    await toImplement(job)
    await h.complete(job)
    expect(h.status(job)).toBe('completed')
    h.followUps.set('does this handle nulls?', 'question')
    await h.say(REVIEWER, 'does this handle nulls?', { thread: MR, source: 'gitlab' })
    expect(answersOn(MR)).toEqual(['Ответ: does this handle nulls?'])
    expect(h.status(job)).toBe('completed')
    await h.say(REVIEWER, 'please handle nulls', { thread: MR, source: 'gitlab' })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'review', entry: 'reopen' })
  })
})

/** The owner's trial (2026-11-14): who hears back on the plan, and change proposals (`D12`). */
describe('people told why, and change proposals (trial 2026-11-14)', () => {
  const JIRA_ANNA: Actor = { source: 'jira', id: 'anna' }
  const GITLAB_ANNA: Actor = { source: 'gitlab', id: 'anna' }
  const requirements = () => delivery(1, declaration => {
    declaration.places = { clarification: 'chat', plan: 'ticket', code: 'mergeRequest' }
    declaration.stages[0]!.tools = ['jira.link']
    declaration.transitions = declaration.transitions.map(transition => transition.from === 'implement' ? { from: 'implement', to: '$complete' } : transition)
    declaration.reopen = { stage: 'review', requirements: 'plan' }
  })
  async function startWith(workflow = requirements(), without: readonly string[] = []): Promise<string> {
    h = new Harness({ workflows: [workflow], without })
    h.policy = { ...h.policy, approvers: { delivery: { mattermost: ['lead'], jira: ['lead'], gitlab: ['lead'] } } }
    const job = await h.start()
    h.wb.action(job, h.attempt(job), { session: 's', id: 'link' }, 'jira.link', { issueKey: 'ORD-1' })
    await h.settle()
    return job
  }
  const postsOn = (thread: string, kind: string) => h.posts.filter(post => post.threadKey === thread && post.message.kind === kind)
  const messagesOn = (thread: string, kind: string) => postsOn(thread, kind).map(post => post.message)
  const proposals = (job: string) => h.state(job).proposals ?? []
  const inputsOf = (job: string) => h.running.get(h.attempt(job))!.payload.inputs
  const proposalGate = (job: string) => Object.values(h.state(job).gates).find(gate => gate.kind === 'proposal')
  async function completed(without: readonly string[] = []): Promise<string> {
    const job = await startWith(requirements(), without)
    await toImplement(job)
    await h.complete(job)
    expect(h.status(job)).toBe('completed')
    return job
  }

  it('tells someone who may not approve that their ok does not count; a change they ask for is put to the approvers on the approval', async () => {
    const job = await startWith()
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, {}, 'Plan r1')
    h.followUps.set('ok', 'approve')
    await h.say(JIRA_ANNA, 'ok', { thread: TICKET })
    expect(messagesOn(TICKET, 'notApprover')).toEqual([{ kind: 'notApprover', to: JIRA_ANNA }])
    h.followUps.set('use plain 422', 'changes_requirements')
    await h.say(JIRA_ANNA, 'use plain 422', { thread: TICKET })
    expect(proposals(job)).toEqual([expect.objectContaining({ id: 'p1', text: 'use plain 422', by: JIRA_ANNA, thread: TICKET, status: 'pending' })])
    expect(messagesOn(TICKET, 'proposalAsk')).toEqual([expect.objectContaining({ proposals: [{ id: 'p1', text: 'use plain 422', by: JIRA_ANNA }], onApproval: true, to: JIRA_ANNA })])
    // Asked in the ticket itself, so no news goes anywhere else; the approval stays open, and talk gets nothing.
    expect(h.posts.filter(post => post.message.kind === 'proposalNews')).toEqual([])
    h.followUps.set('lunch?', 'unrelated')
    await h.say(JIRA_ANNA, 'lunch?', { thread: TICKET })
    expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open' })
    expect(h.followUpPayloads.at(-1)).toMatchObject({ jobId: job, questionOnly: true })
    // A plain ok while a proposal is pending is not taken as approval by the vocabulary: it is read with the proposals, and is unclear.
    h.verdicts.set('ок', { verdict: 'unclear', confidence: 0.9, reading: 'не сказано про изменение' })
    await h.say(JIRA_LEAD, 'ок', { thread: TICKET })
    expect(h.interpretations.at(-1)).toMatchObject({ text: 'ок', proposals: [{ id: 'p1', text: 'use plain 422' }] })
    expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open' })
    // Accepting it makes a revision with the proposal as a requested change.
    h.verdicts.set('согласен', { verdict: 'request_changes', confidence: 0.95, proposals: [{ id: 'p1', accept: true }] })
    await h.say(JIRA_LEAD, 'согласен', { thread: TICKET })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'revision' })
    expect(inputsOf(job)).toEqual([expect.objectContaining({ kind: 'changes_requested', text: 'use plain 422', by: JIRA_ANNA })])
    expect(proposals(job)[0]).toMatchObject({ status: 'accepted', decidedBy: JIRA_LEAD })
    // The revision includes it, and its approval approves it.
    await h.complete(job, {}, 'Plan r2')
    expect(proposals(job)[0]).toMatchObject({ status: 'included', revision: 2 })
    await h.say(JIRA_LEAD, 'ok', { thread: TICKET })
    expect(proposals(job)[0]).toMatchObject({ status: 'approved' })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'implement' })
  })

  it('declines a proposal on the approval and approves the plan as it is ("нет, ок")', async () => {
    const job = await startWith()
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, {}, 'Plan r1')
    h.followUps.set('use plain 422', 'changes_requirements')
    await h.say(JIRA_ANNA, 'use plain 422', { thread: TICKET })
    h.verdicts.set('нет, ок', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p1', accept: false }] })
    await h.say(JIRA_LEAD, 'нет, ок', { thread: TICKET })
    expect(proposals(job)[0]).toMatchObject({ status: 'declined', decidedBy: JIRA_LEAD })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'implement' })
  })

  it('points an approval written in the chat thread to the ticket, and keeps nothing from it', async () => {
    const job = await startWith()
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, {}, 'Plan r1')
    h.followUps.set('ок', 'approve')
    await h.say(LEAD, 'ок')
    expect(messagesOn(THREAD, 'approveElsewhere')).toEqual([{ kind: 'approveElsewhere', ticket: 'ORD-1' }])
    expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open' })
    expect(h.state(job).inputs).toEqual([])
  })

  it('takes an approver\'s requirement change on a finished job\'s merge request to the plan at once, and follows it to done there', async () => {
    const job = await completed()
    h.followUps.set('спасибо, отлично', 'approve')
    await h.say(REVIEWER, 'спасибо, отлично', { thread: MR, source: 'gitlab' })
    expect(h.status(job)).toBe('completed')
    h.followUps.set('добавь фильтр по sku', 'changes_requirements')
    await h.say(REVIEWER, 'добавь фильтр по sku', { thread: MR, source: 'gitlab', replyTo: 'disc-3' })
    expect(proposals(job)).toEqual([expect.objectContaining({ status: 'accepted', by: REVIEWER, decidedBy: REVIEWER, replyTo: 'disc-3' })])
    expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'reopen' })
    expect(inputsOf(job)).toEqual([expect.objectContaining({ kind: 'changes_requested', text: 'добавь фильтр по sku', by: REVIEWER })])
    expect(postsOn(MR, 'proposalNews')).toEqual([expect.objectContaining({ replyTo: 'disc-3', message: { kind: 'proposalNews', news: 'accepted', ticket: 'ORD-1' } })])
    await h.complete(job, {}, 'Plan r2')
    await h.say(JIRA_LEAD, 'ok', { thread: TICKET })
    expect(postsOn(MR, 'proposalNews').at(-1)).toMatchObject({ replyTo: 'disc-3', message: { news: 'approved', revision: 2, by: JIRA_LEAD } })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'implement' })
    await h.complete(job)
    expect(h.status(job)).toBe('completed')
    expect(proposals(job)[0]).toMatchObject({ status: 'done' })
    expect(postsOn(MR, 'proposalNews').at(-1)).toMatchObject({ replyTo: 'disc-3', message: { news: 'done' } })
    expect(messagesOn(THREAD, 'completed').at(-1)).toMatchObject({ reworked: true })
  })

  it('puts a non-approver\'s requirement change on a finished job to the approvers in the ticket; "да" reopens the job at the plan', async () => {
    const job = await completed()
    h.followUps.set('добавь фильтр по sku', 'changes_requirements')
    await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab', replyTo: 'disc-4' })
    expect(h.status(job)).toBe('completed')
    expect(proposalGate(job)).toMatchObject({ status: 'open', threadKey: TICKET })
    expect(messagesOn(TICKET, 'proposalAsk')).toEqual([expect.objectContaining({ proposals: [expect.objectContaining({ id: 'p1', by: GITLAB_ANNA })] })])
    expect(messagesOn(TICKET, 'proposalAsk')[0]).not.toHaveProperty('onApproval')
    expect(postsOn(MR, 'proposalNews')).toEqual([expect.objectContaining({ replyTo: 'disc-4', message: { kind: 'proposalNews', news: 'passed', ticket: 'ORD-1' } })])
    h.verdicts.set('да', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p1', accept: true }] })
    await h.say(JIRA_LEAD, 'да', { thread: TICKET })
    expect(proposals(job)[0]).toMatchObject({ status: 'accepted', decidedBy: JIRA_LEAD })
    expect(proposalGate(job)).toMatchObject({ status: 'satisfied' })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'reopen' })
    expect(postsOn(MR, 'proposalNews').at(-1)).toMatchObject({ replyTo: 'disc-4', message: { news: 'accepted', by: JIRA_LEAD } })
  })

  it('declines a non-approver\'s change on a proposal request: the job stays finished, and the person hears it where they asked', async () => {
    const job = await completed()
    h.followUps.set('добавь фильтр по sku', 'changes_requirements')
    await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
    h.verdicts.set('нет', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p1', accept: false }] })
    await h.say(JIRA_LEAD, 'нет', { thread: TICKET })
    expect(h.status(job)).toBe('completed')
    expect(proposals(job)[0]).toMatchObject({ status: 'declined' })
    expect(postsOn(MR, 'proposalNews').at(-1)).toMatchObject({ message: { news: 'declined', by: JIRA_LEAD } })
    expect(proposalGate(job)).toMatchObject({ status: 'satisfied' })
  })

  it('keeps the job running while a proposal waits, and takes an accepted one to the plan when implement completes, before review', async () => {
    const job = await startWith()
    await toImplement(job)
    h.followUps.set('добавь фильтр по sku', 'changes_requirements')
    await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
    await h.say(REVIEWER, 'rename total', { thread: MR, source: 'gitlab' })
    expect(h.status(job)).toBe('running')
    expect(h.state(job).attempt).toMatchObject({ stageId: 'implement' })
    h.verdicts.set('да', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p1', accept: true }] })
    await h.say(JIRA_LEAD, 'да', { thread: TICKET })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'implement' })
    await h.complete(job)
    // The accepted change goes to the plan first; the code fix waits through plan and implement for review.
    expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'reopen' })
    expect(inputsOf(job).map(input => input.text)).toEqual(['добавь фильтр по sku'])
    await h.complete(job, {}, 'Plan r2')
    await h.say(JIRA_LEAD, 'ok', { thread: TICKET })
    expect(inputsOf(job).map(input => input.text)).not.toContain('rename total')
    await h.complete(job)
    expect(h.state(job).attempt).toMatchObject({ stageId: 'review', entry: 'reopen' })
    expect(inputsOf(job).map(input => input.text)).toContain('rename total')
  })

  it('keeps a pending proposal open when the job finishes; accepting it then reopens the job at the plan', async () => {
    const job = await startWith()
    await toImplement(job)
    h.followUps.set('добавь фильтр по sku', 'changes_requirements')
    await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
    await h.complete(job)
    expect(h.status(job)).toBe('completed')
    expect(proposalGate(job)).toMatchObject({ status: 'open' })
    expect(h.wb.kernel.db.get<{ n: number }>('SELECT count(*) AS n FROM open_gate WHERE job_id = ?', job)!.n).toBe(1)
    h.verdicts.set('да', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p1', accept: true }] })
    await h.say(JIRA_LEAD, 'да', { thread: TICKET })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'reopen' })
  })

  it('makes an open approval a revision when an approver asks for a requirement change on the merge request', async () => {
    const job = await completed()
    h.followUps.set('добавь фильтр по sku', 'changes_requirements')
    await h.say(REVIEWER, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
    await h.complete(job, {}, 'Plan r2')
    expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open' })
    h.followUps.set('и ещё фильтр по дате', 'changes_requirements')
    await h.say(REVIEWER, 'и ещё фильтр по дате', { thread: MR, source: 'gitlab' })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'revision' })
    expect(inputsOf(job).map(input => input.text)).toEqual(['и ещё фильтр по дате'])
    await h.complete(job, {}, 'Plan r3')
    expect(proposals(job).map(proposal => [proposal.status, proposal.revision])).toEqual([['included', 3], ['included', 3]])
  })

  it('sends a requirement change to review as before when the workflow names no requirements stage', async () => {
    const job = await startWith(placed())
    await toImplement(job)
    await h.complete(job)
    h.followUps.set('добавь фильтр по sku', 'changes_requirements')
    await h.say(REVIEWER, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'review', entry: 'reopen' })
    expect(h.state(job).proposals).toBeUndefined()
  })

  it('keeps information and an approval with notes as follow-ups; drops only plain thanks (review, 2026-11-14)', async () => {
    const job = await startWith()
    await toImplement(job)
    h.followUps.set('кстати, лимит на проде 100', 'unrelated')
    await h.say(ANNA, 'кстати, лимит на проде 100')
    h.followUps.set('спасибо', 'approve')
    await h.say(ANNA, 'спасибо')
    expect(h.state(job).inputs.map(input => input.text)).toEqual([])
    expect(h.steers.map(steer => (steer as { text: string }).text)).toEqual(['кстати, лимит на проде 100'])
    await h.complete(job)
    h.followUps.set('LGTM, только переименуй total', 'approve_with_notes')
    await h.say(REVIEWER, 'LGTM, только переименуй total', { thread: MR, source: 'gitlab' })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'review', entry: 'reopen' })
  })

  it('answers a merge request comment in its discussion, and takes the discussion into the reopened attempt', async () => {
    const job = await completed()
    h.followUps.set('почему limit=abc отдаёт detail?', 'question')
    await h.say(REVIEWER, 'почему limit=abc отдаёт detail?', { thread: MR, source: 'gitlab', replyTo: 'disc-1' })
    expect(h.posts.filter(post => post.message.kind === 'answer').at(-1)).toMatchObject({ threadKey: MR, replyTo: 'disc-1' })
    await h.say(REVIEWER, 'rename total', { thread: MR, source: 'gitlab', replyTo: 'disc-2' })
    expect(inputsOf(job)).toEqual([expect.objectContaining({ kind: 'follow_up', text: 'rename total', replyTo: 'disc-2' })])
  })

  describe('the review of change proposals (2026-11-14)', () => {
    async function pendingOnFinished(): Promise<string> {
      const job = await completed()
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      return job
    }

    it('takes no cancel word on a finished job\'s proposal request as cancelling it', async () => {
      const job = await pendingOnFinished()
      h.verdicts.set('отмена', { verdict: 'cancel', confidence: 0.95 })
      await h.say(JIRA_LEAD, 'отмена', { thread: TICKET })
      expect(h.status(job)).toBe('completed')
      expect(proposals(job)[0]).toMatchObject({ status: 'pending' })
      expect(h.interpretations.at(-1)).toMatchObject({ text: 'отмена', gateKind: 'proposal' })
    })

    it('needs an explicit decision: a plain yes the model reads without decisions is restated, not taken as accepting all', async () => {
      const job = await pendingOnFinished()
      h.verdicts.set('ну да', { verdict: 'approve', confidence: 0.95 })
      await h.say(JIRA_LEAD, 'ну да', { thread: TICKET })
      expect(proposals(job)[0]).toMatchObject({ status: 'pending' })
      expect(h.status(job)).toBe('completed')
      // A decision on a proposal the reply was not read with does not count.
      h.verdicts.set('p9 да', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p9', accept: true }] })
      await h.say(JIRA_LEAD, 'p9 да', { thread: TICKET })
      expect(proposals(job)[0]).toMatchObject({ status: 'pending' })
    })

    it('closes the proposal request when the plan\'s approval opens, so the ticket has one gate and later comments are not swallowed', async () => {
      const job = await startWith()
      await toImplement(job)
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      h.followUps.set('и по дате', 'changes_requirements')
      await h.say(REVIEWER, 'и по дате', { thread: MR, source: 'gitlab' })
      await h.complete(job)
      expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'reopen' })
      await h.complete(job, {}, 'Plan r2')
      expect(proposalGate(job)).toMatchObject({ status: 'cancelled' })
      expect(h.wb.kernel.db.all('SELECT kind FROM open_gate WHERE job_id = ?', job)).toEqual([{ kind: 'approval' }])
      // The approval lists the pending one with its own number; "нет, ок" declines it and approves.
      expect(messagesOn(TICKET, 'approval').at(-1)).toMatchObject({ proposals: [{ id: 'p1', text: 'добавь фильтр по sku' }] })
      h.verdicts.set('нет, ок', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p1', accept: false }] })
      await h.say(JIRA_LEAD, 'нет, ок', { thread: TICKET })
      expect(proposals(job).map(proposal => proposal.status)).toEqual(['declined', 'approved'])
      expect(h.state(job).attempt).toMatchObject({ stageId: 'implement' })
    })

    it('tells the running plan attempt every proposal accepted in one reply, and its revision includes them all', async () => {
      const job = await completed()
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(REVIEWER, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      expect(h.state(job).attempt).toMatchObject({ stageId: 'plan' })
      h.followUps.set('и по дате', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'и по дате', { thread: MR, source: 'gitlab' })
      h.followUps.set('и по статусу', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'и по статусу', { thread: MR, source: 'gitlab' })
      h.verdicts.set('да', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p2', accept: true }, { id: 'p3', accept: true }] })
      await h.say(JIRA_LEAD, 'да', { thread: TICKET })
      expect(h.steers.map(steer => (steer as { text: string }).text)).toEqual(['и по дате', 'и по статусу'])
      await h.complete(job, {}, 'Plan r2')
      expect(proposals(job).map(proposal => [proposal.status, proposal.revision])).toEqual([['included', 2], ['included', 2], ['included', 2]])
    })

    it('does not loop when a revision that took an accepted proposal leaves the plan unchanged', async () => {
      const job = await completed()
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(REVIEWER, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      // The reopened plan attempt writes the same plan text as revision 1: no new revision, the approval opens on revision 1.
      await h.complete(job, {}, 'Plan r1')
      expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open' })
      expect(proposals(job)[0]).toMatchObject({ status: 'included' })
    })

    it('declining on the approval without a word on the plan keeps the approval open, with no empty revision', async () => {
      const job = await startWith()
      await h.complete(job, { findings: 'ok' })
      await h.complete(job, {}, 'Plan r1')
      h.followUps.set('use plain 422', 'changes_requirements')
      await h.say(JIRA_ANNA, 'use plain 422', { thread: TICKET })
      h.verdicts.set('нет', { verdict: 'unclear', confidence: 0.9, proposals: [{ id: 'p1', accept: false }] })
      await h.say(JIRA_LEAD, 'нет', { thread: TICKET })
      expect(proposals(job)[0]).toMatchObject({ status: 'declined' })
      expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open' })
      await h.say(JIRA_LEAD, 'ok', { thread: TICKET })
      expect(h.state(job).attempt).toMatchObject({ stageId: 'implement' })
    })

    it('drops the open proposals with news when the job is cancelled', async () => {
      const job = await startWith()
      await toImplement(job)
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab', replyTo: 'disc-5' })
      await h.say(LEAD, 'стоп')
      expect(h.status(job)).toBe('cancelled')
      expect(proposals(job)[0]).toMatchObject({ status: 'dropped' })
      expect(postsOn(MR, 'proposalNews').at(-1)).toMatchObject({ replyTo: 'disc-5', message: { news: 'dropped' } })
      expect(proposalGate(job)).toMatchObject({ status: 'cancelled' })
    })

    it('lets an approver cancel a running job from the ticket while a proposal request is open', async () => {
      const job = await startWith()
      await toImplement(job)
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      await h.say(JIRA_LEAD, 'стоп', { thread: TICKET })
      expect(h.status(job)).toBe('cancelled')
    })

    it('reads a non-approver\'s ticket comment during a proposal request as it would be read without it', async () => {
      const job = await startWith()
      await toImplement(job)
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      h.followUps.set('ключ лежит в vault', 'unrelated')
      await h.say(JIRA_ANNA, 'ключ лежит в vault', { thread: TICKET })
      expect(h.steers.map(steer => (steer as { text: string }).text)).toContain('ключ лежит в vault')
      expect(h.followUpPayloads.at(-1)).not.toHaveProperty('questionOnly')
    })

    it('drops the open proposals of a finished job when its merge request is merged, and closes the request', async () => {
      const job = await completed()
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab', replyTo: 'disc-6' })
      await h.fact('mr_merged', MR)
      expect(h.status(job)).toBe('completed')
      expect(proposals(job)[0]).toMatchObject({ status: 'dropped' })
      expect(proposalGate(job)).toMatchObject({ status: 'cancelled' })
      expect(postsOn(MR, 'proposalNews').at(-1)).toMatchObject({ replyTo: 'disc-6', message: { news: 'dropped' } })
      // A later yes reopens nothing.
      h.verdicts.set('да', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p1', accept: true }] })
      await h.say(JIRA_LEAD, 'да', { thread: TICKET })
      expect(h.status(job)).toBe('completed')
    })

    it('closes a finished job on an approver\'s «закрой» in its ticket, though a proposal request is open there, dropping it with its news', async () => {
      const job = await pendingOnFinished()
      const asked = h.interpretations.length
      await h.say(JIRA_LEAD, 'закрой', { thread: TICKET })
      expect(h.interpretations).toHaveLength(asked)
      expect(h.state(job)).toMatchObject({ closedBy: 'person', closer: JIRA_LEAD, status: { kind: 'completed' } })
      expect(proposals(job)[0]).toMatchObject({ status: 'dropped' })
      expect(proposalGate(job)).toMatchObject({ status: 'cancelled' })
      expect(postsOn(TICKET, 'closed')).toHaveLength(1)
      expect(postsOn(MR, 'proposalNews').at(-1)).toMatchObject({ message: { news: 'dropped' } })
    })

    it('expires a proposal request with no decision at the plan approval\'s deadline, and tells the person who asked', async () => {
      const job = await completed()
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      h.env.clock.advance(2 * 86_400_000)
      h.wb.kernel.timers.fireDue()
      await h.settle()
      expect(proposals(job)[0]).toMatchObject({ status: 'dropped' })
      expect(proposalGate(job)).toMatchObject({ status: 'expired' })
      expect(postsOn(MR, 'proposalNews').at(-1)).toMatchObject({ message: { news: 'expired' } })
    })

    it('keeps pending proposals before the approvers when the approval closes for a revision', async () => {
      const job = await startWith()
      await h.complete(job, { findings: 'ok' })
      await h.complete(job, {}, 'Plan r1')
      h.followUps.set('use plain 422', 'changes_requirements')
      await h.say(JIRA_ANNA, 'use plain 422', { thread: TICKET })
      h.verdicts.set('добавь индекс', { verdict: 'request_changes', notes: 'добавь индекс', confidence: 0.95 })
      await h.say(JIRA_LEAD, 'добавь индекс', { thread: TICKET })
      expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'revision' })
      expect(inputsOf(job).map(input => input.text)).toEqual(['добавь индекс'])
      expect(proposalGate(job)).toMatchObject({ status: 'open' })
      expect(proposals(job)[0]).toMatchObject({ status: 'pending' })
      // A bare "нет" read as a change request with nothing decided is restated, not taken as a change.
      await h.complete(job, {}, 'Plan r2')
      h.verdicts.set('нет', { verdict: 'request_changes', confidence: 0.9 })
      await h.say(JIRA_LEAD, 'нет', { thread: TICKET })
      expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open' })
    })

    it('revises before approval when a proposal accepted while the plan ran did not reach it', async () => {
      const job = await completed()
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(REVIEWER, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      h.undelivered = true
      h.followUps.set('и по дате', 'changes_requirements')
      await h.say(REVIEWER, 'и по дате', { thread: MR, source: 'gitlab' })
      const first = h.attempt(job)
      await h.complete(job, {}, 'Plan r2')
      // The second was not delivered: a revision takes it before the approval opens.
      expect(h.attempt(job)).not.toBe(first)
      expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'revision' })
      expect(inputsOf(job).map(input => input.text)).toEqual(['добавь фильтр по sku', 'и по дате'])
      h.undelivered = false
      await h.complete(job, {}, 'Plan r3')
      expect(proposals(job).map(proposal => [proposal.status, proposal.revision])).toEqual([['included', 3], ['included', 3]])
    })

    it('ignores a steer result that lands after the attempt reported: the revision taking the proposal is not undone', async () => {
      const job = await completed(['stage.steer'])
      let release: ((result: unknown) => void) | undefined
      h.wb.kernel.effects.register('stage.steer', { idempotent: true, long: true, limit: () => 4,
        run: () => new Promise(resolve => { release = resolve }), cancel: async () => {} } as never)
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(REVIEWER, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      h.followUps.set('и по дате', 'changes_requirements')
      await h.say(REVIEWER, 'и по дате', { thread: MR, source: 'gitlab' })
      await h.complete(job, {}, 'Plan r2')
      // The steer has not landed: a revision takes "и по дате" as an input.
      const revision = h.attempt(job)
      expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'revision' })
      release!({ ok: { delivered: true } })
      await h.settle()
      expect(proposals(job).map(proposal => proposal.givenTo)).toEqual([revision, revision])
      await h.complete(job, {}, 'Plan r3')
      expect(h.gate(job)).toMatchObject({ kind: 'approval', status: 'open' })
      expect(proposals(job).map(proposal => [proposal.status, proposal.revision])).toEqual([['included', 3], ['included', 3]])
    })

    it('gives a proposal that joins an open request its full time', async () => {
      const job = await completed()
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      h.env.clock.advance(86_400_000 - 60_000)
      h.followUps.set('и по дате', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'и по дате', { thread: MR, source: 'gitlab' })
      h.env.clock.advance(120_000)
      h.wb.kernel.timers.fireDue()
      await h.settle()
      expect(proposals(job).map(proposal => proposal.status)).toEqual(['pending', 'pending'])
      h.env.clock.advance(86_400_000)
      h.wb.kernel.timers.fireDue()
      await h.settle()
      expect(proposals(job).map(proposal => proposal.status)).toEqual(['dropped', 'dropped'])
    })

    it('tells the person who asked when the request could not be posted, and closes it', async () => {
      const job = await completed()
      h.failPosts = (post: { message: { kind: string } }) => post.message.kind === 'proposalAsk'
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(GITLAB_ANNA, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      expect(proposals(job)[0]).toMatchObject({ status: 'dropped' })
      expect(proposalGate(job)).toMatchObject({ status: 'cancelled' })
      expect(postsOn(MR, 'proposalNews').at(-1)).toMatchObject({ message: { news: 'unasked', ticket: 'ORD-1' } })
    })

    it('takes nothing more on a merged job: no new proposal, no reopening, and other facts after completion are not routed', async () => {
      const job = await completed()
      await h.fact('mr_merged', MR)
      expect(h.state(job).closedBy).toBe('mr_merged')
      h.followUps.set('добавь фильтр по sku', 'changes_requirements')
      await h.say(REVIEWER, 'добавь фильтр по sku', { thread: MR, source: 'gitlab' })
      expect(h.status(job)).toBe('completed')
      expect(h.state(job).proposals).toBeUndefined()
      const pipeline = await h.fact('pipeline', MR, { status: 'success' })
      expect(pipeline.route).toMatchObject({ kind: 'ignore' })
    })
  })
})

describe('the merge-risk summary on completion (P16)', () => {
  const RISK = { level: 'medium', floor: [], sensitive: [], commit: 'c'.repeat(40), categories: {
    alignment: { verdict: 'good', gaps: [] }, impact: { verdict: 'medium', gaps: ['shared ERRORS'] }, verification: { verdict: 'poor', gaps: ['no limit=100 test'] },
    rollback: { verdict: 'low', gaps: [] }, errors: { verdict: 'n/a', gaps: [] } } }

  it('puts the passed review\'s risk in the completion post and the whole summary on the merge request', async () => {
    const job = await start()
    await toImplement(job)
    h.checkExtras.set('lint', { risk: RISK, notes: '- (unverified important: its quote is not on the new side of src/a.py) sorts wrong' })
    await h.complete(job)
    expect(h.status(job)).toBe('completed')
    expect(h.posts.filter(post => post.message.kind === 'completed').at(-1)!.message).toMatchObject({ risk: RISK })
    expect(h.posts.filter(post => post.message.kind === 'mergeRisk')).toEqual([expect.objectContaining({ threadKey: MR,
      message: { kind: 'mergeRisk', risk: RISK, notes: expect.stringContaining('sorts wrong') } })])
  })

  it('posts no risk without one, and no merge request note without a merge request', async () => {
    const job = await start()
    await toImplement(job)
    await h.complete(job)
    expect(h.posts.some(post => post.message.kind === 'mergeRisk')).toBe(false)
    expect(h.posts.filter(post => post.message.kind === 'completed').at(-1)!.message).not.toHaveProperty('risk')
    const other = await start()
    await h.complete(other, { findings: 'ok' })
    await h.complete(other, {}, 'Plan r1')
    await h.say(JIRA_LEAD, 'ok', { thread: TICKET })
    h.checkExtras.set('lint', { risk: RISK })
    await h.complete(other)
    expect(h.posts.filter(post => post.message.kind === 'mergeRisk')).toEqual([])
  })
})

