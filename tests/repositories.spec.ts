/**
 * Repository profiles (`T11.1`, `D10` decision 1, `A20`): validation, the deterministic choice from a trigger, the notice when
 * nothing matches (no job starts), the profile frozen in the manifest, and `ci: none`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { renderNotice } from '../src/adapters/messages.ts'
import { Config, resolveConfig } from '../src/config.ts'
import { chooseRepository, RepositoriesSchema, RepositoryProfileSchema, type RepositoryProfileInput } from '../src/domain/repositories.ts'
import { standardDelivery } from '../src/workflows/standard-delivery.ts'
import { Harness } from './fixtures/domain-workflow.ts'

const PAYMENTS: RepositoryProfileInput = { name: 'payments', project: 'acme/payments', testCommand: 'npm test', match: { jira: ['PAY'], mattermost: ['chpay'] } }
const LEDGER: RepositoryProfileInput = { name: 'ledger', project: 'acme/ledger', testCommand: 'pytest -q', setupCommand: 'uv sync --frozen', registries: ['pypi'],
  toolchains: { python: '3.12' }, match: { jira: ['LED'] }, ci: 'none' }
const profiles = (...inputs: RepositoryProfileInput[]) => RepositoriesSchema.parse(inputs)

let h: Harness | undefined
afterEach(() => { h?.cleanup(); h = undefined })

describe('repository profiles', () => {
  it('fill in defaults: main, npm via the deployment, CI required, no default', () => {
    expect(RepositoryProfileSchema.parse(PAYMENTS)).toMatchObject({ targetBranch: 'main', ci: 'required', default: false, toolchains: {} })
  })

  it('refuse a profile set whose choice could depend on order, or that names things badly', () => {
    const issues = (inputs: unknown[]) => RepositoriesSchema.safeParse(inputs).error?.issues.map(issue => issue.message).join('; ') ?? ''
    expect(issues([PAYMENTS, { ...LEDGER, name: 'payments' }])).toContain('repository name payments is used twice')
    expect(issues([PAYMENTS, { ...LEDGER, project: 'acme/payments' }])).toContain('project acme/payments is configured twice')
    expect(issues([{ ...PAYMENTS, default: true }, { ...LEDGER, default: true }])).toContain('only one repository may be the default')
    expect(issues([PAYMENTS, { ...LEDGER, match: { jira: ['PAY'] } }])).toContain('Jira project PAY matches more than one repository')
    expect(issues([PAYMENTS, { ...LEDGER, match: { mattermost: ['chpay'] } }])).toContain('Mattermost channel chpay matches more than one repository')
    expect(issues([{ ...PAYMENTS, name: 'Payments' }])).toContain('lowercase')
    expect(issues([{ ...PAYMENTS, project: 'payments' }])).toContain('GitLab project path')
    expect(issues([{ ...PAYMENTS, toolchains: { python: '3.12; curl evil' } }])).toContain('plain version')
    expect(issues([{ ...PAYMENTS, toolchains: { ruby: '3.3' } }])).not.toBe('')
    expect(issues([{ ...PAYMENTS, match: { jira: ['pay'] } }])).toContain('Jira project key')
    expect(issues([{ ...PAYMENTS, senders: { mattermost: [''] } }])).not.toBe('')
    expect(issues([{ ...PAYMENTS, senders: { mattermost: 'anna' } }])).not.toBe('')
    expect(issues([{ ...PAYMENTS, senders: { mattermost: ['anna'], jira: [] } }])).toBe('')
  })

  it('are deployment configuration: registries default to the egress presets, and unknown presets or a missing repository are refused', () => {
    const resolved = resolveConfig(Config({ stateDir: '/s', repositories: [PAYMENTS, LEDGER], egress: { presets: ['npm'] } } as never), {})
    expect(resolved.repositories.map(profile => [profile.name, profile.registries])).toEqual([['payments', ['npm']], ['ledger', ['pypi']]])
    expect(() => resolveConfig(Config({ stateDir: '/s', repositories: [{ ...PAYMENTS, registries: ['maven'] }] } as never), {})).toThrow('unknown registry presets maven')
    expect(() => resolveConfig(Config({ stateDir: '/s', workflows: { standardDelivery: { jiraStatuses: { inProgress: 'a', inReview: 'b' } } } } as never), {}))
      .toThrow('standard-delivery needs at least one repository')
    // The old single-repository keys are gone.
    expect(() => resolveConfig(Config({ stateDir: '/s', repositories: [PAYMENTS], workflows: { standardDelivery: { repository: 'acme/x', testCommand: 'x',
      jiraStatuses: { inProgress: 'a', inReview: 'b' } } } } as never), {})).toThrow('`workflows` configuration is invalid')
  })
})

describe('choosing a repository (A20)', () => {
  const both = profiles(PAYMENTS, { ...LEDGER, default: true })
  const choose = (text: string, threadKey: string, list = both) => {
    const choice = chooseRepository(list, { text, threadKey })
    return choice.kind === 'chosen' ? `${choice.repository.name}/${choice.basis}` : choice.kind === 'refused' ? `refused:${choice.reason}:${choice.repository}`
      : `none:${choice.requested ?? ''}:${choice.names.join(',')}`
  }

  it('takes repo:<name> first, then the Jira project, then the Mattermost channel, then the default', () => {
    expect(choose('@workbench repo:payments do it', 'mattermost:other:p1')).toBe('payments/explicit')
    expect(choose('@workbench repo:ledger do LED-4', 'jira:LED-4')).toBe('ledger/explicit')
    expect(choose('@workbench do it', 'jira:PAY-12')).toBe('payments/jira')
    expect(choose('@workbench do it', 'jira:LED-3')).toBe('ledger/jira')
    expect(choose('@workbench do it', 'mattermost:chpay:p1')).toBe('payments/mattermost')
    expect(choose('@workbench do it', 'mattermost:other:p1')).toBe('ledger/default')
    expect(choose('@workbench do it', 'jira:OPS-1')).toBe('ledger/default')
    expect(choose('@workbench (repo:Payments) please', 'mattermost:x:')).toBe('payments/explicit')
  })

  it('chooses nothing for an unknown repo: name, even with a default, or with no rule and no default', () => {
    expect(choose('@workbench repo:billing do it', 'jira:PAY-1')).toBe('none:billing:payments,ledger')
    expect(choose('@workbench do it', 'mattermost:other:p1', profiles(PAYMENTS, LEDGER))).toBe('none::payments,ledger')
  })

  it('reads repo: only as a word of its own, and a name inside another word is no token', () => {
    expect(choose('@workbench see myrepo:payments', 'mattermost:other:p1')).toBe('ledger/default')
    expect(choose('@workbench see a.repo:payments', 'mattermost:other:p1')).toBe('ledger/default')
    expect(choose('@workbench see my_repo:payments', 'mattermost:other:p1')).toBe('ledger/default')
  })

  it('never falls back when a repo: token names nothing configured, however it is written (review)', () => {
    const billing = profiles(PAYMENTS, LEDGER, { name: 'billing', project: 'acme/billing', testCommand: 'npm test' })
    // Each names billing, in a form people write; on a PAY thread none may go to payments.
    for (const text of ['repo:acme/billing', '`repo:billing`', '**repo:billing**', 'repo: billing', '[repo:billing]', 'repo:"billing"', 'REPO:billing',
      'Repo : billing.', '_repo:billing_', '(repo:billing)', 'repo:«billing»']) {
      expect([text, choose(`@workbench ${text} сделай`, 'mattermost:direct:p1', billing)]).toEqual([text, 'billing/explicit'])
      // On a thread that belongs to payments, naming billing is refused, never a fallback to payments.
      expect([text, choose(`@workbench ${text} сделай`, 'jira:PAY-1', billing)]).toEqual([text, 'refused:contradicts:billing'])
    }
    // What follows is not exactly a configured name or project: no job, and the reply lists the names.
    for (const [text, requested] of [['repo:billing:', 'billing:'], ['repo:acme/billing/x', 'acme/billing/x'], ['repo:payments/x', 'payments/x'],
      ['repo: ', ''], ['repo:bill', 'bill'], ['repo:payments repo:ledger', 'ledger']] as const) {
      expect([text, choose(`@workbench ${text}`, 'jira:PAY-1', billing)]).toEqual([text, `none:${requested}:payments,ledger,billing`])
    }
    expect(choose('@workbench repo:payments, repo:Payments', 'mattermost:direct:p1', billing)).toBe('payments/explicit')
  })
})

describe('intake with repositories (A20)', () => {
  it('starts each job on its own repository in one deployment, and freezes the profile in its manifest', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [PAYMENTS, LEDGER] })
    const pay = await h.start('@workbench сделай PAY-1', 'mattermost:chpay:p1')
    const led = await h.start('@workbench repo:ledger сделай LED-1', 'mattermost:direct:p2')
    const extra = (job: string) => h!.wb.workflow(h!.state(job).manifestId).extra
    expect(extra(pay)).toMatchObject({ repository: { name: 'payments', project: 'acme/payments' },
      parameters: { repository: 'acme/payments', testCommand: 'npm test', ci: 'required', targetBranch: 'main' } })
    expect(extra(led)).toMatchObject({ repository: { name: 'ledger', setupCommand: 'uv sync --frozen', toolchains: { python: '3.12' }, ci: 'none' },
      parameters: { repository: 'acme/ledger', testCommand: 'pytest -q', setupCommand: 'uv sync --frozen', ci: 'none' } })
    expect(h.state(led).intake?.repository).toEqual({ name: 'ledger', basis: 'explicit', allowedBy: 'global' })
    // A configuration change reaches only new jobs (A13).
    h.repositories.splice(0, 2, ...profiles({ ...PAYMENTS, testCommand: 'npm run test:ci' }, LEDGER))
    await h.restart()
    const later = await h.start('@workbench сделай PAY-2', 'mattermost:chpay:p3')
    expect(extra(pay).parameters.testCommand).toBe('npm test')
    expect(extra(later).parameters.testCommand).toBe('npm run test:ci')
  })

  it('starts no job when nothing matches, and posts the names once, even when the event is handled again', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [PAYMENTS, LEDGER] })
    const handled = await h.say({ source: 'mattermost', id: 'anna' }, '@workbench сделай', { addressed: 'mention', thread: 'mattermost:elsewhere:p9' })
    expect(handled.route).toMatchObject({ kind: 'notice', notice: { kind: 'no_repository', names: ['payments', 'ledger'] } })
    expect(h.wb.kernel.db.get<{ n: number }>('SELECT count(*) AS n FROM job')!.n).toBe(0)
    expect(h.notices).toEqual([expect.objectContaining({ threadKey: 'mattermost:elsewhere:p9', notice: { kind: 'no_repository', names: ['payments', 'ledger'] } })])
    const event = h.wb.kernel.db.get<{ id: string; status: string; outcome: string }>('SELECT id, status, outcome FROM inbox_event')!
    expect(event).toMatchObject({ status: 'ignored' })
    expect(JSON.parse(event.outcome)).toEqual({ reason: 'no repository matches, and there is no default' })
    // Handled again (a recovery that routes it once more): the notice is keyed by the event, so it is not queued twice.
    h.wb.handle(h.wb.kernel.inbox.get(event.id)!)
    await h.settle()
    expect(h.notices).toHaveLength(1)
    expect(h.wb.kernel.db.get<{ n: number; job: string | null }>("SELECT count(*) AS n, max(job_id) AS job FROM effect WHERE kind = 'notice'")).toEqual({ n: 1, job: null })
    const unknown = await h.say({ source: 'mattermost', id: 'anna' }, '@workbench repo:billing сделай', { addressed: 'mention', thread: 'mattermost:chpay:p8' })
    expect(unknown.route).toMatchObject({ kind: 'notice', notice: { requested: 'billing' }, reason: 'no repository is named "billing"' })
    // A repo: token the parser cannot read exactly is not a fallback to the thread's repository (review).
    const odd = await h.say({ source: 'mattermost', id: 'anna' }, '@workbench repo:payments: сделай', { addressed: 'mention', thread: 'mattermost:chpay:p7' })
    expect(odd.route).toMatchObject({ kind: 'notice', notice: { requested: 'payments:' } })
    const empty = await h.say({ source: 'mattermost', id: 'anna' }, '@workbench repo: , сделай', { addressed: 'mention', thread: 'mattermost:chpay:p6' })
    expect(empty.route).toMatchObject({ kind: 'notice', notice: { kind: 'no_repository', names: ['payments', 'ledger'] }, reason: 'no repository is named ""' })
    expect((empty.route as { notice: { requested?: string } }).notice.requested).toBeUndefined()
  })

  it('keeps every A18 rule ahead of the repository choice: an unaddressed or ineligible message gets no notice', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [PAYMENTS] })
    await h.say({ source: 'mattermost', id: 'anna' }, 'сделай', { addressed: 'none', thread: 'mattermost:elsewhere:p1' })
    await h.say({ source: 'mattermost', id: 'stranger' }, '@workbench сделай', { addressed: 'mention', thread: 'mattermost:elsewhere:p2' })
    expect(h.notices).toEqual([])
  })

  it('leaves the CI check out for a repository with ci: none, and keeps it for one with CI', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [PAYMENTS, LEDGER] })
    h.policy = { ...h.policy, approvers: { 'standard-delivery': { jira: ['lead'] } } }
    const run = async (text: string, thread: string) => {
      const job = await h!.start(text, thread)
      await h!.complete(job, { clarifiedScope: 'x' })
      await h!.complete(job, { steps: ['x'], tests: 'x' }, '### plan')
      // The plan is approved on the job's ticket (`D12`).
      await h!.say({ source: 'jira', id: 'lead' }, 'ок', { thread: h!.gate(job)!.threadKey })
      await h!.complete(job, { branch: 'agent/x' })
      return h!.wb.kernel.engine.events(job).filter(event => event.type === 'CheckCompleted').map(event => (event as { checkId: string }).checkId).sort()
    }
    expect(await run('@workbench repo:ledger сделай LED-2', 'mattermost:x:p1')).toEqual(['integrity', 'review', 'tests'])
    expect(await run('@workbench repo:payments сделай PAY-3', 'mattermost:x:p2')).toEqual(['ci', 'integrity', 'review', 'tests'])
  })
})

describe('a check\'s condition on a missing parameter (review)', () => {
  it('keeps the check: a job without the parameter, or a condition with a typo, runs it', async () => {
    const checksRun = async (harness: Harness) => {
      harness.policy = { ...harness.policy, approvers: { 'standard-delivery': { mattermost: ['lead'], jira: ['lead'] } } }
      // The first key of the repository's Jira projects is the job's ticket (ledger: LED; no repositories: any).
      const job = await harness.start('@workbench сделай PAY-4 LED-4', 'mattermost:x:p1')
      await harness.complete(job, { clarifiedScope: 'x' })
      await harness.complete(job, { steps: ['x'], tests: 'x' }, '### plan')
      const thread = harness.gate(job)!.threadKey
      await harness.say({ source: thread.startsWith('jira:') ? 'jira' : 'mattermost', id: 'lead' }, 'ок', { thread })
      await harness.complete(job, { branch: 'agent/x' })
      return harness.wb.kernel.engine.events(job).filter(event => event.type === 'CheckCompleted').map(event => (event as { checkId: string }).checkId).sort()
    }
    // A deployment with no repositories: the job has no `ci` parameter, and CI still runs.
    h = new Harness({ workflows: [standardDelivery()], parameters: { 'standard-delivery': { repository: 'acme/app', testCommand: 'npm test' } } })
    expect(await checksRun(h)).toEqual(['ci', 'integrity', 'review', 'tests'])
    h.cleanup()
    // A condition naming a parameter nobody sets (a typo) keeps its check too.
    const spec = standardDelivery()
    const stages = (spec.declaration.stages as { checks?: { id: string; when?: { parameter: string; equals: string } }[] }[])
    for (const stage of stages) for (const check of stage.checks ?? []) if (check.when) check.when = { parameter: 'cii', equals: 'required' }
    h = new Harness({ workflows: [spec], repositories: [{ ...LEDGER, default: true }] })
    expect(await checksRun(h)).toEqual(['ci', 'integrity', 'review', 'tests'])
  })
})

describe('workflows that need no repository (review)', () => {
  it('start with none and get no notice in a deployment with repositories, and a module\'s own parameters are kept', async () => {
    const { syntheticHotfix } = await import('../src/workflows/synthetic-hotfix.ts')
    const { jobParameters } = await import('../src/app/workbench-runtime.ts')
    h = new Harness({ workflows: [standardDelivery(), syntheticHotfix()], repositories: [PAYMENTS] })
    const hotfix = await h.start('@workbench hotfix: login fails, OPS-1', 'mattermost:elsewhere:p1')
    expect(h.state(hotfix)).toMatchObject({ workflowId: 'synthetic-hotfix', attempt: { stageId: 'triage' } })
    expect(h.state(hotfix).intake?.repository).toBeUndefined()
    expect(h.wb.workflow(h.state(hotfix).manifestId).extra.repository).toBeUndefined()
    expect(h.notices).toEqual([])
    expect(h.setupRuns).toEqual([])
    const repository = RepositoryProfileSchema.parse(PAYMENTS)
    // A definition that does not say it needs a repository hashes as it did before the field existed.
    const { defineWorkflow } = await import('../src/domain/definition.ts')
    const { definitionHash } = await import('../src/kernel/registry.ts')
    expect('repository' in (defineWorkflow(syntheticHotfix()).declaration as object)).toBe(false)
    expect(definitionHash(defineWorkflow(syntheticHotfix()))).toBe(definitionHash(defineWorkflow({ ...syntheticHotfix() })))
    expect(jobParameters({ repository: 'ops/infra', testCommand: 'make check' }, repository)).toMatchObject({ repository: 'ops/infra', testCommand: 'make check',
      targetBranch: 'main', ci: 'required' })
  })
})

describe('the no-repository notice', () => {
  it('names the repositories, and quotes the requested name inert', () => {
    expect(renderNotice({ kind: 'no_repository', names: ['payments', 'ledger'] }, 'en', 1000))
      .toBe('🤔 I could not tell which repository to work in.\n\n👉 Name it as `repo:<name>` and mention me again.\nRepositories: payments, ledger.')
    expect(renderNotice({ kind: 'no_repository', names: ['payments'], requested: 'x@here' }, 'ru', 1000)).toContain('«x@​here»')
  })
})

describe('per-repository senders and no contradicting repo: (D10 note, 2026-11-12)', () => {
  const ANNA = { source: 'mattermost', id: 'anna' }, LEAD = { source: 'mattermost', id: 'lead' }
  // payments is open to every global sender; ledger only to lead (by Mattermost id) and to the Jira user lead-j.
  const scoped = () => [PAYMENTS, { ...LEDGER, senders: { mattermost: ['LEAD'], jira: ['lead-j'] } }]
  const pick = (who: { source: string; id: string }, text: string, threadKey: string) => {
    const choice = chooseRepository(profiles(...scoped()), { text, threadKey }, who)
    return choice.kind === 'chosen' ? `${choice.repository.name}/${choice.basis}/${choice.allowedBy}` : choice.kind === 'refused'
      ? `refused:${choice.reason}:${choice.repository}${choice.reason === 'contradicts' ? `<${choice.mapped}` : ''}` : `none:${choice.requested ?? ''}:${choice.names.join(',')}`
  }

  it('lets a listed sender start a job on a repository with senders, and refuses anyone else; without a list, the global senders apply', () => {
    expect(pick(LEAD, '@workbench do it', 'jira:LED-1')).toBe('ledger/jira/repository')
    expect(pick(ANNA, '@workbench do it', 'jira:LED-1')).toBe('refused:not_allowed:ledger')
    expect(pick({ source: 'jira', id: 'lead-j' }, '@workbench do it', 'jira:LED-1')).toBe('ledger/jira/repository')
    expect(pick({ source: 'jira', id: 'lead' }, '@workbench do it', 'jira:LED-1')).toBe('refused:not_allowed:ledger')
    expect(pick(ANNA, '@workbench do it', 'jira:PAY-1')).toBe('payments/jira/global')
  })

  it('refuses a repo: that contradicts the thread\'s repository, and allows one that names it, or where nothing maps', () => {
    expect(pick(LEAD, '@workbench repo:ledger do it', 'jira:PAY-1')).toBe('refused:contradicts:ledger<payments')
    expect(pick(LEAD, '@workbench repo:payments do it', 'mattermost:chpay:p1')).toBe('payments/explicit/global')
    expect(pick(LEAD, '@workbench repo:ledger do it', 'mattermost:direct:p1')).toBe('ledger/explicit/repository')
    expect(pick(ANNA, '@workbench repo:ledger do it', 'mattermost:direct:p1')).toBe('refused:not_allowed:ledger')
  })

  it('lists only the repositories this sender may use when nothing matches', () => {
    expect(pick(ANNA, '@workbench repo:billing do it', 'mattermost:direct:p1')).toBe('none:billing:payments')
    expect(pick(LEAD, '@workbench repo:billing do it', 'mattermost:direct:p1')).toBe('none:billing:payments,ledger')
    expect(pick(ANNA, '@workbench do it', 'mattermost:direct:p1')).toBe('none::payments')
  })

  it('starts no job on a refusal, replies why, and records the rule that allowed a job; a later senders change moves no running job', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: scoped() })
    h.policy = { ...h.policy, senders: { ...h.policy.senders, mattermost: [...h.policy.senders.mattermost ?? [], 'lead'] } }
    const refused = await h.say(ANNA, '@workbench repo:ledger сделай', { addressed: 'mention', thread: 'mattermost:direct:p1' })
    expect(refused.route).toMatchObject({ kind: 'notice', notice: { kind: 'repository_refused', reason: 'not_allowed', repository: 'ledger' },
      reason: 'the sender may not start jobs on ledger' })
    const contradicting = await h.say(LEAD, '@workbench repo:ledger сделай', { addressed: 'mention', thread: 'mattermost:chpay:p2' })
    expect(contradicting.route).toMatchObject({ kind: 'notice', notice: { kind: 'repository_refused', reason: 'contradicts', repository: 'ledger', mapped: 'payments' } })
    expect(h.wb.kernel.db.get<{ n: number }>('SELECT count(*) AS n FROM job')!.n).toBe(0)
    expect(h.notices.map(notice => notice.notice.kind)).toEqual(['repository_refused', 'repository_refused'])
    expect(renderNotice(h.notices[0]!.notice, 'en', 1000)).toBe('🚫 You may not start jobs on "ledger".\n\n👉 Ask someone who may.')
    expect(renderNotice(h.notices[1]!.notice, 'ru', 1000)).toContain('Эта ветка относится к репозиторию «payments»')
    // A globally ineligible sender gets nothing at all (A18 comes first), even with a repository list naming them.
    const stranger = await h.say({ source: 'mattermost', id: 'eve' }, '@workbench repo:payments сделай', { addressed: 'mention', thread: 'mattermost:direct:p3' })
    expect(stranger.route).toEqual({ kind: 'ignore', reason: 'the sender may not start jobs' })
    const job = await h.say(LEAD, '@workbench repo:ledger сделай LED-5', { addressed: 'mention', thread: 'mattermost:direct:p4' })
    expect(job.route).toMatchObject({ kind: 'newJob', intake: { repository: { name: 'ledger', basis: 'explicit', allowedBy: 'repository' } } })
    const jobId = (job.submitted!.outcome as { jobId: string }).jobId
    h.repositories.splice(0, 2, ...profiles(PAYMENTS, { ...LEDGER, senders: { mattermost: ['someone-else'] } }))
    await h.restart()
    await h.complete(jobId, { clarifiedScope: 'x' })
    expect(h.state(jobId).attempt?.stageId).toBe('plan')
    expect(h.wb.workflow(h.state(jobId).manifestId).extra.repository?.senders).toEqual({ mattermost: ['LEAD'], jira: ['lead-j'] })
  })
})
