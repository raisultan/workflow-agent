/**
 * The host's side of the sandbox wrapper (`T10.3`, `src/sandbox/`): what the wrapper reads, written where no sandbox can see it.
 *
 * - **Configuration.** At startup the host writes the deployment's paths (the masks, the work root, the job files, the worker git
 *   config) to `<stateDir>/sandbox/config.json`, and sets `WORKBENCH_SANDBOX_CONFIG` in its own environment, which every confined
 *   command inherits; the agent cannot change a spawn's environment.
 * - **Job files.** Before an attempt runs, the host writes `<stateDir>/sandbox/jobs/<jobId>.json`: the job's worktree, the
 *   stage's egress profile frozen in the job's manifest, and for `registries` the job's proxy socket (`egress.ts`).
 * - **The job of a shell.** `DSH_WORKBENCH_JOB` is registered in DSH's `shellEnv`, resolved per shell call from the calling session:
 *   a stage attempt's session names its job, any other session names none.
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_VARIABLE, JOB_VARIABLE, type JobFile, type StageEgress, type WrapperConfig } from '../sandbox/profile.ts'

/** What the host needs of DSH's `shellEnv` registry. */
interface ShellEnv {
  register(contributor: { name: string; variables: Record<string, { description: string }>;
    resolve(execution: { agent?: { session: { header: { id: string } } } }): Record<string, string> }): () => void
}

export interface SandboxHostOptions {
  readonly stateDir: string
  readonly workRoot: string
  readonly dshHome: string
  readonly gitConfig: string
  /** `bwrap` (default `bwrap` on the `PATH`). */
  readonly bwrap?: string
  /** The Node binary (this process's by default) and the in-sandbox bridge script (`lib/sandbox-bridge.js`). */
  readonly node?: string
  readonly bridge: string
  /** The shared toolchain cache and the `mise` binary (`T11.2`); without them, no job can install toolchains. */
  readonly toolchains?: string
  readonly mise?: string
  /** The image's prepared test services (`T12.1`, `WORKBENCH_SERVICES_DIR`); without them, no job has test services. */
  readonly services?: string
}

/** Writes the sandbox wrapper's configuration and job files, and names the job of each agent shell. */
export class SandboxHost {
  readonly configPath: string
  readonly jobsDir: string
  private readonly options: SandboxHostOptions

  constructor(options: SandboxHostOptions) {
    this.options = options
    const dir = join(options.stateDir, 'sandbox')
    this.configPath = join(dir, 'config.json')
    this.jobsDir = join(dir, 'jobs')
  }

  /** Writes the wrapper's configuration and points this process's environment at it. */
  configure(env: NodeJS.ProcessEnv = process.env): WrapperConfig {
    const { stateDir, workRoot, dshHome, gitConfig } = this.options
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 })
    const config: WrapperConfig = { bwrap: this.options.bwrap ?? 'bwrap', masks: [dshHome, stateDir, workRoot], workRoot, jobs: this.jobsDir, gitConfig,
      node: this.options.node ?? process.execPath, bridge: this.options.bridge,
      ...this.options.toolchains && this.options.mise ? { toolchains: this.options.toolchains, mise: this.options.mise } : {},
      ...this.options.services ? { services: this.options.services } : {} }
    atomicWrite(this.configPath, `${JSON.stringify(config, null, 2)}\n`)
    env[CONFIG_VARIABLE] = this.configPath
    return config
  }

  /**
   * Records the job's worktree, the egress profile of the stage about to run, its proxy sockets, its toolchains' directories
   * (`T11.4`), and its test services (`T12.4`).
   */
  prepareJob(jobId: string, job: { worktree: string; egress: StageEgress; socket?: string; toolchainSocket?: string; toolchains?: readonly string[];
    services?: { postgres: string } }): void {
    const file: JobFile = { jobId, worktree: job.worktree, egress: job.egress, ...job.socket ? { socket: job.socket } : {},
      ...job.toolchainSocket ? { toolchainSocket: job.toolchainSocket } : {}, ...job.toolchains?.length ? { toolchains: { path: [...job.toolchains] } } : {},
      ...job.services ? { services: { postgres: job.services.postgres } } : {} }
    atomicWrite(join(this.jobsDir, `${jobId}.json`), `${JSON.stringify(file)}\n`)
  }

  /** Registers `DSH_WORKBENCH_JOB` in DSH's `shellEnv`; `jobOf` names the job of a session, if any. */
  registerShellVariable(ctx: Context, jobOf: (sessionId: string) => string | undefined): () => void {
    const shellEnv = ctx.get('shellEnv') as ShellEnv | undefined
    if (!shellEnv) return () => {}
    return shellEnv.register({ name: 'workbench-job', variables: { [JOB_VARIABLE]: { description: 'The workbench job this shell works for.' } },
      resolve: execution => {
        const jobId = execution.agent ? jobOf(execution.agent.session.header.id) : undefined
        const values: Record<string, string> = {}
        if (jobId) values[JOB_VARIABLE] = jobId
        return values
      } })
  }
}

function atomicWrite(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}
