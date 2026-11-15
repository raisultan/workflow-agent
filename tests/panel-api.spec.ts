/**
 * The supervision API (`T9.9`, `D13`) as the runtime serves it on the dashboard's own port: read-only, over V2 state: jobs (with
 * title, tokens and budget), a job's detail (its posts as sent and its attempts), an attempt's agent trace, health, inbox and settings,
 * with the deployment's secrets redacted; a review's notes and merge risk on an attempt's checks and the job's row (`P16`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WorkbenchRuntime } from '../src/app/workbench-runtime.ts'
import type { AgentTrace } from '../src/app/agent-trace.ts'
import { attempts, type EventRow, type JobDetail, type SettingsView, type StateView } from '../src/app/panel-api.ts'
import { mergeRisk } from '../src/adapters/merge-risk.ts'
import { Config, resolveConfig } from '../src/config.ts'
import { FakeDsh } from './fixtures/fake-dsh.ts'

let dir: string
let runtime: WorkbenchRuntime
let dsh: FakeDsh
const saved = { ...process.env }
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'panel-api-'))
  process.env.LITELLM_API_KEY = 'sk-very-secret-key'
  dsh = new FakeDsh()
  runtime = new WorkbenchRuntime(dsh.ctx, resolveConfig(Config({ stateDir: join(dir, 'state'), demo: true } as never), { LITELLM_MODEL: 'deepseek-flash' }),
    { dashboard: { host: '127.0.0.1', port: 0 }, dashboardAssets: join(dir, 'assets') })
  await runtime.ready
})
afterEach(async () => {
  await runtime.stop()
  process.env = { ...saved }
  rmSync(dir, { recursive: true, force: true })
})

/** One request to the dashboard's server, with exactly these headers. */
function request(path: string, { method = 'GET', headers = { host: 'localhost', 'x-workbench-dashboard': '1' } as Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: unknown }>((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port: runtime.dashboardPort!, path, method, headers }, res => {
      let text = ''
      res.setEncoding('utf8').on('data', chunk => { text += chunk }).on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) as unknown : undefined })
      })
    }).on('error', reject).end()
  })
}

