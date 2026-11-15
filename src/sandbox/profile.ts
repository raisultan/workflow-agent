/**
 * The sandbox wrapper's plan (`T10.2`, `T10.3`): what one confined command may see, decided only from inputs the host controls.
 *
 * DSH's `dsh-sandbox-local` runs `<runnerCommand> <bwrap profile arguments> -- <command>` for every confined command (agent shells,
 * their background jobs, and the host's checks). The wrapper keeps nothing of DSH's profile but the mode and the writable root it
 * names, and builds its own `bwrap` command line:
 *
 * - **Job.** An agent shell names its job in `DSH_WORKBENCH_JOB`, which the workbench registers in DSH's `shellEnv` and DSH sets on
 *   every shell spawn (the model cannot add variables to a spawn). A host-run command names it in `WORKBENCH_SANDBOX_JOB`, with
 *   its profile in `WORKBENCH_SANDBOX_PROFILE`, in the environment the host spawns it with. The working directory is never used:
 *   the agent chooses it.
 * - **Worktree.** In workspace-write, DSH's `--bind` root must be the job's own worktree, as the host recorded it in the job's
 *   file; anything else is refused. A read-only command, or one with no known job, gets no worktree at all.
 * - **Masks.** `$DSH_HOME` (credentials, every session log), the state directory, the work root (every job's worktree) and `/tmp`
 *   are covered with empty `tmpfs` mounts; the job's worktree is bound back, and the worker git config is bound back read-only.
 * - **Network** (`T10.2`). Every command runs in a new network namespace (`--unshare-net`), with only its own loopback. With the
 *   `registries` profile, the job's proxy socket is bound in, and an in-sandbox bridge serves it on `127.0.0.1:BRIDGE_PORT`, which
 *   the proxy variables name; nothing else is reachable.
 * - **Environment.** Credential-shaped and connector variables are removed; `HOME` is in the worktree; git reads only the worker
 *   git config; the proxy variables are set for `registries`.
 * - **Toolchains** (`T11.4`, `D10`). The host profile `toolchain` installs a job's toolchains with `mise`: no worktree at all (mise
 *   runs any repository configuration it can see, `T11.0`), an empty `/tmp` as its working directory, only the toolchain cache
 *   writable, the job's toolchain proxy, mise's settings fixed here (paranoid, precompiled Python only, no versions host, every
 *   backend but `core` and `aqua` disabled), and only `mise install` or `mise where`. The host profile `verify` runs an installed
 *   binary's version command, and nothing else, with no worktree, no network and the cache read-only, so a tampered binary
 *   that got past `mise`'s checks cannot reach the network or change the cache. The host profile `setup` runs the repository's
 *   setup command: as `check`, with the job's `registries` proxy.
 * - **Test services** (`T12.3`, `D11`). An agent's writable shell and the host profile `check`, for a job whose file names its
 *   services, run under the bridge's service launcher: Postgres (the job's major), RabbitMQ and Kafka on their usual loopback ports,
 *   each started on its first connection. The names `postgres`, `rabbitmq` and `kafka`, and the sandbox's own hostname, resolve to
 *   loopback through its own `/etc/hosts`, and the variables that name them are set after the credential filter, since they name servers that exist only in
 *   that sandbox.
 *
 * Every refusal is printed with the `workbench-sandbox: ` prefix, which DSH's `runnerFailureSignatures` treat as "the command did
 * not run".
 */
import { STRIPPED_WORKER_ENV_KEYS, WORKER_FORBIDDEN_ENV_PATTERN } from '../infra/worker-env.ts'
import { POSTGRES_MAJORS, SANDBOX_HOSTNAME, SERVICE_ENV, SERVICE_HOSTS } from './services.ts'

