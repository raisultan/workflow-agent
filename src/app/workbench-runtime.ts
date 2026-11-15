/**
 * The composition root of Workflow Agent (`T9.8`, `D8` decision 13): the workbench (kernel and domain) with its typed services,
 * the adapters that connect it to DSH and the work tools, and the host Sources talk to.
 *
 * - **Workflows** from configuration: `standard-delivery`, whose parameters come from each job's repository profile (`T11.1`),
 *   the synthetic hotfix for the demo, and the operator's modules.
 * - **Effects**: posts, notices and safe-output writes (`writers.ts`), reply verdicts (`verdict.ts`), stage attempts and steering
 *   (`stage-runner.ts`), checks (`checks.ts`), and the setup step (`setup.ts`, `T11.4`) with its toolchain proxy.
 * - **Sources** keep their own polling; their deliveries go to the inbox (`inbound.ts`), their cursors to the kernel's database,
 *   and GitLab watches the merge requests bound to jobs.
 * - **Settings are configuration** (`D9`): models, policy, workers and parameters come from the profile and the environment; the
 *   database keeps no settings. Mattermost usernames in the policy are resolved to user ids at startup.
 *
 * On a stop, running stage attempts are stopped (they return to their jobs as interrupted after the restart), the kernel's loops
 * stop, and the state directory's lock is released.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subprocess'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvedPlan, checkHandler, lastMergeRequest, lastPushedSha } from '../adapters/checks.ts'
import { demoHandlers, demoPolicy, startDemoSource } from '../adapters/demo.ts'
import { confinedUploadPack, runConfined } from '../adapters/host-commands.ts'
import { inboxInput, ownPost } from '../adapters/inbound.ts'
import { render, type Locale } from '../adapters/messages.ts'
import { readTools } from '../adapters/read-tools.ts'
import { safeOutputTools } from '../adapters/safe-output.ts'
import { StageRunner } from '../adapters/stage-runner.ts'
import { parseThread } from '../adapters/threads.ts'
import { EgressProxy, TOOLCHAIN_HOSTS, type EgressRecord } from '../adapters/egress.ts'
import { setupHandler } from '../adapters/setup.ts'
import { SandboxHost } from '../adapters/sandbox-host.ts'
import { followUpHandler, verdictHandler } from '../adapters/verdict.ts'
import { workDiff, type WorkDiff } from '../adapters/work-diff.ts'
import { provideWorkbench } from '../adapters/workbench-plugin.ts'
import { answerHandler, answerText, roundsContext } from '../adapters/answers.ts'
import { readingHandler } from '../adapters/reading.ts'
import { actionHandler, noticeHandler, postHandler, type Connectors } from '../adapters/writers.ts'
import { allowlistOf, type WorkbenchConfig } from '../config.ts'
import type { ReceiveResult } from '../sources/types.ts'
import type { GuardInput } from '../domain/decider.ts'
import type { JobState } from '../domain/job.ts'
import { jobLocale, stageOf, stageTitleIn, type WorkflowSpec } from '../domain/definition.ts'
import { eligible, type Actor, type Policy } from '../domain/policy.ts'
import { repositoryParameters, type RepositoryProfile } from '../domain/repositories.ts'
import { Workbench } from '../domain/workbench.ts'
import { runAsWorker, workerGitConfig, writeEnvironment } from '../infra/environment.ts'
import { HealthBoard } from '../infra/health.ts'
import { excludeJobHome } from '../infra/git-layout.ts'
import { maxCharsFor } from '../infra/text.ts'
import { stopBackground } from '../executor/background.ts'
import { createGitTransport } from '../sources/git-transport.ts'
import { GitLabConnector, resolveGitLabConfig, type GitLabSourceConfig } from '../sources/gitlab.ts'
import type { Health, SourceContext, SourceHost } from '../sources/host.ts'
import { jiraAccount, JiraConnector, resolveJiraConfig, type JiraSourceConfig } from '../sources/jira.ts'
import { MattermostConnector, resolveMattermostConfig, type MattermostSourceConfig } from '../sources/mattermost.ts'
import { POSTGRES_MAJORS } from '../sandbox/services.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { syntheticHotfix } from '../workflows/synthetic-hotfix.ts'
import { standardDelivery } from '../workflows/standard-delivery.ts'
import { readTrace, type SessionReader } from './agent-trace.ts'
import { startDashboard, type Dashboard } from './dashboard-server.ts'
import { routes, type Links, type PanelHost, type Routes, type SettingsView } from './panel-api.ts'
import { lockStateDir } from './state-lock.ts'

declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }

/**
 * The DSH tools a stage session may keep, of those its preset provides. No web tool (`web_search` and `web_fetch` run on the host,
 * outside the egress proxy; `D8` decision 10) and no subagents (a child session would run under DSH's own preset, outside the
 * stage's tools, sandbox and budget; `T10.0`).
 */
export const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'skill', 'todo_write']
const SOURCES = ['jira', 'mattermost', 'gitlab'] as const
/** The package's root directory: the nearest `package.json` above this module (`lib/` when built, `src/app/` in development). */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

/**
 * On Linux, a deployment's sandboxes must run through the workbench's wrapper (`T10.3`): without it, nothing masks the credential
 * store, the state or other jobs' worktrees from an agent's shell. The demo runs no agent shells, so it may run without.
 */
export function assertSandboxWrapper(platform: string, sandbox: { runnerCommand?: readonly string[] } | undefined, demo: boolean): void {
  if (platform !== 'linux' || demo || !sandbox) return
  if (!sandbox.runnerCommand?.length) {
    throw new Error('The sandbox has no wrapper: set WORKBENCH_SANDBOX_WRAPPER to the path of lib/sandbox-wrapper.js (docs/DEPLOYMENT.md), '
      + 'so agent shells cannot read credentials, the state or other jobs\' worktrees')
  }
}

/** The kernel key of a job's base commit. */
const baseKey = (jobId: string) => `work-base:${jobId}`
/** How often the workbench retries resolving Mattermost usernames it could not reach Mattermost for. */
const RESOLVE_RETRY_MS = 60_000
/** How far back the workbench's own Jira comments are read when a connector is made. */
const OWN_COMMENTS_MS = 7 * 24 * 3600_000
const ENDED = new Set(['failed', 'cancelled'])

/** A workflow module: its specs, and optionally its guards and its deployment parameters. */
interface WorkflowModule {
  workflows?: () => WorkflowSpec | WorkflowSpec[] | Promise<WorkflowSpec | WorkflowSpec[]>
  guards?: () => Record<string, (input: GuardInput) => boolean>
  parameters?: (workflowId: string) => Record<string, string> | undefined
}

/** The names in `WORKBENCH_ALLOWED_SENDERS`: comma separated, trimmed, without empties or duplicates. */
export function allowedSendersOf(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map(part => part.trim()).filter(part => part && part.length <= 200))]
}

