/**
 * Jira outbound-polling connector and deep context-gathering / mutation tools (`F2`, `F8`, `D5`, `D7`):
 * - Supports both HTTP Basic (`username` + `password`) and Bearer Personal Access Token (`token`) authentication.
 * - Outbound cursor-based JQL polling with bot-self-loop suppression.
 * - `jira_get_issue`: returns issue details, comments, parent **Epic**, subtasks, `issuelinks` (`blocks`, `relates to`, etc.),
 *   remote/web links (`/remotelink` — Confluence, specs, external URLs), and attachment metadata.
 * - `jira_read_attachment_text`: authenticated fetch of plain-text/log/config attachments (`.log`, `.txt`, `.json`, `.yaml`, `.csv`, `.md`, `.sql`, `.xml`, `.diff`);
 *   rejects binary/image attachments.
 * - `jira_search_issues`: bounded JQL search for connected Epics and tasks.
 * - `jira_add_comment`, `jira_transition_issue`, `jira_update_fields`: mutations the writers (`adapters/writers.ts`) make idempotent.
 */
import type { Context } from '@deepseek-ai/cordis'
import { extname } from 'node:path'
import { z } from 'zod'
import { toJiraMarkup } from '../infra/jira-markup.ts'
import { JIRA_MAX_CHARS, checkedConnectorText } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { fetchWithRetry } from './http-client.ts'
import { health, sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'
import type { Trigger } from './types.ts'

/** Authentication configuration for Jira (`F2`, `G4`). */
export type JiraAuthConfig =
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'bearer'; token: string }

/** Configuration for the Jira connector. */
export interface JiraConfig {
  baseUrl: string
  auth: JiraAuthConfig
  botUsername?: string
  botAccountId?: string
  jql?: string
  fetchImpl?: typeof fetch
  maxRetries?: number
  baseBackoffMs?: number
}

/** Durable polling cursor state for Jira (`A4`, `A8`). */
export interface JiraCursorState {
  lastUpdatedIso?: string
  seenEventIds: string[]
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.log',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.md',
  '.sql',
  '.xml',
  '.diff',
  '.patch',
  '.conf',
  '.ini',
  '.toml',
  '.out',
  '.err',
])

const TEXT_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/sql',
]

/** Default maximum size in bytes for `jira_read_attachment_text` (256 KiB). */
export const JIRA_MAX_ATTACHMENT_BYTES = 256 * 1024

/** Returns whether a Jira attachment is eligible for plain-text/log inspection via `jira_read_attachment_text` (`D5`, `D7`). */
export function isReadableTextAttachment(filename: string, mimeType?: string): boolean {
  const ext = extname(filename.toLowerCase())
  if (TEXT_ATTACHMENT_EXTENSIONS.has(ext)) return true
  if (mimeType) {
    const lowerMime = mimeType.toLowerCase()
    if (TEXT_MIME_PREFIXES.some(prefix => lowerMime.startsWith(prefix))) {
      return true
    }
  }
  return false
}

/** Structured representation of a Jira issue with full connected context (`D5`, `D7`). */
export interface JiraIssueContext {
  key: string
  summary: string
  description: string
  status: string
  issueType: string
  priority?: string
  labels: string[]
  assignee?: string
  reporter?: string
  /** The reporter's email, when Jira shows it (`D12`: the ticket's author is matched to their Mattermost user by email). */
  reporterEmail?: string
  epic?: {
    key: string
    summary?: string
    status?: string
  }
  parent?: {
    key: string
    summary?: string
    status?: string
  }
  subtasks: {
    key: string
    summary: string
    status: string
  }[]
  issueLinks: {
    id: string
    type: string
    direction: 'inward' | 'outward'
    relationship: string
    targetKey: string
    targetSummary: string
    targetStatus?: string
  }[]
  remoteLinks: {
    id: string
    title: string
    url: string
    relationship?: string
  }[]
  comments: {
    id: string
    author: string
    body: string
    created: string
  }[]
  attachments: {
    id: string
    filename: string
    mimeType: string
    size: number
    contentUrl: string
    readableAsText: boolean
  }[]
}

/**
 * How far before the cursor each poll starts reading: an update stamped just before the cursor is not missed, and neither is one
 * hidden by a few minutes of skew between this host's clock (which measures the window) and Jira's (which stamps the cursor).
 * Events read twice are skipped by id.
 */
const POLL_OVERLAP_MS = 5 * 60_000

/**
 * Builds the Jira polling JQL from `baseJql` and `cursor.lastUpdatedIso`.
 * When `lastUpdatedIso` is present, replaces any fixed relative `updated >= -...` window with `updated >= -<N>m`, the minutes
 * since the cursor plus the overlap, so events during an outage longer than the base window are not lost. The window is relative
 * because Jira reads a date literal such as `"2026-11-11 10:00"` in the polling account's time zone: written in UTC, it would
 * start hours late for an account west of UTC and miss updates for good.
 */
