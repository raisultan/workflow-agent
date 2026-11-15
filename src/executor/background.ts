/**
 * A worker's background work in DSH: the shell jobs its Session owns (`ctx.jobs`) and its subagents (`ctx.subagents`). They
 * keep the worker busy after its turn ended, and they stop with its stage attempt. A profile without either service has none.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** What this module uses of DSH's job registry: the jobs a Session can see, a wait for one and a kill. */
interface Jobs {
  list(caller: string): readonly { id: string; owner?: string; status: string; label?: string }[]
  wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<{ status: string }>
  kill(id: string, caller: string, reason?: string): unknown
}
/** What this module uses of DSH's subagents: a worker's subagents, and releasing them. */
interface Subagents {
  listChildren(parentSessionId: string): Promise<readonly { id: string }[]>
  drainChildren(parent: Agent, childIds: readonly string[]): Promise<void>
}
/** How long a stop waits for a killed job to end, collecting its end so the worker is not woken to hear of it. */
const KILL_WAIT_MS = 10_000
/** How long a release of subagents may take; it can hold up a shutdown, so DSH's own callers bound it too. */
const DRAIN_LIMIT_MS = 10_000

const registry = (ctx: Context): Jobs | undefined => ctx.get('jobs') as Jobs | undefined
const subagentsOf = (ctx: Context): Subagents | undefined => ctx.get('subagents') as Subagents | undefined
const running = (status: string) => status === 'running' || status === 'stopping'
/** The running jobs the Session owns. */
const owned = (jobs: Jobs, sessionId: string) => jobs.list(sessionId).filter(job => job.owner === sessionId && running(job.status))
/** `work`, or false once `signal` aborts or `ms` pass first. */
function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false)
  let stop!: () => void
  const stopped = new Promise<false>(resolve => { stop = () => { resolve(false) } })
  signal?.addEventListener('abort', stop, { once: true })
  const timer = ms === undefined ? undefined : setTimeout(stop, ms)
  timer?.unref?.()
  return Promise.race([work, stopped]).finally(() => { signal?.removeEventListener('abort', stop); clearTimeout(timer) })
}
/**
 * Kill the shell jobs the Session owns, collecting each end so the worker is not woken to hear of it. One failure stops none other.
 */
async function killJobs(ctx: Context, sessionId: string, reason: string): Promise<void> {
  const jobs = registry(ctx)
  const live = jobs ? owned(jobs, sessionId) : []
  const failures: unknown[] = []
  // The waits start before the kills, so each end counts as collected.
  const collected = live.map(job => jobs!.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => undefined))
  for (const job of live) try { jobs!.kill(job.id, sessionId, reason) } catch (error) { failures.push(error) }
  await Promise.all(collected)
  if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`)
}

/**
 * Release the worker's live subagents, for a bounded time. DSH delivers each one's end to the worker before the release
 * returns, which wakes it, so the worker's turn is cancelled after, keeping its inbox when `keepInbox`, and the stop ends
 * with that turn. Its Session still admits subagents.
 */
export async function stopSubagents(ctx: Context, agent: Agent, keepInbox = false): Promise<void> {
  const subagents = subagentsOf(ctx)
  if (!subagents) return
  // The catalog lists every subagent the Session had; one that ended has no agent.
  const live = (await subagents.listChildren(agent.id)).map(child => child.id).filter(id => ctx.agents.get(id as SessionId))
  if (!live.length) return
  try { await until(subagents.drainChildren(agent, live), undefined, DRAIN_LIMIT_MS) }
  finally {
    agent.cancel({ kind: 'user' }, { keepInbox })
    await until(agent.whenIdle(), undefined, DRAIN_LIMIT_MS)
  }
}

/**
 * Stop what a worker runs in the background once its stage attempt ends: kill its shell jobs and release its subagents (see
 * `stopSubagents`). A Session not loaded has no subagent at work. One failure stops nothing else.
 */
export async function stopBackground(ctx: Context, sessionId: string, reason: string, keepInbox = false): Promise<void> {
  const failures: unknown[] = []
  await killJobs(ctx, sessionId, reason).catch((error: unknown) => { failures.push(error) })
  const agent = ctx.agents.get(sessionId as SessionId)
  if (agent) await stopSubagents(ctx, agent, keepInbox).catch((error: unknown) => { failures.push(error) })
  if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`)
}
