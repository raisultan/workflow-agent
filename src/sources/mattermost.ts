/**
 * Mattermost outbound-polling connector and host-brokered tools (`F2`, `F8`, `D5`, `D7`):
 * - Polls all public (`O`), private (`P`), and direct (`D`/`G`) channels the bot belongs to without requiring public inbound webhooks.
 * - Suppresses bot self-loops (`post.user_id === botUserId`).
 * - Supports thread replies (`root_id`), thread reading (`mattermost_get_thread`),
 *   idempotent message posting (`mattermost_post_message`), and creating new public channels (`mattermost_create_channel`).
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Trigger } from './types.ts'
import { IM_MAX_CHARS, asciiSlug, checkedConnectorText } from '../infra/text.ts'
import { ConnectorHttpError, fetchWithRetry } from './http-client.ts'
import { health, sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

/** Configuration for the Mattermost connector (`F2`, `D5`). */
export interface MattermostConfig {
  baseUrl: string
  token: string
  botUserId?: string
  botUsername?: string
  teamId?: string
  fetchImpl?: typeof fetch
  maxRetries?: number
  baseBackoffMs?: number
}

/** Durable polling cursor state for Mattermost channels (`A4`, `A8`). */
export interface MattermostCursorState {
  channelSince: Record<string, number>
  seenPostIds: string[]
  /** When polling first started (epoch ms): a channel first read later delivers nothing posted before it. */
  startedAt?: number
}

/** Raw Mattermost channel summary returned by `/api/v4/users/{id}/channels`. */
export interface MattermostChannelInfo {
  id: string
  team_id?: string
  type: 'O' | 'P' | 'D' | 'G'
  name: string
  display_name: string
  create_at?: number
}

/** Raw Mattermost post object returned by `/api/v4/channels/{id}/posts` or `/api/v4/posts/{id}/thread`. */
export interface MattermostPost {
  id: string
  create_at: number
  update_at?: number
  user_id: string
  channel_id: string
  root_id?: string
  message: string
  type?: string
  props?: Record<string, unknown>
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Outbound-polling Mattermost connector and host-brokered tool provider (`D5`, `D7`).
 */
export class MattermostConnector {
  private readonly baseUrl: string
  private botUserId?: string
  private botUsername?: string
  private readonly usernameByUserId = new Map<string, string | null>()
  private readonly config: MattermostConfig

