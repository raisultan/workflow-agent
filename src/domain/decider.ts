/**
 * The job decider (`T8.6`–`T8.8`): a job's rules as pure functions over its state, its pinned workflow and the current policy.
 *
 * - **Stages.** An attempt starts as a long `stage.attempt` effect. Its report is a proposal: a completed report with checks moves
 *   the job to `verifying`, and only passing required checks let the transition table run. A second report for an attempt that
 *   already reported is rejected by state, whatever its tool-call id.
 * - **Retries and budgets.** A failed, interrupted, timed-out or over-limit attempt is retried within the stage's attempt budget,
 *   with a note on what happened. Turns and tokens per job, and backtracks per edge and in total, are budgets too. When one runs out
 *   the job blocks and opens a resume gate to its approvers: approving extends by the declared amount and resumes; cancel cancels.
 * - **Gates.** Question gates collect answers; approval gates are bound to an artifact revision digest and a thread. A reply is
 *   admitted only from an eligible actor, on the bound thread, posted after the gate's post. Its meaning comes from the vocabulary
 *   fast path or an `interpretReply` verdict; unclear replies, low confidence and an unavailable model never approve. Every
 *   approval is acknowledged. A new revision gets a new gate, and a reply posted before it is refused; expiry never approves.
 * - **Parking.** A transition whose guard is not registered parks the job; `resume` re-evaluates it once the guard is back.
 */
import { z } from 'zod'
import type { Decider, DecideContext, KernelCommand, RunManifest } from '../kernel/engine.ts'
import { checksOf, COMPLETE, outputError, stageOf, withoutNulls, type PinnedWorkflow, type Place, type StageDeclaration, type TransitionDeclaration } from './definition.ts'
import {
  ActionResultSchema, AnswerResultSchema, CheckResultSchema, EFFECT, isTerminal, MIN_CONFIDENCE, ReadingSchema, SetupResultSchema, StageReportSchema, TIMER, VerdictSchema,
  type ActionPayload, type ArtifactRevision, type AttemptEntry, type AttemptPayload, type BlockReason, type CheckPayload, type Gate,
  type AnswerPayload, type FollowUpPayload, type GateKind, type InterpretPayload, type Proposal, type ReadPayload, type JobCommand, type JobEvent, type JobState, type Message, type Outbound, type PostPayload, type Resume, type SetupPayload,
  type StageInput, type Verdict,
} from './job.ts'
import { eligible, isWorkbench, type Actor, type Policy, type Role } from './policy.ts'
import { ticketIn } from './router.ts'
import { isClose, isRetry, isStandaloneApproval, matchCancel } from './vocabulary.ts'

/** What a guard sees: plain, deeply frozen data. It returns whether its transition is taken. */
export interface GuardInput {
  readonly stageId: string
  readonly output: Readonly<Record<string, unknown>>
  readonly summary: string
  readonly artifacts: Readonly<Record<string, ArtifactRevision>>
  readonly backtracks: number
}
export type Guard = (input: GuardInput) => boolean

/** Lookups the decider reads; each is deterministic for its arguments (manifests and blobs are immutable). */
export interface DeciderDeps {
  /** The workflow a manifest pinned. */
  workflow(manifestId: string): PinnedWorkflow
  /** A registered guard, or `undefined` when its plugin is not loaded. */
  guard(name: string): ((input: GuardInput) => unknown) | undefined
  /** The current policy. */
  policy(): Policy
}

const PostResultSchema = z.object({ postId: z.string().min(1), postedAt: z.number().int() }).passthrough()
const attemptKey = (jobId: string) => `${jobId}/attempt`
const setupKey = (jobId: string) => `${jobId}/setup`

/** Freezes a JSON value deeply, so a guard cannot change what the decider holds. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const field of Object.values(value)) deepFreeze(field)
  }
  return value
}

/** The thread-key prefix of each place's source (`adapters/threads.ts`). */
const PLACE_PREFIX: Record<Exclude<Place, 'chat'>, string> = { ticket: 'jira:', mergeRequest: 'gitlab:' }

/**
 * The thread a place names for a job (`D12`): its chat thread (the trigger's Mattermost thread), its ticket or its merge request (the
 * latest bound); a place the job has no thread for falls back to the chat thread, then to the trigger's thread.
 */
export function placeThread(state: JobState, place: Place): string {
  const origin = state.originThread ?? ''
  // A direct message cannot take more people, so it is the chat thread only until the workbench opens one (`D12`).
  const chat = state.chatThread ?? (origin.startsWith('mattermost:') && state.intake?.basis !== 'direct' ? origin : undefined)
  const bound = place === 'chat' ? chat : state.bindings.filter(binding => binding.threadKey.startsWith(PLACE_PREFIX[place])).at(-1)?.threadKey
  return bound ?? chat ?? origin
}

/**
 * The Mattermost channel a new job opens its thread in (`D12`): its repository's first mapped channel, for a job of a workflow with
 * places that started in Jira or by a direct message; `undefined` when it needs none (or its repository has none).
 */
export function chatChannel(workflow: PinnedWorkflow, intake: { threadKey: string; basis: string }): string | undefined {
  const { repository } = workflow.extra
  if (!workflow.declaration.places || !repository) return undefined
  if (!intake.threadKey.startsWith('jira:') && intake.basis !== 'direct') return undefined
  return repository.match.mattermost[0]
}

/** Where a gate of `kind` opens: its place when the workflow declares places (`D12`), else the trigger's thread. */
export function gateThread(workflow: PinnedWorkflow, state: JobState, kind: GateKind): string {
  const { places } = workflow.declaration
  if (!places) return state.originThread ?? ''
  return placeThread(state, kind === 'approval' || kind === 'proposal' ? places.plan : places.clarification)
}

/** Where the job's outcome is posted: the clarification place when the workflow declares places, else the trigger's thread. */
function outcomeThread(workflow: PinnedWorkflow, state: JobState): string {
  const { places } = workflow.declaration
  return places ? placeThread(state, places.clarification) : state.originThread ?? ''
}

const latest = (state: JobState): ArtifactRevision[] => Object.values(state.artifacts).flatMap(revisions => revisions.at(-1) ? [revisions.at(-1)!] : [])

/** The decider over `deps`; the kernel runs it inside one transaction per input. */
export function jobDecider(deps: DeciderDeps): Decider<JobState, JobCommand, JobEvent> {
  return {
    initial: initialState,
    decide: (command, state, context) => decide(deps, command, state, context),
    evolve,
    effects: (event, state) => effectsOf(deps, event, state),
    timers: (event, state) => timersOf(deps, event, state),
    status: state => state.status.kind,
    // A faulted job still takes a cancellation.
    acceptsWhenFaulted: command => (command.kind === 'reply' || command.kind === 'followUp') && matchCancel(command.message.text) !== undefined,
  }
}

export function initialState(jobId: string, manifest: RunManifest): JobState {
  return {
    v: 1, jobId, manifestId: manifest.id, workflowId: manifest.definitionId, status: { kind: 'new' }, attemptCount: 0, visitAttempts: 0,
    questionRounds: 0, gateCount: 0, gates: {}, artifacts: {}, backtracks: { total: 0, edges: {} }, usage: { turns: 0, tokens: 0 },
    extended: { turns: 0, tokens: 0, backtracks: 0, attempts: 0 }, inputs: [], bindings: [], actions: 0,
  }
}

/** One decision: events emitted so far, and the state they lead to, so each step sees the previous ones. */
class Decision {
  readonly events: JobEvent[] = []
  state: JobState
  readonly workflow: PinnedWorkflow
  readonly deps: DeciderDeps
  readonly now: number
  readonly policy: Policy
  constructor(state: JobState, workflow: PinnedWorkflow, deps: DeciderDeps, now: number) {
    this.state = state
    this.workflow = workflow
    this.deps = deps
    this.now = now
    this.policy = deps.policy()
  }

  emit(event: JobEvent): void {
    this.events.push(event)
    this.state = evolve(this.state, event)
  }

  stage(id: string): StageDeclaration { return stageOf(this.workflow, id) }

  may(actor: Actor, role: Role): boolean {
    const { requester, workflowId } = this.state
    const repository = this.workflow.extra.repository?.name
    return requester !== undefined && eligible(this.policy, actor, role, { workflowId, requester, ...repository ? { repository } : {},
      participants: this.workflow.declaration.places !== undefined })
  }

  /** The running attempt to stop, if its effect may still run. */
  get running(): string | undefined {
    const { attempt } = this.state
    return attempt && !attempt.ended ? attempt.id : undefined
  }

  startAttempt(stageId: string, entry: AttemptEntry, inputs: readonly StageInput[] = []): void {
    this.stage(stageId)
    const { state } = this
    // `D12`: a change request kept from the merge request waits for review; an attempt of another stage (a retry of implement after
    // a red check) leaves it kept.
    const { places, reopen } = this.workflow.declaration
    const held = (input: StageInput) => places !== undefined && reopen !== undefined && stageId !== reopen.stage && input.kind === 'follow_up'
      && input.thread?.startsWith(PLACE_PREFIX.mergeRequest) === true
    // `D12`, change proposals: the requirements stage is given every accepted change not yet in a plan revision, as a requested change.
    const proposed: StageInput[] = stageId === reopen?.requirements
      ? (state.proposals ?? []).filter(proposal => proposal.status === 'accepted').map(proposal => ({ kind: 'changes_requested', text: proposal.text, by: proposal.by, proposal: proposal.id }))
      : []
    this.emit({ v: 1, type: 'AttemptStarted', attemptId: `${state.jobId}.a${state.attemptCount + 1}`, stageId,
      n: entry === 'retry' || entry === 'recovery' ? state.visitAttempts + 1 : 1, entry,
      inputs: [...state.inputs.filter(input => !held(input)), ...proposed, ...inputs], artifacts: latest(state), at: this.now })
    // Proposals still pending when an approval closed for a revision stay before the approvers on a request (`D12`).
    if (stageId === reopen?.requirements && (state.proposals ?? []).some(proposal => proposal.status === 'pending') && !this.proposalGate()) {
      this.openGate({ id: this.nextGateId(), kind: 'proposal', stageId })
    }
  }

  /** Whether the workflow decides changes to its requirements as proposals (`D12`): it has places and a requirements stage. */
  get proposing(): boolean {
    const { places, reopen } = this.workflow.declaration
    return places !== undefined && reopen?.requirements !== undefined
  }

  /** The open gate proposals are decided on: the plan's approval, else a proposal request (`D12`). */
  proposalGate(): Gate | undefined {
    const open = Object.values(this.state.gates).filter(gate => gate.status === 'open')
    return open.find(gate => gate.kind === 'approval') ?? open.find(gate => gate.kind === 'proposal')
  }

  /**
   * Raises a proposed change to the requirements (`D12`): accepted at once when an approver asks for it, else put to the approvers
   * on the open approval or proposal request, or on a new proposal request.
   */
  raise(message: Message, text: string): void {
    const approver = this.may(message.actor, 'approver')
    const proposal: Proposal = { id: `p${(this.state.proposals?.length ?? 0) + 1}`, text, by: message.actor, thread: message.threadKey,
      ...message.replyTo ? { replyTo: message.replyTo } : {}, at: this.now, status: approver ? 'accepted' : 'pending', ...approver ? { decidedBy: message.actor } : {} }
    this.emit({ v: 1, type: 'ProposalRaised', proposal, eventId: message.eventId })
    if (approver) this.accept([proposal])
    else if (!this.proposalGate()) this.openGate({ id: this.nextGateId(), kind: 'proposal', stageId: this.stageId() })
  }

