/**
 * The setup step (`T11.4`, `D10` decision 3): a long effect, once per job worktree before the first stage, safe to repeat.
 *
 * 1. **The worktree**: cloned by the host, as for a stage.
 * 2. **The pins**: read by the host from the repository's files (`toolchain-files.ts`, `domain/toolchains.ts`), with the profile's
 *    defaults for unpinned tools. A pin that cannot be honoured blocks the step.
 * 3. **The test services** (`T12.4`): the Postgres major from the image tags the repository's CI and Compose files name
 *    (`service-files.ts`, `domain/services.ts`), or the profile's `postgres`; a major the image does not have blocks the step.
 * 4. **The toolchains**: for each tool, under the host profile `toolchain` (no worktree, only the cache writable, the toolchain
 *    proxy): `mise install <backend>:<tool>@<version>`, then `mise where` for the exact version's directory. The host checks that
 *    the directory is inside the cache's installs and is named by a plain version, then runs the tool's version command there,
 *    under the host profile `verify` (no network, the cache read-only), and checks it prints that version; a tool that fails the
 *    check is reinstalled once (`--force`), and blocks if it fails again.
 * 5. **A virtual environment** for a job with Python (`T11.5`), at `<worktree>/.home/venv`, made with the pinned Python under the host
 *    profile `setup`: every sandbox of the job puts it first on `PATH`, so `pip install` lands in the job's home, never the cache.
 * 6. **The setup command**, if the profile has one, under the host profile `setup`: in the job's worktree, with the `registries`
 *    proxy and the toolchains first on `PATH`.
 *
 * Every failure is the environment's, not the agent's: the result is `blocked` with the end of the log, and the job asks its owner
 * to retry or cancel. The installed toolchains are the result, recorded on the job (`SetupCompleted`).
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { JobServices, SetupPayload, Toolchain } from '../domain/job.ts'
import type { RepositoryProfile } from '../domain/repositories.ts'
import { chooseServices } from '../domain/services.ts'
import { resolveToolchains, type ToolName } from '../domain/toolchains.ts'
import type { Workbench } from '../domain/workbench.ts'
import { redactCredentials } from '../infra/redact.ts'
import type { EffectHandler, EffectResult } from '../kernel/effects.ts'
import { toolchainDirs, type HostProfile } from '../sandbox/profile.ts'
import { readServiceImages } from './service-files.ts'
import { readToolchainFiles } from './toolchain-files.ts'

/** How each allowed tool is installed and found (DESIGN §5.5): its backend, its directory under the installs, its binaries, its version command. */
export const TOOLS: Readonly<Record<ToolName, { spec: string; dir: string; bin: string; exe: string; version: string }>> = {
  node: { spec: 'core:node', dir: 'node', bin: 'bin', exe: 'node', version: '--version' },
  python: { spec: 'core:python', dir: 'python', bin: 'bin', exe: 'python3', version: '--version' },
  go: { spec: 'core:go', dir: 'go', bin: 'bin', exe: 'go', version: 'version' },
  uv: { spec: 'aqua:astral-sh/uv', dir: 'aqua-astral-sh-uv', bin: '.mise-bins', exe: 'uv', version: '--version' },
  pnpm: { spec: 'aqua:pnpm/pnpm', dir: 'aqua-pnpm-pnpm', bin: '.', exe: 'pnpm', version: '--version' },
}

export type ConfinedRun = (command: { argv: readonly string[]; cwd: string; timeoutMs: number; signal: AbortSignal; jobId: string; profile: HostProfile }) =>
  Promise<{ exitCode: number | null; output: string; stdout: string }>