export interface WorkbenchRuntimeOptions {
  readonly fetchImpl?: typeof fetch
  /** Loads an operator workflow module by absolute path (replaceable in tests). */
  readonly load?: (path: string) => Promise<unknown>
  /** Serves the dashboard on its own port (`D13`); absent, no dashboard is served (tests). */
  readonly dashboard?: { readonly host: string; readonly port: number; readonly hosts?: readonly string[] }
  /** The built page; `lib/dashboard` of the package by default. */
  readonly dashboardAssets?: string
}

/** How long a Jira ticket's summary is shown before it is read again. */
const TITLE_TTL_MS = 10 * 60_000

/** The composition root; it provides the `orchestrator` service Sources use, and the workbench's typed services. */
export class WorkbenchRuntime extends Service implements SourceHost {
  readonly sources: SourceRegistry
  readonly workbench: Workbench
  readonly runner: StageRunner
  readonly ready: Promise<void>
  readonly health = new HealthBoard()
  private readonly runtimeHealth = this.health.claim('runtime', { state: 'starting', detail: '' })
  private readonly config: WorkbenchConfig
  private readonly options: WorkbenchRuntimeOptions
  private readonly stopped = new AbortController()
  private readonly releaseLock: () => void
  private readonly sandbox: SandboxHost
  private readonly egress: EgressProxy
  /** The proxy of the setup step's toolchain installs (`T11.4`), with the toolchain allowlist; no stage reaches it. */
  private readonly toolchainEgress: EgressProxy
  private stopShellVariable: (() => void) | undefined
  private readonly modules: WorkflowModule[] = []
  /** Mattermost user ids of the usernames the policy names, and usernames by id for mentions. */
  private readonly userIds = new Map<string, string>()
  private readonly usernames = new Map<string, string>()
  private readonly botIdentities: Record<string, string[]> = {}
  private resolveRetry: ReturnType<typeof setTimeout> | undefined
  /** Each repository's approvers by source (`D12`), resolved from the profile's emails at startup. */
  private readonly approvers: Record<string, Record<string, string[]>> = {}
  private approverRetry: ReturnType<typeof setTimeout> | undefined
  private stopping: Promise<void> | undefined
  private stopDemo: (() => void) | undefined
  private dashboardServer: Dashboard | undefined
  /** Jira ticket summaries the dashboard shows, by key, with when each was read. */
  private readonly titles = new Map<string, { title?: string; at: number; pending?: boolean }>()
  private readonly connectorCache = new Map<string, { key: string; connector: unknown }>()

