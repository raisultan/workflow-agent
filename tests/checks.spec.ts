/** Checks that let a stage finish (`T9.13`): a confined command in the worktree, and GitLab CI for the pushed commit. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approvedPlan, checkHandler, followUpsSince, lastMergeRequest, lastPushedSha, serviceFailure } from '../src/adapters/checks.ts'
import { redactCredentials } from '../src/infra/redact.ts'
import { WorkDiffError, type DiffFile, type WorkDiff } from '../src/adapters/work-diff.ts'
import { standardDelivery } from '../src/workflows/standard-delivery.ts'
import { FakeLlm, llmContext } from './fixtures/fake-llm.ts'
import type { CheckPayload } from '../src/domain/job.ts'
import { GitLabConnector } from '../src/sources/gitlab.ts'
import { Harness, LEAD } from './fixtures/domain-workflow.ts'

let h: Harness
const runs: { argv: readonly string[]; cwd: string }[] = []
let exitCodes: Record<string, number | null> = {}
let outputs: Record<string, string> = {}
beforeEach(() => {
  h = new Harness({ without: ['check'] })
  runs.length = 0
  exitCodes = {}
  outputs = {}
  h.wb.kernel.effects.register('check', checkHandler({ workbench: h.wb, worktree: job => `/work/${job}`, repository: () => 'group/app', gitlab: () => undefined,
    run: async ({ argv, cwd }) => {
      runs.push({ argv, cwd })
      const command = argv[2]!
      return { exitCode: exitCodes[command] ?? 0, output: outputs[command] ?? `$ ${command}\n${'line\n'.repeat(1000)}${exitCodes[command] ? 'FAIL auth.spec' : 'ok'}` }
    } }))
})
afterEach(() => { h.cleanup() })

async function implementing(): Promise<string> {
  const job = await h.toApproval()
  await h.say(LEAD, 'ok')
  return job
}
async function settle(harness: Harness): Promise<void> {
  for (let pass = 0; pass < 10; pass++) { await harness.wb.kernel.effects.dispatch(); await new Promise(resolve => setTimeout(resolve, 2)) }
}
const settleChecks = () => settle(h)

describe('command checks', () => {
  it('pass on exit 0 in the job\'s worktree, so the stage moves on', async () => {
    const job = await implementing()
    await h.complete(job)
    await settleChecks()
    // The optional lint check names no command, so it cannot run; being optional, it does not hold the stage.
    expect(runs).toEqual([{ argv: ['sh', '-c', 'pnpm test'], cwd: `/work/${job}` }])
    const checks = h.wb.kernel.engine.events(job).filter(event => event.type === 'CheckCompleted')
    expect(checks).toHaveLength(2)
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: 'tests', outcome: 'passed' }),
      expect.objectContaining({ checkId: 'lint', outcome: 'blocked', evidence: expect.stringContaining('check lint is misconfigured') })]))
    expect(h.state(job).attempt!.stageId).toBe('review')
  })

  it('fail the attempt on a non-zero exit with its log stored and its tail as evidence; an optional check only records', async () => {
    const job = await implementing()
    exitCodes['pnpm test'] = 1
    await h.complete(job)
    await settleChecks()
    expect(h.state(job).attempt).toMatchObject({ stageId: 'implement', entry: 'retry' })
    const evidence = h.wb.kernel.engine.events(job).flatMap(event => event.type === 'CheckCompleted' && event.checkId === 'tests' ? [event.evidence] : [])[0]!
    expect(evidence).toMatch(/^pnpm test: exit 1; log [0-9a-f]{64}\n…/u)
    expect(evidence.endsWith('FAIL auth.spec')).toBe(true)
    expect(evidence.length).toBeLessThan(3200)
    const digest = /log ([0-9a-f]{64})/u.exec(evidence)![1]!
    expect(h.wb.kernel.blobs.text(digest)).toContain('$ pnpm test\n')
  })
})

describe('a test service that did not start (T12.5)', () => {
  it('blocks the check with the launcher\'s report, instead of failing the agent\'s work', async () => {
    const job = await implementing()
    exitCodes['pnpm test'] = 1
    outputs['pnpm test'] = `${'collected 12 items\n'.repeat(200)}workbench-services: postgres did not start: it exited (status 1)\nFATAL: could not create shared memory\n` +
      'E   psycopg.OperationalError: connection closed\n'
    await h.complete(job)
    await settleChecks()
    const evidence = h.wb.kernel.engine.events(job).flatMap(event => event.type === 'CheckCompleted' && event.checkId === 'tests' ? [`${event.outcome}: ${event.evidence}`] : [])[0]!
    expect(evidence).toMatch(/^blocked: pnpm test: exit 1, because a test service did not start; log [0-9a-f]{64}\nworkbench-services: postgres did not start: it exited \(status 1\)\nFATAL: could not create shared memory/u)
    expect(h.state(job).status.kind).toBe('blocked')
    // The end of the log is kept too: the line could have been printed by the agent's own code, and a person decides (review).
    expect(evidence).toContain('--- end of the log:\n')
    expect(evidence.endsWith('E   psycopg.OperationalError: connection closed')).toBe(true)
  })

  it('fails as usual when the line is only quoted in the output, not at a line\'s start, or the command passed', async () => {
    expect(serviceFailure('echo "workbench-services: kafka did not start"\n')).toBeUndefined()
    expect(serviceFailure('workbench-services: kafka did not start: it exited (status 1)\n')).toBe('workbench-services: kafka did not start: it exited (status 1)\n')
    const job = await implementing()
    exitCodes['pnpm test'] = 1
    outputs['pnpm test'] = 'print("workbench-services: x did not start")\nFAIL\n'
    await h.complete(job)
    await settleChecks()
    expect(h.state(job).attempt).toMatchObject({ stageId: 'implement', entry: 'retry' })
  })
})

describe('GitLab CI checks', () => {
  type Pipeline = { status: string; jobs?: { id: number; name: string; status: string; log: string }[] }
  const pipelines: (Pipeline | 'error')[] = []
  let current: Pipeline | undefined
  let clock = 0
  const requests: string[] = []
  const gitlab = new GitLabConnector({ baseUrl: 'http://gl', token: 'glpat-secret', maxRetries: 0, fetchImpl: (async (url: string | URL) => {
    const parsed = new URL(String(url))
    requests.push(`${parsed.pathname}${parsed.search}`)
    const jobs = /\/pipelines\/9\/jobs$/u.exec(parsed.pathname)
    if (jobs) return new Response(JSON.stringify((current?.jobs ?? []).map(job => ({ id: job.id, name: job.name, stage: 'test', status: job.status,
      web_url: `http://gl/jobs/${job.id}` }))), { status: 200 })
    const trace = /\/jobs\/(\d+)\/trace$/u.exec(parsed.pathname)
    if (trace) return new Response(current?.jobs?.find(job => job.id === Number(trace[1]))?.log ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    const sha = parsed.searchParams.get('sha')
    const next = pipelines.shift()
    if (next === 'error') return new Response('{"message":"502 Bad Gateway"}', { status: 502 })
    current = next
    return new Response(JSON.stringify(current ? [{ id: 9, status: current.status, web_url: `http://gl/p/9?sha=${sha}` }] : []), { status: 200 })
  }) as typeof fetch })
  const handler = (options: { gitlab?: GitLabConnector | undefined } = {}) => checkHandler({ workbench: h.wb, worktree: () => '/w', repository: () => 'group/app',
    gitlab: () => 'gitlab' in options ? options.gitlab : gitlab, run: async () => ({ exitCode: 0, output: '' }), ciPollMs: 1000, ciStartMs: 2000, ciLimitMs: 3000,
    now: () => clock })
  const payload = (job: string): CheckPayload => ({ jobId: job, manifestId: 'm', attemptId: `${job}.a5`, stageId: 'implement', check: { id: 'ci', kind: 'gitlab-ci', params: {} } })
  const pushed = (job: string, sha: string) => h.wb.kernel.db.run(`INSERT INTO effect (id, job_id, kind, idempotency_key, payload, status, attempts, due_at, result, seq)
    VALUES (?, ?, 'action', ?, ?, 'succeeded', 1, 0, ?, 999)`, `ef_${sha.slice(0, 4)}`, job, `k-${sha}`,
  JSON.stringify({ action: 'gitlab.push', payload: { branch: 'agent/x-y', sha } }), JSON.stringify({ ok: { branch: 'agent/x-y', sha } }))
  beforeEach(() => { pipelines.length = 0; requests.length = 0; current = undefined; clock = 0 })

  it('fail with no pushed commit, wait while the pipeline runs, and pass on success', async () => {
    const job = await h.start()
    expect(await handler().run(payload(job), 'k', 1)).toEqual({ ok: { outcome: 'failed', evidence: 'no commit was pushed, so CI has nothing to run' } })
    const sha = 'c'.repeat(40)
    pushed(job, sha)
    expect(lastPushedSha(h.wb, job)).toBe(sha)
    pipelines.push({ status: 'running' }, { status: 'success' })
    expect(await handler().run(payload(job), 'k', 1)).toEqual({ retry: { afterMs: 1000, reason: 'CI running' } })
    expect(await handler().run(payload(job), 'k', 2)).toEqual({ ok: { outcome: 'passed', evidence: `CI success for cccccccccccc: http://gl/p/9?sha=${sha}` } })
  })

  it('fail a failed pipeline with the end of each failed job\'s log, colour codes removed and credentials hidden (T10.5)', async () => {
    const job = await h.start()
    pushed(job, 'e'.repeat(40))
    const noise = 'npm test\n'.repeat(2000)
    pipelines.push({ status: 'failed', jobs: [
      { id: 31, name: 'unit', status: 'failed', log: `section_start:1:step_script\r\u001b[0K${noise}\u001b[31mFAIL auth.spec: expected 200\u001b[0m\nDB_PASSWORD=hunter2 glpat-secret\nnpm error 401 ghp_${'a'.repeat(36)} AKIAIOSFODNN7EXAMPLE\n` },
      { id: 32, name: 'lint', status: 'failed', log: 'eslint: 3 problems\n' },
    ] })
    const result = await handler().run(payload(job), 'k', 1) as { ok: { outcome: string; evidence: string } }
    expect(result.ok.outcome).toBe('failed')
    const { evidence } = result.ok
    expect(evidence).toMatch(/^CI failed for eeeeeeeeeeee: http:\/\/gl\/p\/9/u)
    expect(evidence).toContain('--- test/unit failed: http://gl/jobs/31\n…')
    expect(evidence).toContain('FAIL auth.spec: expected 200')
    expect(evidence).toContain('--- test/lint failed: http://gl/jobs/32\neslint: 3 problems')
    expect(evidence).not.toMatch(/\u001b|section_start|hunter2|glpat-secret|ghp_a|AKIAIOSFODNN7EXAMPLE/u)
    expect(evidence).toContain('DB_PASSWORD=[REDACTED]')
    expect(evidence.length).toBeLessThanOrEqual(3000)
    expect(requests).toContain('/api/v4/projects/group%2Fapp/pipelines/9/jobs?scope[]=failed&per_page=20')
  })

  it('block when no pipeline starts within the start window, or one runs past the time limit, measured in wall-clock time (T10.5)', async () => {
    const job = await h.start()
    pushed(job, 'd'.repeat(40))
    const ci = handler()
    expect(await ci.run(payload(job), 'k', 1)).toEqual({ retry: { afterMs: 1000, reason: 'waiting for a CI pipeline' } })
    // Many polls in little time do not use up the window (final review): only the clock does.
    clock = 1500
    expect(await ci.run(payload(job), 'k', 9)).toEqual({ retry: { afterMs: 1000, reason: 'waiting for a CI pipeline' } })
    clock = 2000
    expect(await ci.run(payload(job), 'k', 10)).toEqual({ ok: { outcome: 'blocked',
      evidence: `no CI pipeline started for dddddddddddd within 0 min; does the repository have CI?` } })
    pipelines.push({ status: 'pending' })
    clock = 2500
    expect(await ci.run(payload(job), 'k', 11)).toEqual({ retry: { afterMs: 1000, reason: 'CI pending' } })
    pipelines.push({ status: 'pending' })
    clock = 3000
    expect(await ci.run(payload(job), 'k', 12)).toEqual({ ok: { outcome: 'blocked',
      evidence: `CI did not finish in time (still pending after 0 min): http://gl/p/9?sha=${'d'.repeat(40)}` } })
  })

  it('retries a GitLab error within the window, and blocks only when the window runs out on it (final review)', async () => {
    const job = await h.start()
    pushed(job, 'a'.repeat(40))
    const ci = handler()
    pipelines.push('error', { status: 'success' })
    expect(await ci.run(payload(job), 'k', 1)).toEqual({ retry: { afterMs: 1000, reason: expect.stringContaining('GitLab could not be read') } })
    expect(await ci.run(payload(job), 'k', 2)).toMatchObject({ ok: { outcome: 'passed' } })
    pipelines.push('error')
    clock = 3000
    expect(await ci.run(payload(job), 'k', 3)).toMatchObject({ ok: { outcome: 'blocked', evidence: expect.stringContaining('GitLab could not be read') } })
  })

  it('block on a cancelled pipeline, without GitLab or a repository, and refuse an unknown check kind (T10.5)', async () => {
    const job = await h.start()
    pushed(job, 'f'.repeat(40))
    pipelines.push({ status: 'canceled' })
    expect(await handler().run(payload(job), 'k', 1)).toMatchObject({ ok: { outcome: 'blocked', evidence: expect.stringContaining('CI canceled') } })
    expect(await handler({ gitlab: undefined }).run(payload(job), 'k', 1)).toEqual({ ok: { outcome: 'blocked', evidence: 'GitLab is not configured, so CI cannot be checked' } })
    expect(await handler().run({ ...payload(job), check: { id: 'x', kind: 'sonar', params: {} } }, 'k', 1)).toEqual({ fail: 'no check runs kind sonar' })
  })
})

describe('lastMergeRequest', () => {
  it('names the merge request the job opened or updated last (T10.6)', async () => {
    const job = await h.start()
    expect(lastMergeRequest(h.wb, job)).toBeUndefined()
    const write = (seq: number, action: string, status: string, url: string) => h.wb.kernel.db.run(`INSERT INTO effect (id, job_id, kind, idempotency_key, payload,
      status, attempts, due_at, result, seq) VALUES (?, ?, 'action', ?, ?, ?, 1, 0, ?, ?)`, `ef_${seq}`, job, `k${seq}`, JSON.stringify({ action, payload: {} }), status,
    JSON.stringify({ ok: { webUrl: url } }), seq)
    write(900, 'gitlab.createMr', 'succeeded', 'http://gl/mr/5')
    write(901, 'gitlab.updateMr', 'failed', 'http://gl/mr/6')
    expect(lastMergeRequest(h.wb, job)).toBe('http://gl/mr/5')
    write(902, 'gitlab.updateMr', 'succeeded', 'http://gl/mr/5?v=2')
    expect(lastMergeRequest(h.wb, job)).toBe('http://gl/mr/5?v=2')
  })
})

describe('redactCredentials', () => {
  it('hides credential-shaped values a log printed, and leaves ordinary text alone', () => {
    expect(redactCredentials('export GITLAB_TOKEN=abc123\napi_key: "s3cr3t"\nAuthorization: Bearer xyz\nclone https://bot:pa55@gitlab.example.com/a.git\n42 tests passed'))
      .toBe('export GITLAB_TOKEN=[REDACTED]\napi_key: [REDACTED]\nAuthorization: [REDACTED]\nclone https://bot:[REDACTED]@gitlab.example.com/a.git\n42 tests passed')
  })
})

describe('test-integrity and review checks (T10.1)', () => {
  let fake: FakeLlm
  let llm: Awaited<ReturnType<typeof llmContext>>
  let diff: WorkDiff | Error
  beforeEach(async () => {
    fake = await new FakeLlm().start()
    llm = await llmContext(fake, ['deepseek-flash', 'deepseek-pro'])
    diff = { base: 'b'.repeat(40), head: 'c'.repeat(40), patch: '+export const ttl = 60', files: [], tree: new Set() }
  })
  afterEach(async () => {
    await llm.dispose()
    await fake.close()
  })
  const handler = () => checkHandler({ workbench: h.wb, worktree: () => '/w', repository: () => 'group/app', gitlab: () => undefined,
    run: async () => ({ exitCode: 0, output: '' }), llm: llm.llm, diff: async () => { if (diff instanceof Error) throw diff; return diff } })
  const payload = (job: string, kind: string, params: Record<string, unknown> = {}): CheckPayload =>
    ({ jobId: job, manifestId: h.state(job).manifestId, attemptId: h.attempt(job), stageId: 'implement', check: { id: kind, kind, params } })
  /** A job past an approved plan whose `tests` field is `tests`. */
  let threads = 0
  async function approved(tests?: string): Promise<string> {
    const thread = `mattermost:ch1:t${++threads}`
    const job = await h.start('@workbench add sessions', thread)
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, tests ? { tests } : {}, 'Plan r1: store sessions in Redis')
    await h.say(LEAD, 'ok', { thread })
    return job
  }
  const source = (lines: number): DiffFile => ({ status: 'modified', path: 'src/session.ts', binary: false, removed: [],
    added: Array.from({ length: lines }, (_, index) => ({ line: index + 1, text: `const v${index} = ${index}` })) })

  it('passes clean work, fails flagged work with the rule and the lines, and exempts what the approved plan explains', async () => {
    const job = await approved()
    expect(approvedPlan(h.wb, job)).toEqual({ text: 'Plan r1: store sessions in Redis', attemptId: `${job}.a2` })
    expect(await handler().run(payload(job, 'test-integrity'), 'k', 1)).toEqual({ ok: { outcome: 'passed',
      evidence: 'test integrity: no findings in 0 changed file(s), bbbbbbbbbbbb...cccccccccccc' } })
    diff = { ...diff as WorkDiff, files: [{ status: 'modified', path: 'tests/session.test.ts', binary: false, removed: [], added: [{ line: 3, text: "it.only('ttl', () => {" }] }] }
    const flagged = await handler().run(payload(job, 'test-integrity'), 'k', 1) as { ok: { outcome: string; evidence: string } }
    expect(flagged.ok.outcome).toBe('failed')
    expect(flagged.ok.evidence).toMatch(/^test integrity: 1 finding\(s\) in bbbbbbbbbbbb\.\.\.cccccccccccc; report [0-9a-f]{64}\nskip-marker: tests\/session\.test\.ts: tests are skipped or focused\n {2}\+3 it\.only/u)
    diff = { ...diff, files: [source(40)] }
    expect(await handler().run(payload(job, 'test-integrity'), 'k', 1)).toMatchObject({ ok: { outcome: 'failed', evidence: expect.stringContaining('untested-change') } })
  })

  it('lets a large source change without tests pass when the approved plan says why no tests are needed', async () => {
    h.cleanup()
    h = new Harness({ workflows: [standardDelivery()], without: ['check'],
      parameters: { 'standard-delivery': { repository: 'group/app', targetBranch: 'main', testCommand: 'pnpm test', 'jira.inProgress': 'a', 'jira.inReview': 'b' } } })
    h.policy = { ...h.policy, approvers: { 'standard-delivery': { mattermost: ['lead'] } } }
    const job = await h.start('@workbench сделай PAY-1')
    await h.complete(job, { clarifiedScope: 'Логи' })
    await h.complete(job, { steps: ['Поправить сообщения'], tests: 'none: only log messages change' }, 'Plan: reword log messages')
    await h.say(LEAD, 'ок')
    expect(approvedPlan(h.wb, job)).toMatchObject({ text: 'Plan: reword log messages', tests: 'none: only log messages change' })
    diff = { ...diff as WorkDiff, files: [source(40)] }
    expect(await handler().run(payload(job, 'test-integrity'), 'k', 1)).toMatchObject({ ok: { outcome: 'passed' } })
  })

  it('passes a finding the approved plan exempts, and says so in the evidence (final review)', async () => {
    h.cleanup()
    h = new Harness({ workflows: [standardDelivery()], without: ['check'],
      parameters: { 'standard-delivery': { repository: 'group/app', targetBranch: 'main', testCommand: 'pnpm test', 'jira.inProgress': 'a', 'jira.inReview': 'b' } } })
    h.policy = { ...h.policy, approvers: { 'standard-delivery': { mattermost: ['lead'] } } }
    const job = await h.start('@workbench сделай PAY-1')
    await h.complete(job, { clarifiedScope: 'Удалить старый API' })
    await h.complete(job, { steps: ['Удалить'], tests: 'Tests of the new API.\nexempt deleted-test tests/legacy.test.ts: the legacy API goes away' }, 'Plan: drop the legacy API')
    await h.say(LEAD, 'ок')
    diff = { ...diff as WorkDiff, files: [{ status: 'deleted', path: 'tests/legacy.test.ts', binary: false, added: [], removed: [] }] }
    expect(await handler().run(payload(job, 'test-integrity'), 'k', 1)).toEqual({ ok: { outcome: 'passed', evidence: expect.stringContaining(
      'exempted by the approved plan: deleted-test tests/legacy.test.ts (the legacy API goes away)') } })
  })

  it('fails rewritten history, and blocks when the work cannot be diffed', async () => {
    const job = await approved()
    diff = new WorkDiffError('the work is not based on the commit the job started from (bbbbbbbbbbbb): its history was rewritten')
    expect(await handler().run(payload(job, 'test-integrity'), 'k', 1)).toEqual({ ok: { outcome: 'failed', evidence: diff.message } })
    diff = new Error('job x has no recorded base commit')
    expect(await handler().run(payload(job, 'test-integrity'), 'k', 1)).toEqual({ ok: { outcome: 'blocked', evidence: 'the work could not be diffed: job x has no recorded base commit' } })
  })

  it('reviews on the stage\'s frozen model unless the check names one, with its tokens; changes fail and no model blocks', async () => {
    const job = await approved()
    diff = { ...diff as WorkDiff, patch: 'diff --git a/src/session.ts b/src/session.ts\n--- a/src/session.ts\n+++ b/src/session.ts\n@@ -0,0 +1 @@\n+export const ttl = 60' }
    fake.replies.push({ text: '{"verdict": "pass", "summary": "Matches the plan.", "findings": []}', usage: { prompt: 1200, completion: 300 } })
    expect(await handler().run(payload(job, 'review'), 'k', 1)).toEqual({ ok: { outcome: 'passed', evidence: 'review: pass — Matches the plan.', tokens: 1500 } })
    expect(fake.requests[0]!.model).toBe('deepseek-pro')
    expect(JSON.stringify(fake.requests[0]!.body.messages)).toContain('Plan r1: store sessions in Redis')
    // P16: a serious finding counts with its evidence (a quote of the changed line); the engineer gets only those, people the notes.
    fake.replies.push({ text: '{"verdict": "changes", "summary": "Missing expiry.", "findings": [{"file": "src/session.ts", "severity": "important", '
      + '"issue": "sessions never expire", "quote": "export const ttl = 60"}, {"severity": "suggestion", "issue": "name the unit"}]}' })
    expect(await handler().run(payload(job, 'review', { model: 'litellm/deepseek-flash' }), 'k', 1)).toEqual({ ok: { outcome: 'failed',
      evidence: 'review: changes\n1. [important] src/session.ts:1: sessions never expire', notes: '- (summary) Missing expiry.\n- (suggestion) name the unit', tokens: 15 } })
    expect(fake.requests[1]!.model).toBe('deepseek-flash')
    // The merge risk rides beside the evidence, about the commit reviewed, never inside it.
    const risk = { alignment: { verdict: 'good', gaps: [] }, impact: { verdict: 'medium', gaps: ['общий словарь ошибок'] }, verification: { verdict: 'decent', gaps: [] },
      rollback: { verdict: 'low', gaps: [] }, errors: { verdict: 'n/a', gaps: [] } }
    fake.replies.push({ text: JSON.stringify({ verdict: 'pass', summary: 'Fine.', findings: [], risk }) })
    const withRisk = await handler().run(payload(job, 'review'), 'k', 1) as { ok: { evidence: string; risk: Record<string, unknown> } }
    expect(withRisk.ok.risk).toMatchObject({ level: 'medium', commit: 'c'.repeat(40), categories: { impact: { gaps: ['общий словарь ошибок'] } } })
    expect(withRisk.ok.evidence).not.toContain('общий')
    fake.replies.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 })
    expect(await handler().run(payload(job, 'review'), 'k', 1)).toMatchObject({ ok: { outcome: 'blocked', evidence: expect.stringContaining('review (deepseek-pro)') } })
  })

  it('gives the review the follow-ups since the approved plan, so what a reviewer asked for is not off-plan (eval T13.4)', async () => {
    const job = await approved()
    const thread = `mattermost:ch1:t${threads}`
    expect(followUpsSince(h.wb, job, approvedPlan(h.wb, job)?.attemptId)).toEqual([])
    await h.say(LEAD, 'Also expire sessions after 30 minutes', { thread })
    expect(followUpsSince(h.wb, job, approvedPlan(h.wb, job)?.attemptId)).toEqual(['Also expire sessions after 30 minutes'])
    fake.replies.push({ text: '{"verdict": "pass", "summary": "Matches.", "findings": []}' })
    await handler().run(payload(job, 'review'), 'k', 1)
    expect(JSON.stringify(fake.requests.at(-1)!.body.messages)).toContain('<<<FOLLOWUPS\\n[\\"Also expire sessions after 30 minutes\\"]\\nFOLLOWUPS>>>')
  })

  it('counts a check\'s model tokens against the job\'s budget', async () => {
    const harness = new Harness({ without: ['check'] })
    try {
      harness.wb.kernel.effects.register('check', { idempotent: true, limit: () => 2, run: async () => ({ ok: { outcome: 'passed', evidence: 'ok', tokens: 700 } }) })
      const job = await harness.toApproval()
      await harness.say(LEAD, 'ok')
      const before = harness.state(job).usage.tokens
      await harness.complete(job)
      await settle(harness)
      expect(harness.state(job).usage.tokens - before).toBe(1400)
      expect(harness.wb.kernel.engine.events(job).filter(event => event.type === 'CheckCompleted')).toEqual(expect.arrayContaining([expect.objectContaining({ tokens: 700 })]))
    } finally { harness.cleanup() }
  })
})

