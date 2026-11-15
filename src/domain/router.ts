/**
 * The router (`T8.4`): a pure function from an inbox event, plus lookups, to where it goes. No model is involved.
 *
 * - A reply on the thread of an open gate goes to that gate (`gateReply`); the job decides whether it is admitted.
 * - A message on a thread bound to an active job is a `followUp`; on a completed job's artifact thread (an MR), it may reopen it.
 * - A machine fact (a CI result, a merged MR) goes only to a job bound to its thread, and never answers a gate.
 * - Only an explicit mention or a direct message, from an allowed sender, matching a workflow's trigger, starts a job (`A18`).
 *   A new issue, being in a source's filter, an unaddressed post or a fact never does.
 * - For a workflow that works in a repository, in a deployment with repositories, a new job's repository is chosen from its trigger
 *   (`T11.1`, `chooseRepository`); when none is chosen, the trigger starts no job and gets a notice with the configured names
 *   (`A20`). A `repo:` that contradicts the thread's mapped repository, or a sender the chosen repository's own `senders` do not
 *   list, starts no job either, with a notice saying why. Any other workflow's jobs have no repository.
 * - A workflow whose plan lives in the ticket (`D12`) starts only from Jira or from a trigger that names an issue key (of one of the
 *   repository's Jira projects, when it maps any); any other trigger gets a `no_ticket` notice. After a job completes, only its merge
 *   request takes feedback (it may reopen review); a message on its other threads is routed like any other, except a close
 *   (`закрой`), which goes to the job on any of its threads.
 *
 * Sources append events in arrival order, and the caller routes them in that order, so each thread's events are decided in order.
 */
import { z } from 'zod'
import type { InboxEvent } from '../kernel/inbox.ts'
import type { Declaration } from './definition.ts'
import type { IntakeDecision, Message, Notice } from './job.ts'
import { eligible, isWorkbench, policyVersion, type Policy } from './policy.ts'
import { chooseRepository, type RepositoryProfile } from './repositories.ts'
import { isClose } from './vocabulary.ts'

/** The source of the workbench's own internal events (resuming a parked job). */
export const WORKBENCH_SOURCE = 'workbench'

/** What a source puts in an inbox event's payload; anything else is ignored as malformed. */
export const InboundPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    text: z.string(),
    /** How the message addresses the workbench: an explicit mention, a direct message, or neither. */
    addressed: z.enum(['mention', 'direct', 'none']),
    postedAt: z.number().int(),
    /** Where a reply to it goes within its thread: a merge request note's discussion. */
    replyTo: z.string().min(1).optional(),
  }).passthrough(),
  z.object({ kind: z.literal('fact'), fact: z.string().min(1), data: z.record(z.string(), z.unknown()).default({}) }).passthrough(),
  z.object({ kind: z.literal('resume'), jobId: z.string().min(1) }).strict(),
])

/** A job bound to a thread, with its current status (the kernel's, so `faulted` is included), and what closed it, if anything. */
export interface BoundJob { readonly jobId: string; readonly role: 'origin' | 'artifact'; readonly status: string; readonly closedBy?: string | null }
/** A workflow that may start jobs, in the order intake tries them. */
export interface IntakeWorkflow {
  readonly id: string; readonly version: number
  /** `repository`: whether its jobs work in one of the deployment's repositories (absent counts as no). */
  readonly declaration: Pick<Declaration, 'triggers'> & Partial<Pick<Declaration, 'repository' | 'places' | 'completeOn'>>
}

export interface RouterLookups {
  bindings(threadKey: string): readonly BoundJob[]
  openGate(threadKey: string): { jobId: string; gateId: string } | undefined
  readonly workflows: readonly IntakeWorkflow[]
  readonly policy: Policy
  /** Whether the event is the workbench's own post, recognized from its effect rows (GitLab runs on a person's token). */
  ownPost?(event: InboxEvent): boolean
  /** The deployment's repositories (`T11.1`), with senders resolved to the ids the sources give; with none, jobs have no repository. */
  readonly repositories?: readonly RepositoryProfile[]
}

export type Route =
  | { kind: 'gateReply'; jobId: string; gateId: string; message: Message }
  | { kind: 'followUp'; jobId: string; message: Message }
  | { kind: 'newJob'; intake: IntakeDecision; repository?: RepositoryProfile }
  /** A trigger that starts no job but gets a reply (`A20`: no repository matched). */
  | { kind: 'notice'; notice: Notice; threadKey: string; reason: string }
  | { kind: 'machineFact'; jobId: string; fact: string; threadKey: string; data: Record<string, unknown> }
  | { kind: 'resume'; jobId: string }
  | { kind: 'ignore'; reason: string }

const ENDED = new Set(['completed', 'failed', 'cancelled'])

