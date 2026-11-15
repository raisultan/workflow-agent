/**
 * The job model (`T8.5`): the job's status union, its state, and the commands, events and effect payloads of the job decider.
 * Every event carries a version (`v`), so a later change to an event's shape can be upcast before `evolve` reads it. Everything
 * here is JSON data: the kernel stores the state row and the events as JSON.
 */
import { z } from 'zod'
import { ActorSchema, type Actor } from './policy.ts'

/** Why a job exists (`D8`, decision 3): immutable, recorded at intake. */
export const IntakeDecisionSchema = z.object({
  eventId: z.string().min(1),
  actor: ActorSchema,
  threadKey: z.string().min(1),
  basis: z.enum(['mention', 'direct']),
  workflowId: z.string().min(1),
  workflowVersion: z.number().int().min(1),
  policyVersion: z.string().min(1),
  text: z.string(),
  postedAt: z.number().int(),
  /** The repository chosen for the job (`T11.1`), and by which rule; absent in a deployment with no repositories. */
  repository: z.object({ name: z.string().min(1), basis: z.enum(['explicit', 'jira', 'mattermost', 'default']),
    /** Which sender rule let the requester start it: the repository's own `senders`, or the global ones (`D10`, 2026-11-12). */
    allowedBy: z.enum(['repository', 'global']).optional() }).strict().optional(),
}).strict()
export type IntakeDecision = z.output<typeof IntakeDecisionSchema>

/** A human message the router delivered to a job. */
export const MessageSchema = z.object({
  eventId: z.string().min(1),
  actor: ActorSchema,
  threadKey: z.string().min(1),
  text: z.string(),
  postedAt: z.number().int(),
  /** Where a reply goes within the thread: a merge request note's discussion (trial 2026-11-14). */
  replyTo: z.string().min(1).optional(),
}).strict()
export type Message = z.output<typeof MessageSchema>

/** A stage's report, sent through `workbench_stage_report` (a tool origin). A top-level `null` field counts as absent. */
export const StageReportSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('completed'),
    summary: z.string().min(1),
    output: z.record(z.string(), z.unknown()).default({}),
    /** The produced artifact, already in the blob store. */
    artifact: z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/), title: z.string().min(1).optional() }).strict().optional(),
  }).strict(),
  z.object({
    outcome: z.literal('question'),
    summary: z.string().min(1).optional(),
    items: z.array(z.object({ text: z.string().min(1), choices: z.array(z.string().min(1)).optional() }).strict()).min(1).max(20),
  }).strict(),
  z.object({ outcome: z.literal('backtrack'), to: z.string().min(1), reason: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal('blocked'), reason: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal('failed'), reason: z.string().min(1) }).strict(),
])
export type StageReport = z.output<typeof StageReportSchema>

/** A verdict on a reply to an approval or resume gate (`D8`, decision 7). */
export const VerdictSchema = z.object({
  /**
   * `changes_requirements` only reads a follow-up on a merge request (`D12`): it asks for behaviour, inputs, outputs, errors or
   * interfaces the approved plan does not have, so it goes back to the plan for a new approval rather than into the code.
   */
  verdict: z.enum(['approve', 'approve_with_notes', 'request_changes', 'changes_requirements', 'question', 'cancel', 'unrelated', 'unclear']),
  notes: z.string().optional(),
  /** `D12`: the reply's decision on each proposal it was given (by id); a proposal it does not decide stays pending. */
  proposals: z.array(z.object({ id: z.string().min(1), accept: z.boolean() }).strict()).optional(),
  /** 0 to 1; below `MIN_CONFIDENCE` nothing is approved. */
  confidence: z.number().min(0).max(1),
  /** A one-sentence reading of the reply, restated to the person when it is unclear. */
  reading: z.string().optional(),
}).strict()
export type Verdict = z.output<typeof VerdictSchema>
/** Verdicts below this confidence never approve; the workbench restates its reading instead. */
export const MIN_CONFIDENCE = 0.8

/**
 * A reading of one reply to a question round (`D12`): which items it answers, a question it asks back, items it says to ask
 * someone else about (a username), or that it is unrelated to the questions. Items are 1-based.
 */