export function buildJiraPollJql(baseJql: string | undefined, lastUpdatedIso?: string, nowMs = Date.now()): string {
  const raw = (baseJql ?? 'ORDER BY updated ASC').trim()
  if (!lastUpdatedIso) return raw || 'ORDER BY updated ASC'
  const cursorMs = Date.parse(lastUpdatedIso)
  if (!Number.isFinite(cursorMs)) return raw || 'ORDER BY updated ASC'

  const minutes = Math.max(1, Math.ceil((nowMs - cursorMs + POLL_OVERLAP_MS) / 60_000))
  const updatedClause = `updated >= -${minutes}m`

  const orderMatch = /\bORDER\s+BY\b/iu.exec(raw)
  const wherePart = (orderMatch ? raw.slice(0, orderMatch.index) : raw).trim()
  const orderPart = (orderMatch ? raw.slice(orderMatch.index) : 'ORDER BY updated ASC').trim()

  const relativeUpdatedRe = /\bupdated\s*>=\s*(?:-[0-9]+[a-zA-Z]+|"-[0-9]+[a-zA-Z]+"|'-[0-9]+[a-zA-Z]+')/giu
  if (relativeUpdatedRe.test(wherePart)) {
    const replaced = wherePart.replace(relativeUpdatedRe, updatedClause).trim()
    return `${replaced} ${orderPart}`.trim()
  }
  if (!wherePart) {
    return `${updatedClause} ${orderPart}`.trim()
  }
  return `(${wherePart}) AND ${updatedClause} ${orderPart}`.trim()
}

/**
 * Outbound-polling Jira connector and host-brokered tool provider (`D5`, `D7`).
 */
export class JiraConnector {
  private readonly baseUrl: string
  private readonly config: JiraConfig
  /**
   * The workbench's own comments (`A8`), by key (`${issueKey}#${commentId}`): those this connector posted or found, and those the
   * runtime recorded before it was made. A comment's author cannot tell them apart when the workbench uses a person's account.
   */
  private readonly own = new Set<string>()
  /** Comments being posted, by issue and exact body: a poll can see one before its id is known. */
  private readonly posting = new Map<string, number>()

  constructor(config: JiraConfig) {
    this.config = config
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
  }

  /** Builds the HTTP `Authorization` header for Basic or Bearer PAT auth (`G4`). */
  authHeader(): string {
    if (this.config.auth.kind === 'basic') {
      const encoded = Buffer.from(`${this.config.auth.username}:${this.config.auth.password}`, 'utf8').toString('base64')
      return `Basic ${encoded}`
    }
    return `Bearer ${this.config.auth.token}`
  }

  private secrets(): string[] {
    if (this.config.auth.kind === 'basic') {
      const encoded = Buffer.from(`${this.config.auth.username}:${this.config.auth.password}`, 'utf8').toString('base64')
      return [this.config.auth.password, encoded]
    }
    return [this.config.auth.token]
  }