async function settled(): Promise<string> {
  const { db } = runtime.workbench.kernel
  for (let wait = 0; wait < 100 && db.get<{ status: string }>('SELECT status FROM job_summary')?.status !== 'completed'; wait++) {
    await runtime.workbench.kernel.effects.dispatch()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return db.get<{ id: string }>('SELECT id FROM job')!.id
}

it('is served on its own port, read-only, to the page\'s own requests under a loopback name', async () => {
  expect(runtime.dashboardPort).toBeGreaterThan(0)
  expect((await request('/api/state', { headers: { host: 'evil.example:25410', 'x-workbench-dashboard': '1' } })).status).toBe(403)
  expect((await request('/api/state', { headers: { host: 'localhost' } })).status).toBe(403)
  expect(await request('/api/state', { method: 'POST' })).toMatchObject({ status: 405, headers: { allow: 'GET, HEAD' } })
  expect((await request('/api/nothing')).status).toBe(404)
  const state = (await request('/api/state')).body as StateView
  expect(state.health.runtime.dashboard).toMatchObject({ state: 'ready', detail: expect.stringContaining('Serving http://127.0.0.1:') })
})

it('names the people who wrote to it from the connector\'s cache of names, without asking Mattermost', async () => {
  const asked: string[] = []
  ;(runtime as unknown as { connectors: () => unknown }).connectors = () => ({ mattermost: { knownUsername: (id: string) => { asked.push(id); return id === 'u1seen' ? 'anna.k' : undefined } } })
  for (const id of ['u1seen', 'u2unseen']) {
    runtime.workbench.receive({ source: 'mattermost', externalId: `post-${id}`, threadKey: 'mattermost:ch:root', human: true, actor: { source: 'mattermost', id },
      payload: { kind: 'message', text: 'hello', addressed: 'none', postedAt: 1 } })
  }
  runtime.workbench.receive({ source: 'jira', externalId: 'c1', threadKey: 'jira:ORD-1', human: true, actor: { source: 'jira', id: 'dev' },
    payload: { kind: 'message', text: 'hello', addressed: 'none', postedAt: 1 } })
  expect(((await request('/api/state')).body as StateView).people).toEqual({ u1seen: 'anna.k' })
  expect(asked.sort()).toEqual(['u1seen', 'u2unseen'])
})

it('says it serves on loopback when it listens on every address, as its log line does', async () => {
  const other = new WorkbenchRuntime(new FakeDsh().ctx, resolveConfig(Config({ stateDir: join(dir, 'state-any'), demo: true } as never), { LITELLM_MODEL: 'deepseek-flash' }),
    { dashboard: { host: '0.0.0.0', port: 0 }, dashboardAssets: join(dir, 'assets') })
  try {
    await other.ready
    expect(other.panelHost().health().dashboard).toMatchObject({ state: 'ready', detail: `Serving http://127.0.0.1:${other.dashboardPort!}/` })
  } finally { await other.stop() }
})

it('lists jobs with title, tokens and budget, and shows a job\'s detail: manifest, posts as sent, attempts, events and threads', async () => {
  const id = await settled()
  const state = (await request('/api/state')).body as StateView
  expect(state).toMatchObject({ locale: 'en', demo: true, people: {}, links: {} })
  expect(state.tokensToday).toBeGreaterThanOrEqual(0)
  expect(state.jobs).toEqual([expect.objectContaining({ id, workflowId: 'synthetic-hotfix', status: 'completed', requester: 'demo:demo-requester', gateThread: null,
    ticket: null, mergeRequest: null, waiting: null, title: expect.stringContaining('hotfix'), tokens: expect.any(Number), budget: expect.any(Number) })])
  expect(state.jobs[0]!.budget).toBeGreaterThan(0)
  const detail = (await request(`/api/jobs/${id}`)).body as JobDetail
  expect(detail.manifest).toMatchObject({ definition: 'synthetic-hotfix@2', verdictModel: 'litellm/deepseek-flash', parameters: { testCommand: 'true' },
    budgets: { tokens: expect.any(Number), turns: expect.any(Number) } })
  expect(detail.manifest.stages.map(stage => stage.id)).toEqual(['triage', 'patch', 'notes'])
  expect(detail.events.map(event => event.type)).toEqual(expect.arrayContaining(['JobStarted', 'AttemptStarted', 'GateOpened', 'GateClosed', 'JobCompleted']))
  expect(detail.artifacts).toEqual([expect.objectContaining({ kind: 'rollout-notes', n: 1, text: expect.stringContaining('Rollout notes') })])
  expect(detail.outbound.length).toBe(detail.effects.filter(effect => effect.kind === 'post').length)
  expect(detail.outbound.every(post => post.status === 'succeeded' && typeof post.text === 'string' && post.text.length > 0)).toBe(true)
  // The text as posted, kept on the post's result: what people saw, whatever the wording or the job's data become (2026-11-15).
  expect(detail.outbound.every(post => post.recorded)).toBe(true)
  expect(detail.outbound.map(post => post.text)).toEqual(detail.effects.filter(effect => effect.kind === 'post').map(effect => (effect.result as { ok: { text: string } }).ok.text))
  expect(detail.attempts.map(attempt => attempt.stageId)).toEqual(['triage', 'patch', 'notes'])
  expect(detail.attempts[0]).toMatchObject({ n: 1, entry: 'initial', running: false, outcome: 'completed', sessionId: `wb-${id}-a1`.replace(/[^A-Za-z0-9_-]/gu, '-') })
  expect(detail.communication.map(message => message.text)).toEqual([expect.stringContaining('hotfix'), 'ok'])
  expect(detail.egress).toEqual([])
  expect((await request('/api/jobs/nope')).status).toBe(404)
})

it('reads an attempt\'s agent trace from its DSH session, redacted, and says when there is none', async () => {
  const id = await settled()
  const attempt = ((await request(`/api/jobs/${id}`)).body as JobDetail).attempts[0]!
  dsh.sessionsMustExist = true
  const missing = (await request(`/api/jobs/${id}/attempts/${attempt.id}/trace`)).body as AgentTrace
  expect(missing).toMatchObject({ sessionId: attempt.sessionId, steps: [], unavailable: { reason: 'missing' } })
  dsh.sessionLogs.set(attempt.sessionId, [
    { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'my key is sk-very-secret-key' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] } } },
    { type: 'tool/result', seq: 2, time: 2, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'README.md' }] } } },
  ])
  const trace = (await request(`/api/jobs/${id}/attempts/${attempt.id}/trace`)).body as AgentTrace
  expect(trace.steps).toEqual([expect.objectContaining({ kind: 'text', text: 'my key is [REDACTED]' }),
    expect.objectContaining({ kind: 'tool', name: 'bash', args: { command: 'ls' }, result: 'README.md' })])
  expect((await request(`/api/jobs/${id}/attempts/${id}.a99/trace`)).status).toBe(404)
  expect((await request(`/api/jobs/nope/attempts/${attempt.id}/trace`)).status).toBe(404)
})

