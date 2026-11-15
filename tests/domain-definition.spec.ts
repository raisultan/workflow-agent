/** The workflow definition API and run manifests (`T8.2`): validation, hashing, guards, manifest resolution and report rules. */
import { afterEach, describe, expect, it } from 'vitest'
import { COMPLETE, defineWorkflow, jobLocale, outputError, pinManifest, readPinned, resolveStages, stageTitleIn, withoutNulls, type DeclarationInput } from '../src/domain/definition.ts'
import { initialState, jobDecider } from '../src/domain/decider.ts'
import type { JobEvent, JobState } from '../src/domain/job.ts'
import { KernelDb } from '../src/kernel/db.ts'
import { testEnv } from '../src/kernel/env.ts'
import { definitionHash, Registry } from '../src/kernel/registry.ts'
import { delivery, deliveryDeclaration, PROFILE, prompts } from './fixtures/domain-workflow.ts'

const invalid = (change: (declaration: DeclarationInput) => void, promptsOverride = prompts) => {
  const declaration = deliveryDeclaration()
  change(declaration)
  return () => defineWorkflow({ id: 'delivery', version: 1, declaration, prompts: promptsOverride })
}

describe('defineWorkflow', () => {
  it('applies defaults and lists the guards its transitions name', () => {
    const definition = defineWorkflow(delivery())
    expect(definition.guards).toEqual(['review.approved'])
    const declaration = definition.declaration as ReturnType<typeof deliveryDeclaration> & { stages: { limits: { attempts: number }; checks: unknown[] }[] }
    expect(declaration.stages[0]).toMatchObject({ tools: [], checks: [], limits: { attempts: 3 } })
    expect(declaration.stages[2]!.checks).toEqual([{ id: 'tests', kind: 'command', required: true, params: { command: 'pnpm test' } },
      { id: 'lint', kind: 'command', required: false, params: {} }])
  })

  it.each([
    ['an unknown start stage', (d: DeclarationInput) => { d.start = 'nope' }, 'start stage nope is not declared'],
    ['a transition to an unknown stage', (d: DeclarationInput) => { d.transitions.push({ from: 'plan', to: 'deploy' }) }, 'transition to unknown stage deploy'],
    ['an unguarded transition before another', (d: DeclarationInput) => { d.transitions.splice(3, 1) ; d.transitions.push({ from: 'review', to: COMPLETE, guard: 'x' }) },
      'stage review has transitions after an unguarded one'],
    ['a stage with no transition', (d: DeclarationInput) => { d.transitions = d.transitions.filter(t => t.from !== 'inspect') }, 'stage inspect has no transition'],
    ['a gate on a stage with no artifact', (d: DeclarationInput) => { d.transitions[0] = { from: 'inspect', to: 'plan', gate: 'plan-approval' } },
      'gate plan-approval needs stage inspect to produce an artifact'],
    ['an unknown gate', (d: DeclarationInput) => { d.transitions[1] = { from: 'plan', to: 'implement', gate: 'other' } }, 'transition names unknown gate other'],
    ['a backtrack to an unknown stage', (d: DeclarationInput) => { d.backtracks!.push({ from: 'review', to: 'deploy', budget: 1 }) }, 'backtrack review → deploy'],
    ['a bad trigger pattern', (d: DeclarationInput) => { d.triggers[0]!.pattern = '(' }, 'is not a valid regular expression'],
    ['an unusable output schema', (d: DeclarationInput) => { d.stages[0]!.output = { type: 'nonsense' } }, 'output is not a usable JSON Schema'],
    ['duplicate stage ids', (d: DeclarationInput) => { d.stages.push({ ...d.stages[0]! }) }, 'stage ids must be unique'],
    ['an unknown field', (d: DeclarationInput) => { (d as Record<string, unknown>).extra = 1 }, 'extra'],
    ['a bad stage id', (d: DeclarationInput) => { d.stages[0]!.id = 'Inspect!' }, 'an id is lowercase letters'],
    ['an unknown egress profile', (d: DeclarationInput) => { (d.stages[0] as Record<string, unknown>).egress = 'internet' }, 'egress'],
  ])('refuses %s', (_name, change, message) => {
    expect(invalid(change)).toThrow(message)
  })

  it('refuses a stage whose instructions name a prompt the workflow does not define', () => {
    expect(invalid(() => {}, { ...prompts, review: undefined as unknown as string })).toThrow('names prompts it does not define: review')
  })

  it('hashes the same content the same way whatever the key order, and any prompt or declaration change differently', () => {
    const definition = defineWorkflow(delivery())
    const reordered = { ...definition, declaration: Object.fromEntries(Object.entries(definition.declaration as object).reverse()),
      prompts: Object.fromEntries(Object.entries(definition.prompts).reverse()) }
    expect(definitionHash(reordered)).toBe(definitionHash(definition))
    expect(definitionHash({ ...definition, prompts: { ...definition.prompts, plan: 'Write a better plan.' } })).not.toBe(definitionHash(definition))
    expect(definitionHash(defineWorkflow(delivery(1, d => { d.budgets.turns = 101 })))).not.toBe(definitionHash(definition))
  })
})

