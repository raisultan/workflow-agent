/**
 * Checks that let a stage finish (`T9.13`, moved from `T10.1`): the handler of the domain's `check` effect. A stage's report is a
 * proposal; its job moves on only when its required checks pass, as the host runs them:
 *
 * - `command`: the stage's check command, run by the host in the job's worktree, confined by the sandbox the composition gives it
 *   (DSH's `sandbox.confine`, workspace-write) with no credential in its environment. It passes on exit code 0; its full log goes
 *   to the blob store and its tail is the evidence.
 * - `gitlab-ci`: GitLab CI for the commit the job pushed last. It is polled until the pipeline ends, within a time limit.
 * - `test-integrity` (`T10.1`, `A14`): the diff of the work against the commit the job started from, read by the documented rules
 *   in `test-integrity.ts` (deleted or skipped tests, weakened assertions, changed test configuration, source changes without
 *   tests). Any finding fails the check, with the rule and the lines as evidence.
 * - `review` (`T10.1`): the clean-context review in `review-check.ts`, of the approved plan, the follow-ups since it, and the diff only.
 *
 * A result is `passed`, `failed` or `blocked` (`T10.5`). `failed` is about the agent's work, so the job retries the attempt with the
 * evidence. `blocked` is about the environment, which another attempt cannot fix: a check that is misconfigured or cannot reach its
 * service, a pipeline that never starts or never ends, a cancelled pipeline, a test service that did not start (`T12.5`). The job
 * then blocks until a person re-runs the checks.
 * Checks are long effects: a slow test run never holds up a shutdown, and one a restart interrupts ends as `blocked`.
 */
import { z } from 'zod'
import { fill } from '../domain/definition.ts'
import { redactCredentials } from '../infra/redact.ts'
import { SERVICES_PREFIX } from '../sandbox/services.ts'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { CheckOutcome, CheckPayload, JobEvent } from '../domain/job.ts'
import type { Workbench } from '../domain/workbench.ts'
import type { EffectHandler, EffectResult } from '../kernel/effects.ts'
import type { GitLabConnector } from '../sources/gitlab.ts'
import { reviewChange, reviewEvidence, reviewNotes } from './review-check.ts'
import { applyExemptions, integrityEvidence, integrityFindings, planExemptions } from './test-integrity.ts'
import { WorkDiffError, type WorkDiff } from './work-diff.ts'

export interface CheckDeps {
  readonly workbench: Pick<Workbench, 'kernel' | 'workflow'>
  /** The deployment's language, for what people read of a review (its risk gaps, `P16`). */
  readonly locale?: 'ru' | 'en'
  /** The job's worktree. */
  worktree(jobId: string): string | undefined
  /** The job's repository (GitLab project path). */
  repository(jobId: string): string | undefined
  /** Runs a command confined to its worktree, with no credentials in its environment. */
  run(command: { argv: readonly string[]; cwd: string; timeoutMs: number; signal: AbortSignal; jobId: string }): Promise<{ exitCode: number | null; output: string }>
  gitlab(): GitLabConnector | undefined
  /** The diff of the job's work (`commit`, or its worktree's `HEAD`) against the commit it started from (`work-diff.ts`). */
  diff?(jobId: string, commit: string | undefined): Promise<WorkDiff>
  /** The model runtime the review check calls, and the provider of a model named without one. */
  readonly llm?: Pick<LlmRuntime, 'prepareCall'>
  readonly defaultProvider?: string
  /**
   * How often CI is polled (default 30 s); how long a pipeline may take to appear (default 10 min) and to finish (default 1 h)
   * before the check is `blocked`.
   */
  readonly ciPollMs?: number
  readonly ciStartMs?: number
  readonly ciLimitMs?: number
  /** The clock the CI window is measured on (the kernel's by default). */
  now?(): number
  /** Checks at once (default 2). */
  readonly limit?: number
}

