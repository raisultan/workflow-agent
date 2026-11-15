/**
 * Sources to the inbox (`T9.6`): what a Source delivers becomes an inbox event, appended durably before the Source moves its
 * cursor (each Source awaits delivery before it does). The event's thread key, actor, time and payload follow the domain's inbound
 * contract (`router.ts`):
 *
 * - a person's post or comment is a `message`, `addressed` only by an explicit mention or a direct message (`A18`), timed at its
 *   creation on the source (a Jira issue at its creation, not its last update);
 * - a merged merge request and a pipeline result are `fact`s, never messages, so they cannot answer a gate;
 * - GitLab has no workbench identity (it runs on a person's token), so a GitLab note is never addressed, and the workbench's own
 *   notes are recognized by the hidden marker its writers end them with.
 */
import type { Trigger } from '../sources/types.ts'
import type { InboxEvent, InboxInput } from '../kernel/inbox.ts'
import { threadKey } from './threads.ts'

/** The marker the workbench's own GitLab notes end with, on a line of its own (a quote of one starts with `>`). */
const OWN_NOTE = /(?:^|\n)<!-- workbench:[^\n]* -->\s*$/u

/** The V2 thread key of a Source's thread id. */
export function inboundThread(source: string, id: string): string | undefined {
  if (source === 'mattermost') {
    const [channelId, rootId] = id.split(':')
    return channelId ? threadKey({ source: 'mattermost', channelId, ...rootId ? { rootId } : {} }) : undefined
  }
  if (source === 'jira') return /^[A-Z][A-Z0-9_]*-\d+$/u.test(id) ? threadKey({ source: 'jira', issueKey: id }) : undefined
  if (source === 'gitlab') {
    const match = /^(.+)!mr_(\d+)$/u.exec(id)
    return match ? threadKey({ source: 'gitlab', project: match[1]!, mrIid: Number(match[2]) }) : undefined
  }
  return undefined
}

const time = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

/** The inbox event of a Source's delivery. */
export function inboxInput(trigger: Trigger): InboxInput {
  const meta = trigger.meta ?? {}
  const thread = trigger.threads[0]
  const key = thread ? inboundThread(thread.source, thread.id) : undefined
  const at = time(trigger.at, 0)
  const base = { source: trigger.source, externalId: trigger.id, ...key ? { threadKey: key } : {}, actor: trigger.actor, occurredAt: at }
  if (meta.mrState === 'merged') {
    return { ...base, human: false, payload: { kind: 'fact', fact: 'mr_merged', data: { pipelineStatus: meta.pipelineStatus ?? null } } }
  }
  if (meta.mrState === 'closed') return { ...base, human: false, payload: { kind: 'fact', fact: 'mr_closed', data: {} } }
  if (typeof meta.pipelineStatus === 'string') {
    return { ...base, human: false, payload: { kind: 'fact', fact: 'pipeline', data: { status: meta.pipelineStatus } } }
  }
  const addressed = trigger.source === 'gitlab' ? 'none' : trigger.addressed ?? 'none'
  const postedAt = trigger.source === 'jira' && typeof meta.createdAt === 'string' && !/_comment_/u.test(trigger.id) ? time(meta.createdAt, at) : at
  // A merge request note's discussion: an answer to it goes under it (`replyTo`).
  const replyTo = trigger.source === 'gitlab' && typeof meta.discussionId === 'string' ? meta.discussionId : undefined
  return { ...base, human: trigger.human, payload: { kind: 'message', text: trigger.text, addressed, postedAt, ...replyTo ? { replyTo } : {} } }
}

/** Whether an inbox event is the workbench's own GitLab note. */
export function ownPost(event: InboxEvent): boolean {
  if (event.source !== 'gitlab') return false
  const text = (event.payload as { text?: unknown } | null)?.text
  return typeof text === 'string' && OWN_NOTE.test(text)
}
