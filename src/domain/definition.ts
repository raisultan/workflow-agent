/**
 * The workflow definition API (`T8.2`). A workflow is declarative JSON data, validated with `zod` when it is defined: its triggers,
 * stages, transitions, approval gates, backtrack edges and budgets. Stage instructions are prompt texts, named in the declaration
 * and hashed with it. The only code a workflow needs is its guards: pure functions named by transitions and registered with the
 * kernel's registry. A job runs on the run manifest it pinned at intake, which also freezes each stage's resolved model and
 * reasoning effort (`D9`), the verdict model and the policy version, so later changes to any of them affect only new jobs.
 */
import { z } from 'zod'
import type { RunManifest } from '../kernel/engine.ts'
import { sha256Hex } from '../kernel/projections.ts'
import type { Registry, WorkflowDefinition } from '../kernel/registry.ts'
import { RepositoryProfileSchema, type RepositoryProfile } from './repositories.ts'

/** The transition target that completes the job. */
export const COMPLETE = '$complete'

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/, 'an id is lowercase letters, digits, "-" and "_", starting with a letter')
const Count = z.number().int().min(1)

const LimitsSchema = z.object({
  /** Attempts of the stage before the job blocks; each retry, interruption or failed check uses one. */
  attempts: Count.default(3),
  /** Per attempt: agent turns, tokens, and wall-clock time. An attempt that exceeds one is stopped and counts as failed. */
  turns: Count,
  tokens: Count,
  wallClockMs: z.number().int().min(1000),
}).strict()

const CheckSchema = z.object({
  id: Id,
  /** The check kind a contributor plugin runs, such as `command` or `gitlab-ci`. */
  kind: z.string().min(1),
  /** A failed required check fails the attempt; an optional one is recorded only. */
  required: z.boolean().default(true),
  params: z.record(z.string(), z.unknown()).default({}),
  /**
   * The check runs only for jobs whose frozen parameter `parameter` equals `equals` (for example the repository's `ci`,
   * `T11.1`), so a job's check list is fixed when its manifest is pinned. A job without the parameter runs the check.
   */
  when: z.object({ parameter: z.string().min(1), equals: z.string() }).strict().optional(),
}).strict()

const StageSchema = z.object({
  id: Id,
  title: z.string().min(1),
  /** The title in other languages, by locale (`ru`); the deployment's language picks one, else `title` (`D14`). No default, so a
   * definition without it keeps its hash. */
  titles: z.record(z.string(), z.string().min(1)).optional(),
  agentPreset: z.string().min(1),
  permissionPreset: z.string().min(1),
  /** The stage's own model and reasoning effort; the profile's defaults otherwise (`D9`). */
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  /** `none`: no network. `registries`: public package registries through the proxy (`D8`, decision 10). */
  egress: z.enum(['none', 'registries']),
  /** Safe-output capabilities: the external writes this stage may request, such as `gitlab.createMr`. */
  tools: z.array(z.string().min(1)).default([]),
  /** JSON Schema of a completed report's `output`. */
  output: z.record(z.string(), z.unknown()),
  /** The name of the prompt holding the stage's instructions. */
  instructions: z.string().min(1),
  /** The artifact kind a completed report produces (for example `plan`); an approval gate needs one. */
  artifact: Id.optional(),
  checks: z.array(CheckSchema).default([]),
  limits: LimitsSchema,
  /** Question rounds the stage may open per visit (the first and its follow-ups); 0 forbids questions. */
  questionRounds: z.number().int().min(0).default(1),
}).strict()

const TransitionSchema = z.object({
  from: Id,
  to: z.union([Id, z.literal(COMPLETE)]),
  /** A registered pure guard; the first transition from a stage whose guard passes (or that has none) is taken. */
  guard: z.string().min(1).optional(),
  /** An approval gate on the stage's artifact revision that must be approved before moving on. */
  gate: Id.optional(),
}).strict()

const BacktrackSchema = z.object({ from: Id, to: Id, budget: Count }).strict()

const GateSchema = z.object({
  id: Id,
  kind: z.literal('approval'),
  /** One reminder after this long without a resolution. */
  reminderMs: z.number().int().min(1000).optional(),
  /** The gate expires after this long; expiry never approves, and the job blocks. */
  deadlineMs: z.number().int().min(1000).optional(),
}).strict()

const TriggerSchema = z.object({
  sources: z.array(z.string().min(1)).min(1),
  /** How the message must address the workbench: an explicit mention, a direct message, or either (`A18`). */
  on: z.array(z.enum(['mention', 'direct'])).min(1),
  /** A case-insensitive regular expression the message text must match. */
  pattern: z.string().min(1).optional(),
}).strict()

