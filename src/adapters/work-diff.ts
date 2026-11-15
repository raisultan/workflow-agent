/**
 * The diff of a job's work (`T10.1`), for the checks that read it: the test-integrity check and the clean-context review.
 *
 * The worktree is the agent's: its `.git/config`, its hooks and the `.gitattributes` it commits can name commands (textconv and
 * external diff drivers, `core.fsmonitor`), and its `HOME` holds a `.gitconfig` the agent can write. So git never runs in the
 * worktree here. As `git-transport` does for a push, the work is fetched into a fresh host-owned bare repository (`upload-pack`
 * runs no hooks and takes no worker-set command from repository config), and the diff runs there with external diffs and textconv
 * off, no global or system git configuration, and a scratch `HOME`.
 *
 * The base is the commit the host cloned the job from (`T10.1`), recorded before any stage ran, never a ref the agent can move.
 * The diff is `base...head`: what the work changed since it branched off, without changes merged in from the target branch.
 *
 * Final review (`P10`):
 * - The worktree side of the fetch (`upload-pack`) runs in the job's own sandbox when the host gives `uploadPack` (host profile
 *   `fetch`: the worktree read-only, every other repository, the state and `$DSH_HOME` masked), so alternates, `commondir` or a
 *   symbolic link in `.git` cannot read another job's repository. `assertOwnRepository` refuses those layouts first, cheaply. Only
 *   `HEAD` is fetched, and the pushed commit when `HEAD` no longer contains it; never every branch.
 * - The diff is taken with `--text`, so a NUL byte cannot hide a file's lines from the rules and the review. Files git would call
 *   binary are still marked (`binary`), and a binary test or source file is a finding of its own (`test-integrity.ts`).
 * - A diff over the output limit, or a fetch or diff that runs out of time, is the agent's doing (the size of its change), so it is
 *   a `WorkDiffError` too: the check fails and says why. What the fetch writes to the host's temporary directory is bounded only by
 *   the time limit.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertOwnRepository, GitLayoutError } from '../infra/git-layout.ts'

const run = promisify(execFile)

/** One changed file. `path` is the new path (the old one for a deletion); `from` is the old path of a rename. */
export interface DiffFile {
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed'
  readonly path: string
  readonly from?: string
  /** Added and removed lines, each with its line number on its side of the diff. */
  readonly added: readonly { line: number; text: string }[]
  readonly removed: readonly { line: number; text: string }[]
  readonly binary: boolean
}

export interface WorkDiff {
  readonly base: string
  readonly head: string
  readonly files: readonly DiffFile[]
  /** The unified diff text. */
  readonly patch: string
  /** Every file path in the work's commit. */
  readonly tree: ReadonlySet<string>
}

/**
 * The work could not be diffed against its base because of the work itself: its history does not contain the base, the commit is
 * missing, its `.git` is not a plain directory, or the change is too large to check.
 */
export class WorkDiffError extends Error {}