  /**
   * Where an accepted proposal goes (`D12`): a finished job reopens at the requirements stage; a running attempt of that stage is
   * told; an open approval of the plan becomes a revision; otherwise it waits, and the next requirements attempt takes it (when the
   * job would complete, it goes there first).
   */
  accept(proposals: readonly Proposal[]): void {
    const { status } = this.state
    const [first] = proposals
    if (!first) return
    const stage = this.workflow.declaration.reopen!.requirements!
    const by = first.decidedBy ?? first.by
    // A job completed by a fact (a merged merge request) has dropped its proposals; only one completed through its stages reopens.
    if (status.kind === 'completed') {
      if (status.outcome !== 'completed' || this.state.closedBy) return
      this.emit({ v: 1, type: 'JobReopened', by, eventId: first.id, stage, threadKey: first.thread, ...first.replyTo ? { replyTo: first.replyTo } : {} })
      this.startAttempt(stage, 'reopen')
      return
    }
    if (status.kind === 'running' && status.stageId === stage) {
      // Every one is told to the running attempt, so its revision includes them all.
      for (const proposal of proposals) {
        this.emit({ v: 1, type: 'FollowUpReceived', steer: status.attemptId, proposal: proposal.id,
          message: { eventId: proposal.id, actor: proposal.by, threadKey: proposal.thread, text: proposal.text, postedAt: proposal.at } })
      }
      return
    }
    const approval = status.kind === 'awaiting_gate' ? this.state.gates[status.gateId] : undefined
    if (approval?.kind === 'approval' && approval.status === 'open' && approval.stageId === stage) {
      this.emit({ v: 1, type: 'GateClosed', gateId: approval.id, status: 'changes_requested', by })
      this.startAttempt(stage, 'revision')
    }
  }

  /** Fails the current attempt and retries it within the stage's attempt budget, or blocks the job. */
  failAttempt(reason: string, { stop = false, recovery = false, input }: { stop?: boolean; recovery?: boolean; input?: StageInput } = {}): void {
    const attempt = this.state.attempt!
    this.emit({ v: 1, type: 'AttemptFailed', attemptId: attempt.id, reason, stop })
    const note: StageInput = input ?? { kind: 'recovery', text: `The previous attempt ended: ${reason}.` }
    const limit = this.stage(attempt.stageId).limits.attempts + this.state.extended.attempts
    if (this.state.visitAttempts < limit) this.startAttempt(attempt.stageId, recovery ? 'recovery' : 'retry', [note])
    else this.block({ kind: 'attempts', stageId: attempt.stageId }, { kind: 'attempt', stageId: attempt.stageId, entry: 'retry', inputs: [note] })
  }

  block(reason: BlockReason, resume: Resume): void {
    const stop = this.running
    const gateId = this.nextGateId()
    this.emit({ v: 1, type: 'Blocked', reason, gateId, at: this.now, ...stop ? { stop } : {} })
    this.openGate({ id: gateId, kind: 'resume', stageId: this.stageId(), blocked: reason, resume })
  }

  stageId(): string {
    return this.state.attempt?.stageId ?? this.workflow.declaration.start
  }

  openGate(gate: Pick<Gate, 'id' | 'kind' | 'stageId'> & Partial<Gate>): void {
    // The plan's approval takes over a proposal request (`D12`): the pending proposals are decided there, and the ticket has one gate.
    if (gate.kind === 'approval') {
      for (const open of Object.values(this.state.gates)) {
        if (open.kind === 'proposal' && open.status === 'open') this.emit({ v: 1, type: 'GateClosed', gateId: open.id, status: 'cancelled' })
      }
    }
    this.emit({ v: 1, type: 'GateOpened', gate: { threadKey: gateThread(this.workflow, this.state, gate.kind), openedAt: this.now, status: 'open', responses: [],
      interpreting: [], ...gate } })
  }

  nextGateId(): string { return `${this.state.jobId}.g${this.state.gateCount + 1}` }

  /** Closes every open gate (on cancel or completion); `keep` leaves those it names open. */
  closeOpenGates(status: 'cancelled', by?: Actor, keep: (gate: Gate) => boolean = () => false): void {
    for (const gate of Object.values(this.state.gates)) {
      if (gate.status === 'open' && !keep(gate)) this.emit({ v: 1, type: 'GateClosed', gateId: gate.id, status, ...by ? { by } : {} })
    }
  }

  complete(outcome: string): void {
    const stop = this.running
    // A proposal still before the approvers stays open on a finished job (`D12`): accepting it reopens the job at the plan.
    this.closeOpenGates('cancelled', undefined, gate => outcome === 'completed' && gate.kind === 'proposal'
      && (this.state.proposals ?? []).some(proposal => proposal.status === 'pending'))
    this.emit({ v: 1, type: 'JobCompleted', outcome, at: this.now, ...stop ? { stop } : {} })
  }

  fail(reason: string): void {
    const stop = this.running
    this.closeOpenGates('cancelled')
    this.emit({ v: 1, type: 'JobFailed', reason, at: this.now, ...stop ? { stop } : {} })
  }

  cancel(reason: string, by?: Actor): void {
    if (isTerminal(this.state.status)) return
    const stop = this.running
    this.closeOpenGates('cancelled', by)
    this.emit({ v: 1, type: 'JobCancelled', reason, at: this.now, ...by ? { by } : {}, ...stop ? { stop } : {} })
  }

  /** A completed, verified attempt: records its artifact revision, then runs the transition table. */
  afterVerified(): void {
    const attempt = this.state.attempt!
    const report = attempt.report
    if (report?.outcome !== 'completed') throw new Error(`Attempt ${attempt.id} has no completed report`)
    const stage = this.stage(attempt.stageId)
    if (stage.artifact && report.artifact) {
      const revisions = this.state.artifacts[stage.artifact] ?? []
      const last = revisions.at(-1)
      // Only one stage runs at a time and no stage runs while its gate is open, so a new revision always follows a closed gate; a
      // reply to the old revision is refused because it was posted before the new gate's post.
      if (last?.digest !== report.artifact.digest) {
        this.emit({ v: 1, type: 'ArtifactRecorded', revision: { kind: stage.artifact, n: (last?.n ?? 0) + 1, digest: report.artifact.digest,
          attemptId: attempt.id, ...report.artifact.title ? { title: report.artifact.title } : {} } })
      }
    }
    this.transition(attempt.stageId)
  }

  /** Takes the first transition from `stageId` whose guard passes; parks when a guard is not registered. */
  transition(stageId: string): void {
    const attempt = this.state.attempt!
    const report = attempt.report as Extract<NonNullable<typeof attempt.report>, { outcome: 'completed' }>
    const input = deepFreeze<GuardInput>(JSON.parse(JSON.stringify({ stageId, output: report.output, summary: report.summary,
      artifacts: Object.fromEntries(latest(this.state).map(revision => [revision.kind, revision])), backtracks: this.state.backtracks.total })))
    for (const transition of this.workflow.declaration.transitions.filter(candidate => candidate.from === stageId)) {
      if (transition.guard) {
        const guard = this.deps.guard(transition.guard)
        if (!guard) {
          const missing = this.workflow.guards.filter(name => !this.deps.guard(name))
          this.emit({ v: 1, type: 'Parked', missing, stageId, attemptId: attempt.id, at: this.now })
          return
        }
        const taken = guard(input)
        if (typeof taken !== 'boolean') throw new Error(`Guard ${transition.guard} returned ${typeof taken}, not a boolean`)
        if (!taken) continue
      }
      this.take(transition)
      return
    }
    this.fail(`no transition from stage ${stageId} matched`)
  }

  take(transition: TransitionDeclaration): void {
    if (!transition.gate) { this.go(transition.to); return }
    const kind = this.stage(transition.from).artifact!
    const subject = this.state.artifacts[kind]?.at(-1)
    if (!subject) { this.fail(`stage ${transition.from} produced no ${kind} for gate ${transition.gate}`); return }
    // A proposal accepted after this attempt started (and not told to it) is not in its plan: a revision takes it before approval.
    // The attempt that just finished is the one to compare with: a revision that leaves the plan as it was keeps the older subject.
    const finished = this.state.attempt?.id
    if (transition.from === this.workflow.declaration.reopen?.requirements
      && (this.state.proposals ?? []).some(proposal => proposal.status === 'accepted' && proposal.givenTo !== finished)) {
      this.startAttempt(transition.from, 'revision')
      return
    }
    this.openGate({ id: this.nextGateId(), kind: 'approval', stageId: transition.from, declared: transition.gate, to: transition.to, subject })
  }

  go(to: string, inputs: readonly StageInput[] = []): void {
    if (to !== COMPLETE) { this.startAttempt(to, 'next', inputs); return }
    // A change request kept from an artifact thread (a merge request) while the job worked is handled before it completes (`D12`).
    // An accepted change of the requirements goes to the plan first; the change requests then wait for review as before.
    const { reopen } = this.workflow.declaration
    if (reopen?.requirements && (this.state.proposals ?? []).some(proposal => proposal.status === 'accepted')) {
      this.startAttempt(reopen.requirements, 'reopen', inputs)
      return
    }
    const artifacts = new Set(this.state.bindings.filter(binding => binding.role === 'artifact').map(binding => binding.threadKey))
    if (reopen && this.state.inputs.some(input => input.kind === 'follow_up' && input.thread !== undefined && artifacts.has(input.thread))) {
      this.startAttempt(reopen.stage, 'reopen', inputs)
    } else this.complete('completed')
  }

  /** An answer turn for a question asked on `threadKey` (`D12`); the job does not move. */
  answer(message: Message, question: string): void {
    this.emit({ v: 1, type: 'AnswerRequested', answerId: `${this.state.jobId}.answer.${message.eventId}`, threadKey: message.threadKey, question,
      actor: message.actor, ...message.replyTo ? { replyTo: message.replyTo } : {} })
  }

  backtrack(from: string, to: string, reason: string): void {
    const edge = this.workflow.declaration.backtracks.find(candidate => candidate.from === from && candidate.to === to)!
    const { backtracks, extended } = this.state
    const used = backtracks.edges[`${from}>${to}`] ?? 0
    if (used >= edge.budget + extended.backtracks || backtracks.total >= this.workflow.declaration.budgets.backtracks + extended.backtracks) {
      this.block({ kind: 'backtracks', from, to }, { kind: 'backtrack', from, to, reason })
      return
    }
    this.emit({ v: 1, type: 'Backtracked', from, to, reason })
    this.startAttempt(to, 'backtrack', [{ kind: 'backtrack', text: `Back from ${from}: ${reason}` }])
  }

  resume(resume: Resume): void {
    switch (resume.kind) {
      case 'attempt': this.startAttempt(resume.stageId, resume.entry, resume.inputs); break
      case 'backtrack': this.backtrack(resume.from, resume.to, resume.reason); break
      case 'approval': this.openGate({ id: this.nextGateId(), kind: 'approval', stageId: resume.stageId, declared: resume.declared,
        to: resume.to, subject: resume.subject }); break
      case 'checks': this.verify(resume.stageId, resume.attemptId); break
      case 'setup': this.setup(); break
    }
  }

  /** Starts the setup step (`T11.4`): the job's toolchains and its repository's setup command, before the first stage. */
  setup(afterInterruption = false): void {
    this.emit({ v: 1, type: 'SetupStarted', n: (this.state.setups ?? 0) + 1, at: this.now, ...afterInterruption ? { afterInterruption } : {} })
  }

  /** Runs a reported attempt's checks, from scratch. */
  verify(stageId: string, attemptId: string): void {
    this.emit({ v: 1, type: 'VerificationStarted', attemptId, stageId,
      checks: checksOf(this.workflow, this.stage(stageId)).map(check => ({ id: check.id, kind: check.kind, params: check.params })) })
  }
}

