/** What a Source plugin gets from the host (`T9.8`): its configuration, delivery to the inbox, its cursors, watched threads, health. */
import type { Key } from '../kv.ts'
import { fill } from '../infra/text.ts'
import type { SourceRegistry } from './registry.ts'
import type { ReceiveResult, Trigger, WatchedThread } from './types.ts'

/** Fixed English health templates (`{name}` placeholders). */
export const HEALTH_TEXT = {
  sourceOff: 'Off',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string> }
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
}

/** The host Source plugins inject as `orchestrator`. */
export interface SourceHost {
  readonly sources: SourceRegistry
  /** The context of one Source kind; its `report` writes only the health entries the kind declares. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}

/** What a Source kind may do. */
export interface SourceContext {
  /** Settles once the workbench has started; Sources poll only then. */
  readonly ready: Promise<void>
  /** A Source's configuration while it is installed. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** Appends an event to the inbox; a Source awaits it before moving its cursor, so a crash between the two re-reads rather than loses. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  /** The Source's own records (its cursors); setting `undefined` removes one. */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void }
  /** Threads jobs are bound to, which the Source watches (GitLab merge requests). */
  threads: { subscribed(source: string): WatchedThread[] }
  /** Reports one of this kind's declared health entries; throws for an undeclared one. */
  report(entry: string, health: Health): void
}

export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }): SourceContext => host.context(kind)
