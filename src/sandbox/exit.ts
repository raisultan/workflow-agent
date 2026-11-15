/** How the wrapper and the bridge end when their command ends, so DSH sees what the command did. */
import { constants } from 'node:os'

/** The shell's exit status for a command that ended with `code` or was killed by `signal`: `128 + n` for a signal. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal) return 128 + (constants.signals[signal] ?? 0)
  return code ?? 1
}

/**
 * Ends this process the way its command ended: re-raises the command's signal, and if this process survives it (Node ignores some
 * signals, `SIGPIPE` among them), exits with `128 + n` instead of falling through to 0.
 */
export function endLike(code: number | null, signal: NodeJS.Signals | null): void {
  if (!signal) process.exit(exitStatus(code, signal))
  process.removeAllListeners(signal)
  try { process.kill(process.pid, signal) } catch { /* fall through to the exit status */ }
  setImmediate(() => process.exit(exitStatus(code, signal)))
}