function decide(deps: DeciderDeps, command: JobCommand | KernelCommand, state: JobState, context: DecideContext): JobEvent[] | { rejected: string } {
  const reject = (reason: string) => ({ rejected: reason })
  if (command.kind === 'start') {
    if (state.status.kind !== 'new') return reject('the job has started already')
    const { intake } = command
    if (intake.workflowId !== state.workflowId) return reject(`the intake is for ${intake.workflowId}, not ${state.workflowId}`)
    const d = new Decision(state, deps.workflow(state.manifestId), deps, context.now)
    d.emit({ v: 1, type: 'JobStarted', intake, workflowId: state.workflowId, at: context.now })
    d.emit({ v: 1, type: 'ThreadBound', threadKey: intake.threadKey, role: 'origin' })
    if (d.workflow.declaration.places && d.workflow.extra.repository) {
      // `D12`: the ticket a trigger names is the job's from the start, so the plan has its place; the issue is checked when linked.
      const origin = /^jira:(.+)$/u.exec(intake.threadKey)?.[1]
      const ticket = origin ?? ticketIn(intake.text, d.workflow.extra.repository.match.jira)
      if (ticket && !origin) {
        d.emit({ v: 1, type: 'ActionRequested', attemptId: `${state.jobId}.start`, actionId: `${state.jobId}.start.link`, action: 'jira.link',
          payload: { issueKey: ticket } })
      }
      const channel = chatChannel(d.workflow, intake)
      if (channel) d.emit({ v: 1, type: 'ChatRequested', channelKey: `mattermost:${channel}:`, ...ticket ? { ticket } : {} })
    }
    // A job with a repository gets its toolchains and runs its setup command before the first stage (`T11.4`).
    if (d.workflow.extra.repository) d.setup()
    else d.startAttempt(d.workflow.declaration.start, 'initial')
    return d.events
  }
  if (state.status.kind === 'new') return reject('the job has not started')
  const d = new Decision(state, deps.workflow(state.manifestId), deps, context.now)
  const result = handle(d, command)
  return result ?? d.events
}

/** Runs one command; returns a rejection, or nothing when `d.events` is the decision (possibly empty: a stale input). */
function handle(d: Decision, command: Exclude<JobCommand, { kind: 'start' }> | KernelCommand): { rejected: string } | undefined {
  const reject = (reason: string) => ({ rejected: reason })
  const { status } = d.state
  switch (command.kind) {
    case 'report': {
      const attempt = d.state.attempt
      if (!attempt || attempt.id !== command.attemptId) return reject('not the current attempt')
      if (attempt.report || attempt.ended || status.kind !== 'running') return reject('this attempt has already reported')
      const parsed = StageReportSchema.safeParse(withoutNulls(command.report))
      if (!parsed.success) return reject(`the report is invalid: ${z.prettifyError(parsed.error)}`)
      const report = parsed.data
      const stage = d.stage(attempt.stageId)
      switch (report.outcome) {
        case 'completed': {
          const error = outputError(stage, report.output)
          if (error) return reject(`the output does not match stage ${stage.id}'s schema: ${error}`)
          if (stage.artifact && !report.artifact) return reject(`stage ${stage.id} must report its ${stage.artifact} artifact`)
          d.emit({ v: 1, type: 'AttemptReported', attemptId: attempt.id, report: { ...report, output: withoutNulls(report.output) } })
          if (checksOf(d.workflow, stage).length > 0) d.verify(stage.id, attempt.id)
          else d.afterVerified()
          return undefined
        }
        case 'question': {
          if (d.state.questionRounds >= stage.questionRounds) return reject(`stage ${stage.id} has no question rounds left; continue with what you know, or report blocked`)
          d.emit({ v: 1, type: 'AttemptReported', attemptId: attempt.id, report })
          d.openGate({ id: d.nextGateId(), kind: 'question', stageId: stage.id, items: report.items, round: d.state.questionRounds + 1 })
          return undefined
        }
        case 'backtrack': {
          if (!d.workflow.declaration.backtracks.some(edge => edge.from === stage.id && edge.to === report.to)) {
            return reject(`stage ${stage.id} may not go back to ${report.to}`)
          }
          d.emit({ v: 1, type: 'AttemptReported', attemptId: attempt.id, report })
          d.backtrack(stage.id, report.to, report.reason)
          return undefined
        }
        case 'blocked':
          d.emit({ v: 1, type: 'AttemptReported', attemptId: attempt.id, report })
          d.block({ kind: 'stage_blocked', stageId: stage.id, detail: report.reason },
            { kind: 'attempt', stageId: stage.id, entry: 'resume', inputs: [{ kind: 'recovery', text: `The stage was blocked: ${report.reason}` }] })
          return undefined
        case 'failed':
          d.emit({ v: 1, type: 'AttemptReported', attemptId: attempt.id, report })
          d.failAttempt(report.reason, { input: { kind: 'recovery', text: `The previous attempt failed: ${report.reason}` } })
          return undefined
      }
      return undefined
    }

    case 'usage': {
      const attempt = d.state.attempt
      if (!attempt || attempt.id !== command.attemptId) return reject('not the current attempt')
      if (![command.turns, command.tokens].every(count => Number.isSafeInteger(count) && count >= 0)) return reject('usage counts must be whole numbers, 0 or more')
      const added = { turns: Math.max(0, command.turns - attempt.turns), tokens: Math.max(0, command.tokens - attempt.tokens) }
      if (added.turns === 0 && added.tokens === 0) return undefined
      d.emit({ v: 1, type: 'UsageRecorded', attemptId: attempt.id, turns: Math.max(command.turns, attempt.turns),
        tokens: Math.max(command.tokens, attempt.tokens), added })
      if (status.kind !== 'running' || attempt.ended) return undefined
      const { budgets } = d.workflow.declaration
      const { usage, extended } = d.state
      if (usage.turns > budgets.turns + extended.turns || usage.tokens > budgets.tokens + extended.tokens) {
        const budget = usage.turns > budgets.turns + extended.turns ? 'turns' : 'tokens'
        d.block({ kind: 'budget', budget }, { kind: 'attempt', stageId: attempt.stageId, entry: 'resume',
          inputs: [{ kind: 'recovery', text: `The job ran out of ${budget}; its budget was extended.` }] })
        return undefined
      }
      const { limits } = d.stage(attempt.stageId)
      const current = d.state.attempt!
      if (current.turns > limits.turns || current.tokens > limits.tokens) {
        d.failAttempt(`the attempt went over its ${current.turns > limits.turns ? 'turn' : 'token'} limit`, { stop: true })
      }
      return undefined
    }

    case 'action': {
      const attempt = d.state.attempt
      if (!attempt || attempt.id !== command.attemptId || attempt.ended || status.kind !== 'running') return reject('not the current attempt')
      if (!d.stage(attempt.stageId).tools.includes(command.action)) return reject(`stage ${attempt.stageId} may not use ${command.action}`)
      d.emit({ v: 1, type: 'ActionRequested', attemptId: attempt.id, actionId: `${attempt.id}.x${d.state.actions + 1}`, action: command.action,
        payload: command.payload })
      return undefined
    }

    case 'reply': return reply(d, command.gateId, command.message)
    case 'followUp': return followUp(d, command.message)

    case 'fact': {
      // A merge of a finished job's merge request closes it (`D12`): its open proposals end, and it takes no more feedback.
      if (status.kind === 'completed' && !d.state.closedBy && d.workflow.declaration.completeOn.includes(command.fact)) {
        d.closeOpenGates('cancelled')
        d.emit({ v: 1, type: 'JobClosedByFact', fact: command.fact, at: d.now })
        return undefined
      }
      if (isTerminal(status)) return reject(`the job is ${status.kind}`)
      if (d.workflow.declaration.completeOn.includes(command.fact)) d.complete(command.fact)
      else d.emit({ v: 1, type: 'FactRecorded', fact: command.fact, threadKey: command.threadKey, data: command.data })
      return undefined
    }

    case 'resume': {
      if (status.kind !== 'parked') return reject('the job is not parked')
      const parked = d.state.parkedTransition!
      const missing = d.workflow.guards.filter(name => !d.deps.guard(name))
      if (missing.length > 0) return reject(`guards still missing: ${missing.join(', ')}`)
      d.emit({ v: 1, type: 'Unparked' })
      d.transition(parked.stageId)
      return undefined
    }

    case 'effect.succeeded':
    case 'effect.failed': return effectResult(d, command)

    case 'timer.fired': {
      if (command.timer === TIMER.attempt) {
        const attempt = d.state.attempt
        if (attempt?.id === command.subject && !attempt.ended && status.kind === 'running') d.failAttempt('the attempt ran out of wall-clock time', { stop: true })
        return undefined
      }
      const gate = d.state.gates[command.subject]
      if (!gate || gate.status !== 'open') return undefined
      if (command.timer === TIMER.reminder) d.emit({ v: 1, type: 'GateReminded', gateId: gate.id })
      if (command.timer === TIMER.deadline && gate.kind === 'proposal') {
        d.emit({ v: 1, type: 'GateClosed', gateId: gate.id, status: 'expired' })
        d.emit({ v: 1, type: 'ProposalsDropped', reason: 'expired', at: d.now })
      }
      if (command.timer === TIMER.deadline && gate.kind === 'approval') {
        d.emit({ v: 1, type: 'GateClosed', gateId: gate.id, status: 'expired' })
        d.block({ kind: 'gate_expired', gateId: gate.id }, { kind: 'approval', stageId: gate.stageId, declared: gate.declared!, to: gate.to!,
          subject: gate.subject! })
      }
      return undefined
    }
  }
}

