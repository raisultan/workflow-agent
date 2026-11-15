/**
 * The stage runner (`T9.4`): the handler of the domain's long `stage.attempt` effect, on DSH. Each attempt gets a fresh DSH
 * session (`D8` decision 5), created under the stage's agent preset, pinned to its permission preset, and set to the model and
 * reasoning effort its manifest froze (`D9`). The stage's instructions are a system prompt section; the request, the attempt's
 * typed inputs (answers, notes, change requests, follow-ups, check failures, a recovery note) and the current artifacts are its
 * first message. The model concludes with `workbench_stage_report`, which becomes the job's `report` command (a tool origin): the
 * job validates it, and a refusal returns to the model as the tool's error, so it can correct the report.
 *
 * The attempt holds its worker slot (the effect kind's limit) from start to end, so a job waiting on a person holds none (`A3`).
 * Usage from each model step feeds the job's budgets. A turn that ends without a report gets reminders, then the attempt ends and
 * the job decides. Cancelling (a budget, a timeout, a cancel) stops the session; a restart leaves the attempt to recovery, which
 * returns it to the job as interrupted. When an attempt ends its background work is stopped and its session archived.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { pathGuard } from './path-policy.ts'
import { AgentDelivery } from '../app/delivery.ts'
import { toDshParameterSchema } from '../tools/shared.ts'
import { fill, jobLocale, stageOf, stageTitleIn } from '../domain/definition.ts'
import type { AttemptPayload, JobState, StageInput } from '../domain/job.ts'
import type { Actor } from '../domain/policy.ts'
import type { Workbench } from '../domain/workbench.ts'
import type { EffectHandler } from '../kernel/effects.ts'
import { modelRoute } from './verdict.ts'

/** What a stage session runs with besides the runner's own report tool (the safe-output tools of `T9.3`). */
export interface StageTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  /** `notify` delivers a later message to the session while its attempt still runs (a queued write's result). */
  execute(args: unknown, call: { id: string; signal: AbortSignal; notify(text: string): void }): Promise<unknown>
}

export interface StageRunnerDeps {
  /** DSH's context: sessions, agents, workspaces, permission presets, the LLM runtime and persistence. */
  readonly ctx: Context
  readonly workbench: Pick<Workbench, 'workflow' | 'report' | 'usage' | 'kernel'>
  /** The job's worktree, created when missing; the same for every attempt of the job. */
  prepareWorkspace(jobId: string): Promise<string>
  /** Prepares the job's sandbox for the stage about to run: its worktree and the egress profile the manifest froze (`T10.3`). */
  prepareSandbox?(jobId: string, sandbox: { worktree: string; egress: 'none' | 'registries' }): Promise<void> | void
  /** Releases what `prepareSandbox` started (the job's egress proxy) once the attempt ends. */
  releaseSandbox?(jobId: string): void
  /** How to name a person in an attempt's inputs: `@username` (a Mattermost username for its user id, a Jira name); `@id` otherwise. */
  name?(actor: Actor): string
  /** Directories of skills a stage may read with the file tools (`T10.3`). */
  readonly skillRoots?: readonly string[]
  /** Worker slots: how many attempts run at once. */
  maxWorkers(): number
  /** Stops the background work (shell jobs, subagents) of a session that is done. */
  stopWork?(sessionId: string, reason: string): Promise<void>
  /** Tools the stage may use besides DSH's own: the safe-output tools of its capabilities. */
  tools?(attempt: AttemptPayload, sessionId: string): readonly StageTool[]
  /** DSH tools a stage session may keep, of those its preset provides. */
  readonly workTools: readonly string[]
  /** Reminders to a turn that ends without a report (default 2). */
  readonly reminders?: number
  /** How long a delivered message may leave the session idle before it counts as taken without a turn (default 10 s). */
  readonly turnStartGraceMs?: number
  readonly defaultProvider?: string
}

/** The session of an attempt: one per attempt, never reused. */
export const attemptSessionId = (attemptId: string) => `wb-${attemptId.replace(/[^A-Za-z0-9_-]/gu, '-')}`

