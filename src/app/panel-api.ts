/**
 * The supervision API (`T9.9`, `D7`, `D13`): what the read-only dashboard shows, read from the workbench's state: the job list and
 * each job's detail (state, events, gates, artifacts, effects, the workbench's own posts, attempts, the traffic on its threads and its
 * network connections), an attempt's agent trace, system health, and the effective settings with where each comes from (`D9`).
 * Every route is a `GET`; the dashboard's server (`dashboard-server.ts`) serves them and redacts the deployment's secrets.
 */
import type { JobState, GateKind } from '../domain/job.ts'
import { stageTitleIn, type PinnedWorkflow } from '../domain/definition.ts'
import type { Actor, Policy } from '../domain/policy.ts'
import type { RepositoryProfile } from '../domain/repositories.ts'
import type { Workbench } from '../domain/workbench.ts'
import { escapeRegExp } from '../infra/text.ts'
import type { KindHealth } from '../kernel/effects.ts'
import type { Health } from '../sources/host.ts'
import { attemptSessionId } from '../adapters/stage-runner.ts'
import type { MergeRisk } from '../adapters/merge-risk.ts'
import type { AgentTrace } from './agent-trace.ts'

/** What a job waits for, when it waits on people or on the deployment. */
export interface Waiting {
  /** A gate's kind, or `parked` (the deployment must change). `proposal` only as a job's `proposals`: it stops no job. */
  readonly kind: GateKind | 'parked'
  /** The approval's subject (`plan r2`), the block's reason, the round's progress (`1/3`), what a parked job misses, or how many proposals are pending. */
  readonly subject: string | null
  /**
   * Who may answer: names as people know them, and `*` for any allowed sender. Empty for a question round means anyone in its thread
   * (a workflow with places); for an approval, that no approver is known; for a parked job, nobody.
   */
  readonly who: readonly string[]
  /** The thread the answer is expected in. */
  readonly thread: string | null
  readonly since: number
}
export interface JobRow {
  readonly id: string; readonly workflowId: string; readonly workflowVersion: number; readonly status: string; readonly stageId: string | null
  readonly gateId: string | null; readonly detail: string | null; readonly requester: string; readonly originThread: string
  /** The open gate's thread (`D12`): where the job is waiting for people, which need not be where it started. */
  readonly gateThread: string | null
  readonly startedAt: number; readonly updatedAt: number
  /** The bound Jira ticket's summary when known, else the request's first line. */
  readonly title: string
  readonly ticket: string | null
  /** The bound merge request's thread (`gitlab:<project>!<iid>`), the newest when there are several, else null. */
  readonly mergeRequest: string | null
  /** A completed job that takes nothing more: the fact that closed it after it finished (`mr_merged`), or `person`; else null. */
  readonly closedBy: string | null
  readonly repository: string | null
  /** Tokens used, and the budget with approved extensions. */
  readonly tokens: number
  readonly budget: number
  readonly waiting: Waiting | null
  /**
   * The proposed requirement changes the approvers must decide (`D12`), whatever the job's status (it may be running or completed):
   * how many are pending, who decides, the thread they are decided in (the open plan approval's, else the proposal request's) and
   * since when the oldest waits. Null when none is pending.
   */
  readonly proposals: Waiting | null
  /** The workflow's stages, in order, so a list can show where the job is without its manifest (`A6`). */
  readonly stages: readonly { readonly id: string; readonly title: string }[]
  /** The merge risk a passed review gave the job's last attempt (`P16`): a model's estimate for whoever merges; null when there is none. */
  readonly risk: MergeRisk | null
}
export interface EventRow { readonly seq: number; readonly type: string; readonly at: number; readonly causation: string; readonly data: Record<string, unknown> }
export interface EffectRow {
  readonly id: string; readonly kind: string; readonly status: string; readonly attempts: number; readonly dueAt: number
  readonly payload: unknown; readonly result: unknown
}
export interface MessageRow {
  readonly id: string; readonly source: string; readonly threadKey: string | null; readonly actor: string | null; readonly human: boolean
  readonly receivedAt: number; readonly text: string | null; readonly status: string; readonly outcome: unknown
}
/** A post the workbench made or tried to make, with the text as sent. */
export interface OutboundRow {
  readonly id: string; readonly at: number; readonly threadKey: string; readonly status: string; readonly kind: string; readonly text: string | null
  /** Whether `text` is the text as posted; else it is rendered now (a post from before it was recorded, or one not posted yet). */
  readonly recorded: boolean
}
export interface AttemptRow {
  readonly id: string; readonly stageId: string; readonly n: number; readonly entry: string; readonly startedAt: number; readonly endedAt: number | null
  readonly running: boolean; readonly turns: number; readonly tokens: number
  /** The stage report's outcome (`completed`, `question`, `backtrack`, `blocked`), `failed`, or null while it runs. */
  readonly outcome: string | null
  readonly summary: string | null
  /** Each check's result. A review also gives `notes` (what it said that fails nothing, one per line) and, when it passed, the merge `risk` (`P16`). */
  readonly checks: readonly { readonly id: string; readonly outcome: string; readonly evidence: string; readonly at: number
    readonly notes?: string; readonly risk?: MergeRisk }[]
  readonly sessionId: string
}
export interface JobDetail {
  readonly job: JobRow & { readonly kernelStatus: string; readonly version: number }
  readonly manifest: { readonly definition: string; readonly hash: string; readonly verdictModel: string; readonly policyVersion: string
    readonly parameters: Record<string, string>; readonly stages: { readonly id: string; readonly title: string; readonly model: string; readonly effort?: string
      readonly agentPreset: string; readonly permissionPreset: string; readonly egress: string; readonly tools: readonly string[] }[]
    readonly budgets: { readonly turns: number; readonly tokens: number; readonly backtracks: number } }
  readonly state: JobState
  readonly events: readonly EventRow[]
  readonly effects: readonly EffectRow[]
  readonly timers: readonly { readonly kind: string; readonly subject: string; readonly dueAt: number; readonly status: string }[]
  readonly artifacts: readonly { readonly kind: string; readonly n: number; readonly digest: string; readonly title?: string; readonly text: string | null }[]
  readonly communication: readonly MessageRow[]
  readonly outbound: readonly OutboundRow[]
  readonly attempts: readonly AttemptRow[]
  /** Every connection the job's sandboxes asked the egress proxy for, allowed or refused (`T10.2`). */
  readonly egress: readonly { readonly at: number; readonly attemptId: string | null; readonly host: string; readonly port: number
    readonly address: string | null; readonly allowed: boolean; readonly reason: string }[]
}
export interface HealthView {
  readonly runtime: Readonly<Record<string, Health>>
  readonly effects: Readonly<Record<string, KindHealth>>
  readonly inbox: Readonly<Record<string, number>>
  readonly jobs: Readonly<Record<string, number>>
  readonly timers: { readonly armed: number; readonly nextDue: number | null }
  readonly kernelError: string | null
}
/** Where threads open in their tools: each source's base address, when the deployment knows it. */
export interface Links { readonly jira?: string; readonly mattermost?: string; readonly gitlab?: string }
export interface SettingsView {
  readonly models: { readonly default: string; readonly effort?: string; readonly verdict: string; readonly from: string }
  readonly policy: Policy & { readonly from: string }
  readonly maxWorkers: number
  readonly locale: string
  readonly demo: boolean
  /** The repositories jobs work in (`T11.1`). */
  readonly repositories: readonly RepositoryProfile[]
  readonly workflows: readonly { readonly id: string; readonly version: number; readonly title: string; readonly parameters: Record<string, string>
    readonly stages: readonly { readonly id: string; readonly title: string; readonly model: string; readonly agentPreset: string; readonly egress: string }[]
    readonly budgets?: { readonly turns: number; readonly tokens: number; readonly backtracks: number } }[]
  readonly links: Links & { readonly from: string }
}
export interface StateView {
  readonly jobs: readonly JobRow[]
  readonly health: HealthView
  /** Mattermost user ids to usernames, as resolved by the runtime. */
  readonly people: Readonly<Record<string, string>>
  readonly links: Links
  /** Model tokens used since midnight in the workbench's time zone, by stage attempts, checks and answer turns. */
  readonly tokensToday: number
  /** The language the deployment writes in, the dashboard's default. */
  readonly locale: string
  readonly demo: boolean
}

