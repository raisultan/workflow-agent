/**
 * Effect handlers for external writes (`T9.2`): the domain's `post` (its own messages) and `action` (writes a stage requests
 * through its safe-output tools). Each write carries the effect's idempotency key where the source can hold it unseen (a
 * Mattermost post's `props`, an HTML comment in a GitLab note), so a write whose outcome is unknown is found again before it is
 * repeated; a Jira comment is found by its exact body, and a merge request by its source branch. Transitions, field updates,
 * pushes of a given commit and MR edits are idempotent by nature, and simply run again.
 *
 * A source's refusal (4xx) fails the write for good; a network error or 5xx leaves its outcome unknown, so the kernel reconciles.
 * A post returns the server's creation time, which gate admission compares with replies from the same source.
 */
import { z } from 'zod'
import type { ActionPayload, NoticePayload, PostPayload } from '../domain/job.ts'
import type { EffectHandler, EffectResult } from '../kernel/effects.ts'
import { GITLAB_MAX_CHARS, IM_MAX_CHARS, JIRA_MAX_CHARS } from '../infra/text.ts'
import { ConnectorHttpError } from '../sources/http-client.ts'
import type { GitLabConnector } from '../sources/gitlab.ts'
import type { JiraConnector } from '../sources/jira.ts'
import type { MattermostConnector } from '../sources/mattermost.ts'
import { hardBreaks, render, renderNotice, type Locale, type RenderContext } from './messages.ts'
import { parseThread, threadKey, type Thread } from './threads.ts'

export interface Connectors {
  readonly mattermost?: MattermostConnector | undefined
  readonly jira?: JiraConnector | undefined
  readonly gitlab?: GitLabConnector | undefined
}

export interface WriterDeps {
  /** The configured connectors; a write to a source without one fails. */
  connectors(): Connectors
  /** How to render a job's messages for a source. */
  renderContext(jobId: string, source: Thread['source']): RenderContext
  /** The job's worktree, for pushes. */
  worktree(jobId: string): string | undefined
  /** Who a job's question rounds are addressed to, as a mention (`D12`): its ticket's author, else its requester. */
  addressee?(jobId: string): Promise<string | undefined>
  /** The commit the job pushed last, named when a push is rejected as not a fast-forward. */
  lastPushed?(jobId: string): string | undefined
  /** Writes of each kind at once (default 4). */
  readonly limit?: number
}

/** The `props` field a Mattermost post carries its idempotency key in. */
export const MATTERMOST_KEY_PROP = 'workbench_key'
/** The hidden marker a GitLab note carries its idempotency key in. */
export const gitlabMarker = (key: string) => `<!-- workbench:${key} -->`

/** What a written message is: its id, the server's time, and its thread. */
export interface Written { readonly postId: string; readonly postedAt: number; readonly threadKey: string }