it('redacts a secret a cut ended, as well as a whole one', async () => {
  const { redact } = await import('../src/app/panel-api.ts')
  const secret = 'glpat-0123456789abcdef'
  expect(redact({ a: `token ${secret} and ${secret.slice(0, 12)}…`, b: `${secret.slice(0, 4)}…` }, [secret]))
    .toEqual({ a: 'token [REDACTED] and [REDACTED]…', b: 'glpa…' })
  // Three dots cut text too, and a URL carries the secret encoded.
  expect(redact({ a: `${secret.slice(0, 9)}... and ${secret.slice(0, 5)}...` }, [secret])).toEqual({ a: `[REDACTED]... and ${secret.slice(0, 5)}...` })
  const odd = 'p@ss/word+1 2'
  expect(redact({ url: `https://git.example.test/?token=${encodeURIComponent(odd)}&x=1`, raw: `is ${odd}`, cut: `${encodeURIComponent(odd).slice(0, 10)}…` }, [odd]))
    .toEqual({ url: 'https://git.example.test/?token=[REDACTED]&x=1', raw: 'is [REDACTED]', cut: '[REDACTED]…' })
})

it('redacts strings only: keys, numbers and the structure stay as they are', async () => {
  const { redact } = await import('../src/app/panel-api.ts')
  // A secret of digits inside a timestamp, and one equal to a key and a common word: the JSON is never rewritten as text.
  const value = { at: 1794582273000, status: 'status', n: 582273, nested: [{ status: 'the status is 582273', ok: true, none: null }], quote: 'say "582273"\n\\' }
  const redacted = redact(value, ['582273', 'status', 'true', 'null'])
  expect(redacted).toEqual({ at: 1794582273000, status: '[REDACTED]', n: 582273, nested: [{ status: 'the [REDACTED] is [REDACTED]', ok: true, none: null }],
    quote: 'say "[REDACTED]"\n\\' })
  expect(JSON.parse(JSON.stringify(redacted))).toEqual(redacted)
  // A secret with characters JSON escapes is found in the value itself.
  expect(redact({ a: 'x "quoted\\secret" y' }, ['"quoted\\secret"'])).toEqual({ a: 'x [REDACTED] y' })
  expect(redact({ a: 'short' }, ['short', ''])).toEqual({ a: 'short' })
  expect(redact('plain sk-very-secret-key', ['sk-very-secret-key'])).toBe('plain [REDACTED]')
})