/** The routes and what each returns; the dashboard's client is typed by it. */
export interface PanelApi {
  'GET state': StateView
  'GET jobs/:id': JobDetail
  'GET jobs/:id/attempts/:attemptId/trace': AgentTrace
  'GET inbox': { readonly messages: readonly MessageRow[] }
  'GET settings': SettingsView
}

/** What the API reads; the runtime provides it. */
export interface PanelHost {
  readonly workbench: Workbench
  health(): Readonly<Record<string, Health>>
  settings(): SettingsView
  /** Values to redact from every answer (the deployment's secrets). */
  secrets(): readonly string[]
  /** Mattermost user ids to usernames. */
  people(): Readonly<Record<string, string>>
  links(): Links
  locale(): string
  demo(): boolean
  /** Who may decide a job's approval and resume gates (`eligible()` in `policy.ts`): names as people know them, `*` for any allowed sender. */
  deciders(workflowId: string, repository: string | null, requester: Actor): readonly string[]
  /** A Jira ticket's summary, when known (cached; looked up in the background). */
  ticketTitle(key: string): string | undefined
  /** A post's text as the workbench sends it, or null when it cannot be rendered. */
  renderPost(jobId: string, threadKey: string, message: unknown): string | null
  /** An attempt's agent trace, read from its DSH session. */
  trace(sessionId: string): Promise<AgentTrace>
}

