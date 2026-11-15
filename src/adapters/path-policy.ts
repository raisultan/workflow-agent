/**
 * The path policy on DSH's file tools (`T10.3`, `A15`). DSH's `read`, `read_image`, `grep` and `glob` run in the DSH process, outside
 * any sandbox (`dsh-fs-sandbox` confines only writes, and `grep`/`glob` spawn ripgrep unconfined), so a bwrap mask cannot stop them
 * reading the credential store, the state database, another job's worktree or `/proc/self/environ` (the DSH process's own
 * environment, which holds every connector token). This policy is a tool guard on each stage session: before a file tool runs,
 * the path it names is resolved against the session's working directory, its symbolic links are resolved, and it must lie inside:
 *
 * - the job's worktree, for every file tool;
 * - for the reading tools only, also the skill directories and the session's own saved tool output (DSH tells the model where it
 *   saved a long result, under `<tmp>/dsh-spill-*\/session-<hash of the session id>`).
 *
 * Anything else is refused before the tool runs, and `apply_patch` (whose paths are inside its patch text) is refused outright.
 *
 * Known limit: the check and the tool's own open are two steps. A background job of the same session that swaps a checked path
 * for a symbolic link in between could win that race; closing it needs the reads themselves confined (a follow-up).
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The file tools and the argument that names their path; `undefined` means the session's working directory. */
const READS: Readonly<Record<string, string>> = { read: 'file_path', read_image: 'file_path', grep: 'path', glob: 'path' }
const WRITES: Readonly<Record<string, string>> = { write: 'file_path', edit: 'file_path' }

export interface PathScope {
  /** The job's worktree: the session's working directory. */
  readonly worktree: string
  readonly sessionId: string
  /** Directories of skills the stage may read. */
  readonly skillRoots: readonly string[]
  /** The host's temporary directory (where DSH saves long output); `os.tmpdir()` by default. */
  readonly tmp?: string
}

/** A path with its symbolic links resolved; for a path that does not exist yet, its nearest existing ancestor's, plus the rest. */
export function canonical(path: string): string {
  let current = resolve(path)
  const rest: string[] = []
  for (;;) {
    try { return join(realpathSync(current), ...rest.reverse()) } catch { /* not there: try the parent */ }
    const parent = dirname(current)
    if (parent === current) return resolve(path)
    rest.push(basename(current))
    current = parent
  }
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** The guard for one session: the refusal for a tool call, or `undefined` when it may run. */
export function pathGuard(scope: PathScope): (execution: { readonly name: string; readonly arguments: unknown }) => string | undefined {
  const worktree = canonical(scope.worktree)
  const spill = new RegExp(`^${escape(canonical(scope.tmp ?? tmpdir()))}/dsh-spill-[^/]+/session-${createHash('sha256').update(scope.sessionId).digest('hex').slice(0, 12)}(?:/|$)`, 'u')
  const skills = scope.skillRoots.map(root => canonical(root))
  return execution => {
    if (execution.name === 'apply_patch') return 'apply_patch is not available in workbench stages; use edit or write'
    const read = READS[execution.name], write = WRITES[execution.name]
    const key = read ?? write
    if (!key) return undefined
    const raw = (execution.arguments as Record<string, unknown> | undefined)?.[key]
    if (raw === undefined || raw === null || raw === '') return undefined
    if (typeof raw !== 'string' || raw.includes('\0')) return `${execution.name}: the path is not valid`
    const path = canonical(isAbsolute(raw) ? raw : join(worktree, raw))
    if (inside(path, worktree)) return undefined
    if (read && (spill.test(path) || skills.some(root => inside(path, root)))) return undefined
    return `${execution.name}: ${raw} is outside this job's worktree. File tools may ${read ? 'read only the job\'s worktree, the skills and this session\'s saved tool output' : 'write only inside the job\'s worktree'}.`
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
