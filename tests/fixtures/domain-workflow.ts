/**
 * A synthetic delivery workflow and a harness for domain tests: the real kernel on a temporary database, the domain on top, and
 * fake adapters (a scripted stage runner, recording posts, stubbed verdicts and checks, and a safe-output action that binds an MR).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GuardInput } from '../../src/domain/decider.ts'
import type { DeclarationInput, ModelProfile, WorkflowSpec } from '../../src/domain/definition.ts'
import type { AnswerPayload, AttemptPayload, CheckPayload, FollowUpPayload, InterpretPayload, JobState, NoticePayload, Outbound, PostPayload, ReadPayload, SetupPayload, Verdict } from '../../src/domain/job.ts'
import type { Actor, Policy } from '../../src/domain/policy.ts'
import { RepositoryProfileSchema, repositoryParameters, type RepositoryProfile, type RepositoryProfileInput } from '../../src/domain/repositories.ts'
import { Workbench } from '../../src/domain/workbench.ts'
import type { EffectHandler, EffectResult } from '../../src/kernel/effects.ts'
import { testEnv } from '../../src/kernel/env.ts'

const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false })

export const deliveryDeclaration = (): DeclarationInput => ({
  title: 'Synthetic delivery',
  start: 'inspect',
  triggers: [{ sources: ['mattermost', 'jira'], on: ['mention', 'direct'] }],
  stages: [
    { id: 'inspect', title: 'Inspect', agentPreset: 'inspector', permissionPreset: 'readonly', egress: 'none', instructions: 'inspect',
      output: object({ findings: { type: 'string' } }, ['findings']), limits: { turns: 20, tokens: 10_000, wallClockMs: 600_000 }, questionRounds: 2 },
    { id: 'plan', title: 'Plan', agentPreset: 'planner', permissionPreset: 'readonly', egress: 'none', instructions: 'plan', artifact: 'plan',
      output: object({}), limits: { turns: 20, tokens: 10_000, wallClockMs: 600_000 } },
    { id: 'implement', title: 'Implement', agentPreset: 'implementer', permissionPreset: 'worker', egress: 'registries', instructions: 'implement',
      model: 'deepseek-pro', effort: 'high', tools: ['gitlab.createMr', 'gitlab.push'], output: object({}),
      checks: [{ id: 'tests', kind: 'command', params: { command: 'pnpm test' } }, { id: 'lint', kind: 'command', required: false }],
      limits: { attempts: 2, turns: 50, tokens: 50_000, wallClockMs: 1_800_000 } },
    { id: 'review', title: 'Review', agentPreset: 'reviewer', permissionPreset: 'worker', egress: 'registries', instructions: 'review',
      output: object({ approved: { type: 'boolean' } }, ['approved']), limits: { turns: 20, tokens: 10_000, wallClockMs: 600_000 }, questionRounds: 0 },
  ],
  transitions: [
    { from: 'inspect', to: 'plan' },
    { from: 'plan', to: 'implement', gate: 'plan-approval' },
    { from: 'implement', to: 'review' },
    { from: 'review', to: '$complete', guard: 'review.approved' },
    { from: 'review', to: 'implement' },
  ],
  backtracks: [{ from: 'review', to: 'plan', budget: 1 }, { from: 'implement', to: 'plan', budget: 1 }, { from: 'plan', to: 'inspect', budget: 1 }],
  gates: [{ id: 'plan-approval', kind: 'approval', reminderMs: 3_600_000, deadlineMs: 86_400_000 }],
  budgets: { turns: 100, tokens: 100_000, backtracks: 2, extension: { turns: 50, tokens: 50_000, attempts: 2, backtracks: 1 } },
  reopen: { stage: 'review' },
  completeOn: ['mr_merged'],
})

export const prompts = { inspect: 'Inspect the request.', plan: 'Write a plan.', implement: 'Implement the plan.', review: 'Review the MR.' }
export const delivery = (version = 1, change: (declaration: DeclarationInput) => void = () => {}): WorkflowSpec => {
  const declaration = deliveryDeclaration()
  change(declaration)
  return { id: 'delivery', version, declaration, prompts }
}
export const reviewApproved = (input: GuardInput) => input.output.approved === true

export const PROFILE: ModelProfile = { defaultModel: 'deepseek-flash', verdictModel: 'deepseek-verdict' }
export const ANNA: Actor = { source: 'mattermost', id: 'anna' }
export const LEAD: Actor = { source: 'mattermost', id: 'lead' }
export const EVE: Actor = { source: 'mattermost', id: 'eve' }
export const BOT: Actor = { source: 'mattermost', id: 'workbench' }
export const basePolicy = (): Policy => ({
  senders: { mattermost: ['anna', 'lead', 'bob'], jira: ['anna'] },
  approvers: { delivery: { mattermost: ['lead'] } },
  bots: { mattermost: ['workbench'] },
})

export const THREAD = 'mattermost:ch1:p1'

/** A domain on a temporary database with fake adapters; every adapter call is recorded. */
export class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'domain-'))
  readonly env = testEnv(3)
  policy: Policy = basePolicy()
  wb!: Workbench
  readonly posts: (PostPayload & { key: string })[] = []
  readonly steers: unknown[] = []
  /** Posts the source refuses for good (a 4xx). */
  failPosts?: (payload: PostPayload) => boolean
  /** Steers miss the attempt, as when it has already reported. */
  undelivered = false
  readonly actions: unknown[] = []
  readonly interpretations: InterpretPayload[] = []
  /** Running attempts by attempt id; `end` settles the attempt effect as the runner would. */
  readonly running = new Map<string, { payload: AttemptPayload; end: (result: EffectResult) => void }>()
  /** Scripted verdicts by reply text; anything else is unclear. */
  verdicts = new Map<string, Verdict | 'unavailable'>()
  /** Scripted readings of question-round replies by text (`D12`); anything else answers every open item with the whole reply. */
  readings = new Map<string, Record<string, unknown> | 'unavailable'>()
  readonly reads: ReadPayload[] = []
  /** Jira issues `jira.link` cannot find. */
  readonly missingIssues = new Set<string>()
  /**
   * Scripted kinds of follow-ups by text (`D12`): a question gets an answer turn; `changes_requirements` goes to the plan; `approve`
   * and `unrelated` change nothing; anything else is a change request, a follow-up as before.
   */
  followUps = new Map<string, 'question' | 'changes_requirements' | 'approve' | 'approve_with_notes' | 'unrelated' | 'unavailable'>()
  readonly followUpPayloads: FollowUpPayload[] = []
  readonly answers: AnswerPayload[] = []
  answerFails = false
  /** More fields a check returns by check id (`P16`: a review's `notes` and `risk`). */
  readonly checkExtras = new Map<string, Record<string, unknown>>()
  /** Scripted check results by check id (`true` passes, `false` fails, or `blocked`); anything else passes. */
  checks = new Map<string, boolean | 'blocked'>()
  private calls = 0
  /** Effect kinds the harness leaves to the test to handle. */
  private readonly without: ReadonlySet<string>
  /** The workflows to register (the synthetic delivery by default), and the deployment's parameters per workflow. */
  private readonly workflows: readonly WorkflowSpec[]
  parameters: Record<string, Record<string, string>>

  /** The deployment's repositories (`T11.1`), and the notices posted for triggers that started no job. */
  repositories: RepositoryProfile[]
  readonly notices: (NoticePayload & { key: string })[] = []
  /** Scripted setup results, in order (`T11.4`); a passed one with no toolchains once the script runs out. `hold` keeps it running. */
  readonly setups: (EffectResult | 'hold')[] = []
  readonly setupRuns: SetupPayload[] = []
  private heldSetup: ((result: EffectResult) => void) | undefined

  /** The deployment's language (`D14`), read when the workbench is (re)opened. */
  locale: string | undefined

  constructor(options: { without?: readonly string[]; workflows?: readonly WorkflowSpec[]; parameters?: Record<string, Record<string, string>>;
    repositories?: readonly RepositoryProfileInput[]; locale?: string } = {}) {
    this.locale = options.locale
    this.without = new Set(options.without ?? [])
    this.workflows = options.workflows ?? [delivery()]
    this.parameters = options.parameters ?? {}
    this.repositories = (options.repositories ?? []).map(profile => RepositoryProfileSchema.parse(profile))
    this.open()
  }

  /** Opens the domain on the harness's file, with the delivery workflow and `guards` registered. */
  open(guards: Readonly<Record<string, (input: GuardInput) => unknown>> = { 'review.approved': reviewApproved }): void {
    this.wb = new Workbench({ path: join(this.dir, 'workbench.sqlite'), env: this.env, profile: PROFILE, policy: () => this.policy,
      parameters: (id, repository) => ({ ...this.parameters[id] ?? {}, ...repository ? repositoryParameters(repository) : {} }),
      repositories: this.repositories, kernel: { baseBackoffMs: 10, maxBackoffMs: 10 }, ...this.locale ? { locale: this.locale } : {} })
    for (const workflow of this.workflows) this.wb.register(workflow)
    for (const [name, guard] of Object.entries(guards)) this.wb.registerGuard(name, guard as (input: GuardInput) => boolean)
    this.handlers()
  }

  /** Closes and reopens on the same file, as a restart would (running attempts are lost), then recovers. */
  async restart(guards?: Readonly<Record<string, (input: GuardInput) => unknown>>): Promise<void> {
    await this.wb.stop()
    this.wb.close()
    this.running.clear()
    this.open(guards)
    this.wb.kernel.recover({ route: event => { this.wb.handle(event) }, active: status => !['completed', 'failed', 'cancelled'].includes(status) })
    await this.settle()
  }

  handlers(): void {
    const kernelEffects = this.wb.kernel.effects
    // Kinds the test handles itself are left out.
    const effects = { register: <P>(kind: string, handler: EffectHandler<P>) => this.without.has(kind) ? () => {} : kernelEffects.register(kind, handler) }
    effects.register<AttemptPayload>('stage.attempt', {
      idempotent: true, long: true, limit: () => 2,
      run: payload => new Promise(resolve => { this.running.set(payload.attemptId, { payload, end: resolve }) }),
      cancel: async payload => { this.running.get(payload.attemptId)?.end({ ok: { stopped: true } }); this.running.delete(payload.attemptId) },
    })
    effects.register<PostPayload>('post', {
      idempotent: true, limit: () => 4,
      run: async (payload, key) => {
        if (this.failPosts?.(payload)) return { fail: 'the source refused the post' }
        this.posts.push({ ...payload, key })
        return { ok: { postId: `post-${this.posts.length}`, postedAt: this.env.clock.now() } }
      },
    })
    effects.register<InterpretPayload>('interpretReply', {
      idempotent: true, limit: () => 4,
      run: async payload => {
        this.interpretations.push(payload)
        const verdict = this.verdicts.get(payload.text) ?? { verdict: 'unclear', confidence: 0.9, reading: `I read "${payload.text}" as unclear` }
        return verdict === 'unavailable' ? { fail: 'model unavailable' } : { ok: verdict }
      },
    })
    effects.register<ReadPayload>('readAnswers', {
      idempotent: true, limit: () => 4,
      run: async payload => {
        this.reads.push(payload)
        const reading = this.readings.get(payload.text)
          ?? { answers: payload.items.filter(item => !item.answered).map(item => ({ item: item.n, text: payload.text })), redirects: [] }
        return reading === 'unavailable' ? { fail: 'model unavailable' } : { ok: reading }
      },
    })
    effects.register<FollowUpPayload>('interpretFollowUp', {
      idempotent: true, limit: () => 4,
      run: async payload => {
        this.followUpPayloads.push(payload)
        const kind = this.followUps.get(payload.message.text)
        if (kind === 'unavailable') return { fail: 'model unavailable' }
        return { ok: { verdict: kind ?? 'request_changes', notes: payload.message.text, confidence: 0.9 } }
      },
    })
    effects.register<AnswerPayload>('answer', {
      idempotent: true, limit: () => 4,
      run: async payload => {
        this.answers.push(payload)
        return this.answerFails ? { fail: 'model unavailable' } : { ok: { text: `Ответ: ${payload.question}`, tokens: 100 } }
      },
    })
    effects.register<CheckPayload>('check', {
      idempotent: true, limit: () => 4,
      run: async payload => {
        const scripted = this.checks.get(payload.check.id) ?? true
        return { ok: { outcome: scripted === 'blocked' ? 'blocked' : scripted ? 'passed' : 'failed', evidence: `${payload.check.id} log`,
          ...this.checkExtras.get(payload.check.id) } }
      },
    })
    effects.register<SetupPayload>('setup', {
      idempotent: true, long: true, limit: () => 2,
      run: payload => {
        this.setupRuns.push(payload)
        const next = this.setups.shift() ?? { ok: { outcome: 'passed', toolchains: [], ignored: [], evidence: 'no toolchains' } }
        return next === 'hold' ? new Promise(resolve => { this.heldSetup = resolve }) : Promise.resolve(next)
      },
      cancel: async () => { this.heldSetup?.({ fail: 'cancelled' }); this.heldSetup = undefined },
    })
    effects.register<NoticePayload>('notice', { idempotent: true, limit: () => 2, run: async (payload, key) => { this.notices.push({ ...payload, key }); return { ok: {} } } })
    // As the runner: a steer reaches an attempt that runs and has not reported; `undelivered` makes it miss.
    effects.register('stage.steer', { idempotent: true, limit: () => 4, run: async payload => { this.steers.push(payload); return { ok: { delivered: !this.undelivered } } } })
    effects.register<{ action: string; payload?: unknown }>('action', {
      idempotent: true, limit: () => 4,
      run: async payload => {
        this.actions.push(payload)
        if (payload.action === 'gitlab.createMr') return { ok: { bind: 'gitlab:group/app!1' } }
        if (payload.action === 'jira.link') {
          const issueKey = (payload.payload as { issueKey: string }).issueKey
          return this.missingIssues.has(issueKey) ? { fail: `Jira issue ${issueKey} does not exist` } : { ok: { bind: `jira:${issueKey}` } }
        }
        return { ok: {} }
      },
    })
  }

  /** Dispatches until nothing is left to run now (an attempt waiting for a slot may stay pending). */
  async settle(): Promise<void> {
    for (let pass = 0; pass < 10; pass++) {
      await this.wb.kernel.effects.dispatch()
      const left = this.wb.kernel.db.get<{ n: number }>("SELECT count(*) AS n FROM effect WHERE status IN ('pending', 'unknown')")!.n
      if (left === 0) break
      this.env.clock.advance(20)
    }
  }

  /** A message from `actor` on `thread`, one second after the last thing that happened. */
  async say(actor: Actor, text: string, { thread = THREAD, addressed = 'none' as 'mention' | 'direct' | 'none', source = actor.source, human = true,
    replyTo = undefined as string | undefined } = {}) {
    this.env.clock.advance(1000)
    const { event } = this.wb.kernel.inbox.append({ source, externalId: `m${++this.calls}`, threadKey: thread, actor, human,
      payload: { kind: 'message', text, addressed, postedAt: this.env.clock.now(), ...replyTo ? { replyTo } : {} } })
    const handled = this.wb.handle(event)
    await this.settle()
    return handled
  }

  async fact(fact: string, thread: string, data: Record<string, unknown> = {}) {
    const { event } = this.wb.kernel.inbox.append({ source: 'gitlab', externalId: `f${++this.calls}`, threadKey: thread, human: false,
      payload: { kind: 'fact', fact, data } })
    const handled = this.wb.handle(event)
    await this.settle()
    return handled
  }

  /** Starts a job with a mention from Anna and returns its id. */
  async start(text = '@workbench add sessions', thread = THREAD): Promise<string> {
    const handled = await this.say(ANNA, text, { addressed: 'mention', thread })
    if (handled.route.kind !== 'newJob' || handled.submitted?.outcome.kind !== 'decided') throw new Error(`no job started: ${JSON.stringify(handled)}`)
    return handled.submitted.outcome.jobId
  }

  state(jobId: string): JobState { return this.wb.kernel.engine.job(jobId)!.state }
  status(jobId: string): string { return this.state(jobId).status.kind }
  attempt(jobId: string): string { return this.state(jobId).attempt!.id }
  gate(jobId: string) {
    const { status } = this.state(jobId)
    const id = status.kind === 'awaiting_gate' || status.kind === 'blocked' ? status.gateId : undefined
    return id ? this.state(jobId).gates[id]! : undefined
  }
  outbound(kind: Outbound['kind']): Outbound[] { return this.posts.map(post => post.message).filter(message => message.kind === kind) }

  /** The current attempt reports, then its runner ends; `artifact` is stored as the plan's text. */
  async report(jobId: string, report: Record<string, unknown>, artifact?: string) {
    const attemptId = this.attempt(jobId)
    const submitted = this.wb.report(jobId, attemptId, { session: `${attemptId}-session`, id: `call-${++this.calls}` }, report,
      artifact === undefined ? undefined : { text: artifact })
    if (submitted.outcome.kind === 'decided') this.endAttempt(attemptId)
    await this.settle()
    return submitted
  }

  /** Appends an inbox event for a hand-made reply and submits it to the job, bypassing the router. */
  replyDirectly(jobId: string, gateId: string, message: { actor: Actor; text: string; postedAt: number; threadKey?: string }) {
    const { event } = this.wb.kernel.inbox.append({ source: message.actor.source, externalId: `d${++this.calls}`, human: true, payload: {} })
    return this.wb.kernel.engine.submit(jobId, { kind: 'reply', gateId, message: { eventId: event.id, threadKey: THREAD, ...message } },
      { kind: 'inbox', id: event.id })
  }

  endAttempt(attemptId: string, result: EffectResult = { ok: { ended: true } }): void {
    this.running.get(attemptId)?.end(result)
    this.running.delete(attemptId)
  }

  complete(jobId: string, output: Record<string, unknown> = {}, artifact?: string) {
    return this.report(jobId, { outcome: 'completed', summary: 'done', output }, artifact)
  }

  /** Drives a new job through inspect and plan to an open, posted plan approval gate. */
  async toApproval(): Promise<string> {
    const job = await this.start()
    await this.settle()
    await this.complete(job, { findings: 'ok' })
    await this.complete(job, {}, 'Plan r1')
    return job
  }

  cleanup(): void {
    try { this.wb.close() } catch { /* already closed */ }
    rmSync(this.dir, { recursive: true, force: true })
  }
}