  private headers(): Record<string, string> {
    return {
      Authorization: this.authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private async requestJson<T>(pathOrUrl: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`
    const response = await fetchWithRetry({
      connector: 'jira',
      url,
      method: init?.method ?? 'GET',
      headers: this.headers(),
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      secretsToRedact: this.secrets(),
      fetchImpl: this.config.fetchImpl,
      maxRetries: this.config.maxRetries,
      baseBackoffMs: this.config.baseBackoffMs,
    })
    if (response.status === 204) return {} as T
    return await response.json() as T
  }

  /**
   * Whether `text` mentions the bot (`@name`, `[~name]` or `[~accountid:id]`). Only a mention starts a job: a new issue, or one
   * that enters the polling filter, is not a request by itself. Without a known bot identity nothing counts as a mention.
   */
  private mentionsBot(text: string): boolean {
    const { botUsername, botAccountId } = this.config
    return Boolean((botUsername && (text.includes(`@${botUsername}`) || text.includes(`[~${botUsername}]`)))
      || (botAccountId && text.includes(`[~accountid:${botAccountId}]`)))
  }

  private isBotAuthor(author?: { name?: string; accountId?: string; displayName?: string }): boolean {
    if (!author) return false
    if (this.config.botUsername && author.name === this.config.botUsername) return true
    if (this.config.botAccountId && author.accountId === this.config.botAccountId) return true
    return false
  }

  /**
   * Polls Jira via `/rest/api/2/search` for newly created or commented issues since `cursor`,
   * suppressing the bot's own comments/updates and returning normalized `Trigger` events (`F2`, `A8`).
   */
  async poll(
    cursor: JiraCursorState = { seenEventIds: [] },
    selfAuthoredCommentKeys?: ReadonlySet<string>,
  ): Promise<{
    triggers: Trigger[]
    nextCursor: JiraCursorState
  }> {
    const jql = buildJiraPollJql(this.config.jql, cursor.lastUpdatedIso)
    const pageSize = 50
    const maxPages = 20
    const allIssues: {
      id: string
      key: string
      fields: Record<string, unknown>
    }[] = []
    let startAt = 0

    for (let page = 0; page < maxPages; page++) {
      const searchPayload = await this.requestJson<{
        issues?: {
          id: string
          key: string
          fields: Record<string, unknown>
        }[]
        total?: number
      }>(`/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${pageSize}&startAt=${startAt}`)

      const pageIssues = searchPayload.issues ?? []
      if (pageIssues.length === 0) break
      allIssues.push(...pageIssues)
      startAt += pageIssues.length

      if (typeof searchPayload.total === 'number' && startAt >= searchPayload.total) break
      if (typeof searchPayload.total !== 'number' && pageIssues.length < pageSize) break
    }

    const seen = new Set(cursor.seenEventIds)
    let latestUpdated = cursor.lastUpdatedIso
    // An issue or comment created before the read window was read by an earlier poll, or predates the first start (`A17`): when
    // an old issue is edited, its old comments are not delivered again, even once their ids have left `seenEventIds`.
    const windowStart = cursor.lastUpdatedIso ? Date.parse(cursor.lastUpdatedIso) - POLL_OVERLAP_MS : Number.NaN
    const predates = (created: unknown) => typeof created === 'string' && Date.parse(created) < windowStart
    const triggers: Trigger[] = []

    for (const issue of allIssues) {
      const fields = issue.fields ?? {}
      const updated = typeof fields.updated === 'string' ? fields.updated : new Date().toISOString()
      // Compared as instants: Jira writes its account's offset (`+0500`), the first-start cursor is UTC (`Z`).
      if (!latestUpdated || !(Date.parse(latestUpdated) >= Date.parse(updated))) {
        latestUpdated = updated
      }

      const summary = typeof fields.summary === 'string' ? fields.summary : issue.key
      const description = typeof fields.description === 'string' ? fields.description : ''
      const reporter = fields.reporter as { name?: string; accountId?: string } | undefined

      const commentContainer = fields.comment as {
        comments?: {
          id: string
          body: string
          created: string
          author?: { name?: string; accountId?: string; displayName?: string }
        }[]
      } | undefined
      const comments = commentContainer?.comments ?? []

      if (comments.length === 0) {
        const issueEventId = `jira_issue_${issue.key}`
        if (!seen.has(issueEventId) && !this.isBotAuthor(reporter)) {
          seen.add(issueEventId)
          if (predates(fields.created)) continue
          const actorId = reporter?.name ?? reporter?.accountId ?? 'jira-user'
          triggers.push({
            id: issueEventId,
            source: 'jira',
            threads: [{ source: 'jira', id: issue.key }],
            actor: { source: 'jira', id: actorId },
            human: true,
            ...(this.mentionsBot(`${summary}\n${description}`) ? { addressed: 'mention' as const } : {}),
            at: new Date(updated).toISOString(),
            text: `${issue.key}: ${summary}\n\n${description}`.trim(),
            channel: {
              source: 'jira',
              thread: issue.key,
              address: { issueKey: issue.key },
            },
            meta: {
              issueKey: issue.key,
              summary,
              ...fields.created ? { createdAt: fields.created } : {},
            },
          })
        }
        continue
      }

      for (const comment of comments) {
        const commentEventId = `jira_comment_${issue.key}_${comment.id}`
        if (seen.has(commentEventId)) continue
        seen.add(commentEventId)
        if (predates(comment.created)) continue

        // Bot self-loop suppression (`A8`): its own comments by id or in-flight body, as on a person's account its author is that
        // person; then the bot's author name.
        const commentKey = `${issue.key}#${comment.id}`
        if (selfAuthoredCommentKeys?.has(commentKey) || this.isOwn(issue.key, String(comment.id), comment.body)) continue
        if (this.isBotAuthor(comment.author)) continue

        const actorId = comment.author?.name ?? comment.author?.accountId ?? 'jira-user'
        const mentioned = this.mentionsBot(comment.body)

        triggers.push({
          id: commentEventId,
          source: 'jira',
          threads: [{ source: 'jira', id: issue.key }],
          actor: { source: 'jira', id: actorId },
          human: true,
          ...(mentioned ? { addressed: 'mention' as const } : {}),
          at: new Date(comment.created || updated).toISOString(),
          text: comment.body,
          channel: {
            source: 'jira',
            thread: issue.key,
            address: { issueKey: issue.key, commentId: comment.id },
          },
          meta: {
            issueKey: issue.key,
            commentId: comment.id,
            summary,
          },
        })
      }
    }

    return {
      triggers,
      nextCursor: {
        ...(latestUpdated ? { lastUpdatedIso: latestUpdated } : {}),
        seenEventIds: [...seen].slice(-2000),
      },
    }
  }

