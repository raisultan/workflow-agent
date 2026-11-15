/** A small decider for kernel tests: a counter job that posts messages, sets reminders, and can be told to throw. */
import { KernelDb, type SchemaOwner } from '../../src/kernel/db.ts'
import { Effects } from '../../src/kernel/effects.ts'
import { Engine, type Decider, type KernelCommand, type RunManifest } from '../../src/kernel/engine.ts'
import { testEnv } from '../../src/kernel/env.ts'
import { Projections, type Projection } from '../../src/kernel/projections.ts'

export interface CounterState { n: number; status: 'open' | 'closed' | 'cancelled'; posted: string[]; failed: string[]; reminded: number }
export type CounterCommand =
  | { kind: 'add'; by: number }
  | { kind: 'post'; text: string; conversation?: string }
  | { kind: 'remind'; at: number }
  | { kind: 'close' }
  | { kind: 'cancel' }
  | { kind: 'boom' }
  | { kind: 'noop' }
  | { kind: 'work'; id: string }
  | { kind: 'stop'; effect: string; key: string }
export type CounterEvent =
  | { type: 'added'; by: number }
  | { type: 'requested'; text: string; conversation: string }
  | { type: 'posted'; effectId: string; text: string }
  | { type: 'postFailed'; effectId: string; reason: string }
  | { type: 'reminderSet'; at: number }
  | { type: 'reminded' }
  | { type: 'closed' }
  | { type: 'cancelled' }
  | { type: 'workRequested'; id: string }
  | { type: 'stopRequested'; effect: string; key: string }

export const counterDecider: Decider<CounterState, CounterCommand, CounterEvent> = {
  initial: () => ({ n: 0, status: 'open', posted: [], failed: [], reminded: 0 }),
  decide(command: CounterCommand | KernelCommand, state) {
    if (command.kind === 'boom') throw new Error('the rules have a bug')
    if (command.kind === 'cancel') return state.status === 'cancelled' ? { rejected: 'already cancelled' } : [{ type: 'cancelled' }]
    if (state.status !== 'open') return { rejected: `job is ${state.status}` }
    switch (command.kind) {
      case 'add': return [{ type: 'added', by: command.by }]
      case 'post': return [{ type: 'requested', text: command.text, conversation: command.conversation ?? 'main' }]
      case 'remind': return [{ type: 'reminderSet', at: command.at }]
      case 'close': return [{ type: 'closed' }]
      case 'noop': return []
      case 'work': return [{ type: 'workRequested', id: command.id }]
      case 'stop': return [{ type: 'stopRequested', effect: command.effect, key: command.key }]
      case 'effect.succeeded': return [{ type: 'posted', effectId: command.effectId, text: String((command.result as { text?: string })?.text ?? '') }]
      case 'effect.failed': return [{ type: 'postFailed', effectId: command.effectId, reason: command.reason }]
      case 'timer.fired': return state.reminded > 0 && command.subject !== 'reminder' ? { rejected: 'stale timer' } : [{ type: 'reminded' }]
    }
  },
  evolve(state, event) {
    switch (event.type) {
      case 'added': return { ...state, n: state.n + event.by }
      case 'posted': return { ...state, posted: [...state.posted, event.text] }
      case 'postFailed': return { ...state, failed: [...state.failed, event.reason] }
      case 'reminded': return { ...state, reminded: state.reminded + 1 }
      case 'closed': return { ...state, status: 'closed' }
      case 'cancelled': return { ...state, status: 'cancelled' }
      default: return state
    }
  },
  effects: event => event.type === 'requested' ? [{ kind: 'post', payload: { text: event.text }, orderingKey: event.conversation }]
    : event.type === 'workRequested' ? [{ kind: 'work', payload: { text: event.id }, orderingKey: event.id }]
    : event.type === 'stopRequested' ? [{ cancel: { kind: event.effect, orderingKey: event.key } }] : [],
  timers: event => event.type === 'reminderSet' ? [{ arm: { kind: 'remind', subject: 'reminder', dueAt: event.at } }]
    : event.type === 'closed' || event.type === 'cancelled' ? [{ cancel: { kind: 'remind', subject: 'reminder' } }] : [],
  status: state => state.status,
  acceptsWhenFaulted: command => command.kind === 'cancel',
}

export const counterView: SchemaOwner = { owner: 'test', migrations: [{ version: 1, up: 'CREATE TABLE counter_view (job_id TEXT PRIMARY KEY, n INTEGER NOT NULL)' }] }
export const counterProjection: Projection<CounterEvent> = {
  name: 'counter_view',
  tables: ['counter_view'],
  apply(event, jobId, db) {
    if (event.type !== 'added') return
    db.run('INSERT INTO counter_view (job_id, n) VALUES (?, ?) ON CONFLICT (job_id) DO UPDATE SET n = n + excluded.n', jobId, event.by)
  },
}

export const manifest = (id = 'm1', data: unknown = { stages: ['one'] }): RunManifest =>
  ({ id, definitionId: 'counter', definitionVersion: 1, definitionHash: 'h1', data })

/** A kernel over `path` (or memory) with the counter decider and projection. */
export function counterKernel(path = ':memory:', seed = 1) {
  const env = testEnv(seed)
  const db = KernelDb.open(path, [counterView])
  const projections = new Projections<CounterEvent>(db)
  projections.register(counterProjection)
  let commits = 0
  const cancelled: string[][] = []
  const engine = new Engine({ db, env, decider: counterDecider, projections, onCommit: () => { commits++ },
    onCancelRunning: ids => { cancelled.push([...ids]); void effects.cancelRunning(ids) } })
  const effects = new Effects({ db, env, jobs: engine, baseBackoffMs: 1000 })
  return { env, db, projections, engine, effects, commits: () => commits, cancelled }
}
