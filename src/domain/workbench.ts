/**
 * The domain assembled on the kernel: the job decider with its lookups, the domain's tables and projections, intake through the
 * router, and the entry points adapters call: inbox events, stage reports, usage, safe-output requests and resuming a parked
 * job. Workflow plugins register definitions and guards here; `start` recovers and starts the kernel once they have.
 */
import type { Submitted } from '../kernel/engine.ts'
import type { Env } from '../kernel/env.ts'
import type { InboxEvent, InboxInput } from '../kernel/inbox.ts'
import { Kernel, type KernelOptions, type RecoveryReport } from '../kernel/kernel.ts'
import { sha256Hex } from '../kernel/projections.ts'
import { jobDecider, type Guard } from './decider.ts'
import { defineWorkflow, DeclarationSchema, pinManifest, readPinned, type Declaration, type ModelProfile, type PinnedWorkflow, type WorkflowSpec } from './definition.ts'
import { EFFECT, type JobCommand, type JobEvent, type JobState, type NoticePayload } from './job.ts'
import type { Policy } from './policy.ts'
import { DOMAIN_PROJECTIONS, DOMAIN_SCHEMA } from './projections.ts'
import type { RepositoryProfile } from './repositories.ts'
import { route, WORKBENCH_SOURCE, type BoundJob, type Route } from './router.ts'

export interface WorkbenchOptions {
  /** `<stateDir>/workbench.sqlite`, or `:memory:`. */
  readonly path: string
  readonly env?: Env
  /** The configured models (`D9`), pinned into each new job's manifest. */
  readonly profile: ModelProfile
  /** The current policy; read for every decision, so a change applies to running jobs. */
  readonly policy: () => Policy
  /**
   * Workflow ids in the order intake tries them (the latest registered version of each). By default every registered one: those
   * whose triggers all have a pattern first, then the rest, each by id.
   */
  readonly intake?: readonly string[]
  /** The deployment's parameters for a workflow and the job's repository, frozen into each new job's manifest. */
  readonly parameters?: (workflowId: string, repository: RepositoryProfile | undefined) => Readonly<Record<string, string>>
  /** The deployment's repositories (`T11.1`); a new job's repository is chosen from them, and with none, jobs have none. */
  readonly repositories?: readonly RepositoryProfile[] | (() => readonly RepositoryProfile[])
  /** Recognizes the workbench's own posts on sources where it has no identity of its own (GitLab). */
  readonly ownPost?: (event: InboxEvent) => boolean
  /** The deployment's language (`D14`), frozen into each new job's manifest: its stage prompts are chosen in it. */
  readonly locale?: string
  readonly kernel?: Pick<KernelOptions<JobState, JobCommand, JobEvent>, 'baseBackoffMs' | 'maxBackoffMs' | 'pollMs'>
}

/** A tool call's identity: the session that made it and its call id, so a repeated call is consumed once. */
export interface ToolCall { readonly session: string; readonly id: string }

const ENDED = new Set(['completed', 'failed', 'cancelled'])
const specific = (declaration: Declaration) => declaration.triggers.every(trigger => trigger.pattern !== undefined)

/** The kernel with the job decider, the domain's projections and the routing entry points; one per process. */
export class Workbench {
  readonly kernel: Kernel<JobState, JobCommand, JobEvent>
  private readonly options: WorkbenchOptions
  /** Pinned workflows by manifest id; manifests and their blobs are immutable, so this never goes stale. */
  private readonly pinned = new Map<string, PinnedWorkflow>()
  /** The recovery report of `start`, once started. */
  private started: RecoveryReport | undefined
  /** Validated declarations of registered definitions, so routing does not validate them for every event. */
  private readonly declarations = new WeakMap<object, Declaration>()

  constructor(options: WorkbenchOptions) {
    this.options = options
    const decider = jobDecider({
      workflow: manifestId => this.workflow(manifestId),
      guard: name => this.kernel.registry.guard(name) as Guard | undefined,
      policy: () => options.policy(),
    })
    this.kernel = new Kernel<JobState, JobCommand, JobEvent>({ path: options.path, decider, owners: [DOMAIN_SCHEMA],
      ...options.env ? { env: options.env } : {}, ...options.kernel })
    for (const projection of DOMAIN_PROJECTIONS) this.kernel.projections.register(projection)
  }

