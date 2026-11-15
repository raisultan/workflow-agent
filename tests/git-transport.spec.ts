/** The host's git transport against real local repositories: clone, non-force push of a worktree, and the worker-controlled-repo hazards. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitTransport, GitTransportError } from '../src/sources/git-transport.ts'
import { alternatesAndLinkedRef, commonDir, otherRepository } from './fixtures/repo-escape.ts'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// Real git processes: slow when the whole suite runs at once.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

describe('git transport', () => {
  let root: string, remotes: string, work: string
  const project = 'acme/app'
  const transport = () => createGitTransport({ baseUrl: 'https://gitlab.example.test', token: 'glpat-secret', remoteUrl: name => join(remotes, `${name}.git`) })
  const remoteHead = (branch: string) => git(join(remotes, `${project}.git`), 'rev-parse', `refs/heads/${branch}`)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'awb-git-'))
    remotes = join(root, 'remotes'); work = join(root, 'work')
    mkdirSync(join(remotes, 'acme'), { recursive: true }); mkdirSync(work)
    const bare = join(remotes, `${project}.git`)
    git(root, 'init', '--bare', bare)
    const seed = join(root, 'seed')
    git(root, 'init', seed)
    writeFileSync(join(seed, 'a.txt'), 'one\n')
    git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', bare, 'HEAD:refs/heads/main')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  async function worktree(name = 'job1'): Promise<string> {
    const dir = join(work, name)
    await transport().clone({ project, directory: dir })
    return dir
  }

  it('clones a project and pushes a worker commit to an agent branch without any credential in the worktree', async () => {
    const dir = join(work, 'job1')
    // The clone reports the commit it checked out: the job's trusted base (T10.1).
    expect(await transport().clone({ project, directory: dir })).toEqual({ head: git(dir, 'rev-parse', 'HEAD') })
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(join(remotes, `${project}.git`))
    writeFileSync(join(dir, 'b.txt'), 'two\n')
    git(dir, 'checkout', '-b', 'agent/pay-1-fix'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'change')
    const pushed = await transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-fix' })
    expect(pushed.commitSha).toBe(git(dir, 'rev-parse', 'HEAD'))
    expect(remoteHead('agent/pay-1-fix')).toBe(pushed.commitSha)
    // A later commit on the same branch is a fast-forward and goes through.
    writeFileSync(join(dir, 'c.txt'), 'three\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'review fix')
    const again = await transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-fix' })
    expect(remoteHead('agent/pay-1-fix')).toBe(again.commitSha)
    expect(again.commitSha).not.toBe(pushed.commitSha)
  })

  it('never forces: a rewritten history is refused and the remote branch is kept', async () => {
    const dir = await worktree()
    writeFileSync(join(dir, 'b.txt'), 'two\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'change')
    const first = await transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-fix' })
    git(dir, 'commit', '--amend', '-m', 'rewritten')
    await expect(transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-fix' })).rejects.toBeInstanceOf(GitTransportError)
    expect(remoteHead('agent/pay-1-fix')).toBe(first.commitSha)
  })

  it('does not run hooks or config a worker planted in its worktree', async () => {
    const dir = await worktree()
    writeFileSync(join(dir, 'b.txt'), 'two\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'change')
    // The worker plants hooks and config that would run code if the host ran git inside this repository.
    const marker = join(root, 'ran')
    for (const hook of ['pre-push', 'reference-transaction', 'post-checkout']) {
      writeFileSync(join(dir, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${marker}\n`); chmodSync(join(dir, '.git', 'hooks', hook), 0o755)
    }
    writeFileSync(join(dir, '.git', 'config'), `${execFileSync('cat', [join(dir, '.git', 'config')], { encoding: 'utf8' })}[core]\n\tfsmonitor = touch ${marker}; echo\n\thooksPath = ${join(dir, '.git', 'hooks')}\n`)
    expect(existsSync(marker)).toBe(false)
    const pushed = await transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-fix' })
    expect(existsSync(marker)).toBe(false)
    expect(remoteHead('agent/pay-1-fix')).toBe(pushed.commitSha)
  })

  it('refuses a worktree whose .git is not its own directory (a gitdir file or symlink could name another job)', async () => {
    const other = await worktree('other')
    writeFileSync(join(other, 'secret.txt'), 'other job\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'other')
    const dir = await worktree('mine')
    renameSync(join(dir, '.git'), join(root, 'moved.git'))
    symlinkSync(join(other, '.git'), join(dir, '.git'))
    await expect(transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-fix' })).rejects.toThrow(/\.git directory of its own/u)
    rmSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git'), `gitdir: ${join(other, '.git')}\n`)
    await expect(transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-fix' })).rejects.toThrow(/\.git directory of its own/u)
    expect(() => remoteHead('agent/pay-1-fix')).toThrow()
  })

  it('refuses a repository that reaches another job\'s through alternates and a linked ref, or commondir, and pushes nothing (final review)', async () => {
    const other = otherRepository(root)
    const dir = await worktree()
    alternatesAndLinkedRef(dir, other.dir)
    await expect(transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-x' })).rejects.toThrow(GitTransportError)
    const second = await worktree('job2')
    commonDir(second, other.dir)
    await expect(transport().push({ worktreeDir: second, project, branch: 'agent/pay-1-y' })).rejects.toThrow(/commondir/u)
    expect(() => remoteHead('agent/pay-1-x')).toThrow()
    expect(() => remoteHead('agent/pay-1-y')).toThrow()
  })

  it('runs the worktree\'s upload-pack through the command the host gives, without the token in its environment (final review)', async () => {
    const dir = await worktree()
    writeFileSync(join(dir, 'b.txt'), 'two\n')
    git(dir, 'checkout', '-b', 'agent/pay-1-fix'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'change')
    const marker = join(root, 'upload-pack-env')
    const script = join(root, 'confined-upload-pack.sh')
    writeFileSync(script, `#!/bin/sh\nenv > '${marker}'\nexec git-upload-pack "$@"\n`, { mode: 0o755 })
    await transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-fix', uploadPack: { command: `'${script}'`, env: { WORKBENCH_SANDBOX_JOB: 'job1' } } })
    expect(remoteHead('agent/pay-1-fix')).toBe(git(dir, 'rev-parse', 'HEAD'))
    const env = readFileSync(marker, 'utf8')
    expect(env).toContain('WORKBENCH_SANDBOX_JOB=job1')
    expect(env).not.toMatch(/extraheader|Authorization|glpat-secret/iu)
  })

  it('pushes an earlier commit of the worktree but refuses one it does not contain', async () => {
    const dir = await worktree()
    const first = git(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, 'b.txt'), 'two\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'change')
    const pushed = await transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-early', commitSha: first })
    expect(pushed.commitSha).toBe(first)
    await expect(transport().push({ worktreeDir: dir, project, branch: 'agent/pay-1-x', commitSha: 'f'.repeat(40) })).rejects.toThrow(/not in the worktree/u)
  })

  it('keeps the token out of every error it raises', async () => {
    const unreachable = createGitTransport({ baseUrl: 'http://127.0.0.1:9', token: 'glpat-secret' })
    const error = await unreachable.clone({ project, directory: join(work, 'never') }).then(() => new Error('cloned'), (failure: unknown) => failure as Error)
    expect(error).toBeInstanceOf(GitTransportError)
    expect(error.message).not.toContain('glpat-secret')
    expect(error.message).not.toContain(Buffer.from('oauth2:glpat-secret').toString('base64'))
  })
})