/** A request the API refuses, with its HTTP status. */
export class RouteError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

/** Redacts one string: each whole secret, and the start of one that a cut ended. */
function redactText(text: string, forms: readonly string[]): string {
  let out = text
  for (const form of forms) {
    if (!out.includes(form.slice(0, 6))) continue
    out = out.replaceAll(form, '[REDACTED]')
    // Longest first, so the whole kept start goes, not its first six characters.
    const prefixes = Array.from({ length: form.length - 6 }, (_, index) => escapeRegExp(form.slice(0, form.length - 1 - index)))
    if (prefixes.length) out = out.replace(new RegExp(`(?:${prefixes.join('|')})(…|\\.\\.\\.)`, 'gu'), '[REDACTED]$1')
  }
  return out
}

/**
 * Replaces every occurrence of a secret value in the strings of `value` (secrets shorter than 6 characters are too common to redact
 * safely), its URL-encoded form too, and the start of one that a cut ended (6 characters or more followed by `…` or `...`): text is
 * cut in several places before it reaches the API. Only string values are rewritten: keys, numbers and the structure stay as they are.
 */
export function redact<T>(value: T, secrets: readonly string[]): T {
  const forms = [...new Set(secrets.filter(secret => secret.length >= 6).flatMap(secret => [secret, encodeURIComponent(secret)]))]
  if (forms.length === 0) return value
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return redactText(item, forms)
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object' && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]))
    }
    return item
  }
  return walk(value) as T
}

const parse = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text) as unknown } catch { return text } }
const ENDED = new Set(['completed', 'failed', 'cancelled'])

/** The request's first line without the mention and routing words, for a job with no ticket summary. */
export function requestTitle(text: string | undefined): string {
  const line = (text ?? '').split('\n').map(part => part.trim()).find(Boolean) ?? ''
  return line.replace(/@[\w.-]+/gu, '').replace(/\brepo:\S+/gu, '').replace(/\s+/gu, ' ').trim()
}

interface GateLike { kind: GateKind; stageId: string; threadKey: string; openedAt: number; subject?: { kind: string; n: number }; items?: readonly unknown[]
  answers?: Readonly<Record<string, readonly unknown[]>>; blocked?: { kind: string } }