export interface SetupDeps {
  readonly workbench: Pick<Workbench, 'kernel'>
  prepareWorkspace(jobId: string): Promise<string>
  /** The repository profile the job's manifest froze. */
  repository(jobId: string): RepositoryProfile | undefined
  readonly run: ConfinedRun
  /** The toolchain cache and the `mise` binary; without them a job that needs toolchains blocks. */
  readonly toolchains?: { readonly root: string; readonly mise: string }
  /** The job's toolchain proxy and its registries proxy; each returns its socket. */
  openToolchainProxy(jobId: string): Promise<string>
  openRegistriesProxy(jobId: string): Promise<string>
  closeProxies(jobId: string): void
  /** The image's test services (`T12.1`): the Postgres majors it has. Without them, no job has test services. */
  readonly services?: { readonly postgres: readonly string[] }
  /** Writes the job's sandbox file. */
  prepareJob(jobId: string, file: { worktree: string; socket?: string; toolchainSocket?: string; toolchains?: readonly string[] }): void
  readonly limit?: number
  readonly installTimeoutMs?: number
  readonly setupTimeoutMs?: number
}

const TAIL = 3000

/** Something that blocks the step, with the evidence to show. */
class Blocked extends Error {}

export function setupHandler(deps: SetupDeps): EffectHandler<SetupPayload> {
  const running = new Map<string, AbortController>()
  return {
    idempotent: true,
    long: true,
    limit: () => deps.limit ?? 2,
    async cancel(_payload, key) { running.get(key)?.abort() },
    async run(payload, key): Promise<EffectResult> {
      const controller = new AbortController()
      running.set(key, controller)
      const log: string[] = []
      try {
        return { ok: await setUp(deps, payload.jobId, controller.signal, log) }
      } catch (error) {
        const reason = error instanceof Blocked ? error.message : `the setup step failed: ${error instanceof Error ? error.message : String(error)}`
        const tail = redactCredentials(log.join('\n'))
        return { ok: { outcome: 'blocked', evidence: `${reason}${tail ? `\n${tail.length > TAIL ? `…${tail.slice(-TAIL)}` : tail}` : ''}` } }
      } finally {
        running.delete(key)
        deps.closeProxies(payload.jobId)
      }
    },
  }
}