/** The prefix of everything the wrapper prints about itself; DSH's runner-failure signature. */
export const WRAPPER_PREFIX = 'workbench-sandbox: '
/** The variable an agent shell's job arrives in (set by DSH's `shellEnv`, from the workbench's contributor). */
export const JOB_VARIABLE = 'DSH_WORKBENCH_JOB'
/** The variables a host-run command's job and profile arrive in. */
export const HOST_JOB_VARIABLE = 'WORKBENCH_SANDBOX_JOB'
export const HOST_PROFILE_VARIABLE = 'WORKBENCH_SANDBOX_PROFILE'
/** The variable the wrapper finds its configuration file in; the workbench sets it in its own process at startup. */
export const CONFIG_VARIABLE = 'WORKBENCH_SANDBOX_CONFIG'
/** Where a job's proxy socket appears inside its sandbox, and the loopback port the bridge serves it on. */
export const SANDBOX_SOCKET = '/tmp/.workbench-egress.sock'
export const BRIDGE_PORT = 3128

/** A stage's network: none, or public package registries through the job's proxy. */
export type StageEgress = 'none' | 'registries'
/** A sandbox's network: a stage's, or the toolchain download hosts (the host profile `toolchain` only). */
export type Egress = StageEgress | 'toolchain'
/**
 * A host-run command's profile. `check`: the job's test command, offline, with its worktree writable. `fetch`: git's `upload-pack`
 * on the worktree's side of a fetch the host makes (the integrity diff, a push), offline, with the worktree read-only and everything
 * else masked, so a repository layout the agent wrote (alternates, `commondir`, symbolic links in `.git`) cannot reach another
 * job's repository, the state or `$DSH_HOME`.
 */
export type HostProfile = 'check' | 'fetch' | 'toolchain' | 'verify' | 'setup'
const HOST_PROFILES = new Set<string>(['check', 'fetch', 'toolchain', 'verify', 'setup'])

/** The cache's layout (`T11.4`): mise's data, cache and state directories, all kept, so an interrupted install is redone (`T11.0`). */
export const toolchainDirs = (root: string) => ({ data: `${root}/data`, cache: `${root}/cache`, state: `${root}/state`, installs: `${root}/data/installs` })

/** mise's backends; all but `core` and `aqua` are disabled in the toolchain sandbox (DESIGN §5.5). */
export const DISABLED_BACKENDS = ['asdf', 'cargo', 'conda', 'dotnet', 'forgejo', 'gem', 'github', 'gitlab', 'go', 'http', 'npm', 'packslip', 'pipx', 'pypi',
  's3', 'spinel', 'spm', 'ubi', 'vfox'] as const

/** The deployment's paths, written by the host at startup. */
export interface WrapperConfig {
  readonly bwrap: string
  /** Covered with `tmpfs` in every sandbox. */
  readonly masks: readonly string[]
  /** The directory of every job's worktree; each job's worktree is `<workRoot>/<jobId>`. */
  readonly workRoot: string
  /** The directory of the per-job files (`<jobs>/<jobId>.json`); it is under a masked directory. */
  readonly jobs: string
  /** The worker git config, bound back read-only. */
  readonly gitConfig: string
  /** The Node binary and the bridge script that run a `registries` command. */
  readonly node: string
  readonly bridge: string
  /** The shared toolchain cache (`T11.2`), outside every masked directory; and the `mise` binary, outside every `PATH`. */
  readonly toolchains?: string
  readonly mise?: string
  /** The image's prepared test services (`T12.1`), with the sandbox's `hosts` file; absent when the image has none. */
  readonly services?: string
}

/** What the host wrote about one job. */
export interface JobFile {
  readonly jobId: string
  readonly worktree: string
  readonly egress: StageEgress
  /** The job's proxy socket on the host, for `registries`. */
  readonly socket?: string
  /** The job's toolchain proxy socket, for the host profile `toolchain` while the setup step installs (`T11.4`). */
  readonly toolchainSocket?: string
  /** The job's toolchains (`T11.4`, `T11.5`): their exact version's binary directories, each inside the cache, put first on `PATH`. */
  readonly toolchains?: { readonly path: readonly string[] }
  /** The job's test services (`T12.4`): the Postgres major its setup step chose. Absent: the job has none. */
  readonly services?: { readonly postgres: string }
}