  /**
   * Host-brokered `jira_get_issue` tool (`D5`, `D7`):
   * Gathers full issue context including comments, parent **Epic**, subtasks, `issuelinks` (`blocks`, `relates to`, etc.),
   * remote/web links (`/remotelink` — Confluence, specs, external URLs), and attachment metadata.
   */
  async getIssue(issueKey: string): Promise<JiraIssueContext> {
    const raw = await this.requestJson<{
      key: string
      fields: Record<string, unknown>
    }>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`)

    let rawRemoteLinks: {
      id?: number | string
      relationship?: string
      object?: { url?: string; title?: string }
    }[] = []
    try {
      rawRemoteLinks = await this.requestJson(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/remotelink`)
    } catch {
      rawRemoteLinks = []
    }

    const f = raw.fields ?? {}
    const statusObj = f.status as { name?: string } | undefined
    const typeObj = f.issuetype as { name?: string } | undefined
    const priorityObj = f.priority as { name?: string } | undefined
    const assigneeObj = f.assignee as { name?: string; displayName?: string } | undefined
    const reporterObj = f.reporter as { name?: string; displayName?: string; emailAddress?: string } | undefined

    // Extract parent Epic or parent issue (`fields.epic`, `customfield_10014`, or `fields.parent`).
    let epic: JiraIssueContext['epic']
    let parent: JiraIssueContext['parent']
    const epicField = f.epic as { key?: string; name?: string; summary?: string; status?: { name?: string } } | undefined
    const customEpicKey = typeof f.customfield_10014 === 'string' ? f.customfield_10014 : undefined
    const parentField = f.parent as {
      key?: string
      fields?: { summary?: string; status?: { name?: string }; issuetype?: { name?: string } }
    } | undefined

    if (epicField?.key) {
      const summary = epicField.summary ?? epicField.name
      const status = epicField.status?.name
      epic = {
        key: epicField.key,
        ...(summary ? { summary } : {}),
        ...(status ? { status } : {}),
      }
    } else if (customEpicKey) {
      epic = { key: customEpicKey }
    }

    if (parentField?.key) {
      const parentSummary = parentField.fields?.summary
      const parentStatus = parentField.fields?.status?.name
      const parentType = parentField.fields?.issuetype?.name?.toLowerCase() ?? ''
      parent = {
        key: parentField.key,
        ...(parentSummary ? { summary: parentSummary } : {}),
        ...(parentStatus ? { status: parentStatus } : {}),
      }
      if (!epic && parentType.includes('epic')) {
        epic = { ...parent }
      }
    }

    const rawSubtasks = (f.subtasks as {
      key: string
      fields?: { summary?: string; status?: { name?: string } }
    }[] | undefined) ?? []
    const subtasks = rawSubtasks.map(st => ({
      key: st.key,
      summary: st.fields?.summary ?? '',
      status: st.fields?.status?.name ?? 'Unknown',
    }))

    const rawLinks = (f.issuelinks as {
      id?: string
      type?: { name?: string; inward?: string; outward?: string }
      inwardIssue?: { key: string; fields?: { summary?: string; status?: { name?: string } } }
      outwardIssue?: { key: string; fields?: { summary?: string; status?: { name?: string } } }
    }[] | undefined) ?? []

    const issueLinks: JiraIssueContext['issueLinks'] = []
    for (const link of rawLinks) {
      if (link.outwardIssue) {
        issueLinks.push({
          id: String(link.id ?? `${issueKey}->${link.outwardIssue.key}`),
          type: link.type?.name ?? 'Link',
          direction: 'outward',
          relationship: link.type?.outward ?? 'relates to',
          targetKey: link.outwardIssue.key,
          targetSummary: link.outwardIssue.fields?.summary ?? '',
          ...(link.outwardIssue.fields?.status?.name ? { targetStatus: link.outwardIssue.fields.status.name } : {}),
        })
      }
      if (link.inwardIssue) {
        issueLinks.push({
          id: String(link.id ?? `${link.inwardIssue.key}->${issueKey}`),
          type: link.type?.name ?? 'Link',
          direction: 'inward',
          relationship: link.type?.inward ?? 'is related to',
          targetKey: link.inwardIssue.key,
          targetSummary: link.inwardIssue.fields?.summary ?? '',
          ...(link.inwardIssue.fields?.status?.name ? { targetStatus: link.inwardIssue.fields.status.name } : {}),
        })
      }
    }

    const remoteLinks: JiraIssueContext['remoteLinks'] = (Array.isArray(rawRemoteLinks) ? rawRemoteLinks : [])
      .filter(rl => rl.object?.url)
      .map(rl => ({
        id: String(rl.id ?? rl.object!.url!),
        title: rl.object?.title ?? rl.object!.url!,
        url: rl.object!.url!,
        ...(rl.relationship ? { relationship: rl.relationship } : {}),
      }))

    const rawComments = ((f.comment as { comments?: { id: string; author?: { name?: string; displayName?: string }; body?: string; created?: string }[] } | undefined)?.comments) ?? []
    const comments = rawComments.map(c => ({
      id: String(c.id),
      author: c.author?.name ?? c.author?.displayName ?? 'unknown',
      body: c.body ?? '',
      created: c.created ?? '',
    }))

    const rawAttachments = (f.attachment as {
      id: string
      filename: string
      mimeType?: string
      size?: number
      content?: string
    }[] | undefined) ?? []

    const attachments = rawAttachments.map(att => {
      const mimeType = att.mimeType ?? 'application/octet-stream'
      return {
        id: String(att.id),
        filename: att.filename,
        mimeType,
        size: att.size ?? 0,
        contentUrl: att.content ?? `${this.baseUrl}/secure/attachment/${att.id}/${encodeURIComponent(att.filename)}`,
        readableAsText: isReadableTextAttachment(att.filename, mimeType),
      }
    })

    return {
      key: raw.key,
      summary: typeof f.summary === 'string' ? f.summary : '',
      description: typeof f.description === 'string' ? f.description : '',
      status: statusObj?.name ?? 'Unknown',
      issueType: typeObj?.name ?? 'Task',
      ...(priorityObj?.name ? { priority: priorityObj.name } : {}),
      labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
      ...(assigneeObj ? { assignee: assigneeObj.name ?? assigneeObj.displayName } : {}),
      ...(reporterObj ? { reporter: reporterObj.name ?? reporterObj.displayName } : {}),
      ...(reporterObj?.emailAddress ? { reporterEmail: reporterObj.emailAddress } : {}),
      ...(epic ? { epic } : {}),
      ...(parent ? { parent } : {}),
      subtasks,
      issueLinks,
      remoteLinks,
      comments,
      attachments,
    }
  }

  /**
   * Host-brokered `jira_read_attachment_text` tool (`D5`, `D7`):
   * Fetches plain-text/log/config attachments (`.log`, `.txt`, `.json`, `.yaml`, `.csv`, `.md`, `.sql`, `.xml`, `.diff`)
   * using the host's Jira credentials up to `maxBytes` (default 256 KiB).
   * Rejects binary/image files.
   */
  async readTextAttachment(params: {
    issueKey: string
    attachmentId: string
    filename: string
    contentUrl: string
    mimeType?: string
    size?: number
    maxBytes?: number
  }): Promise<{
    issueKey: string
    attachmentId: string
    filename: string
    content: string
    truncated: boolean
  }> {
    if (!isReadableTextAttachment(params.filename, params.mimeType)) {
      throw new Error(
        `Binary or image attachment "${params.filename}" (${params.mimeType ?? 'unknown'}) is not supported by jira_read_attachment_text; only plain-text/log/config files are supported`,
      )
    }

    const maxBytes = params.maxBytes ?? JIRA_MAX_ATTACHMENT_BYTES
    if (params.size !== undefined && params.size > maxBytes * 4) {
      throw new Error(`Attachment "${params.filename}" (${params.size} bytes) exceeds maximum allowed fetch size`)
    }

    const url = params.contentUrl.startsWith('http://') || params.contentUrl.startsWith('https://')
      ? params.contentUrl
      : `${this.baseUrl}${params.contentUrl}`

    const response = await fetchWithRetry({
      connector: 'jira',
      url,
      method: 'GET',
      headers: {
        Authorization: this.authHeader(),
        Accept: 'text/plain, application/json, */*',
      },
      secretsToRedact: this.secrets(),
      fetchImpl: this.config.fetchImpl,
      maxRetries: this.config.maxRetries,
      baseBackoffMs: this.config.baseBackoffMs,
    })

    const rawText = await response.text()
    const buf = Buffer.from(rawText, 'utf8')
    const truncated = buf.byteLength > maxBytes
    const content = truncated ? buf.subarray(0, maxBytes).toString('utf8') : rawText

    return {
      issueKey: params.issueKey,
      attachmentId: params.attachmentId,
      filename: params.filename,
      content,
      truncated,
    }
  }

  /**
   * Host-brokered `jira_search_issues` tool (`D5`):
   * Searches related Jira issues or Epics via bounded JQL.
   */
  async searchIssues(params: { jql: string; maxResults?: number }): Promise<{
    issues: { key: string; summary: string; status: string; issueType: string }[]
  }> {
    const limit = Math.min(Math.max(params.maxResults ?? 20, 1), 50)
    const payload = await this.requestJson<{
      issues: { key: string; fields?: Record<string, unknown> }[]
    }>(`/rest/api/2/search?jql=${encodeURIComponent(params.jql)}&maxResults=${limit}`)

    return {
      issues: (payload.issues ?? []).map(item => ({
        key: item.key,
        summary: typeof item.fields?.summary === 'string' ? item.fields.summary : '',
        status: (item.fields?.status as { name?: string } | undefined)?.name ?? 'Unknown',
        issueType: (item.fields?.issuetype as { name?: string } | undefined)?.name ?? 'Task',
      })),
    }
  }

  /**
   * The user whose email is `email` (`D12`), or `undefined`: Jira Server's user search matches an email, and a result that shows its
   * email must show this one. A request Jira cannot answer rejects, so a caller can retry.
   */
  async userByEmail(email: string): Promise<{ name: string } | undefined> {
    const users = await this.requestJson<{ name?: string; emailAddress?: string; active?: boolean }[]>(
      `/rest/api/2/user/search?username=${encodeURIComponent(email)}&maxResults=10`)
    const wanted = email.toLowerCase()
    const found = (Array.isArray(users) ? users : []).filter(user => user.name && user.active !== false
      && (user.emailAddress === undefined || user.emailAddress.toLowerCase() === wanted))
    // With emails hidden, Jira still matches on them; only an unambiguous result is taken.
    const exact = found.filter(user => user.emailAddress?.toLowerCase() === wanted)
    const user = exact.length === 1 ? exact[0] : exact.length === 0 && found.length === 1 ? found[0] : undefined
    return user?.name ? { name: user.name } : undefined
  }

  /** Records comments as the workbench's own (`${issueKey}#${commentId}`), so a poll skips them. */
  recordOwn(keys: Iterable<string>): void {
    for (const key of keys) this.own.add(key)
  }

  /** Whether a comment is the workbench's own: posted or found by it, or still being posted with exactly this body. */
  private isOwn(issueKey: string, commentId: string, body: string): boolean {
    return this.own.has(`${issueKey}#${commentId}`) || this.posting.has(`${issueKey}\n${body}`)
  }

  /** The account the connector logs in as: its name on Jira Server, its account id on Jira Cloud. */
  async myself(): Promise<{ name?: string; accountId?: string }> {
    const me = await this.requestJson<{ name?: string; accountId?: string }>('/rest/api/2/myself')
    return { ...me.name ? { name: me.name } : {}, ...me.accountId ? { accountId: me.accountId } : {} }
  }

  /** Posts a comment, written in Markdown and posted as Jira markup (`T14.6`); returns its id and the server's creation time (`T9.2`). */
  async postComment(issueKey: string, body: string): Promise<{ id: string; created: number }> {
    const markup = checkedConnectorText(toJiraMarkup(body), JIRA_MAX_CHARS, 'jira comment')
    const pending = `${issueKey}\n${markup}`
    this.posting.set(pending, (this.posting.get(pending) ?? 0) + 1)
    try {
      const created = await this.requestJson<{ id: string | number; created?: string }>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
        { method: 'POST', body: { body: markup } })
      this.own.add(`${issueKey}#${created.id}`)
      return { id: String(created.id), created: created.created ? Date.parse(created.created) : Date.now() }
    } finally {
      const left = (this.posting.get(pending) ?? 1) - 1
      if (left > 0) this.posting.set(pending, left)
      else this.posting.delete(pending)
    }
  }

  /** The latest comment on the issue with exactly `body`, if any (Jira comments have no field for a hidden key). */
  async findComment(issueKey: string, body: string): Promise<{ id: string; created: number } | undefined> {
    const { comments = [] } = await this.requestJson<{ comments?: { id: string | number; body?: string; created?: string }[] }>(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment?orderBy=-created&maxResults=100`)
    const markup = toJiraMarkup(body)
    const found = comments.find(comment => comment.body === markup)
    if (found) this.own.add(`${issueKey}#${found.id}`)
    return found && { id: String(found.id), created: found.created ? Date.parse(found.created) : 0 }
  }

  /** Moves the issue by a transition id or a transition or status name; an issue already in the named status is left as it is. */
  async moveIssue(issueKey: string, transition: string): Promise<{ moved: boolean }> {
    const resolved = await this.resolveTransition(issueKey, transition)
    if (resolved.kind === 'already') return { moved: false }
    await this.requestJson(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, { method: 'POST', body: { transition: { id: resolved.id } } })
    return { moved: true }
  }

  /** Sets fields on the issue; setting the same values again changes nothing. */
  async setFields(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    await this.requestJson(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, { method: 'PUT', body: { fields } })
  }



  /** Resolves a transition id or a transition or status name against the issue's available transitions. */
  private async resolveTransition(issueKey: string, idOrName: string): Promise<{ kind: 'id'; id: string } | { kind: 'already' }> {
    const wanted = idOrName.trim()
    if (/^\d+$/u.test(wanted)) return { kind: 'id', id: wanted }
    const lower = wanted.toLocaleLowerCase()
    const same = (name?: string): boolean => name?.trim().toLocaleLowerCase() === lower
    const key = encodeURIComponent(issueKey)
    const { transitions = [] } = await this.requestJson<{ transitions?: { id: string; name?: string; to?: { name?: string } }[] }>(
      `/rest/api/2/issue/${key}/transitions`)
    const ids = [...new Set(transitions.filter(item => same(item.name) || same(item.to?.name)).map(item => item.id))]
    if (ids.length === 1) return { kind: 'id', id: ids[0]! }
    if (ids.length > 1) throw new Error(`Jira transition "${wanted}" on ${issueKey} is ambiguous (ids ${ids.join(', ')}); pass the transition id`)
    const issue = await this.requestJson<{ fields?: { status?: { name?: string } } }>(`/rest/api/2/issue/${key}?fields=status`)
    if (same(issue.fields?.status?.name)) return { kind: 'already' }
    const available = transitions.map(item => `${item.id}: ${item.name ?? '?'} → ${item.to?.name ?? '?'}`).join('; ') || 'none'
    throw new Error(`Jira issue ${issueKey} has no transition or status named "${wanted}". Available transitions: ${available}`)
  }

}