export function route(event: InboxEvent, lookups: RouterLookups): Route {
  const ignore = (reason: string): Route => ({ kind: 'ignore', reason })
  const parsed = InboundPayloadSchema.safeParse(event.payload)
  if (!parsed.success) return ignore('malformed payload')
  const payload = parsed.data
  if (payload.kind === 'resume') return event.source === WORKBENCH_SOURCE ? { kind: 'resume', jobId: payload.jobId } : ignore('resume from outside the workbench')
  const threadKey = event.threadKey
  if (!threadKey) return ignore('no thread')
  if (lookups.ownPost?.(event) || (event.actor && isWorkbench(lookups.policy, event.actor))) return ignore('the workbench\'s own post')
  const bound = lookups.bindings(threadKey)
  const active = bound.find(job => !ENDED.has(job.status))

  if (payload.kind === 'fact') {
    // A finished job still hears a fact that would have completed it (a merge), so it closes and drops its open proposals (`D12`).
    const closing = lookups.workflows.some(workflow => workflow.declaration.completeOn?.includes(payload.fact) === true)
    const factJob = active ?? (closing ? bound.find(job => job.status === 'completed' && job.role === 'artifact') : undefined)
    return factJob ? { kind: 'machineFact', jobId: factJob.jobId, fact: payload.fact, threadKey, data: payload.data } : ignore('a fact on a thread no active job is bound to')
  }
  if (!event.human) return ignore('not from a person')
  if (!event.actor) return ignore('no verified actor')
  const message: Message = { eventId: event.id, actor: event.actor, threadKey, text: payload.text, postedAt: payload.postedAt,
    ...payload.replyTo ? { replyTo: payload.replyTo } : {} }

  const gate = lookups.openGate(threadKey)
  if (gate) return { kind: 'gateReply', jobId: gate.jobId, gateId: gate.gateId, message }
  // Only a merge request takes feedback after its job completed; a comment on a done job's ticket is no follow-up (`D12`). A close
  // (`закрой`) reaches the newest finished job on any of its threads; the job decides whether its sender may close it.
  const closing = isClose(payload.text)
  const followed = active ?? (closing ? bound.find(job => job.status === 'completed' && !job.closedBy) : undefined)
    ?? bound.find(job => job.status === 'completed' && (closing || (job.role === 'artifact' && threadKey.startsWith('gitlab:'))))
  if (followed) return { kind: 'followUp', jobId: followed.jobId, message }

  if (payload.addressed === 'none') return ignore('not addressed to the workbench')
  if (!eligible(lookups.policy, event.actor, 'sender')) return ignore('the sender may not start jobs')
  const addressed = payload.addressed
  const workflow = lookups.workflows.find(candidate => candidate.declaration.triggers.some(trigger => trigger.sources.includes(event.source)
    && trigger.on.includes(addressed) && (trigger.pattern === undefined || new RegExp(trigger.pattern, 'iu').test(payload.text))))
  if (!workflow) return ignore('no workflow matches')
  const repositories = lookups.repositories ?? []
  const choice = workflow.declaration.repository === true && repositories.length > 0 ? chooseRepository(repositories, { text: payload.text, threadKey }, event.actor) : undefined
  if (choice?.kind === 'refused') {
    return { kind: 'notice', threadKey, notice: choice.reason === 'contradicts'
      ? { kind: 'repository_refused', reason: 'contradicts', repository: choice.repository, mapped: choice.mapped }
      : { kind: 'repository_refused', reason: 'not_allowed', repository: choice.repository },
    reason: choice.reason === 'contradicts' ? `repo:${choice.repository} contradicts this thread's repository ${choice.mapped}`
      : `the sender may not start jobs on ${choice.repository}` }
  }
  if (choice?.kind === 'none') {
    return { kind: 'notice', threadKey, notice: { kind: 'no_repository', names: choice.names, ...choice.requested ? { requested: choice.requested } : {} },
      reason: choice.requested !== undefined ? `no repository is named ${JSON.stringify(choice.requested)}` : 'no repository matches, and there is no default' }
  }
  // `D12`: a workflow whose plan lives in the ticket needs one; a trigger outside Jira must name its key (the owner's choice).
  const projects = choice?.kind === 'chosen' ? choice.repository.match.jira : []
  if (workflow.declaration.places?.plan === 'ticket' && workflow.declaration.repository === true && event.source !== 'jira'
    && !ticketIn(payload.text, projects)) {
    const named = projects.includes('*') ? [] : projects
    return { kind: 'notice', threadKey, notice: { kind: 'no_ticket', ...named.length > 0 ? { projects: named } : {} },
      reason: 'the trigger names no Jira ticket for the plan' }
  }
  // `D12`: a job started in Jira or by a direct message asks its questions in its repository's channel, so it needs one.
  if (choice && workflow.declaration.places && (event.source === 'jira' || addressed === 'direct') && choice.repository.match.mattermost.length === 0) {
    return { kind: 'notice', threadKey, notice: { kind: 'no_chat_channel', repository: choice.repository.name },
      reason: `${choice.repository.name} has no Mattermost channel for the job's questions` }
  }
  return { kind: 'newJob', ...choice ? { repository: choice.repository } : {}, intake: { eventId: event.id, actor: event.actor, threadKey, basis: addressed,
    workflowId: workflow.id, workflowVersion: workflow.version, policyVersion: policyVersion(lookups.policy), text: payload.text, postedAt: payload.postedAt,
    ...choice ? { repository: { name: choice.repository.name, basis: choice.basis, allowedBy: choice.allowedBy } } : {} } }
}

/**
 * The Jira issue key a trigger names, such as `ORD-300` (the first one). When the repository maps Jira projects, only a key of one
 * of them counts, so `UTF-8` or another project's issue mentioned in passing is not taken for the job's ticket.
 */
export function ticketIn(text: string, projects: readonly string[] = []): string | undefined {
  const any = projects.length === 0 || projects.includes('*')
  for (const match of text.matchAll(/(?<![A-Za-z0-9_-])(([A-Z][A-Z0-9_]{0,31})-\d+)(?![A-Za-z0-9_-])/gu)) {
    if (any || projects.includes(match[2]!)) return match[1]
  }
  return undefined
}