export interface PlanInput {
  /** The wrapper's arguments: DSH's profile arguments, `--`, then the command. */
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly config: WrapperConfig
  /** The job's file, or `undefined` when the host wrote none. */
  job(jobId: string): JobFile | undefined
  /** A path with its symbolic links resolved (the input itself when it does not exist). */
  real(path: string): string
  exists(path: string): boolean
}

export type Plan =
  | { readonly kind: 'run'; readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly job?: string; readonly egress: Egress }
  | { readonly kind: 'refuse'; readonly reason: string }

const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/u
/** Variables a sandbox never gets, besides the workbench's credential pattern. */
const DROPPED = /^(?:WORKBENCH_|DEEPSEEK_|MISE_|NODE_OPTIONS$|NODE_USE_ENV_PROXY$|(?:HTTPS?|ALL|NO|FTP)_PROXY$)/iu

/** Reads DSH's profile arguments: the mode, and the roots it binds writable. */
export function readProfile(args: readonly string[]): { mode: 'read-only' | 'workspace-write'; binds: string[]; command: string[] } | { error: string } {
  const separator = args.indexOf('--')
  if (separator === -1 || separator === args.length - 1) return { error: 'no command after --' }
  const profile = args.slice(0, separator)
  const binds: string[] = []
  let tmp = false
  for (let index = 0; index < profile.length; index++) {
    const arg = profile[index]!
    if (arg === '--bind') {
      const source = profile[index + 1], target = profile[index + 2]
      if (!source || source !== target) return { error: `an unexpected bind in DSH's profile: ${source} ${target}` }
      binds.push(source)
      index += 2
    } else if (arg === '--tmpfs') { tmp ||= profile[index + 1] === '/tmp'; index += 1 }
    else if (arg === '--ro-bind' || arg === '--dev' || arg === '--proc') index += arg === '--ro-bind' ? 2 : 1
  }
  return { mode: binds.length > 0 || tmp ? 'workspace-write' : 'read-only', binds, command: args.slice(separator + 1) }
}