const BudgetsSchema = z.object({
  /** Per job, across attempts. */
  turns: Count,
  tokens: Count,
  /** Backtracks per job, across edges. */
  backtracks: z.number().int().min(0),
  /** What one approved budget extension adds to the exhausted budget. */
  extension: z.object({ turns: Count, tokens: Count, attempts: Count, backtracks: Count }).strict(),
}).strict()

/**
 * Where a kind of conversation happens (`D12`): the job's chat thread (Mattermost), its ticket (Jira), or its merge request (GitLab).
 */
export const PlaceSchema = z.enum(['chat', 'ticket', 'mergeRequest'])
export type Place = z.output<typeof PlaceSchema>

export const DeclarationSchema = z.object({
  title: z.string().min(1),
  start: Id,
  triggers: z.array(TriggerSchema).min(1),
  stages: z.array(StageSchema).min(1),
  transitions: z.array(TransitionSchema).min(1),
  backtracks: z.array(BacktrackSchema).default([]),
  gates: z.array(GateSchema).default([]),
  budgets: BudgetsSchema,
  /**
   * A follow-up on a thread the job bound to an artifact (an MR) reopens a completed job at `stage`. `requirements` (`D12`): the
   * stage a follow-up that changes the approved requirements goes to instead, so new behaviour gets a new plan approval before any
   * code; without it, every follow-up goes to `stage`.
   */
  reopen: z.object({ stage: Id, requirements: Id.optional() }).strict().optional(),
  /**
   * The workflow works in a repository (`T11.1`): a new job chooses one of the deployment's repository profiles, and starts none
   * when no profile matches. A workflow without it never gets one. Optional, not defaulted, so other definitions hash as before.
   */
  repository: z.boolean().optional(),
  /**
   * Where each kind of conversation happens (`D12`): `clarification` (question rounds, and a blocked job's resume), `plan` (the
   * approval gate) and `code` (the merge request's discussion). A place the job has no thread for falls back to its chat thread,
   * then to the trigger's thread. Without it, every gate opens on the trigger's thread. Optional, not defaulted, so other
   * definitions hash as before.
   */
  places: z.object({ clarification: PlaceSchema, plan: PlaceSchema, code: PlaceSchema }).strict().optional(),
  /** Machine facts on a bound thread that complete the job, such as `mr_merged`. */
  completeOn: z.array(z.string().min(1)).default([]),
}).strict().superRefine((declaration, issue) => {
  const fail = (message: string) => issue.addIssue({ code: 'custom', message })
  const stages = new Map(declaration.stages.map(stage => [stage.id, stage]))
  const gates = new Set(declaration.gates.map(gate => gate.id))
  if (stages.size !== declaration.stages.length) fail('stage ids must be unique')
  if (gates.size !== declaration.gates.length) fail('gate ids must be unique')
  if (!stages.has(declaration.start)) fail(`start stage ${declaration.start} is not declared`)
  if (declaration.reopen && !stages.has(declaration.reopen.stage)) fail(`reopen stage ${declaration.reopen.stage} is not declared`)
  if (declaration.reopen?.requirements && !stages.has(declaration.reopen.requirements)) fail(`reopen requirements stage ${declaration.reopen.requirements} is not declared`)
  for (const stage of declaration.stages) {
    const outgoing = declaration.transitions.filter(transition => transition.from === stage.id)
    if (outgoing.length === 0) fail(`stage ${stage.id} has no transition`)
    const open = outgoing.findIndex(transition => !transition.guard)
    if (open !== -1 && open < outgoing.length - 1) fail(`stage ${stage.id} has transitions after an unguarded one, which are never taken`)
    if (new Set(stage.checks.map(check => check.id)).size !== stage.checks.length) fail(`stage ${stage.id} has duplicate check ids`)
    try { z.fromJSONSchema(stage.output as Parameters<typeof z.fromJSONSchema>[0]) } catch (error) {
      fail(`stage ${stage.id} output is not a usable JSON Schema: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const transition of declaration.transitions) {
    if (!stages.has(transition.from)) fail(`transition from unknown stage ${transition.from}`)
    if (transition.to !== COMPLETE && !stages.has(transition.to)) fail(`transition to unknown stage ${transition.to}`)
    if (transition.gate && !gates.has(transition.gate)) fail(`transition names unknown gate ${transition.gate}`)
    if (transition.gate && !stages.get(transition.from)?.artifact) fail(`gate ${transition.gate} needs stage ${transition.from} to produce an artifact`)
  }
  for (const edge of declaration.backtracks) {
    if (!stages.has(edge.from) || !stages.has(edge.to)) fail(`backtrack ${edge.from} → ${edge.to} names an unknown stage`)
  }
  for (const trigger of declaration.triggers) {
    if (trigger.pattern === undefined) continue
    try { new RegExp(trigger.pattern, 'iu') } catch { fail(`trigger pattern ${trigger.pattern} is not a valid regular expression`) }
  }
})
export type Declaration = z.output<typeof DeclarationSchema>
export type DeclarationInput = z.input<typeof DeclarationSchema>
export type StageDeclaration = Declaration['stages'][number]
export type TransitionDeclaration = Declaration['transitions'][number]

/** A workflow as its plugin defines it: identity, declaration and prompt texts. */
export interface WorkflowSpec {
  readonly id: string
  readonly version: number
  readonly declaration: DeclarationInput
  readonly prompts: Readonly<Record<string, string>>
}

/**
 * Validates a workflow and returns it as a kernel definition to register: the declaration with defaults applied, the prompts, and
 * the guard names its transitions use. Throws a readable error on an invalid workflow.
 */
export function defineWorkflow(spec: WorkflowSpec): WorkflowDefinition {
  const parsed = DeclarationSchema.safeParse(spec.declaration)
  if (!parsed.success) throw new Error(`Workflow ${spec.id}@${spec.version} is invalid: ${z.prettifyError(parsed.error)}`)
  const declaration = parsed.data
  const missing = declaration.stages.filter(stage => typeof spec.prompts[stage.instructions] !== 'string').map(stage => stage.instructions)
  if (missing.length > 0) throw new Error(`Workflow ${spec.id}@${spec.version} names prompts it does not define: ${missing.join(', ')}`)
  const guards = [...new Set(declaration.transitions.flatMap(transition => transition.guard ? [transition.guard] : []))].sort()
  return { id: spec.id, version: spec.version, declaration, prompts: spec.prompts, guards }
}

/** What a deployment configures for models (`D9`): the default for agent stages, and the model for approval verdicts. */
export const ModelProfileSchema = z.object({
  defaultModel: z.string().min(1),
  defaultEffort: z.string().min(1).optional(),
  verdictModel: z.string().min(1),
}).strict()
export type ModelProfile = z.output<typeof ModelProfileSchema>

/** A stage as a job runs it: its resolved model and the presets the stage runner applies. */
export const ResolvedStageSchema = z.object({
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
  agentPreset: z.string().min(1),
  permissionPreset: z.string().min(1),
  egress: z.enum(['none', 'registries']),
  tools: z.array(z.string()),
  /** The digest of the stage's instructions in the blob store. */
  instructions: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
export type ResolvedStage = z.output<typeof ResolvedStageSchema>

/** The domain's part of a run manifest (`RunManifest.data.extra`). */
export const ManifestExtraSchema = z.object({
  stages: z.record(z.string(), ResolvedStageSchema),
  verdictModel: z.string().min(1),
  /** The policy version the intake decision was made under. */
  policyVersion: z.string().min(1),
  /**
   * The deployment's parameters for the workflow (its repository, target branch, status names, test command), frozen at intake.
   * Prompts and check settings name them as `{{name}}`, so the definition stays the same across deployments and a configuration
   * change affects only new jobs.
   */
  parameters: z.record(z.string(), z.string()).default({}),
  /** The repository profile chosen at intake (`T11.1`), frozen with the job; absent in a deployment with no repositories. */
  repository: RepositoryProfileSchema.optional(),
  /**
   * The language the job's stage prompts were chosen in (`D14`), frozen so a later change of the deployment's language does not
   * switch a running job's prompts. A manifest without one predates `D14`, when every job was Russian.
   */
  locale: z.string().min(1).optional(),
}).strict()
export type ManifestExtra = z.output<typeof ManifestExtraSchema>

/** The language a job's prompts are in: its manifest's, or Russian for a job pinned before `D14`. */
export const jobLocale = (extra: Pick<ManifestExtra, 'locale'>): string => extra.locale ?? 'ru'

/** A stage's title in `locale` (`D14`): its `titles` entry, else its `title`. */
export const stageTitleIn = (stage: { readonly title: string; readonly titles?: Readonly<Record<string, string>> | undefined }, locale: string): string =>
  stage.titles?.[locale] ?? stage.title

/** Everything a job runs on, read back from its manifest. */
export interface PinnedWorkflow {
  readonly manifestId: string
  readonly id: string
  readonly version: number
  readonly hash: string
  readonly declaration: Declaration
  /** Prompt digests by name. */
  readonly prompts: Readonly<Record<string, string>>
  readonly guards: readonly string[]
  readonly extra: ManifestExtra
}

/**
 * Resolves each stage's model and effort (`stage.model ?? profile default`), presets and instructions for a new manifest. A prompt may
 * have a variant per language, `<name>.<locale>` (`D14`): the job takes the one in its language, else the prompt itself.
 */
export function resolveStages(declaration: Declaration, prompts: Readonly<Record<string, string>>, profile: ModelProfile, locale?: string): Record<string, ResolvedStage> {
  return Object.fromEntries(declaration.stages.map(stage => {
    const effort = stage.effort ?? (stage.model ? undefined : profile.defaultEffort)
    const instructions = (locale ? prompts[`${stage.instructions}.${locale}`] : undefined) ?? prompts[stage.instructions]
    if (!instructions) throw new Error(`Stage ${stage.id} names prompt ${stage.instructions}, which has no digest`)
    return [stage.id, {
      model: stage.model ?? profile.defaultModel, ...effort ? { effort } : {},
      agentPreset: stage.agentPreset, permissionPreset: stage.permissionPreset, egress: stage.egress, tools: [...stage.tools], instructions,
    }]
  }))
}

/**
 * Pins a new job's manifest on a registered workflow: the kernel stores the declaration and prompts as blobs, and the domain adds
 * the resolved stages, the verdict model and the policy version.
 */
export function pinManifest(registry: Registry, ref: { id: string; version: number }, profile: ModelProfile, policyVersion: string,
  parameters: Readonly<Record<string, string>> = {}, repository?: RepositoryProfile, locale?: string): RunManifest {
  const definition = registry.definition(ref.id, ref.version)
  if (!definition) throw new Error(`Workflow ${ref.id}@${ref.version} is not registered`)
  const declaration = DeclarationSchema.parse(definition.declaration)
  // The same digests the kernel's blob store keys the prompts by.
  const prompts = Object.fromEntries(Object.entries(definition.prompts).map(([name, text]) => [name, sha256Hex(text)]))
  const extra: ManifestExtra = { stages: resolveStages(declaration, prompts, ModelProfileSchema.parse(profile), locale),
    verdictModel: profile.verdictModel, policyVersion, parameters: { ...parameters },
    ...repository ? { repository: RepositoryProfileSchema.parse(repository) } : {}, ...locale ? { locale } : {} }
  return registry.manifest(ref.id, ref.version, extra)
}

/** Reads what a manifest pinned. A manifest whose declaration no longer validates throws, which faults the job instead of guessing. */
export function readPinned(registry: Registry, manifest: RunManifest): PinnedWorkflow {
  const content = registry.content(manifest)
  const data = manifest.data as { prompts: Record<string, string> }
  return {
    manifestId: manifest.id, id: manifest.definitionId, version: manifest.definitionVersion, hash: manifest.definitionHash,
    declaration: DeclarationSchema.parse(content.declaration), prompts: data.prompts, guards: content.guards,
    extra: ManifestExtraSchema.parse(content.extra),
  }
}

/** `text` with each `{{name}}` replaced by its parameter; a name with no parameter is left as it is, so its absence shows. */
export function fill(text: string, parameters: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (whole, name: string) => parameters[name] ?? whole)
}

/**
 * The checks a job runs for `stage`: those with no `when`, and those whose condition its frozen parameters meet. A condition on a
 * parameter the job does not have keeps the check (review): a typo, or a job with no repository, never drops a required check.
 */
export function checksOf(workflow: PinnedWorkflow, stage: StageDeclaration): StageDeclaration['checks'] {
  const { parameters } = workflow.extra
  return stage.checks.filter(check => !check.when || !Object.hasOwn(parameters, check.when.parameter) || parameters[check.when.parameter] === check.when.equals)
}

/** The stage `id` of a pinned workflow; throws when the declaration has none, which is a bug in the caller. */
export function stageOf(workflow: PinnedWorkflow, id: string): StageDeclaration {
  const stage = workflow.declaration.stages.find(candidate => candidate.id === id)
  if (!stage) throw new Error(`Workflow ${workflow.id}@${workflow.version} has no stage ${id}`)
  return stage
}

/**
 * Normalizes a stage report object: a top-level `null` field counts as absent, so an optional field accepts it and a required one
 * still fails (kept from `P6`).
 */
export function withoutNulls<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)) as T
}

const outputSchemas = new WeakMap<object, z.ZodType>()
/** Validates a completed report's output against the stage's JSON Schema; returns the error text, or `undefined` when it is valid. */
export function outputError(stage: StageDeclaration, output: unknown): string | undefined {
  let schema = outputSchemas.get(stage.output)
  if (!schema) {
    schema = z.fromJSONSchema(stage.output as Parameters<typeof z.fromJSONSchema>[0])
    outputSchemas.set(stage.output, schema)
  }
  const result = schema.safeParse(withoutNulls(output))
  return result.success ? undefined : z.prettifyError(result.error)
}
