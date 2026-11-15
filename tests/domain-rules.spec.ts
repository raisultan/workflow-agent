/** Policy roles (`T8.3`), the RU/EN vocabulary fast path (`T8.9`), the router (`T8.4`) and the projections (`T8.10`). */
import { afterEach, describe, expect, it } from 'vitest'
import { eligible, isWorkbench, policyVersion, type Actor, type Policy } from '../src/domain/policy.ts'
import { route, type BoundJob, type RouterLookups } from '../src/domain/router.ts'
import { hasQualifier, isClose, isRetry, isStandaloneApproval, matchCancel } from '../src/domain/vocabulary.ts'
import type { InboxEvent } from '../src/kernel/inbox.ts'
import { basePolicy, deliveryDeclaration, Harness, LEAD } from './fixtures/domain-workflow.ts'

const job = { workflowId: 'delivery', requester: { source: 'mattermost', id: 'anna' } }
const mm = (id: string): Actor => ({ source: 'mattermost', id })

describe('policy', () => {
  const policy = basePolicy()
  it.each([
    ['anna (requester, sender)', mm('anna'), { sender: true, approver: true, respondent: true }],
    ['ANNA (ids ignore case)', mm('ANNA'), { sender: true, approver: true, respondent: true }],
    ['lead (approver, sender)', mm('lead'), { sender: true, approver: true, respondent: true }],
    ['bob (sender only)', mm('bob'), { sender: true, approver: false, respondent: true }],
    ['eve (nobody)', mm('eve'), { sender: false, approver: false, respondent: false }],
    ['the workbench', mm('workbench'), { sender: false, approver: false, respondent: false }],
    ['anna on jira (another identity)', { source: 'jira', id: 'anna' }, { sender: true, approver: false, respondent: true }],
  ])('%s', (_name, actor, roles) => {
    expect({ sender: eligible(policy, actor, 'sender'), approver: eligible(policy, actor, 'approver', job),
      respondent: eligible(policy, actor, 'respondent', job) }).toEqual(roles)
  })

  it('never lets the workbench hold a role, even when listed', () => {
    const listed: Policy = { ...policy, senders: { mattermost: ['workbench'] }, approvers: { delivery: { mattermost: ['workbench'] } } }
    expect(isWorkbench(listed, mm('Workbench'))).toBe(true)
    expect(['sender', 'approver', 'respondent'].map(role => eligible(listed, mm('workbench'), role as 'sender', { ...job, requester: mm('workbench') }))).toEqual([false, false, false])
  })

  it('needs a job for job roles, and versions the policy by content', () => {
    expect(eligible(policy, mm('lead'), 'approver')).toBe(false)
    const reordered: Policy = { senders: { jira: ['anna'], mattermost: ['BOB', 'lead', 'anna'] }, approvers: { delivery: { mattermost: ['Lead'] } },
      bots: { mattermost: ['workbench'] } }
    expect(policyVersion(reordered)).toBe(policyVersion(policy))
    expect(policyVersion({ ...policy, senders: { mattermost: ['anna'] } })).not.toBe(policyVersion(policy))
  })
})

