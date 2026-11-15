/**
 * Credential masking (`T10.3`, `A15`): the sandbox wrapper's plan from host-controlled inputs only, the path policy on DSH's file
 * tools (with real symbolic links), the host's sandbox files and shell variable, and the startup check for Linux.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonical, pathGuard } from '../src/adapters/path-policy.ts'
import { SandboxHost } from '../src/adapters/sandbox-host.ts'
import { assertSandboxWrapper } from '../src/app/workbench-runtime.ts'
import { CONFIG_VARIABLE, planSandbox, readProfile, type JobFile, type PlanInput, type WrapperConfig } from '../src/sandbox/profile.ts'

const CONFIG: WrapperConfig = { bwrap: '/usr/bin/bwrap', masks: ['/var/lib/workbench/dsh', '/var/lib/workbench/state/data', '/var/lib/workbench/work/jobs'],
  workRoot: '/var/lib/workbench/work/jobs', jobs: '/var/lib/workbench/state/data/sandbox/jobs', gitConfig: '/var/lib/workbench/state/data/worker-gitconfig',
  node: '/usr/local/bin/node', bridge: '/workspace/lib/sandbox-bridge.js' }
const WORKTREE = '/var/lib/workbench/work/jobs/job_1'
const SOCKET = '/var/lib/workbench/state/data/sandbox/proxy/1.sock'
const JOBS: Record<string, JobFile> = { job_1: { jobId: 'job_1', worktree: WORKTREE, egress: 'none' }, job_3: { jobId: 'job_3', worktree: '/var/lib/workbench/work/jobs/job_3', egress: 'registries', socket: SOCKET }, job_2: { jobId: 'job_2', worktree: '/var/lib/workbench/work/jobs/job_2', egress: 'none' } }
/** DSH's own profile arguments for each mode, as `dsh-sandbox-local` passes them. */
const DSH = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
const write = (root: string) => [...DSH, '--tmpfs', '/tmp', '--bind', root, root, '--', 'bash', '-c', 'npm test']
const read = [...DSH, '--', 'bash', '-c', 'ls']
const HOST_ENV = { PATH: '/usr/bin', HOME: '/home/node', JIRA_BASE_URL: 'https://jira.example', GITLAB_TOKEN: 'glpat', GITLAB_PROJECT: 'acme/app',
  LITELLM_BASE_URL: 'http://llm', DEEPSEEK_BASE_URL: 'https://api', WORKBENCH_STATE_DIR: '/var/lib/workbench/state/data', SSH_AUTH_SOCK: '/s',
  GIT_DIR: '/elsewhere', DSH_SESSION_ID: 'wb-job_1.a1', DSH_HOME: '/var/lib/workbench/dsh', NO_COLOR: '1' }

