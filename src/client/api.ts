/**
 * The dashboard's client for its read-only API (`D13`): typed by `PanelApi`, marked with `x-workbench-dashboard: 1` (the server
 * refuses requests without it), conditional on the last `ETag`, and polled while the page is visible.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PanelApi } from '../app/panel-api.ts'

/** A failed request: its HTTP status, or 0 when the workbench did not answer (a restart). */
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

/** The last answer per path, for `ETag`s; the 50 most recently used are kept. */
const cache = new Map<string, { etag: string; body: unknown }>()
const CACHED = 50

/** The URL path of a route with its parameters. */
export function pathOf(route: keyof PanelApi, params: Record<string, string> = {}): string {
  return `/api/${route.slice(4).split('/').map(part => part.startsWith(':') ? encodeURIComponent(params[part.slice(1)] ?? '') : part).join('/')}`
}

/** Calls a route; an unchanged answer (`304`) returns the cached body. */
export async function get<K extends keyof PanelApi>(route: K, params: Record<string, string> = {}, fetchImpl: typeof fetch = fetch): Promise<PanelApi[K]> {
  const path = pathOf(route, params)
  const cached = cache.get(path)
  let response: Response
  try {
    response = await fetchImpl(path, { headers: { 'x-workbench-dashboard': '1', ...cached ? { 'if-none-match': cached.etag } : {} } })
  } catch {
    throw new ApiError('The workbench is not answering', 0)
  }
  if (response.status === 304 && cached) { cache.delete(path); cache.set(path, cached); return cached.body as PanelApi[K] }
  let body: unknown, parsed = true
  try { body = await response.json() as unknown } catch { parsed = false }
  if (!response.ok) throw new ApiError((body as { error?: string } | undefined)?.error ?? `Request failed (${response.status})`, response.status)
  // A proxy's sign-in page or an error page answers 200 too; it is no data.
  if (!parsed) throw new ApiError('The answer is not the workbench\'s (not JSON)', response.status)
  const etag = response.headers.get('etag')
  if (etag) {
    cache.delete(path)
    cache.set(path, { etag, body })
    if (cache.size > CACHED) cache.delete(cache.keys().next().value!)
  }
  return body as PanelApi[K]
}

export interface Resource<T> {
  readonly data: T | undefined
  readonly error: Error | undefined
  /** When the last answer arrived. */
  readonly at: number | undefined
  reload(): Promise<void>
}

/**
 * Loads a route now and every `everyMs` while the page is visible (`0`: once); keeps the last good data while a reload fails. A tick
 * is skipped while a request for the same address is on its way, so slow answers do not pile up or arrive out of order.
 */
export function useResource<K extends keyof PanelApi>(route: K | null, params: Record<string, string> = {}, everyMs = 3000): Resource<PanelApi[K]> {
  const [state, setState] = useState<{ data?: PanelApi[K]; error?: Error; at?: number; key?: string }>({})
  const key = route ? pathOf(route, params) : ''
  const latest = useRef({ route, params, key })
  latest.current = { route, params, key }
  const pending = useRef(new Set<string>())
  const reload = useCallback(async () => {
    const { route: current, params: currentParams } = latest.current
    if (!current) return
    const requested = pathOf(current, currentParams)
    if (pending.current.has(requested)) return
    pending.current.add(requested)
    // An answer for an address the page has since left is dropped, so it cannot replace the current one.
    try {
      const data = await get(current, currentParams)
      if (latest.current.key === requested) setState({ data, at: Date.now(), key: requested })
    } catch (failure) {
      if (latest.current.key === requested) setState(previous => ({ ...previous.key === requested ? previous : {}, key: requested, error: failure instanceof Error ? failure : new Error(String(failure)) }))
    } finally {
      pending.current.delete(requested)
    }
  }, [])
  useEffect(() => {
    if (!route) return undefined
    void reload()
    if (everyMs <= 0) return undefined
    const tick = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void reload() }
    const timer = setInterval(tick, everyMs)
    const onVisible = () => { if (document.visibilityState === 'visible') void reload() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [key, everyMs, reload]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = state.key === key
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, at: current ? state.at : undefined, reload }
}