  constructor(config: MattermostConfig) {
    this.config = config
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
    this.botUserId = config.botUserId
    this.botUsername = config.botUsername
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private async requestJson<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const response = await fetchWithRetry({
      connector: 'mattermost',
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

  /** The username of a user this connector has seen (a post's author, a lookup), without a request. */
  knownUsername(userId: string): string | undefined {
    return this.usernameByUserId.get(userId) ?? undefined
  }

  /** Resolves and caches the bot's own Mattermost `user_id` and `username` via `/api/v4/users/me`. */
  async ensureBotIdentity(): Promise<{ userId: string; username: string }> {
    if (this.botUserId && this.botUsername) {
      return { userId: this.botUserId, username: this.botUsername }
    }
    const me = await this.requestJson<{ id: string; username: string }>('/api/v4/users/me')
    this.botUserId = me.id
    this.botUsername = me.username
    return { userId: me.id, username: me.username }
  }

  /**
   * Lists all channels (public `'O'`, private `'P'`, direct `'D'`, group `'G'`) the bot is a member of (`D5`).
   */
  async listBotChannels(): Promise<MattermostChannelInfo[]> {
    const { userId } = await this.ensureBotIdentity()
    return await this.requestJson<MattermostChannelInfo[]>(`/api/v4/users/${encodeURIComponent(userId)}/channels`)
  }

  /**
   * Polls all public, private, and DM channels the bot belongs to for new posts since `cursor`,
   * suppressing the bot's own posts and returning normalized `Trigger` events (`F2`, `D5`, `A8`).
   */
  async poll(cursor: MattermostCursorState = { channelSince: {}, seenPostIds: [] }): Promise<{
    triggers: Trigger[]
    nextCursor: MattermostCursorState
    errors: string[]
  }> {
    const { userId, username } = await this.ensureBotIdentity()
    const channels = await this.listBotChannels()
    const nextChannelSince: Record<string, number> = { ...cursor.channelSince }
    const seenSet = new Set(cursor.seenPostIds)
    const triggers: Trigger[] = []
    const errors: string[] = []
    // A cursor stored before `startedAt` existed starts counting now.
    const startedAt = cursor.startedAt ?? Date.now()

    for (const channel of channels) {
      try {
        const since = cursor.channelSince[channel.id] ?? 0
        const path = since > 0
          ? `/api/v4/channels/${encodeURIComponent(channel.id)}/posts?since=${since}`
          : `/api/v4/channels/${encodeURIComponent(channel.id)}/posts?per_page=50`
        const payload = await this.requestJson<{ order: string[]; posts: Record<string, MattermostPost> }>(path)
        const orderedPosts = (payload.order ?? [])
          .map(id => payload.posts[id])
          .filter((post): post is MattermostPost => post !== undefined)
          .sort((a, b) => a.create_at - b.create_at || a.id.localeCompare(b.id))
        // A channel read for the first time (joined after the first start, or failed then) starts at the latest of the first
        // start, the bot's own join post and the channel's creation, so its earlier posts never start a job (`A17`). A direct
        // channel has no join post and starts at its creation, so a first direct message is delivered.
        const floor = since > 0 ? 0 : Math.max(startedAt, channel.create_at ?? 0, ...orderedPosts
          .filter(post => (post.type === 'system_join_channel' && post.user_id === userId)
            || (post.type === 'system_add_to_channel' && post.props?.addedUserId === userId))
          .map(post => post.create_at))

        let maxTimestamp = Math.max(since, floor)
        for (const post of orderedPosts) {
          if (post.create_at > maxTimestamp) maxTimestamp = post.create_at
          if (seenSet.has(post.id)) continue
          seenSet.add(post.id)
          // Posted before the channel's start, or a system post (a join, an add) rather than a person's message.
          if (post.create_at < floor || post.type?.startsWith('system_')) continue

          // Bot self-loop suppression (`A8`).
          if (post.user_id === userId || post.props?.from_bot === 'true' || post.props?.from_bot === true) {
            continue
          }

          const rootId = post.root_id && post.root_id.length > 0 ? post.root_id : post.id
          const threadId = `${channel.id}:${rootId}`
          const mentioned = new RegExp(`(?:^|\\s)@${escapeRegExp(username)}(?=$|[\\s,.:;!?])`, 'iu').test(post.message)
          const addressed = channel.type === 'D' ? 'direct' : mentioned ? 'mention' : undefined

          if (!this.usernameByUserId.has(post.user_id)) {
            const userRecord = await this.requestJson<{ id?: string; username?: string }>(
              `/api/v4/users/${encodeURIComponent(post.user_id)}`,
            ).catch(() => undefined)
            this.usernameByUserId.set(post.user_id, userRecord?.username?.trim() || null)
          }
          const postUsername =
            this.usernameByUserId.get(post.user_id)
            || (typeof post.props?.username === 'string' ? post.props.username.trim() : undefined)

          triggers.push({
            id: `mm_${post.id}`,
            source: 'mattermost',
            threads: [{ source: 'mattermost', id: threadId }],
            actor: { source: 'mattermost', id: post.user_id },
            human: true,
            ...(addressed ? { addressed } : {}),
            at: new Date(post.create_at).toISOString(),
            text: post.message,
            channel: {
              source: 'mattermost',
              thread: threadId,
              address: {
                channelId: channel.id,
                rootId,
                channelType: channel.type,
                channelName: channel.name,
              },
            },
            meta: {
              postId: post.id,
              channelId: channel.id,
              channelType: channel.type,
              channelName: channel.name,
              rootId,
              ...(postUsername ? { username: postUsername } : {}),
            },
          })
        }

        if (maxTimestamp > 0) {
          nextChannelSince[channel.id] = maxTimestamp
        }
      } catch (error) {
        errors.push(`channel ${channel.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const boundedSeen = [...seenSet].slice(-2000)
    return {
      triggers,
      nextCursor: {
        channelSince: nextChannelSince,
        seenPostIds: boundedSeen,
        startedAt,
      },
      errors,
    }
  }

  /**
   * Host-brokered `mattermost_get_thread` tool (`D5`): fetches and orders posts in a thread.
   */
  async readThread(params: { postId: string; limit?: number }): Promise<{
    rootId: string
    posts: { id: string; userId: string; message: string; createdAt: string }[]
  }> {
    const payload = await this.requestJson<{ order: string[]; posts: Record<string, MattermostPost> }>(
      `/api/v4/posts/${encodeURIComponent(params.postId)}/thread`,
    )
    const posts = (payload.order ?? [])
      .map(id => payload.posts[id])
      .filter((p): p is MattermostPost => p !== undefined)
      .sort((a, b) => a.create_at - b.create_at || a.id.localeCompare(b.id))
      .slice(0, params.limit ?? 100)
      .map(p => ({
        id: p.id,
        userId: p.user_id,
        message: p.message,
        createdAt: new Date(p.create_at).toISOString(),
      }))
    return {
      rootId: posts[0]?.id ?? params.postId,
      posts,
    }
  }


  /**
   * Creates a post carrying `props`; V2 writers put their idempotency key there, so a post whose outcome is unknown can be found
   * again (`T9.2`). Returns the server's id and creation time.
   */
  async createPost(input: { channelId: string; rootId?: string; message: string; props?: Record<string, unknown> }): Promise<{ id: string; createAt: number }> {
    const created = await this.requestJson<MattermostPost>('/api/v4/posts', { method: 'POST', body: { channel_id: input.channelId,
      ...input.rootId ? { root_id: input.rootId } : {}, message: checkedConnectorText(input.message, IM_MAX_CHARS, 'mattermost message'),
      ...input.props ? { props: input.props } : {} } })
    return { id: created.id, createAt: created.create_at }
  }

  /** A post in the thread (or the channel's latest 200) whose `props[prop]` is `value`. */
  async findPostByProp(input: { channelId: string; rootId?: string; prop: string; value: string }): Promise<{ id: string; createAt: number } | undefined> {
    const path = input.rootId ? `/api/v4/posts/${encodeURIComponent(input.rootId)}/thread`
      : `/api/v4/channels/${encodeURIComponent(input.channelId)}/posts?per_page=200`
    const { posts = {} } = await this.requestJson<{ posts?: Record<string, MattermostPost> }>(path)
    const found = Object.values(posts).find(post => post.props?.[input.prop] === input.value)
    return found && { id: found.id, createAt: found.create_at }
  }

  /** Creates a public channel, or finds the one a previous attempt created under the same name. */
  async ensurePublicChannel(input: { teamId?: string; name: string; displayName: string; purpose?: string }): Promise<{ id: string; name: string }> {
    const teamId = input.teamId ?? this.config.teamId
    if (!teamId) throw new Error('creating a Mattermost channel needs a team id')
    const name = asciiSlug(input.name || input.displayName, 64)
    const existing = await this.requestJson<MattermostChannelInfo>(
      `/api/v4/teams/${encodeURIComponent(teamId)}/channels/name/${encodeURIComponent(name)}`).catch(() => undefined)
    if (existing?.id) return { id: existing.id, name: existing.name }
    const created = await this.requestJson<MattermostChannelInfo>('/api/v4/channels', { method: 'POST',
      body: { team_id: teamId, name, display_name: input.displayName, purpose: input.purpose ?? '', type: 'O' } })
    return { id: created.id, name: created.name }
  }

  /** Adds users to a channel; adding a member again changes nothing. */
  async addChannelMembers(channelId: string, userIds: readonly string[]): Promise<void> {
    for (const userId of userIds) {
      await this.requestJson(`/api/v4/channels/${encodeURIComponent(channelId)}/members`, { method: 'POST', body: { user_id: userId } })
    }
  }


  /**
   * The user with `email` (`D12`), or `undefined` when Mattermost has none. Unlike `resolveUsers`, a request Mattermost cannot answer
   * rejects, so a caller can tell an unreachable Mattermost from an unknown email and retry.
   */
  async userByEmail(email: string): Promise<{ id: string; username: string } | undefined> {
    try {
      const user = await this.requestJson<{ id?: string; username?: string }>(`/api/v4/users/email/${encodeURIComponent(email)}`)
      if (!user.id || !user.username) return undefined
      this.usernameByUserId.set(user.id, user.username)
      return { id: user.id, username: user.username }
    } catch (error) {
      if (error instanceof ConnectorHttpError && error.status === 404) return undefined
      throw error
    }
  }

  /**
   * Host-brokered `mattermost_resolve_users` tool (`D5`): resolves usernames or emails via Mattermost API (`/api/v4/users/usernames`
   * and `/api/v4/users/email/:email`), returning the matched user records or normalized `@username` handles.
   */
  async resolveUsers(identifiers: readonly string[]): Promise<{ id?: string; username: string; email?: string }[]> {
    const cleaned = identifiers.map(raw => raw.trim().replace(/^@+/u, '')).filter(Boolean)
    const emails = cleaned.filter(item => item.includes('@'))
    const usernames = cleaned.filter(item => !item.includes('@'))
    const resolved = new Map<string, { id?: string; username: string; email?: string }>()
    if (usernames.length > 0) {
      const found = await this.requestJson<{ id: string; username: string; email?: string }[]>('/api/v4/users/usernames', {
        method: 'POST',
        body: usernames,
      }).catch(() => [])
      for (const user of Array.isArray(found) ? found : []) {
        if (user?.username) {
          if (user.id) this.usernameByUserId.set(user.id, user.username)
          resolved.set(user.username.toLowerCase(), { id: user.id, username: user.username, ...(user.email ? { email: user.email } : {}) })
        }
      }
    }
    for (const email of emails) {
      const user = await this.requestJson<{ id: string; username: string; email?: string }>(`/api/v4/users/email/${encodeURIComponent(email)}`).catch(() => undefined)
      if (user?.username) {
        if (user.id) this.usernameByUserId.set(user.id, user.username)
        resolved.set(email.toLowerCase(), { id: user.id, username: user.username, ...(user.email ? { email: user.email } : {}) })
      }
    }
    return cleaned.map(item => resolved.get(item.toLowerCase()) ?? { username: item })
  }

  /**
   * Looks users up by username. Unlike `resolveUsers`, a failed request rejects, so a caller can tell an unreachable Mattermost
   * (try again later) from a name with no user (left out of the result).
   */
  async usersByUsername(usernames: readonly string[]): Promise<{ id: string; username: string }[]> {
    const cleaned = usernames.map(raw => raw.trim().replace(/^@+/u, '')).filter(Boolean)
    if (!cleaned.length) return []
    const found = await this.requestJson<{ id: string; username: string }[]>('/api/v4/users/usernames', { method: 'POST', body: cleaned })
    return (Array.isArray(found) ? found : []).filter(user => user?.id && user.username).map(user => ({ id: user.id, username: user.username }))
  }
}

export const MattermostSourceConfigSchema = z.object({
  baseUrl: z.string().default(''),
  teamId: z.string().default(''),
  botUserId: z.string().default(''),
  pollSeconds: z.number().int().min(5).max(3600).default(15),
  directMessages: z.boolean().default(true),
}).strict()

export type MattermostSourceConfig = z.infer<typeof MattermostSourceConfigSchema>

/**
 * Resolves Mattermost connector settings with explicit source config taking precedence over environment variables.
 */
export function resolveMattermostConfig(
  cfg?: Partial<MattermostSourceConfig>,
  env: NodeJS.ProcessEnv = process.env,
): {
  baseUrl: string
  token?: string
  botUserId: string
  teamId?: string
  missing: string[]
} {
  const baseUrl = cfg?.baseUrl?.trim() || env.MATTERMOST_BASE_URL?.trim() || ''
  const token = env.MATTERMOST_TOKEN?.trim() || undefined
  const botUserId = cfg?.botUserId?.trim() || env.MATTERMOST_BOT_USER_ID?.trim() || 'bot'
  const teamId = cfg?.teamId?.trim() || env.MATTERMOST_TEAM_ID?.trim() || undefined
  const missing: string[] = []
  if (!baseUrl) missing.push('baseUrl / MATTERMOST_BASE_URL')
  if (!token) missing.push('MATTERMOST_TOKEN')
  return {
    baseUrl,
    ...(token ? { token } : {}),
    botUserId,
    ...(teamId ? { teamId } : {}),
    missing,
  }
}

export const mattermostKind: SourceKind<MattermostSourceConfig> = {
  kind: 'mattermost',
  title: { ru: 'Mattermost', en: 'Mattermost' },
  schema: MattermostSourceConfigSchema,
  health: ['mattermost'],
}

import { KV } from '../kv.ts'
import { pause } from './poll.ts'

/**
 * Executes one Mattermost poll batch, saving cursor progress incrementally per delivered trigger so an abort mid-batch
 * never drops undelivered triggers, and reporting per-channel errors in health.
 */
export async function pollMattermostOnce(params: {
  connector: MattermostConnector
  state: {
    get(key: typeof KV.mattermost.cursor): MattermostCursorState | undefined
    set(key: typeof KV.mattermost.cursor, value: MattermostCursorState): void
  }
  receive: (trigger: Trigger) => unknown | Promise<unknown>
  report: (name: string, status: { state: 'ready' | 'error'; detail: string; at: string }) => void
  signal: AbortSignal
}): Promise<void> {
  const stored = params.state.get(KV.mattermost.cursor)
  if (!stored) {
    // A fresh state directory: record each channel's latest post and deliver nothing, so posts from before the first start
    // never start a job (`A17`). The baseline is stored even when some channels failed, so one broken channel cannot hold back
    // every other; like a channel the bot joins later, a failed channel then delivers only what was posted after the first start.
    const { nextCursor, errors } = await params.connector.poll({ channelSince: {}, seenPostIds: [] })
    if (!params.signal.aborted) params.state.set(KV.mattermost.cursor, nextCursor)
    params.report('mattermost', errors.length > 0
      ? { state: 'error', detail: errors.join('; '), at: new Date().toISOString() }
      : { state: 'ready', detail: 'Mattermost polling active', at: new Date().toISOString() })
    return
  }
  const initialCursor = stored
  const { triggers, nextCursor, errors } = await params.connector.poll(initialCursor)
  const deliveredSeen = new Set(initialCursor.seenPostIds)
  let abortedMidBatch = false

  for (const trigger of triggers) {
    if (params.signal.aborted) {
      abortedMidBatch = true
      break
    }
    await params.receive(trigger)
    if (typeof trigger.meta.postId === 'string') {
      deliveredSeen.add(trigger.meta.postId)
    }
    params.state.set(KV.mattermost.cursor, {
      channelSince: { ...initialCursor.channelSince },
      seenPostIds: [...deliveredSeen].slice(-2000),
      startedAt: nextCursor.startedAt,
    })
  }

  if (!abortedMidBatch && !params.signal.aborted) {
    params.state.set(KV.mattermost.cursor, nextCursor)
  }

  if (errors.length > 0) {
    params.report('mattermost', { state: 'error', detail: errors.join('; '), at: new Date().toISOString() })
  } else {
    params.report('mattermost', { state: 'ready', detail: 'Mattermost polling active', at: new Date().toISOString() })
  }
}

export const name = 'workflow-agent-mattermost'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(mattermostKind), 'mattermost: source kind')
  ctx.effect(() => {
    const abort = new AbortController()
    const source = sourceContext(ctx.orchestrator, mattermostKind)
    void (async () => {
      await source.ready
      while (!abort.signal.aborted) {
        const cfg = source.config<MattermostSourceConfig>('mattermost')
        if (!cfg) {
          source.report('mattermost', health('paused', 'sourceOff'))
          await pause(5_000, abort.signal)
          continue
        }
        const hostMattermost = (ctx.orchestrator as { mattermost?: MattermostConnector }).mattermost
        const resolved = resolveMattermostConfig(cfg)
        if (!hostMattermost && (!resolved.baseUrl || !resolved.token)) {
          source.report('mattermost', {
            state: 'error',
            detail: `Mattermost connector is not configured: missing ${resolved.missing.join(', ')}`,
            at: new Date().toISOString(),
          })
          await pause((cfg.pollSeconds || 15) * 1000, abort.signal)
          continue
        }
        try {
          const fetchImpl = (ctx.orchestrator as { fetchImpl?: typeof fetch }).fetchImpl
          const connector = hostMattermost ?? new MattermostConnector({
            baseUrl: resolved.baseUrl,
            token: resolved.token!,
            botUserId: resolved.botUserId,
            ...(resolved.teamId ? { teamId: resolved.teamId } : {}),
            ...(fetchImpl ? { fetchImpl } : {}),
          })
          await pollMattermostOnce({
            connector,
            state: source.state,
            receive: trigger => source.receive(trigger),
            report: (id, status) => source.report(id, status),
            signal: abort.signal,
          })
        } catch (error) {
          source.report('mattermost', { state: 'error', detail: String(error), at: new Date().toISOString() })
        }
        await pause((cfg.pollSeconds || 15) * 1000, abort.signal)
      }
    })()
    return () => { abort.abort() }
  })
}