const plan = (overrides: Partial<PlanInput> & { env?: Record<string, string> }) => planSandbox({
  args: write(WORKTREE), env: { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_1' }, cwd: WORKTREE, config: CONFIG, job: id => JOBS[id],
  real: path => path, exists: path => path !== '/missing', ...overrides })

describe('the sandbox wrapper\'s plan', () => {
  it('reads the mode and the writable root from DSH\'s profile arguments', () => {
    expect(readProfile(write(WORKTREE))).toEqual({ mode: 'workspace-write', binds: [WORKTREE], command: ['bash', '-c', 'npm test'] })
    expect(readProfile(read)).toEqual({ mode: 'read-only', binds: [], command: ['bash', '-c', 'ls'] })
    expect(readProfile(DSH)).toEqual({ error: 'no command after --' })
  })

  it('masks $DSH_HOME, the state and the work root, binds back the job\'s worktree and the worker git config, and cleans the environment', () => {
    const result = plan({})
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') return
    expect(result.argv).toEqual(['/usr/bin/bwrap', ...DSH, '--new-session', '--unshare-net', '--tmpfs', '/tmp', '--tmpfs', '/var/lib/workbench/dsh',
      '--tmpfs', '/var/lib/workbench/work/jobs', '--tmpfs', '/var/lib/workbench/state/data', '--bind', WORKTREE, WORKTREE,
      '--ro-bind', CONFIG.gitConfig, CONFIG.gitConfig, '--remount-ro', '/var/lib/workbench/dsh', '--remount-ro', '/var/lib/workbench/work/jobs',
      '--remount-ro', '/var/lib/workbench/state/data', '--chdir', WORKTREE, '--', 'bash', '-c', 'npm test'])
    const home = `${WORKTREE}/.home`
    // `exists` says yes to everything here, so the job's virtual environment is there.
    expect(result.env).toEqual({ PATH: `${home}/venv/bin:${home}/.npm-global/bin:${home}/go/bin:/usr/bin`, VIRTUAL_ENV: `${home}/venv`, HOME: home, GIT_CONFIG_GLOBAL: CONFIG.gitConfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', DSH_SESSION_ID: 'wb-job_1.a1', DSH_HOME: '/var/lib/workbench/dsh', DSH_WORKBENCH_JOB: 'job_1', NO_COLOR: '1',
      GOTOOLCHAIN: 'local', UV_PYTHON_DOWNLOADS: 'never', GOFLAGS: '-modcacherw', NPM_CONFIG_PREFIX: `${home}/.npm-global`, npm_config_prefix: `${home}/.npm-global`,
      COREPACK_HOME: `${home}/.corepack`, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', GOPATH: `${home}/go` })
  })

  it('cuts every sandbox off the network, and gives a registries job only its proxy, through the bridge, with the proxy variables (T10.2)', () => {
    const offline = plan({})
    expect(offline.kind === 'run' && offline.argv).toContain('--unshare-net')
    expect(offline.kind === 'run' && Object.keys(offline.env).filter(key => /proxy/iu.test(key))).toEqual([])
    const worktree = '/var/lib/workbench/work/jobs/job_3'
    const online = plan({ args: write(worktree), env: { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_3', HTTPS_PROXY: 'http://evil:1' }, cwd: worktree })
    expect(online.kind).toBe('run')
    if (online.kind !== 'run') return
    expect(online.egress).toBe('registries')
    expect(online.argv).toContain('--unshare-net')
    const bind = online.argv.indexOf(SOCKET)
    expect(online.argv.slice(bind - 1, bind + 2)).toEqual(['--ro-bind', SOCKET, '/tmp/.workbench-egress.sock'])
    expect(online.argv.slice(online.argv.indexOf('--', bind))).toEqual(['--', '/usr/local/bin/node', '/workspace/lib/sandbox-bridge.js', '--egress', '--', 'bash', '-c', 'npm test'])
    expect(online.env).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:3128', HTTP_PROXY: 'http://127.0.0.1:3128', NO_PROXY: 'localhost,127.0.0.1,::1' })
    // Go and pip use only their public registries through the proxy (T11.6): no direct VCS fetch, checksums kept.
    expect(online.env).toMatchObject({ GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', GONOSUMDB: '', GOPRIVATE: '', GOINSECURE: '',
      GOFLAGS: '-modcacherw', PIP_INDEX_URL: 'https://pypi.org/simple', UV_INDEX_URL: 'https://pypi.org/simple' })
    // The host's own settings never reach the sandbox: they are replaced, not merged.
    const hostile = plan({ args: write(worktree), env: { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_3', GOPROXY: 'https://evil.example,direct', GONOSUMDB: '*',
      GOFLAGS: '-insecure', PIP_INDEX_URL: 'https://evil.example/simple' }, cwd: worktree })
    expect(hostile.kind === 'run' && hostile.env).toMatchObject({ GOPROXY: 'https://proxy.golang.org', GONOSUMDB: '', GOFLAGS: '-modcacherw', PIP_INDEX_URL: 'https://pypi.org/simple' })
    // A check of the same job runs offline, and a job whose proxy is not running is refused.
    expect(plan({ args: write(worktree), env: { ...HOST_ENV, WORKBENCH_SANDBOX_JOB: 'job_3', WORKBENCH_SANDBOX_PROFILE: 'check' }, cwd: worktree }))
      .toMatchObject({ kind: 'run', egress: 'none' })
    expect(plan({ args: write(worktree), env: { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_3' }, cwd: worktree, exists: path => path !== SOCKET }))
      .toEqual({ kind: 'refuse', reason: 'job job_3\'s egress proxy is not running' })
  })

  it('refuses a writable root that is not the job\'s own worktree, whatever the working directory says', () => {
    expect(plan({ args: write('/var/lib/workbench/work/jobs/job_2') })).toEqual({ kind: 'refuse',
      reason: 'the writable root /var/lib/workbench/work/jobs/job_2 is not job job_1\'s worktree' })
    expect(plan({ args: write('/var/lib/workbench/state/data') })).toMatchObject({ kind: 'refuse' })
    // A symbolic link to the worktree is the worktree; one that resolves elsewhere is not.
    expect(plan({ args: write('/link'), real: path => path === '/link' ? WORKTREE : path })).toMatchObject({ kind: 'run' })
    expect(plan({ args: write(`${WORKTREE}/x`), real: path => path === `${WORKTREE}/x` ? '/var/lib/workbench/dsh' : path })).toMatchObject({ kind: 'refuse' })
    // The command may start in any directory; outside the worktree it starts in the worktree.
    const elsewhere = plan({ cwd: '/var/lib/workbench/state/data' })
    expect(elsewhere.kind === 'run' && elsewhere.argv[elsewhere.argv.indexOf('--chdir') + 1]).toBe(WORKTREE)
    const inside = plan({ cwd: `${WORKTREE}/src` })
    expect(inside.kind === 'run' && inside.argv[inside.argv.indexOf('--chdir') + 1]).toBe(`${WORKTREE}/src`)
  })

  it('refuses a writable command with no job or an unknown one, and a malformed job id', () => {
    expect(plan({ env: HOST_ENV })).toEqual({ kind: 'refuse', reason: 'a writable sandbox needs a job, and this command names none' })
    expect(plan({ env: { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_9' } })).toEqual({ kind: 'refuse', reason: 'job job_9 has no sandbox file; the host has not prepared it' })
    expect(plan({ env: { ...HOST_ENV, DSH_WORKBENCH_JOB: '../job_1' } })).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('is not valid') })
  })

  it('gives a read-only command no worktree at all, with or without a job', () => {
    for (const env of [HOST_ENV, { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_1' }]) {
      const result = plan({ args: read, env })
      expect(result.kind).toBe('run')
      if (result.kind !== 'run') continue
      expect(result.argv).not.toContain('--bind')
      expect(result.argv.slice(result.argv.indexOf('--chdir'), result.argv.indexOf('--chdir') + 2)).toEqual(['--chdir', '/tmp'])
      expect(result.env.HOME).toBe('/tmp/home')
      expect(result.egress).toBe('none')
    }
  })

  it('takes a host-run command\'s job and profile from the host\'s variables, and runs a check offline', () => {
    const result = plan({ env: { ...HOST_ENV, WORKBENCH_SANDBOX_JOB: 'job_1', WORKBENCH_SANDBOX_PROFILE: 'check' } })
    expect(result).toMatchObject({ kind: 'run', job: 'job_1', egress: 'none' })
    expect(result.kind === 'run' && Object.keys(result.env).filter(key => key.startsWith('WORKBENCH_'))).toEqual([])
    expect(plan({ env: { ...HOST_ENV, WORKBENCH_SANDBOX_JOB: 'job_1', WORKBENCH_SANDBOX_PROFILE: 'setup' } })).toMatchObject({ kind: 'refuse' })
  })

  it('runs a host fetch read-only on the job\'s own worktree, offline, with everything else masked (final review)', () => {
    const env = { ...HOST_ENV, WORKBENCH_SANDBOX_JOB: 'job_1', WORKBENCH_SANDBOX_PROFILE: 'fetch' }
    const result = plan({ args: [...DSH, '--', 'git-upload-pack', WORKTREE], env, cwd: '/var/lib/workbench/state/data' })
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') return
    const bind = result.argv.indexOf(WORKTREE)
    expect(result.argv.slice(bind - 1, bind + 2)).toEqual(['--ro-bind', WORKTREE, WORKTREE])
    expect(result.argv).not.toContain('--bind')
    expect(result.argv).toContain('--unshare-net')
    expect(result.argv.filter(arg => arg === '--tmpfs')).toHaveLength(4)
    expect(result.argv.slice(-3)).toEqual(['--', 'git-upload-pack', WORKTREE])
    expect(plan({ env })).toEqual({ kind: 'refuse', reason: 'the fetch profile runs read-only' })
  })

  it('skips masks that do not exist and puts parents before children', () => {
    const result = plan({ config: { ...CONFIG, masks: ['/var/lib/workbench/state/data/sub', '/missing', '/var/lib/workbench/state/data'] } })
    const masks = result.kind === 'run' ? result.argv.flatMap((arg, index) => arg === '--tmpfs' ? [result.argv[index + 1]] : []) : []
    expect(masks).toEqual(['/tmp', '/var/lib/workbench/state/data', '/var/lib/workbench/state/data/sub'])
  })
})

describe('test services in the sandbox (T12.3, D11)', () => {
  const ROOT = '/opt/workbench-services'
  const SERVICES: WrapperConfig = { ...CONFIG, services: ROOT }
  const jobs: Record<string, JobFile> = { job_1: { ...JOBS.job_1!, services: { postgres: '16' } },
    job_3: { ...JOBS.job_3!, services: { postgres: '16' } }, job_2: JOBS.job_2! }
  const withServices = (overrides: Partial<PlanInput> & { env?: Record<string, string> }) => plan({ config: SERVICES, job: id => jobs[id], ...overrides })
  const launcher = ['/usr/local/bin/node', '/workspace/lib/sandbox-bridge.js', '--services', ROOT, '--postgres', '16', '--', 'bash', '-c', 'npm test']

  it('runs an agent\'s writable shell under the launcher, with the job\'s Postgres major, the CI names on loopback and the address variables', () => {
    const result = withServices({ env: { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_1', DATABASE_URL: 'postgresql://prod.example/app', PGPASSWORD: 'secret' } })
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') return
    const hosts = result.argv.indexOf(`${ROOT}/hosts`)
    expect(result.argv.slice(hosts - 4, hosts + 2)).toEqual(['--unshare-uts', '--hostname', 'workbench-sandbox', '--ro-bind', `${ROOT}/hosts`, '/etc/hosts'])
    expect(result.argv.slice(result.argv.indexOf('--', hosts))).toEqual(['--', ...launcher])
    // The host's own values never reach the sandbox; the ones that name the sandbox's services are set after the filter.
    expect(result.env).toMatchObject({ DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres', PGHOST: 'localhost', PGPORT: '5432',
      PGUSER: 'postgres', PGPASSWORD: 'postgres', PGDATABASE: 'postgres', AMQP_URL: 'amqp://guest:guest@localhost:5672/',
      RABBITMQ_URL: 'amqp://guest:guest@localhost:5672/', KAFKA_BOOTSTRAP_SERVERS: 'localhost:9092' })
  })

  it('combines the launcher with the egress bridge, and keeps the service names off the proxy', () => {
    const worktree = '/var/lib/workbench/work/jobs/job_3'
    const result = withServices({ args: write(worktree), env: { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_3' }, cwd: worktree })
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') return
    expect(result.argv.slice(result.argv.lastIndexOf('/usr/local/bin/node'))).toEqual(['/usr/local/bin/node', '/workspace/lib/sandbox-bridge.js', '--egress',
      '--services', ROOT, '--postgres', '16', '--', 'bash', '-c', 'npm test'])
    expect(result.env).toMatchObject({ NO_PROXY: 'localhost,127.0.0.1,::1,postgres,rabbitmq,kafka', no_proxy: 'localhost,127.0.0.1,::1,postgres,rabbitmq,kafka' })
  })

  it('gives services to the host\'s checks, and never to the setup command, a fetch, a read-only command or a job without them', () => {
    const host = (profile: string, args = write(WORKTREE)) => withServices({ args, env: { ...HOST_ENV, WORKBENCH_SANDBOX_JOB: 'job_1', WORKBENCH_SANDBOX_PROFILE: profile } })
    const check = host('check')
    expect(check.kind === 'run' && check.argv.slice(-10)).toEqual(launcher)
    const none = [host('setup', write(WORKTREE)), host('fetch', [...DSH, '--', 'git-upload-pack', WORKTREE]),
      withServices({ args: read, env: { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_1' } }),
      withServices({ args: write('/var/lib/workbench/work/jobs/job_2'), env: { ...HOST_ENV, DSH_WORKBENCH_JOB: 'job_2' }, cwd: '/var/lib/workbench/work/jobs/job_2' })]
    for (const result of none) {
      if (result.kind !== 'run') continue
      expect(result.argv).not.toContain('/etc/hosts')
      expect(result.argv).not.toContain('--services')
      expect(result.env.DATABASE_URL).toBeUndefined()
    }
    // The setup command is refused for an unrelated reason here (no proxy for job_1); the others run.
    expect(none.filter(result => result.kind === 'run')).toHaveLength(3)
  })

  it('refuses a job with services in a deployment with none, a major the image lacks, and an image without its hosts file', () => {
    expect(plan({ job: id => jobs[id] })).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('this deployment\'s image has none') })
    expect(withServices({ job: id => id === 'job_1' ? { ...JOBS.job_1!, services: { postgres: '12' } } : undefined }))
      .toMatchObject({ kind: 'refuse', reason: expect.stringContaining('names Postgres "12", which this image does not have') })
    expect(withServices({ exists: path => path !== `${ROOT}/postgres/16` }))
      .toMatchObject({ kind: 'refuse', reason: expect.stringContaining('which this image does not have') })
    expect(withServices({ exists: path => path !== `${ROOT}/hosts` })).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('no hosts file') })
  })
})

describe('the path policy on DSH\'s file tools', () => {
  let root: string, worktree: string, sibling: string, secrets: string, skills: string, spill: string
  const sessionId = 'wb-job_1.a1'
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'awb-paths-')))
    worktree = join(root, 'work', 'job_1'); sibling = join(root, 'work', 'job_2'); secrets = join(root, 'dsh'); skills = join(root, 'skills')
    for (const dir of [join(worktree, 'src'), sibling, secrets, skills]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(secrets, '.credentials.yaml'), 'token: x')
    writeFileSync(join(worktree, 'src', 'a.ts'), '')
    symlinkSync(join(secrets, '.credentials.yaml'), join(worktree, 'creds'))
    symlinkSync(sibling, join(worktree, 'other'))
    spill = join(root, 'tmp', 'dsh-spill-abc', `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`)
    mkdirSync(spill, { recursive: true })
    mkdirSync(join(root, 'tmp', 'dsh-spill-abc', 'session-000000000000'), { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  const guard = () => pathGuard({ worktree, sessionId, skillRoots: [skills], tmp: join(root, 'tmp') })
  const check = (name: string, args: Record<string, unknown>) => guard()({ name, arguments: args })

  it('lets file tools name paths in the worktree, relative or absolute, and new files to write', () => {
    expect(check('read', { file_path: 'src/a.ts' })).toBeUndefined()
    expect(check('read', { file_path: join(worktree, 'src', 'a.ts') })).toBeUndefined()
    expect(check('grep', { pattern: 'x' })).toBeUndefined()
    expect(check('glob', { pattern: '**/*.ts', path: 'src' })).toBeUndefined()
    expect(check('write', { file_path: 'src/new/file.ts', content: '' })).toBeUndefined()
    expect(check('bash', { command: 'cat /etc/passwd' })).toBeUndefined()
  })

  it('refuses `..`, absolute paths, symbolic links out of the worktree, a sibling worktree and /proc', () => {
    expect(check('read', { file_path: '../job_2/x' })).toMatch(/is outside this job's worktree/u)
    expect(check('read', { file_path: join(secrets, '.credentials.yaml') })).toMatch(/is outside/u)
    expect(check('read', { file_path: 'creds' })).toMatch(/creds is outside/u)
    expect(check('grep', { pattern: 'token', path: 'other' })).toMatch(/is outside/u)
    expect(check('glob', { pattern: '*', path: sibling })).toMatch(/is outside/u)
    expect(check('read', { file_path: '/proc/self/environ' })).toMatch(/is outside/u)
    expect(check('read_image', { file_path: '/etc/hostname' })).toMatch(/is outside/u)
    expect(check('edit', { file_path: 'other/x.ts', old_string: 'a', new_string: 'b' })).toMatch(/may write only inside/u)
    expect(check('apply_patch', { input: '*** Begin Patch' })).toMatch(/not available/u)
    expect(check('read', { file_path: 'a\0b' })).toMatch(/not valid/u)
  })

  it('lets the reading tools read the skills and this session\'s own saved output, but no other session\'s', () => {
    expect(check('read', { file_path: join(skills, 'jira', 'SKILL.md') })).toBeUndefined()
    expect(check('write', { file_path: join(skills, 'jira', 'SKILL.md') })).toMatch(/may write only inside/u)
    expect(check('read', { file_path: join(spill, 'out.txt') })).toBeUndefined()
    expect(check('read', { file_path: join(root, 'tmp', 'dsh-spill-abc', 'session-000000000000', 'out.txt') })).toMatch(/is outside/u)
  })

  it('resolves a path that does not exist yet through its nearest existing ancestor', () => {
    expect(canonical(join(worktree, 'other', 'new', 'x.ts'))).toBe(join(sibling, 'new', 'x.ts'))
  })
})

describe('the host\'s sandbox files', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'awb-sandbox-host-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('writes the wrapper\'s configuration and the job files where every sandbox has them masked, and points the environment at them', () => {
    const host = new SandboxHost({ stateDir: join(root, 'state'), workRoot: join(root, 'work'), dshHome: join(root, 'dsh'), gitConfig: join(root, 'state', 'worker-gitconfig'),
      bridge: '/w/lib/sandbox-bridge.js' })
    const env: NodeJS.ProcessEnv = {}
    const config = host.configure(env)
    expect(env[CONFIG_VARIABLE]).toBe(join(root, 'state', 'sandbox', 'config.json'))
    expect(JSON.parse(readFileSync(env[CONFIG_VARIABLE]!, 'utf8'))).toEqual(config)
    expect(config.masks).toEqual([join(root, 'dsh'), join(root, 'state'), join(root, 'work')])
    expect(config.jobs.startsWith(join(root, 'state'))).toBe(true)
    expect(config).toMatchObject({ node: process.execPath, bridge: '/w/lib/sandbox-bridge.js' })
    host.prepareJob('job_1', { worktree: join(root, 'work', 'job_1'), egress: 'registries', socket: '/s/1.sock' })
    expect(JSON.parse(readFileSync(join(config.jobs, 'job_1.json'), 'utf8'))).toEqual({ jobId: 'job_1', worktree: join(root, 'work', 'job_1'), egress: 'registries', socket: '/s/1.sock' })
  })

  it('registers DSH_WORKBENCH_JOB, resolved from the calling session', () => {
    const host = new SandboxHost({ stateDir: root, workRoot: root, dshHome: root, gitConfig: root, bridge: '/b.js' })
    let contributor: { name: string; variables: Record<string, unknown>; resolve(execution: unknown): Record<string, string> } | undefined
    const ctx = { get: (name: string) => name === 'shellEnv' ? { register: (value: typeof contributor) => { contributor = value; return () => {} } } : undefined }
    host.registerShellVariable(ctx as never, sessionId => sessionId === 'wb-job_1.a1' ? 'job_1' : undefined)
    expect(contributor!.variables).toHaveProperty('DSH_WORKBENCH_JOB')
    expect(contributor!.resolve({ agent: { session: { header: { id: 'wb-job_1.a1' } } } })).toEqual({ DSH_WORKBENCH_JOB: 'job_1' })
    expect(contributor!.resolve({ agent: { session: { header: { id: 'someone-else' } } } })).toEqual({})
    expect(contributor!.resolve({})).toEqual({})
  })
})

describe('the startup check', () => {
  it('refuses to start on Linux without the wrapper, outside the demo', () => {
    expect(() => assertSandboxWrapper('linux', { runnerCommand: [] }, false)).toThrow(/WORKBENCH_SANDBOX_WRAPPER/u)
    expect(() => assertSandboxWrapper('linux', {}, false)).toThrow(/WORKBENCH_SANDBOX_WRAPPER/u)
    expect(() => assertSandboxWrapper('linux', { runnerCommand: ['node', '/w.js'] }, false)).not.toThrow()
    expect(() => assertSandboxWrapper('linux', { runnerCommand: [] }, true)).not.toThrow()
    expect(() => assertSandboxWrapper('darwin', { runnerCommand: [] }, false)).not.toThrow()
  })
})
