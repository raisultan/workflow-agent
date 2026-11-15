/**
 * Connector read tools (`T9.8`): what a stage session reads from Jira, Mattermost and GitLab, with host credentials that never
 * reach the session. Every stage gets them; reading changes nothing. The names are V1's, so prompts keep working. GitLab reads stay
 * within the job's repository. Binding a Jira issue to a job is a write of its own (`jira_link_issue`), not a side effect of reading.
 */
import { z } from 'zod'
import type { AttemptPayload } from '../domain/job.ts'
import { toDshParameterSchema } from '../tools/shared.ts'
import type { StageTool } from './stage-runner.ts'
import type { Connectors } from './writers.ts'

export interface ReadToolDeps {
  connectors(): Connectors
  /** The job's repository (GitLab project path). */
  repository(jobId: string): string | undefined
}

interface ReadTool { readonly name: string; readonly description: string; readonly args: z.ZodType; run(args: never, deps: ReadToolDeps, jobId: string): Promise<unknown> }

const IssueKey = z.object({ issue_key: z.string().min(1) }).strict()
const Mr = z.object({ project: z.string().min(1).optional(), mr_iid: z.number().int().positive() }).strict()
const jira = (deps: ReadToolDeps) => deps.connectors().jira ?? (() => { throw new Error('Jira is not configured') })()
const mattermost = (deps: ReadToolDeps) => deps.connectors().mattermost ?? (() => { throw new Error('Mattermost is not configured') })()
const gitlab = (deps: ReadToolDeps) => deps.connectors().gitlab ?? (() => { throw new Error('GitLab is not configured') })()
const ownProject = (deps: ReadToolDeps, jobId: string, requested?: string) => {
  const repository = deps.repository(jobId)
  const project = requested ?? repository
  if (!project || project !== repository) throw new Error(`GitLab reads are limited to this job's repository (${repository ?? 'none'})`)
  return project
}

const TOOLS: readonly ReadTool[] = [
  { name: 'jira_get_issue', description: 'Read a Jira issue with its summary, description, comments, status, parent, epic, links and attachments.',
    args: IssueKey, run: (args: { issue_key: string }, deps) => jira(deps).getIssue(args.issue_key) },
  { name: 'jira_get_issue_links', description: 'Read the issue links, parent and sub-tasks, and remote links of a Jira issue.',
    args: IssueKey, run: async (args: { issue_key: string }, deps) => {
      const issue = await jira(deps).getIssue(args.issue_key)
      return { key: issue.key, ...issue.parent ? { parent: issue.parent } : {}, ...issue.epic ? { epic: issue.epic } : {}, subtasks: issue.subtasks,
        issueLinks: issue.issueLinks, remoteLinks: issue.remoteLinks }
    } },
  { name: 'jira_get_epic_context', description: 'Read a Jira issue\'s epic and its sibling issues.',
    args: IssueKey, run: async (args: { issue_key: string }, deps) => {
      const issue = await jira(deps).getIssue(args.issue_key)
      const siblings = issue.epic ? await jira(deps).searchIssues({ jql: `"Epic Link" = ${issue.epic.key}` }) : { issues: [] }
      return { key: issue.key, ...issue.epic ? { epic: issue.epic } : {}, siblings: siblings.issues }
    } },
  { name: 'jira_get_attachments', description: 'List a Jira issue\'s attachments (whether each is readable as text) and remote links.',
    args: IssueKey, run: async (args: { issue_key: string }, deps) => {
      const issue = await jira(deps).getIssue(args.issue_key)
      return { key: issue.key, attachments: issue.attachments, remoteLinks: issue.remoteLinks }
    } },
  { name: 'jira_read_attachment_text', description: 'Read a text or log attachment of a Jira issue (up to 512 KB); binary files are refused.',
    args: z.object({ issue_key: z.string().min(1), attachment_id: z.string().min(1) }).strict(),
    run: async (args: { issue_key: string; attachment_id: string }, deps) => {
      const issue = await jira(deps).getIssue(args.issue_key)
      const attachment = issue.attachments.find(item => item.id === args.attachment_id)
      if (!attachment) throw new Error(`Attachment ${args.attachment_id} is not on ${args.issue_key}`)
      return jira(deps).readTextAttachment({ issueKey: args.issue_key, attachmentId: attachment.id, filename: attachment.filename,
        contentUrl: attachment.contentUrl, mimeType: attachment.mimeType, size: attachment.size })
    } },
  { name: 'jira_search_issues', description: 'Search Jira issues with a bounded JQL query.',
    args: z.object({ jql: z.string().min(1), max_results: z.number().int().min(1).max(50).optional() }).strict(),
    run: (args: { jql: string; max_results?: number }, deps) => jira(deps).searchIssues({ jql: args.jql, ...args.max_results ? { maxResults: args.max_results } : {} }) },
  { name: 'mattermost_get_thread', description: 'Read a Mattermost thread: its root post and replies, oldest first.',
    args: z.object({ post_id: z.string().min(1) }).strict(), run: (args: { post_id: string }, deps) => mattermost(deps).readThread({ postId: args.post_id }) },
  { name: 'mattermost_resolve_users', description: 'Find Mattermost users by username or email, to mention them as @username.',
    args: z.object({ identifiers: z.array(z.string().min(1)).min(1) }).strict(),
    run: async (args: { identifiers: string[] }, deps) => ({ users: await mattermost(deps).resolveUsers(args.identifiers) }) },
  { name: 'gitlab_get_mr', description: 'Read a merge request of the job\'s repository: branches, merge status and latest pipeline.',
    args: Mr, run: (args: { project?: string; mr_iid: number }, deps, jobId) => gitlab(deps).getMergeRequest({ project: ownProject(deps, jobId, args.project), mrIid: args.mr_iid }) },
  { name: 'gitlab_list_discussions', description: 'List the review discussions and notes of a merge request of the job\'s repository.',
    args: Mr, run: (args: { project?: string; mr_iid: number }, deps, jobId) => gitlab(deps).listDiscussions({ project: ownProject(deps, jobId, args.project), mrIid: args.mr_iid }) },
]

/** The read tools of an attempt's session. */
export function readTools(deps: ReadToolDeps): (attempt: AttemptPayload) => StageTool[] {
  return attempt => TOOLS.map(tool => ({
    name: tool.name, description: tool.description, parameters: toDshParameterSchema(tool.args),
    execute: async raw => tool.run(tool.args.parse(raw) as never, deps, attempt.jobId),
  }))
}