  /** Registers a workflow (validated first); returns a disposer. */
  register(spec: WorkflowSpec): () => void {
    return this.kernel.registry.register(defineWorkflow(spec))
  }

  /** Registers a pure guard by name; returns a disposer. */
  registerGuard(name: string, guard: Guard): () => void {
    return this.kernel.registry.registerGuard(name, guard as (...args: never[]) => unknown)
  }

  /** The workflow a manifest pinned. */
  workflow(manifestId: string): PinnedWorkflow {
    let pinned = this.pinned.get(manifestId)
    if (!pinned) {
      const manifest = this.kernel.engine.manifest(manifestId)
      if (!manifest) throw new Error(`No run manifest ${manifestId}`)
      pinned = readPinned(this.kernel.registry, manifest)
      this.pinned.set(manifestId, pinned)
    }
    return pinned
  }

  /** Where an inbox event goes, given the current bindings, open gates, workflows and policy. */
  route(event: InboxEvent): Route {
    const { db, registry } = this.kernel
    const ids = this.options.intake ?? [...new Set(registry.list().map(definition => definition.id))]
    const workflows = ids.flatMap(id => {
      const definition = registry.definition(id)
      if (!definition) return []
      let declaration = this.declarations.get(definition)
      if (!declaration) {
        declaration = DeclarationSchema.parse(definition.declaration)
        this.declarations.set(definition, declaration)
      }
      return [{ id, version: definition.version, declaration }]
    })
    // Without a configured order, a workflow whose triggers all have a pattern is tried before a catch-all one.
    if (!this.options.intake) workflows.sort((a, b) => Number(!specific(a.declaration)) - Number(!specific(b.declaration)))
    return route(event, {
      bindings: threadKey => db.all<BoundJob>(`SELECT b.job_id AS jobId, b.role AS role, j.status AS status, json_extract(j.state, '$.closedBy') AS closedBy FROM binding b
        JOIN job j ON j.id = b.job_id WHERE b.thread_key = ? ORDER BY j.created_at DESC, j.id DESC`, threadKey),
      openGate: threadKey => db.get<{ jobId: string; gateId: string }>(
        'SELECT job_id AS jobId, gate_id AS gateId FROM open_gate WHERE thread_key = ? ORDER BY opened_at DESC, rowid DESC LIMIT 1', threadKey),
      workflows,
      policy: this.options.policy(),
      ...this.options.ownPost ? { ownPost: this.options.ownPost } : {},
      ...this.options.repositories ? { repositories: typeof this.options.repositories === 'function' ? this.options.repositories() : this.options.repositories } : {},
    })
  }

  /** Routes an inbox event and hands it to its job; an ignored event is settled with the reason. */
  handle(event: InboxEvent): { route: Route; submitted?: Submitted } {
    const { db, engine, inbox } = this.kernel
    const decided = this.route(event)
    const origin = { kind: 'inbox' as const, id: event.id }
    switch (decided.kind) {
      case 'ignore':
        db.tx(() => { inbox.settle(event.id, 'ignored', { reason: decided.reason }) })
        return { route: decided }
      case 'notice': {
        // No job starts; the reply is a job-less effect, queued with the event's settlement, so it is posted once (`A20`).
        const payload: NoticePayload = { eventId: event.id, threadKey: decided.threadKey, notice: decided.notice }
        db.tx(() => {
          inbox.settle(event.id, 'ignored', { reason: decided.reason })
          this.kernel.effects.notify(EFFECT.notice, payload, `notice:${event.id}`, `post:${decided.threadKey}`)
        })
        this.kernel.wake()
        return { route: decided }
      }
      case 'newJob': {
        const { intake, repository } = decided
        const manifest = pinManifest(this.kernel.registry, { id: intake.workflowId, version: intake.workflowVersion }, this.options.profile, intake.policyVersion,
          this.options.parameters?.(intake.workflowId, repository), repository, this.options.locale)
        return { route: decided, submitted: engine.create(event.id.replace(/^in_/, 'job_'), manifest, { kind: 'start', intake }, origin) }
      }
      case 'gateReply': return { route: decided, submitted: engine.submit(decided.jobId, { kind: 'reply', gateId: decided.gateId, message: decided.message }, origin) }
      case 'followUp': return { route: decided, submitted: engine.submit(decided.jobId, { kind: 'followUp', message: decided.message }, origin) }
      case 'machineFact': return { route: decided, submitted: engine.submit(decided.jobId,
        { kind: 'fact', fact: decided.fact, threadKey: decided.threadKey, data: decided.data }, origin) }
      case 'resume': return { route: decided, submitted: engine.submit(decided.jobId, { kind: 'resume' }, origin) }
    }
  }

