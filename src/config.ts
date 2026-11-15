/**
 * The `workflow-agent` plugin's configuration (`T9.8`, `D9`): settings are deployment configuration, versioned with the profile and
 * changed by a reviewed edit and a redeploy. Hosts and secrets come from the environment (or DSH's credential store); the profile
 * sets the structure:
 *
 * - `stateDir`: the database and locks (job worktrees live outside it, under `executor.workRoot`);
 * - `models`: the default model for agent stages (`provider/model`), its reasoning effort, and the model that reads replies;
 * - `policy`: allowed senders, approvers per workflow, and the workbench's own identities, per source; `WORKBENCH_ALLOWED_SENDERS`
 *   adds senders to every source;
 * - `executor.maxWorkers`: stage attempts that run at once; `executor.workRoot`: where job worktrees live (outside `stateDir`);
 * - `locale`: the language the workbench writes in;
 * - `demo`: one scripted synthetic job, end to end, with no connector or model (the Compose demo);
 * - `repositories`: the repositories the deployment serves (`T11.1`, `D10`): each one's GitLab project, target branch, test and
 *   setup commands, registry presets, toolchain defaults, `postgres` major, match rules, `ci`, and its own `approvers` and `senders`
 *   (`D12`); a new job's repository is chosen from its trigger;
 * - `workflows`: `standardDelivery` (its Jira status names), `synthetic` (the demo's second workflow), and `modules`, the
 *   operator's own workflow modules;
 * - `egress`: what a `registries` stage may reach (`T10.2`): the default registry `presets` of a repository that names none (`npm`
 *   by default), and extra public `hosts` (exact names or `*.suffix`) for every job;
 * - `dashboard`: `links`, the addresses people open Jira, Mattermost and GitLab at, when they differ from the connectors' (`D13`).
 */
import { basename, dirname, join, resolve } from 'node:path'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { ModelProfileSchema, type ModelProfile } from './domain/definition.ts'
import { PolicySchema, type Policy } from './domain/policy.ts'
import { EGRESS_PRESETS, HOST_PATTERN } from './adapters/egress.ts'
import { RepositoriesSchema, type RepositoryProfile } from './domain/repositories.ts'

const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)

export const Config = s.object({
  stateDir: absolute('Directory for the database and locks; job worktrees live outside it.').required(),
  models: s.any().default({}).description('`default` and `verdict` models as `provider/model`, and `effort`; LITELLM_MODEL by default.'),
  policy: s.any().default({}).description('`senders`, `approvers` (per workflow) and `bots`, each per source.'),
  executor: s.any().default({}).description('`maxWorkers`: stage attempts that run at once (2 by default); `workRoot`: where job worktrees live.'),
  locale: s.union(['en', 'ru']).default('en').description('The language the workbench writes in, and new jobs\' stage prompts are chosen in (`D14`).'),
  demo: s.boolean().default(false).description('Runs one scripted synthetic job end to end, with no connector or model (the Compose demo).'),
  repositories: s.any().default([]).description('The repositories jobs work in: `name`, `project`, `targetBranch`, `testCommand`, `setupCommand`, `registries`, `toolchains`, `postgres`, `match`, `ci`, `default`, `approvers`, `senders`.'),
  workflows: s.any().default({}).description('`standardDelivery` (its `jiraStatuses`), `synthetic`, and `modules` (absolute paths of workflow modules).'),
  egress: s.any().default({}).description('`presets` (`npm` by default) and extra public `hosts` that implement and review may reach through the proxy.'),
  dashboard: s.any().default({}).description('`links`: the `jira`, `mattermost` and `gitlab` addresses people open threads at, when they differ from the connectors\' base URLs.'),
})
export type PluginConfig = ReturnType<typeof Config>

const StandardDeliverySchema = z.object({
  jiraStatuses: z.object({ inProgress: z.string().trim().min(1), inReview: z.string().trim().min(1) }).passthrough(),
}).strict()