/**
 * How the account Jira logs in as stands to the bot's identity (`A8`): `bot` when it is the bot (comments by it are skipped as the
 * workbench's own), `person` when it is someone else's (the workbench knows its comments by their ids), and `clash` when it is the
 * bot's and also a person the policy names, whose comments would then be skipped. `undefined` when Jira names no account.
 */
export function jiraAccount(me: { name?: string; accountId?: string }, bot: { botUsername?: string; botAccountId?: string },
  people: ReadonlySet<string>): 'bot' | 'person' | 'clash' | undefined {
  if (!me.name && !me.accountId) return undefined
  const isBot = (bot.botUsername !== undefined && me.name === bot.botUsername) || (bot.botAccountId !== undefined && me.accountId === bot.botAccountId)
  if (!isBot) return 'person'
  return [me.name, me.accountId].some(id => id !== undefined && people.has(id)) ? 'clash' : 'bot'
}

export const JiraSourceConfigSchema = z.object({
  baseUrl: z.string().default(''),
  jql: z.string().default('updated >= -1h ORDER BY updated ASC'),
  botUsername: z.string().default(''),
  botAccountId: z.string().default(''),
  pollSeconds: z.number().int().min(5).max(3600).default(60),
}).strict()

export type JiraSourceConfig = z.infer<typeof JiraSourceConfigSchema>