/** What a job waits for, from its summary and the open gate (`A3`). */
function waiting(host: Pick<PanelHost, 'deciders'>, row: Record<string, unknown>, repository: string | null, places: boolean): Waiting | null {
  const status = row.status as string
  if (status === 'parked') {
    return { kind: 'parked', subject: (row.detail as string | null) ?? null, who: [], thread: null, since: row.updated_at as number }
  }
  if (status !== 'awaiting_gate' && status !== 'blocked') return null
  const gate = parse(row.gate as string | null) as GateLike | null
  if (!gate) return null
  const deciders = () => host.deciders(row.workflow_id as string, repository, { source: row.requester_source as string, id: row.requester_id as string })
  if (gate.kind === 'question') {
    const items = gate.items?.length ?? 0
    const answered = Object.values(gate.answers ?? {}).filter(list => list.length > 0).length
    // Anyone in the thread answers a round only where the workflow declares places (`participants`, `decider.ts`); elsewhere the allowed
    // senders do (and the approvers, who are named for approvals).
    return { kind: 'question', subject: `${answered}/${items}`, who: places ? [] : ['*'], thread: gate.threadKey, since: gate.openedAt }
  }
  if (gate.kind === 'approval') {
    return { kind: 'approval', subject: gate.subject ? `${gate.subject.kind} r${gate.subject.n}` : null, who: deciders(), thread: gate.threadKey, since: gate.openedAt }
  }
  return { kind: 'resume', subject: gate.blocked?.kind ?? (row.detail as string | null) ?? null, who: deciders(), thread: gate.threadKey, since: gate.openedAt }
}

/** The pending proposals of a job and the open gate they are decided on (`proposalGate()` in `decider.ts`), as something it waits for. */
function pendingProposals(host: Pick<PanelHost, 'deciders'>, row: Record<string, unknown>, repository: string | null): Waiting | null {
  const pending = ((parse(row.proposals as string | null) ?? []) as { status: string; at: number }[]).filter(proposal => proposal.status === 'pending')
  const thread = (row.proposal_thread as string | null) ?? null
  if (pending.length === 0 || thread === null) return null
  return { kind: 'proposal', subject: String(pending.length), thread, since: Math.min(...pending.map(proposal => proposal.at)),
    who: host.deciders(row.workflow_id as string, repository, { source: row.requester_source as string, id: row.requester_id as string }) }
}

/** A check's merge risk as the host made it (`mergeRisk()`); anything else an event or the state carries under `risk` is not shown. */
function riskOf(value: unknown): MergeRisk | undefined {
  const risk = value as Partial<MergeRisk> | null | undefined
  const whole = risk && typeof risk === 'object' && ['low', 'medium', 'high'].includes(risk.level as string) && risk.categories && typeof risk.categories === 'object'
    && Array.isArray(risk.floor) && Array.isArray(risk.sensitive)
  return whole ? risk as MergeRisk : undefined
}