function effectResult(d: Decision, command: Extract<KernelCommand, { kind: 'effect.succeeded' | 'effect.failed' }>): undefined {
  const { status } = d.state
  const ok = command.kind === 'effect.succeeded'
  switch (command.effect) {
    case EFFECT.setup: {
      const payload = command.payload as SetupPayload
      if (status.kind !== 'setting_up' || status.n !== payload.n) return undefined
      // A restart interrupts the setup step: it runs again once. Interrupted again (a setup command that takes the host down, say),
      // the job blocks rather than loop (review).
      if (!ok && command.interrupted === true) {
        if (!status.afterInterruption) d.setup(true)
        else d.block({ kind: 'setup_blocked', detail: 'the setup step was interrupted by a restart twice in a row' }, { kind: 'setup' })
        return undefined
      }
      const parsed = ok ? SetupResultSchema.safeParse(command.result) : undefined
      const result = parsed?.success ? parsed.data : { outcome: 'blocked' as const, evidence: ok ? 'the setup step returned no result' : `the setup step could not run: ${command.reason}` }
      if (result.outcome === 'passed') {
        d.emit({ v: 1, type: 'SetupCompleted', n: payload.n, toolchains: result.toolchains, ignored: result.ignored,
          ...result.services ? { services: result.services } : {}, evidence: result.evidence })
        // The first stage may ask questions, so it waits for the job's Mattermost thread (`D12`).
        if (d.state.chatPending) d.emit({ v: 1, type: 'StartDeferred' })
        else d.startAttempt(d.workflow.declaration.start, 'initial')
      } else d.block({ kind: 'setup_blocked', detail: result.evidence }, { kind: 'setup' })
      return undefined
    }
    case EFFECT.attempt: {
      const payload = command.payload as AttemptPayload
      const attempt = d.state.attempt
      // A stopped, reported or superseded attempt's end changes nothing.
      if (attempt?.id !== payload.attemptId || attempt.ended || status.kind !== 'running') return undefined
      const interrupted = !ok && command.interrupted === true
      d.failAttempt(ok ? 'it ended without a report' : command.reason, { recovery: interrupted })
      return undefined
    }
    case EFFECT.check: {
      const payload = command.payload as CheckPayload
      if (status.kind !== 'verifying' || status.attemptId !== payload.attemptId || d.state.attempt!.checks[payload.check.id]) return undefined
      // A check that could not run, or returned no verdict, says nothing about the agent's work: it blocks rather than fails.
      const parsed = ok ? CheckResultSchema.safeParse(command.result) : undefined
      const outcome = parsed?.success ? parsed.data.outcome : 'blocked'
      const evidence = !ok ? `the check could not run: ${command.reason}` : parsed?.success ? parsed.data.evidence : 'the check returned no result'
      const tokens = parsed?.success ? parsed.data.tokens ?? 0 : 0
      const said = parsed?.success ? { ...parsed.data.notes ? { notes: parsed.data.notes } : {}, ...parsed.data.risk ? { risk: parsed.data.risk } : {} } : {}
      d.emit({ v: 1, type: 'CheckCompleted', attemptId: payload.attemptId, checkId: payload.check.id, outcome, evidence, ...tokens > 0 ? { tokens } : {}, ...said })
      const done = d.state.attempt!.checks
      if (status.checks.some(id => !done[id])) return undefined
      const stage = d.stage(status.stageId)
      const required = checksOf(d.workflow, stage).filter(check => check.required)
      const evidenceOf = (checks: typeof required) => checks.map(check => `${check.id}: ${done[check.id]!.evidence}`).join('\n')
      // The agent's failures come first: its next attempt runs every check again anyway.
      const failures = required.filter(check => done[check.id]!.outcome === 'failed')
      if (failures.length > 0) {
        d.failAttempt(`required checks failed: ${failures.map(check => check.id).join(', ')}`, { input: { kind: 'check_failures', text: evidenceOf(failures) } })
        return undefined
      }
      const blocked = required.filter(check => done[check.id]!.outcome === 'blocked')
      if (blocked.length > 0) {
        d.block({ kind: 'checks_blocked', stageId: stage.id, checks: blocked.map(check => check.id), detail: evidenceOf(blocked) },
          { kind: 'checks', stageId: stage.id, attemptId: status.attemptId })
        return undefined
      }
      d.afterVerified()
      return undefined
    }
    case EFFECT.post: {
      const { message, threadKey } = command.payload as PostPayload
      if (message.kind === 'chat') {
        if (!d.state.chatPending || isTerminal(status)) return undefined
        if (!ok) { d.fail(`could not open the job's Mattermost thread: ${command.reason}`); return undefined }
        // A root post in `mattermost:<channel>:` starts the thread `mattermost:<channel>:<post id>`.
        const thread = `${threadKey}${PostResultSchema.parse(command.result).postId}`
        const deferred = d.state.startPending === true
        d.emit({ v: 1, type: 'ChatOpened', threadKey: thread })
        d.emit({ v: 1, type: 'ThreadBound', threadKey: thread, role: 'origin' })
        if (deferred) d.startAttempt(d.workflow.declaration.start, 'initial')
        return undefined
      }
      const gateId = 'gateId' in message && (message.kind === 'question' || message.kind === 'approval' || message.kind === 'blocked' || message.kind === 'proposalAsk') ? message.gateId : undefined
      const gate = gateId === undefined ? undefined : d.state.gates[gateId]
      if (!gate || gate.status !== 'open' || gate.postedAt !== undefined) return undefined
      // A proposal request that could not be posted leaves the job as it is (it may be finished); the approval still lists them.
      if (!ok && message.kind === 'proposalAsk') {
        // Nobody can decide what could not be asked: the request closes and the person who asked hears it went nowhere.
        if (gate.kind === 'proposal') {
          d.emit({ v: 1, type: 'GateClosed', gateId: gate.id, status: 'cancelled' })
          d.emit({ v: 1, type: 'ProposalsDropped', reason: 'unasked', at: d.now })
        }
        return undefined
      }
      if (ok) {
        const result = PostResultSchema.parse(command.result)
        d.emit({ v: 1, type: 'GatePosted', gateId: gate.id, postId: result.postId, postedAt: result.postedAt })
      } else d.fail(`could not post to ${threadKey}: ${command.reason}`)
      return undefined
    }
    case EFFECT.interpretFollowUp: {
      const { message, questionOnly } = command.payload as FollowUpPayload
      const parsed = ok ? VerdictSchema.safeParse(command.result) : undefined
      // A follow-up the model cannot read is taken as a follow-up, as before places: nothing is lost, and nothing is answered.
      if (status.kind === 'failed' || status.kind === 'cancelled') return undefined
      const verdict = parsed?.success ? parsed.data : undefined
      if (verdict?.verdict === 'question') { d.answer(message, message.text); return undefined }
      // A job closed while the reading ran (a merge, an approver's `закрой`) takes nothing more: no reopening, and no proposal.
      if (status.kind === 'completed' && (d.state.closedBy !== undefined || status.outcome !== 'completed')) return undefined
      const sure = verdict !== undefined && verdict.confidence >= MIN_CONFIDENCE
      const approving = sure && (verdict.verdict === 'approve' || verdict.verdict === 'approve_with_notes')
      const changing = sure && (verdict.verdict === 'request_changes' || verdict.verdict === 'changes_requirements')
      const approval = Object.values(d.state.gates).find(gate => gate.kind === 'approval' && gate.status === 'open')
      const change = verdict?.notes?.trim() || message.text
      if (questionOnly) {
        // `D12` (`A24`): a reply on the approval from someone who may not approve: an approval does not count and they are told who
        // approves; a change they ask for becomes a proposal the approvers decide; anything else is talk and gets nothing.
        if (changing && d.proposing) d.raise(message, change)
        else if (approving && approval?.threadKey === message.threadKey) {
          d.emit({ v: 1, type: 'NonApproverReplied', gateId: approval.id, eventId: message.eventId, actor: message.actor })
        }
        return undefined
      }
      // An approval written outside the approval's place is pointed there; it neither approves nor reopens anything.
      if (approval && approval.threadKey !== message.threadKey && approving) {
        d.emit({ v: 1, type: 'ApprovalElsewhere', gateId: approval.id, eventId: message.eventId, threadKey: message.threadKey, actor: message.actor })
        return undefined
      }
      // Plain thanks or agreement ("спасибо", "LGTM") changes nothing: it neither reopens a finished job nor waits for the next attempt.
      // Anything else, an approval with notes and information included, is a follow-up as before, so nothing the job needs is lost.
      if (sure && verdict.verdict === 'approve') return undefined
      // A change of the requirements is a proposal the approvers decide (`D12`), never a change to make in the code first.
      if (sure && verdict.verdict === 'changes_requirements' && d.proposing) { d.raise(message, change); return undefined }
      // Only a merge request takes feedback after its job finished; a ticket comment read here does not reopen it.
      if (status.kind === 'completed' && !message.threadKey.startsWith(PLACE_PREFIX.mergeRequest)) return undefined
      proceed(d, message)
      return undefined
    }
    case EFFECT.steer: {
      // A proposal counts as given to the attempt only when the steer reached it (`D12`); else the next revision takes it.
      const { attemptId, proposal } = command.payload as { attemptId: string; proposal?: string }
      // A late result for an attempt that has reported, or been followed by another, changes nothing: the next revision takes it.
      const current = d.state.attempt
      if (ok && proposal && (command.result as { delivered?: boolean } | undefined)?.delivered === true && current?.id === attemptId && !current.ended) {
        d.emit({ v: 1, type: 'ProposalGiven', id: proposal, attemptId })
      }
      return undefined
    }
    case EFFECT.answer: {
      const payload = command.payload as AnswerPayload
      const parsed = ok ? AnswerResultSchema.safeParse(command.result) : undefined
      const replyTo = payload.replyTo ? { replyTo: payload.replyTo } : {}
      if (parsed?.success) d.emit({ v: 1, type: 'AnswerGiven', answerId: payload.answerId, threadKey: payload.threadKey, text: parsed.data.text, tokens: parsed.data.tokens, ...replyTo })
      else d.emit({ v: 1, type: 'AnswerFailed', answerId: payload.answerId, threadKey: payload.threadKey, reason: ok ? 'the answer was malformed' : command.reason, ...replyTo })
      return undefined
    }
    case EFFECT.read: {
      const payload = command.payload as ReadPayload
      const gate = d.state.gates[payload.gateId]
      if (!gate || !gate.interpreting.includes(payload.eventId)) return undefined
      const refuse = (reason: string) => d.emit({ v: 1, type: 'GateResponded', gateId: gate.id,
        response: { eventId: payload.eventId, actor: payload.actor, accepted: false, reason, interpreter: 'model' } })
      if (gate.status !== 'open') { refuse(`the round was ${gate.status} before the reply was read`); return undefined }
      const parsed = ok ? ReadingSchema.safeParse(command.result) : undefined
      const items = gate.items?.length ?? 0
      const answers = parsed?.success ? parsed.data.answers.filter(answer => answer.item <= items) : []
      // A redirect names a person the reply mentions (`@name`); a ticket key or a word the model took for one is not a person.
      const mentioned = (name: string) => new RegExp(`(^|[^\\w@.-])@${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w.-])`, 'iu').test(payload.text)
      const redirects = parsed?.success ? parsed.data.redirects.filter(redirect => redirect.item <= items).map(redirect => ({ ...redirect, to: redirect.to.replace(/^@/u, '') }))
        .filter(redirect => mentioned(redirect.to)) : []
      if (answers.length === 0 && redirects.length === 0) {
        // A question back is answered where it was asked (`T14.5`); anything else the workbench could not read is said so.
        if (parsed?.success && parsed.data.question) {
          refuse('a question back')
          d.answer({ eventId: payload.eventId, actor: payload.actor, threadKey: gate.threadKey, text: payload.text, postedAt: 0 }, parsed.data.question)
          return undefined
        }
        // Talk between people in the thread is not a reply to the round: it is recorded as such and gets no post.
        if (parsed?.success && parsed.data.unrelated) { refuse('unrelated to the questions'); return undefined }
        refuse(parsed?.success ? 'it answered no item' : ok ? 'the reading was malformed' : `no reading: ${command.reason}`)
        d.emit({ v: 1, type: 'AnswersUnread', gateId: gate.id, eventId: payload.eventId })
        return undefined
      }
      d.emit({ v: 1, type: 'GateResponded', gateId: gate.id, response: { eventId: payload.eventId, actor: payload.actor, accepted: true,
        reason: 'answered', interpreter: 'model' }, text: payload.text })
      d.emit({ v: 1, type: 'AnswersRecorded', gateId: gate.id, eventId: payload.eventId, actor: payload.actor, answers, redirects })
      if (parsed?.success && parsed.data.question) {
        d.answer({ eventId: payload.eventId, actor: payload.actor, threadKey: gate.threadKey, text: payload.text, postedAt: 0 }, parsed.data.question)
      }
      const recorded = d.state.gates[gate.id]!
      const all = (recorded.items ?? []).map((item, index) => ({ item, answers: recorded.answers?.[String(index + 1)] ?? [] }))
      if (all.every(entry => entry.answers.length > 0)) {
        d.emit({ v: 1, type: 'GateClosed', gateId: gate.id, status: 'answered', by: payload.actor })
        const text = all.map(({ item, answers: given }, index) => [`${index + 1}. ${item.text}`,
          ...given.map(answer => `   — ${answer.text} (${answer.by.source}:${answer.by.id})`)].join('\n')).join('\n')
        d.startAttempt(gate.stageId, 'answer', [{ kind: 'answers', text, by: payload.actor, items: recorded.items ?? [],
          answers: all.flatMap(({ answers: given }, index) => given.map(answer => ({ item: index + 1, text: answer.text, by: answer.by }))) }])
      }
      return undefined
    }
    case EFFECT.interpret: {
      const payload = command.payload as InterpretPayload
      const gate = d.state.gates[payload.gateId]
      if (!gate || !gate.interpreting.includes(payload.eventId)) return undefined
      const parsed = ok ? VerdictSchema.safeParse(command.result) : undefined
      const verdict: Verdict = parsed?.success ? parsed.data
        : { verdict: 'unclear', confidence: 0, reading: ok ? 'the verdict was malformed' : `no verdict: ${command.reason}` }
      if (gate.status !== 'open') {
        d.emit({ v: 1, type: 'GateResponded', gateId: gate.id, response: { eventId: payload.eventId, actor: payload.actor, accepted: false,
          reason: `the gate was ${gate.status} before the verdict`, interpreter: 'model', verdict: verdict.verdict } })
        return undefined
      }
      applyVerdict(d, gate, payload.eventId, payload.actor, payload.text, verdict, 'model', new Set((payload.proposals ?? []).map(proposal => proposal.id)))
      return undefined
    }
    case EFFECT.action: {
      const payload = command.payload as ActionPayload
      const result = ok ? ActionResultSchema.safeParse(command.result ?? {}) : undefined
      d.emit({ v: 1, type: 'ActionSettled', actionId: payload.actionId, action: payload.action, ok, detail: ok ? 'done' : command.reason })
      // `D12`: the ticket a trigger named holds the plan; a job whose ticket cannot be linked stops instead of planning elsewhere.
      if (!ok && payload.actionId === `${d.state.jobId}.start.link` && !['completed', 'failed', 'cancelled'].includes(d.state.status.kind)) {
        d.fail(`the ticket ${String((payload.payload as { issueKey?: unknown }).issueKey)} could not be linked: ${command.reason}`)
        return undefined
      }
      const bind = result?.success ? result.data.bind : undefined
      if (bind && !d.state.bindings.some(binding => binding.threadKey === bind)) d.emit({ v: 1, type: 'ThreadBound', threadKey: bind, role: 'artifact' })
      return undefined
    }
    default: return undefined
  }
}

