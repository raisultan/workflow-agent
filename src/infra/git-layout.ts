/**
 * A cheap first guard on a worktree's repository before the host fetches from it (final review): the repository must be its own.
 * The real protection is that the worktree side of every host fetch (`upload-pack`) runs in the job's sandbox, where every other
 * repository, the state and `$DSH_HOME` are masked (`src/sandbox/`, host profile `fetch`); this guard refuses the known ways a
 * repository reaches outside itself before anything runs:
 *
 * - `.git` is not a plain directory (a `gitdir:` file or a link names another repository);
 * - `.git/commondir` (a linked worktree's pointer to another repository's objects and refs);
 * - `.git/objects/info/alternates` or `http-alternates` (borrowed objects);
 * - any symbolic link inside `.git` (a ref, `HEAD`, `packed-refs`, an object or pack linked to another repository).
 */
import { appendFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** The sandbox's `HOME` (npm's prefix, the job's virtual environment, caches) is in the worktree; git leaves it out of commits (`T11.5`). */
export async function excludeJobHome(repository: string): Promise<void> {
  await mkdir(join(repository, '.git', 'info'), { recursive: true })
  await appendFile(join(repository, '.git', 'info', 'exclude'), '\n/.home/\n')
}

/** The worktree's repository reaches outside itself. */
export class GitLayoutError extends Error {}

/** Refuses a worktree whose repository could read another repository; `maxEntries` bounds the walk. */
export async function assertOwnRepository(worktree: string, maxEntries = 200_000): Promise<void> {
  const dotGit = join(worktree, '.git')
  const top = await lstat(dotGit).catch(() => undefined)
  if (!top?.isDirectory()) throw new GitLayoutError(`${worktree} has no .git directory of its own (a gitdir file or a link could name another repository)`)
  for (const name of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
    if (await lstat(join(dotGit, name)).then(() => true, () => false)) throw new GitLayoutError(`the repository in ${worktree} has .git/${name}, which reaches another repository`)
  }
  let seen = 0
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++seen > maxEntries) throw new GitLayoutError(`the repository in ${worktree} has more than ${maxEntries} entries in .git`)
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new GitLayoutError(`the repository in ${worktree} has a symbolic link at .git/${relative(dotGit, path)}`)
      if (entry.isDirectory()) await walk(path)
    }
  }
  await walk(dotGit)
}

/** A shell command line for `argv`, each word single-quoted. */
export function shellCommand(argv: readonly string[]): string {
  return argv.map(word => `'${word.replaceAll("'", "'\\''")}'`).join(' ')
}