describe('the CI log tail (final review)', () => {
  const connector = (body: () => ReadableStream<Uint8Array> | string, seen: { headers?: Headers; pulled: number }) => new GitLabConnector({ baseUrl: 'http://gl',
    token: 'glpat-own', maxRetries: 0, fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      seen.headers = new Headers(init?.headers)
      return new Response(body(), { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }) as typeof fetch })

  it('asks for the tail only, redacts before cutting, so a cut never splits a secret from its name, and hides foreign tokens', async () => {
    const seen: { headers?: Headers; pulled: number } = { pulled: 0 }
    const log = `${'npm test\n'.repeat(2000)}export API_TOKEN=leakyvalue12345678\n${'x'.repeat(70)}\nglpat-abcdefghijklmnopqrstu eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2ln\n`
    const tail = await connector(() => log, seen).jobLogTail('group/app', 7, 200)
    expect(seen.headers?.get('range')).toBe('bytes=-4896')
    expect(tail).not.toMatch(/leaky|lue1234|glpat-abc|eyJhbGci/u)
    expect(tail).toContain('[REDACTED]')
  })

  it('stops reading a log over the read limit, keeping memory to a window, and says its end was not read', async () => {
    const seen: { headers?: Headers; pulled: number } = { pulled: 0 }
    const chunk = new TextEncoder().encode('line of output\n'.repeat(1000))
    const endless = () => new ReadableStream<Uint8Array>({ pull: controller => { seen.pulled++; controller.enqueue(chunk) } })
    const tail = await connector(endless, seen).jobLogTail('group/app', 7, 100, { readLimit: 1 << 20 })
    expect(tail.startsWith('(the log is longer than 1 MiB; its end was not read)')).toBe(true)
    expect(seen.pulled).toBeLessThan(120)
  })
})