/** The job list, newest first: every job still in play, and the newest `limit` (a job waiting on people never drops off). */
export function jobs(host: Pick<PanelHost, 'workbench' | 'deciders' | 'ticketTitle'> & Partial<Pick<PanelHost, 'locale'>>, limit = 200, id?: string): JobRow[] {
  const { workbench } = host
  return workbench.kernel.db.all<Record<string, unknown>>(`SELECT s.*, j.updated_at, j.manifest_id, g.thread_key AS gate_thread,
      json_extract(j.state, '$.usage.tokens') AS tokens, json_extract(j.state, '$.extended.tokens') AS extended,
      json_extract(j.state, '$.intake.text') AS intake_text, json_extract(j.state, '$.intake.repository.name') AS repository,
      json_extract(j.state, '$.bindings') AS bindings, json_extract(j.state, '$.closedBy') AS closed_by, json_extract(j.state, '$.proposals') AS proposals, json_extract(j.state, '$.attempt.checks') AS checks,
      (SELECT o.thread_key FROM open_gate o WHERE o.job_id = s.job_id AND o.kind IN ('approval', 'proposal') ORDER BY o.kind LIMIT 1) AS proposal_thread,
      CASE WHEN s.gate_id IS NULL THEN NULL ELSE json_extract(j.state, '$.gates."' || s.gate_id || '"') END AS gate
    FROM job_summary s JOIN job j ON j.id = s.job_id LEFT JOIN open_gate g ON g.gate_id = s.gate_id
    WHERE ${id ? 's.job_id = ?' : `s.status NOT IN ('completed', 'failed', 'cancelled')
      OR EXISTS (SELECT 1 FROM open_gate o WHERE o.job_id = s.job_id AND o.kind = 'proposal')
      OR s.job_id IN (SELECT job_id FROM job_summary ORDER BY started_at DESC, job_id DESC LIMIT ?)`}
    ORDER BY s.started_at DESC, s.job_id DESC`, id ?? limit).map(row => {
    const bindings = (parse(row.bindings as string | null) ?? []) as { threadKey: string }[]
    const ticket = bindings.map(binding => /^jira:(.+)$/u.exec(binding.threadKey)?.[1]).find(key => key !== undefined) ?? null
    const repository = (row.repository as string | null) ?? null
    // The same check the completion post takes its risk from (`JobCompleted` in `decider.ts`).
    const reviewed = Object.values((parse(row.checks as string | null) ?? {}) as Record<string, { outcome?: string; risk?: unknown }>).find(check => check.outcome === 'passed' && check.risk)
    let budget = 0
    let stages: { id: string; title: string }[] = []
    let places = false
    try {
      const { declaration } = workbench.workflow(row.manifest_id as string)
      budget = declaration.budgets.tokens
      stages = declaration.stages.map(stage => ({ id: stage.id, title: stageTitleIn(stage, host.locale?.() ?? 'en') }))
      places = declaration.places !== undefined
    } catch { /* a workflow this deployment no longer registers (parked) */ }
    return {
      id: row.job_id as string, workflowId: row.workflow_id as string, workflowVersion: row.workflow_version as number, status: row.status as string,
      stageId: row.stage_id as string | null, gateId: row.gate_id as string | null, detail: row.detail as string | null,
      requester: `${row.requester_source as string}:${row.requester_id as string}`, originThread: row.origin_thread as string,
      gateThread: (row.gate_thread as string | null) ?? null, startedAt: row.started_at as number, updatedAt: row.updated_at as number,
      title: (ticket ? host.ticketTitle(ticket) : undefined) ?? requestTitle(row.intake_text as string | undefined),
      ticket, mergeRequest: bindings.findLast(binding => binding.threadKey.startsWith('gitlab:'))?.threadKey ?? null, closedBy: (row.closed_by as string | null) ?? null, repository, tokens: (row.tokens as number | null) ?? 0, budget: budget + ((row.extended as number | null) ?? 0),
      waiting: waiting(host, row, repository, places), proposals: pendingProposals(host, row, repository), stages,
      risk: riskOf(reviewed?.risk) ?? null,
    }
  })
}

const messageRow = (row: Record<string, unknown>): MessageRow => {
  const payload = parse(row.payload as string) as { text?: unknown } | null
  return { id: row.id as string, source: row.source as string, threadKey: row.thread_key as string | null,
    actor: row.actor_id ? `${row.actor_source as string}:${row.actor_id as string}` : null, human: row.human === 1, receivedAt: row.received_at as number,
    text: typeof payload?.text === 'string' ? payload.text : null, status: row.status as string, outcome: parse(row.outcome as string | null) }
}

/** A job's stage attempts, from its events: usage, report, checks and the DSH session each ran in. */
export function attempts(events: readonly EventRow[], state: JobState): AttemptRow[] {
  const byId = new Map<string, { -readonly [K in keyof AttemptRow]: AttemptRow[K] } & { checks: AttemptRow['checks'][number][] }>()
  for (const event of events) {
    const data = event.data as Record<string, unknown> & { attemptId?: string }
    if (event.type === 'AttemptStarted') {
      const id = data.attemptId!
      byId.set(id, { id, stageId: data.stageId as string, n: data.n as number, entry: data.entry as string, startedAt: event.at, endedAt: null,
        running: false, turns: 0, tokens: 0, outcome: null, summary: null, checks: [], sessionId: attemptSessionId(id) })
      continue
    }
    const attempt = data.attemptId ? byId.get(data.attemptId) : undefined
    if (!attempt) continue
    if (event.type === 'UsageRecorded') { attempt.turns = data.turns as number; attempt.tokens = data.tokens as number }
    if (event.type === 'AttemptReported') {
      const report = data.report as { outcome: string; summary?: string; reason?: string }
      attempt.outcome = report.outcome; attempt.summary = report.summary ?? report.reason ?? null; attempt.endedAt = event.at
    }
    if (event.type === 'AttemptFailed') { attempt.outcome = 'failed'; attempt.summary = data.reason as string; attempt.endedAt = event.at }
    if (event.type === 'CheckCompleted') {
      const risk = riskOf(data.risk)
      attempt.checks.push({ id: data.checkId as string, outcome: data.outcome as string, evidence: data.evidence as string, at: event.at,
        ...typeof data.notes === 'string' && data.notes ? { notes: data.notes } : {}, ...risk ? { risk } : {} })
      attempt.endedAt = event.at
    }
  }
  const current = state.attempt && !state.attempt.ended ? state.attempt.id : undefined
  return [...byId.values()].map(attempt => ({ ...attempt, running: attempt.id === current && !ENDED.has(state.status.kind) }))
}