  constructor(ctx: Context, config: WorkbenchConfig, options: WorkbenchRuntimeOptions = {}) {
    super(ctx, 'orchestrator')
    this.config = config
    this.options = options
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
    this.releaseLock = lockStateDir(config.stateDir, error => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() })
    try {
      this.workbench = new Workbench({ path: join(config.stateDir, 'workbench.sqlite'), profile: config.profile, policy: () => this.policy(),
        parameters: (id, repository) => this.parameters(id, repository), repositories: () => this.intakeRepositories(), ownPost, locale: config.locale })
      provideWorkbench(ctx, this.workbench, () => this.policy())
      this.sources = new SourceRegistry(this.health)
      const writerDeps = { connectors: () => this.connectors(), worktree: (jobId: string) => this.worktree(jobId),
        lastPushed: (jobId: string) => lastPushedSha(this.workbench, jobId), addressee: (jobId: string) => this.addressee(jobId),
        renderContext: (jobId: string, source: 'mattermost' | 'jira' | 'gitlab') => this.renderContext(jobId, source) }
      const reads = readTools({ connectors: () => this.connectors(), repository: jobId => this.repository(jobId) })
      const writes = safeOutputTools({ workbench: this.workbench, repository: jobId => this.repository(jobId), headSha: jobId => this.headSha(jobId) })
      const dshHome = resolveDshHome(undefined)
      const toolchains = toolchainCache(process.env)
      const services = testServices(process.env)
      this.sandbox = new SandboxHost({ stateDir: config.stateDir, workRoot: config.workRoot, dshHome, gitConfig: workerGitConfig(config.stateDir),
        bridge: join(packageRoot(), 'lib', 'sandbox-bridge.js'), ...toolchains ? { toolchains: toolchains.root, mise: toolchains.mise } : {},
        ...services ? { services: services.root } : {} })
      const record = (entry: EgressRecord) => {
        this.workbench.kernel.db.run(`INSERT INTO egress_connection (job_id, attempt_id, host, port, address, allowed, reason, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, entry.jobId, entry.attemptId ?? null, entry.host, entry.port, entry.address ?? null,
          entry.allowed ? 1 : 0, entry.reason, this.workbench.kernel.env.clock.now())
      }
      this.egress = new EgressProxy({ dir: join(config.stateDir, 'sandbox', 'proxy'), allowlist: config.egress.allowlist,
        allowlistOf: jobId => allowlistOf(config.egress, this.jobRepository(jobId)?.registries ?? config.egress.presets),
        attemptOf: jobId => connectionLabel(this.workbench.kernel.engine.job(jobId)?.state), record })
      this.toolchainEgress = new EgressProxy({ dir: join(config.stateDir, 'sandbox', 'toolchain-proxy'), allowlist: TOOLCHAIN_HOSTS,
        attemptOf: () => 'setup', record })
      this.runner = new StageRunner({ ctx, workbench: this.workbench, maxWorkers: () => config.maxWorkers, workTools: WORK_TOOLS,
        name: actor => `@${this.username(actor) ?? actor.id}`,
        prepareWorkspace: jobId => this.prepareWorkspace(jobId), stopWork: (sessionId, reason) => stopBackground(ctx, sessionId, reason),
        prepareSandbox: async (jobId, sandbox) => {
          const jobServices = this.workbench.kernel.engine.job(jobId)?.state.services
          this.sandbox.prepareJob(jobId, { ...sandbox, toolchains: this.toolchainsOf(jobId), ...jobServices ? { services: jobServices } : {},
            ...sandbox.egress === 'registries' ? { socket: await this.egress.open(jobId) } : {} })
        },
        releaseSandbox: jobId => { this.egress.close(jobId) },
        skillRoots: [join(packageRoot(), 'skills'), join(dshHome, 'skills')],
        tools: (attempt, sessionId) => [...reads(attempt), ...writes(attempt, sessionId)] })
      const { effects } = this.workbench.kernel
      const checks = checkHandler({ workbench: this.workbench, locale: this.config.locale === 'ru' ? 'ru' : 'en', worktree: jobId => this.worktree(jobId), repository: jobId => this.repository(jobId),
        gitlab: () => this.connectors().gitlab, run: command => runConfined(ctx, { ...command, profile: 'check' }), diff: (jobId, commit) => this.diff(jobId, commit),
        llm: ctx.llm })
      const demo = config.demo ? demoHandlers(this.workbench, postHandler(writerDeps), payload => this.renderPost(payload.jobId, payload.threadKey, payload.message)) : undefined
      effects.register('post', demo?.post ?? postHandler(writerDeps))
      effects.register('notice', noticeHandler({ connectors: () => this.connectors(), locale: config.locale as Locale,
        bot: () => this.botIdentities.mattermost?.[1] }))
      effects.register('action', actionHandler(writerDeps))
      effects.register('interpretReply', verdictHandler(ctx.llm))
      effects.register('readAnswers', readingHandler(ctx.llm, { username: actor => this.username(actor) ?? (actor.source === 'mattermost' ? undefined : actor.id) }))
      // The approved plan lets the reading tell a change within it from a change of its requirements (`D12`).
      effects.register('interpretFollowUp', followUpHandler(ctx.llm, { plan: jobId => approvedPlan(this.workbench, jobId)?.text }))
      effects.register('answer', answerHandler(ctx.llm, (jobId, threadKey) => this.answerContext(jobId, threadKey), { locale: jobId => this.jobLanguage(jobId) }))
      effects.register('stage.attempt', demo?.attempt ?? this.runner.handler())
      effects.register('stage.steer', this.runner.steerHandler())
      effects.register('check', demo?.check ?? checks)
      effects.register('setup', setupHandler({ workbench: this.workbench, prepareWorkspace: jobId => this.prepareWorkspace(jobId),
        repository: jobId => this.jobRepository(jobId), run: command => runConfined(ctx, command), ...toolchains ? { toolchains } : {},
        ...services ? { services: { postgres: services.postgres } } : {},
        openToolchainProxy: jobId => this.toolchainEgress.open(jobId), openRegistriesProxy: jobId => this.egress.open(jobId),
        closeProxies: jobId => { this.toolchainEgress.close(jobId); this.egress.close(jobId) },
        prepareJob: (jobId, file) => { this.sandbox.prepareJob(jobId, { ...file, egress: 'none' }) } }))
      this.ready = this.initialize()
    } catch (error) {
      this.releaseLock()
      throw error
    }
  }

  get lifetime(): AbortSignal { return this.stopped.signal }

  /** The policy: the profile's, plus the environment's senders and the identities resolved at startup. */
  policy(): Policy {
    const { policy } = this.config
    const env = allowedSendersOf(process.env.WORKBENCH_ALLOWED_SENDERS)
    const withIds = (ids: readonly string[]) => this.withUserIds(ids)
    const senders = Object.fromEntries([...new Set([...SOURCES, ...Object.keys(policy.senders)])].map(source => {
      const ids = [...policy.senders[source] ?? [], ...env]
      return [source, source === 'mattermost' ? withIds(ids) : ids]
    }))
    const approvers = Object.fromEntries(Object.entries(policy.approvers).map(([workflow, bySource]) =>
      [workflow, Object.fromEntries(Object.entries(bySource).map(([source, ids]) => [source, source === 'mattermost' ? withIds(ids) : ids]))]))
    const bots = Object.fromEntries([...new Set([...Object.keys(policy.bots), ...Object.keys(this.botIdentities)])].map(source =>
      [source, [...new Set([...policy.bots[source] ?? [], ...this.botIdentities[source] ?? []])]]))
    // A repository that lists approvers is decided by them alone; until their emails resolve, nobody approves (fails closed).
    const repositoryApprovers = Object.fromEntries(this.config.repositories.filter(profile => profile.approvers !== undefined)
      .map(profile => [profile.name, this.approvers[profile.name] ?? {}]))
    const merged = { senders, approvers, bots, ...Object.keys(repositoryApprovers).length > 0 ? { repositoryApprovers } : {} }
    return this.config.demo ? demoPolicy(merged) : merged
  }

  /** Mattermost usernames with the user ids the bot resolved for them, so a policy list matches the ids posts carry. */
  private withUserIds(ids: readonly string[]): string[] {
    return [...new Set(ids.flatMap(id => this.userIds.has(id.toLowerCase()) ? [id, this.userIds.get(id.toLowerCase())!] : [id]))]
  }

  /** The repositories intake chooses from: each one's Mattermost `senders` resolved to ids, as the global senders are (`D10`). */
  intakeRepositories(): RepositoryProfile[] {
    return this.config.repositories.map(profile => profile.senders?.mattermost
      ? { ...profile, senders: { ...profile.senders, mattermost: this.withUserIds(profile.senders.mattermost) } } : profile)
  }

  /** The parameters a new job's manifest freezes (`jobParameters`): its repository's, then the workflow's own. */
  private parameters(workflowId: string, repository: RepositoryProfile | undefined): Record<string, string> {
    const delivery = this.config.workflows.standardDelivery
    const own: Record<string, string> = workflowId === 'standard-delivery' && delivery
      ? { 'jira.inProgress': delivery.jiraStatuses.inProgress, 'jira.inReview': delivery.jiraStatuses.inReview }
      : this.modules.map(module => module.parameters?.(workflowId)).find(parameters => parameters !== undefined)
        ?? (workflowId === 'synthetic-hotfix' && !repository ? { testCommand: 'true' } : {})
    return jobParameters(own, repository)
  }

  /** The configured connectors, built from each Source's configuration and the environment; credentials stay on the host. */
  connectors(): Connectors {
    const fetchImpl = this.options.fetchImpl
    const uploadPackFor = (worktree: string) => this.uploadPackFor(worktree)
    const cached = <T>(name: string, key: unknown, build: () => T | undefined): T | undefined => {
      const id = JSON.stringify(key)
      const hit = this.connectorCache.get(name)
      if (hit?.key === id) return hit.connector as T
      const connector = build()
      this.connectorCache.set(name, { key: id, connector })
      return connector
    }
    const instance = <C extends Record<string, unknown>>(id: string) => this.sources.instance<C>(id)
    const ownJiraComments = () => this.ownJiraComments()
    const jira = instance<JiraSourceConfig>('jira'), mattermost = instance<MattermostSourceConfig>('mattermost'), gitlab = instance<GitLabSourceConfig>('gitlab')
    return {
      get jira() {
        if (jira && !jira.enabled) return undefined
        const resolved = resolveJiraConfig(jira?.config)
        return cached('jira', resolved, () => {
          if (!resolved.baseUrl || !resolved.auth) return undefined
          const connector = new JiraConnector({ baseUrl: resolved.baseUrl, auth: resolved.auth,
            ...resolved.botUsername ? { botUsername: resolved.botUsername } : {}, ...resolved.botAccountId ? { botAccountId: resolved.botAccountId } : {},
            ...fetchImpl ? { fetchImpl } : {} })
          connector.recordOwn(ownJiraComments())
          return connector
        })
      },
      get mattermost() {
        if (mattermost && !mattermost.enabled) return undefined
        const resolved = resolveMattermostConfig(mattermost?.config)
        return cached('mattermost', resolved, () => resolved.baseUrl && resolved.token ? new MattermostConnector({ baseUrl: resolved.baseUrl, token: resolved.token,
          botUserId: resolved.botUserId, ...resolved.teamId ? { teamId: resolved.teamId } : {}, ...fetchImpl ? { fetchImpl } : {} }) : undefined)
      },
      get gitlab() {
        if (gitlab && !gitlab.enabled) return undefined
        const resolved = resolveGitLabConfig(gitlab?.config)
        return cached('gitlab', resolved, () => {
          if (!resolved.baseUrl || !resolved.token) return undefined
          const transport = createGitTransport({ baseUrl: resolved.baseUrl, token: resolved.token })
          return new GitLabConnector({ baseUrl: resolved.baseUrl, token: resolved.token, ...fetchImpl ? { fetchImpl } : {},
            gitPushRunner: async params => transport.push({ ...params, ...await uploadPackFor(params.worktreeDir) }) })
        })
      },
    }
  }

  /** Sources read their host's connector through these. */
  get jira(): JiraConnector | undefined { return this.connectors().jira }
  get mattermost(): MattermostConnector | undefined { return this.connectors().mattermost }
  get gitlab(): GitLabConnector | undefined { return this.connectors().gitlab }
  get fetchImpl(): typeof fetch | undefined { return this.options.fetchImpl }

  /** A Source kind's context: deliveries to the inbox, cursors in the kernel's database, and its health entries. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext {
    const health = this.sources.healthEntries(kind.health)
    const { db } = this.workbench.kernel
    const key = (name: string) => `source:${name}`
    const runtime = this
    return {
      get ready() { return runtime.ready },
      config: <C extends Record<string, unknown>>(id: string) => {
        const instance = this.sources.instance<C>(id)
        return instance?.enabled ? instance.config : undefined
      },
      receive: (trigger): ReceiveResult => this.workbench.receive(inboxInput(trigger)).duplicate ? 'duplicate' : 'stored',
      state: {
        get: name => this.stored(key(name)) as never,
        set: (name, value) => {
          if (value === undefined) db.run('DELETE FROM kv WHERE key = ?', key(name))
          else this.store(key(name), value)
        },
      },
      threads: {
        // GitLab watches the merge requests bound to jobs still in play (a completed job takes review feedback).
        subscribed: source => db.all<{ thread_key: string; status: string }>(`SELECT b.thread_key, j.status FROM binding b JOIN job j ON j.id = b.job_id
          WHERE b.thread_key LIKE ?`, `${source}:%`).filter(row => !ENDED.has(row.status)).flatMap(row => {
          const thread = (() => { try { return parseThread(row.thread_key) } catch { return undefined } })()
          return thread?.source === 'gitlab' ? [{ key: row.thread_key, ref: { source: 'gitlab', id: `${thread.project}!mr_${thread.mrIid}` },
            meta: { project: thread.project } }] : []
        }),
      },
      report: (entry: string, value: Health) => {
        if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`)
        health.get(entry)?.set(value)
      },
    }
  }

  private jobManifest(jobId: string): string | undefined { return this.workbench.kernel.engine.job(jobId)?.manifestId }

  /** The repository profile the job's manifest froze (`T11.1`). */
  jobRepository(jobId: string): RepositoryProfile | undefined {
    const manifestId = this.jobManifest(jobId)
    return manifestId ? this.workbench.workflow(manifestId).extra.repository : undefined
  }

  /** The binary directories of the toolchains the job's setup step installed (`T11.5`). */
  toolchainsOf(jobId: string): string[] {
    return (this.workbench.kernel.engine.job(jobId)?.state.toolchains ?? []).map(toolchain => toolchain.bin)
  }

  /** The job's repository, from the parameters its manifest froze. */
  repository(jobId: string): string | undefined {
    const manifestId = this.jobManifest(jobId)
    return manifestId ? this.workbench.workflow(manifestId).extra.parameters.repository || undefined : undefined
  }

  worktree(jobId: string): string { return join(this.config.workRoot, jobId) }

  /**
   * The job's worktree: cloned by the host (its credentials stay out of the worktree), or empty when the job has no repository.
   * The clone happens beside the worktree and is renamed into place only after its commit is recorded as the job's base (`T10.1`),
   * so a worktree never exists without a base no worker could have chosen.
   */
  private async prepareWorkspace(jobId: string): Promise<string> {
    const directory = this.worktree(jobId)
    if (existsSync(directory)) return directory
    await mkdir(dirname(directory), { recursive: true })
    const project = this.repository(jobId)
    const gitlab = resolveGitLabConfig(this.sources.instance<GitLabSourceConfig>('gitlab')?.config)
    if (project && gitlab.baseUrl && gitlab.token) {
      const staging = `${directory}.clone`
      await rm(staging, { recursive: true, force: true })
      const { head } = await createGitTransport({ baseUrl: gitlab.baseUrl, token: gitlab.token }).clone({ project, directory: staging })
      this.store(baseKey(jobId), head)
      await excludeJobHome(staging)
      await rename(staging, directory)
    } else await mkdir(directory, { recursive: true })
    return directory
  }

  /** The commit the job's worktree was cloned at (`T10.1`). */
  base(jobId: string): string | undefined {
    return this.stored(baseKey(jobId)) as string | undefined
  }

  /** A value in the kernel's `kv` table. */
  private stored(key: string): unknown {
    const row = this.workbench.kernel.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)
    return row ? JSON.parse(row.value) as unknown : undefined
  }

  private store(key: string, value: unknown): void {
    this.workbench.kernel.db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
  }

  /** The diff of the job's work against its base, computed outside the worktree (`work-diff.ts`). */
  private async diff(jobId: string, commit: string | undefined): Promise<WorkDiff> {
    const base = this.base(jobId)
    if (!base) throw new Error(`job ${jobId} has no recorded base commit`)
    return await workDiff({ worktree: this.worktree(jobId), base, ...commit ? { commit } : {}, ...await this.uploadPackFor(this.worktree(jobId)) })
  }

  /** The confined upload-pack for a fetch from a job's worktree (`<workRoot>/<jobId>`), as `{ uploadPack }`. */
  private async uploadPackFor(worktree: string): Promise<{ uploadPack?: { command: string; env: Record<string, string> } }> {
    const jobId = basename(worktree)
    if (dirname(resolve(worktree)) !== resolve(this.config.workRoot)) throw new Error(`${worktree} is not a job's worktree`)
    const uploadPack = await confinedUploadPack(this.ctx, jobId, worktree)
    return uploadPack ? { uploadPack } : {}
  }

  /**
   * The worktree's `HEAD`. Git runs in the worktree, so it reads the worktree's own configuration, but never the agent's `HOME`: its
   * global configuration is the worker git config, and `core.fsmonitor` (a command git would start) is off (`T10.3`).
   */
  private async headSha(jobId: string): Promise<string> {
    return (await runAsWorker(this.ctx.subprocess, ['git', '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD'], this.worktree(jobId),
      AbortSignal.timeout(30_000), { HOME: join(this.config.stateDir, 'worker-home'), GIT_CONFIG_GLOBAL: workerGitConfig(this.config.stateDir) })).trim()
  }

  /** The language a job's prompts are in (`D14`): its manifest's, Russian for a job pinned before it, the deployment's if unknown. */
  private jobLanguage(jobId: string): string {
    try {
      const job = this.workbench.kernel.engine.job(jobId)
      return job ? jobLocale(this.workbench.workflow(job.manifestId).extra) : this.config.locale
    } catch { return this.config.locale }
  }

  /**
   * The context of a job's answer turn (`D12`): its request, its ticket, the answers its question rounds got, its current plan and, for
   * a question on its merge request, the diff of what it pushed. Each part is bounded; a part that cannot be read is left out.
   */
  private async answerContext(jobId: string, threadKey: string): Promise<string> {
    const state = this.workbench.kernel.engine.job(jobId)?.state
    if (!state) return ''
    const cap = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}\n…` : text
    const locale = this.jobLanguage(jobId)
    const words = answerText(locale)
    const parts: string[] = [`${words.request}: ${cap(state.intake?.text ?? '', 2000)}`]
    const ticket = ticketOf(state)
    const { jira } = this.connectors()
    if (ticket && jira) {
      try {
        const issue = await jira.getIssue(ticket)
        parts.push(`${words.ticket} ${issue.key}: ${issue.summary}\n${cap(issue.description, 6000)}`)
      } catch { /* the answer goes on without the ticket */ }
    }
    parts.push(...roundsContext(Object.values(state.gates), locale))
    const plan = state.artifacts.plan?.at(-1)
    const planText = plan && this.workbench.kernel.blobs.text(plan.digest)
    if (planText) parts.push(`${words.plan(plan.n)}:\n${cap(planText, 12_000)}`)
    if (threadKey.startsWith('gitlab:')) {
      try {
        const diff = await this.diff(jobId, lastPushedSha(this.workbench, jobId))
        parts.push(`${words.diff}:\n${cap(diff.patch, 20_000)}`)
      } catch { /* the answer goes on without the diff */ }
    }
    return parts.join('\n\n')
  }

  /**
   * Who a job's question rounds are addressed to (`D12`): its ticket's author, matched to a Mattermost user by email; else the
   * requester. A lookup that fails falls back to the requester, so a question is never held up by it.
   */
  private async addressee(jobId: string): Promise<string | undefined> {
    const state = this.workbench.kernel.engine.job(jobId)?.state
    if (!state) return undefined
    const ticket = ticketOf(state)
    const { jira, mattermost } = this.connectors()
    if (ticket && jira && mattermost) {
      try {
        const issue = await jira.getIssue(ticket)
        const user = issue.reporterEmail ? await mattermost.userByEmail(issue.reporterEmail) : undefined
        if (user) return `@${user.username}`
      } catch (error) {
        this.ctx.logger.warn('workflow-agent could not find the author of %s, asking the requester: %s', ticket, String(error))
      }
    }
    const requester = state.requester && this.username(state.requester)
    return requester ? `@${requester}` : undefined
  }

  /** A Mattermost user's username, from the policy's resolved names or the connector's cache. */
  private username(actor: Actor): string | undefined {
    if (actor.source !== 'mattermost') return undefined
    return this.usernames.get(actor.id) ?? this.connectors().mattermost?.knownUsername(actor.id)
  }

  private renderContext(jobId: string, source: 'mattermost' | 'jira' | 'gitlab') {
    const manifestId = this.jobManifest(jobId)
    const pinned = manifestId ? this.workbench.workflow(manifestId) : undefined
    // A link in a post is for people: the address they open Jira at (`dashboard.links`), else the connector's (`D13`).
    const jiraBase = this.links().jira
    const job = this.workbench.kernel.engine.job(jobId)?.state
    // A Jira mention (`[~name]`) is markup only in Jira; elsewhere a person is named `@name`.
    const mention = (name: string) => source === 'jira' ? `[~${name}]` : `@${name}`
    return {
      locale: this.config.locale as Locale,
      source,
      ticketUrl: (issueKey: string) => jiraBase ? `${jiraBase}/browse/${encodeURIComponent(issueKey)}` : undefined,
      stageTitle: (stageId: string) => { try { return pinned ? stageTitleIn(stageOf(pinned, stageId), this.config.locale) : stageId } catch { return stageId } },
      artifactText: (digest: string) => this.workbench.kernel.blobs.text(digest),
      // A Jira user is mentioned only in Jira, and shown by name elsewhere.
      name: (actor: Actor) => {
        const username = this.username(actor)
        return username ? `@${username}` : actor.source !== 'jira' ? `@${actor.id}` : source === 'jira' ? `[~${actor.id}]` : actor.id
      },
      maxChars: maxCharsFor(source),
      reportOutput: (attemptId: string) => {
        const event = this.workbench.kernel.engine.events(jobId).find(candidate => candidate.type === 'AttemptReported' && candidate.attemptId === attemptId)
        return event?.type === 'AttemptReported' && event.report.outcome === 'completed' ? event.report.output : undefined
      },
      delivered: () => ({ mergeRequest: lastMergeRequest(this.workbench, jobId), commit: lastPushedSha(this.workbench, jobId) }),
      // `*` (any allowed sender) names nobody in particular, so a post names only the people; a person is mentioned only by their
      // name in this post's source, and written plainly when known only elsewhere, so no one of the same name elsewhere is pinged.
      approvers: () => {
        if (!job?.requester) return []
        const people = this.approverPeople(job.workflowId, pinned?.extra.repository?.name ?? null, job.requester)
        const here = people.filter(person => person.source === source)
        return [...new Set([...here.map(person => mention(person.name)),
          ...people.filter(person => person.source !== source && !here.some(other => other.name === person.name)).map(person => person.name)])]
      },
    }
  }

  private async registerWorkflows(): Promise<void> {
    const { workflows } = this.config
    const specs: WorkflowSpec[] = []
    if (workflows.standardDelivery) specs.push(standardDelivery())
    if (workflows.synthetic || this.config.demo) specs.push(syntheticHotfix())
    const load = this.options.load ?? (path => import(path))
    for (const path of workflows.modules) {
      const module = await load(path) as WorkflowModule
      if (typeof module.workflows !== 'function') throw new Error(`Workflow module ${path} must export a \`workflows()\` function`)
      this.modules.push(module)
      specs.push(...[await module.workflows()].flat())
      for (const [name, guard] of Object.entries(module.guards?.() ?? {})) this.workbench.registerGuard(name, guard)
    }
    for (const spec of specs) this.workbench.register(spec)
  }

  /**
   * The workbench's Jira comments of the last week, from its post effects (`A8`): a new connector (after a restart, or a settings
   * change) still skips them when it polls, though on a person's account their author is that person.
   */
  private ownJiraComments(): string[] {
    const since = this.workbench.kernel.env.clock.now() - OWN_COMMENTS_MS
    return this.workbench.kernel.db.all<{ thread: string | null; post: string | number | null }>(`SELECT json_extract(result, '$.ok.threadKey') AS thread,
      json_extract(result, '$.ok.postId') AS post FROM effect WHERE status = 'succeeded' AND due_at >= ? AND json_extract(result, '$.ok.threadKey') LIKE 'jira:%'`, since)
      .flatMap(row => row.thread && row.post !== null ? [`${row.thread.slice('jira:'.length)}#${row.post}`] : [])
  }

  /**
   * Checks the account Jira logs in as against the bot's name (`A8`). Comments by the bot's name are skipped as the workbench's own,
   * so when that name is the login account's and the policy names that account as a person (a sender or an approver), the person's
   * comments would be skipped: on a person's account the bot's name must be one nobody has. Logged; it does not stop the workbench.
   */
  private async checkJiraAccount(): Promise<void> {
    const { jira } = this.connectors()
    if (!jira) return
    const { botUsername, botAccountId } = resolveJiraConfig(this.sources.instance<JiraSourceConfig>('jira')?.config)
    let me: { name?: string; accountId?: string }
    try {
      me = await jira.myself()
    } catch (error) {
      this.ctx.logger.info('workflow-agent could not read the Jira login account: %s', String(error))
      return
    }
    const { policy } = this.config
    const people = new Set([...policy.senders.jira ?? [], ...allowedSendersOf(process.env.WORKBENCH_ALLOWED_SENDERS),
      ...Object.values(policy.approvers).flatMap(bySource => bySource.jira ?? []),
      ...this.config.repositories.flatMap(profile => profile.senders?.jira ?? []),
      ...Object.values(this.approvers).flatMap(bySource => bySource.jira ?? [])])
    const login = me.name ?? me.accountId
    const account = jiraAccount(me, { ...botUsername ? { botUsername } : {}, ...botAccountId ? { botAccountId } : {} }, people)
    if (account === 'person') this.ctx.logger.info('workflow-agent: Jira logs in as %s, a person\'s account; the workbench knows its own comments by their ids', login)
    if (account === 'clash') {
      this.ctx.logger.warn('workflow-agent: Jira logs in as %s, which is also the bot\'s name, and the policy names %s as a person: its comments are '
        + 'skipped as the workbench\'s own, and a mention of it starts jobs. On a person\'s account, set JIRA_BOT_USERNAME to a name nobody has, '
        + 'such as workbench (DEPLOYMENT, "A shared Jira account").', login, login)
    }
  }

  /** Resolves the Mattermost usernames the policy names and the bots' identities; retries while Mattermost is unreachable. */
  private async resolveIdentities(): Promise<void> {
    const { mattermost } = this.connectors()
    const jiraConfig = resolveJiraConfig(this.sources.instance<JiraSourceConfig>('jira')?.config)
    this.botIdentities.jira = [jiraConfig.botUsername, jiraConfig.botAccountId].filter((id): id is string => Boolean(id))
    if (!mattermost) return
    try {
      const bot = await mattermost.ensureBotIdentity()
      this.botIdentities.mattermost = [bot.userId, bot.username]
      const { policy } = this.config
      const names = [...new Set([...policy.senders.mattermost ?? [], ...allowedSendersOf(process.env.WORKBENCH_ALLOWED_SENDERS),
        ...Object.values(policy.approvers).flatMap(bySource => bySource.mattermost ?? []),
        ...this.config.repositories.flatMap(profile => profile.senders?.mattermost ?? [])].filter(name => name !== '*' && !/^[a-z0-9]{26}$/u.test(name)))]
      for (const user of names.length > 0 ? await mattermost.usersByUsername(names) : []) {
        if (!user.id) continue
        this.userIds.set(user.username.toLowerCase(), user.id)
        this.usernames.set(user.id, user.username)
      }
    } catch (error) {
      this.ctx.logger.warn('workflow-agent could not resolve Mattermost users, retrying: %s', String(error))
      if (!this.lifetime.aborted) this.resolveRetry = setTimeout(() => { void this.resolveIdentities() }, RESOLVE_RETRY_MS)
      this.resolveRetry?.unref?.()
    }
  }

  /**
   * Resolves each repository's approver emails to their Jira and Mattermost users (`D12`); retries while either tool is unreachable.
   * An email a tool has no user for is logged and left out.
   */
  private async resolveApprovers(): Promise<void> {
    const profiles = this.config.repositories.filter(profile => profile.approvers && profile.approvers.length > 0)
    if (profiles.length === 0) return
    const { jira, mattermost } = this.connectors()
    try {
      const missing: string[] = []
      for (const profile of profiles) {
        const bySource: Record<string, string[]> = { jira: [], mattermost: [] }
        for (const email of profile.approvers!) {
          const [jiraUser, mattermostUser] = await Promise.all([jira?.userByEmail(email), mattermost?.userByEmail(email)])
          if (jiraUser) bySource.jira!.push(jiraUser.name)
          if (mattermostUser) bySource.mattermost!.push(mattermostUser.id, mattermostUser.username)
          for (const [tool, connector, user] of [['Jira', jira, jiraUser], ['Mattermost', mattermost, mattermostUser]] as const) {
            if (connector && !user) missing.push(`${profile.name}: ${email} (${tool})`)
          }
        }
        this.approvers[profile.name] = bySource
      }
      if (missing.length > 0) this.ctx.logger.warn('workflow-agent found no user for these approvers: %s', missing.join(', '))
    } catch (error) {
      this.ctx.logger.warn('workflow-agent could not resolve repository approvers, retrying: %s', String(error))
      if (!this.lifetime.aborted) this.approverRetry = setTimeout(() => { void this.resolveApprovers() }, RESOLVE_RETRY_MS)
      this.approverRetry?.unref?.()
    }
  }

  /** The effective settings and where each comes from (`D9`), for the panel. */
  settings(): SettingsView {
    const { profile } = this.config
    return {
      models: { default: profile.defaultModel, ...profile.defaultEffort ? { effort: profile.defaultEffort } : {}, verdict: profile.verdictModel,
        from: 'profile `models`, else LITELLM_MODEL' },
      policy: { ...this.policy(), from: 'profile `policy`, WORKBENCH_ALLOWED_SENDERS, repositories\' `approvers`, and identities resolved at startup' },
      maxWorkers: this.config.maxWorkers, locale: this.config.locale, demo: this.config.demo, repositories: this.config.repositories,
      workflows: this.workbench.kernel.registry.list().map(definition => {
        const declaration = definition.declaration as { title: string; stages: { id: string; title: string; titles?: Record<string, string>; model?: string; agentPreset: string; egress: string }[]
          budgets?: { turns: number; tokens: number; backtracks: number } }
        return { id: definition.id, version: definition.version, title: declaration.title, parameters: this.parameters(definition.id, undefined),
          stages: declaration.stages.map(stage => ({ id: stage.id, title: stageTitleIn(stage, this.config.locale), model: stage.model ?? profile.defaultModel, agentPreset: stage.agentPreset,
            egress: stage.egress })),
          ...declaration.budgets ? { budgets: { turns: declaration.budgets.turns, tokens: declaration.budgets.tokens, backtracks: declaration.budgets.backtracks } } : {} }
      }),
      links: { ...this.links(), from: 'profile `dashboard.links`, else the connectors\' base URLs' },
    }
  }

  /** What the dashboard's routes read (`D13`). */
  panelHost(): PanelHost {
    return {
      workbench: this.workbench, health: () => this.health.all, settings: () => this.settings(), secrets: () => this.secrets(),
      people: () => this.people(), links: () => this.links(), locale: () => this.config.locale, demo: () => this.config.demo,
      deciders: (workflowId, repository, requester) => this.deciders(workflowId, repository, requester), ticketTitle: key => this.ticketTitle(key),
      renderPost: (jobId, threadKey, message) => this.renderPost(jobId, threadKey, message),
      trace: sessionId => readTrace(this.ctx.sessionPersistence as unknown as SessionReader, sessionId),
    }
  }

  /** The dashboard's routes, as its server serves them. */
  get api(): Routes { return routes(this.panelHost()) }

  /** The dashboard's address, once it listens. */
  get dashboardPort(): number | undefined { return this.dashboardServer?.port }

  /**
   * Mattermost user ids the runtime knows, to their usernames: the policy's users, the bot, requesters and the last 1000 inbox authors, when
   * the connector has already seen their name (its cache is read; no request is made).
   */
  private people(): Record<string, string> {
    const people: Record<string, string> = {}
    const mattermost = this.connectors().mattermost
    if (mattermost) {
      for (const { id } of this.workbench.kernel.db.all<{ id: string }>(`SELECT requester_id AS id FROM job_summary WHERE requester_source = 'mattermost'
        UNION SELECT actor_id FROM (SELECT actor_source, actor_id FROM inbox_event ORDER BY rowid DESC LIMIT 1000)
        WHERE actor_source = 'mattermost' AND actor_id IS NOT NULL`)) {
        const name = mattermost.knownUsername(id)
        if (name) people[id] = name
      }
    }
    for (const [id, name] of this.usernames) people[id] = name
    const [botId, botName] = this.botIdentities.mattermost ?? []
    if (botId && botName) people[botId] = botName
    return people
  }

  /** Where threads open: the profile's `dashboard.links`, else the connectors' base URLs. */
  links(): Links {
    const trim = (url: string | undefined) => url?.replace(/\/+$/u, '') || undefined
    const configured = this.config.dashboard.links
    const jira = trim(configured.jira ?? resolveJiraConfig(this.sources.instance<JiraSourceConfig>('jira')?.config).baseUrl)
    const mattermost = trim(configured.mattermost ?? resolveMattermostConfig(this.sources.instance<MattermostSourceConfig>('mattermost')?.config).baseUrl)
    const gitlab = trim(configured.gitlab ?? resolveGitLabConfig(this.sources.instance<GitLabSourceConfig>('gitlab')?.config).baseUrl)
    return { ...jira ? { jira } : {}, ...mattermost ? { mattermost } : {}, ...gitlab ? { gitlab } : {} }
  }

  /** The people `deciders()` names, each with the source the name belongs to (`*` left out). */
  private approverPeople(workflowId: string, repository: string | null, requester: Actor): { source: string; name: string }[] {
    const policy = this.policy()
    const person = (source: string, id: string) => ({ source, name: (source === 'mattermost' ? this.username({ source, id }) : undefined) ?? id })
    const pick = (bySource: Readonly<Record<string, readonly string[]>>) => Object.entries(bySource).flatMap(([source, ids]) => ids.filter(id => id !== '*').map(id => person(source, id)))
    const byRepository = repository ? policy.repositoryApprovers?.[repository] : undefined
    if (byRepository) return pick(byRepository)
    const workflow = policy.approvers[workflowId] ?? {}
    const anyone = Object.values(workflow).some(ids => ids.includes('*'))
    return [...!anyone && eligible(policy, requester, 'sender') ? [person(requester.source, requester.id)] : [], ...pick(workflow)]
  }

  /**
   * Who decides a job's approval and resume gates, as `eligible()` rules: its repository's approvers when the repository lists any;
   * else the requester (while an allowed sender), the workflow's approvers, and `*` where any allowed sender may. Mattermost ids are
   * shown by name.
   */
  private deciders(workflowId: string, repository: string | null, requester: Actor): string[] {
    const policy = this.policy()
    // A resolved Mattermost id becomes its name (and merges with it); an id with no name yet is shown as it is, never dropped.
    const name = (source: string, id: string) => (source === 'mattermost' ? this.username({ source, id }) : undefined) ?? id
    const names = (bySource: Readonly<Record<string, readonly string[]>>) => Object.entries(bySource).flatMap(([source, ids]) => ids.map(id => id === '*' ? id : name(source, id)))
    const byRepository = repository ? policy.repositoryApprovers?.[repository] : undefined
    if (byRepository) return [...new Set(names(byRepository))]
    const approvers = names(policy.approvers[workflowId] ?? {})
    // `*` covers the requester: both are allowed senders.
    const own = !approvers.includes('*') && eligible(policy, requester, 'sender') ? [name(requester.source, requester.id)] : []
    return [...new Set([...own, ...approvers])]
  }

  /** A Jira ticket's summary, cached; an unknown or stale one is read in the background and shown on the next poll. */
  private ticketTitle(key: string): string | undefined {
    const cached = this.titles.get(key)
    const now = this.workbench.kernel.env.clock.now()
    // A lookup that never settled is tried again after a minute; at most four run at once.
    if (cached && (cached.pending ? now - cached.at < 60_000 : now - cached.at < TITLE_TTL_MS)) return cached.title
    const jira = this.connectors().jira
    const inFlight = [...this.titles.values()].filter(entry => entry.pending && now - entry.at < 60_000).length
    if (!jira || this.titles.size > 5000 || inFlight >= 4) return cached?.title
    this.titles.set(key, { ...cached?.title ? { title: cached.title } : {}, at: now, pending: true })
    void jira.getIssue(key).then(issue => { this.titles.set(key, { title: issue.summary || undefined, at: this.workbench.kernel.env.clock.now() }) },
      () => { this.titles.set(key, { ...cached?.title ? { title: cached.title } : {}, at: this.workbench.kernel.env.clock.now() }) })
    return cached?.title
  }

  /** A post's text as the workbench sends it to its thread, or null when it cannot be rendered. */
  private renderPost(jobId: string, threadKey: string, message: unknown): string | null {
    // Jira and GitLab have their own formatting; chat-like threads (Mattermost, the demo's) take Mattermost's.
    const prefix = threadKey.split(':')[0]
    const source = prefix === 'jira' || prefix === 'gitlab' ? prefix : 'mattermost'
    try { return render(message as Parameters<typeof render>[0], this.renderContext(jobId, source)) } catch { return null }
  }

  /** Starts the dashboard's server; a port it cannot take is reported in health, and the workbench runs on. */
  private async openDashboard(): Promise<void> {
    const options = this.options.dashboard
    if (!options) return
    const entry = this.health.claim('dashboard', { state: 'starting', detail: '' })
    // Every address (a container publishing the port) is opened as loopback.
    const shown = options.host === '0.0.0.0' ? '127.0.0.1' : options.host
    try {
      this.dashboardServer = await startDashboard({ ...options, assets: this.options.dashboardAssets ?? join(packageRoot(), 'lib', 'dashboard'),
        // Read per request: `ready` is assigned only once this method has returned its promise.
        routes: this.api, ready: () => this.ready, secrets: () => this.secrets(), log: message => { this.ctx.logger.warn(message) } })
      // A stop while it was starting found no server to close.
      if (this.lifetime.aborted) { await this.dashboardServer.close(); return }
      entry.set({ state: 'ready', at: new Date().toISOString(), detail: `Serving http://${shown}:${this.dashboardServer.port}/` })
      this.ctx.logger.info('workflow-agent dashboard: http://%s:%d/', shown, this.dashboardServer.port)
    } catch (error) {
      entry.set({ state: 'error', detail: `The dashboard could not listen on ${options.host}:${options.port}: ${error instanceof Error ? error.message : String(error)}` })
      this.ctx.logger.warn('workflow-agent dashboard could not listen on %s:%d: %s', options.host, options.port, String(error))
    }
  }

  /** The deployment's secret values, redacted from everything the panel shows. */
  secrets(): string[] {
    return ['LITELLM_API_KEY', 'DEEPSEEK_API_KEY', 'MATTERMOST_TOKEN', 'JIRA_TOKEN', 'JIRA_PASSWORD', 'GITLAB_TOKEN']
      .flatMap(name => process.env[name] ? [process.env[name]!] : [])
  }

  private async initialize(): Promise<void> {
    await this.openDashboard()
    await writeEnvironment({ stateDir: this.config.stateDir })
    assertSandboxWrapper(process.platform, this.ctx.get('sandbox') as { runnerCommand?: readonly string[] } | undefined, this.config.demo)
    this.sandbox.configure()
    this.stopShellVariable = this.sandbox.registerShellVariable(this.ctx, sessionId => this.runner.jobOfSession(sessionId))
    await this.registerWorkflows()
    await this.resolveIdentities()
    await this.resolveApprovers()
    await this.checkJiraAccount()
    const report = this.workbench.start()
    if (this.config.demo) this.stopDemo = startDemoSource(this.workbench)
    this.runtimeHealth.set({ state: 'ready', at: new Date().toISOString(),
      detail: `Ready; recovered ${report.interrupted} interrupted attempts, ${report.routed} waiting events, ${report.firedTimers} overdue timers` })
  }

  stop(): Promise<void> { return this.stopping ??= this.shutdown() }

  private async shutdown(): Promise<void> {
    this.stopped.abort()
    clearTimeout(this.resolveRetry)
    clearTimeout(this.approverRetry)
    this.stopDemo?.()
    await this.dashboardServer?.close().catch(() => {})
    this.stopShellVariable?.()
    this.egress.closeAll()
    this.toolchainEgress.closeAll()
    try {
      this.runner.shutdown()
      await this.workbench.stop()
      await this.ctx.sessionPersistence.flush().catch(() => {})
    } finally {
      try { this.workbench.close() } finally { this.releaseLock() }
    }
  }
}