/** What the model passes to `workbench_stage_report`; the stage's own output schema replaces `output`'s. */
const ReportArgs = z.object({
  outcome: z.enum(['completed', 'question', 'backtrack', 'blocked', 'failed']),
  summary: z.string().optional().describe('What the stage did or found, in a few sentences.'),
  output: z.record(z.string(), z.unknown()).optional().describe('The stage\'s structured result (completed only).'),
  artifact: z.object({ text: z.string().min(1), title: z.string().optional() }).strict().optional()
    .describe('The artifact this stage produces, such as the plan text (completed only).'),
  questions: z.array(z.object({ text: z.string().min(1), choices: z.array(z.string().min(1)).optional() }).strict()).optional()
    .describe('Every open question at once, numbered by position (question only).'),
  backtrackTo: z.string().optional().describe('The earlier stage to go back to (backtrack only).'),
  reason: z.string().optional().describe('Why (backtrack, blocked, failed).'),
}).strict()
type ReportArgs = z.output<typeof ReportArgs>

/** The domain's report from the tool's arguments; the job validates it. */
export function domainReport(args: ReportArgs): Record<string, unknown> {
  switch (args.outcome) {
    case 'completed': return { outcome: 'completed', summary: args.summary ?? '', output: args.output ?? {} }
    case 'question': return { outcome: 'question', ...args.summary ? { summary: args.summary } : {}, items: args.questions ?? [] }
    case 'backtrack': return { outcome: 'backtrack', to: args.backtrackTo ?? '', reason: args.reason ?? '' }
    default: return { outcome: args.outcome, reason: args.reason ?? args.summary ?? '' }
  }
}

const INPUT_TITLES: Record<StageInput['kind'], string> = {
  answers: 'Answers to your questions', approval_notes: 'Notes from the approval', changes_requested: 'Changes requested',
  gate_question: 'A question about your result', follow_up: 'Follow-up messages', check_failures: 'Checks that failed on your last attempt',
  recovery: 'What happened before', backtrack: 'Why you are back at this stage', fact: 'Events since',
}

/** Marks on a round's answers, in the language of the stage prompts, which name them (`D14`: the job's language). */
export const ANSWER_MARKS_BY_LOCALE = {
  en: {
    replaced: '(replaced by the answer below)',
    current: '(current answer)',
    several: '(different people answered: the latest answer counts; if the answers differ, name the disagreement and whose answer was taken)',
  },
  ru: {
    replaced: '(заменён ответом ниже)',
    current: '(действующий ответ)',
    several: '(ответили разные люди: действует последний ответ; если ответы расходятся, назови расхождение и чей ответ принят)',
  },
} as const
/** The Russian marks, which jobs pinned before `D14` were prompted with. */
export const ANSWER_MARKS = ANSWER_MARKS_BY_LOCALE.ru
const marksFor = (locale: string) => locale === 'en' ? ANSWER_MARKS_BY_LOCALE.en : ANSWER_MARKS_BY_LOCALE.ru

/**
 * The answers to one item of a round, in the order given. A person's later answer replaces their earlier one, and both are marked, so
 * a correction is never read as a second requirement. Answers of different people all stay: when they disagree, the stage names it.
 */
function answerLines(given: readonly { readonly text: string; readonly by: Actor }[], name: (actor: Actor) => string, locale: string): string[] {
  const marks = marksFor(locale)
  const same = (a: Actor, b: Actor) => a.source === b.source && a.id === b.id
  const replaced = given.map((answer, index) => given.slice(index + 1).some(later => same(later.by, answer.by)))
  const corrected = replaced.includes(true)
  const lines = given.map((answer, index) => `   — ${answer.text} (${name(answer.by)})${replaced[index] ? ` ${marks.replaced}` : corrected ? ` ${marks.current}` : ''}`)
  if (replaced.filter(mark => !mark).length > 1) lines.push(`   ${marks.several}`)
  return lines
}