it('names who decides a gate as the policy rules it: the repository\'s approvers alone, else the requester, the approvers and any sender', () => {
  const host = runtime.panelHost()
  // The demo's policy: both demo users are senders, and `demo-lead` approves.
  expect(host.deciders('synthetic-hotfix', null, { source: 'demo', id: 'demo-requester' })).toEqual(['demo-requester', 'demo-lead'])
  expect(host.deciders('synthetic-hotfix', null, { source: 'demo', id: 'demo-lead' })).toEqual(['demo-lead'])
  // A requester no longer an allowed sender decides nothing.
  expect(host.deciders('synthetic-hotfix', null, { source: 'demo', id: 'gone' })).toEqual(['demo-lead'])
  const policy = { senders: { jira: ['anna', 'bob'] }, bots: {}, approvers: { delivery: { jira: ['lead', '*'] }, strict: { jira: ['lead'] } },
    repositoryApprovers: { 'orders-api': { jira: ['owner'] }, unresolved: {} } }
  ;(runtime as unknown as { policy: () => unknown }).policy = () => policy
  const anna = { source: 'jira', id: 'anna' }
  // `*` is any allowed sender, the requester among them.
  expect(host.deciders('delivery', null, anna)).toEqual(['lead', '*'])
  expect(host.deciders('strict', null, anna)).toEqual(['anna', 'lead'])
  expect(host.deciders('other', null, anna)).toEqual(['anna'])
  // A repository that lists approvers is decided by them alone, even before their names resolve.
  expect(host.deciders('delivery', 'orders-api', anna)).toEqual(['owner'])
  expect(host.deciders('delivery', 'unresolved', anna)).toEqual([])
  expect(host.deciders('strict', 'elsewhere', anna)).toEqual(['anna', 'lead'])
})

it('shows the effective settings with where they come from, and redacts the deployment\'s secrets', async () => {
  const settings = (await request('/api/settings')).body as SettingsView
  expect(settings).toMatchObject({ models: { default: 'litellm/deepseek-flash', from: expect.stringContaining('profile') }, maxWorkers: 2, demo: true,
    workflows: [expect.objectContaining({ id: 'synthetic-hotfix', version: 2, budgets: expect.objectContaining({ tokens: expect.any(Number) }) })],
    links: { from: expect.stringContaining('dashboard.links') } })
  runtime.workbench.receive({ source: 'demo', externalId: 'leak', threadKey: 'demo:9', human: true, actor: { source: 'demo', id: 'x' },
    payload: { kind: 'message', text: 'my key is sk-very-secret-key', addressed: 'none', postedAt: 1 } })
  const inbox = (await request('/api/inbox')).body as { messages: { text: string }[] }
  expect(inbox.messages[0]!.text).toBe('my key is [REDACTED]')
})

it('says what a job waits for, from whom and where, read from its open gate (A3)', async () => {
  const { Harness } = await import('./fixtures/domain-workflow.ts')
  const { jobs } = await import('../src/app/panel-api.ts')
  const h = new Harness()
  try {
    const job = await h.toApproval()
    const [row] = jobs({ workbench: h.wb, deciders: () => ['lead'], ticketTitle: () => undefined }, 200, job)
    // However many newer jobs there are, one still in play stays on the list.
    expect(jobs({ workbench: h.wb, deciders: () => [], ticketTitle: () => undefined }, 0).map(listed => listed.id)).toEqual([job])
    expect(row).toMatchObject({ status: 'awaiting_gate', title: 'add sessions', ticket: null,
      waiting: { kind: 'approval', subject: 'plan r1', who: ['lead'], thread: 'mattermost:ch1:p1', since: expect.any(Number) } })
    expect(row!.stages.map(stage => stage.id)).toEqual(['inspect', 'plan', 'implement', 'review'])
    expect(row!.budget).toBeGreaterThan(0)
  } finally { h.cleanup() }
})