describe('vocabulary (ported RU/EN cases)', () => {
  it('matches standalone approvals and refuses qualified ones', () => {
    for (const token of ['ок', 'Окей!', 'аппрув', 'Аппрувлю', 'согласен', 'согласна', 'согласовано', 'подтверждаю', 'принято', 'годится', 'делай',
      'погнали', '+', '++', 'LGTM', 'approved', '/approve', '@workbench аппрув']) expect(isStandaloneApproval(token), token).toBe(true)
    for (const qualified of ['Ок, но переделай схему БД', 'Аппрув, только сначала добавь индекс', 'Согласен, кроме миграции таблицы users',
      'LGTM, but fix the timeout first']) {
      expect(isStandaloneApproval(qualified), qualified).toBe(false)
      expect(hasQualifier(qualified), qualified).toBe(true)
    }
    expect(isStandaloneApproval('@anna ok')).toBe(false)
    expect(isStandaloneApproval('@workbench @anna ok')).toBe(true)
    expect(isStandaloneApproval('@here ok')).toBe(true)
    expect(isStandaloneApproval('ok', ['wb'])).toBe(true)
    expect(isStandaloneApproval('@wb ok', ['wb'])).toBe(true)
  })

  it('matches command-shaped cancellations and retries only', () => {
    for (const command of ['cancel', '/cancel', 'Cancel!', 'abort.', 'stop', '/stop', 'отмена', 'Отмени!', 'отменить.', 'стоп', 'Стоп!', 'останови',
      'остановить', 'прекрати', '@workbench отмени!', '@bot Стоп.', '@workbench cancel']) expect(matchCancel(command), command).toBeDefined()
    for (const text of ['Cancel my previous comment', 'stop the migration step and use X instead', 'Отмени пункт 3 в плане', 'стоп-кран в коде не трогай',
      'не надо менять этот файл, остальное ок',
      // An answer in a question round ("is pagination needed?"), not a command.
      'не надо', 'не нужно']) expect(matchCancel(text), text).toBeUndefined()
    expect(matchCancel('/cancel no longer needed')).toEqual({ reason: 'no longer needed' })
    for (const command of ['закрой', 'Закрыть.', '@workbench закрой задачу', 'закрывай!', 'close', '@bot Close job', 'close it'])
      expect(isClose(command), command).toBe(true)
    // No slash form (a GitLab quick action), and a sentence is not a command.
    for (const text of ['/close', 'закрой тикет потом', 'не закрывай', 'можно закрыть?', 'close the door', 'стоп']) expect(isClose(text), text).toBe(false)
    for (const command of ['retry', '/retry', 'Retry!', 'повтори', 'Повтори.', 'повторить', 'перезапусти', 'перезапустить', 'заново', 'ещё раз', 'еще раз',
      'попробуй ещё раз', 'попробуй еще раз', '@workbench повтори!', '@bot /retry']) expect(isRetry(command), command).toBe(true)
    for (const text of ['retry logic should use exponential backoff', 'повтори этот шаг в тесте для второго воркера', 'заново создай таблицу в миграции']) {
      expect(isRetry(text), text).toBe(false)
    }
  })
})

