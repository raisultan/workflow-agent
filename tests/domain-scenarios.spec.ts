/**
 * The domain scenario suite (`T8.11`, `G8`): jobs on the real kernel with fake adapters. Covers questions (`A3`), approval admission
 * and resolution (`A5`, `A12`), a second workflow (`A6`), pinned manifests (`A13`), budgets (`A16`) and intake (`A18`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPLETE } from '../src/domain/definition.ts'
import { ANNA, BOT, delivery, EVE, Harness, LEAD, THREAD } from './fixtures/domain-workflow.ts'

let h: Harness
beforeEach(() => { h = new Harness() })
afterEach(() => { h.cleanup() })

const MR = 'gitlab:group/app!1'

describe('a job end to end', () => {
  it('runs inspect, a question round, plan, approval, implement with checks, review, and completes', async () => {
    const job = await h.start()
    expect(h.outbound('started')).toHaveLength(1)
    expect(h.running.size).toBe(1)

    // A3: the question gate holds no worker slot, and says what it waits for and where.
    await h.report(job, { outcome: 'question', items: [{ text: 'Which store?', choices: ['redis', 'sql'] }, { text: 'TTL?' }] })
    expect(h.status(job)).toBe('awaiting_gate')
    expect(h.running.size).toBe(0)
    expect(h.wb.kernel.db.get("SELECT count(*) AS n FROM effect WHERE kind = 'stage.attempt' AND status = 'running'")).toEqual({ n: 0 })
    expect(h.outbound('question')).toEqual([expect.objectContaining({ round: 1, items: expect.arrayContaining([expect.objectContaining({ text: 'TTL?' })]) })])
    expect(h.wb.kernel.db.all('SELECT thread_key, kind FROM open_gate')).toEqual([{ thread_key: THREAD, kind: 'question' }])

    await h.say(ANNA, '1: redis, 2: one hour')
    expect(h.status(job)).toBe('running')
    const answered = h.running.get(h.attempt(job))!.payload
    expect(answered).toMatchObject({ stageId: 'inspect', entry: 'answer', inputs: [{ kind: 'answers', text: '1: redis, 2: one hour' }] })

    await h.complete(job, { findings: 'sessions live in redis' })
    expect(h.state(job).attempt!.stageId).toBe('plan')
    await h.complete(job, {}, 'Plan r1')
    expect(h.status(job)).toBe('awaiting_gate')
    const gate = h.gate(job)!
    expect(gate).toMatchObject({ kind: 'approval', subject: { kind: 'plan', n: 1 }, to: 'implement' })
    expect(gate.postedAt).toBeDefined()

    await h.say(LEAD, 'LGTM')
    expect(h.outbound('approved')).toEqual([expect.objectContaining({ subject: expect.objectContaining({ n: 1 }), by: LEAD, next: 'implement' })])
    expect(h.state(job).attempt!.stageId).toBe('implement')

    // A safe-output request binds the MR thread to the job.
    expect(h.wb.action(job, h.attempt(job), { session: 's', id: 'mr' }, 'gitlab.createMr', { title: 'Sessions' }).outcome.kind).toBe('decided')
    expect(h.wb.action(job, h.attempt(job), { session: 's', id: 'merge' }, 'gitlab.merge', {}).outcome)
      .toEqual(expect.objectContaining({ kind: 'rejected', reason: 'stage implement may not use gitlab.merge' }))
    await h.settle()
    expect(h.state(job).bindings).toContainEqual({ threadKey: MR, role: 'artifact' })

    await h.complete(job)
    expect(h.state(job).attempt!.stageId).toBe('review')
    await h.complete(job, { approved: true })
    expect(h.state(job).status).toMatchObject({ kind: 'completed', outcome: 'completed' })
    expect(h.outbound('completed')).toHaveLength(1)
    expect(h.wb.kernel.engine.foldedState(job)).toEqual(h.state(job))
  })
})

describe('questions (A3)', () => {
  it('allows a follow-up round within the stage limit and refuses one more', async () => {
    const job = await h.start()
    await h.report(job, { outcome: 'question', items: [{ text: 'Which store?' }] })
    await h.say(ANNA, 'redis')
    await h.report(job, { outcome: 'question', items: [{ text: 'Which redis cluster?' }] })
    expect(h.outbound('question').map(question => (question as { round: number }).round)).toEqual([1, 2])
    await h.say(LEAD, 'the shared one')
    const third = await h.report(job, { outcome: 'question', items: [{ text: 'And the TTL?' }] })
    expect(third.outcome).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('no question rounds left') })
    expect(h.status(job)).toBe('running')
  })

  it('refuses a question from a stage that may ask none', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    await h.complete(job)
    expect((await h.report(job, { outcome: 'question', items: [{ text: 'Merge now?' }] })).outcome)
      .toMatchObject({ kind: 'rejected', reason: expect.stringContaining('stage review has no question rounds left') })
  })

  it('takes answers from respondents only and lets an approver cancel from the question thread', async () => {
    const job = await h.start()
    await h.report(job, { outcome: 'question', items: [{ text: 'Which store?' }] })
    await h.say(EVE, 'redis')
    expect(h.gate(job)!.responses).toEqual([expect.objectContaining({ accepted: false, reason: 'not an eligible respondent' })])
    expect(h.status(job)).toBe('awaiting_gate')
    await h.say(LEAD, 'стоп')
    expect(h.state(job).status).toMatchObject({ kind: 'cancelled', by: LEAD })
    expect(h.wb.kernel.db.all('SELECT * FROM open_gate')).toEqual([])
  })
})

describe('approval admission (A5, A12)', () => {
  it('refuses replies from an ineligible actor, the workbench, another thread, or before the gate was posted', async () => {
    const job = await h.toApproval()
    const gate = h.gate(job)!
    await h.say(EVE, 'LGTM')
    // The router drops the workbench's own posts; the job refuses one that reaches it anyway.
    expect((await h.say(BOT, 'LGTM')).route).toEqual({ kind: 'ignore', reason: 'the workbench\'s own post' })
    const reply = (text: string, extra: object) => h.replyDirectly(job, gate.id, { actor: LEAD, text, postedAt: h.env.clock.now(), ...extra })
    reply('bot', { actor: BOT })
    reply('elsewhere', { threadKey: 'mattermost:ch1:other' })
    reply('early', { postedAt: gate.postedAt! - 1 })
    expect(h.gate(job)!.responses.map(response => response.reason)).toEqual([
      'not an eligible approver', 'the workbench cannot answer its own gate', 'not on the gate\'s thread', 'posted before the gate\'s current revision'])
    expect(h.status(job)).toBe('awaiting_gate')
    expect(h.outbound('approved')).toEqual([])
  })

  it('lets the requester approve their own job, but not after leaving the allowlist', async () => {
    const job = await h.toApproval()
    h.policy = { ...h.policy, senders: { mattermost: ['lead'] } }
    await h.say(ANNA, 'ок')
    expect(h.gate(job)!.responses.at(-1)).toMatchObject({ accepted: false, reason: 'not an eligible approver' })
    h.policy = { ...h.policy, senders: { mattermost: ['anna', 'lead'] } }
    await h.say(ANNA, 'ок')
    expect(h.state(job).attempt!.stageId).toBe('implement')
  })

  it('removing an approver from the policy applies to a running job', async () => {
    const job = await h.toApproval()
    h.policy = { ...h.policy, approvers: {} }
    await h.say(LEAD, 'approved')
    expect(h.gate(job)!.responses.at(-1)).toMatchObject({ accepted: false, reason: 'not an eligible approver' })
  })

  it('treats a conditional reply as a change request and gates the new revision afresh', async () => {
    const job = await h.toApproval()
    const first = h.gate(job)!
    h.verdicts.set('Ок, но добавь индекс', { verdict: 'request_changes', notes: 'add an index', confidence: 0.95 })
    await h.say(LEAD, 'Ок, но добавь индекс')
    expect(h.interpretations).toEqual([expect.objectContaining({ text: 'Ок, но добавь индекс', verdictModel: 'deepseek-verdict', subject: first.subject })])
    expect(h.state(job).gates[first.id]!.status).toBe('changes_requested')
    expect(h.running.get(h.attempt(job))!.payload).toMatchObject({ stageId: 'plan', entry: 'revision',
      inputs: [{ kind: 'changes_requested', text: 'add an index', by: LEAD }] })
    const staleAt = h.env.clock.now()
    await h.complete(job, {}, 'Plan r2')
    const second = h.gate(job)!
    expect(second.id).not.toBe(first.id)
    expect(second.subject).toMatchObject({ kind: 'plan', n: 2 })
    // A reply written before the new revision was posted applies to the old one.
    h.replyDirectly(job, second.id, { actor: LEAD, text: 'ok', postedAt: staleAt })
    expect(h.gate(job)!.responses.at(-1)).toMatchObject({ accepted: false, reason: 'posted before the gate\'s current revision' })
    await h.say(LEAD, 'ok')
    expect(h.outbound('approved')).toEqual([expect.objectContaining({ subject: expect.objectContaining({ n: 2 }) })])
  })

  it('never approves on an unclear reply, low confidence or an unavailable model, and restates its reading', async () => {
    const job = await h.toApproval()
    h.verdicts.set('maybe later?', { verdict: 'approve', confidence: 0.5, reading: 'you might approve later' })
    h.verdicts.set('sure, whatever works', 'unavailable')
    await h.say(LEAD, 'hmm')
    await h.say(LEAD, 'maybe later?')
    await h.say(LEAD, 'sure, whatever works')
    expect(h.status(job)).toBe('awaiting_gate')
    expect(h.gate(job)!.responses.map(response => [response.accepted, response.reason])).toEqual([[false, 'unclear'], [false, 'low confidence'], [false, 'unclear']])
    expect(h.outbound('restate').map(message => (message as { reading: string }).reading)).toEqual([
      'I read "hmm" as unclear', 'you might approve later', 'no verdict: model unavailable'])
    expect(h.outbound('approved')).toEqual([])
  })

  it('passes approval notes to the next stage and acknowledges them; ignores unrelated replies', async () => {
    const job = await h.toApproval()
    h.verdicts.set('lunch?', { verdict: 'unrelated', confidence: 0.99 })
    h.verdicts.set('approved, reuse the helper', { verdict: 'approve_with_notes', notes: 'reuse the helper', confidence: 0.9 })
    await h.say(LEAD, 'lunch?')
    expect(h.status(job)).toBe('awaiting_gate')
    await h.say(LEAD, 'approved, reuse the helper')
    expect(h.outbound('approved')).toEqual([expect.objectContaining({ notes: 'reuse the helper', by: LEAD })])
    expect(h.running.get(h.attempt(job))!.payload).toMatchObject({ stageId: 'implement', inputs: [{ kind: 'approval_notes', text: 'reuse the helper' }] })
  })

  it('cancels on a cancel verdict, and a question goes back to the stage', async () => {
    const job = await h.toApproval()
    h.verdicts.set('why redis?', { verdict: 'question', confidence: 0.9 })
    await h.say(LEAD, 'why redis?')
    expect(h.running.get(h.attempt(job))!.payload).toMatchObject({ stageId: 'plan', entry: 'question', inputs: [{ kind: 'gate_question', text: 'why redis?' }] })
    await h.complete(job, {}, 'Plan r1')
    expect(h.gate(job)!.subject).toMatchObject({ n: 1 })
    h.verdicts.set('drop it, we will not do this', { verdict: 'cancel', confidence: 0.9 })
    await h.say(LEAD, 'drop it, we will not do this')
    expect(h.state(job).status).toMatchObject({ kind: 'cancelled', by: LEAD })
    expect(h.outbound('cancelled')).toHaveLength(1)
  })

  it('reminds once, then expires without approving and blocks until an approver resumes', async () => {
    const job = await h.toApproval()
    const gate = h.gate(job)!
    h.env.clock.advance(3_600_000)
    h.wb.kernel.timers.fireDue()
    await h.settle()
    expect(h.outbound('reminder')).toEqual([{ kind: 'reminder', gateId: gate.id }])
    h.env.clock.advance(86_400_000)
    h.wb.kernel.timers.fireDue()
    await h.settle()
    expect(h.state(job).gates[gate.id]!.status).toBe('expired')
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'gate_expired' } })
    await h.say(LEAD, 'повтори')
    const reopened = h.gate(job)!
    expect(reopened).toMatchObject({ kind: 'approval', subject: gate.subject, status: 'open' })
    expect(reopened.id).not.toBe(gate.id)
    await h.say(LEAD, 'go ahead')
    expect(h.state(job).attempt!.stageId).toBe('implement')
  })
})

describe('stages', () => {
  it('rejects a second report for an attempt that already reported, whatever its call id, and invalid outputs', async () => {
    const job = await h.start()
    const attemptId = h.attempt(job)
    const invalid = h.wb.report(job, attemptId, { session: 's', id: 'c0' }, { outcome: 'completed', summary: 'x', output: { findings: 3 } })
    expect(invalid.outcome).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('does not match stage inspect') })
    const report = { outcome: 'completed', summary: 'x', output: { findings: 'ok', extra: null } }
    expect(h.wb.report(job, attemptId, { session: 's', id: 'c1' }, report).outcome.kind).toBe('decided')
    expect(h.wb.report(job, attemptId, { session: 's', id: 'c1' }, report).replayed).toBe(true)
    expect(h.wb.report(job, attemptId, { session: 's2', id: 'c2' }, report).outcome).toMatchObject({ kind: 'rejected', reason: 'not the current attempt' })
    expect(h.wb.report(job, h.attempt(job), { session: 's', id: 'c3' }, { outcome: 'completed', summary: 'plan' }).outcome)
      .toMatchObject({ kind: 'rejected', reason: 'stage plan must report its plan artifact' })
  })

  it('retries failed checks within the attempt budget, then blocks, and an approver retries with an extension', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    h.checks.set('tests', false)
    h.checks.set('lint', false)
    await h.complete(job)
    expect(h.running.get(h.attempt(job))!.payload).toMatchObject({ stageId: 'implement', entry: 'retry', n: 2,
      inputs: [{ kind: 'check_failures', text: 'tests: tests log' }] })
    await h.complete(job)
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'attempts', stageId: 'implement' } })
    expect(h.outbound('blocked')).toEqual([expect.objectContaining({ extension: { attempts: 2 } })])
    await h.say(EVE, 'retry')
    expect(h.status(job)).toBe('blocked')
    await h.say(LEAD, 'retry')
    expect(h.state(job).extended.attempts).toBe(2)
    expect(h.running.get(h.attempt(job))!.payload).toMatchObject({ entry: 'retry', n: 3 })
    h.checks.set('tests', true)
    await h.complete(job)
    expect(h.state(job).attempt!.stageId).toBe('review')
  })

  it('blocks on a check the environment holds up, without using an attempt, and "ok" re-runs the checks on the same attempt (T10.5)', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    const implement = h.attempt(job)
    h.checks.set('tests', 'blocked')
    await h.complete(job)
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'checks_blocked', stageId: 'implement', checks: ['tests'], detail: 'tests: tests log' } })
    expect(h.state(job).attempt).toMatchObject({ id: implement, ended: true })
    expect(h.state(job).visitAttempts).toBe(1)
    expect(h.outbound('blocked')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ kind: 'checks_blocked' }) })])
    expect(h.outbound('blocked')[0]).not.toHaveProperty('extension')
    // Still blocked by the environment: the re-run blocks again, and still no attempt is used.
    await h.say(LEAD, 'ок')
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'checks_blocked' } })
    expect(h.state(job).attempt!.id).toBe(implement)
    h.checks.set('tests', true)
    await h.say(LEAD, 'ок')
    expect(h.wb.kernel.engine.events(job).filter(event => event.type === 'VerificationStarted').map(event => event.attemptId)).toEqual([implement, implement, implement])
    expect(h.state(job).attempt!.stageId).toBe('review')
  })

  it('retries the attempt when one required check failed and another was blocked; an optional blocked check only records (T10.5)', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    h.checks.set('tests', false)
    h.checks.set('lint', 'blocked')
    await h.complete(job)
    expect(h.state(job).attempt).toMatchObject({ stageId: 'implement', entry: 'retry', n: 2 })
    h.checks.set('tests', true)
    await h.complete(job)
    expect(h.state(job).attempt!.stageId).toBe('review')
  })

  it('treats a check that could not run as blocked, and "стоп" cancels the blocked job (T10.5)', async () => {
    h.cleanup()
    h = new Harness({ without: ['check'] })
    h.wb.kernel.effects.register('check', { idempotent: true, limit: () => 2, run: async () => ({ fail: 'the sandbox is not available' }) })
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    await h.complete(job)
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'checks_blocked', checks: ['tests'],
      detail: 'tests: the check could not run: the sandbox is not available' } })
    await h.say(LEAD, 'стоп')
    expect(h.status(job)).toBe('cancelled')
  })

  it('names the checks that passed in the completion post (T10.6)', async () => {
    h.cleanup()
    h = new Harness({ workflows: [delivery(1, declaration => { declaration.transitions[2] = { from: 'implement', to: COMPLETE } })] })
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    // The optional lint check could not run, so only tests is named.
    h.checks.set('lint', 'blocked')
    await h.complete(job)
    expect(h.status(job)).toBe('completed')
    expect(h.outbound('completed')).toEqual([{ kind: 'completed', outcome: 'completed', checks: ['tests'] }])
  })

  it('retries an attempt interrupted by a restart with a recovery note', async () => {
    const job = await h.start()
    const first = h.attempt(job)
    await h.restart()
    expect(h.state(job).attempt).toMatchObject({ entry: 'recovery', n: 2 })
    expect(h.state(job).attempt!.id).not.toBe(first)
    expect(h.running.get(h.attempt(job))!.payload.inputs).toEqual([{ kind: 'recovery', text: 'The previous attempt ended: interrupted by a restart.' }])
  })

  it('stops an attempt that runs out of wall-clock time or goes over its turn limit, and retries it', async () => {
    const job = await h.start()
    const first = h.attempt(job)
    h.env.clock.advance(600_000)
    h.wb.kernel.timers.fireDue()
    await h.settle()
    expect(h.running.has(first)).toBe(false)
    expect(h.state(job).attempt).toMatchObject({ entry: 'retry', n: 2 })
    const second = h.attempt(job)
    h.wb.usage(job, second, { session: 's', id: 'u1' }, { turns: 21, tokens: 100 })
    await h.settle()
    expect(h.state(job).attempt).toMatchObject({ entry: 'retry', n: 3 })
    expect(h.state(job).usage).toEqual({ turns: 21, tokens: 100 })
    expect(h.wb.usage(job, h.attempt(job), { session: 's', id: 'u2' }, { turns: -1, tokens: Number.NaN }).outcome)
      .toMatchObject({ kind: 'rejected', reason: 'usage counts must be whole numbers, 0 or more' })
  })

  it('steers a running attempt with a follow-up and keeps one that arrives between attempts for the next', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    await h.say(ANNA, 'also handle logout')
    expect(h.steers).toEqual([expect.objectContaining({ attemptId: h.attempt(job), text: 'also handle logout' })])
    h.checks.set('tests', false)
    const attemptId = h.attempt(job)
    h.wb.report(job, attemptId, { session: 's', id: 'r1' }, { outcome: 'completed', summary: 'done', output: {} })
    h.endAttempt(attemptId)
    expect(h.status(job)).toBe('verifying')
    // The checks run after the follow-up is decided, so the retry they cause starts with it.
    await h.say(ANNA, 'and refresh tokens')
    expect(h.running.get(h.attempt(job))!.payload.inputs).toEqual([
      { kind: 'follow_up', text: 'and refresh tokens', by: ANNA, thread: THREAD }, { kind: 'check_failures', text: 'tests: tests log' }])
    expect((await h.say(EVE, 'me too')).submitted?.outcome).toMatchObject({ kind: 'rejected', reason: 'the sender is not eligible for this job' })
  })
})

describe('backtracks and budgets (A16)', () => {
  it('backtracks review → plan with a new revision and a fresh approval, within the edge budget', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    await h.complete(job)
    expect((await h.report(job, { outcome: 'backtrack', to: 'inspect', reason: 'x' })).outcome)
      .toMatchObject({ kind: 'rejected', reason: 'stage review may not go back to inspect' })
    await h.report(job, { outcome: 'backtrack', to: 'plan', reason: 'the ledger API changes' })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'backtrack' })
    expect(h.running.get(h.attempt(job))!.payload.inputs).toEqual([{ kind: 'backtrack', text: 'Back from review: the ledger API changes' }])
    await h.complete(job, {}, 'Plan r2')
    expect(h.gate(job)!.subject).toMatchObject({ n: 2 })
    await h.say(LEAD, 'ok')
    await h.complete(job)
    // The edge's budget is spent: the job blocks and asks to extend.
    await h.report(job, { outcome: 'backtrack', to: 'plan', reason: 'again' })
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'backtracks', from: 'review', to: 'plan' } })
    await h.say(LEAD, '+1')
    expect(h.state(job).backtracks).toEqual({ total: 2, edges: { 'review>plan': 2 } })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'plan', entry: 'backtrack' })
  })

  it('blocks when the job runs out of turns, then extends by the declared amount on approval', async () => {
    const job = await h.start()
    const use = (turns: number) => h.wb.usage(job, h.attempt(job), { session: h.attempt(job), id: 'usage' }, { turns, tokens: 100 })
    use(19)
    await h.complete(job, { findings: 'ok' })
    use(19)
    await h.complete(job, {}, 'Plan r1')
    await h.say(LEAD, 'ok')
    use(49)
    await h.complete(job)
    const review = h.attempt(job)
    use(14)
    await h.settle()
    expect(h.state(job).usage.turns).toBe(101)
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'budget', budget: 'turns' } })
    expect(h.running.has(review)).toBe(false)
    expect(h.outbound('blocked').at(-1)).toMatchObject({ extension: { turns: 50 } })
    expect(h.running.size).toBe(0)
    await h.say(ANNA, 'ok')
    expect(h.state(job).extended.turns).toBe(50)
    expect(h.status(job)).toBe('running')
  })

  it('cancels a blocked job when its owner says so', async () => {
    const job = await h.start()
    await h.report(job, { outcome: 'blocked', reason: 'no access to the repo' })
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'stage_blocked', detail: 'no access to the repo' } })
    await h.say(ANNA, '/cancel no longer needed')
    expect(h.state(job).status).toMatchObject({ kind: 'cancelled', reason: 'no longer needed', by: ANNA })
  })
})

describe('pinned manifests (A13)', () => {
  it('keeps a running job on its pinned definition, prompts and models while new jobs take the new ones', async () => {
    const job = await h.start()
    const pinned = h.wb.workflow(h.state(job).manifestId)
    expect(pinned.extra.stages.inspect).toMatchObject({ model: 'deepseek-flash', agentPreset: 'inspector' })
    expect(pinned.extra.stages.implement).toMatchObject({ model: 'deepseek-pro', effort: 'high' })
    expect(pinned.extra).toMatchObject({ verdictModel: 'deepseek-verdict', policyVersion: h.state(job).intake!.policyVersion })

    h.wb.register({ ...delivery(2, declaration => { declaration.stages[0]!.model = 'deepseek-v2'; declaration.transitions[0] = { from: 'inspect', to: COMPLETE } }),
      prompts: { inspect: 'Inspect v2.', plan: 'p', implement: 'i', review: 'r' } })
    const next = await h.start('@workbench another one', 'mattermost:ch1:p2')
    expect(h.wb.workflow(h.state(next).manifestId)).toMatchObject({ version: 2, extra: { stages: { inspect: { model: 'deepseek-v2' } } } })
    await h.complete(next, { findings: 'ok' })
    expect(h.status(next)).toBe('completed')

    await h.complete(job, { findings: 'ok' })
    expect(h.state(job).attempt!.stageId).toBe('plan')
    const prompt = h.wb.kernel.blobs.text(pinned.extra.stages.inspect!.instructions)
    expect(prompt).toBe('Inspect the request.')
  })

  it('parks a job whose guard is not registered, and resumes it when the guard is back', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    await h.complete(job)
    // A restart without the plugin that registers the guard.
    await h.restart({})
    await h.complete(job, { approved: true })
    expect(h.state(job).status).toMatchObject({ kind: 'parked', missing: ['review.approved'] })
    expect(h.wb.resume(job).submitted?.outcome).toMatchObject({ kind: 'rejected', reason: 'guards still missing: review.approved' })
    h.wb.registerGuard('review.approved', input => input.output.approved === true)
    h.wb.resume(job)
    expect(h.status(job)).toBe('completed')
  })
})

describe('facts and reopening', () => {
  it('never answers a gate with a machine fact, and completes on a merged MR', async () => {
    const job = await h.toApproval()
    await h.fact('pipeline', THREAD, { status: 'success' })
    expect(h.status(job)).toBe('awaiting_gate')
    expect(h.gate(job)!.responses).toEqual([])
    await h.say(LEAD, 'ok')
    h.wb.action(job, h.attempt(job), { session: 's', id: 'mr' }, 'gitlab.createMr', {})
    await h.settle()
    await h.fact('mr_merged', MR)
    expect(h.state(job).status).toMatchObject({ kind: 'completed', outcome: 'mr_merged' })
    expect(h.running.size).toBe(0)
    // A merged MR is done: feedback on it does not reopen the job; the merge request is told so once, then comments are ignored.
    await h.say(LEAD, 'nice', { thread: MR })
    expect(h.state(job).status).toMatchObject({ kind: 'completed', outcome: 'mr_merged' })
    expect(h.posts.filter(post => post.threadKey === MR).map(post => post.message)).toEqual([{ kind: 'jobClosed', fact: 'mr_merged' }])
    expect((await h.say(LEAD, 'nice again', { thread: MR })).submitted?.outcome).toMatchObject({ kind: 'rejected', reason: 'the merge request is merged' })
    expect((await h.fact('pipeline', 'gitlab:unbound!9')).route).toEqual({ kind: 'ignore', reason: 'a fact on a thread no active job is bound to' })
  })

  it('reopens a completed job at review on feedback in its MR thread, but not on its origin thread', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    h.wb.action(job, h.attempt(job), { session: 's', id: 'mr' }, 'gitlab.createMr', {})
    await h.settle()
    await h.complete(job)
    await h.complete(job, { approved: true })
    expect(h.status(job)).toBe('completed')
    const origin = await h.say(ANNA, 'thanks!')
    expect(origin.route.kind).toBe('ignore')
    const feedback = await h.say({ source: 'gitlab', id: 'lead' }, 'this breaks the ledger API', { thread: MR, source: 'gitlab' })
    expect(feedback.route).toMatchObject({ kind: 'followUp', jobId: job })
    expect(feedback.submitted?.outcome).toMatchObject({ kind: 'rejected', reason: 'the sender is not eligible for this job' })
    h.policy = { ...h.policy, approvers: { delivery: { mattermost: ['lead'], gitlab: ['lead'] } } }
    await h.say({ source: 'gitlab', id: 'lead' }, 'this breaks the ledger API', { thread: MR, source: 'gitlab' })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'review', entry: 'reopen' })
    expect(h.running.get(h.attempt(job))!.payload.inputs).toEqual([{ kind: 'follow_up', text: 'this breaks the ledger API', by: { source: 'gitlab', id: 'lead' }, thread: MR }])
  })
})

describe('intake (A18, A6)', () => {
  it('starts a job only on a mention or a direct message from an allowed sender', async () => {
    expect((await h.say(ANNA, 'add sessions')).route).toEqual({ kind: 'ignore', reason: 'not addressed to the workbench' })
    expect((await h.say(EVE, '@workbench add sessions', { addressed: 'mention' })).route).toEqual({ kind: 'ignore', reason: 'the sender may not start jobs' })
    expect((await h.say({ source: 'gitlab', id: 'anna' }, '@workbench add sessions', { addressed: 'mention', source: 'gitlab', thread: 'gitlab:x!2' })).route)
      .toEqual({ kind: 'ignore', reason: 'the sender may not start jobs' })
    h.policy = { ...h.policy, senders: { ...h.policy.senders, gitlab: ['anna'] } }
    expect((await h.say({ source: 'gitlab', id: 'anna' }, '@workbench add sessions', { addressed: 'mention', source: 'gitlab', thread: 'gitlab:x!3' })).route)
      .toEqual({ kind: 'ignore', reason: 'no workflow matches' })
    expect((await h.say(ANNA, 'machine', { addressed: 'mention', human: false })).route).toEqual({ kind: 'ignore', reason: 'not from a person' })
    const direct = await h.say(ANNA, 'add sessions', { addressed: 'direct', thread: 'mattermost:dm:anna' })
    expect(direct.route).toMatchObject({ kind: 'newJob', intake: { basis: 'direct', workflowId: 'delivery', actor: ANNA } })
    expect(h.wb.kernel.db.all("SELECT status, outcome FROM inbox_event WHERE status = 'ignored'")).toHaveLength(5)
  })

  it('loads a second workflow with its own stages and trigger rule, and intake picks it by its pattern (A6)', async () => {
    h.wb.register({ id: 'docs', version: 1, prompts: { write: 'Write the docs.' }, declaration: {
      title: 'Docs', start: 'write', triggers: [{ sources: ['mattermost'], on: ['mention'], pattern: '\\bdocs?\\b' }],
      stages: [{ id: 'write', title: 'Write', agentPreset: 'writer', permissionPreset: 'worker', egress: 'none', instructions: 'write',
        output: {}, limits: { turns: 5, tokens: 1000, wallClockMs: 60_000 } }],
      transitions: [{ from: 'write', to: COMPLETE }],
      budgets: { turns: 10, tokens: 10_000, backtracks: 0, extension: { turns: 5, tokens: 1000, attempts: 1, backtracks: 1 } } } })
    const docs = await h.start('@workbench update the docs')
    expect(h.state(docs).workflowId).toBe('docs')
    await h.complete(docs)
    expect(h.wb.kernel.db.get('SELECT workflow_id, status FROM job_summary WHERE job_id = ?', docs)).toEqual({ workflow_id: 'docs', status: 'completed' })
  })
})

describe('faults', () => {
  it('faults a job whose guard misbehaves, and still lets an approver cancel it', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    await h.complete(job)
    // After a restart, a buggy guard returns a string.
    await h.restart({ 'review.approved': () => 'yes' })
    const faulted = await h.complete(job, { approved: true })
    expect(faulted.outcome).toMatchObject({ kind: 'faulted', error: 'Guard review.approved returned string, not a boolean' })
    expect((await h.say(LEAD, 'go on')).submitted?.outcome).toMatchObject({ kind: 'rejected', reason: 'job is faulted' })
    await h.say(LEAD, 'stop')
    expect(h.state(job).status).toMatchObject({ kind: 'cancelled', by: LEAD })
  })
})

describe('reply order', () => {
  it('applies a gate\'s replies in the order they were posted, even when a later one is a quick approval', async () => {
    const job = await h.toApproval()
    h.verdicts.set('Ок, но добавь индекс', { verdict: 'request_changes', notes: 'add an index', confidence: 0.95 })
    // Both replies arrive before any verdict comes back.
    const say = (text: string) => {
      h.env.clock.advance(1000)
      const { event } = h.wb.kernel.inbox.append({ source: 'mattermost', externalId: text, threadKey: THREAD, actor: LEAD, human: true,
        payload: { kind: 'message', text, addressed: 'none', postedAt: h.env.clock.now() } })
      h.wb.handle(event)
    }
    say('Ок, но добавь индекс')
    say('ok')
    const gate = h.gate(job)!
    expect(gate.interpreting).toHaveLength(2)
    await h.settle()
    expect(h.running.get(h.attempt(job))!.payload).toMatchObject({ stageId: 'plan', entry: 'revision' })
    expect(h.outbound('approved')).toEqual([])
    // The later reply's verdict came after the gate closed, and is recorded as refused.
    expect(h.state(job).gates[gate.id]).toMatchObject({ interpreting: [], responses: [expect.objectContaining({ accepted: true, verdict: 'request_changes' }),
      expect.objectContaining({ accepted: false, reason: 'the gate was changes_requested before the verdict' })] })
  })
})