/** A reply on an open gate's thread: deterministic admission, then the vocabulary fast path or a model verdict. */
function reply(d: Decision, gateId: string, message: Message): { rejected: string } | undefined {
  const gate = d.state.gates[gateId]
  if (!gate || gate.status !== 'open') return followUp(d, message)
  // A finished job's only open gate is a proposal request in its ticket; a close there closes the job, rather than answer it.
  if (d.state.status.kind === 'completed' && isClose(message.text) && !isWorkbench(d.policy, message.actor)) return followUp(d, message)
  const refuse = (reason: string) => {
    d.emit({ v: 1, type: 'GateResponded', gateId, response: { eventId: message.eventId, actor: message.actor, accepted: false, reason } })
    return undefined
  }
  const role: Role = gate.kind === 'question' ? 'respondent' : 'approver'
  if (isWorkbench(d.policy, message.actor)) return refuse('the workbench cannot answer its own gate')
  if (message.threadKey !== gate.threadKey) return refuse('not on the gate\'s thread')
  if (!d.may(message.actor, role)) {
    refuse(`not an eligible ${role}`)
    // `D12` (`A24`): anyone who may talk to the job gets an answer to a question about the plan; nothing else they say counts here.
    // A proposal request does not stop the job, so what they write there is read as it would be without it.
    if (gate.kind === 'proposal' && d.may(message.actor, 'respondent')) d.emit({ v: 1, type: 'FollowUpInterpreting', message })
    else if (gate.kind === 'approval' && d.workflow.declaration.places && d.may(message.actor, 'respondent')) {
      d.emit({ v: 1, type: 'FollowUpInterpreting', message, questionOnly: true })
    }
    return undefined
  }
  if (gate.postedAt === undefined || message.postedAt <= gate.postedAt) return refuse('posted before the gate\'s current revision')
  const cancel = matchCancel(message.text)
  if (gate.kind === 'question') {
    if (cancel && d.may(message.actor, 'approver')) { cancelBy(d, gate, message, cancel.reason, 'vocabulary'); return undefined }
    // `D12`: a round is read item by item, so several people can answer parts of it.
    if (d.workflow.declaration.places) {
      d.emit({ v: 1, type: 'AnswersReading', gateId, eventId: message.eventId, text: message.text, actor: message.actor })
      return undefined
    }
    d.emit({ v: 1, type: 'GateResponded', gateId, response: { eventId: message.eventId, actor: message.actor, accepted: true, reason: 'answered' }, text: message.text })
    d.emit({ v: 1, type: 'GateClosed', gateId, status: 'answered', by: message.actor })
    d.startAttempt(gate.stageId, 'answer', [{ kind: 'answers', text: message.text, by: message.actor, items: gate.items ?? [] }])
    return undefined
  }
  const bots = d.policy.bots[message.actor.source] ?? []
  // On a finished job's proposal request "отмена" is not a command: the job has nothing to cancel (`D12`).
  if (cancel && !(gate.kind === 'proposal' && d.state.status.kind === 'completed')) { cancelBy(d, gate, message, cancel.reason, 'vocabulary'); return undefined }
  // Replies resolve in the order they were posted: while an earlier one waits for its verdict, a later approval waits behind it.
  const approves = isStandaloneApproval(message.text, bots) || (gate.kind === 'resume' && isRetry(message.text))
  // A proposal before the approvers (`D12`) makes even "ок" or "согласен" ambiguous: it is read with the proposals, never taken as is.
  const deciding = gate.kind === 'proposal' || (gate.kind === 'approval' && pending(d.state).length > 0)
  if (approves && gate.interpreting.length === 0 && !deciding) {
    applyVerdict(d, gate, message.eventId, message.actor, message.text, { verdict: 'approve', confidence: 1 }, 'vocabulary')
    return undefined
  }
  d.emit({ v: 1, type: 'GateInterpreting', gateId, eventId: message.eventId, text: message.text, actor: message.actor })
  return undefined
}

function cancelBy(d: Decision, gate: Gate, message: Message, reason: string, interpreter: 'vocabulary' | 'model'): void {
  d.emit({ v: 1, type: 'GateResponded', gateId: gate.id, response: { eventId: message.eventId, actor: message.actor, accepted: true,
    reason: 'cancel', interpreter, verdict: 'cancel' }, text: message.text })
  d.cancel(reason, message.actor)
}

/** Resolves a gate by a verdict. Only a confident approval approves; anything unclear is restated and the gate stays open. */
function applyVerdict(d: Decision, gate: Gate, eventId: string, actor: Actor, text: string, verdict: Verdict, interpreter: 'vocabulary' | 'model',
  asked: ReadonlySet<string> = new Set()): void {
  const respond = (accepted: boolean, reason: string) => d.emit({ v: 1, type: 'GateResponded', gateId: gate.id,
    response: { eventId, actor, accepted, reason, interpreter, verdict: verdict.verdict }, text })
  const restate = (reason: string) => {
    respond(false, reason)
    d.emit({ v: 1, type: 'GateRestated', gateId: gate.id, eventId, reading: verdict.reading ?? '' })
  }
  // Proposals are decided first, so an explicit decision counts even in a reply that is unclear about the rest (`D12`).
  if (decideProposals(d, gate, { eventId, actor, threadKey: gate.threadKey, text, postedAt: 0 }, verdict, asked, respond, restate)) return
  if (verdict.verdict === 'unclear') { restate('unclear'); return }
  if (verdict.confidence < MIN_CONFIDENCE && verdict.verdict !== 'unrelated') { restate('low confidence'); return }
  switch (verdict.verdict) {
    case 'approve':
    case 'approve_with_notes': {
      const notes = verdict.notes?.trim() || undefined
      respond(true, verdict.verdict)
      d.emit({ v: 1, type: 'GateClosed', gateId: gate.id, status: 'satisfied', by: actor, ...notes ? { notes } : {} })
      if (gate.kind === 'approval') d.go(gate.to!, notes ? [{ kind: 'approval_notes', text: notes, by: actor }] : [])
      else {
        const added = gate.blocked ? extensionFor(gate.blocked, d.workflow.declaration.budgets.extension) : {}
        if (gate.blocked && Object.keys(added).length > 0) d.emit({ v: 1, type: 'BudgetExtended', reason: gate.blocked, by: actor, added })
        d.resume(gate.resume!)
      }
      return
    }
    case 'request_changes':
    case 'changes_requirements':
    case 'question':
      if (gate.kind !== 'approval') { restate(`a ${verdict.verdict} reply does not resume a blocked job`); return }
      // `D12`: a question about the plan gets an answer where it was asked; the gate stays open and no revision is made.
      if (verdict.verdict === 'question' && d.workflow.declaration.places) {
        respond(true, 'question')
        d.answer({ eventId, actor, threadKey: gate.threadKey, text, postedAt: 0 }, text)
        return
      }
      respond(true, verdict.verdict)
      d.emit({ v: 1, type: 'GateClosed', gateId: gate.id, status: verdict.verdict === 'question' ? 'questioned' : 'changes_requested', by: actor })
      d.startAttempt(gate.stageId, verdict.verdict === 'question' ? 'question' : 'revision', [{
        kind: verdict.verdict === 'question' ? 'gate_question' : 'changes_requested', text: verdict.notes?.trim() || text, by: actor }])
      return
    case 'cancel':
      respond(true, 'cancel')
      d.cancel(verdict.notes?.trim() || text, actor)
      return
    case 'unrelated': respond(false, 'unrelated'); return
  }
}

/** The proposals still before the approvers (`D12`). */
function pending(state: JobState): readonly Proposal[] {
  return (state.proposals ?? []).filter(proposal => proposal.status === 'pending')
}

/**
 * An approver's reply where proposals are decided (`D12`): a proposal request, or the plan's approval with proposals pending; `true`
 * when it handled the reply. Only explicit decisions count, and only on the proposals the reply was read with (`asked`). On a
 * proposal request, the accepted go to the plan; a new change of the requirements is a proposal of its own; anything else that is not
 * a decision is a follow-up, as without the request; an unclear reply is restated. On the approval, accepting any (or asking a change
 * of one's own) makes a revision, declining them all and approving lets the approval stand, declining without approving keeps it open,
 * and leaving one undecided is restated. A question is answered where it was asked.
 */
function decideProposals(d: Decision, gate: Gate, message: Message, verdict: Verdict, asked: ReadonlySet<string>,
  respond: (accepted: boolean, reason: string) => void, restate: (reason: string) => void): boolean {
  const open = pending(d.state)
  if (gate.kind !== 'proposal' && !(gate.kind === 'approval' && open.length > 0)) return false
  if (verdict.confidence < MIN_CONFIDENCE && verdict.verdict !== 'unrelated') { restate('low confidence'); return true }
  if (verdict.verdict === 'question' && d.workflow.declaration.places) {
    respond(true, 'question')
    d.answer({ ...message, threadKey: gate.threadKey }, message.text)
    return true
  }
  if (verdict.verdict === 'unrelated' && gate.kind === 'approval') return false
  if (verdict.verdict === 'cancel') {
    // Cancelling a running job is the approvers' to take; on a finished job's proposal request "отмена" is not a decision.
    if (gate.kind === 'approval' || d.state.status.kind !== 'completed') return false
    restate('a cancel reply on a proposal request')
    return true
  }
  const decisions = new Map((verdict.proposals ?? []).filter(decision => asked.has(decision.id) && open.some(proposal => proposal.id === decision.id))
    .map(decision => [decision.id, decision.accept]))
  for (const [id, accepted] of decisions) d.emit({ v: 1, type: 'ProposalDecided', id, accepted, by: message.actor, eventId: message.eventId })
  const changes = verdict.verdict === 'request_changes' || verdict.verdict === 'changes_requirements'
  if (gate.kind === 'proposal') {
    if (decisions.size === 0) {
      if (verdict.verdict === 'changes_requirements') { respond(true, 'a new proposal'); d.raise(message, verdict.notes?.trim() || message.text); return true }
      if (verdict.verdict === 'request_changes' || verdict.verdict === 'approve_with_notes' || verdict.verdict === 'unrelated') {
        respond(false, 'not a decision on the proposals')
        if (d.state.status.kind !== 'completed') proceed(d, message)
        return true
      }
      restate('the proposals are not decided')
      return true
    }
    respond(true, 'proposals decided')
    if (pending(d.state).length === 0) d.emit({ v: 1, type: 'GateClosed', gateId: gate.id, status: 'satisfied', by: message.actor })
    d.accept((d.state.proposals ?? []).filter(proposal => decisions.get(proposal.id) === true))
    return true
  }
  // The plan's approval. A bare agreement that accepted proposals is no change of its own; a change the approver words is.
  // A change request with proposals pending and nothing decided must word its change; a bare "нет" is no change.
  const notes = changes ? verdict.notes?.trim() || undefined : undefined
  if ((d.state.proposals ?? []).some(proposal => proposal.status === 'accepted') || notes) {
    // The accepted proposals reach the revision as requested changes (`startAttempt`); a change the approver asks goes with them.
    respond(true, changes ? verdict.verdict : 'proposals decided')
    d.emit({ v: 1, type: 'GateClosed', gateId: gate.id, status: 'changes_requested', by: message.actor })
    d.startAttempt(gate.stageId, 'revision', notes ? [{ kind: 'changes_requested', text: notes, by: message.actor }] : [])
    return true
  }
  if (pending(d.state).length > 0) { restate('the proposals are not decided'); return true }
  // Every proposal declined: an approval stands; a reply that only declined keeps the approval open for the plan's own decision.
  if (verdict.verdict === 'approve' || verdict.verdict === 'approve_with_notes') return false
  respond(true, 'proposals decided')
  return true
}

