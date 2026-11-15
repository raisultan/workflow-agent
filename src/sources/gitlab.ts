/**
 * GitLab outbound-polling connector and the host's side of the branch and merge request tools (`F2`, `F8`, `D5`):
 * - Polls bound Merge Requests for review notes/discussions, pipeline status transitions and merge state, without inbound webhooks.
 * - Suppresses system notes and the notes it posts itself, recognized by note id, so it can share a person's account and token.
 * - Pushes without force, and only to `agent/<issue-key>-<ascii-slug>` branches (`D5`, `D6`).
 * - Opens and edits merge requests and posts notes; the writers (`adapters/writers.ts`) make those idempotent (`A4`).
 * - Reads merge request metadata, pipeline status, failed job logs and review threads.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { redactCredentials } from '../infra/redact.ts'
import { GITLAB_MAX_CHARS, checkedConnectorText } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { fetchWithRetry, scrubSecret } from './http-client.ts'
import { health, sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'
import type { Trigger } from './types.ts'

/** Configuration for the GitLab connector (`F2`, `D5`). */
export interface GitLabConfig {
  baseUrl: string
  token: string
  fetchImpl?: typeof fetch
  maxRetries?: number
  baseBackoffMs?: number
  /** The host's git push, which `pushCommit` runs. */
  gitPushRunner?: (params: {
    worktreeDir: string
    project: string
    branch: string
    commitSha?: string
  }) => Promise<{ pushed: true; commitSha: string }>
}

/** Durable polling cursor state for GitLab MRs (`A4`, `A8`). */
export interface GitLabCursorState {
  seenNoteIds: string[]
  lastPipelineStatusByMr: Record<string, string>
  mergedMrKeys?: string[]
  /** Merge requests already reported closed without a merge (`mr_closed`). */
  closedMrKeys?: string[]
}

const ALLOWED_AGENT_BRANCH_PATTERN = /^agent\/[a-z0-9][a-z0-9._-]{1,90}$/
const PROTECTED_BRANCH_NAMES = new Set(['main', 'master', 'develop', 'production', 'staging'])

/**
 * Validates that `branch` is an allowed non-force ASCII `agent/<issue-key>-<ascii-slug>` branch (`D5`, `D6`).
 * Rejects protected branches, non-ASCII characters, and force-push refspecs (`+`).
 */