/** The first message of an attempt: the request, the stage, its inputs and the current artifacts. */
export function firstMessage(state: JobState, payload: AttemptPayload, stageTitle: string, artifactText: (digest: string) => string | undefined,
  name: (actor: Actor) => string = actor => `@${actor.id}`, locale = 'ru'): string {
  const lines = [`# Request`, state.intake?.text.trim() ?? '']
  // The job's ticket (`D12`): a job started by a Jira comment has only "@workbench сделай" as its request, and the code may name
  // other tickets, so every stage is told which issue holds its requirements.
  const ticket = state.bindings.map(binding => /^jira:(.+)$/u.exec(binding.threadKey)?.[1]).filter(key => key !== undefined).at(-1)
  if (ticket) lines.push('', '# Ticket', `${ticket} is this job's Jira issue: its description and comments hold the requirements and what earlier stages recorded.`)
  lines.push('', `# Stage: ${stageTitle} (attempt ${payload.n}, ${payload.entry})`)
  if (payload.inputs.length > 0) {
    lines.push('', '# Inputs')
    for (const input of payload.inputs) {
      if (input.answers) {
        // A round read item by item (`D12`): each question with its answers and who gave each, so the plan can name its sources.
        lines.push('', `## ${INPUT_TITLES[input.kind]}`)
        input.items?.forEach((item, index) => {
          lines.push(`${index + 1}. ${item.text}`)
          lines.push(...answerLines(input.answers!.filter(given => given.item === index + 1), name, locale))
        })
        continue
      }
      lines.push('', `## ${INPUT_TITLES[input.kind]}${input.by ? ` (from ${name(input.by)})` : ''}`)
      // A merge request comment's discussion: the agent answers it there (`gitlab_reply_discussion`), not in a new note.
      if (input.replyTo) lines.push(`(merge request discussion \`${input.replyTo}\`: when you reply on the merge request, reply in it with \`discussionId\`)`)
      if (input.items?.length) input.items.forEach((item, index) => lines.push(`${index + 1}. ${item.text}`))
      lines.push(input.text)
    }
  }
  for (const revision of payload.artifacts) {
    const text = artifactText(revision.digest)
    if (text) lines.push('', `# Current ${revision.kind} (revision ${revision.n})`, text)
  }
  lines.push('', 'When the stage is done, or you need answers, call `workbench_stage_report`.')
  return lines.join('\n')
}

const REMINDER = 'You ended your turn without `workbench_stage_report`. Finish the stage, or report a question, a backtrack, blocked or failed.'

interface Running { readonly agent: Agent; readonly controller: AbortController; readonly sessionId: string; readonly jobId: string; reported: boolean }

/** The `stage.attempt` handler, and steering into the attempt that runs. */
export class StageRunner {
  private readonly running = new Map<string, Running>()
  private readonly delivery: AgentDelivery
  private readonly deps: StageRunnerDeps
  private sequence = 0

  constructor(deps: StageRunnerDeps) {
    this.deps = deps
    this.delivery = new AgentDelivery(deps.ctx)
  }

  handler(): EffectHandler<AttemptPayload> {
    return {
      idempotent: true,
      long: true,
      limit: () => Math.max(1, this.deps.maxWorkers()),
      run: payload => this.run(payload),
      cancel: async payload => { this.stop(payload.attemptId, 'the job stopped the attempt') },
    }
  }

  /** The `stage.steer` handler: a follow-up for the attempt that runs; one that has ended takes nothing. */
  steerHandler(): EffectHandler<{ attemptId: string; text: string }> {
    return {
      idempotent: true,
      limit: () => 4,
      run: async (payload, key) => {
        const attempt = this.running.get(payload.attemptId)
        if (!attempt || attempt.reported) return { ok: { delivered: false } }
        await this.delivery.send(attempt.agent, `steer:${key}`, payload.text, 'steer', attempt.controller.signal)
        return { ok: { delivered: true } }
      },
    }
  }

  /** The job a running attempt's session works for; `undefined` for any other session. */
  jobOfSession(sessionId: string): string | undefined {
    for (const attempt of this.running.values()) if (attempt.sessionId === sessionId) return attempt.jobId
    return undefined
  }

  /** Stops every running attempt; on shutdown, they return to their jobs as interrupted after the restart. */
  shutdown(): void {
    for (const attemptId of [...this.running.keys()]) this.stop(attemptId, 'the workbench is stopping')
  }

  private stop(attemptId: string, reason: string): void {
    const attempt = this.running.get(attemptId)
    if (!attempt) return
    attempt.controller.abort(new Error(reason))
    attempt.agent.cancel({ kind: 'user' }, { keepInbox: false })
  }

  /** Runs an attempt; a failure to set it up or to run its turns fails the attempt, which its job retries within its budget. */
  private async run(payload: AttemptPayload): Promise<{ ok: unknown } | { fail: string }> {
    try {
      return await this.attempt(payload)
    } catch (error) {
      return { fail: error instanceof Error ? error.message : String(error) }
    }
  }