/**
 * Resolves Jira connector settings with explicit source config taking precedence over environment variables.
 */
export function resolveJiraConfig(
  cfg?: Partial<JiraSourceConfig>,
  env: NodeJS.ProcessEnv = process.env,
): {
  baseUrl: string
  auth?: JiraAuthConfig
  jql?: string
  botUsername?: string
  botAccountId?: string
  missing: string[]
} {
  const baseUrl = cfg?.baseUrl?.trim() || env.JIRA_BASE_URL?.trim() || ''
  const token = env.JIRA_TOKEN?.trim() || ''
  const username = env.JIRA_USERNAME?.trim() || ''
  const password = env.JIRA_PASSWORD?.trim() || ''
  const auth: JiraAuthConfig | undefined = token
    ? { kind: 'bearer', token }
    : username && password
      ? { kind: 'basic', username, password }
      : undefined
  const jql = cfg?.jql?.trim() || env.JIRA_JQL?.trim() || undefined
  const botUsername = cfg?.botUsername?.trim() || env.JIRA_BOT_USERNAME?.trim() || username || undefined
  const botAccountId = cfg?.botAccountId?.trim() || env.JIRA_BOT_ACCOUNT_ID?.trim() || undefined
  const missing: string[] = []
  if (!baseUrl) missing.push('baseUrl / JIRA_BASE_URL')
  if (!auth) missing.push('JIRA_TOKEN (or JIRA_USERNAME + JIRA_PASSWORD)')
  return {
    baseUrl,
    ...(auth ? { auth } : {}),
    ...(jql ? { jql } : {}),
    ...(botUsername ? { botUsername } : {}),
    ...(botAccountId ? { botAccountId } : {}),
    missing,
  }
}

