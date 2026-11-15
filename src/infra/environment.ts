/** Process environment and git configuration helpers that isolate worker subprocesses. */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'
import { GIT_LOCATION, STRIPPED_WORKER_ENV_KEYS, WORKER_FORBIDDEN_ENV_PATTERN } from './worker-env.ts'

const MARKER = '# Written by workflow-agent on every start; edits are lost.'
/** Markers of files written under the project's earlier names, which `workflow-agent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer', 'dsh-superagent'].map(name => `# Written by ${name} on every start; edits are lost.`)
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')

export { GIT_LOCATION, STRIPPED_WORKER_ENV_KEYS, WORKER_FORBIDDEN_ENV_PATTERN }

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * Returns environment variable overrides that strip ambient tokens, widened credential variables,
 * `SSH_AUTH_SOCK`, interactive prompts, the repository the host's own environment may name, and operator git
 * identity/config overrides, while setting a per-job or isolated `HOME` and `GIT_CONFIG_GLOBAL`.
 */
export function agentVariables(
  stateDir: string,
  worktreeDir?: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const tombstones: Record<string, undefined> = {}
  for (const key of Object.keys(parentEnv)) {
    if (WORKER_FORBIDDEN_ENV_PATTERN.test(key) || STRIPPED_WORKER_ENV_KEYS.includes(key.toUpperCase())) {
      tombstones[key] = undefined
    }
  }
  return {
    ...tombstones,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GITLAB_TOKEN: undefined,
    JIRA_TOKEN: undefined,
    MATTERMOST_TOKEN: undefined,
    SSH_AUTH_SOCK: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    HOME: worktreeDir ? join(worktreeDir, '.home') : join(stateDir, 'worker-home'),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir),
    GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    // When no credential helper is set, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '',
    SSH_ASKPASS: undefined,
    GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_EMAIL: undefined,
  }
}

/**
 * True when a regular file has a workflow-agent marker in its first two lines; a symbolic link, directory, or other non-regular file
 * never counts as written by workflow-agent.
 */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/** Isolated worker git configuration content blocking direct remote access and enforcing explicit commit identity. */
export const WORKER_GITCONFIG_CONTENT = [
  MARKER,
  // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
  '[user]',
  '\tuseConfigOnly = true',
  '[credential]',
  '\thelper =',
  // Block direct worker remote git operations (`https://`, `http://`, `ssh://`, `git://`, `git@`); all remote clones/pushes are host-brokered.
  '[url "invalid://blocked-by-workflow-agent/"]',
  '\tinsteadOf = https://',
  '\tinsteadOf = http://',
  '\tinsteadOf = ssh://',
  '\tinsteadOf = git://',
  '\tinsteadOf = git@',
  // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
  '[filter "lfs"]',
  '\tclean = git-lfs clean -- %f',
  '\tsmudge = git-lfs smudge -- %f',
  '\tprocess = git-lfs filter-process',
  '\trequired = true',
  '',
].join('\n')

/**
 * Atomically writes the isolated worker git configuration file into the state directory and removes the command shims earlier
 * versions left in `worker-bin`, refusing to overwrite or remove files it did not write.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir'>): Promise<void> {
  const { stateDir } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  for (const name of before) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), WORKER_GITCONFIG_CONTENT)
}

/**
 * The environment overrides of a command the host runs for a job: credentials and agent sockets removed, git prompts off, and a
 * `HOME` inside its working directory.
 */
export function workerEnvironment(cwd: string, env?: Record<string, string>): Record<string, string | undefined> {
  const tombstones: Record<string, string | undefined> = {
    SSH_AUTH_SOCK: undefined,
    SSH_ASKPASS: undefined,
    GIT_ASKPASS: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: join(cwd, '.home'),
  }
  for (const key of Object.keys(process.env)) {
    if (WORKER_FORBIDDEN_ENV_PATTERN.test(key) || STRIPPED_WORKER_ENV_KEYS.includes(key.toUpperCase())) {
      tombstones[key] = undefined
    }
  }
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (WORKER_FORBIDDEN_ENV_PATTERN.test(k) || STRIPPED_WORKER_ENV_KEYS.includes(k.toUpperCase())) {
        tombstones[k] = undefined
      } else {
        tombstones[k] = v
      }
    }
  }
  return tombstones
}

/** Spawns a command through the DSH subprocess runtime with hardened worker environment overrides. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const tombstones = workerEnvironment(cwd, env)
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, env: tombstones, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, exitCode ?? undefined)
}
