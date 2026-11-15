import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  GIT_LOCATION,
  WORKER_FORBIDDEN_ENV_PATTERN,
  agentVariables,
  runAsWorker,
  withoutDirectory,
  workerBin,
  workerGitConfig,
  writeEnvironment,
} from '../src/infra/environment.ts'
import { CliError } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** A worker shell's environment: the overrides applied (`undefined` removes a variable), then DSH's drop of credential-shaped names. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0]),
    ),
  )
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('worker environment files and legacy cleanup', () => {
  it('writes isolated worker-gitconfig, cleans up legacy shims in worker-bin, and refuses foreign files', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }))
    const bin = workerBin(dir)
    expect(readdirSync(bin)).toEqual([])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by workflow-agent')

    const markerLine = '# Written by workflow-agent on every start; edits are lost.'
    writeFileSync(join(bin, 'legacy-shim'), `#!/bin/sh\n${markerLine}\nexit 1\n`)
    await writeEnvironment(testDeployment({ stateDir: dir }))
    expect(readdirSync(bin)).toEqual([])

    // A file that merely contains the marker on a later line, a symlink, and a foreign gitconfig are all rejected.
    writeFileSync(join(bin, 'notes'), `notes\nmore\n${markerLine}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }))).rejects.toThrow(`${join(bin, 'notes')} was not written by workflow-agent`)
    rmSync(join(bin, 'notes'))

    writeFileSync(join(bin, 'target'), 'data')
    symlinkSync(join(bin, 'target'), join(bin, 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }))).rejects.toThrow('link was not written by workflow-agent')
    rmSync(join(bin, 'link'))
    rmSync(join(bin, 'target'))

    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }))).rejects.toThrow(`${workerGitConfig(dir)} was not written by workflow-agent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })

  it('replaces files written under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }))
    writeFileSync(workerGitConfig(dir), readFileSync(workerGitConfig(dir), 'utf8').replace('Written by workflow-agent', 'Written by dsh-go'))
    writeFileSync(join(workerBin(dir), 'old-cli'), '#!/bin/sh\n# Written by dsh-tag on every start; edits are lost.\nexit 1\n')
    await writeEnvironment(testDeployment({ stateDir: dir }))
    expect(readdirSync(workerBin(dir))).toEqual([])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by workflow-agent')
  })
})

describe('agent git configuration and worker environment hardening', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that enables commit signing and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir })
    await writeEnvironment(deployment)
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    expect(await git('config', '--show-origin', '--get', 'user.useConfigOnly')).toBe(`file:${workerGitConfig(dir)}\ttrue`)
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })

  it('strips SSH_AUTH_SOCK, operator HOME, inherited git config, and all widened credential patterns from the worker environment', () => {
    const operatorHome = '/Users/operator'
    const worktreeDir = join(dir, 'work', 'pay-123')
    const ambientParent: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: operatorHome,
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      SSH_ASKPASS: '/usr/bin/ssh-askpass',
      GIT_AUTHOR_NAME: 'Operator',
      GIT_COMMITTER_EMAIL: 'operator@example.com',
      GIT_CONFIG_COUNT: '1',
      DEEPSEEK_API_KEY: 'sk-deepseek',
      DB_PASSWORD: 'db-pass',
      WEBHOOK_SECRET: 'wh-sec',
      GITHUB_TOKEN: 'gh-tok',
      SERVICE_AUTH_HEADER: 'Bearer xyz',
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/creds.json',
      SESSION_COOKIE: 'sid=123',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      JIRA_BASE_URL: 'https://jira.example.com',
      JIRA_API_TOKEN: 'jira-pat',
      MATTERMOST_URL: 'https://mm.example.com',
      MATTERMOST_BOT_TOKEN: 'mm-pat',
      GITLAB_URL: 'https://gitlab.example.com',
      GITLAB_PRIVATE_TOKEN: 'gl-pat',
      LITELLM_BASE_URL: 'https://litellm.example.com',
      LITELLM_API_KEY: 'litellm-key',
    }

    const overrides = agentVariables(dir, worktreeDir, ambientParent)
    const finalEnv = workerEnv({ ...ambientParent, ...overrides })

    expect(finalEnv.HOME).toBe(join(worktreeDir, '.home'))
    expect(finalEnv.HOME).not.toBe(operatorHome)
    expect(finalEnv.GIT_CONFIG_GLOBAL).toBe(workerGitConfig(dir))
    expect(finalEnv.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(finalEnv.GIT_TERMINAL_PROMPT).toBe('0')
    expect(finalEnv.GIT_ASKPASS).toBe('')
    expect(finalEnv).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(finalEnv).not.toHaveProperty('SSH_ASKPASS')
    expect(finalEnv).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(finalEnv).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    expect(finalEnv).not.toHaveProperty('GIT_CONFIG_COUNT')

    for (const key of Object.keys(finalEnv)) {
      expect(WORKER_FORBIDDEN_ENV_PATTERN.test(key), `Forbidden env key leaked: ${key}`).toBe(false)
    }
    for (const forbidden of [
      'DEEPSEEK_API_KEY',
      'DB_PASSWORD',
      'WEBHOOK_SECRET',
      'GITHUB_TOKEN',
      'SERVICE_AUTH_HEADER',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'SESSION_COOKIE',
      'DATABASE_URL',
      'DOCKER_HOST',
      'JIRA_BASE_URL',
      'JIRA_API_TOKEN',
      'MATTERMOST_URL',
      'MATTERMOST_BOT_TOKEN',
      'GITLAB_URL',
      'GITLAB_PRIVATE_TOKEN',
      'LITELLM_BASE_URL',
      'LITELLM_API_KEY',
    ]) {
      expect(finalEnv).not.toHaveProperty(forbidden)
    }
  })
})

it('fails instead of asking the operator\'s askpass helpers when no credential helper answers', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const deployment = testDeployment({ stateDir: dir })
  await writeEnvironment(deployment)
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=gitlab.example.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), '/usr/bin', 'node_modules/.bin'].join(':'), bin)).toBe('/usr/bin:node_modules/.bin')
})

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('a command run as a worker', () => {
  const signal = new AbortController().signal
  it('reports a failed command\'s exit status', async () => {
    const failing = ['sh', '-c', 'echo nope >&2; exit 3']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, read by a worker's git.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      expect((await runAsWorker(subprocess(join(dir, 'global')), ['git', 'rev-parse', '--git-dir'], join(dir, 'repo'), new AbortController().signal)).trim()).toBe('.git')
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})