/** The plan for one confined command. */
export function planSandbox(input: PlanInput): Plan {
  const profile = readProfile(input.args)
  if ('error' in profile) return { kind: 'refuse', reason: profile.error }
  const { config } = input
  const host = input.env[HOST_JOB_VARIABLE] !== undefined
  const jobId = host ? input.env[HOST_JOB_VARIABLE] : input.env[JOB_VARIABLE]
  if (jobId !== undefined && !JOB_ID.test(jobId)) return { kind: 'refuse', reason: `the job id ${JSON.stringify(jobId)} is not valid` }
  const hostProfile = input.env[HOST_PROFILE_VARIABLE]
  if (host && !HOST_PROFILES.has(hostProfile ?? '')) return { kind: 'refuse', reason: `unknown host profile ${JSON.stringify(hostProfile)}` }
  const job = jobId === undefined ? undefined : input.job(jobId)
  if (jobId !== undefined && !job) return { kind: 'refuse', reason: `job ${jobId} has no sandbox file; the host has not prepared it` }
  if (job && (job.egress as string) !== 'none' && job.egress !== 'registries') return { kind: 'refuse', reason: `job ${job.jobId}'s file names an unknown egress profile` }
  if (host && hostProfile === 'toolchain') return planToolchain(input, profile, job!)
  if (host && hostProfile === 'verify') return planVerify(input, profile, job!)

  let worktree: string | undefined, readOnly = false
  if (host && hostProfile === 'fetch') {
    // DSH's read-only mode binds nothing; the fetch profile binds the job's own worktree back, read-only.
    if (profile.mode !== 'read-only') return { kind: 'refuse', reason: 'the fetch profile runs read-only' }
    const expected = input.real(job!.worktree)
    if (!expected.startsWith(`${input.real(config.workRoot)}/`)) return { kind: 'refuse', reason: `job ${job!.jobId}'s worktree is outside the work root` }
    worktree = expected
    readOnly = true
  } else if (profile.mode === 'workspace-write') {
    if (!job) return { kind: 'refuse', reason: 'a writable sandbox needs a job, and this command names none' }
    const expected = input.real(job.worktree)
    const roots = profile.binds.map(root => input.real(root))
    if (roots.length !== 1 || roots[0] !== expected) {
      return { kind: 'refuse', reason: `the writable root ${profile.binds.join(', ') || '(none)'} is not job ${job.jobId}'s worktree` }
    }
    if (!expected.startsWith(`${input.real(config.workRoot)}/`)) return { kind: 'refuse', reason: `job ${job.jobId}'s worktree is outside the work root` }
    worktree = expected
  }
  // A host-run command is offline, except the setup command, which reaches the job's registries (`T11.4`).
  const egress: StageEgress = host ? (hostProfile === 'setup' ? 'registries' : 'none') : profile.mode === 'read-only' || !job ? 'none' : job.egress
  if (host && hostProfile === 'setup' && profile.mode !== 'workspace-write') return { kind: 'refuse', reason: 'the setup profile runs in the job\'s worktree' }
  if (egress === 'registries' && (!job?.socket || !input.exists(job.socket))) {
    return { kind: 'refuse', reason: `job ${job?.jobId}'s egress proxy is not running` }
  }
  // Test services for an agent's writable shell and the host's checks, never a read-only command, a fetch or the setup (`T12.3`).
  const withServices = job?.services !== undefined && worktree !== undefined && !readOnly && (host ? hostProfile === 'check' : true)
  const services = withServices ? servicesOf(input, job!) : undefined
  if (services && 'error' in services) return { kind: 'refuse', reason: services.error }

  const argv: string[] = [config.bwrap, '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent',
    '--new-session', '--unshare-net', '--tmpfs', '/tmp']
  // Parents before children, so a nested mask is not hidden by its parent's.
  const masks = [...new Set(config.masks.map(path => input.real(path)))].filter(path => input.exists(path)).sort((a, b) => a.length - b.length)
  for (const mask of masks) argv.push('--tmpfs', mask)
  if (worktree) argv.push(readOnly ? '--ro-bind' : '--bind', worktree, worktree)
  if (input.exists(config.gitConfig)) argv.push('--ro-bind', config.gitConfig, config.gitConfig)
  if (egress === 'registries') argv.push('--ro-bind', job!.socket!, SANDBOX_SOCKET)
  if (services) argv.push('--unshare-uts', '--hostname', SANDBOX_HOSTNAME, '--ro-bind', services.hosts, '/etc/hosts')
  // The masks are empty and stay empty: nothing written there could reach the host anyway, but nothing should look like it does.
  for (const mask of masks) argv.push('--remount-ro', mask)
  // The command starts where DSH asked when that is inside the worktree; anywhere else is masked or read-only, so it starts in the
  // worktree (or in the empty /tmp, with no worktree).
  const cwd = input.real(input.cwd)
  argv.push('--chdir', !worktree ? '/tmp' : cwd === worktree || cwd.startsWith(`${worktree}/`) ? cwd : worktree)
  const bridge = [...egress === 'registries' ? ['--egress'] : [], ...services ? ['--services', services.root, '--postgres', services.postgres] : []]
  argv.push('--', ...bridge.length > 0 ? [config.node, config.bridge, ...bridge, '--'] : [], ...profile.command)
  const env = sandboxEnv(input.env, { worktree, egress, gitConfig: config.gitConfig })
  // Every sandbox of the job gets its toolchains first on PATH (`T11.5`), except git's upload-pack for a host fetch.
  const path = job && !(host && hostProfile === 'fetch') ? toolchainPath(input, job) : { dirs: [] }
  if ('error' in path) return { kind: 'refuse', reason: path.error }
  Object.assign(env, toolchainEnv(env, { dirs: path.dirs, home: worktree && !readOnly ? `${worktree}/.home` : undefined, exists: input.exists }))
  if (services) {
    Object.assign(env, SERVICE_ENV)
    for (const key of ['NO_PROXY', 'no_proxy']) if (env[key]) env[key] = `${env[key]},${SERVICE_HOSTS.join(',')}`
  }
  return { kind: 'run', argv, env, ...jobId ? { job: jobId } : {}, egress }
}

