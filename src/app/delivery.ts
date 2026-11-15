/** Idempotent message delivery to DSH agents across Session restarts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'workflow-agent': { kind: 'workflow-agent' } & ContextFormed
  }
}

type Seen = { ids: Set<string>; loaded?: Promise<void> }
/** The project's name before `D14`, under which older sessions recorded their delivered messages. */
const LEGACY = 'dsh-superagent'
/** The id of the message delivered under `requestId`, the same on every retry. */
export const messageId = (requestId: string) => MessageId(`workflow-agent:${requestId}`)
/** Extracts the idempotency key from current or legacy plugin message sources. */
function deliveryId(message: UserMessage): string | undefined {
  // Persisted sources may predate the current producer-specific source map.
  const source: { kind: string; plugin?: unknown; rpcId?: unknown } = message.source
  if (source.kind === 'workflow-agent' || (source.kind === 'plugin' && source.plugin === 'workflow-agent')) return message.id
  // Delivered before the rename to Workflow Agent (`D14`): the same request under the project's earlier name.
  if (source.kind === LEGACY || (source.kind === 'plugin' && source.plugin === LEGACY)) return message.id.replace(`${LEGACY}:`, 'workflow-agent:')
  // Requests admitted by the former user RPC retain their original attribution.
  if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') return messageId(source.rpcId)
}

/**
 * Delivers messages to DSH agents at most once per request ID across active and restored Sessions.
 * Tracks delivered message IDs from live Session events, persisted history, and pending inboxes so retries from `Sessions` do not duplicate messages,
 * and marks delivered messages with `workflow-agent`'s own source (`workflow-agent`) rather than user RPCs so they are never mistaken for messages written by a person.
 */
export class AgentDelivery {
  private readonly seen = new WeakMap<Session, Seen>()
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const id = deliveryId(event.data)
      if (id) this.seen.get(session)?.ids.add(id)
    })
  }
  private async history(agent: Agent): Promise<Seen> {
    let seen = this.seen.get(agent.session)
    if (!seen) { seen = { ids: new Set() }; this.seen.set(agent.session, seen) }
    const state = seen
    state.loaded ??= (async () => {
      await this.ctx.sessionPersistence.flush()
      const handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      try {
        for (let offset = 0; ; ) {
          const { events } = await handle.read(offset, 512)
          if (!events.length) break
          for (const event of events) {
            if (event.type !== 'user/message') continue
            const id = deliveryId(event.data)
            if (id) state.ids.add(id)
          }
          offset += events.length
        }
      } finally {
        await handle[Symbol.asyncDispose]()
      }
    })().catch(error => { state.loaded = undefined; throw error })
    await state.loaded
    return state
  }
  async holds(agent: Agent, requestId: string): Promise<boolean> {
    const id = messageId(requestId)
    return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
  }
  /** Delivers once to the selected inbox, or injects into history without waking the agent, and flushes Session persistence before acknowledging the producer. */
  async send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, signal: AbortSignal, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    signal.throwIfAborted()
    const seen = await this.history(agent)
    signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    authorize?.()
    const id = messageId(requestId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
    if (!seen.ids.has(id) && !pending) {
      const source = typeof mode === 'object' ? { kind: 'workflow-agent' as const, form: 'notice' as const, summary: mode.inject }
        : { kind: 'workflow-agent' as const, form: 'relay' as const }
      const message = freezeMessage({ id, role: 'user' as const, content: [{ type: 'text' as const, text }], source })
      if (typeof mode === 'object') { agent.inject(message); seen.ids.add(id) }
      else if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
    }
    accepted?.()
    await this.ctx.sessionPersistence.flush()
  }
}