export const jiraKind: SourceKind<JiraSourceConfig> = {
  kind: 'jira',
  title: { ru: 'Jira', en: 'Jira' },
  schema: JiraSourceConfigSchema,
  health: ['jira'],
}

/**
 * Executes one Jira poll batch, saving cursor progress incrementally per delivered trigger so an abort mid-batch
 * never drops undelivered triggers.
 */
export async function pollJiraOnce(params: {
  connector: JiraConnector
  state: {
    get(key: typeof KV.jira.cursor): JiraCursorState | undefined
    set(key: typeof KV.jira.cursor, value: JiraCursorState): void
  }
  receive: (trigger: Trigger) => unknown | Promise<unknown>
  report: (name: string, status: { state: 'ready' | 'error'; detail: string; at: string }) => void
  signal: AbortSignal
  selfComments?: ReadonlySet<string>
}): Promise<void> {
  const stored = params.state.get(KV.jira.cursor)
  if (!stored) {
    // A fresh state directory: start the cursor now and deliver nothing, so events from before the first start never start a job
    // (`A17`). The poll reads only the overlap window, recording its events as seen; older history is never fetched.
    const { nextCursor } = await params.connector.poll({ seenEventIds: [], lastUpdatedIso: new Date().toISOString() }, params.selfComments)
    if (!params.signal.aborted) params.state.set(KV.jira.cursor, nextCursor)
    params.report('jira', { state: 'ready', detail: 'Jira polling active', at: new Date().toISOString() })
    return
  }
  const initialCursor = stored
  const { triggers, nextCursor } = await params.connector.poll(initialCursor, params.selfComments)
  const deliveredSeen = new Set(initialCursor.seenEventIds)
  let abortedMidBatch = false

  for (const trigger of triggers) {
    if (params.signal.aborted) {
      abortedMidBatch = true
      break
    }
    await params.receive(trigger)
    deliveredSeen.add(trigger.id)
    params.state.set(KV.jira.cursor, {
      ...(initialCursor.lastUpdatedIso ? { lastUpdatedIso: initialCursor.lastUpdatedIso } : {}),
      seenEventIds: [...deliveredSeen].slice(-2000),
    })
  }

  if (!abortedMidBatch && !params.signal.aborted) {
    params.state.set(KV.jira.cursor, nextCursor)
  }
  params.report('jira', { state: 'ready', detail: 'Jira polling active', at: new Date().toISOString() })
}