export function assertAllowedAgentBranch(branch: string, force?: boolean): void {
  if (force) {
    throw new Error('Force push (--force) is forbidden by GitLab connector policy (D5)')
  }
  const trimmed = branch.trim()
  if (trimmed.startsWith('+') || trimmed.includes('..') || trimmed.includes(' ')) {
    throw new Error(`Invalid or force-refspec branch "${branch}"`)
  }
  const normalized = trimmed.replace(/^refs\/heads\//u, '')
  if (PROTECTED_BRANCH_NAMES.has(normalized.toLowerCase()) || normalized.toLowerCase().startsWith('release/')) {
    throw new Error(`Pushing directly to protected branch "${normalized}" is forbidden`)
  }
  if (!ALLOWED_AGENT_BRANCH_PATTERN.test(normalized)) {
    throw new Error(
      `Branch "${normalized}" must match ASCII pattern "agent/<issue-key>-<ascii-slug>" (lowercase ASCII letters, digits, hyphens)`,
    )
  }
}

/** Summary of a GitLab Merge Request and its latest pipeline (`D5`). */
export interface GitLabMergeRequestInfo {
  iid: number
  projectId: string
  title: string
  description: string
  state: string
  sourceBranch: string
  targetBranch: string
  webUrl: string
  headPipeline?: {
    id: number
    status: string
    webUrl?: string
  }
}

/**
 * Outbound-polling GitLab connector and host-brokered tool provider (`D5`).
 */
export class GitLabConnector {
  private readonly baseUrl: string
  private readonly config: GitLabConfig

  constructor(config: GitLabConfig) {
    this.config = config
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
  }

  private headers(): Record<string, string> {
    return {
      'PRIVATE-TOKEN': this.config.token,
      Authorization: `Bearer ${this.config.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private async requestJson<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const response = await fetchWithRetry({
      connector: 'gitlab',
      url: `${this.baseUrl}${path}`,
      method: init?.method ?? 'GET',
      headers: this.headers(),
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      secretsToRedact: [this.config.token],
      fetchImpl: this.config.fetchImpl,
      maxRetries: this.config.maxRetries,
      baseBackoffMs: this.config.baseBackoffMs,
    })
    return await response.json() as T
  }

  /**
   * Follows GitLab pagination (`per_page=100`, `page=1..maxPages`, and `X-Next-Page` header).
   */
  private async requestPaginatedJson<T>(
    basePath: string,
    params?: { perPage?: number; maxPages?: number },
  ): Promise<T[]> {
    const perPage = params?.perPage ?? 100
    const maxPages = params?.maxPages ?? 20
    const results: T[] = []
    let page = 1

    for (let i = 0; i < maxPages; i++) {
      const sep = basePath.includes('?') ? '&' : '?'
      const response = await fetchWithRetry({
        connector: 'gitlab',
        url: `${this.baseUrl}${basePath}${sep}per_page=${perPage}&page=${page}`,
        method: 'GET',
        headers: this.headers(),
        secretsToRedact: [this.config.token],
        fetchImpl: this.config.fetchImpl,
        maxRetries: this.config.maxRetries,
        baseBackoffMs: this.config.baseBackoffMs,
      })
      const items = (await response.json() as T[]) ?? []
      if (!Array.isArray(items) || items.length === 0) break
      results.push(...items)

      const nextPageHeader = response.headers.get('x-next-page')?.trim()
      if (nextPageHeader) {
        const parsedNext = Number(nextPageHeader)
        if (Number.isInteger(parsedNext) && parsedNext > page) {
          page = parsedNext
          continue
        }
        break
      }
      if (response.headers.has('x-next-page')) break
      if (items.length < perPage) break
      page += 1
    }

    return results
  }

  /**
   * Polls watched Merge Requests (`watchedMrs`) for new human review notes, pipeline status changes, and merge state (`F2`, `A8`).
   * Isolates per-MR failures so one failing MR (404/403) does not stop polling of remaining MRs.
   */
  async poll(
    watchedMrs: readonly { project: string; iid?: number; mrIid?: number; checkMergeState?: boolean }[],
    cursor: GitLabCursorState = { seenNoteIds: [], lastPipelineStatusByMr: {} },
    isSelfAuthored?: (noteKey: string, body: string) => boolean,
  ): Promise<{
    triggers: Trigger[]
    nextCursor: GitLabCursorState
    errors: string[]
  }> {
    const seenNotes = new Set(cursor.seenNoteIds)
    const nextPipelineStatus: Record<string, string> = { ...cursor.lastPipelineStatusByMr }
    const mergedMrs = new Set(cursor.mergedMrKeys ?? [])
    const closedMrs = new Set(cursor.closedMrKeys ?? [])
    const triggers: Trigger[] = []
    const errors: string[] = []

    for (const target of watchedMrs) {
      const iid = target.iid ?? target.mrIid
      if (!iid || !Number.isFinite(iid)) continue
      const encodedProj = encodeURIComponent(target.project)
      const mrKey = `${target.project}!mr_${iid}`

      try {
        // 1. Poll MR notes with pagination, through their discussions: each note keeps its discussion's id, so an answer to it is
        //    posted under it, not as a new note. Notes are taken oldest first.
        const discussions = await this.requestPaginatedJson<{ id: string; notes?: {
          id: number
          body: string
          created_at: string
          system?: boolean
          author?: { id?: number; username?: string }
        }[] }>(`/api/v4/projects/${encodedProj}/merge_requests/${iid}/discussions`)
        const notes = (discussions ?? []).flatMap(discussion => (discussion.notes ?? []).map(note => ({ ...note, discussionId: discussion.id })))
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)

        for (const note of notes ?? []) {
          const noteKey = `${mrKey}#note_${note.id}`
          if (seenNotes.has(noteKey)) continue
          seenNotes.add(noteKey)

          // Suppress system notes and self-loops (`A8`): the notes the workbench posted, recognized by id or text rather than by
          // author, as the token may be a person's.
          if (note.system) continue
          if (isSelfAuthored?.(noteKey, note.body)) continue

          const actorId = note.author?.username ?? String(note.author?.id ?? 'gitlab-reviewer')
          triggers.push({
            id: `gl_note_${target.project.replace(/\//gu, '_')}_${iid}_${note.id}`,
            source: 'gitlab',
            threads: [{ source: 'gitlab', id: mrKey }],
            actor: { source: 'gitlab', id: actorId },
            human: true,
            addressed: 'mention',
            at: new Date(note.created_at).toISOString(),
            text: note.body,
            channel: {
              source: 'gitlab',
              thread: mrKey,
              address: { project: target.project, mrIid: String(iid), noteId: String(note.id), discussionId: note.discussionId },
            },
            meta: {
              project: target.project,
              mrIid: iid,
              noteId: note.id,
              discussionId: note.discussionId,
            },
          })
        }

        // 2. Poll MR pipelines
        const pipelines = await this.requestJson<{
          id: number
          status: string
          updated_at?: string
          web_url?: string
        }[]>(`/api/v4/projects/${encodedProj}/merge_requests/${iid}/pipelines`)

        const latestPipeline = pipelines?.[0]
        if (latestPipeline) {
          const prevStatus = cursor.lastPipelineStatusByMr[mrKey]
          nextPipelineStatus[mrKey] = latestPipeline.status
          // When `checkMergeState` is active, only emit a pipeline trigger on `failed` (so green CI waits for MR merge).
          const shouldEmitPipeTrigger = target.checkMergeState
            ? latestPipeline.status === 'failed'
            : latestPipeline.status === 'failed' || latestPipeline.status === 'success'
          if (prevStatus !== latestPipeline.status && shouldEmitPipeTrigger) {
            triggers.push({
              id: `gl_pipe_${target.project.replace(/\//gu, '_')}_${iid}_${latestPipeline.id}_${latestPipeline.status}`,
              source: 'gitlab',
              threads: [{ source: 'gitlab', id: mrKey }],
              actor: { source: 'gitlab', id: 'gitlab-ci' },
              human: false,
              at: new Date(latestPipeline.updated_at ?? Date.now()).toISOString(),
              text: `Pipeline #${latestPipeline.id} ${latestPipeline.status} on ${mrKey}`,
              channel: {
                source: 'gitlab',
                thread: mrKey,
                address: { project: target.project, mrIid: String(iid) },
              },
              meta: {
                project: target.project,
                mrIid: iid,
                pipelineId: latestPipeline.id,
                pipelineStatus: latestPipeline.status,
                webUrl: latestPipeline.web_url,
              },
            })
          }
        }

        // 3. Optional MR merge + green pipeline check (`checkMergeState`)
        if (target.checkMergeState && !mergedMrs.has(mrKey)) {
          const mr = await this.getMergeRequest({ project: target.project, mrIid: iid })
          const pipelineStatus = mr.headPipeline?.status ?? nextPipelineStatus[mrKey]
          if (mr.state === 'merged' && pipelineStatus === 'success') {
            mergedMrs.add(mrKey)
            triggers.push({
              id: `gl_merged_${target.project.replace(/\//gu, '_')}_${iid}`,
              source: 'gitlab',
              threads: [{ source: 'gitlab', id: mrKey }],
              actor: { source: 'gitlab', id: 'gitlab-merge' },
              human: true,
              addressed: 'mention',
              at: new Date().toISOString(),
              text: `Merge Request !${iid} merged with green pipeline (${pipelineStatus})`,
              channel: {
                source: 'gitlab',
                thread: mrKey,
                address: { project: target.project, mrIid: String(iid) },
              },
              meta: {
                project: target.project,
                mrIid: iid,
                mrState: 'merged',
                pipelineStatus: 'success',
                webUrl: mr.webUrl,
              },
            })
          } else if (mr.state === 'closed' && !closedMrs.has(mrKey)) {
            // Closed without a merge: reported once (`mr_closed`); its merge state is still checked, since it may be reopened and merged.
            closedMrs.add(mrKey)
            triggers.push({
              id: `gl_closed_${target.project.replace(/\//gu, '_')}_${iid}`,
              source: 'gitlab',
              threads: [{ source: 'gitlab', id: mrKey }],
              actor: { source: 'gitlab', id: 'gitlab-merge' },
              human: true,
              addressed: 'mention',
              at: new Date().toISOString(),
              text: `Merge Request !${iid} closed without merging`,
              channel: { source: 'gitlab', thread: mrKey, address: { project: target.project, mrIid: String(iid) } },
              meta: { project: target.project, mrIid: iid, mrState: 'closed', webUrl: mr.webUrl },
            })
          }
        }
      } catch (error) {
        errors.push(`${mrKey}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      triggers,
      nextCursor: {
        seenNoteIds: [...seenNotes].slice(-2000),
        lastPipelineStatusByMr: nextPipelineStatus,
        ...(mergedMrs.size > 0 ? { mergedMrKeys: [...mergedMrs] } : {}),
        ...(closedMrs.size > 0 ? { closedMrKeys: [...closedMrs] } : {}),
      },
      errors,
    }
  }

  /**
   * Host-brokered `gitlab_get_mr` tool (`D5`): fetches Merge Request details and latest pipeline status.
   */
  async getMergeRequest(params: { project: string; mrIid: number }): Promise<GitLabMergeRequestInfo> {
    const raw = await this.requestJson<{
      iid: number
      title: string
      description?: string
      state: string
      source_branch: string
      target_branch: string
      web_url: string
      head_pipeline?: { id: number; status: string; web_url?: string }
    }>(`/api/v4/projects/${encodeURIComponent(params.project)}/merge_requests/${params.mrIid}`)

    return {
      iid: raw.iid,
      projectId: params.project,
      title: raw.title,
      description: raw.description ?? '',
      state: raw.state,
      sourceBranch: raw.source_branch,
      targetBranch: raw.target_branch,
      webUrl: raw.web_url,
      ...(raw.head_pipeline
        ? {
            headPipeline: {
              id: raw.head_pipeline.id,
              status: raw.head_pipeline.status,
              ...(raw.head_pipeline.web_url ? { webUrl: raw.head_pipeline.web_url } : {}),
            },
          }
        : {}),
    }
  }

  /**
   * Host-brokered `gitlab_list_discussions` tool (`D5`): lists review discussions on a Merge Request.
   */
  async listDiscussions(params: { project: string; mrIid: number }): Promise<{
    discussions: {
      id: string
      notes: { id: number; author: string; body: string; createdAt: string; resolved?: boolean }[]
    }[]
  }> {
    const raw = await this.requestPaginatedJson<{
      id: string
      notes?: {
        id: number
        body: string
        created_at: string
        resolved?: boolean
        system?: boolean
        author?: { username?: string }
      }[]
    }>(`/api/v4/projects/${encodeURIComponent(params.project)}/merge_requests/${params.mrIid}/discussions`)

    return {
      discussions: (raw ?? [])
        .map(disc => ({
          id: disc.id,
          notes: (disc.notes ?? [])
            .filter(n => !n.system)
            .map(n => ({
              id: n.id,
              author: n.author?.username ?? 'unknown',
              body: n.body,
              createdAt: n.created_at,
              ...(n.resolved !== undefined ? { resolved: n.resolved } : {}),
            })),
        }))
        .filter(disc => disc.notes.length > 0),
    }
  }

  /**
   * Posts a note on a merge request (in a discussion, when given). The writers end its body with a hidden marker carrying their
   * idempotency key (`T9.2`). Returns its id and the server's creation time.
   */
  async createNote(input: { project: string; mrIid: number; body: string; discussionId?: string }): Promise<{ id: number; createdAt: number }> {
    const base = `/api/v4/projects/${encodeURIComponent(input.project)}/merge_requests/${input.mrIid}`
    const path = input.discussionId ? `${base}/discussions/${encodeURIComponent(input.discussionId)}/notes` : `${base}/notes`
    const created = await this.requestJson<{ id: number; created_at?: string }>(path, { method: 'POST',
      body: { body: checkedConnectorText(input.body, GITLAB_MAX_CHARS, 'gitlab note') } })
    return { id: created.id, createdAt: created.created_at ? Date.parse(created.created_at) : Date.now() }
  }

  /** The latest note on the merge request whose body contains `marker`, if any. */
  async findNote(input: { project: string; mrIid: number; marker: string }): Promise<{ id: number; createdAt: number } | undefined> {
    const notes = await this.requestJson<{ id: number; body?: string; created_at?: string }[]>(
      `/api/v4/projects/${encodeURIComponent(input.project)}/merge_requests/${input.mrIid}/notes?sort=desc&order_by=created_at&per_page=100`)
    const found = notes.find(note => note.body?.includes(input.marker))
    return found && { id: found.id, createdAt: found.created_at ? Date.parse(found.created_at) : 0 }
  }

  /** The open merge request from `sourceBranch`, if any. */
  async openMergeRequest(project: string, sourceBranch: string): Promise<{ iid: number; webUrl: string } | undefined> {
    const list = await this.requestJson<{ iid: number; web_url: string }[]>(
      `/api/v4/projects/${encodeURIComponent(project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}`)
    return list[0] && { iid: list[0].iid, webUrl: list[0].web_url }
  }

  /** Opens a merge request from an agent branch. */
  async openNewMergeRequest(input: { project: string; sourceBranch: string; targetBranch: string; title: string; description: string }): Promise<{ iid: number; webUrl: string }> {
    assertAllowedAgentBranch(input.sourceBranch, false)
    const created = await this.requestJson<{ iid: number; web_url: string }>(`/api/v4/projects/${encodeURIComponent(input.project)}/merge_requests`,
      { method: 'POST', body: { source_branch: input.sourceBranch, target_branch: input.targetBranch, title: input.title,
        description: checkedConnectorText(input.description, GITLAB_MAX_CHARS, 'gitlab MR description') } })
    return { iid: created.iid, webUrl: created.web_url }
  }

  /** Sets a merge request's title or description; setting the same values again changes nothing. */
  async editMergeRequest(input: { project: string; mrIid: number; title?: string; description?: string }): Promise<{ iid: number; webUrl: string }> {
    const updated = await this.requestJson<{ iid: number; web_url: string }>(
      `/api/v4/projects/${encodeURIComponent(input.project)}/merge_requests/${input.mrIid}`, { method: 'PUT', body: {
        ...input.title !== undefined ? { title: input.title } : {},
        ...input.description !== undefined ? { description: checkedConnectorText(input.description, GITLAB_MAX_CHARS, 'gitlab MR description') } : {} } })
    return { iid: updated.iid, webUrl: updated.web_url }
  }

  /** The newest pipeline for commit `sha`, if any. */
  async latestPipeline(project: string, sha: string): Promise<{ id: number; status: string; webUrl: string } | undefined> {
    const pipelines = await this.requestJson<{ id: number; status: string; web_url: string }[]>(
      `/api/v4/projects/${encodeURIComponent(project)}/pipelines?sha=${encodeURIComponent(sha)}&order_by=id&sort=desc&per_page=1`)
    return pipelines[0] && { id: pipelines[0].id, status: pipelines[0].status, webUrl: pipelines[0].web_url }
  }

  /** The failed jobs of a pipeline (`T10.5`), so a failed CI check can show why. */
  async failedJobs(project: string, pipelineId: number): Promise<{ id: number; name: string; stage: string; webUrl: string }[]> {
    const jobs = await this.requestJson<{ id: number; name: string; stage: string; status: string; web_url: string }[]>(
      `/api/v4/projects/${encodeURIComponent(project)}/pipelines/${pipelineId}/jobs?scope[]=failed&per_page=20`)
    return jobs.filter(job => job.status === 'failed').map(job => ({ id: job.id, name: job.name, stage: job.stage, webUrl: job.web_url }))
  }

  /**
   * The last `maxChars` of a CI job's log (`T10.5`), as plain text: terminal colour codes and GitLab's section markers removed, and
   * credentials redacted (the connector's token, and what `redactCredentials` finds). The read is bounded: only the
   * tail is asked for (`Range`), and a server that sends the whole log is read through a window of the last bytes, up to a cap.
   * Redaction runs on that window before the tail is cut, with the window's partial first line dropped, so a cut never splits a
   * secret from its name.
   */
  async jobLogTail(project: string, jobId: number, maxChars: number, options: { readLimit?: number } = {}): Promise<string> {
    const keep = maxChars * 4 + 4096, readLimit = options.readLimit ?? 32 << 20
    const response = await fetchWithRetry({
      connector: 'gitlab',
      url: `${this.baseUrl}/api/v4/projects/${encodeURIComponent(project)}/jobs/${jobId}/trace`,
      method: 'GET',
      headers: { ...this.headers(), Accept: 'text/plain', Range: `bytes=-${keep}` },
      secretsToRedact: [this.config.token],
      fetchImpl: this.config.fetchImpl,
      maxRetries: this.config.maxRetries,
      baseBackoffMs: this.config.baseBackoffMs,
    })
    let window = Buffer.alloc(0), total = 0, unread = false
    const reader = response.body?.getReader()
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        window = Buffer.concat([window, Buffer.from(value)])
        if (window.length > keep) window = window.subarray(window.length - keep)
        if (total > readLimit) { unread = true; await reader.cancel().catch(() => {}); break }
      }
    }
    let raw = window.toString('utf8')
    // A window that does not start at the log's start may begin inside a line: drop that part line.
    if (response.status === 206 || total > window.length) raw = raw.slice(raw.indexOf('\n') + 1)
    const plain = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '').replace(/section_(?:start|end):\d+:[^\r\n]*\r?/gu, '')
      .replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
    const text = redactCredentials(scrubSecret(plain, this.config.token)).trimEnd()
    const tail = text.length > maxChars ? `…${text.slice(-maxChars)}` : text
    return unread ? `(the log is longer than ${readLimit >> 20} MiB; its end was not read)\n${tail}` : tail
  }

  /** Pushes `sha` from a worktree to an agent branch, without force; pushing the same commit again changes nothing. */
  async pushCommit(input: { worktreeDir: string; project: string; branch: string; sha: string }): Promise<{ branch: string; sha: string }> {
    const branch = input.branch.trim().replace(/^refs\/heads\//u, '')
    assertAllowedAgentBranch(branch, false)
    if (!this.config.gitPushRunner) throw new Error('GitLab has no git transport configured')
    const pushed = await this.config.gitPushRunner({ worktreeDir: input.worktreeDir, project: input.project, branch, commitSha: input.sha })
    return { branch, sha: pushed.commitSha }
  }
}

export const GitLabSourceConfigSchema = z.object({
  baseUrl: z.string().default(''),
  project: z.string().default(''),
  projectId: z.string().default(''),
  pollSeconds: z.number().int().min(5).max(3600).default(60),
}).strict()

export type GitLabSourceConfig = z.infer<typeof GitLabSourceConfigSchema>

/**
 * Resolves GitLab connector settings with explicit source config taking precedence over environment variables.
 */
export function resolveGitLabConfig(
  cfg?: Partial<GitLabSourceConfig>,
  env: NodeJS.ProcessEnv = process.env,
): {
  baseUrl: string
  token?: string
  project: string
  missing: string[]
} {
  const baseUrl = cfg?.baseUrl?.trim() || env.GITLAB_BASE_URL?.trim() || ''
  const token = env.GITLAB_TOKEN?.trim() || undefined
  const project = cfg?.project?.trim() || cfg?.projectId?.trim() || env.GITLAB_PROJECT?.trim() || ''
  const missing: string[] = []
  if (!baseUrl) missing.push('baseUrl / GITLAB_BASE_URL')
  if (!token) missing.push('GITLAB_TOKEN')
  return {
    baseUrl,
    ...(token ? { token } : {}),
    project,
    missing,
  }
}

export const gitlabKind: SourceKind<GitLabSourceConfig> = {
  kind: 'gitlab',
  title: { ru: 'GitLab', en: 'GitLab' },
  schema: GitLabSourceConfigSchema,
  health: ['gitlab'],
}

/**
 * Executes one GitLab poll batch, saving cursor progress incrementally per delivered trigger so an abort mid-batch
 * never drops undelivered triggers, and reporting per-MR errors in health.
 */
export async function pollGitLabOnce(params: {
  connector: GitLabConnector
  watchedMrs: readonly { project: string; iid?: number; mrIid?: number; checkMergeState?: boolean }[]
  state: {
    get(key: typeof KV.gitlab.cursor): GitLabCursorState | undefined
    set(key: typeof KV.gitlab.cursor, value: GitLabCursorState): void
  }
  receive: (trigger: Trigger) => unknown | Promise<unknown>
  report: (name: string, status: { state: 'ready' | 'error'; detail: string; at: string }) => void
  signal: AbortSignal
  isSelfAuthored?: (noteKey: string, body: string) => boolean
}): Promise<void> {
  const initialCursor = params.state.get(KV.gitlab.cursor) ?? { seenNoteIds: [], lastPipelineStatusByMr: {} }
  const { triggers, nextCursor, errors } = await params.connector.poll(params.watchedMrs, initialCursor, params.isSelfAuthored)
  const deliveredSeen = new Set(initialCursor.seenNoteIds)
  const deliveredPipeline: Record<string, string> = { ...initialCursor.lastPipelineStatusByMr }
  const deliveredMerged = new Set(initialCursor.mergedMrKeys ?? [])
  const deliveredClosed = new Set(initialCursor.closedMrKeys ?? [])
  let abortedMidBatch = false

  for (const trigger of triggers) {
    if (params.signal.aborted) {
      abortedMidBatch = true
      break
    }
    await params.receive(trigger)
    const mrKey = trigger.threads[0]?.id
    if (mrKey) {
      if (trigger.meta.noteId !== undefined) {
        deliveredSeen.add(`${mrKey}#note_${String(trigger.meta.noteId)}`)
      } else if (trigger.meta.mrState === 'merged') {
        deliveredMerged.add(mrKey)
      } else if (trigger.meta.mrState === 'closed') {
        deliveredClosed.add(mrKey)
      } else if (typeof trigger.meta.pipelineStatus === 'string') {
        deliveredPipeline[mrKey] = trigger.meta.pipelineStatus
      }
    }
    params.state.set(KV.gitlab.cursor, {
      seenNoteIds: [...deliveredSeen].slice(-2000),
      lastPipelineStatusByMr: { ...deliveredPipeline },
      ...(deliveredMerged.size > 0 ? { mergedMrKeys: [...deliveredMerged] } : {}),
      ...(deliveredClosed.size > 0 ? { closedMrKeys: [...deliveredClosed] } : {}),
    })
  }

  if (!abortedMidBatch && !params.signal.aborted) {
    params.state.set(KV.gitlab.cursor, nextCursor)
  }

  if (errors.length > 0) {
    params.report('gitlab', { state: 'error', detail: errors.join('; '), at: new Date().toISOString() })
  } else {
    params.report('gitlab', { state: 'ready', detail: 'GitLab polling active', at: new Date().toISOString() })
  }
}

export const name = 'workflow-agent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const abort = new AbortController()
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    void (async () => {
      await source.ready
      while (!abort.signal.aborted) {
        const cfg = source.config<GitLabSourceConfig>('gitlab')
        if (!cfg) {
          source.report('gitlab', health('paused', 'sourceOff'))
          await pause(5_000, abort.signal)
          continue
        }
        const hostGitlab = (ctx.orchestrator as { gitlab?: GitLabConnector }).gitlab
        const resolved = resolveGitLabConfig(cfg)
        if (!hostGitlab && (!resolved.baseUrl || !resolved.token)) {
          source.report('gitlab', {
            state: 'error',
            detail: `GitLab connector is not configured: missing ${resolved.missing.join(', ')}`,
            at: new Date().toISOString(),
          })
          await pause((cfg.pollSeconds || 60) * 1000, abort.signal)
          continue
        }
        try {
          const fetchImpl = (ctx.orchestrator as { fetchImpl?: typeof fetch }).fetchImpl
          const connector = hostGitlab ?? new GitLabConnector({
            baseUrl: resolved.baseUrl,
            token: resolved.token!,
            ...(fetchImpl ? { fetchImpl } : {}),
          })
          const defaultProject = resolved.project
          const boundMrs = source.threads.subscribed('gitlab').flatMap(thread => watchedMr(thread, defaultProject) ?? [])
          await pollGitLabOnce({
            connector,
            watchedMrs: boundMrs,
            state: source.state,
            receive: trigger => source.receive(trigger),
            report: (id, status) => source.report(id, status),
            signal: abort.signal,
          })
        } catch (error) {
          source.report('gitlab', { state: 'error', detail: String(error), at: new Date().toISOString() })
        }
        await pause((cfg.pollSeconds || 60) * 1000, abort.signal)
      }
    })()
    return () => { abort.abort() }
  })
}

/** The merge request number of a thread id or key: `group/project!mr_17`, `gitlab:group/project!mr_17`, `gitlab:mr_17`, or `gitlab:17`. */
export const mrNumber = (thread: string): number | undefined => {
  const mrMatch = /^(?:(?:gitlab|github):)?(?:.+!mr_|mr_)?(\d+)$/.exec(thread)
  return mrMatch?.[1] ? Number(mrMatch[1]) : undefined
}
/** The merge request a bound GitLab thread watches: its project is the thread's own, else the one in its id, else `defaultProject`. */
export function watchedMr(
  thread: { ref: { id: string }; meta: Record<string, unknown> },
  defaultProject: string,
): { project: string; iid: number; checkMergeState: boolean } | undefined {
  const iid = mrNumber(thread.ref.id)
  const embedded = thread.ref.id.includes('!mr_') ? thread.ref.id.slice(0, thread.ref.id.indexOf('!mr_')).replace(/^gitlab:/u, '') : ''
  const project = typeof thread.meta.project === 'string' && thread.meta.project ? thread.meta.project : embedded || defaultProject
  return iid !== undefined && project ? { project, iid, checkMergeState: true } : undefined
}