const CommandParams = z.object({ command: z.string().min(1), timeoutMs: z.number().int().positive().default(15 * 60_000) }).passthrough()
const CiParams = z.object({ project: z.string().min(1).optional() }).passthrough()
const ReviewParams = z.object({ model: z.string().min(1).optional(), maxDiffChars: z.number().int().positive().optional() }).passthrough()
const ENDED = new Set(['success', 'failed', 'canceled', 'skipped'])
const TAIL = 3000
/** Failed CI jobs whose log tails go into the evidence. */
const CI_JOBS = 3

export { redactCredentials } from '../infra/redact.ts'

/** The commit the job pushed last, from its settled push writes. */
export function lastPushedSha(workbench: Pick<Workbench, 'kernel'>, jobId: string): string | undefined {
  return workbench.kernel.db.get<{ sha: string | null }>(`SELECT json_extract(result, '$.ok.sha') AS sha FROM effect WHERE job_id = ? AND kind = 'action'
    AND status = 'succeeded' AND json_extract(payload, '$.action') = 'gitlab.push' ORDER BY seq DESC LIMIT 1`, jobId)?.sha ?? undefined
}

/** The link of the merge request the job opened or updated last, from its settled MR writes (`T10.6`). */
export function lastMergeRequest(workbench: Pick<Workbench, 'kernel'>, jobId: string): string | undefined {
  return workbench.kernel.db.get<{ url: string | null }>(`SELECT json_extract(result, '$.ok.webUrl') AS url FROM effect WHERE job_id = ? AND kind = 'action'
    AND status = 'succeeded' AND json_extract(payload, '$.action') IN ('gitlab.createMr', 'gitlab.updateMr') ORDER BY seq DESC LIMIT 1`, jobId)?.url ?? undefined
}

/** The plan a person approved last, and its `tests` field (`T10.1`); `undefined` when no plan was approved. */
export function approvedPlan(workbench: Pick<Workbench, 'kernel'>, jobId: string): { text?: string; tests?: string; attemptId?: string } | undefined {
  const job = workbench.kernel.engine.job(jobId)
  if (!job) return undefined
  const approved = Object.values(job.state.gates).filter(gate => gate.kind === 'approval' && gate.status === 'satisfied' && gate.subject)
    .sort((a, b) => a.openedAt - b.openedAt).at(-1)
  if (!approved?.subject) return undefined
  const { subject } = approved
  const report = workbench.kernel.engine.events(jobId).find((event): event is Extract<JobEvent, { type: 'AttemptReported' }> =>
    event.type === 'AttemptReported' && event.attemptId === subject.attemptId)?.report
  const tests = report?.outcome === 'completed' ? report.output?.tests : undefined
  const text = workbench.kernel.blobs.text(subject.digest)
  return { ...text !== undefined ? { text } : {}, ...typeof tests === 'string' ? { tests } : {}, attemptId: subject.attemptId }
}

/**
 * The follow-up messages a job took after the attempt that wrote its approved plan (a reopening MR review note, a message kept
 * for the next attempt, or one that steered a running attempt), oldest first; for the review check.
 */
export function followUpsSince(workbench: Pick<Workbench, 'kernel'>, jobId: string, attemptId: string | undefined): string[] {
  const events = workbench.kernel.engine.events(jobId)
  const from = attemptId === undefined ? 0 : events.findIndex(event => event.type === 'AttemptStarted' && event.attemptId === attemptId)
  const texts: string[] = []
  for (const event of from === -1 ? [] : events.slice(from + 1)) {
    if (event.type === 'AttemptStarted') texts.push(...event.inputs.filter(input => input.kind === 'follow_up').map(input => input.text))
    if (event.type === 'FollowUpReceived' && event.steer) texts.push(event.message.text)
  }
  return texts
}

/** The launcher's report of a test service that did not start (`services.ts`), with its log tail, if the output has one. */
export function serviceFailure(output: string): string | undefined {
  const found = new RegExp(`^${SERVICES_PREFIX}\\S+ (?:did not start|is not available)`, 'mu').exec(output)
  if (!found) return undefined
  const report = output.slice(found.index)
  return report.length > TAIL ? `${report.slice(0, TAIL)}…` : report
}