export const ReadingSchema = z.object({
  answers: z.array(z.object({ item: z.number().int().min(1), text: z.string().trim().min(1) }).strict()).default([]),
  question: z.string().trim().min(1).optional(),
  redirects: z.array(z.object({ item: z.number().int().min(1), to: z.string().trim().regex(/^@?[A-Za-z0-9._-]{1,64}$/u) }).strict()).default([]),
  /** The reply is not about the questions at all (people talking to each other in the thread): nothing is recorded and nothing is posted. */
  unrelated: z.boolean().optional(),
}).strict()
export type Reading = z.output<typeof ReadingSchema>

export type JobCommand =
  | { kind: 'start'; intake: IntakeDecision }
  /** A stage report (tool origin). */
  | { kind: 'report'; attemptId: string; report: unknown }
  /** Usage so far in an attempt (tool origin): cumulative turns and tokens. */
  | { kind: 'usage'; attemptId: string; turns: number; tokens: number }
  /** A safe-output write a stage requests (tool origin), checked against the stage's capabilities. */
  | { kind: 'action'; attemptId: string; action: string; payload: unknown }
  /** A reply on the thread of an open gate. */
  | { kind: 'reply'; gateId: string; message: Message }
  /** A message on a bound thread with no open gate. */
  | { kind: 'followUp'; message: Message }
  /** A machine fact on a bound thread (a CI result, a merged MR); never a human answer. */
  | { kind: 'fact'; fact: string; threadKey: string; data: Record<string, unknown> }
  /** Re-evaluates a parked job once its guards are registered. */
  | { kind: 'resume' }

export type AttemptEntry = 'initial' | 'next' | 'retry' | 'recovery' | 'answer' | 'revision' | 'question' | 'backtrack' | 'reopen' | 'resume'

/** What an attempt starts from besides its stage instructions: answers, notes, feedback, follow-ups and evidence, in order. */
export interface StageInput {
  readonly kind: 'answers' | 'approval_notes' | 'changes_requested' | 'gate_question' | 'follow_up' | 'check_failures' | 'recovery' | 'backtrack' | 'fact'
  readonly text: string
  readonly by?: Actor
  readonly items?: readonly { text: string; choices?: readonly string[] }[]
  /** A follow-up's thread, so a change request kept from a merge request reopens review when the job would complete (`D12`). */
  readonly thread?: string
  /** A merge request follow-up's discussion, so the agent answers it there. */
  readonly replyTo?: string
  /** The proposal a requested change carries (`D12`), so the job knows which attempt was given it. */
  readonly proposal?: string
  /** `answers` of a round read item by item (`D12`): each answer with its item (1-based) and who gave it. */
  readonly answers?: readonly { readonly item: number; readonly text: string; readonly by: Actor }[]
}

export interface ArtifactRevision { readonly kind: string; readonly n: number; readonly digest: string; readonly attemptId: string; readonly title?: string }

/** `proposal` (`D12`): the approvers decide proposed changes to the requirements; it does not stop the job. */
export type GateKind = 'question' | 'approval' | 'resume' | 'proposal'

/**
 * A proposed change to the approved requirements (`D12`, change proposals): raised where it was asked, decided by the approvers in
 * the ticket, and followed until it is done. `pending`: put to the approvers; `accepted`: going to the plan; `included`: in plan
 * revision `revision`, awaiting its approval; `approved`: that revision is approved; `done`: the job finished with it; `declined`.
 */
export interface Proposal {
  readonly id: string
  readonly text: string
  readonly by: Actor
  /** Where it was asked, and the discussion there (a merge request's), so the answer goes back to it. */
  readonly thread: string
  readonly replyTo?: string
  readonly at: number
  readonly status: 'pending' | 'accepted' | 'declined' | 'included' | 'approved' | 'done' | 'dropped'
  readonly decidedBy?: Actor
  readonly revision?: number
  /** When the job finished with it (`done`), or ended without it (`dropped`: cancelled, failed, or completed by a fact). */
  readonly doneAt?: number
  /** The requirements attempt it was given to, as a requested change or told to while running; only that attempt's revision includes it. */
  readonly givenTo?: string
}
export type GateStatus = 'open' | 'answered' | 'satisfied' | 'changes_requested' | 'questioned' | 'expired' | 'cancelled'