it('says who answers a question round: anyone in the thread where the workflow has places, the allowed senders elsewhere', async () => {
  const { delivery, Harness } = await import('./fixtures/domain-workflow.ts')
  const { jobs } = await import('../src/app/panel-api.ts')
  const asked: { source: string; id: string }[] = []
  const waitingOf = async (h: InstanceType<typeof Harness>) => {
    try {
      const job = await h.start()
      await h.settle()
      await h.report(job, { outcome: 'question', items: [{ text: 'TTL?' }, { text: 'Where?' }] })
      return jobs({ workbench: h.wb, deciders: (_workflow, _repository, requester) => { asked.push(requester); return ['lead'] }, ticketTitle: () => undefined }, 200, job)[0]!.waiting
    } finally { h.cleanup() }
  }
  expect(await waitingOf(new Harness())).toMatchObject({ kind: 'question', subject: '0/2', who: ['*'] })
  expect(await waitingOf(new Harness({ workflows: [delivery(1, declaration => { declaration.places = { clarification: 'chat', plan: 'ticket', code: 'mergeRequest' } })] })))
    .toMatchObject({ kind: 'question', subject: '0/2', who: [] })
  // A question round asks nobody's approval.
  expect(asked).toEqual([])
})

it('passes the requester to whoever names the deciders, and lists a job whose workflow is no longer registered', async () => {
  const { ANNA, Harness } = await import('./fixtures/domain-workflow.ts')
  const { jobs } = await import('../src/app/panel-api.ts')
  const h = new Harness()
  try {
    const job = await h.toApproval()
    const asked: unknown[] = []
    const host = { workbench: h.wb, deciders: (...args: unknown[]) => { asked.push(args); return [] }, ticketTitle: () => undefined }
    jobs(host, 200, job)
    expect(asked).toEqual([['delivery', null, ANNA]])
    // A parked job's workflow may be gone from this deployment: the list still shows the job, without stages or a budget.
    const broken = Object.create(h.wb, { workflow: { value: () => { throw new Error('No definition delivery@1') } } }) as typeof h.wb
    expect(jobs({ ...host, workbench: broken }, 200, job)).toEqual([expect.objectContaining({ id: job, status: 'awaiting_gate', stages: [], budget: 0,
      waiting: expect.objectContaining({ kind: 'approval' }) })])
  } finally { h.cleanup() }
})

it('says who must decide a pending proposal and where, on a job that runs on and after it completes (D12)', async () => {
  const { delivery, Harness } = await import('./fixtures/domain-workflow.ts')
  const { jobs } = await import('../src/app/panel-api.ts')
  const h = new Harness({ workflows: [delivery(1, declaration => {
    declaration.places = { clarification: 'chat', plan: 'ticket', code: 'mergeRequest' }
    declaration.stages[0]!.tools = ['jira.link']
    declaration.transitions = declaration.transitions.map(transition => transition.from === 'implement' ? { from: 'implement', to: '$complete' } : transition)
    declaration.reopen = { stage: 'review', requirements: 'plan' }
  })] })
  try {
    h.policy = { ...h.policy, approvers: { delivery: { mattermost: ['lead'], jira: ['lead'], gitlab: ['lead'] } } }
    const lead = { source: 'jira', id: 'lead' }
    const job = await h.start()
    h.wb.action(job, h.attempt(job), { session: 's', id: 'link' }, 'jira.link', { issueKey: 'ORD-1' })
    await h.settle()
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, {}, 'Plan r1')
    await h.say(lead, 'ok', { thread: 'jira:ORD-1' })
    h.wb.action(job, h.attempt(job), { session: 's', id: 'mr' }, 'gitlab.createMr', {})
    await h.settle()
    const row = () => jobs({ workbench: h.wb, deciders: () => ['lead'], ticketTitle: () => undefined }, 200, job)[0]!
    expect(row()).toMatchObject({ status: 'running', waiting: null, proposals: null })
    h.followUps.set('add a sku filter', 'changes_requirements')
    await h.say({ source: 'gitlab', id: 'anna' }, 'add a sku filter', { thread: 'gitlab:group/app!1', source: 'gitlab' })
    // The job runs on; the approvers are asked in the ticket.
    expect(row()).toMatchObject({ status: 'running', waiting: null, proposals: { kind: 'proposal', subject: '1', who: ['lead'], thread: 'jira:ORD-1', since: expect.any(Number) } })
    await h.complete(job)
    expect(row()).toMatchObject({ status: 'completed', waiting: null, proposals: { kind: 'proposal', subject: '1', thread: 'jira:ORD-1' } })
    // A finished job with a proposal before the approvers stays on the list past the newest `limit` (it waits on people).
    await h.start('@workbench another one')
    expect(jobs({ workbench: h.wb, deciders: () => ['lead'], ticketTitle: () => undefined }, 1).map(listed => listed.id)).toContain(job)
    h.verdicts.set('нет', { verdict: 'approve', confidence: 0.95, proposals: [{ id: 'p1', accept: false }] })
    await h.say(lead, 'нет', { thread: 'jira:ORD-1' })
    expect(row()).toMatchObject({ status: 'completed', proposals: null })
  } finally { h.cleanup() }
})