describe('run manifests', () => {
  let db: KernelDb | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('resolves each stage\'s model (stage override, else the profile default) and freezes the verdict model and policy version', () => {
    db = KernelDb.open(':memory:')
    const registry = new Registry(db, testEnv())
    registry.register(defineWorkflow(delivery()))
    const manifest = pinManifest(registry, { id: 'delivery', version: 1 }, { ...PROFILE, defaultEffort: 'medium' }, 'pv_1')
    const pinned = readPinned(registry, manifest)
    expect(pinned.extra.stages.inspect).toMatchObject({ model: 'deepseek-flash', effort: 'medium', agentPreset: 'inspector', egress: 'none', tools: [] })
    // A stage that names its own model does not inherit the profile's default effort.
    expect(pinned.extra.stages.implement).toMatchObject({ model: 'deepseek-pro', effort: 'high', egress: 'registries', tools: ['gitlab.createMr', 'gitlab.push'] })
    expect(pinned.extra).toMatchObject({ verdictModel: 'deepseek-verdict', policyVersion: 'pv_1' })
    expect(pinned.declaration.start).toBe('inspect')
    expect(pinned.prompts.plan).toBe(pinned.extra.stages.plan!.instructions)
    expect(new TextDecoder().decode(db.get<{ content: Uint8Array }>('SELECT content FROM blob WHERE sha256 = ?', pinned.prompts.plan!)!.content)).toBe('Write a plan.')
  })

  it('takes a prompt\'s variant in the deployment\'s language and pins that language; an older manifest reads as Russian (D14)', () => {
    db = KernelDb.open(':memory:')
    const registry = new Registry(db, testEnv())
    const spec = { ...delivery(), prompts: { ...delivery().prompts, 'plan.ru': 'Составь план.' } }
    registry.register(defineWorkflow(spec))
    const text = (digest: string) => new TextDecoder().decode(db!.get<{ content: Uint8Array }>('SELECT content FROM blob WHERE sha256 = ?', digest)!.content)
    const ru = readPinned(registry, pinManifest(registry, { id: 'delivery', version: 1 }, PROFILE, 'pv_1', {}, undefined, 'ru'))
    const en = readPinned(registry, pinManifest(registry, { id: 'delivery', version: 1 }, PROFILE, 'pv_1', {}, undefined, 'en'))
    expect(text(ru.extra.stages.plan!.instructions)).toBe('Составь план.')
    expect(text(en.extra.stages.plan!.instructions)).toBe('Write a plan.')
    // A prompt with no variant in the language is the base one; the language is frozen with the job.
    expect(ru.extra.stages.inspect!.instructions).toBe(en.extra.stages.inspect!.instructions)
    expect([jobLocale(ru.extra), jobLocale(en.extra)]).toEqual(['ru', 'en'])
    // A manifest pinned before D14 has no language: every job then was Russian.
    expect(jobLocale(readPinned(registry, pinManifest(registry, { id: 'delivery', version: 1 }, PROFILE, 'pv_1')).extra)).toBe('ru')
    // The definition is hashed with all its variants, whatever language a deployment picks from them; titles in other languages are optional.
    expect(definitionHash(defineWorkflow(spec))).toBe(definitionHash(defineWorkflow({ ...spec, prompts: { ...spec.prompts } })))
    expect(stageTitleIn({ title: 'Plan', titles: { ru: 'План' } }, 'ru')).toBe('План')
    expect(stageTitleIn({ title: 'Plan', titles: { ru: 'План' } }, 'en')).toBe('Plan')
    expect(stageTitleIn({ title: 'Plan' }, 'ru')).toBe('Plan')
  })

  it('keeps a stage without its own model or effort on the profile default with no effort', () => {
    const stages = resolveStages(defineWorkflow(delivery()).declaration as never, { inspect: 'a'.repeat(64), plan: 'b'.repeat(64),
      implement: 'c'.repeat(64), review: 'd'.repeat(64) }, PROFILE)
    expect(stages.review).toEqual({ model: 'deepseek-flash', agentPreset: 'reviewer', permissionPreset: 'worker', egress: 'registries', tools: [],
      instructions: 'd'.repeat(64) })
  })
})