export const WorkflowsSchema = z.object({
  standardDelivery: StandardDeliverySchema.optional(),
  /** Registers the synthetic hotfix workflow (`A6`), for the demo. */
  synthetic: z.boolean().default(false),
  /** Modules exporting `workflows()` (WorkflowSpec or a list), and optionally `guards()` and `parameters(workflowId)`. */
  modules: z.array(z.string().regex(/^\//u, 'an absolute path')).default([]),
}).strict()
export type WorkflowsConfig = z.output<typeof WorkflowsSchema>

/**
 * What `registries` stages may reach. A bare `*`, an address and a private name are not allowed: open web access, private registries
 * and internal hosts are out of scope.
 */
const EgressSchema = z.object({
  presets: z.array(z.enum(Object.keys(EGRESS_PRESETS) as [string, ...string[]])).default(['npm']),
  hosts: z.array(z.string().trim().toLowerCase().regex(HOST_PATTERN, 'an exact host name or *.suffix').refine(host => !/(?:^|\.)(?:localhost|local|internal|lan|home|corp)$/u.test(host), 'a public host')).default([]),
}).strict()

const DashboardSchema = z.object({
  links: z.object({ jira: z.url(), mattermost: z.url(), gitlab: z.url() }).partial().strict().default({}),
}).strict()

const ExecutorSchema = z.object({ maxWorkers: z.number().int().min(1).max(64).default(2), workRoot: z.string().regex(/^\//u, 'an absolute path').optional() }).strict()

/**
 * Where job worktrees live: configured, else `WORKBENCH_WORK_DIR`, else beside the state directory (`<parent>/work` for a state
 * directory named `state`, `<stateDir>-work` otherwise). Never inside the state directory, which no sandbox may read (`A15`).
 */
export function workRootOf(stateDir: string, configured: string | undefined, env: NodeJS.ProcessEnv): string {
  if (configured) return resolve(configured)
  if (env.WORKBENCH_WORK_DIR) return resolve(env.WORKBENCH_WORK_DIR)
  const state = resolve(stateDir)
  return basename(state) === 'state' ? join(dirname(state), 'work') : `${state}-work`
}

/** The configuration, validated and resolved. */
export interface WorkbenchConfig {
  readonly stateDir: string
  readonly profile: ModelProfile
  /** The policy the profile states; senders from the environment and resolved identities are added at runtime. */
  readonly policy: Policy
  readonly maxWorkers: number
  /** Where job worktrees live, outside the state directory. */
  readonly workRoot: string
  readonly locale: 'ru' | 'en'
  readonly workflows: WorkflowsConfig
  /** The repositories jobs work in (`T11.1`), each with its registry presets resolved; empty when jobs need none (the demo). */
  readonly repositories: readonly RepositoryProfile[]
  /** Demo mode: a synthetic source, a scripted stage driver and logged posts (the Compose demo, `A1`). */
  readonly demo: boolean
  /**
   * What `registries` stages may reach through the egress proxy: the default `presets` and the extra `hosts`, and `allowlist`, the
   * hosts of a job whose repository uses the default presets. A job's own allowlist is `allowlistOf` its repository's presets.
   */
  readonly egress: { readonly presets: readonly string[]; readonly hosts: readonly string[]; readonly allowlist: readonly string[] }
  /** The dashboard's thread links, when people reach the tools at other addresses than the connectors do (`D13`). */
  readonly dashboard: { readonly links: { readonly jira?: string; readonly mattermost?: string; readonly gitlab?: string } }
}

const parse = <T>(schema: z.ZodType<T>, value: unknown, key: string): T => {
  const parsed = schema.safeParse(value ?? {})
  if (!parsed.success) throw new Error(`workflow-agent \`${key}\` configuration is invalid: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/** Validates the plugin configuration; `env` supplies the default model. */
export function resolveConfig(config: PluginConfig, env: NodeJS.ProcessEnv = process.env): WorkbenchConfig {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`workflow-agent configuration has keys it does not use: ${unknown.join(', ')}; docs/DEPLOYMENT.md lists the keys`)
  const models = parse(z.object({ default: z.string().min(1).optional(), effort: z.string().min(1).optional(), verdict: z.string().min(1).optional() }).strict(),
    config.models, 'models')
  const fallback = `litellm/${env.LITELLM_MODEL || 'deepseek-v4-pro'}`
  const executor = parse(ExecutorSchema, config.executor, 'executor')
  const profile = ModelProfileSchema.parse({ defaultModel: models.default ?? fallback, ...models.effort ? { defaultEffort: models.effort } : {},
    verdictModel: models.verdict ?? models.default ?? fallback })
  const egress = egressOf(parse(EgressSchema, config.egress, 'egress'))
  const workflows = parse(WorkflowsSchema, config.workflows, 'workflows')
  const repositories = parse(RepositoriesSchema, config.repositories ?? [], 'repositories').map(profile => ({ ...profile, registries: profile.registries ?? [...egress.presets] }))
  const unknownPresets = [...new Set(repositories.flatMap(profile => profile.registries.filter(name => !(name in EGRESS_PRESETS))))]
  if (unknownPresets.length > 0) throw new Error(`workflow-agent \`repositories\` configuration is invalid: unknown registry presets ${unknownPresets.join(', ')}; known: ${Object.keys(EGRESS_PRESETS).join(', ')}`)
  if (workflows.standardDelivery && repositories.length === 0) throw new Error('workflow-agent `repositories` configuration is invalid: standard-delivery needs at least one repository')
  return {
    stateDir: config.stateDir,
    profile,
    policy: parse(PolicySchema, config.policy, 'policy'),
    maxWorkers: executor.maxWorkers,
    workRoot: workRootOf(config.stateDir, executor.workRoot, env),
    locale: config.locale ?? 'en',
    workflows,
    repositories,
    demo: config.demo ?? false,
    egress,
    dashboard: parse(DashboardSchema, config.dashboard, 'dashboard'),
  }
}

/** The hosts a job may reach through the proxy: its repository's registry presets and the deployment's extra hosts. */
export function allowlistOf(egress: WorkbenchConfig['egress'], presets: readonly string[]): string[] {
  return [...new Set([...presets.flatMap(name => EGRESS_PRESETS[name] ?? []), ...egress.hosts])]
}

function egressOf(egress: z.output<typeof EgressSchema>): WorkbenchConfig['egress'] {
  return { ...egress, allowlist: allowlistOf({ ...egress, allowlist: [] }, egress.presets) }
}