/** One job's detail. */
export function jobDetail(host: Pick<PanelHost, 'workbench' | 'deciders' | 'ticketTitle' | 'renderPost'> & Partial<Pick<PanelHost, 'locale'>>, id: string): JobDetail {
  const { workbench } = host
  const { db, engine, blobs } = workbench.kernel
  const job = engine.job(id)
  const row = jobs(host, 1, id)[0]
  if (!job || !row) throw new RouteError(404, `No job ${id}`)
  const pinned: PinnedWorkflow = workbench.workflow(job.manifestId)
  const threads = job.state.bindings.map(binding => binding.threadKey)
  const events = db.all<Record<string, unknown>>('SELECT seq, type, at, causation, data FROM job_event WHERE job_id = ? ORDER BY seq', id)
    .map(event => ({ seq: event.seq as number, type: event.type as string, at: event.at as number, causation: event.causation as string,
      data: parse(event.data as string) as Record<string, unknown> }))
  const effects = db.all<Record<string, unknown>>('SELECT * FROM effect WHERE job_id = ? ORDER BY seq', id).map(effect => ({ id: effect.id as string,
    kind: effect.kind as string, status: effect.status as string, attempts: effect.attempts as number, dueAt: effect.due_at as number,
    payload: parse(effect.payload as string), result: parse(effect.result as string | null) }))
  const { budgets } = pinned.declaration
  return {
    job: { ...row, kernelStatus: job.status, version: job.version },
    manifest: { definition: `${pinned.id}@${pinned.version}`, hash: pinned.hash, verdictModel: pinned.extra.verdictModel, policyVersion: pinned.extra.policyVersion,
      parameters: pinned.extra.parameters, stages: pinned.declaration.stages.map(stage => {
        const resolved = pinned.extra.stages[stage.id]!
        return { id: stage.id, title: stageTitleIn(stage, host.locale?.() ?? 'en'), model: resolved.model, ...resolved.effort ? { effort: resolved.effort } : {}, agentPreset: resolved.agentPreset,
          permissionPreset: resolved.permissionPreset, egress: resolved.egress, tools: resolved.tools }
      }), budgets: { turns: budgets.turns, tokens: budgets.tokens, backtracks: budgets.backtracks } },
    state: job.state,
    events,
    effects,
    timers: db.all<{ kind: string; subject: string; due_at: number; status: string }>('SELECT kind, subject, due_at, status FROM timer WHERE job_id = ? ORDER BY due_at', id)
      .map(timer => ({ kind: timer.kind, subject: timer.subject, dueAt: timer.due_at, status: timer.status })),
    artifacts: Object.values(job.state.artifacts).flat().map(revision => ({ kind: revision.kind, n: revision.n, digest: revision.digest,
      ...revision.title ? { title: revision.title } : {}, text: blobs.text(revision.digest) ?? null })),
    communication: threads.length === 0 ? [] : db.all<Record<string, unknown>>(`SELECT * FROM inbox_event WHERE thread_key IN (${threads.map(() => '?').join(',')})
      ORDER BY received_at, id`, ...threads).map(messageRow),
    outbound: effects.filter(effect => effect.kind === 'post').map(effect => {
      const payload = effect.payload as { threadKey: string; message: { kind: string } }
      const ok = (effect.result as { ok?: { postedAt?: number; threadKey?: string; text?: unknown } } | null)?.ok
      // The text as posted when the post recorded it; else as the workbench would write it now.
      const recorded = typeof ok?.text === 'string'
      return { id: effect.id, at: ok?.postedAt ?? effect.dueAt, threadKey: ok?.threadKey ?? payload.threadKey, status: effect.status,
        kind: payload.message.kind, text: recorded ? ok.text as string : host.renderPost(id, payload.threadKey, payload.message), recorded }
    }),
    attempts: attempts(events, job.state),
    egress: db.all<{ at: number; attempt_id: string | null; host: string; port: number; address: string | null; allowed: number; reason: string }>(
      'SELECT at, attempt_id, host, port, address, allowed, reason FROM egress_connection WHERE job_id = ? ORDER BY seq', id)
      .map(row => ({ at: row.at, attemptId: row.attempt_id, host: row.host, port: row.port, address: row.address, allowed: row.allowed === 1, reason: row.reason })),
  }
}