/** A message on a closed job's thread: told once per thread that the job is closed, then ignored. */
function closedJob(d: Decision, message: Message): { rejected: string } | undefined {
  const closed = d.state.closedBy === 'person' ? 'the job was closed' : d.state.closedBy === 'mr_merged' || (d.state.closedBy === undefined
    && d.state.status.kind === 'completed' && d.state.status.outcome === 'mr_merged') ? 'the merge request is merged' : 'the job is closed'
  if (d.state.closedTold?.includes(message.threadKey)) return { rejected: closed }
  d.emit({ v: 1, type: 'ClosedJobAddressed', eventId: message.eventId, threadKey: message.threadKey, ...message.replyTo ? { replyTo: message.replyTo } : {} })
  return undefined
}

/** A message on a bound thread with no open gate: steers a running attempt, is kept for the next one, or reopens a completed job. */
function followUp(d: Decision, message: Message): { rejected: string } | undefined {
  const { status } = d.state
  if (isWorkbench(d.policy, message.actor)) return { rejected: 'the workbench\'s own post' }
  if (!d.may(message.actor, 'respondent')) return { rejected: 'the sender is not eligible for this job' }
  if (status.kind === 'failed' || status.kind === 'cancelled') return { rejected: `the job is ${status.kind}` }
  const cancel = matchCancel(message.text)
  if (cancel && d.may(message.actor, 'approver') && status.kind !== 'completed') { d.cancel(cancel.reason, message.actor); return undefined }
  // A job closed by a merge, by an approver, or completed by a fact while it ran, takes nothing more; each thread is told so once.
  if (status.kind === 'completed' && (d.state.closedBy !== undefined || status.outcome !== 'completed')) return closedJob(d, message)
  // An approver closes a finished job (`закрой`), on any of its threads; anyone else is told who may.
  if (status.kind === 'completed' && isClose(message.text)) {
    const at = { eventId: message.eventId, threadKey: message.threadKey, ...message.replyTo ? { replyTo: message.replyTo } : {} }
    if (!d.may(message.actor, 'approver')) { d.emit({ v: 1, type: 'CloseRefused', actor: message.actor, ...at }); return undefined }
    d.closeOpenGates('cancelled', message.actor)
    d.emit({ v: 1, type: 'JobClosed', by: message.actor, ...at, at: d.now })
    return undefined
  }
  if (status.kind === 'completed') {
    const { reopen } = d.workflow.declaration
    const bound = d.state.bindings.find(binding => binding.threadKey === message.threadKey)
    // A job completed by a fact (a merged MR) is done; only one that finished through its stages takes MR feedback, and only there.
    if (!reopen || bound?.role !== 'artifact' || !message.threadKey.startsWith(PLACE_PREFIX.mergeRequest) || status.outcome !== 'completed') {
      return { rejected: 'the job is completed' }
    }
  }
  // `D12`: a question to the workbench gets an answer turn; anything else is a follow-up, once read.
  if (d.workflow.declaration.places) { d.emit({ v: 1, type: 'FollowUpInterpreting', message }); return undefined }
  proceed(d, message)
  return undefined
}

/** A follow-up taken as such: it reopens a completed job, steers the running attempt, or waits for the next one. */
function proceed(d: Decision, message: Message): void {
  const { status } = d.state
  if (status.kind === 'failed' || status.kind === 'cancelled') return
  const replyTo = message.replyTo ? { replyTo: message.replyTo } : {}
  if (status.kind === 'completed') {
    const stage = d.workflow.declaration.reopen!.stage
    d.emit({ v: 1, type: 'JobReopened', by: message.actor, eventId: message.eventId, stage, threadKey: message.threadKey, ...replyTo })
    d.startAttempt(stage, 'reopen', [{ kind: 'follow_up', text: message.text, by: message.actor, thread: message.threadKey, ...replyTo }])
    return
  }
  // `D12`: a change request on the merge request is never steered into a running implement attempt; it waits for review.
  const { places, reopen } = d.workflow.declaration
  const fromCode = places !== undefined && message.threadKey === placeThread(d.state, places.code) && message.threadKey !== placeThread(d.state, places.clarification)
  const steer = status.kind === 'running' && !(fromCode && status.stageId !== reopen?.stage) ? status.attemptId : undefined
  d.emit({ v: 1, type: 'FollowUpReceived', message, ...steer ? { steer } : {} })
}

/** Applies one event to the state; pure, and the only way state changes. */
export function evolve(state: JobState, event: JobEvent): JobState {
  const gate = (id: string, change: (gate: Gate) => Gate) => state.gates[id] ? { ...state.gates, [id]: change(state.gates[id]) } : state.gates
  // A job with no attempt yet (blocked or ended during its setup step) gains no `attempt` key: a key holding `undefined` is dropped
  // when the state is stored, and would order a fold's keys differently from the stored state's.
  const endAttempt = (id?: string) => !state.attempt ? {} : { attempt: id === undefined || state.attempt.id === id ? { ...state.attempt, ended: true } : state.attempt }
  switch (event.type) {
    case 'JobStarted':
      return { ...state, intake: event.intake, requester: event.intake.actor, originThread: event.intake.threadKey }
    case 'SetupStarted':
      return { ...state, setups: event.n, status: { kind: 'setting_up', n: event.n, since: event.at, ...event.afterInterruption ? { afterInterruption: true } : {} } }
    case 'SetupCompleted': {
      const { services: _previous, ...rest } = state
      return { ...rest, toolchains: event.toolchains, ...event.services ? { services: event.services } : {} }
    }
    case 'ThreadBound':
      return { ...state, bindings: [...state.bindings, { threadKey: event.threadKey, role: event.role }] }
    case 'AttemptStarted': {
      const retry = event.entry === 'retry' || event.entry === 'recovery'
      const newStage = ['initial', 'next', 'backtrack', 'reopen'].includes(event.entry)
      // The attempt takes the kept inputs it lists; any other stays kept (a change request waiting for review).
      const taken = new Set(event.inputs.map(input => JSON.stringify(input)))
      return { ...state, attemptCount: state.attemptCount + 1, visitAttempts: retry ? state.visitAttempts + 1 : 1,
        inputs: state.inputs.filter(input => !taken.has(JSON.stringify(input))),
        questionRounds: newStage ? 0 : state.questionRounds,
        extended: retry ? state.extended : { ...state.extended, attempts: 0 },
        attempt: { id: event.attemptId, stageId: event.stageId, n: event.n, entry: event.entry, startedAt: event.at, ended: false, turns: 0, tokens: 0, checks: {} },
        status: { kind: 'running', stageId: event.stageId, attemptId: event.attemptId },
        ...given(state, new Set(event.inputs.flatMap(input => input.proposal ? [input.proposal] : [])), event.attemptId) }
    }
    case 'UsageRecorded':
      return { ...state, usage: { turns: state.usage.turns + event.added.turns, tokens: state.usage.tokens + event.added.tokens },
        attempt: state.attempt && { ...state.attempt, turns: event.turns, tokens: event.tokens } }
    case 'AttemptReported':
      return { ...state, attempt: state.attempt && { ...state.attempt, report: event.report, ended: true } }
    case 'VerificationStarted':
      // A re-run starts from no results.
      return { ...state, status: { kind: 'verifying', stageId: event.stageId, attemptId: event.attemptId, checks: event.checks.map(check => check.id) },
        attempt: state.attempt && state.attempt.id === event.attemptId ? { ...state.attempt, checks: {} } : state.attempt }
    case 'CheckCompleted':
      // A check's model tokens (the review) count against the job's budget.
      return { ...state, usage: { ...state.usage, tokens: state.usage.tokens + (event.tokens ?? 0) }, attempt: state.attempt && { ...state.attempt, checks: { ...state.attempt.checks, [event.checkId]: { outcome: event.outcome, evidence: event.evidence,
        ...event.notes ? { notes: event.notes } : {}, ...event.risk ? { risk: event.risk } : {} } } } }
    case 'AttemptFailed':
      return { ...state, ...endAttempt(event.attemptId) }
    case 'ArtifactRecorded':
      return { ...state, artifacts: { ...state.artifacts, [event.revision.kind]: [...state.artifacts[event.revision.kind] ?? [], event.revision] } }
    case 'GateOpened':
      return { ...state, gateCount: state.gateCount + 1, gates: { ...state.gates, [event.gate.id]: event.gate },
        questionRounds: event.gate.kind === 'question' ? state.questionRounds + 1 : state.questionRounds,
        // A resume gate (the job is blocked) and a proposal request (the job goes on, `D12`) leave the status as it is.
        status: event.gate.kind === 'resume' || event.gate.kind === 'proposal' ? state.status : { kind: 'awaiting_gate', gateId: event.gate.id, stageId: event.gate.stageId },
        // A plan revision put to approval includes every accepted proposal, and still includes those an earlier revision did (`D12`).
        // Only the proposals the revision's attempt was given count, so one accepted too late waits for the next revision.
        ...event.gate.kind === 'approval' && event.gate.subject && state.proposals?.some(proposal => includes(proposal, state.attempt?.id))
          ? { proposals: state.proposals.map(proposal => includes(proposal, state.attempt?.id)
            ? { ...proposal, status: 'included' as const, revision: event.gate.subject!.n } : proposal) } : {} }
    case 'GatePosted':
      return { ...state, gates: gate(event.gateId, current => ({ ...current, postedAt: event.postedAt, postId: event.postId })) }
    case 'GateResponded':
      return { ...state, gates: gate(event.gateId, current => ({ ...current, responses: [...current.responses, event.response],
        interpreting: current.interpreting.filter(id => id !== event.response.eventId) })) }
    case 'GateInterpreting':
    case 'AnswersReading':
      return { ...state, gates: gate(event.gateId, current => ({ ...current, interpreting: [...current.interpreting, event.eventId] })) }
    case 'AnswersRecorded':
      return { ...state, gates: gate(event.gateId, current => {
        const answers: Record<string, readonly { text: string; by: Actor }[]> = { ...current.answers ?? {} }
        for (const answer of event.answers) answers[String(answer.item)] = [...answers[String(answer.item)] ?? [], { text: answer.text, by: event.actor }]
        const redirects = [...current.redirects ?? [], ...event.redirects.map(redirect => ({ item: redirect.item, to: redirect.to }))]
        return { ...current, answers, ...redirects.length ? { redirects } : {} }
      }) }
    case 'AnswersUnread':
      return state
    case 'GateRestated':
    case 'GateReminded':
      return state
    case 'GateClosed': {
      // Replies still awaiting a verdict stay listed, so a verdict that arrives after the gate closed is recorded as refused.
      const closed = state.gates[event.gateId]
      // The approval of a plan revision approves the proposals it includes (`D12`).
      const approves = closed?.kind === 'approval' && event.status === 'satisfied' && closed.subject
        && state.proposals?.some(proposal => proposal.status === 'included' && proposal.revision === closed.subject!.n)
      return { ...state, gates: gate(event.gateId, current => ({ ...current, status: event.status })),
        ...approves ? { proposals: state.proposals!.map(proposal => proposal.status === 'included' && proposal.revision === closed!.subject!.n
          ? { ...proposal, status: 'approved' as const } : proposal) } : {} }
    }
    case 'Backtracked': {
      const key = `${event.from}>${event.to}`
      return { ...state, backtracks: { total: state.backtracks.total + 1, edges: { ...state.backtracks.edges, [key]: (state.backtracks.edges[key] ?? 0) + 1 } } }
    }
    case 'Blocked':
      return { ...state, ...endAttempt(event.stop), status: { kind: 'blocked', reason: event.reason, gateId: event.gateId, since: event.at } }
    case 'BudgetExtended': {
      const { extended } = state
      const { added } = event
      return { ...state, extended: { turns: extended.turns + (added.turns ?? 0), tokens: extended.tokens + (added.tokens ?? 0),
        attempts: extended.attempts + (added.attempts ?? 0), backtracks: extended.backtracks + (added.backtracks ?? 0) } }
    }
    case 'Parked':
      return { ...state, status: { kind: 'parked', missing: event.missing, since: event.at }, parkedTransition: { stageId: event.stageId, attemptId: event.attemptId } }
    case 'Unparked': {
      const { parkedTransition: _parked, ...rest } = state
      return { ...rest, status: { kind: 'verifying', stageId: state.parkedTransition!.stageId, attemptId: state.parkedTransition!.attemptId, checks: [] } }
    }
    case 'FollowUpReceived':
      if (event.steer) return state
      return { ...state, inputs: [...state.inputs, { kind: 'follow_up', text: event.message.text, by: event.message.actor,
        thread: event.message.threadKey, ...event.message.replyTo ? { replyTo: event.message.replyTo } : {} }] }
    case 'NonApproverReplied':
      return state
    case 'ProposalRaised':
      return { ...state, proposals: [...state.proposals ?? [], event.proposal] }
    case 'ProposalGiven':
      return { ...state, ...given(state, new Set([event.id]), event.attemptId) }
    case 'ProposalsDropped':
      return { ...state, ...settled(state, event.at, ['pending'], false) }
    case 'JobClosedByFact':
      return { ...state, closedBy: event.fact, ...settled(state, event.at, OPEN_PROPOSAL, false) }
    case 'JobClosed':
      return { ...state, closedBy: 'person', closer: event.by, ...settled(state, event.at, OPEN_PROPOSAL, false) }
    case 'CloseRefused':
      return state
    case 'ClosedJobAddressed':
      return { ...state, closedTold: [...state.closedTold ?? [], event.threadKey] }
    case 'ProposalDecided':
      return { ...state, proposals: (state.proposals ?? []).map(proposal => proposal.id === event.id && proposal.status === 'pending'
        ? { ...proposal, status: event.accepted ? 'accepted' : 'declined', decidedBy: event.by } : proposal) }
    case 'ApprovalElsewhere':
      return state
    case 'FollowUpInterpreting':
    case 'AnswerRequested':
    case 'AnswerFailed':
      return state
    case 'AnswerGiven':
      return { ...state, usage: { ...state.usage, tokens: state.usage.tokens + event.tokens } }
    case 'FactRecorded':
      return { ...state, inputs: [...state.inputs, { kind: 'fact', text: `${event.fact}: ${JSON.stringify(event.data)}` }] }
    case 'ActionRequested':
      return { ...state, actions: state.actions + 1 }
    case 'ChatRequested':
      return { ...state, chatPending: true }
    case 'ChatOpened': {
      const { chatPending: _chat, startPending: _start, ...rest } = state
      return { ...rest, chatThread: event.threadKey }
    }
    case 'StartDeferred':
      return { ...state, startPending: true }
    case 'ActionSettled':
      return state
    case 'JobReopened':
      return { ...state, reopened: true }
    case 'JobCompleted':
      // The approved proposals are done with the work the job finished with (`D12`); a job completed through its stages keeps the
      // pending ones before the approvers, and one completed by a fact (a merged merge request) drops every open one.
      return { ...state, ...endAttempt(event.stop), status: { kind: 'completed', outcome: event.outcome, at: event.at },
        ...settled(state, event.at, event.outcome === 'completed' ? ['approved'] : ['approved', 'pending', 'accepted', 'included'], event.outcome === 'completed') }
    case 'JobFailed':
      return { ...state, ...endAttempt(event.stop), status: { kind: 'failed', reason: event.reason, at: event.at }, ...settled(state, event.at, OPEN_PROPOSAL, false) }
    case 'JobCancelled':
      return { ...state, ...endAttempt(event.stop), status: { kind: 'cancelled', reason: event.reason, at: event.at, ...event.by ? { by: event.by } : {} },
        ...settled(state, event.at, OPEN_PROPOSAL, false) }
  }
}

