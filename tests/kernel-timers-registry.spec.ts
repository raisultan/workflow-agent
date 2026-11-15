/** Timers (`T7.8`), the registry and run manifests (`T7.10`), and recovery after a restart (`T7.9`). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { EffectHandler } from '../src/kernel/effects.ts'
import { testEnv } from '../src/kernel/env.ts'
import { Kernel } from '../src/kernel/kernel.ts'
import { Registry, canonicalJson, definitionHash, type WorkflowDefinition } from '../src/kernel/registry.ts'
import { Timers } from '../src/kernel/timers.ts'
import { counterDecider, counterKernel, counterView, manifest, type CounterCommand, type CounterEvent, type CounterState } from './fixtures/kernel-decider.ts'

const timer = (id: string) => ({ kind: 'timer' as const, id })
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kernel-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('fires a due timer once as a command, never one that was cancelled or replaced', () => {
  const { engine, db, env } = counterKernel()
  engine.create('j1', manifest(), { kind: 'remind', at: env.clock.now() + 1000 }, timer('c'))
  engine.submit('j1', { kind: 'remind', at: env.clock.now() + 5000 }, timer('d'))
  const timers = new Timers({ db, env, jobs: engine })
  expect(timers.fireDue()).toBe(0)
  env.clock.advance(1000)
  expect(timers.fireDue()).toBe(0)
  expect(timers.nextDue()).toBe(env.clock.now() + 4000)
  env.clock.advance(4000)
  expect(timers.fireDue()).toBe(1)
  expect(timers.fireDue()).toBe(0)
  expect(engine.job('j1')!.state.reminded).toBe(1)
  expect(db.all('SELECT status FROM timer ORDER BY due_at')).toEqual([{ status: 'cancelled' }, { status: 'fired' }])
  engine.submit('j1', { kind: 'remind', at: env.clock.now() + 10 }, timer('e'))
  engine.submit('j1', { kind: 'close' }, timer('f'))
  env.clock.advance(10)
  expect(timers.fireDue()).toBe(0)
})

const definition = (overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  id: 'delivery', version: 1, declaration: { stages: ['inspect', 'plan'], guards: { plan: 'hasSteps' } },
  prompts: { inspect: 'Read the issue.', plan: 'Write the plan.' }, guards: ['hasSteps'], ...overrides })

it('hashes a definition canonically and refuses the same version with other content, also after a restart', () => {
  expect(definitionHash(definition({ declaration: { b: 1, a: [2, { d: 3, c: 4 }] } })))
    .toBe(definitionHash(definition({ declaration: { a: [2, { c: 4, d: 3 }], b: 1 } })))
  expect(() => canonicalJson({ a: () => 1 })).toThrow(/only JSON/)
  const path = join(dir, 'workbench.sqlite')
  const first = new Kernel({ path, decider: counterDecider, owners: [counterView], env: testEnv() })
  const dispose = first.registry.register(definition())
  expect(() => first.registry.register(definition())).toThrow(/registered already/)
  dispose()
  expect(() => first.registry.register(definition({ prompts: { inspect: 'Changed.', plan: 'Write the plan.' } }))).toThrow(/without a new version/)
  first.close()
  const second = new Kernel({ path, decider: counterDecider, owners: [counterView], env: testEnv() })
  second.registry.register(definition())
  second.registry.register(definition({ version: 2, prompts: { inspect: 'Read it twice.', plan: 'Plan.' } }))
  expect(second.registry.definition('delivery')!.version).toBe(2)
  expect(second.registry.definition('delivery', 1)!.prompts.inspect).toBe('Read the issue.')
  second.close()
})

it('makes manifests that keep their content after the definition changes, and names the guards a job needs', () => {
  const { db, env, engine } = counterKernel()
  const registry = new Registry(db, env)
  registry.register(definition())
  const pinned = registry.manifest('delivery', 1, { models: { plan: 'deepseek-v4-pro' } })
  engine.create('j1', pinned, { kind: 'add', by: 1 }, timer('c'))
  registry.register(definition({ version: 2, prompts: { inspect: 'New text.', plan: 'New plan.' } }))
  const stored = engine.manifest(pinned.id)!
  expect(registry.content(stored)).toEqual({ declaration: definition().declaration, prompts: definition().prompts, guards: ['hasSteps'],
    extra: { models: { plan: 'deepseek-v4-pro' } } })
  expect(registry.missingGuards(stored)).toEqual(['hasSteps'])
  const dispose = registry.registerGuard('hasSteps', () => true)
  expect(registry.missingGuards(stored)).toEqual([])
  dispose()
  expect(() => registry.manifest('delivery', 9, {})).toThrow(/not registered/)
})
it('recovers after a crash: interrupts running stages, reconciles other writes, fires overdue timers, routes waiting events, and parks jobs missing a guard', async () => {
  const path = join(dir, 'workbench.sqlite')
  const env = testEnv()
  const first = new Kernel<CounterState, CounterCommand, CounterEvent>({ path, decider: counterDecider, owners: [counterView], env })
  first.registry.register(definition())
  first.engine.create('j1', first.registry.manifest('delivery', 1, {}), { kind: 'work', id: 'att-1' }, timer('a'))
  first.engine.submit('j1', { kind: 'post', text: 'hi' }, timer('b'))
  first.engine.submit('j1', { kind: 'remind', at: env.clock.now() + 1000 }, timer('c'))
  first.engine.create('j2', manifest('m-plain', {}), { kind: 'add', by: 1 }, timer('d'))
  first.inbox.append({ source: 'mattermost', externalId: 'p1', human: true, payload: { text: 'later' } })
  // The process dies with both effects running.
  first.db.run("UPDATE effect SET status = 'running', attempts = 1")
  first.close()

  env.clock.advance(5000)
  const second = new Kernel<CounterState, CounterCommand, CounterEvent>({ path, decider: counterDecider, owners: [counterView], env })
  const writes: string[] = []
  const post: EffectHandler<{ text: string }> = { idempotent: false, limit: () => 1,
    run: async (payload, key) => { writes.push(key); return { ok: payload } },
    reconcile: async () => ({ absent: true }) }
  second.effects.register('post', post)
  second.effects.register('work', { idempotent: true, long: true, limit: () => 1, run: () => new Promise(() => {}), cancel: async () => {} })
  second.registry.register(definition())
  const routed: string[] = []
  const report = second.recover({ route: event => { routed.push(event.externalId) }, active: status => status === 'open' })
  expect(report).toEqual({ interrupted: 1, unknown: 1, firedTimers: 1, routed: 1, parked: ['j1'] })
  expect(routed).toEqual(['p1'])
  expect(second.engine.job('j1')!.state).toMatchObject({ failed: ['interrupted by a restart'], reminded: 1 })
  // One pass reconciles the unknown write and finds it absent; the next runs it again.
  await second.effects.dispatch()
  expect(writes).toEqual([])
  await second.effects.dispatch()
  expect(writes).toHaveLength(1)
  expect(second.engine.job('j1')!.state.posted).toEqual(['hi'])
  second.registry.registerGuard('hasSteps', () => true)
  expect(second.recover({ active: status => status === 'open' }).parked).toEqual([])
  second.close()
})

it('stops without waiting for a running stage, which returns as interrupted after the restart', async () => {
  const path = join(dir, 'workbench.sqlite')
  const env = testEnv()
  const open = () => {
    const kernel = new Kernel<CounterState, CounterCommand, CounterEvent>({ path, decider: counterDecider, owners: [counterView], env, pollMs: 10_000 })
    kernel.effects.register('work', { idempotent: true, long: true, limit: () => 1, run: () => new Promise(() => {}), cancel: async () => {} })
    return kernel
  }
  const first = open()
  first.start()
  first.engine.create('j1', manifest(), { kind: 'work', id: 'att-1' }, timer('a'))
  await Promise.resolve()
  expect(first.db.get<{ status: string }>('SELECT status FROM effect')!.status).toBe('running')
  await first.stop()
  first.close()
  const second = open()
  expect(second.recover().interrupted).toBe(1)
  expect(second.engine.job('j1')!.state.failed).toEqual(['interrupted by a restart'])
  second.close()
})

it('refuses to start again after a stop, since late stage results are no longer settled', async () => {
  const kernel = new Kernel({ path: ':memory:', decider: counterDecider, owners: [counterView], env: testEnv() })
  kernel.start()
  await kernel.stop()
  expect(() => kernel.start()).toThrow('A stopped kernel cannot start again')
  kernel.close()
})