async function setUp(deps: SetupDeps, jobId: string, signal: AbortSignal, log: string[]) {
  const worktree = await deps.prepareWorkspace(jobId)
  const profile = deps.repository(jobId)
  if (!profile) return { outcome: 'passed' as const, toolchains: [], ignored: [], evidence: 'no repository' }
  const files = readToolchainFiles(worktree)
  const resolution = resolveToolchains(files.files, profile.toolchains)
  const errors = [...files.errors, ...resolution.errors]
  if (errors.length > 0) throw new Blocked(`the repository's toolchain pins cannot be used:\n- ${errors.join('\n- ')}`)
  // The Postgres major for the job's test services, from the image tags its CI names (`T12.4`).
  let services: JobServices | undefined
  const notes: string[] = []
  if (deps.services) {
    const read = readServiceImages(worktree)
    const choice = chooseServices({ images: read.images, unreadable: read.unreadable, available: deps.services.postgres,
      ...profile.postgres ? { override: profile.postgres } : {} })
    if (choice.kind === 'error') throw new Blocked(`the job's test services cannot be set up: ${choice.error}`)
    services = choice.services
    notes.push(...choice.notes)
  }
  const step = async (argv: readonly string[], profileName: HostProfile, cwd: string, timeoutMs: number) => {
    if (signal.aborted) throw new Blocked('the setup step was stopped')
    const result = await deps.run({ argv, cwd, timeoutMs, signal, jobId, profile: profileName })
    log.push(`$ ${argv.join(' ')}`, result.output.trim(), result.exitCode === 0 ? '' : `(exit ${result.exitCode ?? 'stopped'})`)
    return result
  }

  const toolchains: Toolchain[] = []
  if (resolution.tools.length > 0) {
    if (!deps.toolchains) throw new Blocked('this deployment has no toolchain cache (WORKBENCH_TOOLCHAINS_DIR and WORKBENCH_MISE), so it cannot install toolchains')
    const { root, mise } = deps.toolchains
    const installs = toolchainDirs(realpathSync(root)).installs
    deps.prepareJob(jobId, { worktree, toolchainSocket: await deps.openToolchainProxy(jobId) })
    const timeoutMs = deps.installTimeoutMs ?? 20 * 60_000
    for (const pinned of resolution.tools) {
      const tool = TOOLS[pinned.tool]
      const spec = `${tool.spec}@${pinned.version}`
      const install = async (force: boolean) => {
        const installed = await step([mise, 'install', ...force ? ['--force'] : [], spec], 'toolchain', root, timeoutMs)
        if (installed.exitCode !== 0) throw new Blocked(`${pinned.tool} ${pinned.version} could not be installed`)
        const where = await step([mise, 'where', spec], 'toolchain', root, 60_000)
        const directory = where.exitCode === 0 ? installedDirectory(where.stdout, installs, tool.dir) : undefined
        if (!directory) throw new Blocked(`${pinned.tool} ${pinned.version}: mise did not name an installed directory of its own`)
        const bin = tool.bin === '.' ? directory.path : join(directory.path, tool.bin)
        // Offline, with the cache read-only: what runs here is the downloaded binary.
        const version = await step([join(bin, tool.exe), tool.version], 'verify', root, 60_000)
        return version.exitCode === 0 && printsVersion(version.output, directory.version) ? { version: directory.version, bin } : undefined
      }
      const ready = await install(false) ?? await install(true)
      if (!ready) throw new Blocked(`${pinned.tool} ${pinned.version} was installed, but its ${tool.exe} does not run or prints another version`)
      toolchains.push({ tool: pinned.tool, requested: pinned.version, from: pinned.from, version: ready.version, bin: ready.bin })
    }
  }

  const python = toolchains.find(toolchain => toolchain.tool === 'python')
  if (python || profile.setupCommand) {
    deps.prepareJob(jobId, { worktree, socket: await deps.openRegistriesProxy(jobId), toolchains: toolchains.map(toolchain => toolchain.bin) })
  }
  if (python) {
    const venv = await step([join(python.bin, 'python3'), '-m', 'venv', join(worktree, '.home', 'venv')], 'setup', worktree, 5 * 60_000)
    if (venv.exitCode !== 0) throw new Blocked(`a virtual environment could not be made with python ${python.version}`)
  }
  if (profile.setupCommand) {
    const result = await step(['sh', '-c', profile.setupCommand], 'setup', worktree, deps.setupTimeoutMs ?? 30 * 60_000)
    if (result.exitCode !== 0) throw new Blocked(`the setup command failed: ${profile.setupCommand}`)
  }
  const summary = [...toolchains.map(toolchain => `${toolchain.tool} ${toolchain.version}`), ...services ? [`Postgres ${services.postgres}`] : []].join(', ')
  const evidence = [summary || 'no toolchains', ...notes.map(note => `note: ${note}`)].join('\n')
  return { outcome: 'passed' as const, toolchains, ignored: [...resolution.ignored], ...services ? { services } : {}, evidence }
}

/**
 * The exact version's directory from `mise where`'s output, if it is `<installs>/<dir>/<plain version>` with its links resolved:
 * never a moving link such as `22` or `latest`, nor anything outside the cache.
 */
export function installedDirectory(stdout: string, installs: string, dir: string): { path: string; version: string } | undefined {
  const named = stdout.trim().split('\n').at(-1)?.trim()
  if (!named?.startsWith('/')) return undefined
  let path: string
  try { path = realpathSync(named) } catch { return undefined }
  const version = basename(path)
  if (dirname(path) !== join(installs, dir) || !/^\d+(?:\.\d+)*$/u.test(version)) return undefined
  return { path, version }
}

/** Whether a version command's output names `version` as a whole version (`22.12.0`, not `22.12.01`). */
export function printsVersion(output: string, version: string): boolean {
  return new RegExp(`(?:^|[^0-9.])v?(?:go)?${version.replace(/\./gu, '\\.')}(?![0-9.]*[0-9])`, 'u').test(output)
}