/**
 * A new job's parameters (`T11.1`): its repository's (`{{repository}}`, `{{testCommand}}`, `ci`, …), then the workflow's own
 * (standard-delivery's Jira status names, or a module's parameters), which are kept over the repository's.
 */
export function jobParameters(own: Readonly<Record<string, string>>, repository: RepositoryProfile | undefined): Record<string, string> {
  return { ...repository ? repositoryParameters(repository) : {}, ...own }
}

/** The key of the Jira ticket a job is bound to, if any. */
const ticketOf = (state: JobState): string | undefined =>
  state.bindings.map(binding => /^jira:(.+)$/u.exec(binding.threadKey)?.[1]).find(key => key !== undefined)

/** What a job's proxy connection is recorded against: its running attempt, or `setup` while the setup step runs (`T11.4`). */
export function connectionLabel(state: JobState | undefined): string | undefined {
  return state?.status.kind === 'setting_up' ? 'setup' : state?.attempt?.id
}

/**
 * The image's prepared test services (`T12.1`): `WORKBENCH_SERVICES_DIR`, set by the image, with its `hosts` file, and the Postgres
 * majors prepared there. Without it, no job has test services.
 */
export function testServices(env: NodeJS.ProcessEnv): { root: string; postgres: string[] } | undefined {
  const root = env.WORKBENCH_SERVICES_DIR
  if (!root?.startsWith('/') || !existsSync(join(root, 'hosts'))) return undefined
  const postgres = POSTGRES_MAJORS.filter(major => existsSync(join(root, 'postgres', major)))
  return postgres.length > 0 ? { root, postgres } : undefined
}

/**
 * The toolchain cache and the `mise` binary (`T11.2`): `WORKBENCH_TOOLCHAINS_DIR` and `WORKBENCH_MISE`, set by the image. Without
 * either, a job whose repository needs toolchains blocks at its setup step.
 */
export function toolchainCache(env: NodeJS.ProcessEnv): { root: string; mise: string } | undefined {
  const root = env.WORKBENCH_TOOLCHAINS_DIR, mise = env.WORKBENCH_MISE
  return root && mise && root.startsWith('/') && mise.startsWith('/') && existsSync(mise) ? { root, mise } : undefined
}