/** The image's services for a job (`T12.3`): its prepared data, its `hosts` file, and a Postgres major the image has. */
function servicesOf(input: Pick<PlanInput, 'config' | 'real' | 'exists'>, job: JobFile): { root: string; hosts: string; postgres: string } | { error: string } {
  const configured = input.config.services
  if (!configured) return { error: `job ${job.jobId} has test services, and this deployment's image has none` }
  const postgres = job.services!.postgres
  const root = input.real(configured)
  if (!(POSTGRES_MAJORS as readonly string[]).includes(postgres) || !input.exists(`${root}/postgres/${postgres}`)) {
    return { error: `job ${job.jobId} names Postgres ${JSON.stringify(postgres)}, which this image does not have` }
  }
  const hosts = `${root}/hosts`
  if (!input.exists(hosts)) return { error: `the test services in ${root} have no hosts file; the image was not built with them` }
  return { root, hosts, postgres }
}

/**
 * The toolchains in a sandbox (`T11.5`). The cache is read-only in every sandbox (`--ro-bind / /`), so global installs go to the
 * job's home: npm's prefix and corepack's home, a virtual environment for pip (made by the setup step when the job has Python),
 * Go's `GOPATH`. No tool downloads a toolchain itself: `GOTOOLCHAIN=local`, `UV_PYTHON_DOWNLOADS=never`. `PATH` is, in order, the
 * job's virtual environment, its toolchains, its npm and Go binaries, then the rest.
 */
