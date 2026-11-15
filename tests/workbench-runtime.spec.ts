/**
 * The V2 composition root (`T9.8`): startup from configuration, the workbench's services, the policy from configuration and the
 * environment with Mattermost usernames resolved, Sources delivering to the inbox with cursors in the kernel's database (`A17`),
 * GitLab watching bound merge requests, and a clean stop.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkbenchRuntime } from '../src/app/workbench-runtime.ts'
import { Config, resolveConfig } from '../src/config.ts'
import type { Trigger } from '../src/sources/types.ts'
import { KV } from '../src/kv.ts'
import { mattermostKind, pollMattermostOnce, type MattermostConnector } from '../src/sources/mattermost.ts'
import { FakeDsh } from './fixtures/fake-dsh.ts'

let dir: string
let runtime: WorkbenchRuntime | undefined
const saved = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-runtime-'))
  Object.assign(process.env, { MATTERMOST_BASE_URL: 'http://mm', MATTERMOST_TOKEN: 't', WORKBENCH_ALLOWED_SENDERS: 'anna' })
})
afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  process.env = { ...saved }
  jiraComments = []
  rmSync(dir, { recursive: true, force: true })
})

/** The user id the fake Mattermost gives `name`. */
const uid = (name: string) => `${name}id`.padEnd(26, '0')
/** The comments on the fake Jira's one issue, `ORD-1`, all written by `anna`: the account the workbench logs in as there. */
let jiraComments: { id: string; body: string }[] = []
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const path = new URL(String(url)).pathname
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  if (path === '/rest/api/2/search') {
    const at = new Date().toISOString()
    return json({ total: 1, issues: [{ id: '1', key: 'ORD-1', fields: { summary: 'ORD-1', description: '', reporter: { name: 'anna' }, created: at, updated: at,
      comment: { comments: jiraComments.map(comment => ({ ...comment, created: at, author: { name: 'anna' } })) } } }] })
  }
  if (path === '/api/v4/users/me') return json({ id: 'botid00000000000000000000a', username: 'workbench' })
  if (path === '/api/v4/users/usernames') return json((JSON.parse(String(init?.body)) as string[]).map(name => ({ id: uid(name), username: name })))
  if (decodeURIComponent(path) === '/api/v4/users/email/lead@example.test') return json({ id: uid('lead'), username: 'lead' })
  return new Response('{}', { status: 404 })
}) as typeof fetch

async function start(over: Record<string, unknown> = {}): Promise<{ runtime: WorkbenchRuntime; dsh: FakeDsh }> {
  const dsh = new FakeDsh()
  const config = resolveConfig(Config({ stateDir: join(dir, 'state'), policy: { approvers: { 'standard-delivery': { mattermost: ['lead'] } } },
    repositories: [{ name: 'app', project: 'group/app', testCommand: 'pnpm test', default: true },
      { name: 'ledger', project: 'group/ledger', testCommand: 'pytest', registries: [], match: { mattermost: ['chled'] }, ci: 'none' }],
    workflows: { standardDelivery: { jiraStatuses: { inProgress: 'In Progress', inReview: 'In Review' } }, synthetic: true }, ...over } as never), {})
  runtime = new WorkbenchRuntime(dsh.ctx, config, { fetchImpl })
  runtime.sources.register(mattermostKind)
  await runtime.ready
  return { runtime, dsh }
}

const mention = (id: string, text: string, actorId = uid('anna')): Trigger => ({ id: `mm_${id}`, source: 'mattermost',
  threads: [{ source: 'mattermost', id: `ch1:${id}` }], actor: { source: 'mattermost', id: actorId }, human: true, addressed: 'mention',
  at: new Date().toISOString(), text, meta: {} })

