/**
 * An attempt's agent trace (`D13`, `T15.3`): what the agent said, its reasoning when the model stores it, each tool call with its
 * result, and its token usage, read from the attempt's DSH session log. The log is read through a session-persistence read handle,
 * which never writes and never takes ownership, so a running attempt can be read while the runner holds its write handle.
 */

/** One step of a trace, in the order the agent took them. */
export type TraceStep =
  | { readonly kind: 'input'; readonly seq: number; readonly at: number; readonly text: string; readonly truncated?: true }
  | { readonly kind: 'text' | 'reasoning'; readonly seq: number; readonly at: number; readonly text: string; readonly truncated?: true
      readonly usage?: TraceUsage }
  | { readonly kind: 'tool'; readonly seq: number; readonly at: number; readonly callId: string; readonly name: string; readonly args: unknown
      readonly result?: string; readonly error?: boolean; readonly durationMs?: number; readonly truncated?: true; readonly usage?: TraceUsage }
  | { readonly kind: 'end'; readonly seq: number; readonly at: number; readonly reason: string }
export interface TraceUsage { readonly input: number; readonly output: number; readonly cached: number }
export interface AgentTrace {
  readonly sessionId: string
  /** The last `TRACE_STEPS_MAX` steps. */
  readonly steps: readonly TraceStep[]
  /** How many earlier steps were left out, when any were. */
  readonly omitted?: number
  /** Why no steps could be read (`missing`: no session; `unreadable`: a log this build does not read), absent when they were. */
  readonly unavailable?: { readonly reason: 'missing' | 'unreadable'; readonly detail: string }
}

/** The longest text kept per step; the rest is cut and the step marked `truncated`. */
export const STEP_TEXT_MAX = 16_384
/** The most steps kept per trace, the newest; a long attempt's earlier steps are counted, not sent. */
export const TRACE_STEPS_MAX = 500

interface RawEvent { readonly type?: unknown; readonly seq?: unknown; readonly time?: unknown; readonly data?: unknown }
interface Block { readonly type?: unknown; readonly text?: unknown; readonly id?: unknown; readonly name?: unknown; readonly arguments?: unknown }

const cut = (text: string, max: number) => text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true as const } : { text }
/** A message's text: its text blocks, or the string itself when the content is one. */
const textOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content)
  ? (content as Block[]).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n') : ''
/** A call's arguments, with every long string cut (a `write` carries a whole file). */
function argsOf(raw: unknown, max: number): { args: unknown; truncated: boolean } {
  let truncated = false
  const capped = (value: unknown): unknown => {
    if (typeof value === 'string') { if (value.length <= max) return value; truncated = true; return `${value.slice(0, max)}…` }
    if (Array.isArray(value)) return value.map(capped)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capped(item)]))
    return value
  }
  let parsed: unknown = raw
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw) as unknown } catch { parsed = raw } }
  return { args: capped(parsed), truncated }
}
const reasoning = (type: unknown) => typeof type === 'string' && /reason|think/u.test(type)

/** Turns a DSH session log into trace steps. Unknown events are skipped, so a newer DSH adds nothing rather than failing. */
export function normalizeTrace(sessionId: string, events: readonly RawEvent[], max = STEP_TEXT_MAX, maxSteps = TRACE_STEPS_MAX): AgentTrace {
  const steps: (TraceStep & Record<string, unknown>)[] = []
  const calls = new Map<string, number>()
  const callTimes = new Map<string, number>()
  for (const event of events) {
    const seq = typeof event.seq === 'number' ? event.seq : steps.length
    const at = typeof event.time === 'number' ? event.time : 0
    const data = (event.data ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'user/message': {
        // The workbench's relayed input; the runtime's and the clock's snapshots are DSH's own, not the job's.
        const source = (data.source as { kind?: string } | undefined)?.kind
        // `dsh-superagent`: the same input, delivered before the rename to Workflow Agent (`D14`).
        if (source !== 'workflow-agent' && source !== 'dsh-superagent') break
        steps.push({ kind: 'input', seq, at, ...cut(textOf(data.content), max) })
        break
      }
      case 'assistant/message': {
        const message = data.message as { content?: unknown } | undefined
        const raw = data.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined
        let usage: TraceUsage | undefined = raw ? { input: raw.inputTokens ?? 0, output: raw.outputTokens ?? 0, cached: raw.cacheReadTokens ?? 0 } : undefined
        for (const block of Array.isArray(message?.content) ? message!.content as Block[] : []) {
          const first = usage ? { usage } : {}
          if ((block.type === 'text' || reasoning(block.type)) && typeof block.text === 'string' && block.text.trim()) {
            steps.push({ kind: block.type === 'text' ? 'text' : 'reasoning', seq, at, ...cut(block.text, max), ...first })
            usage = undefined
          } else if (block.type === 'tool-call' && typeof block.id === 'string') {
            calls.set(block.id, steps.length)
            const { args, truncated } = argsOf(block.arguments, max)
            steps.push({ kind: 'tool', seq, at, callId: block.id, name: String(block.name ?? 'tool'), args, ...truncated ? { truncated: true } : {}, ...first })
            usage = undefined
          }
        }
        break
      }
      case 'tool/call':
        if (typeof data.callId === 'string') callTimes.set(data.callId, at)
        break
      case 'tool/result': {
        const message = data.message as { toolCallId?: string; content?: unknown; isError?: boolean } | undefined
        const index = message?.toolCallId ? calls.get(message.toolCallId) : undefined
        if (index === undefined) break
        const started = callTimes.get(message!.toolCallId!) ?? steps[index]!.at
        const result = cut(textOf(message!.content), max)
        steps[index] = { ...steps[index]!, result: result.text, ...result.truncated ? { truncated: true } : {}, ...message!.isError ? { error: true } : {},
          durationMs: Math.max(0, at - started) } as TraceStep & Record<string, unknown>
        break
      }
      case 'turn/end': {
        const reason = data.reason as { kind?: string; reason?: { kind?: string } } | undefined
        steps.push({ kind: 'end', seq, at, reason: [reason?.kind, reason?.reason?.kind].filter(Boolean).join(': ') || 'ended' })
        break
      }
      default: break
    }
  }
  const omitted = Math.max(0, steps.length - maxSteps)
  return omitted ? { sessionId, steps: steps.slice(omitted), omitted } : { sessionId, steps }
}

/** The part of DSH's session persistence a trace needs. */
export interface SessionReader {
  open(id: never, access: 'read'): Promise<{ read(): Promise<{ readonly events: readonly unknown[] }>; close?(): Promise<void> | void
    [Symbol.asyncDispose]?(): Promise<void> }>
}

/** Reads a session's log through a read handle and normalizes it; a missing or unreadable session is reported, not thrown. */
export async function readTrace(persistence: SessionReader, sessionId: string): Promise<AgentTrace> {
  let handle: Awaited<ReturnType<SessionReader['open']>>
  try {
    handle = await persistence.open(sessionId as never, 'read')
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const detail = error instanceof Error ? error.message : String(error)
    return { sessionId, steps: [], unavailable: { reason: /NotFound/u.test(name) || /no durable log|not found/iu.test(detail) ? 'missing' : 'unreadable', detail } }
  }
  try {
    const { events } = await handle.read()
    return normalizeTrace(sessionId, events as RawEvent[])
  } catch (error) {
    return { sessionId, steps: [], unavailable: { reason: 'unreadable', detail: error instanceof Error ? error.message : String(error) } }
  } finally {
    await (handle.close ? handle.close() : handle[Symbol.asyncDispose]?.())
  }
}
