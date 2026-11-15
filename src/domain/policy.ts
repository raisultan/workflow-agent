/**
 * Who may do what (`T8.3`). The policy is deployment configuration (`D9`): allowed senders per source (from
 * `WORKBENCH_ALLOWED_SENDERS`), approvers per workflow and source, and the workbench's own identities per source. Eligibility is a
 * pure function over the **current** policy, so removing an approver applies to running jobs too; a job's manifest records the
 * policy version its intake was decided under. The requester may approve their own job; the workbench itself never can. GitLab
 * has no workbench identity (it runs on a person's token), so its own posts are recognized from effect rows by the router's
 * caller, not by author.
 */
import { z } from 'zod'
import { sha256Hex } from '../kernel/projections.ts'
import { canonicalJson } from '../kernel/registry.ts'

export const ActorSchema = z.object({ source: z.string().min(1), id: z.string().min(1) }).strict()
/** A source-verified identity. */
export type Actor = z.output<typeof ActorSchema>

const Ids = z.array(z.string().min(1))
export const PolicySchema = z.object({
  /** Who may start a job, per source. */
  senders: z.record(z.string(), Ids).default({}),
  /** Who may approve a workflow's gates besides the requester, per workflow id and source; `*` is every allowed sender of that source. */
  approvers: z.record(z.string(), z.record(z.string(), Ids)).default({}),
  /**
   * The workbench's own identities per source, as ids and usernames (a username also tells the vocabulary which mentions are the
   * workbench's); a source without one (GitLab) is absent.
   */
  bots: z.record(z.string(), Ids).default({}),
  /**
   * Each repository's approvers (`D12`), per source, as the host resolved them from the profile's emails: when a job's repository
   * has an entry, only they approve and resolve its blocked gates.
   */
  repositoryApprovers: z.record(z.string(), z.record(z.string(), Ids)).optional(),
}).strict()
export type Policy = z.output<typeof PolicySchema>

/**
 * Roles a job checks:
 * - `sender` starts a job (an allowed sender);
 * - `approver` resolves approval and budget gates and cancels or retries the job (the requester while still an allowed sender,
 *   or a workflow approver);
 * - `respondent` answers questions (an approver or an allowed sender; on a job whose workflow declares places, `D12`, any person
 *   in its threads).
 */
export type Role = 'sender' | 'approver' | 'respondent'
/** What eligibility needs to know about a job. */
export interface JobRoles {
  readonly workflowId: string
  readonly requester: Actor
  /** The job's repository: its approvers, when the policy lists them, are the only approvers (`D12`). */
  readonly repository?: string
  /** Whether anyone in the job's threads may answer its questions (a workflow with places, `D12`). */
  readonly participants?: boolean
}

const same = (a: Actor, b: Actor) => a.source === b.source && a.id.toLowerCase() === b.id.toLowerCase()
const listed = (ids: readonly string[] | undefined, actor: Actor) => (ids ?? []).some(id => id.toLowerCase() === actor.id.toLowerCase())

/** A stable identifier of the policy's content: ids are compared case-insensitively, so they are hashed lowercased and sorted. */
export function policyVersion(policy: Policy): string {
  const norm = (ids: readonly string[]) => [...new Set(ids.map(id => id.toLowerCase()))].sort()
  const map = (record: Readonly<Record<string, readonly string[]>>) => Object.fromEntries(Object.entries(record).map(([key, ids]) => [key, norm(ids)]))
  const nested = (record: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>) =>
    Object.fromEntries(Object.entries(record).map(([key, bySource]) => [key, map(bySource)]))
  const repositoryApprovers = policy.repositoryApprovers ?? {}
  // Hashed only when present, so a policy without repository approvers keeps its version.
  const normalized = { senders: map(policy.senders), bots: map(policy.bots), approvers: nested(policy.approvers),
    ...Object.keys(repositoryApprovers).length > 0 ? { repositoryApprovers: nested(repositoryApprovers) } : {} }
  return `pv_${sha256Hex(canonicalJson(normalized)).slice(0, 16)}`
}

/** Whether `actor` is one of the workbench's own identities. */
export function isWorkbench(policy: Policy, actor: Actor): boolean {
  return listed(policy.bots[actor.source], actor)
}

/** Whether `actor` holds `role`, under the current policy, for `job` (needed for every role but `sender`). */
export function eligible(policy: Policy, actor: Actor, role: Role, job?: JobRoles): boolean {
  if (isWorkbench(policy, actor)) return false
  const sender = listed(policy.senders[actor.source], actor)
  if (role === 'sender') return sender
  if (!job) return false
  const byRepository = job.repository === undefined ? undefined : policy.repositoryApprovers?.[job.repository]
  const approvers = policy.approvers[job.workflowId]?.[actor.source]
  const approver = byRepository ? listed(byRepository[actor.source], actor)
    : (sender && same(actor, job.requester)) || listed(approvers, actor) || (sender && (approvers ?? []).includes('*'))
  return role === 'respondent' ? approver || sender || job.participants === true : approver
}