/** The news to each proposal the job dropped at `at`, where it was asked, unless that is where the job's end is posted anyway. */
function dropped<T>(state: JobState, at: number, origin: string, post: (threadKey: string, message: Outbound, replyTo?: string) => T): T[] {
  return (state.proposals ?? []).filter(proposal => proposal.status === 'dropped' && proposal.doneAt === at && proposal.thread !== origin)
    .map(proposal => post(proposal.thread, { kind: 'proposalNews', news: 'dropped' }, proposal.replyTo))
}

/** The statuses of a proposal the job has not finished with. */
const OPEN_PROPOSAL: readonly Proposal['status'][] = ['pending', 'accepted', 'included', 'approved']

/** Marks the proposals named by id as given to `attemptId` (`D12`). */
function given(state: JobState, ids: ReadonlySet<string>, attemptId: string): Partial<JobState> {
  if (ids.size === 0 || !state.proposals?.some(proposal => ids.has(proposal.id))) return {}
  return { proposals: state.proposals.map(proposal => ids.has(proposal.id) && proposal.status === 'accepted' ? { ...proposal, givenTo: attemptId } : proposal) }
}

/** Whether the plan revision put to approval after `attemptId` includes the proposal: it was given it, or an earlier revision included it. */
const includes = (proposal: Proposal, attemptId: string | undefined) => (proposal.status === 'accepted' && attemptId !== undefined && proposal.givenTo === attemptId)
  || proposal.status === 'included'

/** The job ended: `done` (`approved` with `done`) or dropped proposals in the given statuses, at `at`. */
function settled(state: JobState, at: number, statuses: readonly Proposal['status'][], done: boolean): Partial<JobState> {
  if (!state.proposals?.some(proposal => statuses.includes(proposal.status))) return {}
  return { proposals: state.proposals.map(proposal => !statuses.includes(proposal.status) ? proposal
    : { ...proposal, status: done && proposal.status === 'approved' ? 'done' as const : 'dropped' as const, doneAt: at }) }
}

/** A proposal as it is put to the approvers. */
const asked = (proposal: Proposal) => ({ id: proposal.id, text: proposal.text, by: proposal.by })

/** The job's Jira ticket, where a workflow with places has its plan (`D12`). */
function ticketOf(deps: DeciderDeps, state: JobState): string | undefined {
  const { places } = deps.workflow(state.manifestId).declaration
  return /^jira:(.+)$/u.exec(places ? placeThread(state, places.plan) ?? '' : '')?.[1]
}

