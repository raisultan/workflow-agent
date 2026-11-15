/** The plugin configuration (`T9.8`, `D9`): settings are configuration, validated at startup with the faulty key named. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedSendersOf } from '../src/app/workbench-runtime.ts'
import { Config, resolveConfig } from '../src/config.ts'

const config = (over: Record<string, unknown> = {}) => Config({ stateDir: '/var/lib/workbench/state', ...over } as never)

describe('configuration', () => {
  it('defaults the models to LITELLM_MODEL on the litellm route, and two workers', () => {
    expect(resolveConfig(config(), { LITELLM_MODEL: 'deepseek-flash' })).toMatchObject({
      profile: { defaultModel: 'litellm/deepseek-flash', verdictModel: 'litellm/deepseek-flash' }, maxWorkers: 2, locale: 'en',
      policy: { senders: {}, approvers: {}, bots: {} }, workflows: { synthetic: false, modules: [] } })
  })

  it('takes models, effort, policy, workers, repositories and standard-delivery parameters from the profile', () => {
    const resolved = resolveConfig(config({
      models: { default: 'litellm/deepseek-pro', effort: 'high', verdict: 'litellm/deepseek-flash' },
      policy: { senders: { mattermost: ['anna'] }, approvers: { 'standard-delivery': { mattermost: ['*'] } } },
      executor: { maxWorkers: 4 }, locale: 'en',
      repositories: [{ name: 'app', project: 'group/app', testCommand: 'pnpm test', default: true }],
      workflows: { standardDelivery: { jiraStatuses: { inProgress: 'In Progress', inReview: 'In Review' } } },
    }), {})
    expect(resolved).toMatchObject({ profile: { defaultModel: 'litellm/deepseek-pro', defaultEffort: 'high', verdictModel: 'litellm/deepseek-flash' },
      maxWorkers: 4, locale: 'en', policy: { senders: { mattermost: ['anna'] } },
      repositories: [{ name: 'app', project: 'group/app', targetBranch: 'main', testCommand: 'pnpm test', registries: ['npm'], ci: 'required', default: true }],
      workflows: { standardDelivery: { jiraStatuses: { inProgress: 'In Progress' } } } })
  })

  it('names the key at fault, and refuses keys it does not use', () => {
    expect(() => resolveConfig(config({ workflows: { standardDelivery: { repository: 'group/app' } } }), {})).toThrow('`workflows` configuration is invalid')
    expect(() => resolveConfig(config({ repositories: [{ name: 'app' }] }), {})).toThrow('`repositories` configuration is invalid')
    expect(() => resolveConfig(config({ executor: { maxWorkers: 0 } }), {})).toThrow('`executor` configuration is invalid')
    expect(() => resolveConfig({ ...config(), promptMaxChars: 1000 } as never, {})).toThrow('keys it does not use: promptMaxChars')
  })

  it('keeps job worktrees outside the state directory: configured, WORKBENCH_WORK_DIR, or beside it', () => {
    expect(resolveConfig(config(), {}).workRoot).toBe('/var/lib/workbench/work')
    expect(resolveConfig(Config({ stateDir: '/srv/workbench' } as never), {}).workRoot).toBe('/srv/workbench-work')
    expect(resolveConfig(config(), { WORKBENCH_WORK_DIR: '/var/lib/workbench/work/jobs' }).workRoot).toBe('/var/lib/workbench/work/jobs')
    expect(resolveConfig(config({ executor: { workRoot: '/data/jobs' } }), { WORKBENCH_WORK_DIR: '/x' }).workRoot).toBe('/data/jobs')
  })

  it('reads WORKBENCH_ALLOWED_SENDERS as trimmed names without empties or duplicates', () => {
    expect(allowedSendersOf(' anna, lead,,anna ,')).toEqual(['anna', 'lead'])
    expect(allowedSendersOf(undefined)).toEqual([])
  })
})

describe('the example profile', () => {
  it('is a valid configuration as DSH reads it, with demo mode on in the Compose demo', async () => {
    const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
    const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
    const { entryListSchema } = await import(include) as { entryListSchema: unknown }
    const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
    const rows = yaml.load(readFileSync(join(import.meta.dirname, '..', 'examples', 'profile.cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as
      { id: string; config?: Record<string, unknown> }[]
    // `!!js` values are expressions over the environment, evaluated when DSH loads the profile.
    const evaluate = (value: unknown, env: Record<string, string>): unknown => {
      if (value && typeof value === 'object' && '__jsExpr' in value) return new Function('process', `return (${(value as { __jsExpr: string }).__jsExpr})`)({ env })
      if (Array.isArray(value)) return value.map(item => evaluate(item, env))
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(item, env)]))
      return value
    }
    const raw = rows.find(row => row.id === 'workflow-agent')!.config!
    const demo = resolveConfig(Config(evaluate(raw, { WORKBENCH_DEMO: 'true', LITELLM_MODEL: 'deepseek-flash' }) as never), {})
    expect(demo).toMatchObject({ demo: true, locale: 'en', profile: { defaultModel: 'litellm/deepseek-flash' },
      repositories: [{ name: 'app', project: 'acme/app', match: { jira: ['APP'], mattermost: [] } }] })
    expect(resolveConfig(Config(evaluate(raw, { GITLAB_PROJECT: 'group/app' }) as never), {})).toMatchObject({ demo: false,
      repositories: [{ project: 'group/app', testCommand: 'npm test', default: true }], policy: { approvers: { 'standard-delivery': { gitlab: ['*'] } } } })
    // One repository from .env alone (getting started): its Jira project, channel, approvers, commands and registries.
    const env = { GITLAB_PROJECT: 'acme/payments', REPOSITORY_NAME: 'payments', REPOSITORY_TARGET_BRANCH: 'develop', REPOSITORY_TEST_COMMAND: 'pytest -q',
      REPOSITORY_REGISTRIES: 'pypi, npm', JIRA_PROJECT: 'PAY', MATTERMOST_CHANNEL_ID: 'abc123', APPROVER_EMAILS: 'Lead@Example.com, qa@example.com' }
    expect(resolveConfig(Config(evaluate(raw, env) as never), {}).repositories).toEqual([expect.objectContaining({ name: 'payments', project: 'acme/payments',
      targetBranch: 'develop', testCommand: 'pytest -q', registries: ['pypi', 'npm'], match: { jira: ['PAY'], mattermost: ['abc123'] },
      approvers: ['lead@example.com', 'qa@example.com'], default: true })])
  })
})