it('carries a review\'s notes and merge risk on the attempt\'s check, and the passed review\'s risk on the job\'s row (P16)', async () => {
  const id = await settled()
  const good = { verdict: 'good', gaps: [] }
  const risk = mergeRisk({ alignment: good, impact: { verdict: 'medium', gaps: ['the shared formatter'] }, verification: { verdict: 'decent', gaps: ['no test under one rouble'] },
    rollback: { verdict: 'low' }, errors: { verdict: 'n/a' } }, ['pyproject.toml', 'notify/refund.py'], '5713515a')!
  expect(risk).toMatchObject({ level: 'medium', floor: ['dependencies'] })
  const notes = '- (unverified important: it gives no evidence) notify/refund.py: rounded twice'
  // The rows are read from the events: a failed review has no risk, a passed one has both; a risk that is not the host's shape is left out.
  const event = (seq: number, type: string, data: Record<string, unknown>): EventRow => ({ seq, type, at: seq, causation: 'test', data })
  const [attempt] = attempts([event(1, 'AttemptStarted', { attemptId: 'j.a1', stageId: 'implement', n: 1, entry: 'initial' }),
    event(2, 'CheckCompleted', { attemptId: 'j.a1', checkId: 'tests', outcome: 'passed', evidence: '3 passed' }),
    event(3, 'CheckCompleted', { attemptId: 'j.a1', checkId: 'review', outcome: 'failed', evidence: 'review: changes\n1. [important] a.py:3: wrong', notes }),
    event(4, 'CheckCompleted', { attemptId: 'j.a1', checkId: 'review', outcome: 'passed', evidence: 'review: pass', notes, risk }),
    event(5, 'CheckCompleted', { attemptId: 'j.a1', checkId: 'review', outcome: 'passed', evidence: 'review: pass', risk: { level: 'severe' } })],
  { status: { kind: 'completed' } } as never)
  expect(attempt!.checks).toEqual([{ id: 'tests', outcome: 'passed', evidence: '3 passed', at: 2 },
    { id: 'review', outcome: 'failed', evidence: 'review: changes\n1. [important] a.py:3: wrong', at: 3, notes },
    { id: 'review', outcome: 'passed', evidence: 'review: pass', at: 4, notes, risk },
    { id: 'review', outcome: 'passed', evidence: 'review: pass', at: 5 }])
  // The row: null with no review, then the risk of the last attempt's passed review, as the state keeps it.
  const jobs = async () => ((await request('/api/state')).body as StateView).jobs
  expect((await jobs())[0]!.risk).toBeNull()
  const { db } = runtime.workbench.kernel
  const withChecks = (checks: unknown) => { db.run('UPDATE job SET state = json_set(state, \'$.attempt.checks\', json(?)) WHERE id = ?', JSON.stringify(checks), id) }
  withChecks({ tests: { outcome: 'passed', evidence: '3 passed' }, review: { outcome: 'failed', evidence: 'review: changes', risk } })
  expect((await jobs())[0]!.risk).toBeNull()
  withChecks({ tests: { outcome: 'passed', evidence: '3 passed' }, review: { outcome: 'passed', evidence: 'review: pass', notes, risk } })
  expect((await jobs())[0]!.risk).toEqual(risk)
  expect(((await request(`/api/jobs/${id}`)).body as JobDetail).job.risk).toMatchObject({ level: 'medium', commit: '5713515a', sensitive: [{ area: 'dependencies', files: ['pyproject.toml'] }] })
})