describe('stage reports', () => {
  it('counts a top-level null as absent, so optional fields accept it and required ones still fail', () => {
    const stage = defineWorkflow(delivery()).declaration as { stages: Parameters<typeof outputError>[0][] }
    expect(withoutNulls({ a: 1, b: null, c: { d: null } })).toEqual({ a: 1, c: { d: null } })
    expect(outputError(stage.stages[0]!, { findings: 'ok', note: null })).toBeUndefined()
    expect(outputError(stage.stages[0]!, { findings: null })).toContain('findings')
  })
})

describe('guards', () => {
  it('see deeply frozen input, so a guard that writes to it faults the job instead of changing its state', () => {
    let seen: unknown
    const deps = {
      workflow: () => ({ manifestId: 'm', id: 'delivery', version: 1, hash: 'h', guards: ['review.approved'], prompts: {},
        declaration: defineWorkflow(delivery()).declaration, extra: { stages: {}, verdictModel: 'v', policyVersion: 'p' } }) as never,
      guard: () => (input: { output: Record<string, unknown> }) => { seen = input; input.output.approved = false; return true },
      policy: () => ({ senders: {}, approvers: {}, bots: {} }),
    }
    const decider = jobDecider(deps)
    let state: JobState = { ...initialState('j', { id: 'm', definitionId: 'delivery', definitionVersion: 1, definitionHash: 'h', data: null }) }
    const apply = (events: readonly JobEvent[]) => { for (const event of events) state = decider.evolve(state, event) }
    apply([{ v: 1, type: 'JobStarted', at: 0, workflowId: 'delivery', intake: { eventId: 'e', actor: { source: 'mattermost', id: 'anna' },
      threadKey: 't', basis: 'mention', workflowId: 'delivery', workflowVersion: 1, policyVersion: 'p', text: '', postedAt: 0 } },
    { v: 1, type: 'AttemptStarted', attemptId: 'j.a1', stageId: 'review', n: 1, entry: 'initial', inputs: [], artifacts: [], at: 0 }])
    expect(() => decider.decide({ kind: 'report', attemptId: 'j.a1', report: { outcome: 'completed', summary: 's', output: { approved: true } } },
      state, { jobId: 'j', now: 1, origin: { kind: 'tool', session: 's', id: 'c' } })).toThrow(TypeError)
    expect(Object.isFrozen((seen as { output: object }).output)).toBe(true)
  })
})