function effectsOf(deps: DeciderDeps, event: JobEvent, state: JobState) {
  const post = (threadKey: string, message: Outbound, replyTo?: string) => ({ kind: EFFECT.post,
    payload: { jobId: state.jobId, threadKey, message, ...replyTo ? { replyTo } : {} } satisfies PostPayload, orderingKey: `post:${threadKey}` })
  const stop = (attemptId?: string) => attemptId ? [{ cancel: { kind: EFFECT.attempt, orderingKey: attemptKey(state.jobId) } }] : []
  const origin = outcomeThread(deps.workflow(state.manifestId), state)
  const stopSetup = { cancel: { kind: EFFECT.setup, orderingKey: setupKey(state.jobId) } }
  switch (event.type) {
    case 'JobStarted': {
      const workflow = deps.workflow(state.manifestId)
      const chatIn = chatChannel(workflow, event.intake) ? workflow.extra.repository!.name : undefined
      return [post(event.intake.threadKey, { kind: 'started', workflowId: event.workflowId, stageId: workflow.declaration.start, ...chatIn ? { chatIn } : {} })]
    }
    case 'ChatRequested': return [post(event.channelKey, { kind: 'chat', requester: state.requester!, ...event.ticket ? { ticket: event.ticket } : {} })]
    case 'AttemptStarted': {
      const payload: AttemptPayload = { jobId: state.jobId, manifestId: state.manifestId, attemptId: event.attemptId, stageId: event.stageId,
        n: event.n, entry: event.entry, inputs: event.inputs, artifacts: event.artifacts }
      return [{ kind: EFFECT.attempt, payload, orderingKey: attemptKey(state.jobId) }]
    }
    case 'SetupStarted': return [{ kind: EFFECT.setup, payload: { jobId: state.jobId, manifestId: state.manifestId, n: event.n } satisfies SetupPayload,
      orderingKey: setupKey(state.jobId) }]
    case 'AttemptFailed': return event.stop ? stop(event.attemptId) : []
    case 'VerificationStarted': return event.checks.map(check => ({ kind: EFFECT.check,
      payload: { jobId: state.jobId, manifestId: state.manifestId, attemptId: event.attemptId, stageId: event.stageId, check } satisfies CheckPayload }))
    case 'GateOpened': {
      const { gate } = event
      if (gate.kind === 'question') return [post(gate.threadKey, { kind: 'question', gateId: gate.id, round: gate.round ?? 1, items: gate.items ?? [] })]
      if (gate.kind === 'approval') {
        // `D12`: the plan is in the ticket; the job's Mattermost thread gets one line pointing there.
        const { places } = deps.workflow(state.manifestId).declaration
        const chat = places ? placeThread(state, places.clarification) : undefined
        const ticket = /^jira:(.+)$/u.exec(gate.threadKey)?.[1]
        // Proposals still before the approvers are decided on this approval (`D12`).
        const open = pending(state).map(asked)
        return [post(gate.threadKey, { kind: 'approval', gateId: gate.id, subject: gate.subject!, ...open.length > 0 ? { proposals: open } : {} }),
          ...chat && ticket && chat !== gate.threadKey ? [post(chat, { kind: 'planPosted', subject: gate.subject!, ticket })] : []]
      }
      if (gate.kind === 'proposal') {
        const open = pending(state)
        const only = open.length === 1 && open[0]!.thread === gate.threadKey ? { to: open[0]!.by } : {}
        return [post(gate.threadKey, { kind: 'proposalAsk', gateId: gate.id, proposals: open.map(asked), ...only })]
      }
      const extension = deps.workflow(state.manifestId).declaration.budgets.extension
      const added = extensionFor(gate.blocked!, extension)
      return [post(gate.threadKey, { kind: 'blocked', gateId: gate.id, reason: gate.blocked!, ...Object.keys(added).length > 0 ? { extension: added } : {} })]
    }
    case 'GateInterpreting': {
      const gate = state.gates[event.gateId]!
      const payload: InterpretPayload = { gateId: gate.id, eventId: event.eventId, gateKind: gate.kind, text: event.text,
        verdictModel: deps.workflow(state.manifestId).extra.verdictModel, actor: event.actor, ...gate.subject ? { subject: gate.subject } : {},
        ...pending(state).length > 0 && (gate.kind === 'approval' || gate.kind === 'proposal') ? { proposals: pending(state).map(asked) } : {} }
      // One gate's replies are interpreted one after another, so their verdicts apply in the order they were posted.
      return [{ kind: EFFECT.interpret, payload, orderingKey: `interpret:${gate.id}` }]
    }
    case 'AnswersReading': {
      const gate = state.gates[event.gateId]!
      const payload: ReadPayload = { gateId: gate.id, eventId: event.eventId, text: event.text, actor: event.actor,
        model: deps.workflow(state.manifestId).extra.verdictModel,
        items: (gate.items ?? []).map((item, index) => {
          const askedOf = [...new Set((gate.redirects ?? []).filter(redirect => redirect.item === index + 1).map(redirect => redirect.to))]
          return { n: index + 1, text: item.text, answered: (gate.answers?.[String(index + 1)]?.length ?? 0) > 0, ...askedOf.length ? { askedOf } : {} }
        }) }
      // A round's replies are read one after another, so each sees the items the earlier ones answered.
      return [{ kind: EFFECT.read, payload, orderingKey: `read:${gate.id}` }]
    }
    case 'AnswersRecorded': {
      const gate = state.gates[event.gateId]!
      const items = gate.items ?? []
      // The post says what this reply changed, then what is still open; what earlier replies answered is not repeated.
      return [post(gate.threadKey, { kind: 'answersRecorded', gateId: gate.id,
        answered: [...new Set(event.answers.map(answer => answer.item))].sort((a, b) => a - b),
        remaining: items.flatMap((_item, index) => (gate.answers?.[String(index + 1)]?.length ?? 0) > 0 ? [] : [index + 1]),
        redirects: event.redirects.map(redirect => ({ ...redirect, text: items[redirect.item - 1]!.text })) })]
    }
    case 'AnswersUnread': return [post(state.gates[event.gateId]!.threadKey, { kind: 'unread', gateId: event.gateId })]
    case 'FollowUpInterpreting': {
      const payload: FollowUpPayload = { message: event.message, verdictModel: deps.workflow(state.manifestId).extra.verdictModel, jobId: state.jobId,
        ...event.questionOnly ? { questionOnly: true } : {} }
      // A job's follow-ups are read one after another, so they apply in the order they were posted.
      return [{ kind: EFFECT.interpretFollowUp, payload, orderingKey: `follow-up:${state.jobId}` }]
    }
    case 'AnswerRequested': {
      const payload: AnswerPayload = { jobId: state.jobId, answerId: event.answerId, threadKey: event.threadKey, question: event.question,
        actor: event.actor, model: deps.workflow(state.manifestId).extra.verdictModel, ...event.replyTo ? { replyTo: event.replyTo } : {} }
      return [{ kind: EFFECT.answer, payload, orderingKey: `answer:${state.jobId}` }]
    }
    case 'AnswerGiven': return [post(event.threadKey, { kind: 'answer', text: event.text }, event.replyTo)]
    case 'AnswerFailed': return [post(event.threadKey, { kind: 'answerFailed' }, event.replyTo)]
    case 'GateRestated': return [post(state.gates[event.gateId]!.threadKey, { kind: 'restate', gateId: event.gateId, reading: event.reading })]
    case 'GateReminded': return [post(state.gates[event.gateId]!.threadKey, { kind: 'reminder', gateId: event.gateId })]
    case 'GateClosed': {
      const gate = state.gates[event.gateId]!
      if (event.status !== 'satisfied' || !event.by || gate.kind === 'proposal') return []
      // The approval of a revision tells each proposal it includes, where it was asked (`D12`).
      const approved = gate.kind === 'approval' && gate.subject
        ? (state.proposals ?? []).filter(proposal => proposal.status === 'approved' && proposal.revision === gate.subject!.n && proposal.thread !== gate.threadKey) : []
      const news = approved.map(proposal => post(proposal.thread, { kind: 'proposalNews', news: 'approved', by: event.by!, revision: proposal.revision!,
        ...ticketOf(deps, state) ? { ticket: ticketOf(deps, state)! } : {} }, proposal.replyTo))
      const next = gate.kind === 'approval' ? gate.to! : gate.resume?.kind === 'attempt' ? gate.resume.stageId : gate.resume?.kind === 'backtrack' ? gate.resume.to : gate.stageId
      return [post(gate.threadKey, { kind: 'approved', gateId: gate.id, by: event.by, next, ...gate.subject ? { subject: gate.subject } : {},
        ...event.notes ? { notes: event.notes } : {} }), ...news]
    }
    case 'Blocked': return stop(event.stop)
    case 'NonApproverReplied': {
      const gate = state.gates[event.gateId]
      return gate ? [post(gate.threadKey, { kind: 'notApprover', to: event.actor })] : []
    }
    case 'ProposalRaised': {
      // `D12`: a pending proposal is put to the approvers on the open approval or proposal request (a new request posts it itself),
      // and the person who asked hears where it went; one an approver raised is accepted, and they hear the plan comes first.
      const { proposal } = event
      const ticket = ticketOf(deps, state)
      const where = ticket ? { ticket } : {}
      if (proposal.status === 'accepted') return [post(proposal.thread, { kind: 'proposalNews', news: 'accepted', ...where }, proposal.replyTo)]
      const open = Object.values(state.gates).filter(gate => gate.status === 'open')
      const gate = open.find(candidate => candidate.kind === 'approval') ?? open.find(candidate => candidate.kind === 'proposal')
      return [
        // Every pending one is listed again, so a plain "да" answers what the approvers see, with the numbers they see.
        ...gate ? [post(gate.threadKey, { kind: 'proposalAsk', gateId: gate.id, proposals: pending(state).map(asked), ...gate.kind === 'approval' ? { onApproval: true as const } : {},
          ...proposal.thread === gate.threadKey ? { to: proposal.by } : {} })] : [],
        ...proposal.thread !== placeThread(state, deps.workflow(state.manifestId).declaration.places!.plan)
          ? [post(proposal.thread, { kind: 'proposalNews', news: 'passed', ...where }, proposal.replyTo)] : []]
    }
    case 'ProposalDecided': {
      // Said where it was asked, unless that is the ticket the decision was made in.
      const proposal = state.proposals?.find(candidate => candidate.id === event.id)
      if (!proposal || proposal.thread === placeThread(state, deps.workflow(state.manifestId).declaration.places!.plan)) return []
      const ticket = ticketOf(deps, state)
      return [post(proposal.thread, { kind: 'proposalNews', news: event.accepted ? 'accepted' : 'declined', by: event.by, ...ticket ? { ticket } : {} }, proposal.replyTo)]
    }
    case 'ApprovalElsewhere': return [post(event.threadKey, { kind: 'approveElsewhere', ...ticketOf(deps, state) ? { ticket: ticketOf(deps, state)! } : {} })]
    case 'ProposalsDropped': return (state.proposals ?? []).filter(proposal => proposal.status === 'dropped' && proposal.doneAt === event.at)
      .map(proposal => post(proposal.thread, { kind: 'proposalNews', news: event.reason, ...ticketOf(deps, state) ? { ticket: ticketOf(deps, state)! } : {} }, proposal.replyTo))
    case 'JobClosedByFact': return dropped(state, event.at, '', post)
    case 'JobClosed': return [post(event.threadKey, { kind: 'closed', by: event.by }, event.replyTo), ...dropped(state, event.at, event.threadKey, post)]
    case 'CloseRefused': return [post(event.threadKey, { kind: 'closeNotAllowed', to: event.actor }, event.replyTo)]
    case 'ClosedJobAddressed': {
      const fact = state.closedBy !== undefined && state.closedBy !== 'person' ? state.closedBy
        : state.status.kind === 'completed' && state.status.outcome !== 'completed' ? state.status.outcome : undefined
      return [post(event.threadKey, { kind: 'jobClosed', ...fact ? { fact } : {}, ...state.closer ? { by: state.closer } : {} }, event.replyTo)]
    }
    case 'FollowUpReceived': return event.steer ? [{ kind: EFFECT.steer, payload: { attemptId: event.steer, text: event.message.text, actor: event.message.actor,
      ...event.proposal ? { proposal: event.proposal } : {} },
      orderingKey: `${state.jobId}/steer` }] : []
    case 'ActionRequested': return [{ kind: EFFECT.action, payload: { jobId: state.jobId, attemptId: event.attemptId, actionId: event.actionId, action: event.action,
      payload: event.payload } satisfies ActionPayload, orderingKey: `${state.jobId}/action` }]
    case 'JobCompleted': {
      // A job that finished through its stages names the checks its last attempt passed.
      const passed = event.outcome === 'completed' ? Object.entries(state.attempt?.checks ?? {}).filter(([, check]) => check.outcome === 'passed').map(([id]) => id) : []
      // Each proposal done with this work hears so where it was asked (`D12`).
      const done = (state.proposals ?? []).filter(proposal => proposal.status === 'done' && proposal.doneAt === event.at && proposal.thread !== origin)
      // The review's merge risk (`P16`): one line in the completion post, and the whole summary on the merge request when there is one.
      const reviewed = event.outcome === 'completed' ? Object.values(state.attempt?.checks ?? {}).find(check => check.outcome === 'passed' && check.risk) : undefined
      const mergeRequest = state.bindings.filter(binding => binding.threadKey.startsWith(PLACE_PREFIX.mergeRequest)).at(-1)?.threadKey
      return [...stop(event.stop), post(origin, { kind: 'completed', outcome: event.outcome, ...passed.length > 0 ? { checks: passed } : {},
        ...state.reopened ? { reworked: true } : {}, ...reviewed?.risk ? { risk: reviewed.risk } : {} }),
        ...reviewed?.risk && mergeRequest ? [post(mergeRequest, { kind: 'mergeRisk', risk: reviewed.risk, ...reviewed.notes ? { notes: reviewed.notes } : {} })] : [],
        ...done.map(proposal => post(proposal.thread, { kind: 'proposalNews', news: 'done' }, proposal.replyTo)),
        ...dropped(state, event.at, origin, post)]
    }
    // Ending the job also stops a setup step still running; with none, the cancel changes nothing.
    case 'JobFailed': return [...stop(event.stop), stopSetup, post(origin, { kind: 'failed', reason: event.reason }), ...dropped(state, event.at, origin, post)]
    case 'JobCancelled': return [...stop(event.stop), stopSetup, post(origin, { kind: 'cancelled', reason: event.reason, ...event.by ? { by: event.by } : {} }),
      ...dropped(state, event.at, origin, post)]
    default: return []
  }
}

/** The amounts one approval adds for an exhausted budget. */
export function extensionFor(reason: BlockReason, extension: { turns: number; tokens: number; attempts: number; backtracks: number }):
  Partial<Record<'turns' | 'tokens' | 'attempts' | 'backtracks', number>> {
  switch (reason.kind) {
    case 'budget': return reason.budget === 'turns' ? { turns: extension.turns } : { tokens: extension.tokens }
    case 'attempts': return { attempts: extension.attempts }
    case 'backtracks': return { backtracks: extension.backtracks }
    default: return {}
  }
}

function timersOf(deps: DeciderDeps, event: JobEvent, state: JobState) {
  switch (event.type) {
    case 'AttemptStarted': {
      const { limits } = stageOf(deps.workflow(state.manifestId), event.stageId)
      return [{ arm: { kind: TIMER.attempt, subject: event.attemptId, dueAt: event.at + limits.wallClockMs } }]
    }
    case 'AttemptReported':
    case 'AttemptFailed': return [{ cancel: { kind: TIMER.attempt, subject: event.attemptId } }]
    case 'GateOpened': {
      // A proposal request has the reminder and deadline of the plan's approval (`D12`).
      const { declaration } = deps.workflow(state.manifestId)
      const id = event.gate.kind === 'proposal'
        ? declaration.transitions.find(transition => transition.from === declaration.reopen?.requirements && transition.gate)?.gate : event.gate.declared
      const declared = id && declaration.gates.find(gate => gate.id === id)
      if (!declared) return []
      return [
        ...declared.reminderMs ? [{ arm: { kind: TIMER.reminder, subject: event.gate.id, dueAt: event.gate.openedAt + declared.reminderMs } }] : [],
        ...declared.deadlineMs ? [{ arm: { kind: TIMER.deadline, subject: event.gate.id, dueAt: event.gate.openedAt + declared.deadlineMs } }] : [],
      ]
    }
    case 'GateClosed': return [{ cancel: { kind: TIMER.reminder, subject: event.gateId } }, { cancel: { kind: TIMER.deadline, subject: event.gateId } }]
    case 'ProposalRaised': {
      // A proposal that joins an open request gets its full time: the request's reminder and deadline start again.
      if (event.proposal.status !== 'pending') return []
      const gate = Object.values(state.gates).find(candidate => candidate.kind === 'proposal' && candidate.status === 'open')
      const declaration = deps.workflow(state.manifestId).declaration
      const id = declaration.transitions.find(transition => transition.from === declaration.reopen?.requirements && transition.gate)?.gate
      const declared = gate && id && declaration.gates.find(candidate => candidate.id === id)
      if (!gate || !declared) return []
      return [
        ...declared.reminderMs ? [{ arm: { kind: TIMER.reminder, subject: gate.id, dueAt: event.proposal.at + declared.reminderMs } }] : [],
        ...declared.deadlineMs ? [{ arm: { kind: TIMER.deadline, subject: gate.id, dueAt: event.proposal.at + declared.deadlineMs } }] : [],
      ]
    }
    default: return []
  }
}