/** The `check` handler. */
export function checkHandler(deps: CheckDeps): EffectHandler<CheckPayload> {
  const running = new Map<string, AbortController>()
  const verdict = (outcome: CheckOutcome, evidence: string): EffectResult => ({ ok: { outcome, evidence } })
  const now = () => deps.now?.() ?? deps.workbench.kernel.env.clock.now()

  /** A check's parameters, or a failure that names what is wrong with them. */
  const paramsOf = <T>(schema: z.ZodType<T>, payload: CheckPayload): { params: T } | { fail: string } => {
    const parsed = schema.safeParse(payload.check.params)
    return parsed.success ? { params: parsed.data } : { fail: `check ${payload.check.id} is misconfigured: ${z.prettifyError(parsed.error)}` }
  }

  async function command(payload: CheckPayload, signal: AbortSignal): Promise<EffectResult> {
    const parsed = paramsOf(CommandParams, payload)
    if ('fail' in parsed) return parsed
    const { params } = parsed
    const cwd = deps.worktree(payload.jobId)
    if (!cwd) return { fail: `job ${payload.jobId} has no worktree` }
    const commandLine = fill(params.command, deps.workbench.workflow(payload.manifestId).extra.parameters)
    if (/\{\{[^}]*\}\}/u.test(commandLine)) return { fail: `check ${payload.check.id} names a parameter this deployment does not set: ${commandLine}` }
    const result = await deps.run({ argv: ['sh', '-c', commandLine], cwd, timeoutMs: params.timeoutMs, signal, jobId: payload.jobId })
    const digest = deps.workbench.kernel.blobs.put(result.output)
    const output = redactCredentials(result.output)
    const tail = output.length > TAIL ? `…${output.slice(-TAIL)}` : output
    const exit = result.exitCode === null ? 'stopped before it finished' : `exit ${result.exitCode}`
    // A test service that did not start is the environment, not the agent's work (`T12.5`): another attempt cannot fix it.
    const service = result.exitCode === 0 ? undefined : serviceFailure(output)
    // The command's own output carries this line, so an agent's code could print it too: that can only block the job for a person,
    // never pass a check, and the evidence keeps the end of the log so that person sees what really happened (review).
    if (service) {
      const share = Math.floor(TAIL / 2)
      const ending = output.length > share ? `…${output.slice(-share)}` : output
      return verdict('blocked', `${commandLine}: ${exit}, because a test service did not start; log ${digest}\n${service.slice(0, share)}\n--- end of the log:\n${ending}`.trim())
    }
    return verdict(result.exitCode === 0 ? 'passed' : 'failed', `${commandLine}: ${exit}; log ${digest}\n${tail}`.trim())
  }

  /** The evidence of a failed pipeline: its link, and the end of each failed job's log, within the evidence limit. */
  async function failedEvidence(gitlab: GitLabConnector, project: string, sha: string, pipeline: { id: number; webUrl: string }): Promise<string> {
    const head = `CI failed for ${sha.slice(0, 12)}: ${pipeline.webUrl}`
    const jobs = (await gitlab.failedJobs(project, pipeline.id).catch(() => [])).slice(0, CI_JOBS)
    if (jobs.length === 0) return head
    const share = Math.floor((TAIL - head.length) / jobs.length) - 80
    const parts = await Promise.all(jobs.map(async job => {
      const log = await gitlab.jobLogTail(project, job.id, share).then(text => text, (error: unknown) => `(the log could not be read: ${error instanceof Error ? error.message : String(error)})`)
      return `--- ${job.stage}/${job.name} failed: ${job.webUrl}\n${log}`
    }))
    return [head, ...parts].join('\n')
  }

  async function ci(payload: CheckPayload, attempt: number): Promise<EffectResult> {
    const parsed = paramsOf(CiParams, payload)
    if ('fail' in parsed) return parsed
    const { params } = parsed
    const gitlab = deps.gitlab()
    if (!gitlab) return verdict('blocked', 'GitLab is not configured, so CI cannot be checked')
    const project = params.project ?? deps.repository(payload.jobId)
    if (!project) return verdict('blocked', 'the job has no repository, so CI cannot be checked')
    // Pushing is the agent's work: with nothing pushed, the attempt is retried.
    const sha = lastPushedSha(deps.workbench, payload.jobId)
    if (!sha) return verdict('failed', 'no commit was pushed, so CI has nothing to run')
    // The window is wall-clock time since the attempt's verification started (final review), not a count of polls.
    const pollMs = deps.ciPollMs ?? 30_000
    const waited = now() - verificationStart(payload, attempt)
    let pipeline: Awaited<ReturnType<GitLabConnector['latestPipeline']>>
    try {
      pipeline = await gitlab.latestPipeline(project, sha)
    } catch (error) {
      // A GitLab error while waiting is retried within the window; only a window that runs out on it blocks.
      const reason = `GitLab could not be read: ${error instanceof Error ? error.message : String(error)}`
      if (waited >= (deps.ciLimitMs ?? 60 * 60_000)) return verdict('blocked', `${reason}, for ${Math.round(waited / 60_000)} min`)
      return { retry: { afterMs: pollMs, reason } }
    }
    if (pipeline && ENDED.has(pipeline.status)) {
      const evidence = `CI ${pipeline.status} for ${sha.slice(0, 12)}: ${pipeline.webUrl}`
      if (pipeline.status === 'success') return verdict('passed', evidence)
      if (pipeline.status === 'failed') return verdict('failed', await failedEvidence(gitlab, project, sha, pipeline))
      // A cancelled or skipped pipeline ran nothing to judge the work by.
      return verdict('blocked', evidence)
    }
    if (!pipeline && waited >= (deps.ciStartMs ?? 10 * 60_000)) {
      return verdict('blocked', `no CI pipeline started for ${sha.slice(0, 12)} within ${Math.round(waited / 60_000)} min; does the repository have CI?`)
    }
    if (pipeline && waited >= (deps.ciLimitMs ?? 60 * 60_000)) {
      return verdict('blocked', `CI did not finish in time (still ${pipeline.status} after ${Math.round(waited / 60_000)} min): ${pipeline.webUrl}`)
    }
    return { retry: { afterMs: pollMs, reason: pipeline ? `CI ${pipeline.status}` : 'waiting for a CI pipeline' } }
  }

  /** When the attempt's verification started (its latest `VerificationStarted`), else when this check first ran in this process. */
  const firstSeen = new Map<string, number>()
  function verificationStart(payload: CheckPayload, attempt: number): number {
    const at = deps.workbench.kernel.db.get<{ at: number }>(`SELECT at FROM job_event WHERE job_id = ? AND type = 'VerificationStarted'
      AND json_extract(data, '$.attemptId') = ? ORDER BY seq DESC LIMIT 1`, payload.jobId, payload.attemptId)?.at
    if (at !== undefined) return at
    const key = `${payload.attemptId}/${payload.check.id}`
    if (attempt <= 1 || !firstSeen.has(key)) firstSeen.set(key, now())
    return firstSeen.get(key)!
  }

  /** The diff to judge: the commit the job pushed last, else its worktree's `HEAD`. A rewritten history is the agent's doing. */
  async function diffOf(payload: CheckPayload): Promise<{ diff: WorkDiff } | { result: EffectResult }> {
    if (!deps.diff) return { result: verdict('blocked', 'this deployment cannot diff a job\'s work') }
    try {
      return { diff: await deps.diff(payload.jobId, lastPushedSha(deps.workbench, payload.jobId)) }
    } catch (error) {
      if (error instanceof WorkDiffError) return { result: verdict('failed', error.message) }
      return { result: verdict('blocked', `the work could not be diffed: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  async function integrity(payload: CheckPayload): Promise<EffectResult> {
    const work = await diffOf(payload)
    if ('result' in work) return work.result
    const { diff } = work
    const planned = approvedPlan(deps.workbench, payload.jobId)?.tests
    const { kept: findings, exempted } = applyExemptions(integrityFindings(diff.files, planned, { tree: diff.tree }), planExemptions(planned))
    const range = `${diff.base.slice(0, 12)}...${diff.head.slice(0, 12)}`
    const excused = exempted.map(({ finding, reason }) => `exempted by the approved plan: ${finding.rule} ${finding.file} (${reason})`).join('\n')
    if (findings.length === 0) return verdict('passed', [`test integrity: no findings in ${diff.files.length} changed file(s), ${range}`, excused].filter(Boolean).join('\n'))
    const report = [integrityEvidence(findings), excused].filter(Boolean).join('\n')
    const digest = deps.workbench.kernel.blobs.put(report)
    const text = `test integrity: ${findings.length} finding(s) in ${range}; report ${digest}\n${report}`
    return verdict('failed', text.length > TAIL ? `${text.slice(0, TAIL)}…` : text)
  }

  async function review(payload: CheckPayload): Promise<EffectResult> {
    const parsed = paramsOf(ReviewParams, payload)
    if ('fail' in parsed) return parsed
    if (!deps.llm) return verdict('blocked', 'no model runtime is available for the review')
    const work = await diffOf(payload)
    if ('result' in work) return work.result
    const { diff } = work
    const pinned = deps.workbench.workflow(payload.manifestId)
    const model = parsed.params.model ?? pinned.extra.stages[payload.stageId]?.model
    if (!model) return verdict('blocked', `stage ${payload.stageId} has no model for the review`)
    const plan = approvedPlan(deps.workbench, payload.jobId)
    const followUps = followUpsSince(deps.workbench, payload.jobId, plan?.attemptId)
    const outcome = await reviewChange(deps.llm, { model, diff: diff.patch, files: diff.files.map(file => file.path), ...plan?.text ? { plan: plan.text } : {},
      ...followUps.length > 0 ? { followUps } : {},
      ...deps.defaultProvider ? { defaultProvider: deps.defaultProvider } : {}, ...parsed.params.maxDiffChars ? { maxChars: parsed.params.maxDiffChars } : {},
      ...deps.locale ? { language: deps.locale } : {} })
    if (outcome.kind === 'unavailable') return { ok: { outcome: 'blocked', evidence: `review (${model}): ${outcome.reason}`, tokens: outcome.tokens } }
    // The engineer gets only the blocking findings (`evidence`, the next attempt's input on a failure); people get the rest (`notes`).
    const evidence = reviewEvidence(outcome.review)
    const notes = reviewNotes(outcome.review)
    return { ok: { outcome: outcome.review.verdict === 'pass' ? 'passed' : 'failed', evidence: evidence.length > TAIL ? `${evidence.slice(0, TAIL)}…` : evidence,
      tokens: outcome.tokens, ...notes ? { notes: notes.length > TAIL ? `${notes.slice(0, TAIL)}…` : notes } : {},
      // For the person who merges (`P16`): about the commit reviewed, kept out of `evidence` so it never steers the next attempt.
      ...outcome.risk && outcome.review.verdict === 'pass' ? { risk: { ...outcome.risk, commit: diff.head } } : {} } }
  }

  return {
    idempotent: true,
    long: true,
    limit: () => deps.limit ?? 2,
    async run(payload, key, attempt) {
      const controller = new AbortController()
      running.set(key, controller)
      try {
        switch (payload.check.kind) {
          case 'command': return await command(payload, controller.signal)
          case 'gitlab-ci': return await ci(payload, attempt)
          case 'test-integrity': return await integrity(payload)
          case 'review': return await review(payload)
          default: return { fail: `no check runs kind ${payload.check.kind}` }
        }
      } catch (error) {
        return controller.signal.aborted ? { fail: 'the check was stopped' } : { fail: error instanceof Error ? error.message : String(error) }
      } finally {
        running.delete(key)
      }
    },
    async cancel(_payload, key) { running.get(key)?.abort() },
  }
}