export function toolchainEnv(env: Readonly<Record<string, string>>, options: { dirs: readonly string[]; home: string | undefined; exists(path: string): boolean }):
  Record<string, string> {
  // Go makes its module cache read-only unless told otherwise, which would leave a job's home that cannot be removed.
  const out: Record<string, string> = { GOTOOLCHAIN: 'local', UV_PYTHON_DOWNLOADS: 'never', GOFLAGS: '-modcacherw' }
  const { home } = options
  const first: string[] = []
  const after: string[] = []
  if (home) {
    const venv = `${home}/venv`
    if (options.exists(`${venv}/bin/python`)) { out.VIRTUAL_ENV = venv; first.push(`${venv}/bin`) }
    Object.assign(out, { NPM_CONFIG_PREFIX: `${home}/.npm-global`, npm_config_prefix: `${home}/.npm-global`, COREPACK_HOME: `${home}/.corepack`,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', GOPATH: `${home}/go` })
    after.push(`${home}/.npm-global/bin`, `${home}/go/bin`)
  }
  out.PATH = [...first, ...options.dirs, ...after, env.PATH ?? '/usr/local/bin:/usr/bin:/bin'].join(':')
  return out
}

/** The job's toolchain directories, each of which must be inside the cache's installs once its links are resolved. */
export function toolchainPath(input: Pick<PlanInput, 'config' | 'real'>, job: JobFile): { dirs: string[] } | { error: string } {
  const { toolchains } = input.config
  const dirs = job.toolchains?.path ?? []
  if (dirs.length === 0) return { dirs: [] }
  if (!toolchains) return { error: 'this deployment has no toolchain cache' }
  const installs = `${toolchainDirs(input.real(toolchains)).installs}/`
  const outside = dirs.find(dir => !dir.startsWith('/') || dir.split('/').includes('..') || dir.includes(':') || !input.real(dir).startsWith(installs))
  return outside === undefined ? { dirs: dirs.map(dir => input.real(dir)) } : { error: `job ${job.jobId}'s toolchain directory ${JSON.stringify(outside)} is not in the toolchain cache` }
}

/**
 * Registry settings for a `registries` sandbox (`T11.6`). Go fetches modules only from its proxy, never `direct` from a VCS host,
 * and keeps verifying them against the checksum database (no `GONOSUMDB`, `GONOSUMCHECK` or `GOFLAGS=-insecure`); pip and uv
 * honour the proxy variables and use PyPI.
 */
export const REGISTRY_ENV: Readonly<Record<string, string>> = {
  GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', GONOSUMDB: '', GONOSUMCHECK: '', GONOPROXY: '', GOPRIVATE: '', GOINSECURE: '',
  GOFLAGS: '-modcacherw', PIP_INDEX_URL: 'https://pypi.org/simple', PIP_DISABLE_PIP_VERSION_CHECK: '1', UV_INDEX_URL: 'https://pypi.org/simple',
  // Corepack fetches a pinned yarn or pnpm from the npm registry, not from its own hosts (DEPLOYMENT: repositories that use yarn).
  COREPACK_NPM_REGISTRY: 'https://registry.npmjs.org',
}

/** The toolchain cache and the masks, for the `toolchain` and `verify` profiles; a refusal when there is none or it overlaps a mask. */
function cacheOf(input: PlanInput, profile: { mode: 'read-only' | 'workspace-write' }, name: string): { cache: string; masks: string[] } | { refuse: string } {
  const { config } = input
  if (profile.mode !== 'read-only') return { refuse: `the ${name} profile runs read-only, with no worktree` }
  if (!config.toolchains || !config.mise) return { refuse: 'this deployment has no toolchain cache' }
  const cache = input.real(config.toolchains)
  const masks = [...new Set(config.masks.map(path => input.real(path)))].filter(path => input.exists(path)).sort((a, b) => a.length - b.length)
  if (!cache.startsWith('/') || masks.some(mask => cache === mask || cache.startsWith(`${mask}/`) || mask.startsWith(`${cache}/`))) {
    return { refuse: `the toolchain cache ${cache} overlaps a masked directory` }
  }
  return { cache, masks }
}

/** The sandbox's start: the root read-only, its own `/proc`, PID and network namespaces, an empty `/tmp`, and the masks. */
function baseArgv(bwrap: string, masks: readonly string[]): string[] {
  const argv = [bwrap, '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--new-session', '--unshare-net', '--tmpfs', '/tmp']
  for (const mask of masks) argv.push('--tmpfs', mask)
  return argv
}

/**
 * The toolchain install (`T11.4`): only `mise install` or `mise where` by full name, with no worktree, the cache writable, the job's
 * toolchain proxy, and mise's settings fixed here, never inherited.
 */
function planToolchain(input: PlanInput, profile: { mode: 'read-only' | 'workspace-write'; command: string[] }, job: JobFile): Plan {
  const { config } = input
  const refuse = (reason: string): Plan => ({ kind: 'refuse', reason })
  const found = cacheOf(input, profile, 'toolchain')
  if ('refuse' in found) return refuse(found.refuse)
  const { cache, masks } = found
  const dirs = toolchainDirs(cache)
  const [program, ...args] = profile.command
  const allowed = program !== undefined && input.real(program) === input.real(config.mise!) && (args[0] === 'install' || args[0] === 'where') && args.length >= 2
    && args.slice(1).every(arg => /^(?:--force|(?:core|aqua):[a-z0-9][a-z0-9/._-]*@[0-9][0-9.]*)$/u.test(arg))
  if (!allowed) return refuse(`the toolchain profile runs only mise install or where; not ${JSON.stringify(profile.command.slice(0, 3))}`)
  if (!job.toolchainSocket || !input.exists(job.toolchainSocket)) return refuse(`job ${job.jobId}'s toolchain proxy is not running`)
  const argv = baseArgv(config.bwrap, masks)
  argv.push('--bind', cache, cache, '--ro-bind', job.toolchainSocket, SANDBOX_SOCKET)
  for (const mask of masks) argv.push('--remount-ro', mask)
  argv.push('--chdir', '/tmp', '--', config.node, config.bridge, '--egress', '--', ...profile.command)
  const env: Record<string, string> = { ...sandboxEnv(input.env, { worktree: undefined, egress: 'toolchain' }), GIT_CONFIG_GLOBAL: '/dev/null',
    MISE_DATA_DIR: dirs.data, MISE_CACHE_DIR: dirs.cache, MISE_STATE_DIR: dirs.state, MISE_CONFIG_DIR: '/tmp/mise-config',
    MISE_GLOBAL_CONFIG_FILE: '/tmp/mise-config/config.toml', MISE_PARANOID: '1', MISE_YES: '1', MISE_PYTHON_COMPILE: 'false',
    MISE_USE_VERSIONS_HOST: 'false', MISE_USE_VERSIONS_HOST_TRACK: 'false', MISE_DISABLE_BACKENDS: DISABLED_BACKENDS.join(','),
    MISE_EXPERIMENTAL: 'false', MISE_NODE_COREPACK: 'false', MISE_HIDE_UPDATE_WARNING: '1' }
  return { kind: 'run', argv, env, job: job.jobId, egress: 'toolchain' }
}

/**
 * The post-install check: an installed binary's `--version` (or `version`) and nothing else, with no worktree, no network,
 * and the cache read-only like the rest of the root, so a binary that is not what it claims cannot reach out or change the cache.
 */
function planVerify(input: PlanInput, profile: { mode: 'read-only' | 'workspace-write'; command: string[] }, job: JobFile): Plan {
  const found = cacheOf(input, profile, 'verify')
  if ('refuse' in found) return { kind: 'refuse', reason: found.refuse }
  const { cache, masks } = found
  const [program, ...args] = profile.command
  const installed = program !== undefined && input.real(program).startsWith(`${toolchainDirs(cache).installs}/`)
  if (!installed || args.length !== 1 || (args[0] !== '--version' && args[0] !== 'version')) {
    return { kind: 'refuse', reason: `the verify profile runs only an installed tool's version; not ${JSON.stringify(profile.command.slice(0, 3))}` }
  }
  const argv = baseArgv(input.config.bwrap, masks)
  for (const mask of masks) argv.push('--remount-ro', mask)
  argv.push('--chdir', '/tmp', '--', ...profile.command)
  return { kind: 'run', argv, env: { ...sandboxEnv(input.env, { worktree: undefined, egress: 'none' }), GIT_CONFIG_GLOBAL: '/dev/null' }, job: job.jobId, egress: 'none' }
}

/** The environment inside the sandbox. */
export function sandboxEnv(env: Readonly<Record<string, string | undefined>>, options: { worktree: string | undefined; egress: Egress; gitConfig?: string }):
  Record<string, string> {
  const stripped = new Set(STRIPPED_WORKER_ENV_KEYS.map(key => key.toUpperCase()))
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || WORKER_FORBIDDEN_ENV_PATTERN.test(key) || stripped.has(key.toUpperCase()) || DROPPED.test(key)) continue
    clean[key] = value
  }
  clean.HOME = options.worktree ? `${options.worktree}/.home` : '/tmp/home'
  if (options.gitConfig) clean.GIT_CONFIG_GLOBAL = options.gitConfig
  clean.GIT_CONFIG_NOSYSTEM = '1'
  clean.GIT_TERMINAL_PROMPT = '0'
  clean.GIT_ASKPASS = ''
  if (options.egress !== 'none') {
    const proxy = `http://127.0.0.1:${BRIDGE_PORT}`
    Object.assign(clean, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1', ...options.egress === 'registries' ? { npm_config_proxy: proxy, npm_config_https_proxy: proxy, NODE_USE_ENV_PROXY: '1',
        ...REGISTRY_ENV } : {} })
  }
  return clean
}