/** Why a job is blocked, and what an approved resume does. */
export type BlockReason =
  | { kind: 'budget'; budget: 'turns' | 'tokens' }
  | { kind: 'attempts'; stageId: string }
  | { kind: 'backtracks'; from: string; to: string }
  | { kind: 'stage_blocked'; stageId: string; detail: string }
  | { kind: 'gate_expired'; gateId: string }
  /** A required check could not decide, for a reason in the environment, not the agent's work (`T10.5`). */
  | { kind: 'checks_blocked'; stageId: string; checks: readonly string[]; detail: string }
  /** The setup step (toolchains, then the repository's setup command) failed; the cause is the environment (`T11.4`). */
  | { kind: 'setup_blocked'; detail: string }
export type Resume =
  | { kind: 'attempt'; stageId: string; entry: AttemptEntry; inputs: readonly StageInput[] }
  | { kind: 'backtrack'; from: string; to: string; reason: string }
  | { kind: 'approval'; stageId: string; declared: string; to: string; subject: ArtifactRevision }
  /** Runs the attempt's checks again, on the same commit. */
  | { kind: 'checks'; stageId: string; attemptId: string }
  /** Runs the setup step again (`T11.4`). */
  | { kind: 'setup' }

export interface GateResponse {
  readonly eventId: string
  readonly actor: Actor
  readonly accepted: boolean
  /** Why a reply was not admitted, or what a verdict decided. */
  readonly reason: string
  readonly interpreter?: 'vocabulary' | 'model'
  readonly verdict?: Verdict['verdict']
}

export interface Gate {
  readonly id: string
  readonly kind: GateKind
  readonly stageId: string
  readonly threadKey: string
  readonly openedAt: number
  readonly status: GateStatus
  /** The post that opened the gate; a reply must be posted after it. Absent until the post succeeds. */
  readonly postedAt?: number
  readonly postId?: string
  /** Approval: the declared gate, where approval leads, and the artifact revision it is about. */
  readonly declared?: string
  readonly to?: string
  readonly subject?: ArtifactRevision
  /** Question: the items and the round (1 is the first). */
  readonly items?: readonly { text: string; choices?: readonly string[] }[]
  readonly round?: number
  /** Resume: why the job blocked, what resuming does, and the extension an approval grants. */
  readonly blocked?: BlockReason
  readonly resume?: Resume
  readonly responses: readonly GateResponse[]
  /** Replies waiting for a model verdict, by inbox event id. */
  readonly interpreting: readonly string[]
  /** Question, read item by item (`D12`): the answers so far, by item (1-based). The round closes when every item has one. */
  readonly answers?: Readonly<Record<string, readonly { readonly text: string; readonly by: Actor }[]>>
  /** Question (`D12`): the items a reply said to ask someone else about, and whom (a username as written after `@`). */
  readonly redirects?: readonly { readonly item: number; readonly to: string }[]
}

/** The job's status (design §5): each variant carries only its own data. `new` exists only inside the first decision. */
export type JobStatus =
  | { kind: 'new' }
  /** The host's setup step runs before the first stage (`T11.4`): the job's toolchains, then its repository's setup command. */
  | { kind: 'setting_up'; n: number; since: number; afterInterruption?: boolean }
  | { kind: 'running'; stageId: string; attemptId: string }
  | { kind: 'verifying'; stageId: string; attemptId: string; checks: readonly string[] }
  | { kind: 'awaiting_gate'; gateId: string; stageId: string }
  | { kind: 'blocked'; reason: BlockReason; gateId: string; since: number }
  | { kind: 'parked'; missing: readonly string[]; since: number }
  | { kind: 'completed'; outcome: string; at: number }
  | { kind: 'failed'; reason: string; at: number }
  | { kind: 'cancelled'; by?: Actor; reason: string; at: number }

export interface Attempt {
  readonly id: string
  readonly stageId: string
  /** The attempt's number within its stage visit (1 is the first). */
  readonly n: number
  readonly entry: AttemptEntry
  readonly startedAt: number
  readonly ended: boolean
  readonly report?: StageReport
  readonly turns: number
  readonly tokens: number
  readonly checks: Readonly<Record<string, { outcome: CheckOutcome; evidence: string; notes?: string; risk?: Readonly<Record<string, unknown>> }>>
}

/**
 * A check's result (`T10.5`): `passed`; `failed`, the agent's work, so the attempt is retried with the evidence; or `blocked`, the
 * environment (no pipeline started, a check that could not run), so the job blocks until a person re-runs the checks or cancels.
 */