describe('router', () => {
  const lookups = (over: Partial<RouterLookups> = {}): RouterLookups => ({
    bindings: () => [], openGate: () => undefined, policy: basePolicy(),
    workflows: [{ id: 'docs', version: 1, declaration: { triggers: [{ sources: ['mattermost'], on: ['mention'], pattern: 'docs' }] } },
      { id: 'delivery', version: 3, declaration: deliveryDeclaration() as never }],
    ...over,
  })
  const event = (over: Partial<InboxEvent> = {}, payload: object = { kind: 'message', text: 'hi', addressed: 'mention', postedAt: 5 }): InboxEvent => ({
    id: 'in_1', source: 'mattermost', externalId: 'p1', threadKey: 't1', actor: mm('anna'), human: true, receivedAt: 6, status: 'received', payload, ...over })
  const bound = (status: string, role: BoundJob['role'] = 'origin'): RouterLookups['bindings'] => () => [{ jobId: 'j1', role, status }]

  it.each([
    ['a malformed payload', event({}, { kind: 'message' }), lookups(), { kind: 'ignore', reason: 'malformed payload' }],
    ['a resume from a source', event({}, { kind: 'resume', jobId: 'j1' }), lookups(), { kind: 'ignore', reason: 'resume from outside the workbench' }],
    ['no thread', event({ threadKey: undefined }), lookups(), { kind: 'ignore', reason: 'no thread' }],
    ['the workbench\'s own post', event({ actor: mm('workbench') }), lookups(), { kind: 'ignore', reason: 'the workbench\'s own post' }],
    ['its own post on GitLab, by effect rows', event({ source: 'gitlab' }), lookups({ ownPost: () => true }), { kind: 'ignore', reason: 'the workbench\'s own post' }],
    ['a machine message', event({ human: false }), lookups(), { kind: 'ignore', reason: 'not from a person' }],
    ['no verified actor', event({ actor: undefined }), lookups(), { kind: 'ignore', reason: 'no verified actor' }],
    ['an unaddressed post', event({}, { kind: 'message', text: 'hi', addressed: 'none', postedAt: 5 }), lookups(), { kind: 'ignore', reason: 'not addressed to the workbench' }],
    ['a mention by a stranger', event({ actor: mm('eve') }), lookups(), { kind: 'ignore', reason: 'the sender may not start jobs' }],
    ['a mention on GitLab', event({ source: 'gitlab', actor: { source: 'gitlab', id: 'anna' } }),
      lookups({ policy: { ...basePolicy(), senders: { gitlab: ['anna'] } } }), { kind: 'ignore', reason: 'no workflow matches' }],
    ['a fact on an unbound thread', event({ human: false, actor: undefined }, { kind: 'fact', fact: 'mr_merged' }), lookups(),
      { kind: 'ignore', reason: 'a fact on a thread no active job is bound to' }],
    ['a fact on an ended job\'s thread', event({ human: false }, { kind: 'fact', fact: 'ci' }), lookups({ bindings: bound('cancelled') }),
      { kind: 'ignore', reason: 'a fact on a thread no active job is bound to' }],
  ])('ignores %s', (_name, input, look, expected) => {
    expect(route(input, look)).toEqual(expected)
  })

  it('sends a reply on an open gate\'s thread to the gate, even from a stranger (the job refuses it), and a fact never to a gate', () => {
    const gate = lookups({ openGate: () => ({ jobId: 'j1', gateId: 'g1' }), bindings: bound('awaiting_gate') })
    expect(route(event({ actor: mm('eve') }), gate)).toMatchObject({ kind: 'gateReply', jobId: 'j1', gateId: 'g1', message: { actor: mm('eve'), postedAt: 5 } })
    expect(route(event({ human: false }, { kind: 'fact', fact: 'ci', data: { status: 'success' } }), gate))
      .toEqual({ kind: 'machineFact', jobId: 'j1', fact: 'ci', threadKey: 't1', data: { status: 'success' } })
  })

  it('sends messages on a bound thread to its active job, a faulted one included, and on an MR thread to a completed job', () => {
    expect(route(event(), lookups({ bindings: bound('running') }))).toMatchObject({ kind: 'followUp', jobId: 'j1' })
    expect(route(event(), lookups({ bindings: bound('faulted') }))).toMatchObject({ kind: 'followUp', jobId: 'j1' })
    const mr = { threadKey: 'gitlab:acme/app!7' }
    expect(route(event(mr), lookups({ bindings: bound('completed', 'artifact') }))).toMatchObject({ kind: 'followUp', jobId: 'j1' })
    // A done job's ticket is no merge request: a comment there is routed like any other (D12), so a mention starts a new job.
    expect(route(event({ threadKey: 'jira:ORD-1' }), lookups({ bindings: bound('completed', 'artifact') }))).toMatchObject({ kind: 'newJob' })
    // A new mention on a finished job's origin thread starts a new job.
    expect(route(event(), lookups({ bindings: bound('completed') }))).toMatchObject({ kind: 'newJob' })
  })

  it('sends a close (закрой) on any thread of a finished job to it, preferring the newest job not closed yet', () => {
    const close = (threadKey: string) => event({ threadKey }, { kind: 'message', text: '@workbench закрой', addressed: 'mention', postedAt: 5 })
    expect(route(close('jira:ORD-1'), lookups({ bindings: bound('completed', 'artifact') }))).toMatchObject({ kind: 'followUp', jobId: 'j1' })
    expect(route(close('t1'), lookups({ bindings: bound('completed') }))).toMatchObject({ kind: 'followUp', jobId: 'j1' })
    // Newest first: j2 is closed, so j1, still open, takes the close; with both closed, the newest is told it is closed.
    const two = (closed: readonly (string | null)[]): RouterLookups['bindings'] => () =>
      [{ jobId: 'j2', role: 'artifact', status: 'completed', closedBy: closed[0] }, { jobId: 'j1', role: 'artifact', status: 'completed', closedBy: closed[1] }]
    expect(route(close('jira:ORD-1'), lookups({ bindings: two(['person', null]) }))).toMatchObject({ kind: 'followUp', jobId: 'j1' })
    expect(route(close('jira:ORD-1'), lookups({ bindings: two(['person', 'mr_merged']) }))).toMatchObject({ kind: 'followUp', jobId: 'j2' })
    // On a running job's thread it is that job's, as any message is.
    expect(route(close('t1'), lookups({ bindings: () => [{ jobId: 'j3', role: 'origin', status: 'running' }, { jobId: 'j1', role: 'origin', status: 'completed' }] })))
      .toMatchObject({ kind: 'followUp', jobId: 'j3' })
  })

  it('starts a job on a mention or a direct message, trying workflows in order, with an intake decision', () => {
    expect(route(event({}, { kind: 'message', text: 'update the docs', addressed: 'mention', postedAt: 5 }), lookups())).toMatchObject({ intake: { workflowId: 'docs' } })
    expect(route(event({}, { kind: 'message', text: 'update the docs', addressed: 'direct', postedAt: 5 }), lookups())).toEqual({ kind: 'newJob', intake: {
      eventId: 'in_1', actor: mm('anna'), threadKey: 't1', basis: 'direct', workflowId: 'delivery', workflowVersion: 3,
      policyVersion: policyVersion(basePolicy()), text: 'update the docs', postedAt: 5 } })
  })
})