  /**
   * A stage report from `workbench_stage_report`. An artifact's text is stored in the blob store in the same transaction, and the
   * report carries its digest.
   */
  report(jobId: string, attemptId: string, call: ToolCall, report: Record<string, unknown>, artifact?: { text: string; title?: string }): Submitted {
    const withArtifact = artifact ? { ...report, artifact: { digest: sha256Hex(artifact.text), ...artifact.title ? { title: artifact.title } : {} } } : report
    return this.kernel.engine.submit(jobId, { kind: 'report', attemptId, report: withArtifact }, { kind: 'tool', ...call },
      artifact ? () => { this.kernel.blobs.put(artifact.text) } : undefined)
  }

  /** Cumulative usage of an attempt so far. */
  usage(jobId: string, attemptId: string, call: ToolCall, usage: { turns: number; tokens: number }): Submitted {
    return this.kernel.engine.submit(jobId, { kind: 'usage', attemptId, ...usage }, { kind: 'tool', ...call })
  }

  /** A safe-output write a stage requests. */
  action(jobId: string, attemptId: string, call: ToolCall, action: string, payload: unknown): Submitted {
    return this.kernel.engine.submit(jobId, { kind: 'action', attemptId, action, payload }, { kind: 'tool', ...call })
  }

  /** Re-evaluates a parked job, through the inbox so the request is durable. */
  resume(jobId: string): { route: Route; submitted?: Submitted } {
    const version = this.kernel.engine.job(jobId)?.version ?? 0
    // Each request is its own event: a request refused while a guard was missing must not answer a later one.
    const { event } = this.kernel.inbox.append({ source: WORKBENCH_SOURCE, externalId: `resume:${jobId}:${version}:${this.kernel.env.ids.next()}`, human: false,
      payload: { kind: 'resume', jobId } })
    return this.handle(event)
  }

  /**
   * Appends a source's event to the inbox and, once started, routes it at once; before `start`, it waits there and recovery routes
   * it. A redelivered event is not routed again.
   */
  receive(input: InboxInput): { event: InboxEvent; duplicate: boolean; route?: Route; submitted?: Submitted } {
    const { event, duplicate } = this.kernel.inbox.append(input)
    if (duplicate || !this.started || event.status !== 'received') return { event, duplicate }
    return { event, duplicate, ...this.handle(event) }
  }

  /**
   * Recovers after a restart (waiting inbox events are routed), starts the kernel's loops, and resumes parked jobs whose guards
   * are registered again. Runs once; a later call returns the first report.
   */
  start(): RecoveryReport {
    if (this.started) return this.started
    const report = this.kernel.recover({ route: event => { this.handle(event) }, active: status => !ENDED.has(status) })
    this.started = report
    this.kernel.start()
    for (const { id } of this.kernel.db.all<{ id: string }>("SELECT id FROM job WHERE status = 'parked' ORDER BY id")) {
      const job = this.kernel.engine.job(id)!
      const manifest = this.kernel.engine.manifest(job.manifestId)!
      if (this.kernel.registry.missingGuards(manifest).length === 0) this.resume(id)
    }
    return report
  }

  async stop(): Promise<void> { await this.kernel.stop() }
  close(): void { this.kernel.close() }
}