export type CheckOutcome = 'passed' | 'failed' | 'blocked'
/** `tokens`: model tokens the check used (the review), counted against the job's budget. */
/** `notes` and `risk` (`P16`): what a review says for people, apart from the engineer's evidence; the domain keeps them as data. */
export const CheckResultSchema = z.object({ outcome: z.enum(['passed', 'failed', 'blocked']), evidence: z.string(),
  tokens: z.number().int().nonnegative().optional(), notes: z.string().optional(), risk: z.record(z.string(), z.unknown()).optional() }).passthrough()

export interface JobState {
  readonly v: 1
  readonly jobId: string
  readonly manifestId: string
  readonly workflowId: string
  readonly requester?: Actor
  readonly originThread?: string
  readonly intake?: IntakeDecision
  readonly status: JobStatus
  /** Attempts so far, for ids; attempts in the current stage visit, for the attempt budget. */
  readonly attemptCount: number
  readonly visitAttempts: number
  readonly questionRounds: number
  readonly attempt?: Attempt
  readonly gateCount: number
  readonly gates: Readonly<Record<string, Gate>>
  readonly artifacts: Readonly<Record<string, readonly ArtifactRevision[]>>
  readonly backtracks: { readonly total: number; readonly edges: Readonly<Record<string, number>> }
  readonly usage: { readonly turns: number; readonly tokens: number }
  /** Approved extensions on top of the declared budgets. */
  readonly extended: { readonly turns: number; readonly tokens: number; readonly backtracks: number; readonly attempts: number }
  /** Inputs collected for the next attempt. */
  readonly inputs: readonly StageInput[]
  readonly bindings: readonly { readonly threadKey: string; readonly role: 'origin' | 'artifact' }[]
  /** The job's Mattermost thread, when the workbench opened one (`D12`: a job started in Jira or by a direct message). */
  readonly chatThread?: string
  /** The job reopened on merge request feedback at least once (`D12`): its completion post says it reworked the change. */
  readonly reopened?: true
  /**
   * The job is closed and takes nothing more: a `completeOn` fact (a merge) that came after it finished (`D12`), or `person` when an
   * approver closed it (`closer`).
   */
  readonly closedBy?: string
  readonly closer?: Actor
  /** The threads already told that the job is closed, so each is told once. */
  readonly closedTold?: readonly string[]
  /** Proposed changes to the requirements (`D12`), in the order raised; absent until the first. */
  readonly proposals?: readonly Proposal[]
  /** The job waits for its Mattermost thread; `startPending`: and its first attempt waits for it too. */
  readonly chatPending?: boolean
  readonly startPending?: boolean
  /** What a parked job re-evaluates once its guards are registered. */
  readonly parkedTransition?: { readonly stageId: string; readonly attemptId: string }
  readonly actions: number
  /** Setup runs so far (`T11.4`), and the toolchains the last completed one installed. */
  readonly setups?: number
  readonly toolchains?: readonly Toolchain[]
  /** The test services the last completed setup chose (`T12.4`): the Postgres major. Absent: the job has none. */
  readonly services?: JobServices
}

/** A toolchain the setup step installed for the job (`T11.4`): what was pinned, where, and the exact version and directory installed. */
export const ToolchainSchema = z.object({
  tool: z.string().min(1),
  requested: z.string().min(1),
  from: z.string().min(1),
  version: z.string().regex(/^\d+(?:\.\d+)*$/u),
  /** The binary directory, inside the toolchain cache, that goes first on every sandbox's PATH. */
  bin: z.string().regex(/^\//u),
}).strict()
export type Toolchain = z.output<typeof ToolchainSchema>
/** A job's test services (`T12.4`, `D11` decision 6): the Postgres major its repository uses. */
export const JobServicesSchema = z.object({ postgres: z.string().regex(/^\d{2}$/u) }).strict()
export type JobServices = z.output<typeof JobServicesSchema>
/** The setup effect's result. `blocked`: the environment failed (a download, a pin that cannot be honoured, the setup command). */
export const SetupResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('passed'), toolchains: z.array(ToolchainSchema).default([]), ignored: z.array(z.string()).default([]),
    services: JobServicesSchema.optional(), evidence: z.string() }).strict(),
  z.object({ outcome: z.literal('blocked'), evidence: z.string().min(1) }).strict(),
])