describe('projections', () => {
  let h: Harness | undefined
  afterEach(() => { h?.cleanup(); h = undefined })

  it('keep binding, open_gate and job_summary current, and rebuilding them from job_event gives equal tables', async () => {
    h = new Harness()
    const job = await h.toApproval()
    const { db, projections } = h.wb.kernel
    expect(db.all('SELECT thread_key, role FROM binding')).toEqual([{ thread_key: 'mattermost:ch1:p1', role: 'origin' }])
    expect(db.all('SELECT job_id, kind FROM open_gate')).toEqual([{ job_id: job, kind: 'approval' }])
    expect(db.get('SELECT status, stage_id, detail FROM job_summary')).toEqual({ status: 'awaiting_gate', stage_id: 'plan', detail: 'approval' })
    await h.say(LEAD, 'ok')
    h.wb.action(job, h.attempt(job), { session: 's', id: 'mr' }, 'gitlab.createMr', {})
    await h.settle()
    await h.report(job, { outcome: 'blocked', reason: 'no access' })
    const tables = () => ['binding', 'open_gate', 'job_summary'].map(table => db.all(`SELECT * FROM ${table} ORDER BY 1, 2`))
    const before = tables()
    expect(before[2]).toEqual([expect.objectContaining({ status: 'blocked', stage_id: 'implement', detail: 'stage_blocked' })])
    for (const name of ['binding', 'open_gate', 'job_summary']) projections.rebuild(name)
    expect(tables()).toEqual(before)
  })
})

describe('policy wildcards', () => {
  it('lets "*" approvers be any allowed sender of that source, and never someone off the allowlist', () => {
    const policy: Policy = { ...basePolicy(), approvers: { delivery: { mattermost: ['*'] } } }
    expect(eligible(policy, mm('bob'), 'approver', job)).toBe(true)
    expect(eligible(policy, mm('eve'), 'approver', job)).toBe(false)
    expect(eligible(policy, { source: 'jira', id: 'anna' }, 'approver', job)).toBe(false)
  })
})