/** Diffs the worktree's `HEAD` (or `commit`, which must be in its history) against `base`, in a host-owned bare repository. */
export async function workDiff(options: { worktree: string; base: string; commit?: string; git?: string; maxBytes?: number; timeoutMs?: number
  /** Runs the worktree's `upload-pack` in the job's sandbox: the command git starts, and the variables the sandbox wrapper reads. */
  uploadPack?: { command: string; env: Readonly<Record<string, string>> } }): Promise<WorkDiff> {
  const git = options.git ?? 'git'
  const scratch = await mkdtemp(join(tmpdir(), 'awb-diff-'))
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const exec = async (args: string[], extraEnv: Readonly<Record<string, string>> = {}): Promise<string> => {
    const { stdout } = await run(git, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', ...args],
      { cwd: scratch, env: { ...env, ...extraEnv }, timeout: options.timeoutMs ?? 120_000, maxBuffer: options.maxBytes ?? 64 << 20 })
    return stdout
  }
  // A fetch from the worktree: its upload-pack confined when the host gives one. A failure is the work's layout, unless the sandbox
  // itself refused to run (the environment).
  const fetch = async (args: string[]): Promise<void> => {
    const pack = options.uploadPack ? [`--upload-pack=${options.uploadPack.command}`] : []
    try {
      await exec(['fetch', '--quiet', '--no-tags', ...pack, options.worktree, ...args], options.uploadPack?.env)
    } catch (error) {
      const failure = error as { stderr?: string; code?: string; killed?: boolean }
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || failure.killed) throw error
      if (/workbench-sandbox: |bwrap: /u.test(failure.stderr ?? '')) throw error
      throw new WorkDiffError(`the work could not be fetched from its worktree in its sandbox: ${(failure.stderr ?? String(error)).trim().slice(0, 300)}`)
    }
  }
  try {
    await assertOwnRepository(options.worktree).catch(error => { throw error instanceof GitLayoutError ? new WorkDiffError(error.message) : error })
    await exec(['init', '--quiet', '--bare', scratch])
    await fetch(['+HEAD:refs/work/head'])
    const verify = (ref: string) => exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(out => out.trim(), () => undefined)
    // The pushed commit, if HEAD has moved past it or away from it: fetched by its id, and nothing else.
    if (options.commit && /^[0-9a-f]{40}$/u.test(options.commit) && !await verify(options.commit)) {
      // upload-pack reads `-c` settings through the environment git passes it, so this reaches the confined upload-pack too.
      await exec(['-c', 'uploadpack.allowAnySHA1InWant=true', 'fetch', '--quiet', '--no-tags', ...options.uploadPack ? [`--upload-pack=${options.uploadPack.command}`] : [],
        options.worktree, `+${options.commit}:refs/work/pushed`], options.uploadPack?.env).catch(() => undefined)
    }
    const head = await verify(options.commit ?? 'refs/work/head')
    if (!head) throw new WorkDiffError(`commit ${options.commit ?? 'HEAD'} is not in the job's worktree`)
    if (!await verify(options.base)) throw new WorkDiffError(`the work does not contain the commit the job started from (${options.base.slice(0, 12)})`)
    const ancestor = await exec(['merge-base', '--is-ancestor', options.base, head]).then(() => true, () => false)
    if (!ancestor) throw new WorkDiffError(`the work is not based on the commit the job started from (${options.base.slice(0, 12)}): its history was rewritten`)
    const range = `${options.base}...${head}`
    const patch = await exec(['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--unified=3', range])
    // Without --text, numstat shows `-` for the files git calls binary.
    const binary = new Set((await exec(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', range])).split('\0')
      .flatMap(entry => /^-\t-\t(.+)$/su.exec(entry)?.[1] ?? []))
    const tree = new Set((await exec(['ls-tree', '-r', '-z', '--name-only', head])).split('\0').filter(Boolean))
    return { base: options.base, head, files: parseUnifiedDiff(patch).map(file => binary.has(file.path) || (file.from && binary.has(file.from)) ? { ...file, binary: true } : file),
      patch, tree }
  } catch (error) {
    if (error instanceof WorkDiffError) throw error
    const failure = error as { stderr?: string; message?: string; code?: string; killed?: boolean }
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new WorkDiffError(`the change is too large to check: its diff is over ${Math.round((options.maxBytes ?? 64 << 20) / (1 << 20))} MiB`)
    if (failure.killed) throw new WorkDiffError(`the change is too large to check: git did not finish within ${Math.round((options.timeoutMs ?? 120_000) / 1000)} s`)
    throw new Error(`git failed: ${(failure.stderr || failure.message || String(error)).trim()}`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Reads a path as git writes it in a diff header: plain, or C-quoted when it holds special characters. */
function headerPath(text: string): string {
  const raw = text.replace(/\t$/u, '')
  if (!raw.startsWith('"')) return raw
  return raw.slice(1, -1).replace(/\\([\\"tnr]|[0-7]{3})/gu, (_, code: string) =>
    code.length === 3 ? String.fromCharCode(parseInt(code, 8)) : ({ t: '\t', n: '\n', r: '\r' } as Record<string, string>)[code] ?? code)
}

/**
 * The path in a `diff --git` header. When both sides name the same path, the header is `a/P b/P`, which splits evenly even when P
 * itself contains ` b/`; a rename's real paths come from its `rename from`/`rename to` lines, and content changes from `---`/`+++`.
 */
function headerPathOf(rest: string): string {
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest.slice(0, half) === `a/${rest.slice(half + 3)}` && rest.slice(half, half + 3) === ' b/') return rest.slice(half + 3)
  const quoted = /^"a\/(.*)" "b\/(.*)"$/u.exec(rest)
  if (quoted) return headerPath(`"${quoted[2]}"`)
  return /^a\/.* b\/(.*)$/u.exec(rest)?.[1] ?? rest
}

/** One line of a unified diff as the shared walk reads it: a file's start and header lines, a hunk header, or a hunk line. */
type DiffStep =
  | { readonly kind: 'file'; readonly raw: string; readonly path: string }
  | { readonly kind: 'header'; readonly raw: string }
  | { readonly kind: 'hunk'; readonly raw: string; readonly old: number; readonly new: number }
  | { readonly kind: 'added'; readonly raw: string; readonly new: number; readonly text: string }
  | { readonly kind: 'removed'; readonly raw: string; readonly old: number; readonly text: string }
  | { readonly kind: 'context'; readonly raw: string; readonly old: number; readonly new: number; readonly text: string }
  | { readonly kind: 'other'; readonly raw: string }

/** Walks a unified diff line by line, numbering hunk lines on each side; `parseUnifiedDiff` and `annotatePatch` share it. */
function* walkDiff(patch: string): Generator<DiffStep> {
  let oldLine = 0, newLine = 0, inHunk = false, inFile = false
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) { inHunk = false; inFile = true; yield { kind: 'file', raw, path: headerPathOf(raw.slice(11)) }; continue }
    if (!inFile) { yield { kind: 'other', raw }; continue }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw)
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; yield { kind: 'hunk', raw, old: oldLine, new: newLine }; continue }
    if (!inHunk) { yield { kind: 'header', raw }; continue }
    if (raw.startsWith('+')) yield { kind: 'added', raw, new: newLine++, text: raw.slice(1) }
    else if (raw.startsWith('-')) yield { kind: 'removed', raw, old: oldLine++, text: raw.slice(1) }
    else if (raw.startsWith(' ')) yield { kind: 'context', raw, old: oldLine++, new: newLine++, text: raw.slice(1) }
    else yield { kind: 'other', raw }
  }
}

/** Parses `git diff` output into files with their added and removed lines. */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: { status: DiffFile['status']; path: string; from?: string; added: { line: number; text: string }[];
    removed: { line: number; text: string }[]; binary: boolean; oldPath?: string; newPath?: string } | undefined
  const flush = () => {
    if (!current) return
    const path = current.status === 'deleted' ? current.oldPath ?? current.path : current.newPath ?? current.path
    files.push({ status: current.status, path, ...current.status === 'renamed' && current.from ? { from: current.from } : {},
      added: current.added, removed: current.removed, binary: current.binary })
  }
  for (const step of walkDiff(patch)) {
    if (step.kind === 'file') { flush(); current = { status: 'modified', path: step.path, added: [], removed: [], binary: false }; continue }
    if (!current) continue
    if (step.kind === 'header') {
      const line = step.raw
      if (line.startsWith('new file mode')) current.status = 'added'
      else if (line.startsWith('deleted file mode')) current.status = 'deleted'
      else if (line.startsWith('rename from ')) { current.status = 'renamed'; current.from = headerPath(line.slice(12)) }
      else if (line.startsWith('rename to ')) current.newPath = headerPath(line.slice(10))
      else if (line.startsWith('--- ')) { if (line !== '--- /dev/null') current.oldPath = headerPath(line.slice(4)).replace(/^a\//u, '') }
      else if (line.startsWith('+++ ')) { if (line !== '+++ /dev/null') current.newPath = headerPath(line.slice(4)).replace(/^b\//u, '') }
      else if (line.startsWith('Binary files ')) current.binary = true
    } else if (step.kind === 'added') current.added.push({ line: step.new, text: step.text })
    else if (step.kind === 'removed') current.removed.push({ line: step.old, text: step.text })
  }
  flush()
  return files
}

/** One side of a file in an annotated diff: its lines by number, and which of them the change added or removed. */
export interface AnnotatedSide { readonly lines: ReadonlyMap<number, string>; readonly changed: ReadonlySet<number> }
/** One hunk line of a file in diff order (`P16`): its kind, its number on each side it is on, its hunk, and its text. */
export interface DiffRow { readonly kind: 'added' | 'removed' | 'context'; readonly old?: number; readonly new?: number; readonly hunk: number; readonly text: string }
/** A diff with each hunk line numbered for the reviewer (`P16`), and its lines by file and side for checking what it quotes. */
export interface AnnotatedDiff {
  /** The diff with `[NEW:m] `, `[OLD:n] ` or `[OLD:n,NEW:m] ` before each hunk line; file and hunk headers as they are. */
  readonly text: string
  /** Per path (a rename under both), the old and new sides, and the hunk lines in diff order. */
  readonly files: ReadonlyMap<string, { readonly old: AnnotatedSide; readonly new: AnnotatedSide; readonly rows: readonly DiffRow[] }>
}

/**
 * Annotates a unified diff for the clean-context review (`P16`, adapted from `review-pr`'s annotation contract): each hunk line
 * carries its number on each side it is on, so the reviewer cites real lines; the host reads the same numbering back to check them.
 */
export function annotatePatch(patch: string): AnnotatedDiff {
  type Sides = { old: { lines: Map<number, string>; changed: Set<number> }; new: { lines: Map<number, string>; changed: Set<number> }; rows: DiffRow[] }
  const files = new Map<string, Sides>()
  const parsed = parseUnifiedDiff(patch)
  let index = -1, hunk = 0
  let current: Sides | undefined
  const out: string[] = []
  for (const step of walkDiff(patch)) {
    switch (step.kind) {
      case 'file': {
        const file = parsed[++index]
        current = { old: { lines: new Map(), changed: new Set() }, new: { lines: new Map(), changed: new Set() }, rows: [] }
        if (file) { files.set(file.path, current); if (file.from) files.set(file.from, current) }
        out.push(step.raw)
        break
      }
      case 'hunk': hunk++; out.push(step.raw); break
      case 'added': current?.new.lines.set(step.new, step.text); current?.new.changed.add(step.new); current?.rows.push({ kind: 'added', new: step.new, hunk, text: step.text })
        out.push(`[NEW:${step.new}] ${step.raw}`); break
      case 'removed': current?.old.lines.set(step.old, step.text); current?.old.changed.add(step.old); current?.rows.push({ kind: 'removed', old: step.old, hunk, text: step.text })
        out.push(`[OLD:${step.old}] ${step.raw}`); break
      case 'context': current?.old.lines.set(step.old, step.text); current?.new.lines.set(step.new, step.text)
        current?.rows.push({ kind: 'context', old: step.old, new: step.new, hunk, text: step.text }); out.push(`[OLD:${step.old},NEW:${step.new}] ${step.raw}`); break
      default: out.push(step.raw)
    }
  }
  return { text: out.join('\n'), files }
}