/** Job events; `v` is the event's schema version. */
export type JobEvent =
  | { v: 1; type: 'JobStarted'; intake: IntakeDecision; workflowId: string; at: number }
  /** `afterInterruption`: this run follows one a restart interrupted; another interruption blocks the job (review). */
  | { v: 1; type: 'SetupStarted'; n: number; at: number; afterInterruption?: boolean }
  | { v: 1; type: 'SetupCompleted'; n: number; toolchains: readonly Toolchain[]; ignored: readonly string[]; services?: JobServices; evidence: string }
  | { v: 1; type: 'ThreadBound'; threadKey: string; role: 'origin' | 'artifact' }
  | { v: 1; type: 'AttemptStarted'; attemptId: string; stageId: string; n: number; entry: AttemptEntry; inputs: readonly StageInput[];
      artifacts: readonly ArtifactRevision[]; at: number }
  | { v: 1; type: 'UsageRecorded'; attemptId: string; turns: number; tokens: number; added: { turns: number; tokens: number } }
  | { v: 1; type: 'AttemptReported'; attemptId: string; report: StageReport }
  | { v: 1; type: 'VerificationStarted'; attemptId: string; stageId: string; checks: readonly { id: string; kind: string; params: Record<string, unknown> }[] }
  | { v: 1; type: 'CheckCompleted'; attemptId: string; checkId: string; outcome: CheckOutcome; evidence: string; tokens?: number
    notes?: string; risk?: Readonly<Record<string, unknown>> }
  | { v: 1; type: 'AttemptFailed'; attemptId: string; reason: string; stop: boolean }
  | { v: 1; type: 'ArtifactRecorded'; revision: ArtifactRevision }
  | { v: 1; type: 'GateOpened'; gate: Gate }
  | { v: 1; type: 'GatePosted'; gateId: string; postId: string; postedAt: number }
  | { v: 1; type: 'GateResponded'; gateId: string; response: GateResponse; text?: string }
  | { v: 1; type: 'GateInterpreting'; gateId: string; eventId: string; text: string; actor: Actor }
  | { v: 1; type: 'GateRestated'; gateId: string; eventId: string; reading: string }
  | { v: 1; type: 'GateReminded'; gateId: string }
  | { v: 1; type: 'GateClosed'; gateId: string; status: Exclude<GateStatus, 'open'>; by?: Actor; notes?: string }
  | { v: 1; type: 'Backtracked'; from: string; to: string; reason: string }
  | { v: 1; type: 'Blocked'; reason: BlockReason; gateId: string; at: number; stop?: string }
  | { v: 1; type: 'BudgetExtended'; reason: BlockReason; by: Actor; added: Partial<Record<'turns' | 'tokens' | 'attempts' | 'backtracks', number>> }
  | { v: 1; type: 'Parked'; missing: readonly string[]; stageId: string; attemptId: string; at: number }
  | { v: 1; type: 'Unparked' }
  /** `proposal`: the accepted proposal told to the running requirements attempt (`D12`). */
  | { v: 1; type: 'FollowUpReceived'; message: Message; steer?: string; proposal?: string }
  /** `D12`: a steer delivered the proposal to the running requirements attempt, so that attempt's revision includes it. */
  | { v: 1; type: 'ProposalGiven'; id: string; attemptId: string }
  /** `D12`: the open proposals end undone: the request expired with no decision, or the merge request was merged. */
  /** `D12`: the open proposals end undone: the request expired with no decision, or could not be posted. */
  | { v: 1; type: 'ProposalsDropped'; reason: 'expired' | 'unasked'; at: number }
  /** `D12`: a finished job's merge request was merged (a `completeOn` fact after completion): it takes no more proposals or feedback. */
  | { v: 1; type: 'JobClosedByFact'; fact: string; at: number }
  /** An approver closed the finished job (`закрой`) on one of its threads: it takes no more proposals or feedback. */
  | { v: 1; type: 'JobClosed'; by: Actor; eventId: string; threadKey: string; replyTo?: string; at: number }
  /** Someone who may not close the finished job asked to; they are told who may. */
  | { v: 1; type: 'CloseRefused'; actor: Actor; eventId: string; threadKey: string; replyTo?: string }
  /** A message on a closed job's thread: the thread is told once that the job is closed. */
  | { v: 1; type: 'ClosedJobAddressed'; eventId: string; threadKey: string; replyTo?: string }
  /** `D12`: someone who may not approve approved (or agreed) on an approval gate: it does not count, and they are told who approves. */
  | { v: 1; type: 'NonApproverReplied'; gateId: string; eventId: string; actor: Actor }
  /** `D12`: a proposed change to the requirements; `accepted` when an approver raised it (then `proposal.decidedBy` is them). */
  | { v: 1; type: 'ProposalRaised'; proposal: Proposal; eventId: string }
  /** `D12`: the approvers decided a pending proposal. */
  | { v: 1; type: 'ProposalDecided'; id: string; accepted: boolean; by: Actor; eventId: string }
  /** `D12`: an approval written outside the approval's place (an "ок" in Mattermost while the plan waits in Jira). */
  | { v: 1; type: 'ApprovalElsewhere'; gateId: string; eventId: string; threadKey: string; actor: Actor }
  | { v: 1; type: 'FactRecorded'; fact: string; threadKey: string; data: Record<string, unknown> }
  | { v: 1; type: 'ActionRequested'; attemptId: string; actionId: string; action: string; payload: unknown }
  /** `D12`: the workbench asked for the job's Mattermost thread in `channelKey`, opened it as `threadKey`, or held the first attempt for it. */
  /** `D12`: a reply to a question round is being read item by item, was read, or could not be read. */
  | { v: 1; type: 'AnswersReading'; gateId: string; eventId: string; text: string; actor: Actor }
  | { v: 1; type: 'AnswersRecorded'; gateId: string; eventId: string; actor: Actor; answers: readonly { item: number; text: string }[];
    redirects: readonly { item: number; to: string }[] }
  | { v: 1; type: 'AnswersUnread'; gateId: string; eventId: string }
  /** `D12`: a follow-up on a job with places is read first: a question gets an answer turn, anything else is a follow-up. */
  /** `questionOnly`: a reply on an approval gate from someone who may not approve; a question gets an answer, nothing else counts (`A24`). */
  | { v: 1; type: 'FollowUpInterpreting'; message: Message; questionOnly?: true }
  /** `D12`: an answer turn for a question asked on `threadKey`, its answer (tokens count against the budget), or its failure. */
  /** `replyTo`: the discussion of the thread the question was asked in, where the answer goes. */
  | { v: 1; type: 'AnswerRequested'; answerId: string; threadKey: string; question: string; actor: Actor; replyTo?: string }
  | { v: 1; type: 'AnswerGiven'; answerId: string; threadKey: string; text: string; tokens: number; replyTo?: string }
  | { v: 1; type: 'AnswerFailed'; answerId: string; threadKey: string; reason: string; replyTo?: string }
  | { v: 1; type: 'ChatRequested'; channelKey: string; ticket?: string }
  | { v: 1; type: 'ChatOpened'; threadKey: string }
  | { v: 1; type: 'StartDeferred' }
  | { v: 1; type: 'ActionSettled'; actionId: string; action: string; ok: boolean; detail: string }
  /** `stage`: where the job reopened; `threadKey`: the thread whose message reopened it (`D12`). */
  | { v: 1; type: 'JobReopened'; by: Actor; eventId: string; stage?: string; threadKey?: string; replyTo?: string }
  | { v: 1; type: 'JobCompleted'; outcome: string; at: number; stop?: string }
  | { v: 1; type: 'JobFailed'; reason: string; at: number; stop?: string }
  | { v: 1; type: 'JobCancelled'; by?: Actor; reason: string; at: number; stop?: string }

