/**
 * Host-side git transport for GitLab (`D5`, `F8`, `F9`): clones a project into a job's worktree and pushes the worktree's commits to an
 * `agent/<issue>-<slug>` branch. The token exists only in the environment of the host's git processes, never in a worktree, a remote
 * URL, or a command line, so a worker can neither read it from the worktree nor push on its own.
 *
 * A worktree is writable by the worker: its `.git/config` and hooks are untrusted and must never run on the host with the token.
 * `push` therefore fetches the worktree's `HEAD` into a fresh host-owned bare repository (`upload-pack` runs no hooks and takes no
 * worker-set command from repository config) and pushes from there. The repository must be its own (`assertOwnRepository`: no
 * `gitdir:` file, `commondir`, alternates or symbolic link in `.git`), and when the host gives `uploadPack`, the worktree's
 * `upload-pack` runs in the job's sandbox (host profile `fetch`), where no other repository is visible: otherwise
 * a layout the agent wrote could push another job's code under this job's branch.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertOwnRepository, GitLayoutError } from '../infra/git-layout.ts'

const run = promisify(execFile)

export interface GitTransportConfig {
  /** GitLab base URL, such as `https://gitlab.example.com`. */
  baseUrl: string
  token: string
  /** The remote URL of a project; `<baseUrl>/<project>.git` when omitted. Tests point it at local repositories. */
  remoteUrl?: (project: string) => string
  git?: string
}

export interface GitTransport {
  /**
   * Clones `project` into the not-yet-existing or empty `directory`, and returns the commit it checked out: read before any worker
   * has touched the clone, so it is the trusted base the test-integrity check diffs against (`T10.1`).
   */
  clone(params: { project: string; directory: string }): Promise<{ head: string }>
  /** Pushes the worktree's `HEAD` (or its ancestor `commitSha`) to `branch`, never forcing; returns the commit pushed. */
  push(params: { worktreeDir: string; project: string; branch: string; commitSha?: string; uploadPack?: { command: string; env: Readonly<Record<string, string>> } }):
    Promise<{ pushed: true; commitSha: string }>
}

/** Thrown for a git failure; its message never contains the token. */
export class GitTransportError extends Error {}

export function createGitTransport(config: GitTransportConfig): GitTransport {
  const git = config.git ?? 'git'
  const base = config.baseUrl.replace(/\/+$/u, '')
  const url = config.remoteUrl ?? ((project: string) => `${base}/${project}.git`)
  const basic = Buffer.from(`oauth2:${config.token}`, 'utf8').toString('base64')
  const hide = (text: string): string => text.replaceAll(config.token, '***').replaceAll(basic, '***')
  // The credential travels as an `http.<base>/.extraHeader` entry of the git process's environment: scoped to this GitLab, absent from argv and from disk.
  const environment = (credential = true): Record<string, string> => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? tmpdir(), LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1',
    ...credential ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${base}/.extraheader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` } : {},
  })
  /** Runs git; `local` runs read only the worktree, so they get no credential, and `extraEnv` (the sandbox wrapper's variables). */
  async function exec(args: string[], cwd?: string, local?: { extraEnv?: Readonly<Record<string, string>> }): Promise<string> {
    try {
      const { stdout } = await run(git, args, { cwd, env: { ...environment(local === undefined), ...local?.extraEnv }, timeout: 5 * 60_000, maxBuffer: 1 << 20 })
      return stdout.trim()
    } catch (error) {
      const failure = error as { stderr?: string; message?: string }
      throw new GitTransportError(hide(`git ${args[0]} failed: ${(failure.stderr || failure.message || String(error)).trim()}`))
    }
  }
  return {
    async clone({ project, directory }) {
      await exec(['clone', '--quiet', url(project), directory])
      return { head: await exec(['rev-parse', '--verify', 'HEAD^{commit}'], directory) }
    },
    async push({ worktreeDir, project, branch, commitSha, uploadPack }) {
      // The repository must be its own: a gitdir file, commondir, alternates or a link in .git could name another job's repository.
      await assertOwnRepository(worktreeDir).catch(error => { throw error instanceof GitLayoutError ? new GitTransportError(error.message) : error })
      const scratch = await mkdtemp(join(tmpdir(), 'workflow-agent-push-'))
      try {
        await exec(['init', '--quiet', '--bare', scratch])
        // The token is not in this fetch's environment: it reads the worktree only. Its upload-pack runs in the job's sandbox.
        await exec(['fetch', '--quiet', '--no-tags', ...uploadPack ? [`--upload-pack=${uploadPack.command}`] : [], worktreeDir, 'HEAD'], scratch,
          { ...uploadPack ? { extraEnv: uploadPack.env } : {} })
        const head = await exec(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], scratch)
        let sha = head
        if (commitSha && commitSha !== 'HEAD' && commitSha !== head) {
          sha = await exec(['rev-parse', '--verify', `${commitSha}^{commit}`], scratch).catch(() => { throw new GitTransportError(`Commit ${commitSha} is not in the worktree`) })
          await exec(['merge-base', '--is-ancestor', sha, head], scratch).catch(() => { throw new GitTransportError(`Commit ${commitSha} is not part of the worktree's HEAD history`) })
        }
        await exec(['push', '--quiet', url(project), `${sha}:refs/heads/${branch}`], scratch)
        return { pushed: true, commitSha: sha }
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    },
  }
}
