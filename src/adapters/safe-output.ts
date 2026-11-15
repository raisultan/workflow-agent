/**
 * Safe-output tools (`T9.3`, `D8` decision 6): a stage's write tools never hold a credential. Each one checks its request against
 * the job's scope, submits it to the job as an `action` command (a tool origin: a repeated call is consumed once), and waits for the
 * write's effect. The job checks the action against the stage's capabilities and turns it into an effect, which the writers perform
 * with host credentials (`T9.2`). A result within the wait returns to the model; after it, the tool answers `queued`, and the
 * result reaches the session as a notice.
 *
 * Scope (kept from V1): Jira writes go to the job's own issue; GitLab writes go to the job's repository, on agent branches no other
 * job uses, and to merge requests bound to the job; Mattermost posts go to threads bound to the job, their channels, or channels
 * the job created.
 */
import { z } from 'zod'
import type { AttemptPayload, JobState } from '../domain/job.ts'
import type { Workbench } from '../domain/workbench.ts'
import { assertAllowedAgentBranch } from '../sources/gitlab.ts'
import type { StageTool } from './stage-runner.ts'
import { parseThread, threadKey, type Thread } from './threads.ts'
import { toDshParameterSchema } from '../tools/shared.ts'
import type { ActionName } from './writers.ts'

export interface SafeOutputDeps {
  readonly workbench: Pick<Workbench, 'action' | 'workflow' | 'kernel'>
  /** The job's repository (GitLab project path), if it has one. */
  repository(jobId: string): string | undefined
  /** The commit at the job worktree's `HEAD`. */
  headSha(jobId: string): Promise<string>
  /** The branch a merge request targets when the model names none (default `main`). */
  readonly targetBranch?: string
  /** How long a tool waits for its write before answering `queued` (default 30 s). */
  readonly awaitMs?: number
}

/** What a tool may write to, from the job's state and the writes it made. */
interface Scope {
  readonly jobId: string
  readonly state: JobState
  readonly bound: ReadonlySet<string>
  readonly repository: string | undefined
  readonly createdChannels: ReadonlySet<string>
  branchOwner(branch: string): string | undefined
}

const Text = z.string().min(1)
const MrIid = z.number().int().positive()
const Project = Text.optional().describe('The GitLab project path; the job\'s repository by default.')
const IssueKey = Text.optional().describe('The Jira issue key; the job\'s issue by default.')

interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly args: z.ZodType
  payload(args: never, scope: Scope, deps: SafeOutputDeps): Promise<unknown> | unknown
}

const fail = (message: string): never => { throw new Error(message) }

function jiraIssue(requested: string | undefined, scope: Scope): string {
  const own = [...scope.bound].flatMap(key => key.startsWith('jira:') ? [key.slice(5)] : [])
  const issueKey = requested ?? own[0] ?? fail('This job has no Jira issue')
  if (!scope.bound.has(`jira:${issueKey}`)) fail(`Jira writes are limited to this job's issue (${own.join(', ') || 'none'}); ${issueKey} is out of scope`)
  return issueKey
}

function gitlabProject(requested: string | undefined, scope: Scope): string {
  const project = requested ?? scope.repository ?? fail('This job has no repository')
  if (project !== scope.repository) fail(`GitLab writes are limited to this job's repository (${scope.repository ?? 'none'}); ${project} is out of scope`)
  return project
}