describe('the V2 runtime', () => {
  it('starts from configuration: the configured workflows, the workbench\'s services, and a ready health entry', async () => {
    const { runtime, dsh } = await start()
    expect(runtime.workbench.kernel.registry.list().map(definition => `${definition.id}@${definition.version}`)).toEqual(['standard-delivery@13', 'synthetic-hotfix@2'])
    expect(dsh.ctx.get('wbWorkflows')).toBe(runtime.workbench)
    expect(runtime.health.all.runtime).toMatchObject({ state: 'ready' })
  })

  it('loads a workflow module named in workflows.modules: the example of docs/workflows.md', async () => {
    const path = fileURLToPath(new URL('../examples/workflows/docs-update.ts', import.meta.url))
    const { runtime } = await start({ workflows: { synthetic: false, modules: [path] } })
    expect(runtime.workbench.kernel.registry.list().map(definition => `${definition.id}@${definition.version}`)).toEqual(['docs-update@1'])
  })

  it('builds the policy from configuration and the environment, with Mattermost usernames resolved and its own identity known', async () => {
    const { runtime } = await start()
    const policy = runtime.policy()
    expect(policy.senders.mattermost).toEqual(['anna', uid('anna')])
    expect(policy.senders.jira).toEqual(['anna'])
    expect(policy.approvers['standard-delivery']!.mattermost).toEqual(['lead', uid('lead')])
    expect(policy.bots.mattermost).toEqual(['botid00000000000000000000a', 'workbench'])
  })

  it('resolves a repository\'s approver emails to users, leaving out an email no tool knows (D12)', async () => {
    const { runtime } = await start({ repositories: [{ name: 'app', project: 'group/app', testCommand: 'pnpm test', default: true,
      approvers: ['lead@example.test', 'ghost@example.test'] }, { name: 'ledger', project: 'group/ledger', testCommand: 'pytest' }] })
    expect(runtime.policy().repositoryApprovers).toEqual({ app: { jira: [], mattermost: [uid('lead'), 'lead'] } })
  })

  it('starts a job from a Source\'s delivery, routes by the inbox, and freezes the deployment\'s parameters', async () => {
    const { runtime } = await start()
    const context = runtime.context({ kind: 'mattermost', health: [] })
    expect(context.receive(mention('p1', '@workbench сделай PAY-1'))).toBe('stored')
    expect(context.receive(mention('p1', '@workbench сделай PAY-1'))).toBe('duplicate')
    const job = runtime.workbench.kernel.db.get<{ id: string; workflow_id: string }>('SELECT job_id AS id, workflow_id FROM job_summary')!
    expect(job.workflow_id).toBe('standard-delivery')
    const manifestId = runtime.workbench.kernel.engine.job(job.id)!.manifestId
    expect(runtime.workbench.workflow(manifestId).extra.parameters).toMatchObject({ repository: 'group/app', testCommand: 'pnpm test',
      'jira.inProgress': 'In Progress' })
    expect(runtime.repository(job.id)).toBe('group/app')
    expect(runtime.jobRepository(job.id)).toMatchObject({ name: 'app', registries: ['npm'] })
  })

  it('serves several repositories: the channel picks the job\'s repository, and the settings list them (A20)', async () => {
    const { runtime } = await start()
    const context = runtime.context({ kind: 'mattermost', health: [] })
    context.receive({ ...mention('p2', '@workbench сделай LED-1'), threads: [{ source: 'mattermost', id: 'chled:p2' }] })
    const job = runtime.workbench.kernel.db.get<{ id: string }>('SELECT job_id AS id FROM job_summary')!
    expect(runtime.repository(job.id)).toBe('group/ledger')
    expect(runtime.jobRepository(job.id)).toMatchObject({ name: 'ledger', ci: 'none', registries: [] })
    expect(runtime.settings().repositories.map(repository => repository.name)).toEqual(['app', 'ledger'])
    expect(runtime.settings().workflows.find(workflow => workflow.id === 'standard-delivery')!.parameters).toEqual({ 'jira.inProgress': 'In Progress', 'jira.inReview': 'In Review' })
  })

  it('keeps Source cursors in the kernel\'s database, and on a fresh one delivers nothing from before the first start (A17)', async () => {
    const { runtime } = await start()
    const context = runtime.context({ kind: 'mattermost', health: ['mattermost'] })
    const old = mention('old', '@workbench old request')
    const connector = { poll: async (cursor?: { channelSince: Record<string, number> }) => ({ triggers: cursor && Object.keys(cursor.channelSince).length ? [mention('new', '@workbench new request')] : [old],
      nextCursor: { channelSince: { ch1: Date.now() }, seenPostIds: [] }, errors: [] }) } as unknown as MattermostConnector
    const received: string[] = []
    const receive = (trigger: Trigger) => { received.push(trigger.id); return context.receive(trigger) }
    await pollMattermostOnce({ connector, state: context.state, receive, report: () => {}, signal: new AbortController().signal })
    expect(received).toEqual([])
    expect(runtime.workbench.kernel.db.get<{ key: string }>('SELECT key FROM kv WHERE key = ?', `source:${KV.mattermost.cursor}`)).toBeDefined()
    await pollMattermostOnce({ connector, state: context.state, receive, report: () => {}, signal: new AbortController().signal })
    expect(received).toEqual(['mm_new'])
  })

  it('knows the workbench\'s Jira comments of the last week from its post effects, so a new connector skips them on a person\'s account (A8)', async () => {
    Object.assign(process.env, { JIRA_BASE_URL: 'http://jira', JIRA_USERNAME: 'anna', JIRA_PASSWORD: 'p', JIRA_BOT_USERNAME: 'workbench' })
    const { runtime } = await start()
    runtime.context({ kind: 'mattermost', health: [] }).receive(mention('j1', '@workbench сделай ORD-1'))
    const { db, env } = runtime.workbench.kernel
    const jobId = db.get<{ id: string }>('SELECT id FROM job')!.id
    const effect = (id: string, threadKey: string, postId: string, dueAt: number) => db.run(`INSERT INTO effect (id, job_id, kind, idempotency_key, payload, status,
      due_at, result, seq) VALUES (?, ?, 'post', ?, '{}', 'succeeded', ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM effect))`, id, jobId, `test:${id}`, dueAt,
      JSON.stringify({ ok: { postId, postedAt: dueAt, threadKey } }))
    effect('ef_t1', 'jira:ORD-1', '60', env.clock.now())
    effect('ef_t2', 'jira:ORD-1', '61', env.clock.now() - 8 * 24 * 3600_000)
    effect('ef_t3', 'mattermost:ch1:j1', '62', env.clock.now())
    jiraComments = [{ id: '60', body: 'План r1' }, { id: '61', body: 'Старый' }, { id: '62', body: 'ок' }]
    // A restart: the new runtime's connector reads them.
    await runtime.stop()
    const { runtime: again } = await start()
    const { triggers } = await again.jira!.poll({ seenEventIds: [], lastUpdatedIso: new Date(Date.now() - 60_000).toISOString() })
    expect(triggers.map(trigger => trigger.id)).toEqual(['jira_comment_ORD-1_61', 'jira_comment_ORD-1_62'])
  })

  it('watches the merge requests bound to jobs still in play, and stops cleanly so another runtime can open the state', async () => {
    const { runtime } = await start()
    const context = runtime.context({ kind: 'gitlab', health: [] })
    context.receive(mention('p1', '@workbench сделай PAY-1'))
    const jobId = runtime.workbench.kernel.db.get<{ id: string }>('SELECT id FROM job')!.id
    runtime.workbench.kernel.db.run("INSERT INTO binding (thread_key, job_id, role) VALUES ('gitlab:group/app!7', ?, 'artifact')", jobId)
    expect(context.threads.subscribed('gitlab')).toEqual([{ key: 'gitlab:group/app!7', ref: { source: 'gitlab', id: 'group/app!mr_7' }, meta: { project: 'group/app' } }])
    await runtime.stop()
    const again = new WorkbenchRuntime(new FakeDsh().ctx, resolveConfig(Config({ stateDir: join(dir, 'state') } as never), {}), { fetchImpl })
    await again.ready
    await again.stop()
  })
})

describe('demo mode (A1)', () => {
  it('runs one synthetic job end to end with no connector or model: request, stages, checks, approval and completion', async () => {
    const dsh = new FakeDsh()
    runtime = new WorkbenchRuntime(dsh.ctx, resolveConfig(Config({ stateDir: join(dir, 'state'), demo: true } as never), {}))
    await runtime.ready
    const { db } = runtime.workbench.kernel
    for (let wait = 0; wait < 100 && db.get<{ status: string }>('SELECT status FROM job_summary')?.status !== 'completed'; wait++) {
      await runtime.workbench.kernel.effects.dispatch()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(db.get('SELECT workflow_id, status FROM job_summary')).toEqual({ workflow_id: 'synthetic-hotfix', status: 'completed' })
    const posts = JSON.parse(db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'demo:posts'")!.value) as { message: { kind: string } }[]
    expect(posts.map(post => post.message.kind)).toEqual(['started', 'approval', 'approved', 'completed'])
  }, 20_000)
})