/** System health: the runtime's and Sources' entries, the effect queues, the inbox, jobs by status, timers and the kernel's last error. */
export function health(host: Pick<PanelHost, 'workbench' | 'health'>): HealthView {
  const { db, effects, timers, lastError } = host.workbench.kernel
  const counts = (sql: string) => Object.fromEntries(db.all<{ key: string; n: number }>(sql).map(row => [row.key, row.n]))
  return {
    runtime: host.health(),
    effects: effects.health(),
    inbox: counts('SELECT status AS key, count(*) AS n FROM inbox_event GROUP BY status'),
    jobs: counts('SELECT status AS key, count(*) AS n FROM job GROUP BY status'),
    timers: { armed: db.get<{ n: number }>("SELECT count(*) AS n FROM timer WHERE status = 'armed'")!.n, nextDue: timers.nextDue() ?? null },
    kernelError: lastError ?? null,
  }
}

/** Model tokens used since `since`: stage attempts' usage, checks' reviews and answer turns. */
export function tokensSince(workbench: Workbench, since: number): number {
  // Only jobs touched since then can have used tokens since then; their events are found by the event log's key.
  return workbench.kernel.db.get<{ n: number | null }>(`SELECT sum(coalesce(json_extract(e.data, '$.added.tokens'), json_extract(e.data, '$.tokens'), 0)) AS n
    FROM job j JOIN job_event e ON e.job_id = j.id WHERE j.updated_at >= ? AND e.type IN ('UsageRecorded', 'CheckCompleted', 'AnswerGiven') AND e.at >= ?`, since, since)?.n ?? 0
}

const midnight = (now: number) => { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.getTime() }

type Handler<K extends keyof PanelApi> = (params: Record<string, string>) => PanelApi[K] | Promise<PanelApi[K]>
export type Routes = { [K in keyof PanelApi]: Handler<K> }

export function routes(host: PanelHost): Routes {
  return {
    'GET state': () => ({ jobs: jobs(host), health: health(host), people: host.people(), links: host.links(),
      tokensToday: tokensSince(host.workbench, midnight(host.workbench.kernel.env.clock.now())), locale: host.locale(), demo: host.demo() }),
    'GET jobs/:id': params => jobDetail(host, params.id!),
    'GET jobs/:id/attempts/:attemptId/trace': params => {
      const job = host.workbench.kernel.engine.job(params.id!)
      const known = job && host.workbench.kernel.db.get('SELECT 1 FROM job_event WHERE job_id = ? AND type = \'AttemptStarted\' AND json_extract(data, \'$.attemptId\') = ?',
        params.id!, params.attemptId!)
      if (!known) throw new RouteError(404, `No attempt ${params.attemptId!} in job ${params.id!}`)
      return host.trace(attemptSessionId(params.attemptId!))
    },
    'GET inbox': () => ({ messages: host.workbench.kernel.db.all<Record<string, unknown>>('SELECT * FROM inbox_event ORDER BY received_at DESC, id DESC LIMIT 200')
      .map(messageRow) }),
    'GET settings': () => host.settings(),
  }
}