/** Runs a write; a source's refusal fails it, an unknown outcome is thrown for the kernel to reconcile, anything else fails. */
async function attempt(write: () => Promise<unknown>): Promise<EffectResult> {
  try {
    return { ok: await write() }
  } catch (error) {
    if (error instanceof ConnectorHttpError && !(error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500)) {
      return { fail: error.message }
    }
    if (error instanceof ConnectorHttpError) throw error
    return { fail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A push the remote rejected because the branch has commits the pushed one does not contain (eval `T13.4`: an agent amended a
 * commit it had pushed, could not fetch the branch, and blocked). History is never force-pushed, but the job's last pushed commit
 * is in its worktree: the error names it, so the agent can build on it.
 */
export function notFastForward(error: unknown, lastPushed: string | undefined): unknown {
  const message = error instanceof Error ? error.message : String(error)
  if (!/\[rejected\]|non-fast-forward|fetch first/u.test(message)) return error
  const base = lastPushed ? `The job last pushed ${lastPushed}, which is in the worktree; make your commit its descendant (for example \`git reset --soft ${lastPushed}\` and commit again, `
    + 'or merge it), then push again.' : 'Make your commit a descendant of the branch\'s current commit, then push again.'
  return new Error(`${message}\nThe branch has commits your commit does not contain, and branches are never force-pushed. ${base}`)
}

function need<T>(connector: T | undefined, source: string): T {
  if (!connector) throw new Error(`${source} is not configured`)
  return connector
}

/** Posts `text` to `thread`, keyed by `key`. */
async function postText(connectors: Connectors, thread: Thread, text: string, key: string, replyTo?: string): Promise<Written> {
  switch (thread.source) {
    case 'mattermost': {
      const post = await need(connectors.mattermost, 'Mattermost').createPost({ channelId: thread.channelId, message: text,
        ...thread.rootId ? { rootId: thread.rootId } : {}, props: { [MATTERMOST_KEY_PROP]: key } })
      return { postId: post.id, postedAt: post.createAt, threadKey: threadKey(thread) }
    }
    case 'jira': {
      const comment = await need(connectors.jira, 'Jira').postComment(thread.issueKey, text)
      return { postId: comment.id, postedAt: comment.created, threadKey: threadKey(thread) }
    }
    case 'gitlab': {
      // In the discussion it answers, when it answers one (trial 2026-11-14); else, or when GitLab refuses the discussion, a new note.
      const gitlab = need(connectors.gitlab, 'GitLab')
      const body = `${text}\n\n${gitlabMarker(key)}`
      const note = await (replyTo ? gitlab.createNote({ project: thread.project, mrIid: thread.mrIid, body, discussionId: replyTo }).catch((error: unknown) => {
        if (error instanceof ConnectorHttpError && (error.status === 400 || error.status === 403 || error.status === 404)) return undefined
        throw error
      }) : Promise.resolve(undefined)) ?? await gitlab.createNote({ project: thread.project, mrIid: thread.mrIid, body })
      return { postId: String(note.id), postedAt: note.createdAt, threadKey: threadKey(thread) }
    }
  }
}

/** Finds a post an earlier attempt made under `key`. */
async function findText(connectors: Connectors, thread: Thread, text: string, key: string): Promise<Written | undefined> {
  switch (thread.source) {
    case 'mattermost': {
      const post = await need(connectors.mattermost, 'Mattermost').findPostByProp({ channelId: thread.channelId,
        ...thread.rootId ? { rootId: thread.rootId } : {}, prop: MATTERMOST_KEY_PROP, value: key })
      return post && { postId: post.id, postedAt: post.createAt, threadKey: threadKey(thread) }
    }
    case 'jira': {
      const comment = await need(connectors.jira, 'Jira').findComment(thread.issueKey, text)
      return comment && { postId: comment.id, postedAt: comment.created, threadKey: threadKey(thread) }
    }
    case 'gitlab': {
      const note = await need(connectors.gitlab, 'GitLab').findNote({ project: thread.project, mrIid: thread.mrIid, marker: gitlabMarker(key) })
      return note && { postId: String(note.id), postedAt: note.createdAt, threadKey: threadKey(thread) }
    }
  }
}

/**
 * The handler of the domain's `post` effect: renders the message and posts it to its thread. Its result keeps the text as posted
 * (`text`, before a source's own conversion such as Jira markup), so what people saw stays readable when the wording or the job's
 * context (its last commit, say) changes later (2026-11-15). A post found again after an unknown outcome keeps the text rendered when
 * it was found, which Jira's exact-body match makes the same and which a Mattermost or GitLab post's key does not check.
 */
export function postHandler(deps: WriterDeps): EffectHandler<PostPayload> {
  const text = async (payload: PostPayload, thread: Thread) => {
    const context = deps.renderContext(payload.jobId, thread.source)
    const addressee = payload.message.kind === 'question' ? await deps.addressee?.(payload.jobId) : undefined
    return render(payload.message, addressee ? { ...context, addressee } : context)
  }
  return {
    idempotent: false,
    limit: () => deps.limit ?? 4,
    run: (payload, key) => attempt(async () => {
      const thread = parseThread(payload.threadKey)
      const body = await text(payload, thread)
      return { ...await postText(deps.connectors(), thread, body, key, payload.replyTo), text: body }
    }),
    async reconcile(payload, key) {
      const thread = parseThread(payload.threadKey)
      const body = await text(payload, thread)
      const found = await findText(deps.connectors(), thread, body, key)
      return found ? { found: { ...found, text: body } } : { absent: true }
    },
  }
}

/** The handler of the job-less `notice` effect (`T11.1`): a reply to a trigger that started no job, posted once per event. */
export function noticeHandler(deps: { connectors(): Connectors; locale: Locale; limit?: number; bot?(): string | undefined }): EffectHandler<NoticePayload> {
  const text = (payload: NoticePayload, thread: Thread) => renderNotice(payload.notice, deps.locale, maxCharsOf(thread), deps.bot?.())
  return {
    idempotent: false,
    limit: () => deps.limit ?? 2,
    run: (payload, key) => attempt(() => { const thread = parseThread(payload.threadKey); return postText(deps.connectors(), thread, text(payload, thread), key) }),
    async reconcile(payload, key) {
      const thread = parseThread(payload.threadKey)
      const found = await findText(deps.connectors(), thread, text(payload, thread), key)
      return found ? { found } : { absent: true }
    },
  }
}

const maxCharsOf = (thread: Thread) => thread.source === 'mattermost' ? IM_MAX_CHARS : thread.source === 'jira' ? JIRA_MAX_CHARS : GITLAB_MAX_CHARS

const Text = z.string().min(1)
/** The safe-output actions and their requests; a stage's `tools` names the ones it may use. */
export const ACTIONS = {
  'mattermost.post': z.object({ thread: Text, text: Text }).strict(),
  'mattermost.createChannel': z.object({ name: Text, displayName: Text, purpose: z.string().optional(), invite: z.array(Text).default([]) }).strict(),
  'jira.link': z.object({ issueKey: Text }).strict(),
  'jira.comment': z.object({ issueKey: Text, body: Text }).strict(),
  'jira.transition': z.object({ issueKey: Text, transition: Text }).strict(),
  'jira.updateFields': z.object({ issueKey: Text, fields: z.record(z.string(), z.unknown()) }).strict(),
  'gitlab.push': z.object({ project: Text, branch: Text, sha: z.string().regex(/^[0-9a-f]{40}$/u) }).strict(),
  'gitlab.createMr': z.object({ project: Text, sourceBranch: Text, targetBranch: Text, title: Text, description: z.string() }).strict(),
  'gitlab.updateMr': z.object({ project: Text, mrIid: z.number().int().positive(), title: Text.optional(), description: z.string().optional() }).strict(),
  'gitlab.reply': z.object({ project: Text, mrIid: z.number().int().positive(), discussionId: Text.optional(), body: Text }).strict(),
} as const
export type ActionName = keyof typeof ACTIONS
export type ActionRequest<A extends ActionName> = z.output<(typeof ACTIONS)[A]>

/** The handler of the domain's `action` effect: performs a safe-output write by its action name. */
export function actionHandler(deps: WriterDeps): EffectHandler<ActionPayload> {
  const parse = (payload: ActionPayload) => {
    const schema = (ACTIONS as Record<string, z.ZodType>)[payload.action]
    if (!schema) throw new Error(`Unknown action ${payload.action}`)
    return schema.parse(payload.payload) as never
  }
  const run = async (payload: ActionPayload, key: string): Promise<unknown> => {
    const connectors = deps.connectors()
    switch (payload.action as ActionName) {
      case 'mattermost.post': {
        const request: ActionRequest<'mattermost.post'> = parse(payload)
        const thread = parseThread(request.thread)
        const written = await postText(connectors, thread, request.text, key)
        // A new root post starts a thread the job follows; a reply goes to a thread it already knows.
        return thread.source === 'mattermost' && !thread.rootId
          ? { ...written, bind: threadKey({ source: 'mattermost', channelId: thread.channelId, rootId: written.postId }) } : written
      }
      case 'mattermost.createChannel': {
        const request: ActionRequest<'mattermost.createChannel'> = parse(payload)
        const mattermost = need(connectors.mattermost, 'Mattermost')
        const channel = await mattermost.ensurePublicChannel({ name: request.name, displayName: request.displayName,
          ...request.purpose ? { purpose: request.purpose } : {} })
        const users = request.invite.length > 0 ? await mattermost.usersByUsername(request.invite) : []
        await mattermost.addChannelMembers(channel.id, users.flatMap(user => user.id ? [user.id] : []))
        return { channelId: channel.id, name: channel.name, invited: users.map(user => user.username) }
      }
      case 'jira.link': {
        const request: ActionRequest<'jira.link'> = parse(payload)
        const issue = await need(connectors.jira, 'Jira').getIssue(request.issueKey)
        const issueKey = (issue.key || request.issueKey).trim().toUpperCase()
        return { issueKey, bind: threadKey({ source: 'jira', issueKey }) }
      }
      case 'jira.comment': {
        const request: ActionRequest<'jira.comment'> = parse(payload)
        return postText(connectors, { source: 'jira', issueKey: request.issueKey }, request.body, key)
      }
      case 'jira.transition': {
        const request: ActionRequest<'jira.transition'> = parse(payload)
        return need(connectors.jira, 'Jira').moveIssue(request.issueKey, request.transition)
      }
      case 'jira.updateFields': {
        const request: ActionRequest<'jira.updateFields'> = parse(payload)
        await need(connectors.jira, 'Jira').setFields(request.issueKey, request.fields)
        return { updated: true }
      }
      case 'gitlab.push': {
        const request: ActionRequest<'gitlab.push'> = parse(payload)
        const worktreeDir = deps.worktree(payload.jobId)
        if (!worktreeDir) throw new Error(`Job ${payload.jobId} has no worktree`)
        return await need(connectors.gitlab, 'GitLab').pushCommit({ worktreeDir, project: request.project, branch: request.branch, sha: request.sha })
          .catch(error => { throw notFastForward(error, deps.lastPushed?.(payload.jobId)) })
      }
      case 'gitlab.createMr': {
        const request: ActionRequest<'gitlab.createMr'> = parse(payload)
        const gitlab = need(connectors.gitlab, 'GitLab')
        const mr = await gitlab.openMergeRequest(request.project, request.sourceBranch) ?? await gitlab.openNewMergeRequest(request)
        return { mrIid: mr.iid, webUrl: mr.webUrl, bind: threadKey({ source: 'gitlab', project: request.project, mrIid: mr.iid }) }
      }
      case 'gitlab.updateMr': {
        const request: ActionRequest<'gitlab.updateMr'> = parse(payload)
        return need(connectors.gitlab, 'GitLab').editMergeRequest(request)
      }
      case 'gitlab.reply': {
        // The agent's reply, with its lines kept: GitLab would join lines a single newline separates (2026-11-15).
        const request: ActionRequest<'gitlab.reply'> = parse(payload)
        const note = await need(connectors.gitlab, 'GitLab').createNote({ project: request.project, mrIid: request.mrIid,
          body: `${hardBreaks(request.body)}\n\n${gitlabMarker(key)}`, ...request.discussionId ? { discussionId: request.discussionId } : {} })
        return { postId: String(note.id), postedAt: note.createdAt, threadKey: threadKey({ source: 'gitlab', project: request.project, mrIid: request.mrIid }) }
      }
      default: throw new Error(`Unknown action ${payload.action}`)
    }
  }
  return {
    idempotent: false,
    limit: () => deps.limit ?? 4,
    run: (payload, key) => attempt(() => run(payload, key)),
    async reconcile(payload, key) {
      const connectors = deps.connectors()
      switch (payload.action as ActionName) {
        case 'mattermost.post': {
          const request: ActionRequest<'mattermost.post'> = parse(payload)
          const thread = parseThread(request.thread)
          const found = await findText(connectors, thread, request.text, key)
          if (!found) return { absent: true }
          return { found: thread.source === 'mattermost' && !thread.rootId
            ? { ...found, bind: threadKey({ source: 'mattermost', channelId: thread.channelId, rootId: found.postId }) } : found }
        }
        case 'jira.comment': {
          const request: ActionRequest<'jira.comment'> = parse(payload)
          const found = await findText(connectors, { source: 'jira', issueKey: request.issueKey }, request.body, key)
          return found ? { found } : { absent: true }
        }
        case 'gitlab.reply': {
          const request: ActionRequest<'gitlab.reply'> = parse(payload)
          const found = await findText(connectors, { source: 'gitlab', project: request.project, mrIid: request.mrIid }, request.body, key)
          return found ? { found } : { absent: true }
        }
        case 'gitlab.createMr': {
          const request: ActionRequest<'gitlab.createMr'> = parse(payload)
          const mr = await need(connectors.gitlab, 'GitLab').openMergeRequest(request.project, request.sourceBranch)
          return mr ? { found: { mrIid: mr.iid, webUrl: mr.webUrl, bind: threadKey({ source: 'gitlab', project: request.project, mrIid: mr.iid }) } } : { absent: true }
        }
        // The rest are idempotent: running them again is how they are reconciled.
        default: return { absent: true }
      }
    },
  }
}
