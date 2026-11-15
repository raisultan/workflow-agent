/** The bundle's patch, read with the entry-list dialect DSH reads bundle patches with, and the stage presets workflows name. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defineWorkflow, type Declaration } from '../src/domain/definition.ts'
import { standardDelivery } from '../src/workflows/standard-delivery.ts'

const declaration = defineWorkflow(standardDelivery()).declaration as Declaration
const preset = (stage: string) => declaration.stages.find(item => item.id === stage)!
const INSPECTOR_PRESET = preset('inspect').agentPreset, PLANNER_PRESET = preset('plan').agentPreset
const IMPLEMENTER_PRESET = preset('implement').agentPreset, REVIEWER_PRESET = preset('review').agentPreset
const STAGE_PRESETS = [INSPECTOR_PRESET, PLANNER_PRESET, IMPLEMENTER_PRESET, REVIEWER_PRESET]

interface Row { id?: string; name: string; disabled?: unknown; config?: Record<string, unknown> & { plugins?: Row[] } | Row[] }
/** The patch as DSH reads it: Cordis's include plugin parses `!!js` scalars, and applies the inserts to an entry list. */
async function patched(): Promise<Row[]> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema, applyEntryPatches } = await import(include) as {
    entryListSchema: unknown; applyEntryPatches(data: Row[], patches: unknown[], warn: (message: string) => void): Row[] }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  const patches = yaml.load(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as unknown[]
  const warnings: string[] = []
  const base: Row[] = [
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
    { id: 'permission', name: '@deepseek-ai/dsh-permission-presets' },
    // DSH 0.2.2's base ships read-before-write disabled.
    { id: 'fs-observation-policy', name: '@deepseek-ai/dsh-fs-observation-policy', disabled: true },
    { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
  ]
  const rows = applyEntryPatches(base, patches, message => { warnings.push(message) })
  expect(warnings).toEqual([])
  return rows
}
/** Every plugin row of a preset, those inside groups too. */
const flat = (rows: readonly Row[]): Row[] => rows.flatMap(row => [row, ...Array.isArray(row.config) ? flat(row.config) : []])

/** A preset the patch defines, by its id. */
const presetOf = (rows: readonly Row[], id: string) => rows.map(row => row.config as { id?: string; order?: number; plugins: Row[] })
  .find(config => config?.id === id)!

it('defines the 4 stage presets the workflows name, with a background-capable shell, and no V1 connector tool plugins', async () => {
  const rows = await patched()
  expect(rows.map(row => row.id)).toEqual([
    'agent-default-model',
    'llm-pi-ai',
    'permission',
    'fs-observation-policy',
    'sandbox',
    'workflow-agent',
    'workflow-agent-jira',
    'workflow-agent-mattermost',
    'workflow-agent-gitlab',
    'workflow-agent-inspector-preset',
    'workflow-agent-planner-preset',
    'workflow-agent-implementer-preset',
    'workflow-agent-reviewer-preset',
  ])
  expect(rows.find(row => row.id === 'agent-default-model')?.config).toEqual({
    // The default model is the LiteLLM route's own model, so both follow `LITELLM_MODEL` (PRD §3 rule 3).
    provider: 'litellm',
    model: { __jsExpr: "process.env.LITELLM_MODEL || 'deepseek-v4-pro'" },
  })
  const litellm = (rows.find(row => row.id === 'llm-pi-ai')?.config as { providers?: Record<string, unknown> })?.providers?.litellm
  expect(litellm).toMatchObject({
    displayName: 'LiteLLM Gateway',
    apiKeyEnv: 'LITELLM_API_KEY',
    api: 'openai-completions',
    baseURL: { __jsExpr: "process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000/v1'" },
  })
  expect(rows.find(row => row.id === 'workflow-agent-jira')?.disabled).toBe(true)
  expect(rows.find(row => row.id === 'workflow-agent-mattermost')?.disabled).toBe(true)
  expect(rows.find(row => row.id === 'workflow-agent-gitlab')?.disabled).toBe(true)

  // Every stage preset includes persona, instructions, time-context, fs, fs-search, skills, compaction, and connector tools, and omits interactive/ptc plugins.
  for (const presetId of STAGE_PRESETS) {
    const preset = presetOf(rows, presetId)
    expect(preset?.id).toBe(presetId)
    const plugins = flat(preset.plugins)
    const named = (name: string) => plugins.filter(row => row.name === name).map(row => row.config)
    for (const name of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-skill',
      '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction-tool-result-pruner',
      '@deepseek-ai/dsh-agent-instructions']) expect(named(name).length, `${presetId}:${name}`).toBeGreaterThan(0)
    const names = plugins.map(row => row.name)
    for (const name of ['@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-plugin-manager/tools',
      '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal',
      '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names).not.toContain(name)
  }

  // Inspector & Planner are read-only on fs (`write: false, edit: false`) and do not mount shell, jobs, or subagents;
  // Implementer & Reviewer have full fs and 5s shell/job timeouts, and no web tools or subagents (T10.2).
  const inspectorPlugins = flat(presetOf(rows, INSPECTOR_PRESET).plugins)
  const plannerPlugins = flat(presetOf(rows, PLANNER_PRESET).plugins)
  const implementerPlugins = flat(presetOf(rows, IMPLEMENTER_PRESET).plugins)
  const reviewerPlugins = flat(presetOf(rows, REVIEWER_PRESET).plugins)

  const configOf = (plugins: Row[], name: string) => plugins.filter(row => row.name === name).map(row => row.config)
  expect(configOf(inspectorPlugins, '@deepseek-ai/dsh-tool-fs')).toEqual([{ write: false, edit: false }])
  expect(configOf(plannerPlugins, '@deepseek-ai/dsh-tool-fs')).toEqual([{ write: false, edit: false }])
  expect(configOf(implementerPlugins, '@deepseek-ai/dsh-tool-fs')).toEqual([undefined])
  expect(configOf(reviewerPlugins, '@deepseek-ai/dsh-tool-fs')).toEqual([undefined])

  for (const roPlugins of [inspectorPlugins, plannerPlugins]) {
    const roNames = roPlugins.map(row => row.name)
    for (const name of ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control']) {
      expect(roNames).not.toContain(name)
    }
  }
  expect(inspectorPlugins.map(row => row.name)).not.toContain('@deepseek-ai/dsh-tool-todo')
  expect(configOf(plannerPlugins, '@deepseek-ai/dsh-tool-todo')).toEqual([{ allowParallelInProgress: true }])

  for (const rwPlugins of [implementerPlugins, reviewerPlugins]) {
    expect(configOf(rwPlugins, '@deepseek-ai/dsh-bash-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
    expect(configOf(rwPlugins, '@deepseek-ai/dsh-pwsh-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
    expect(configOf(rwPlugins, '@deepseek-ai/dsh-tool-jobs')).toEqual([{ waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 }])
    // web_search and web_fetch run on the host, outside the egress proxy; a subagent runs outside the stage's tools and sandbox.
    for (const name of ['@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-tool-workflow']) {
      expect(rwPlugins.map(row => row.name)).not.toContain(name)
    }
    expect(configOf(rwPlugins, '@deepseek-ai/dsh-tool-todo')).toEqual([{ allowParallelInProgress: true }])
  }

  // The stage runner gives every session the connector read tools and its stage's safe-output tools; no preset carries them.
  for (const plugins of [inspectorPlugins, plannerPlugins, implementerPlugins, reviewerPlugins]) {
    expect(plugins.map(row => row.name).filter(name => name.startsWith('workflow-agent/'))).toEqual([])
  }
})

it('pins read-only stages to read-only and writing stages to workspace-write, and never offers danger-full-access', async () => {
  const rows = await patched()
  const presets = (rows.find(row => row.id === 'permission')?.config as { presets: Record<string, { sandbox: string; approval: string }> }).presets
  const sandbox = (stage: string) => presets[preset(stage).permissionPreset]
  expect(sandbox('inspect')).toMatchObject({ sandbox: 'read-only', approval: 'never' })
  expect(sandbox('plan')).toMatchObject({ sandbox: 'read-only', approval: 'never' })
  expect(sandbox('implement')).toMatchObject({ sandbox: 'workspace-write', approval: 'never' })
  expect(sandbox('review')).toMatchObject({ sandbox: 'workspace-write', approval: 'never' })
  expect(Object.keys(presets)).not.toContain('dsh-superagent-router')
  expect(Object.values(presets).map(item => item.sandbox)).not.toContain('danger-full-access')
  // Every agent preset a stage names is one the patch defines.
  for (const stage of declaration.stages) expect(presetOf(rows, stage.agentPreset), stage.agentPreset).toBeDefined()
})
it('keeps read-before-write on, which DSH 0.2.2 ships disabled', async () => {
  const row = (await patched()).find(item => item.id === 'fs-observation-policy')
  expect(row?.disabled).toBe(false)
})

it('declares the services the plugin waits for in a form Cordis reads as service names', async () => {
  const { Inject } = await import('@deepseek-ai/cordis')
  const { inject } = await import('../src/index.ts')
  // An object would map its keys to services: `{ required, optional }` made the plugin wait for services named "required" and "optional".
  expect(Array.isArray(inject)).toBe(true)
  expect(Object.keys(Inject.resolve(inject))).toEqual(['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets',
    'tools', 'systemPrompt', 'skills', 'llm', 'subprocess'])
})

it('runs every confined command through the workbench\'s sandbox wrapper when the image names it (T10.3)', async () => {
  const row = (await patched()).find(item => item.id === 'sandbox')!
  expect(row.name).toBe('@deepseek-ai/dsh-sandbox-local')
  const config = row.config as Record<string, { __jsExpr: string }>
  const evaluate = (expression: string, env: Record<string, string>) => new Function('process', `return (${expression})`)({ env, execPath: '/usr/local/bin/node' }) as unknown
  const wrapper = { WORKBENCH_SANDBOX_WRAPPER: '/workspace/lib/sandbox-wrapper.js' }
  expect(evaluate(config.runnerCommand!.__jsExpr, wrapper)).toEqual(['/usr/local/bin/node', '/workspace/lib/sandbox-wrapper.js'])
  // DSH requires failure signatures with a runner command; the wrapper prints its refusals with this prefix.
  expect(evaluate(config.runnerFailureSignatures!.__jsExpr, wrapper)).toEqual(['workbench-sandbox: ', 'bwrap: '])
  expect(evaluate(config.runnerCommand!.__jsExpr, {})).toEqual([])
  expect(evaluate(config.runnerFailureSignatures!.__jsExpr, {})).toEqual([])
})

it('keeps no web or subagent tool in what a stage session may use (T10.2)', async () => {
  const { WORK_TOOLS } = await import('../src/app/workbench-runtime.ts')
  for (const name of ['web_search', 'web_fetch', 'subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent', 'list_subagent_models', 'apply_patch']) {
    expect(WORK_TOOLS).not.toContain(name)
  }
})