/** Upcasts a stored event to the current version; every event is at version 1 so far. */
export function upcast(event: JobEvent): JobEvent {
  return event
}

/** What the workbench posts; the adapter renders it in the thread's language. */
export type Outbound =
  /** `chatIn`: the job's questions are in a Mattermost thread of this repository's channel, not here (`D12`). */
  | { kind: 'started'; workflowId: string; stageId: string; chatIn?: string }
  /** The root post of a job's Mattermost thread, for a job started in Jira or by a direct message (`D12`). */
  | { kind: 'chat'; ticket?: string; requester: Actor }
  | { kind: 'question'; gateId: string; round: number; items: readonly { text: string; choices?: readonly string[] }[] }
  /** `proposals`: proposed changes still before the approvers, decided on this approval (`D12`). */
  | { kind: 'approval'; gateId: string; subject: ArtifactRevision; proposals?: readonly { id: string; text: string; by: Actor }[] }
  /**
   * After a reply to a question round (`D12`): what this reply changed (the items it answered, the people it said to ask about an
   * item) and the items still open.
   */
  | { kind: 'answersRecorded'; gateId: string; answered: readonly number[]; remaining: readonly number[];
    redirects: readonly { item: number; to: string; text: string }[] }
  /** An answer turn's answer to a question asked here, or a notice that none could be given (`D12`). */
  | { kind: 'answer'; text: string }
  | { kind: 'answerFailed' }
  /** A reply to a question round that tried to answer but matched no item (`D12`); talk unrelated to the questions gets no post. */
  | { kind: 'unread'; gateId: string }
  /** In the job's Mattermost thread: the plan revision is in the Jira ticket, discussed and approved there (`D12`). */
  | { kind: 'planPosted'; subject: ArtifactRevision; ticket: string }
  | { kind: 'approved'; gateId: string; subject?: ArtifactRevision; by: Actor; notes?: string; next: string }
  | { kind: 'restate'; gateId: string; reading: string }
  | { kind: 'reminder'; gateId: string }
  | { kind: 'blocked'; gateId: string; reason: BlockReason; extension?: Record<string, number> }
  /** `checks`: the checks that passed on the work the job finished with (`T10.6`); `reworked`: it finished again after MR feedback. */
  | { kind: 'completed'; outcome: string; checks?: readonly string[]; reworked?: true; risk?: Readonly<Record<string, unknown>> }
  /** On the merge request (`P16`): the review's merge-risk summary, and the serious claims it could not back with evidence. */
  | { kind: 'mergeRisk'; risk: Readonly<Record<string, unknown>>; notes?: string }
  /** `D12`: someone who may not approve approved, which does not count. */
  | { kind: 'notApprover'; to: Actor }
  /** The job was closed by `by` (an approver's `закрой`). */
  | { kind: 'closed'; by: Actor }
  /** `to` may not close the job; its approvers may. */
  | { kind: 'closeNotAllowed'; to: Actor }
  /** The job is closed, by a fact (`fact`, a merge) or by a person (`by`): comments no longer reopen it. */
  | { kind: 'jobClosed'; fact?: string; by?: Actor }
  /**
   * In the ticket (`D12`): proposals put to the approvers. `onApproval`: they are decided on the plan's approval; `to`: the person
   * who proposed it here, told first that only the approvers change the plan.
   */
  | { kind: 'proposalAsk'; gateId: string; proposals: readonly { id: string; text: string; by: Actor }[]; onApproval?: true; to?: Actor }
  /** Where a proposal was asked (`D12`): what became of it. `ticket`: where the plan is; `revision`: the plan revision it is in. */
  | { kind: 'proposalNews'; news: 'passed' | 'accepted' | 'declined' | 'approved' | 'done' | 'dropped' | 'expired' | 'unasked'; ticket?: string; by?: Actor; revision?: number }
  /** `D12`: an approval written outside the approval's place; `ticket` is where the plan is approved. */
  | { kind: 'approveElsewhere'; ticket?: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled'; reason: string; by?: Actor }

/**
 * What the workbench posts about an inbox event that starts no job (`T11.1`): a notice, queued by intake with no job (the kernel's
 * job-less effect), once per event.
 */
export type Notice =
  /** No repository matched the trigger (`A20`): `requested` is the `repo:` name it gave, if any; `names` are the configured ones. */
  | { kind: 'no_repository'; names: readonly string[]; requested?: string }
  /** The sender may not start jobs on `repository` (its own `senders`), or `repo:` named another than the thread's `mapped` one. */
  | { kind: 'repository_refused'; reason: 'not_allowed'; repository: string }
  | { kind: 'repository_refused'; reason: 'contradicts'; repository: string; mapped: string }
  /** A job started in Jira or by a direct message needs its repository's Mattermost channel for its questions, and it has none (`D12`). */
  | { kind: 'no_chat_channel'; repository: string }
  /**
   * A workflow whose plan lives in the ticket was started outside Jira by a trigger that names no issue key (`D12`). `projects` are
   * the repository's Jira projects, when it maps any: only their keys count, and the reply's example uses the first.
   */
  | { kind: 'no_ticket'; projects?: readonly string[] }
export interface NoticePayload { readonly eventId: string; readonly threadKey: string; readonly notice: Notice }

/** Effect kinds and payloads the decider emits; adapters (`P9`) perform them. */
export const EFFECT = {
  attempt: 'stage.attempt',
  steer: 'stage.steer',
  post: 'post',
  interpret: 'interpretReply',
  /** Reads a reply to a question round item by item (`D12`). */
  read: 'readAnswers',
  /** Tells a question to the workbench from any other follow-up (`D12`). */
  interpretFollowUp: 'interpretFollowUp',
  /** An answer turn: one model call, read-only, with the job's context (`D12`). */
  answer: 'answer',
  check: 'check',
  action: 'action',
  notice: 'notice',
  setup: 'setup',
} as const
export interface AttemptPayload {
  readonly jobId: string; readonly manifestId: string; readonly attemptId: string; readonly stageId: string; readonly n: number
  readonly entry: AttemptEntry; readonly inputs: readonly StageInput[]; readonly artifacts: readonly ArtifactRevision[]
}
/** `replyTo`: where in the thread the post goes, a merge request discussion; absent, it starts a new note or post. */
export interface PostPayload { readonly jobId: string; readonly threadKey: string; readonly message: Outbound; readonly replyTo?: string }
export interface InterpretPayload {
  readonly gateId: string; readonly eventId: string; readonly gateKind: GateKind; readonly text: string; readonly actor: Actor
  readonly verdictModel: string; readonly subject?: ArtifactRevision
  /** `D12`: proposed changes to the requirements put to the approvers, which the reply may decide. */
  readonly proposals?: readonly { readonly id: string; readonly text: string; readonly by: Actor }[]
}
/** What telling a follow-up's kind needs (`D12`). */
export interface FollowUpPayload {
  readonly message: Message; readonly verdictModel: string; readonly questionOnly?: true
  /** The job, so the host can give the reading the approved plan: a change to the plan's requirements is told from a code fix. */
  readonly jobId?: string
}
/** What an answer turn needs (`D12`): the question, where it was asked, and the model; the host assembles the job's context. */
export interface AnswerPayload {
  readonly jobId: string; readonly answerId: string; readonly threadKey: string; readonly question: string; readonly actor: Actor; readonly model: string
  readonly replyTo?: string
}
/** An answer turn's result. */
export const AnswerResultSchema = z.object({ text: z.string().trim().min(1), tokens: z.number().int().min(0).default(0) }).passthrough()

/** What reading a reply to a question round needs (`D12`): the round's items, which are answered already, and the model. */
export interface ReadPayload {
  readonly gateId: string; readonly eventId: string; readonly text: string; readonly actor: Actor; readonly model: string
  /** `askedOf`: the people a reply said to ask about the item (usernames), so their unnumbered reply can be read as about it. */
  readonly items: readonly { readonly n: number; readonly text: string; readonly answered: boolean; readonly askedOf?: readonly string[] }[]
}
export interface CheckPayload {
  readonly jobId: string; readonly manifestId: string; readonly attemptId: string; readonly stageId: string
  readonly check: { id: string; kind: string; params: Record<string, unknown> }
}
/** The setup step of a job (`T11.4`); `n` tells a stale result from the current run's. */
export interface SetupPayload { readonly jobId: string; readonly manifestId: string; readonly n: number }
export interface ActionPayload { readonly jobId: string; readonly attemptId: string; readonly actionId: string; readonly action: string; readonly payload: unknown }
/** An action's result may bind a thread the action created (an MR) to the job. */
export const ActionResultSchema = z.object({ bind: z.string().min(1).optional() }).passthrough()

/** Timer kinds; each one's subject is an attempt or gate id. */
export const TIMER = { attempt: 'attempt.deadline', reminder: 'gate.reminder', deadline: 'gate.deadline' } as const

/** Terminal statuses take no further work. */
export const isTerminal = (status: JobStatus) => status.kind === 'completed' || status.kind === 'failed' || status.kind === 'cancelled'