  private async attempt(payload: AttemptPayload): Promise<{ ok: unknown }> {
    const { ctx, workbench } = this.deps
    const pinned = workbench.workflow(payload.manifestId)
    const stage = stageOf(pinned, payload.stageId)
    const resolved = pinned.extra.stages[payload.stageId]
    if (!resolved) throw new Error(`Manifest ${payload.manifestId} has no stage ${payload.stageId}`)
    const state = workbench.kernel.engine.job(payload.jobId)?.state
    if (!state) throw new Error(`No job ${payload.jobId}`)
    const text = (digest: string) => workbench.kernel.blobs.text(digest)
    const template = text(resolved.instructions)
    if (template === undefined) throw new Error(`The instructions of stage ${stage.id} are missing from the blob store`)
    const instructions = fill(template, pinned.extra.parameters)
    const locale = jobLocale(pinned.extra)
    const title = stageTitleIn(stage, locale)

    const directory = await this.deps.prepareWorkspace(payload.jobId)
    await this.deps.prepareSandbox?.(payload.jobId, { worktree: directory, egress: resolved.egress })
    const sessionId = attemptSessionId(payload.attemptId)
    const agent = await this.session(sessionId, directory, resolved, `${(state.intake?.text ?? payload.jobId).split('\n')[0]!.slice(0, 80)} · ${title}`)
    const attempt: Running = { agent, controller: new AbortController(), sessionId, jobId: payload.jobId, reported: false }
    this.running.set(payload.attemptId, attempt)
    const disposers: (() => void)[] = []
    try {
      disposers.push(agent.ctx.systemPrompt.section({ name: 'workbench-stage', order: 9999, interpolate: false, text: () => instructions }))
      disposers.push(...this.registerTools(agent, attempt, payload, stage.output))
      // File tools run in the host process, outside any sandbox: they may name only the job's own paths (`T10.3`).
      disposers.push(agent.ctx.tools.guard(pathGuard({ worktree: directory, sessionId, skillRoots: this.deps.skillRoots ?? [] }) as never))
      disposers.push(this.meter(sessionId, payload))
      let message = firstMessage(state, payload, title, text, this.deps.name, locale)
      for (let turn = 0; turn <= (this.deps.reminders ?? 2); turn++) {
        await this.turn(agent, `${payload.attemptId}:${turn}`, message, attempt.controller.signal)
        if (attempt.reported || attempt.controller.signal.aborted) break
        message = REMINDER
      }
      return { ok: { reported: attempt.reported, stopped: attempt.controller.signal.aborted } }
    } finally {
      this.running.delete(payload.attemptId)
      for (const dispose of disposers.reverse()) { try { dispose() } catch { /* the session is going away */ } }
      await this.deps.stopWork?.(sessionId, 'the attempt ended').catch(() => {})
      try { this.deps.releaseSandbox?.(payload.jobId) } catch { /* nothing to release */ }
      await ctx.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: true }).catch(() => {})
    }
  }

  /** A fresh session for the attempt, under the stage's presets and model. */
  private async session(sessionId: string, directory: string, resolved: { agentPreset: string; permissionPreset: string; model: string; effort?: string | undefined },
    title: string): Promise<Agent> {
    const { ctx } = this.deps
    let result = await ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(directory)
      await ctx.sessionController.create({ sessionId: sessionId as SessionId, workspaceId: workspace.id, agentPreset: resolved.agentPreset })
      result = await ctx.sessionController.resolveAgent(sessionId as SessionId)
    }
    if ('error' in result) throw result.error
    const { agent } = result
    const route = modelRoute(resolved.model, this.deps.defaultProvider)
    const selected = await ctx.llm.resolveCallConfig({ ...route, ...resolved.effort ? { reasoningEffort: ReasoningEffortId(resolved.effort) } : {} })
    agent.model.select({ provider: selected.provider, model: selected.model, ...selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {} })
    ctx.permissionPresets.set(agent.session, resolved.permissionPreset)
    await ctx.sessionController.rename({ sessionId: sessionId as SessionId, title })
    await ctx.sessionPersistence.flush()
    return agent
  }

  /** The report tool and the stage's safe-output tools; the session keeps only those and its preset's work tools. */
  private registerTools(agent: Agent, attempt: Running, payload: AttemptPayload, output: Record<string, unknown>): (() => void)[] {
    const { workbench } = this.deps
    const parameters = toDshParameterSchema(ReportArgs)
    ;(parameters.properties as Record<string, unknown>).output = output
    const report: StageTool = {
      name: 'workbench_stage_report',
      description: 'Ends the stage: completed with its output (and artifact), question with every open question, backtrack to an earlier '
        + 'stage, blocked, or failed. The workbench checks the report; if it is refused, the error says why, and you may report again.',
      parameters,
      execute: async (raw, call) => {
        const args = ReportArgs.parse(raw)
        const submitted = workbench.report(payload.jobId, payload.attemptId, { session: attempt.sessionId, id: call.id }, domainReport(args),
          args.outcome === 'completed' && args.artifact ? { text: args.artifact.text, ...args.artifact.title ? { title: args.artifact.title } : {} } : undefined)
        if (submitted.outcome.kind !== 'decided') throw new Error(submitted.outcome.kind === 'rejected' ? submitted.outcome.reason : submitted.outcome.error)
        attempt.reported = true
        return { accepted: true }
      },
    }
    const tools = [report, ...this.deps.tools?.(payload, attempt.sessionId) ?? []]
    const disposers = tools.map(tool => agent.ctx.tools.register({ name: tool.name, description: tool.description, parameters: tool.parameters as never,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      execute: async (args: unknown, execution: { callId: string; signal: AbortSignal; concludeTurn(): void }) => {
        const notify = (text: string) => {
          if (attempt.reported || attempt.controller.signal.aborted) return
          void this.delivery.send(agent, `notice:${execution.callId}`, text, 'steer', attempt.controller.signal).catch(() => {})
        }
        const value = await tool.execute(args, { id: execution.callId, signal: execution.signal, notify })
        if (tool === report) execution.concludeTurn()
        return value
      } } as never))
    // `restrict` masks only inherited tools (the preset's), read through the parent scope; it refuses to name the session's own
    // registrations (the report and safe-output tools above, and local ones such as `subagent`), which stay visible anyway.
    const parent = scopeParentOf(agent)
    disposers.push(agent.ctx.tools.restrict({ allow: this.deps.workTools.filter(name => agent.ctx.tools.get(name, parent)) }))
    // Once the attempt reported or was stopped, the session changes nothing more.
    disposers.push(agent.ctx.tools.guard(() => attempt.reported || attempt.controller.signal.aborted ? 'This stage attempt has ended' : undefined))
    return disposers
  }

  /** Feeds the job's budgets: model steps as turns, input and output tokens, after each step. */
  private meter(sessionId: string, payload: AttemptPayload): () => void {
    let turns = 0, tokens = 0
    return this.deps.ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId || event.type !== 'assistant/message') return
      const data = event.data as { turn: number; step: number; usage?: { inputTokens: number; outputTokens: number } }
      turns++
      tokens += (data.usage?.inputTokens ?? 0) + (data.usage?.outputTokens ?? 0)
      this.deps.workbench.usage(payload.jobId, payload.attemptId, { session: sessionId, id: `usage-${data.turn}-${data.step}` }, { turns, tokens })
    })
  }

  /** Delivers `text` as the session's next turn and resolves when that turn has ended. */
  private async turn(agent: Agent, requestId: string, text: string, signal: AbortSignal): Promise<void> {
    const { ctx } = this.deps
    let begun = agent.status !== 'idle'
    let begin: () => void = () => {}
    let failure: unknown
    const started = new Promise<void>(resolve => { begin = resolve })
    const stopStatus = ctx.on('agent/status', ({ agent: changed, status }) => { if (changed === agent && status !== 'idle') { begun = true; begin() } })
    const stopError = ctx.on('agent/error', ({ agent: failed, error }) => { if (failed === agent && failure === undefined) failure = error })
    try {
      await this.delivery.send(agent, `${requestId}:${this.sequence++}`, text, 'queue', signal)
      if (!begun) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([started, new Promise<void>(resolve => { timer = setTimeout(resolve, this.deps.turnStartGraceMs ?? 10_000) })])
        clearTimeout(timer)
      }
      await agent.whenIdle()
      if (failure !== undefined && !signal.aborted) throw failure instanceof Error ? failure : new Error(String(failure))
    } finally {
      stopError()
      stopStatus()
    }
  }
}
