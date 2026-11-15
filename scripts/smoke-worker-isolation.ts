/**
 * The extended isolation smoke (`T10.4`, `A14`, `A15`), run inside the full container:
 *
 *   docker compose --profile full exec -T workbench-full node scripts/smoke-worker-isolation.ts
 *
 * It goes through the paths that matter, not a hand-built `bwrap` command line:
 * - **agent shells**: DSH's own `dsh-sandbox-local` `confine`, configured as the profile configures it (the workbench's wrapper as
 *   `runnerCommand`), spawned through DSH's subprocess runtime with the environment DSH gives a shell (its scrubbed parent
 *   environment plus the `DSH_*` variables, `DSH_WORKBENCH_JOB` among them);
 * - **host checks**: the workbench's `runConfined`, as the `command` check calls it;
 * - **file tools**: a real stage attempt (`smoke-session-tools.ts`): DSH's own profile boot, the stage runner, the implement preset
 *   and DSH's tool pipeline with the guard the stage runner registers, driven by a scripted model on loopback;
 * - **egress**: the workbench's proxy, with one socket per job;
 * - **test integrity**: the work diff and the rules, on a real repository;
 * - **toolchains** (`T11.4`–`T11.6`): the workbench's setup handler, with real `mise` installs through the toolchain proxy under the
 *   host profile `toolchain`, for a repository with a hostile `mise.toml`; then agent shells and a host check with the installed
 *   toolchains, pip and Go through the registries proxy, and the read-only cache.
 * - **test services** (`T12.6`, `D11`): Postgres, RabbitMQ and Kafka in agent shells and a host check, each started on its first
 *   connection inside that command's sandbox: fresh per command, unreachable from any other, gone when the command ends.
 *
 * It uses two synthetic jobs (`smoke-a`, egress `registries`; `smoke-b`) under the deployment's real work root, and marker files
 * in the real `$DSH_HOME` and state directory; it never prints a credential, and removes what it created. Each probe states what
 * it expects; the smoke exits 1 if any probe gets something else. Probes that need the internet (`npm` through the proxy) are
 * skipped with `--offline`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { EGRESS_PRESETS, EgressProxy, TOOLCHAIN_HOSTS, type EgressRecord } from '../src/adapters/egress.ts'
import { setupHandler } from '../src/adapters/setup.ts'
import type { Toolchain } from '../src/domain/job.ts'
import { RepositoryProfileSchema } from '../src/domain/repositories.ts'
import { confinedUploadPack, runConfined } from '../src/adapters/host-commands.ts'
import { SandboxHost } from '../src/adapters/sandbox-host.ts'
import { integrityFindings } from '../src/adapters/test-integrity.ts'
import { workDiff } from '../src/adapters/work-diff.ts'
import { workRootOf } from '../src/config.ts'
import { WORKER_FORBIDDEN_ENV_PATTERN, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { excludeJobHome } from '../src/infra/git-layout.ts'

interface Probe { readonly name: string; readonly expected: string; readonly ok: boolean; readonly detail: string }
const probes: Probe[] = []
const check = (name: string, expected: string, ok: boolean, detail: string) => { probes.push({ name, expected, ok, detail: detail.replace(/\s+/gu, ' ').trim().slice(0, 160) }) }
const MARKER = 'SMOKE_MARKER_7f3a9c'
const offline = process.argv.includes('--offline')

const need = (name: string) => process.env[name] ?? (() => { throw new Error(`${name} is not set; run the smoke inside the full container`) })()
const stateDir = need('WORKBENCH_STATE_DIR')
const wrapper = need('WORKBENCH_SANDBOX_WRAPPER')
const workRoot = workRootOf(stateDir, undefined, process.env)
const dshHome = resolveDshHome(undefined)
const jobA = join(workRoot, 'smoke-a'), jobB = join(workRoot, 'smoke-b'), jobC = join(workRoot, 'smoke-c'), jobD = join(workRoot, 'smoke-d'), jobE = join(workRoot, 'smoke-e')
const servicesDir = process.env.WORKBENCH_SERVICES_DIR
const toolchainsDir = process.env.WORKBENCH_TOOLCHAINS_DIR, mise = process.env.WORKBENCH_MISE
const created = [jobA, jobB, jobC, jobD, jobE, join(stateDir, 'smoke-marker.txt'), join(dshHome, 'smoke-marker.txt')]

// The host process holds credentials, as the DSH process does.
Object.assign(process.env, { GITLAB_TOKEN: MARKER, JIRA_TOKEN: MARKER, MATTERMOST_TOKEN: MARKER, LITELLM_API_KEY: MARKER, JIRA_BASE_URL: 'https://jira.smoke.example' })

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@localhost', ...args],
  { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()

async function main(): Promise<void> {
  // The layout: markers where credentials live, and two jobs' worktrees.
  await writeEnvironment({ stateDir })
  writeFileSync(join(stateDir, 'smoke-marker.txt'), MARKER)
  writeFileSync(join(dshHome, 'smoke-marker.txt'), MARKER)
  for (const dir of [jobA, jobB]) { rmSync(dir, { recursive: true, force: true }); mkdirSync(join(dir, 'tests'), { recursive: true }) }
  writeFileSync(join(jobB, 'secret.txt'), MARKER)
  writeFileSync(join(jobA, 'tests', 'auth.test.js'), "it('rejects', () => {\n  expect(1).toBe(1)\n})\n")
  writeFileSync(join(jobA, 'package.json'), JSON.stringify({ name: 'smoke-a', version: '1.0.0', private: true }))
  git(jobA, 'init', '-q', '-b', 'main'); git(jobA, 'add', '.'); git(jobA, 'commit', '-qm', 'base')
  const base = git(jobA, 'rev-parse', 'HEAD')

  // The host's side, as the runtime sets it up.
  const host = new SandboxHost({ stateDir, workRoot, dshHome, gitConfig: workerGitConfig(stateDir), bridge: join(dirname(wrapper), 'sandbox-bridge.js'),
    ...toolchainsDir && mise ? { toolchains: toolchainsDir, mise } : {}, ...servicesDir ? { services: servicesDir } : {} })
  host.configure()
  const records: EgressRecord[] = []
  // `localtest.me` is a public name that resolves to 127.0.0.1: an allowed name with a private address behind it.
  const proxy = new EgressProxy({ dir: join(stateDir, 'sandbox', 'proxy'), allowlist: [...EGRESS_PRESETS.npm!, 'localtest.me'], record: entry => { records.push(entry) } })
  host.prepareJob('smoke-a', { worktree: jobA, egress: 'registries', socket: await proxy.open('smoke-a') })
  host.prepareJob('smoke-b', { worktree: jobB, egress: 'none' })
  host.prepareJob('smoke-c', { worktree: jobC, egress: 'none' })

  // DSH's own sandbox provider and subprocess runtime, configured as cordis.patch.yml configures them.
  const ctx = new Context()
  const plugin = ctx.plugin.bind(ctx) as (plugin: unknown, config?: unknown) => PromiseLike<unknown>
  await plugin(LocalSubprocessRuntime)
  await plugin(LocalSandboxProvider, { runnerCommand: [process.execPath, wrapper], runnerFailureSignatures: ['workbench-sandbox: ', 'bwrap: '] })
  const sandbox = ctx.get('sandbox') as unknown as { confine(argv: string[], policy: { mode: string; workspaceRoot: string }): Promise<{ argv: string[] }> }
  const subprocess = ctx.get('subprocess') as unknown as SubprocessRuntime

  /** An agent shell, as DSH's bash tool runs one: confined, with DSH's environment for the calling session. */
  async function shell(command: string, options: { job?: string; mode?: 'workspace-write' | 'read-only'; root?: string } = {}) {
    const root = options.root ?? jobA
    const { argv } = await sandbox.confine(['bash', '-c', command], { mode: options.mode ?? 'workspace-write', workspaceRoot: root })
    const env = { NO_COLOR: '1', TERM: 'dumb', DSH_SHELL: '1', DSH_SESSION_ID: 'wb-smoke', DSH_HOME: dshHome, ...options.job === undefined ? { DSH_WORKBENCH_JOB: 'smoke-a' }
      : options.job ? { DSH_WORKBENCH_JOB: options.job } : {} }
    const handle = subprocess.spawn({ argv, cwd: root, graceMs: 2000, signal: AbortSignal.timeout(180_000), env,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } } })
    const { exitCode } = await handle.done
    const read = (reader: { readFrom(offset: number): { text: string } } | undefined) => reader?.readFrom(0).text ?? ''
    return { exitCode, out: read(handle.collected.stdout), err: read(handle.collected.stderr) }
  }
  const leaks = (text: string) => text.includes(MARKER)

  // 1. Credentials, state and other jobs, from an implement shell.
  for (const [name, path] of [['$DSH_HOME/.credentials.yaml', join(dshHome, '.credentials.yaml')], ['$DSH_HOME marker', join(dshHome, 'smoke-marker.txt')],
    ['workbench.sqlite', join(stateDir, 'workbench.sqlite')], ['state marker', join(stateDir, 'smoke-marker.txt')], ['sibling worktree', join(jobB, 'secret.txt')]] as const) {
    const result = await shell(`test -e '${path}' && echo VISIBLE; cat '${path}' 2>&1 | head -c 200`)
    check(`shell cannot read ${name}`, 'not visible', !result.out.includes('VISIBLE') && !leaks(result.out), result.out || result.err)
  }
  const listing = await shell(`ls '${workRoot}'; ls '${dshHome}' | wc -l; ls '${stateDir}'`)
  check('shell sees only its own worktree, an empty $DSH_HOME, and only the worker git config in the state', 'smoke-a 0 worker-gitconfig',
    listing.out.split('\n').filter(Boolean).join(' ') === 'smoke-a 0 worker-gitconfig', listing.out)
  const proc = await shell(`cat /proc/1/environ /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c '${MARKER}' || true; ls /proc | grep -cE '^[0-9]+$'`)
  check('shell sees no process environment holding a credential', 'no marker; only its own processes', proc.out.split('\n')[0] === '0' && Number(proc.out.split('\n')[1]) < 10, proc.out)
  const env = await shell('env')
  const forbidden = env.out.split('\n').map(line => line.split('=')[0]!).filter(name => WORKER_FORBIDDEN_ENV_PATTERN.test(name) || /^(?:WORKBENCH_|DEEPSEEK_)/u.test(name))
  check('shell environment holds no credential or connector variable', 'none', forbidden.length === 0 && !leaks(env.out), forbidden.join(', ') || 'none')
  check('shell HOME is in its worktree, and git reads the worker git config', `${jobA}/.home`,
    env.out.includes(`HOME=${jobA}/.home`) && env.out.includes(`GIT_CONFIG_GLOBAL=${workerGitConfig(stateDir)}`), env.out.split('\n').filter(line => /^(HOME|GIT_CONFIG_GLOBAL)=/u.test(line)).join(' '))
  const writes = await shell(`touch ./written && echo inside-ok; touch '${stateDir}/escape' 2>&1; touch '${jobB}/escape' 2>&1; touch '${dshHome}/escape' 2>&1`)
  check('shell writes inside its worktree and nowhere else', 'inside-ok; others refused', writes.out.startsWith('inside-ok') && !existsSync(join(stateDir, 'escape'))
    && !existsSync(join(jobB, 'escape')) && !existsSync(join(dshHome, 'escape')), writes.out)
  const remote = await shell('git ls-remote https://gitlab.com/gitlab-org/gitlab.git 2>&1; git config --global --get credential.helper; echo "[$?]"')
  check('the worker git config still blocks remote URLs', 'refused by the insteadOf rule', /invalid/u.test(remote.out) && !/HEAD/u.test(remote.out), remote.out)

  // 2. Writable roots the job does not own, and commands that name no job.
  const sibling = await shell('true', { root: jobB })
  check('a writable sandbox on another job\'s worktree is refused', 'workbench-sandbox refusal', sibling.exitCode !== 0 && sibling.err.includes('workbench-sandbox: '), sibling.err)
  const nobody = await shell('true', { job: '' })
  check('a writable sandbox that names no job is refused', 'workbench-sandbox refusal', nobody.exitCode !== 0 && nobody.err.includes('workbench-sandbox: '), nobody.err)

  // 3. Network.
  const direct = await shell(`node -e "const s = require('net').connect(443, '104.16.0.35'); s.on('connect', () => { console.log('CONNECTED'); s.destroy() }); s.on('error', e => console.log(e.code))"`)
  check('implement cannot open a connection around the proxy', 'ENETUNREACH', !direct.out.includes('CONNECTED'), direct.out)
  const dns = await shell('getent hosts registry.npmjs.org || echo no-dns')
  check('implement has no DNS of its own', 'no-dns', dns.out.trim() === 'no-dns', dns.out)
  const loop = await shell(`node -e "const s = require('net').connect(${process.env.PORT ?? 25402}, '127.0.0.1'); s.on('connect', () => { console.log('CONNECTED'); s.destroy() }); s.on('error', e => console.log(e.code))"`)
  check('implement cannot reach the host\'s loopback (DSH\'s web server)', 'refused', !loop.out.includes('CONNECTED'), loop.out)
  const fetchCode = (url: string) => `node -e "fetch('${url}').then(r => console.log('STATUS', r.status), e => console.log('FAILED', e.cause?.message ?? e.message))"`
  const offList = await shell(fetchCode('https://example.com/'))
  check('a host outside the allowlist fails, and the refusal names it', 'refused: example.com', offList.out.includes('FAILED') && offList.err.includes('example.com is not on the egress allowlist'), offList.err)
  const hidden = await shell(fetchCode('https://localtest.me/'))
  check('a private address behind an allowed name fails', 'refused: non-public address', hidden.err.includes('non-public address') && hidden.out.includes('FAILED'), hidden.err)
  const readOnly = await shell(fetchCode('https://registry.npmjs.org/left-pad'), { mode: 'read-only' })
  check('a read-only (inspect, plan) sandbox has no network and no worktree', 'fails; no worktree', readOnly.out.includes('FAILED')
    && !(await shell(`ls '${workRoot}' 2>&1 | wc -l`, { mode: 'read-only' })).out.trim().startsWith('1'), readOnly.out)
  if (!offline) {
    const install = await shell('npm install left-pad@1.3.0 --no-audit --no-fund --no-update-notifier 2>&1 | tail -3; test -f node_modules/left-pad/package.json && echo INSTALLED')
    check('npm install through the proxy works in implement', 'INSTALLED', install.out.includes('INSTALLED'), install.out)
    mkdirSync(join(jobA, 'pkg-fetch'), { recursive: true })
    writeFileSync(join(jobA, 'pkg-fetch', 'package.json'), JSON.stringify({ name: 'pkg-fetch', version: '1.0.0',
      scripts: { postinstall: "node -e \"fetch('https://github.com/').then(() => process.exit(0), e => { console.error('download failed:', e.cause?.message ?? e.message); process.exit(1) })\"" } }))
    const script = await shell('npm install ./pkg-fetch --no-audit --no-fund --no-update-notifier 2>&1 | tail -4; echo "npm-exit=${PIPESTATUS[0]}"')
    check('an install script that downloads from outside the registries fails', 'npm fails; github.com refused', /npm-exit=[1-9]/u.test(script.out)
      && records.some(record => record.host === 'github.com' && !record.allowed), script.out)
  }
  check('every connection was recorded against its job', 'records for smoke-a only', records.length > 0 && records.every(record => record.jobId === 'smoke-a'),
    records.map(record => `${record.host}:${record.allowed ? 'allowed' : 'refused'}`).join(' '))

  // 4. Host checks.
  const checkRun = await runConfined(ctx, { argv: ['sh', '-c', `cat '${join(dshHome, 'smoke-marker.txt')}' '${join(stateDir, 'smoke-marker.txt')}' 2>&1; ${fetchCode('https://registry.npmjs.org/left-pad')}; echo HOME=$HOME`],
    cwd: jobA, timeoutMs: 60_000, signal: AbortSignal.timeout(60_000), jobId: 'smoke-a', profile: 'check' })
  check('a host check sees no credential and runs offline', 'no marker; FAILED', !leaks(checkRun.output) && checkRun.output.includes('FAILED') && checkRun.output.includes(`HOME=${jobA}/.home`), checkRun.output)

  // 5. DSH's file tools: what they could read unguarded, and what a real stage session gets when its model calls them.
  // What `read /proc/<dsh pid>/environ` would return without the guard: the DSH process's own credentials (names only are shown).
  const dsh = readdirSync('/proc').filter(entry => /^\d+$/u.test(entry)).find(pid => {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes('dsh/lib/bin.js') } catch { return false }
  })
  const names = dsh ? readFileSync(`/proc/${dsh}/environ`, 'latin1').split('\0').map(entry => entry.split('=')[0]!).filter(name => WORKER_FORBIDDEN_ENV_PATTERN.test(name)) : []
  check('unguarded, the DSH process environment is readable and holds credential variables', 'credential names present (why the guard exists)', names.length > 0,
    names.join(', ') || `no DSH process found (${dsh ?? 'none'})`)
  // A real stage attempt (smoke-session-tools.ts): DSH's own profile boot, stage runner, preset and tool pipeline, a scripted model.
  const child = execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'smoke-session-tools.ts')],
    { encoding: 'utf8', timeout: 240_000, env: process.env })
  const line = child.split('\n').find(entry => entry.startsWith('SMOKE_SESSION_RESULT '))
  const session = (line ? JSON.parse(line.slice('SMOKE_SESSION_RESULT '.length)) : { error: 'no result' }) as { error?: string; status?: string
    offered?: string[]; results?: Record<string, string> }
  check('a real stage attempt ran its scripted tool calls to completion', 'completed', session.status === 'completed', session.error ?? `status ${session.status}`)
  const offered = session.offered ?? []
  check('the implement session is offered the file tools, and no web or subagent tool', 'read, grep, glob, write; no web_*, subagent',
    ['read', 'read_image', 'grep', 'glob', 'write', 'edit', 'bash'].every(name => offered.includes(name))
      && !offered.some(name => /^web_|subagent|send_message|list_agents|apply_patch/u.test(name)), offered.join(' '))
  const results = session.results ?? {}
  for (const [id, call] of [['c1', 'read /proc/self/environ'], ['c2', 'read $DSH_HOME/.credentials.yaml'], ['c3', 'grep a sibling worktree'],
    ['c4', 'glob the state directory'], ['c5', 'read_image /etc/hostname'], ['c6', 'read ../<sibling>/secret.txt']] as const) {
    const result = results[id] ?? '(no result)'
    check(`in a stage session, ${call} is refused by DSH before it runs`, 'refused', result.startsWith('Error:') && result.includes('outside this job\'s worktree')
      && !result.includes('SMOKE_SIBLING_SECRET') && !leaks(result), result)
  }
  check('in a stage session, write, read and grep inside the worktree work', 'written, read back, found', (results.c7 ?? '').includes('Created file')
    && (results.c8 ?? '').includes('SMOKE_WORKTREE_NOTE') && (results.c9 ?? '').includes('Found 1 match'), `${results.c8 ?? ''} ${results.c9 ?? ''}`)

  // 6. Test tampering.
  writeFileSync(join(jobA, 'tests', 'auth.test.js'), "it.skip('rejects', () => {\n  expect(1).toBe(1)\n})\n")
  git(jobA, 'commit', '-qam', 'skip the failing test')
  const confined = await confinedUploadPack(ctx, 'smoke-a', jobA)
  const diff = await workDiff({ worktree: jobA, base, ...confined ? { uploadPack: confined } : {} })
  const rules = integrityFindings(diff.files).map(finding => finding.rule)
  check('test tampering is detected, through the confined upload-pack', 'skip-marker', rules.includes('skip-marker') && confined !== undefined, rules.join(', '))

  // 7. A host fetch from a worktree whose repository reaches another job's: smoke-c borrows smoke-b's objects
  // (alternates) and links its branch to smoke-b's ref; smoke-b holds a committed secret.
  git(jobB, 'init', '-q', '-b', 'main'); git(jobB, 'add', '.'); git(jobB, 'commit', '-qm', 'other job')
  mkdirSync(jobC, { recursive: true })
  writeFileSync(join(jobC, 'README.md'), 'smoke-c\n')
  git(jobC, 'init', '-q', '-b', 'main'); git(jobC, 'add', '.'); git(jobC, 'commit', '-qm', 'c')
  writeFileSync(join(jobC, '.git', 'objects', 'info', 'alternates'), `${join(jobB, '.git', 'objects')}\n`)
  rmSync(join(jobC, '.git', 'refs', 'heads', 'main'))
  symlinkSync(join(jobB, '.git', 'refs', 'heads', 'main'), join(jobC, '.git', 'refs', 'heads', 'main'))
  const fetchInto = (extra: string[], env: Record<string, string> = {}) => {
    const scratch = join(stateDir, 'smoke-fetch')
    rmSync(scratch, { recursive: true, force: true })
    git(stateDir, 'init', '-q', '--bare', scratch)
    try {
      execFileSync('git', ['-C', scratch, 'fetch', '--quiet', '--no-tags', ...extra, jobC, '+HEAD:refs/work/head'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env } })
      return execFileSync('git', ['-C', scratch, 'show', 'refs/work/head:secret.txt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { return `FAILED ${String((error as { stderr?: string }).stderr ?? error).split('\n')[0]}` } finally { rmSync(scratch, { recursive: true, force: true }) }
  }
  const unconfined = fetchInto([])
  check('unconfined, a fetch from that worktree reads the other job\'s secret', 'secret read (why the sandbox exists)', leaks(unconfined), leaks(unconfined) ? 'secret read' : unconfined)
  const pack = await confinedUploadPack(ctx, 'smoke-c', jobC)
  const sandboxed = pack ? fetchInto([`--upload-pack=${pack.command}`], pack.env) : 'no sandbox'
  check('through the job\'s sandbox (host profile fetch), the same fetch cannot read it', 'fails; no secret', !leaks(sandboxed) && sandboxed.startsWith('FAILED'), sandboxed)
  const guarded = await workDiff({ worktree: jobC, base: git(jobC, 'rev-parse', 'HEAD'), ...pack ? { uploadPack: pack } : {} }).then(() => 'diffed', (error: unknown) => String(error))
  check('the integrity diff refuses that worktree', 'refused: alternates', guarded.includes('alternates') && !leaks(guarded), guarded)

  proxy.closeAll()
  await services(ctx, host, shell)
  if (!offline) await toolchains(ctx, host, shell, fetchCode)
}

type Shell = (command: string, options?: { job?: string; root?: string; mode?: 'workspace-write' | 'read-only' }) =>
  Promise<{ exitCode: number | null; out: string; err: string }>

/** The container's processes whose command line matches, outside every sandbox. */
const processes = (pattern: RegExp) => readdirSync('/proc').filter(entry => /^\d+$/u.test(entry)).flatMap(pid => {
  try { const line = readFileSync(`/proc/${pid}/cmdline`, 'latin1').replace(/\0/gu, ' '); return pattern.test(line) ? [line.slice(0, 60)] : [] } catch { return [] }
})

/** 9. Test services (`T12.6`, `D11`): each started on first connection inside the command's own sandbox, and nowhere else. */
async function services(ctx: Context, host: SandboxHost, shell: Shell): Promise<void> {
  if (!servicesDir) { check('the image names its test services', 'WORKBENCH_SERVICES_DIR', false, 'not set'); return }
  rmSync(jobE, { recursive: true, force: true })
  mkdirSync(jobE, { recursive: true })
  writeFileSync(join(jobE, 'marker.txt'), 'smoke-e\n')
  host.prepareJob('smoke-e', { worktree: jobE, egress: 'none', services: { postgres: '16' } })
  const e = (command: string, mode: 'workspace-write' | 'read-only' = 'workspace-write') => shell(command, { job: 'smoke-e', root: jobE, mode })
  const timed = async (command: string) => { const started = Date.now(); const result = await e(command); return { ...result, ms: Date.now() - started } }

  const idle = await e('ls /tmp/.workbench-services 2>&1; echo; ls /proc | grep -cE "^[0-9]+$"')
  check('a command that never connects starts no service', 'no service directory; a few processes', /No such file/u.test(idle.out) && Number(idle.out.trim().split('\n').at(-1)) < 10, idle.out)
  const pg = await timed('psql -Atc "select current_setting(\'server_version_num\')"; psql -h postgres -Atc "select current_user"; echo "$DATABASE_URL"')
  check('Postgres starts on the first connection, at the job\'s major, by localhost and by its CI name', `16xxxx; postgres; the URL (${pg.ms} ms)`,
    /^16\d{4}\npostgres\npostgresql:\/\/postgres:postgres@localhost:5432\/postgres/u.test(pg.out), `${pg.out} ${pg.err}`)
  host.prepareJob('smoke-e', { worktree: jobE, egress: 'none', services: { postgres: '15' } })
  const pg15 = await e('psql -Atc "show server_version"')
  check('another job\'s Postgres major is the one its file names', '15.x', /^15\./u.test(pg15.out), pg15.out || pg15.err)
  host.prepareJob('smoke-e', { worktree: jobE, egress: 'none', services: { postgres: '16' } })
  const amqp = await timed(`node -e "const s = require('net').connect(5672, 'rabbitmq', () => s.write(Buffer.from('AMQP\\x00\\x00\\x09\\x01', 'latin1'))); `
    + `s.on('data', d => { console.log(d[0] === 1 && d.includes('RabbitMQ') ? 'CONNECTION.START' : 'OTHER'); s.destroy() }); s.on('error', e => console.log(e.code))"`)
  check('RabbitMQ starts on the first connection to rabbitmq:5672 and answers AMQP', `Connection.Start (${amqp.ms} ms)`, amqp.out.includes('CONNECTION.START'), `${amqp.out} ${amqp.err}`)
  const kafka = await timed('k=/opt/kafka/bin; export KAFKA_HEAP_OPTS=-Xmx128m LOG_DIR=/tmp/cli-logs; '
    + '$k/kafka-topics.sh --bootstrap-server kafka:9092 --create --topic smoke 2>&1 | tail -1; '
    + 'echo hello-kafka | $k/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic smoke 2>&1 | tail -1; '
    + '$k/kafka-console-consumer.sh --bootstrap-server $KAFKA_BOOTSTRAP_SERVERS --topic smoke --from-beginning --max-messages 1 --timeout-ms 20000 2>/dev/null')
  check('Kafka starts on the first connection, and a topic, a message and its read-back go through the launcher', `hello-kafka (${kafka.ms} ms, three JVM clients)`,
    kafka.out.includes('Created topic smoke') && kafka.out.trim().endsWith('hello-kafka'), `${kafka.out} ${kafka.err}`.slice(-300))
  const fresh = await e('psql -qc "create table seeded (x int)"; psql -Atc "select count(*) from pg_tables where tablename = \'seeded\'"')
  const after = await e('psql -Atc "select count(*) from pg_tables where tablename = \'seeded\'"')
  check('every command gets fresh services: a table one command made is gone in the next', '1, then 0', fresh.out.trim() === '1' && after.out.trim() === '0', `${fresh.out} | ${after.out}`)
  // Two commands at once: each reaches only the Postgres in its own sandbox.
  const holder = e('psql -qc "create table held (x int)" && echo HELD && sleep 12')
  await new Promise(resolve => setTimeout(resolve, 6000))
  const other = await e('psql -Atc "select count(*) from pg_tables where tablename = \'held\'"')
  const checkSees = await runConfined(ctx, { argv: ['sh', '-c', 'psql -Atc "select count(*) from pg_tables where tablename = \'held\'"'], cwd: jobE, timeoutMs: 120_000,
    signal: AbortSignal.timeout(120_000), jobId: 'smoke-e', profile: 'check' })
  const held = await holder
  check('a service is reachable only from its own sandbox: another shell and a host check see none of its data', 'HELD; 0; 0',
    held.out.includes('HELD') && other.out.trim() === '0' && checkSees.output.trim().endsWith('0'), `${held.out.trim()} | ${other.out.trim()} | ${checkSees.output.trim().slice(-40)}`)
  const masked = await e(`psql -Atc "select pg_read_file('${join(dshHome, 'smoke-marker.txt')}')" 2>&1; psql -Atc "copy (select 1) to program 'cat ${join(stateDir, 'smoke-marker.txt')} >&2'" 2>&1`)
  check('a service cannot read the masked directories either', 'no such file; no marker', !masked.out.includes(MARKER) && /No such file/u.test(masked.out), masked.out)
  // What the server itself runs shares the command's /tmp, so its answer is read back from there.
  const net = await e(`psql -qc "copy (select 1) to program 'getent hosts registry.npmjs.org > /tmp/dns.txt || echo no-dns > /tmp/dns.txt; `
    + `${process.execPath} -e \\"require(''net'').connect(443, ''104.16.0.35'').on(''connect'', () => console.log(''CONNECTED'')).on(''error'', e => console.log(e.code))\\" > /tmp/tcp.txt'" 2>&1; sleep 1; cat /tmp/dns.txt /tmp/tcp.txt`)
  check('a service reaches no network', 'no-dns; ENETUNREACH', net.out.includes('no-dns') && net.out.includes('ENETUNREACH') && !net.out.includes('CONNECTED'), net.out)
  await new Promise(resolve => setTimeout(resolve, 1500))
  const left = processes(/postgres -D|beam\.smp|kafka\.Kafka|epmd/u)
  check('nothing is left running once the commands end', 'no postgres, beam, java or epmd process', left.length === 0, left.join('; ') || 'none')
  const inspect = await e(`node -e "require('net').connect(5432, '127.0.0.1').on('connect', () => console.log('CONNECTED')).on('error', e => console.log(e.code))"; echo "[$DATABASE_URL]"`, 'read-only')
  check('a read-only command (inspect, plan) has no services', 'ECONNREFUSED; no variable', inspect.out.includes('ECONNREFUSED') && inspect.out.includes('[]'), inspect.out)
  const broken = await runConfined(ctx, { argv: ['sh', '-c', `node -e "require('net').createServer().listen(15432, '127.0.0.1')" & sleep 1; psql -Atc "select 1"; echo "exit=$?"`],
    cwd: jobE, timeoutMs: 180_000, signal: AbortSignal.timeout(180_000), jobId: 'smoke-e', profile: 'check' })
  check('a service that cannot start says why, for the check to block on', 'workbench-services: postgres did not start …', /^workbench-services: postgres did not start: /mu.test(broken.output),
    broken.output.split('\n').find(line => line.startsWith('workbench-services:')) ?? broken.output.slice(-200))
}

/** 8. Toolchains (`T11.4`–`T11.6`, `A19`): the setup step for real, then the job's sandboxes with what it installed. */
async function toolchains(ctx: Context, host: SandboxHost, shell: Shell, fetchCode: (url: string) => string): Promise<void> {
  if (!toolchainsDir || !mise) { check('the image names a toolchain cache and mise', 'WORKBENCH_TOOLCHAINS_DIR, WORKBENCH_MISE', false, 'not set'); return }
  // A repository whose mise.toml tries every way to run something, beside its real pins.
  rmSync(jobD, { recursive: true, force: true })
  mkdirSync(jobD, { recursive: true })
  const pwned = (name: string) => `touch ${toolchainsDir}/PWNED-${name} ${jobD}/PWNED-${name} /tmp/PWNED-${name}`
  writeFileSync(join(jobD, 'evil.sh'), `#!/bin/sh\n${pwned('source')}\n`, { mode: 0o755 })
  writeFileSync(join(jobD, 'mise.toml'), `[env]\n_.source = "./evil.sh"\nEVIL = "{{ exec(command='${pwned('template')}') }}"\n[tools]\npython = "3.12"\n`
    + `node = { version = "22.12.0", postinstall = "${pwned('postinstall')}" }\n[hooks]\nenter = "${pwned('hook')}"\n[tasks.x]\nrun = "${pwned('task')}"\n`
    + `[plugins]\nnode = "https://example.invalid/evil.git"\n[settings]\nnode.mirror_url = "https://example.invalid/"\n`)
  // The inline-table node pin is refused, so the first run blocks; the repository then pins node plainly in .tool-versions.
  writeFileSync(join(jobD, '.tool-versions'), 'nodejs 22.12.0\ngolang 1.24.0\n')
  writeFileSync(join(jobD, 'go.mod'), 'module example.com/smoke\n\ngo 1.24\n\nrequire github.com/google/uuid v1.6.0\n')
  git(jobD, 'init', '-q', '-b', 'main'); git(jobD, 'add', '.'); git(jobD, 'commit', '-qm', 'base')
  await excludeJobHome(jobD)
  const records: EgressRecord[] = []
  const registries = new EgressProxy({ dir: join(stateDir, 'sandbox', 'proxy'), allowlist: [...EGRESS_PRESETS.npm!, ...EGRESS_PRESETS.pypi!, ...EGRESS_PRESETS.go!],
    record: entry => { records.push(entry) } })
  const downloads = new EgressProxy({ dir: join(stateDir, 'sandbox', 'toolchain-proxy'), allowlist: TOOLCHAIN_HOSTS, record: entry => { records.push({ ...entry, attemptId: 'setup' }) } })
  const profile = RepositoryProfileSchema.parse({ name: 'smoke', project: 'smoke/d', testCommand: 'python -m pytest', toolchains: { uv: '0.9.5' },
    setupCommand: `python -m pip install --quiet six==1.16.0 && python -c "import six, sys; print('six', six.__version__, sys.prefix)"` })
  const handler = setupHandler({ workbench: {} as never, prepareWorkspace: async () => jobD, repository: () => profile, run: command => runConfined(ctx, command),
    toolchains: { root: toolchainsDir, mise }, openToolchainProxy: jobId => downloads.open(jobId), openRegistriesProxy: jobId => registries.open(jobId),
    closeProxies: jobId => { downloads.close(jobId); registries.close(jobId) }, prepareJob: (jobId, file) => { host.prepareJob(jobId, { ...file, egress: 'none' }) } })
  const run = async () => (await handler.run({ jobId: 'smoke-d', manifestId: 'm', n: 1 }, 'smoke-d', 1) as { ok: { outcome: string; evidence: string; toolchains?: Toolchain[] } }).ok
  const first = await run()
  check('the setup step refuses a pin with a hook, and runs nothing', 'blocked: node must be a plain version string', first.outcome === 'blocked'
    && first.evidence.includes('node must be a plain version string'), first.evidence.split('\n')[0] ?? '')
  writeFileSync(join(jobD, 'mise.toml'), readFileSync(join(jobD, 'mise.toml'), 'utf8').replace(/^node = \{.*\}$/mu, ''))
  const second = await run()
  const installed = Object.fromEntries((second.toolchains ?? []).map(toolchain => [toolchain.tool, toolchain]))
  check('the setup step installs the pinned toolchains and runs the setup command', 'passed: python 3.12.x, node 22.12.0, go 1.24.0, uv 0.9.5',
    second.outcome === 'passed' && /^3\.12\.\d+$/u.test(installed.python?.version ?? '') && installed.node?.version === '22.12.0' && installed.go?.version === '1.24.0'
      && installed.uv?.version === '0.9.5', second.outcome === 'passed' ? second.evidence : second.evidence.slice(-400))
  const markers = execFileSync('sh', ['-c', `ls ${toolchainsDir} ${jobD} /tmp 2>/dev/null | grep -c PWNED || true`], { encoding: 'utf8' }).trim()
  check('nothing in the repository\'s mise.toml ran during the install', 'no PWNED marker anywhere', markers === '0', `${markers} markers`)
  const downloads0 = records.filter(record => record.attemptId === 'setup')
  const hosts = [...new Set(downloads0.map(record => `${record.host}:${record.allowed ? 'ok' : 'refused'}`))]
  // With a warm cache nothing is downloaded; a run on an empty cache shows the hosts.
  check('the install reached only toolchain hosts, through the job\'s toolchain proxy', 'toolchain hosts only (none when cached)',
    downloads0.filter(record => record.allowed).every(record => TOOLCHAIN_HOSTS.includes(record.host)), `${downloads0.length} connections: ${hosts.join(' ') || 'cached'}`)
  const setupNet = records.filter(record => record.attemptId !== 'setup').map(record => record.host)
  check('the setup command reached PyPI through the registries proxy', 'pypi.org, files.pythonhosted.org', setupNet.includes('pypi.org') && setupNet.includes('files.pythonhosted.org'),
    [...new Set(setupNet)].join(' '))
  // The toolchain profile runs nothing but mise install/where and a version command.
  host.prepareJob('smoke-d', { worktree: jobD, egress: 'none', toolchainSocket: await downloads.open('smoke-d') })
  const sneak = await runConfined(ctx, { argv: ['sh', '-c', `touch ${toolchainsDir}/PWNED-sneak; ${fetchCode('https://github.com/')}`], cwd: toolchainsDir, timeoutMs: 30_000,
    signal: AbortSignal.timeout(30_000), jobId: 'smoke-d', profile: 'toolchain' })
  check('the toolchain profile refuses any other command', 'workbench-sandbox refusal', sneak.exitCode !== 0 && sneak.output.includes('workbench-sandbox: ')
    && !existsSync(join(toolchainsDir, 'PWNED-sneak')), sneak.output)
  downloads.close('smoke-d')
  // A tampered binary in the cache: its version command tries to change the cache and to reach out; under the host
  // profile verify, where the setup step runs it, it can do neither.
  const fake = join(toolchainsDir, 'data', 'installs', 'smoke-probe', '1.0.0', 'bin')
  mkdirSync(fake, { recursive: true })
  writeFileSync(join(fake, 'tool'), `#!/bin/sh\ntouch ${toolchainsDir}/PWNED-verify 2>&1\n${process.execPath} -e "fetch('https://github.com/').then(() => console.log('REACHED'), () => console.log('NONET'))"\necho 1.0.0\n`, { mode: 0o755 })
  const tampered = await runConfined(ctx, { argv: [join(fake, 'tool'), '--version'], cwd: toolchainsDir, timeoutMs: 30_000, signal: AbortSignal.timeout(30_000),
    jobId: 'smoke-d', profile: 'verify' })
  rmSync(join(toolchainsDir, 'data', 'installs', 'smoke-probe'), { recursive: true, force: true })
  check('a tampered binary\'s version command runs offline, and cannot change the cache', 'read-only; NONET; no marker', /Read-only file system/u.test(tampered.output)
    && tampered.output.includes('NONET') && !tampered.output.includes('REACHED') && !existsSync(join(toolchainsDir, 'PWNED-verify')), tampered.output)
  const verifyOther = await runConfined(ctx, { argv: [mise, 'install', 'core:node@22.12.0'], cwd: toolchainsDir, timeoutMs: 30_000, signal: AbortSignal.timeout(30_000),
    jobId: 'smoke-d', profile: 'verify' })
  check('the verify profile runs nothing but a version command', 'workbench-sandbox refusal', verifyOther.exitCode !== 0 && verifyOther.output.includes('workbench-sandbox: '),
    verifyOther.output)

  // The job's sandboxes with what the setup step installed (T11.5).
  const bins = (second.toolchains ?? []).map(toolchain => toolchain.bin)
  host.prepareJob('smoke-d', { worktree: jobD, egress: 'registries', socket: await registries.open('smoke-d'), toolchains: bins })
  const d = (command: string) => shell(command, { job: 'smoke-d', root: jobD })
  const versions = await d('python --version; node --version; go version; uv --version; command -v python pip')
  check('an agent shell gets the pinned versions, with the job\'s virtual environment first', `Python ${installed.python?.version}; v22.12.0; go1.24.0; uv 0.9.5; venv`,
    versions.out.includes(`Python ${installed.python?.version}`) && versions.out.includes('v22.12.0') && versions.out.includes('go1.24.0') && versions.out.includes('uv 0.9.5')
      && versions.out.includes(`${jobD}/.home/venv/bin/python`), versions.out)
  const cacheWrite = await d(`touch ${toolchainsDir}/data/installs/PWNED-agent 2>&1; touch ${installed.python?.bin}/PWNED-agent 2>&1; rm -f ${installed.python?.bin}/python3 2>&1; echo done`)
  check('an agent shell cannot write into the toolchain cache', 'read-only file system', !existsSync(join(toolchainsDir, 'data', 'installs', 'PWNED-agent'))
    && existsSync(join(installed.python?.bin ?? '/x', 'python3')) && /Read-only file system/u.test(cacheWrite.out), cacheWrite.out)
  const globals = await d('npm install -g left-pad@1.3.0 --no-audit --no-fund --no-update-notifier >/dev/null 2>&1; pip install --quiet six==1.16.0 2>&1 | tail -1; '
    + 'ls $HOME/.npm-global/lib/node_modules; python -c "import six; print(six.__file__)"')
  check('npm i -g and pip install land in the job\'s home', `${jobD}/.home/.npm-global, ${jobD}/.home/venv`, globals.out.includes('left-pad')
    && globals.out.includes(`${jobD}/.home/venv/lib/`), globals.out)
  // A package with no wheel builds from source with the image's compiler and headers, through the registries proxy.
  const native = await d('python -m pip install --quiet --no-binary psycopg2 psycopg2==2.9.10 2>&1 | tail -3; python -c "import psycopg2; print(\'psycopg2\', psycopg2.__version__)"')
  check('a package with native code builds from source in an implement sandbox (psycopg2 against libpq)', 'psycopg2 2.9.10', /psycopg2 2\.9\.10/u.test(native.out), native.out)
  const goFetch = await d('go mod download -x github.com/google/uuid 2>&1 | tail -1; go list -m github.com/google/uuid; GOPROXY=direct go mod download github.com/google/uuid@v1.5.0 2>&1 | tail -1')
  check('Go fetches a module through its proxy only; a direct fetch from the VCS host is refused', 'uuid v1.6.0; direct refused', goFetch.out.includes('github.com/google/uuid v1.6.0')
    && records.some(record => record.host === 'proxy.golang.org' && record.allowed) && records.some(record => record.host === 'github.com' && !record.allowed && record.attemptId !== 'setup'),
    goFetch.out)
  const yarn = await d('corepack enable 2>&1 | grep -o "EROFS[^,]*" | head -1; mkdir -p "$HOME/.npm-global/bin" && corepack enable --install-directory "$HOME/.npm-global/bin" && mkdir -p yarn-probe && cd yarn-probe '
    + '&& echo \'{"name":"p","packageManager":"yarn@4.10.3"}\' > package.json && yarn --version 2>&1 | tail -1')
  check('yarn comes through corepack from the npm registry, its shims in the job\'s home (corepack enable alone cannot write next to node)', '4.10.3',
    yarn.out.includes('EROFS') && yarn.out.includes('4.10.3') && !records.some(record => record.host === 'repo.yarnpkg.com' && record.allowed), yarn.out)
  const offlineCheck = await runConfined(ctx, { argv: ['sh', '-c', `python --version; node --version; ${fetchCode('https://pypi.org/simple/six/')}`], cwd: jobD, timeoutMs: 60_000,
    signal: AbortSignal.timeout(60_000), jobId: 'smoke-d', profile: 'check' })
  check('a host check gets the same toolchains, offline', `Python ${installed.python?.version}; v22.12.0; FAILED`, offlineCheck.output.includes(`Python ${installed.python?.version}`)
    && offlineCheck.output.includes('v22.12.0') && offlineCheck.output.includes('FAILED'), offlineCheck.output)
  host.prepareJob('smoke-d', { worktree: jobD, egress: 'registries', socket: await registries.open('smoke-d'), toolchains: [join(jobD, '.home', 'venv', 'bin')] })
  const planted = await d('true')
  check('a toolchain directory outside the cache is refused', 'workbench-sandbox refusal', planted.exitCode !== 0 && planted.err.includes('is not in the toolchain cache'), planted.err)
  const status = git(jobD, 'status', '--porcelain')
  check('the job\'s home is not part of its commits', 'no .home in git status', !status.includes('.home'), status || 'clean')
  registries.closeAll()
  downloads.closeAll()
}

const cleanup = () => {
  for (const path of created) {
    try { execFileSync('chmod', ['-R', 'u+w', path], { stdio: 'ignore' }) } catch { /* missing */ }
    try { rmSync(path, { recursive: true, force: true }) } catch (error) { console.error(`cleanup: ${path}: ${String(error)}`) }
  }
  for (const job of ['smoke-a', 'smoke-b', 'smoke-c', 'smoke-d', 'smoke-e']) rmSync(join(stateDir, 'sandbox', 'jobs', `${job}.json`), { force: true })
}
try {
  await main()
} catch (error) {
  check('the smoke ran to its end', 'no error', false, error instanceof Error ? `${error.message} ${error.stack?.split('\n')[1] ?? ''}` : String(error))
} finally {
  cleanup()
}
const width = Math.max(...probes.map(probe => probe.name.length))
for (const probe of probes) console.log(`${probe.ok ? 'PASS' : 'FAIL'}  ${probe.name.padEnd(width)}  expected: ${probe.expected}; got: ${probe.detail}`)
const failed = probes.filter(probe => !probe.ok)
console.log(`\n${probes.length - failed.length}/${probes.length} probes passed${offline ? ' (offline: npm probes skipped)' : ''}`)
process.exit(failed.length > 0 ? 1 : 0)