export const name = 'workflow-agent-jira'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(jiraKind), 'jira: source kind')
  ctx.effect(() => {
    const abort = new AbortController()
    const source = sourceContext(ctx.orchestrator, jiraKind)
    void (async () => {
      await source.ready
      while (!abort.signal.aborted) {
        const cfg = source.config<JiraSourceConfig>('jira')
        if (!cfg) {
          source.report('jira', health('paused', 'sourceOff'))
          await pause(5_000, abort.signal)
          continue
        }
        const hostJira = (ctx.orchestrator as { jira?: JiraConnector }).jira
        const resolved = resolveJiraConfig(cfg)
        if (!hostJira && (!resolved.baseUrl || !resolved.auth)) {
          source.report('jira', {
            state: 'error',
            detail: `Jira connector is not configured: missing ${resolved.missing.join(', ')}`,
            at: new Date().toISOString(),
          })
          await pause((cfg.pollSeconds || 60) * 1000, abort.signal)
          continue
        }
        try {
          const fetchImpl = (ctx.orchestrator as { fetchImpl?: typeof fetch }).fetchImpl
          const connector = hostJira ?? new JiraConnector({
            baseUrl: resolved.baseUrl,
            auth: resolved.auth!,
            ...(resolved.jql ? { jql: resolved.jql } : {}),
            ...(resolved.botUsername ? { botUsername: resolved.botUsername } : {}),
            ...(resolved.botAccountId ? { botAccountId: resolved.botAccountId } : {}),
            ...(fetchImpl ? { fetchImpl } : {}),
          })
          await pollJiraOnce({
            connector,
            state: source.state,
            receive: trigger => source.receive(trigger),
            report: (id, status) => source.report(id, status),
            signal: abort.signal,
          })
        } catch (error) {
          source.report('jira', { state: 'error', detail: String(error), at: new Date().toISOString() })
        }
        await pause((cfg.pollSeconds || 60) * 1000, abort.signal)
      }
    })()
    return () => { abort.abort() }
  })
}

