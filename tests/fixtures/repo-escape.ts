/**
 * Repository layouts that reach another repository from a worktree whose `.git` is a real directory (final review): alternates
 * plus a ref linked into the other repository, and `commondir`. The other repository holds a secret file a fetch must never read.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } }).trim()

/** Another job's repository with a committed secret, under `root`. */
export function otherRepository(root: string): { dir: string; secret: string } {
  const dir = join(root, 'other-job')
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 's.txt'), 'OTHER_JOB_SECRET\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'other job')
  return { dir, secret: 'OTHER_JOB_SECRET' }
}

/** Makes `worktree` borrow the other repository's objects and point its current branch at the other repository's commit. */
export function alternatesAndLinkedRef(worktree: string, other: string): void {
  const branch = git(worktree, 'symbolic-ref', '--short', 'HEAD')
  writeFileSync(join(worktree, '.git', 'objects', 'info', 'alternates'), `${join(other, '.git', 'objects')}\n`)
  const ref = join(worktree, '.git', 'refs', 'heads', branch)
  rmSync(ref, { force: true })
  symlinkSync(join(other, '.git', 'refs', 'heads', git(other, 'symbolic-ref', '--short', 'HEAD')), ref)
}

/** Makes `worktree`'s repository a linked worktree of the other repository, through `commondir`. */
export function commonDir(worktree: string, other: string): void {
  writeFileSync(join(worktree, '.git', 'commondir'), `${join(other, '.git')}\n`)
}