function agentBranch(branch: string, scope: Scope): string {
  const name = branch.trim().replace(/^refs\/heads\//u, '')
  assertAllowedAgentBranch(name, false)
  const issue = [...scope.bound].find(key => key.startsWith('jira:'))?.slice(5).toLowerCase()
  if (issue && !name.startsWith(`agent/${issue}-`)) fail(`Branch ${name} must start with agent/${issue}- for this job`)
  const owner = scope.branchOwner(name)
  if (owner && owner !== scope.jobId) fail(`Branch ${name} is already used by another job (${owner})`)
  return name
}

function boundMr(project: string, mrIid: number, scope: Scope): number {
  if (!scope.bound.has(threadKey({ source: 'gitlab', project, mrIid }))) fail(`Merge request !${mrIid} in ${project} is not this job's; only one it opened or is bound to may change`)
  return mrIid
}

function mattermostThread(args: { thread?: string | undefined; channelId?: string | undefined; rootId?: string | undefined }, scope: Scope): string {
  const origin = scope.state.originThread
  const key = args.thread ?? (args.channelId ? `mattermost:${args.channelId}:${args.rootId ?? ''}`
    : origin?.startsWith('mattermost:') ? origin : fail('Name the thread or channel to post to'))
  let thread: Thread
  try { thread = parseThread(key) } catch { return fail(`Unknown thread ${key}`) }
  if (thread.source !== 'mattermost') fail(`${key} is not a Mattermost thread`)
  if (scope.bound.has(key)) return key
  const channel = (thread as Extract<Thread, { source: 'mattermost' }>).channelId
  const ownChannels = new Set([...scope.createdChannels, ...[...scope.bound].flatMap(bound => {
    const parsed = (() => { try { return parseThread(bound) } catch { return undefined } })()
    return parsed?.source === 'mattermost' ? [parsed.channelId] : []
  })])
  // A new root post may go to a channel the job knows; a reply only to a thread bound to it.
  if (!(thread as { rootId?: string }).rootId && ownChannels.has(channel)) return key
  return fail(`Mattermost ${key} is out of scope for this job; only its threads, their channels and channels it created are`)
}

/** The tools, by the action (capability) each performs. */
export const TOOLS: Record<ActionName, ToolDefinition> = {
  'mattermost.post': {
    name: 'mattermost_post_message',
    description: 'Posts a message to a Mattermost thread of this job, or a new thread in one of its channels. Mention people as @username.',
    args: z.object({ thread: Text.optional().describe('A thread key, mattermost:<channelId>:<rootId>; the job\'s thread by default.'),
      channelId: Text.optional(), rootId: Text.optional(), text: Text }).strict(),
    payload: (args: { thread?: string; channelId?: string; rootId?: string; text: string }, scope) => ({ thread: mattermostThread(args, scope), text: args.text }),
  },
  'mattermost.createChannel': {
    name: 'mattermost_create_channel',
    description: 'Creates a public Mattermost channel (or finds the one with that name) and invites people by username.',
    args: z.object({ name: Text, displayName: Text, purpose: z.string().optional(), invite: z.array(Text).default([]) }).strict(),
    payload: (args: object) => args,
  },
  'jira.link': {
    name: 'jira_link_issue',
    description: 'Makes a Jira issue this job\'s issue (the one the request is about), so the job may comment on and move it.',
    args: z.object({ issueKey: Text }).strict(),
    payload: (args: { issueKey: string }, scope) => {
      const own = [...scope.bound].find(key => key.startsWith('jira:'))?.slice(5)
      if (own && own !== args.issueKey.toUpperCase()) fail(`This job's issue is ${own} already`)
      return { issueKey: args.issueKey.toUpperCase() }
    },
  },
  'jira.comment': {
    name: 'jira_add_comment',
    description: 'Adds a comment to the job\'s Jira issue.',
    args: z.object({ issueKey: IssueKey, body: Text }).strict(),
    payload: (args: { issueKey?: string; body: string }, scope) => ({ issueKey: jiraIssue(args.issueKey, scope), body: args.body }),
  },
  'jira.transition': {
    name: 'jira_transition_issue',
    description: 'Moves the job\'s Jira issue by a transition id, or a transition or status name.',
    args: z.object({ issueKey: IssueKey, transition: Text }).strict(),
    payload: (args: { issueKey?: string; transition: string }, scope) => ({ issueKey: jiraIssue(args.issueKey, scope), transition: args.transition }),
  },
  'jira.updateFields': {
    name: 'jira_update_fields',
    description: 'Sets fields on the job\'s Jira issue.',
    args: z.object({ issueKey: IssueKey, fields: z.record(z.string(), z.unknown()) }).strict(),
    payload: (args: { issueKey?: string; fields: Record<string, unknown> }, scope) => ({ issueKey: jiraIssue(args.issueKey, scope), fields: args.fields }),
  },
  'gitlab.push': {
    name: 'gitlab_push_branch',
    description: 'Pushes the worktree\'s current commit (or the one named) to an agent branch, without force. Commit your changes first.',
    args: z.object({ project: Project, branch: Text, commitSha: z.string().regex(/^[0-9a-f]{40}$/u).optional() }).strict(),
    payload: async (args: { project?: string; branch: string; commitSha?: string }, scope, deps) => ({ project: gitlabProject(args.project, scope),
      branch: agentBranch(args.branch, scope), sha: args.commitSha ?? await deps.headSha(scope.jobId) }),
  },
  'gitlab.createMr': {
    name: 'gitlab_create_mr',
    description: 'Opens a merge request from a pushed agent branch (or returns the one already open from it). The job follows its discussion.',
    args: z.object({ project: Project, sourceBranch: Text, targetBranch: Text.optional(), title: Text, description: z.string().default('') }).strict(),
    payload: (args: { project?: string; sourceBranch: string; targetBranch?: string; title: string; description: string }, scope, deps) => ({
      project: gitlabProject(args.project, scope), sourceBranch: agentBranch(args.sourceBranch, scope), targetBranch: args.targetBranch ?? deps.targetBranch ?? 'main',
      title: args.title, description: args.description }),
  },
  'gitlab.updateMr': {
    name: 'gitlab_update_mr',
    description: 'Changes the title or description of this job\'s merge request.',
    args: z.object({ project: Project, mrIid: MrIid, title: Text.optional(), description: z.string().optional() }).strict(),
    payload: (args: { project?: string; mrIid: number; title?: string; description?: string }, scope) => {
      const project = gitlabProject(args.project, scope)
      return { project, mrIid: boundMr(project, args.mrIid, scope), ...args.title !== undefined ? { title: args.title } : {},
        ...args.description !== undefined ? { description: args.description } : {} }
    },
  },
  'gitlab.reply': {
    name: 'gitlab_reply_discussion',
    description: 'Replies on this job\'s merge request, in a discussion when one is named.',
    args: z.object({ project: Project, mrIid: MrIid, discussionId: Text.optional(), body: Text }).strict(),
    payload: (args: { project?: string; mrIid: number; discussionId?: string; body: string }, scope) => {
      const project = gitlabProject(args.project, scope)
      return { project, mrIid: boundMr(project, args.mrIid, scope), ...args.discussionId ? { discussionId: args.discussionId } : {}, body: args.body }
    },
  },
}

/** The scope of a job, read when a tool runs, so it reflects every write the job made so far. */
function scopeOf(deps: SafeOutputDeps, jobId: string): Scope {
  const { db, engine } = deps.workbench.kernel
  const state = engine.job(jobId)?.state ?? fail(`No job ${jobId}`)
  const created = db.all<{ channel: string | null }>(`SELECT json_extract(result, '$.ok.channelId') AS channel FROM effect WHERE job_id = ? AND kind = 'action'
    AND status = 'succeeded' AND json_extract(payload, '$.action') = 'mattermost.createChannel'`, jobId)
  return {
    jobId, state, bound: new Set(state.bindings.map(binding => binding.threadKey)), repository: deps.repository(jobId),
    createdChannels: new Set(created.flatMap(row => row.channel ? [row.channel] : [])),
    branchOwner: branch => db.get<{ job_id: string }>(`SELECT job_id FROM effect WHERE kind = 'action' AND status <> 'cancelled'
      AND (json_extract(payload, '$.payload.branch') = ? OR json_extract(payload, '$.payload.sourceBranch') = ?) ORDER BY seq LIMIT 1`, branch, branch)?.job_id,
  }
}

/** The safe-output tools an attempt's stage may use, by its capabilities in the job's manifest. */
export function safeOutputTools(deps: SafeOutputDeps): (attempt: AttemptPayload, sessionId: string) => StageTool[] {
  return (attempt, sessionId) => {
    const capabilities = deps.workbench.workflow(attempt.manifestId).extra.stages[attempt.stageId]?.tools ?? []
    return capabilities.flatMap(action => {
      const definition = TOOLS[action as ActionName]
      if (!definition) return []
      return [{
        name: definition.name,
        description: definition.description,
        parameters: toDshParameterSchema(definition.args),
        async execute(raw, call) {
          const args = definition.args.parse(raw) as never
          const payload = await definition.payload(args, scopeOf(deps, attempt.jobId), deps)
          const submitted = deps.workbench.action(attempt.jobId, attempt.attemptId, { session: sessionId, id: call.id }, action, payload)
          const { outcome } = submitted
          if (outcome.kind === 'rejected') throw new Error(outcome.reason)
          if (outcome.kind === 'faulted') throw new Error(`The job could not take the request: ${outcome.error}`)
          const effectId = outcome.effects[0] ?? fail('The job queued no write for this request')
          const result = await deps.workbench.kernel.effects.awaitResult(effectId, deps.awaitMs ?? 30_000)
          if ('fail' in result) throw new Error(result.fail)
          if ('ok' in result) return result.ok
          void deps.workbench.kernel.effects.awaitResult(effectId, 30 * 60_000).then(late => {
            if (!('pending' in late)) call.notify(`Your ${definition.name} request ${effectId} finished: ${JSON.stringify('ok' in late ? late.ok : { failed: late.fail })}`)
          })
          return { queued: true, effectId, note: 'The write is queued; its result will reach you as a message.' }
        },
      }]
    })
  }
}
