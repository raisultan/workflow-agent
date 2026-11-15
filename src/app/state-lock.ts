/** The state directory lock that keeps a second runtime off the same `stateDir`. */
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'

/** A lock not refreshed for this long belongs to a process that is gone (proper-lockfile refreshes it every half of it). */
export const LOCK_STALE_MS = 30_000

/**
 * Locks `stateDir` for this process. The lock lives inside `stateDir`, because its parent may be read-only (the Compose image
 * mounts only the state directory as a volume). A lock that a stopped process left behind (a container restart, a kill) still
 * looks fresh for up to `staleMs`: wait that out rather than fail for good, and fail only while another process keeps it fresh.
 * @returns the release function.
 * @throws ELOCKED when another live process still holds the lock after `staleMs + marginMs`.
 */
export function lockStateDir(stateDir: string, onCompromised: (error: Error) => void, staleMs = LOCK_STALE_MS, marginMs = 5_000): () => void {
  const deadline = Date.now() + staleMs + marginMs
  for (;;) {
    try {
      return lockSync(stateDir, { stale: staleMs, onCompromised, lockfilePath: join(stateDir, '.lock') })
    } catch (error) {
      if ((error as { code?: string }).code !== 'ELOCKED' || Date.now() >= deadline) throw error
      // Synchronous by necessity: the runtime opens its Store right after locking, in its constructor.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
  }
}
