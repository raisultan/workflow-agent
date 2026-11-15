/**
 * Reads a job worktree's toolchain files for the host's resolver (`T11.3`, `src/domain/toolchains.ts`). The worktree is the
 * repository's content, which anyone with commit access controls, and the host reads it outside any sandbox, so each file must be
 * a regular file directly in the worktree, at most `MAX_BYTES`:
 *
 * - a symbolic link is refused, both before opening (`lstat`) and when opening (`O_NOFOLLOW`), so a `.nvmrc` linked to
 *   `/proc/self/environ` or another job's file is never read;
 * - a FIFO or device is refused without blocking (`O_NONBLOCK`, then `fstat` on the opened file);
 * - a larger file is refused unread.
 *
 * A refused file is an error of the resolution, so the setup step blocks and says which file and why.
 */
import { constants, fstatSync, lstatSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLCHAIN_FILES, type ToolchainFile } from '../domain/toolchains.ts'

export const MAX_BYTES = 64 * 1024

export interface ToolchainFiles {
  readonly files: Partial<Record<ToolchainFile, string>>
  readonly errors: readonly string[]
}

export function readToolchainFiles(worktree: string): ToolchainFiles {
  const files: Partial<Record<ToolchainFile, string>> = {}
  const errors: string[] = []
  for (const name of TOOLCHAIN_FILES) {
    const read = readWorktreeFile(worktree, name)
    if (read && 'error' in read) errors.push(read.error)
    else if (read) files[name] = read.text
  }
  return { files, errors }
}

/**
 * One file directly in the worktree, by the rules above: its text, a reason it was refused, or `undefined` when there is none. Also
 * read for the Postgres major (`T12.4`).
 */
export function readWorktreeFile(worktree: string, name: string): { text: string } | { error: string } | undefined {
  const path = join(worktree, name)
  let stat
  try { stat = lstatSync(path) } catch { return undefined }
  if (stat.isSymbolicLink()) return { error: `${name} is a symbolic link; it must be a regular file` }
  if (!stat.isFile()) return { error: `${name} is not a regular file` }
  if (stat.size > MAX_BYTES) return { error: `${name} is larger than ${MAX_BYTES} bytes` }
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (!opened.isFile()) return { error: `${name} is not a regular file` }
    if (opened.size > MAX_BYTES) return { error: `${name} is larger than ${MAX_BYTES} bytes` }
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    for (let read = -1; read !== 0 && length <= MAX_BYTES;) { read = readSync(fd, buffer, length, buffer.length - length, null); length += read }
    if (length > MAX_BYTES) return { error: `${name} is larger than ${MAX_BYTES} bytes` }
    return { text: buffer.subarray(0, length).toString('utf8') }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { error: code === 'ELOOP' ? `${name} is a symbolic link; it must be a regular file` : `${name} could not be read (${code ?? 'error'})` }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
