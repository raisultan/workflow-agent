/** What a Source delivers (`T9.6`): a source event, before the inbox maps it to the domain's inbound contract (`inbound.ts`). */

/** A source-verified identity. */
export interface ActorRef { source: string; id: string }
/** A thread's identity; the rule that derives `id` from a native event belongs to the source. */
export interface ThreadRef { source: string; id: string }
/** Where on a thread a message is, in the source's own terms. */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** One event a Source read: a post, comment or note, or a fact (a pipeline result, a merge). */
export interface Trigger {
  id: string
  source: string
  /** The threads the event belongs to; the first is its own. */
  threads: ThreadRef[]
  actor: ActorRef
  /** The event was written by a person, rather than a bot, CI or this workbench. */
  human: boolean
  /** The sender addressed the workbench, by mentioning it or in a direct message. */
  addressed?: 'mention' | 'direct'
  /** When it happened on the source (ISO time). */
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** Source-native details (a Jira issue's creation time, a pipeline's status, a merge). */
  meta: Record<string, unknown>
}

/** What became of a delivery: appended to the inbox, or already there. */
export type ReceiveResult = 'stored' | 'duplicate'

/** A thread jobs are bound to, which a Source watches (GitLab merge requests). */
export interface WatchedThread { key: string; ref: ThreadRef; meta: Record<string, unknown> }
