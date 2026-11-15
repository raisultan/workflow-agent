/**
 * The dashboard's router (`D13`): the History API, so every view and every job has its own address (`/jobs/<id>/<tab>`), and
 * reload, back and forward work. The server answers every page path with the page.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'

export interface Location { readonly path: string; readonly query: URLSearchParams }
interface RouterValue {
  readonly location: Location
  /** The jobs list as the viewer left it: `/` with its repository, so a way back to the list from another view keeps that filter. */
  readonly home: string
  navigate(to: string, options?: { replace?: boolean }): void
}

const RouterContext = createContext<RouterValue>({ location: { path: '/', query: new URLSearchParams() }, home: '/', navigate: () => {} })

const read = (): Location => ({ path: window.location.pathname, query: new URLSearchParams(window.location.search) })

export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Location>(read)
  useEffect(() => {
    const onPop = () => { setLocation(read()) }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop) }
  }, [])
  const navigate = useCallback((to: string, { replace = false } = {}) => {
    if (to === `${window.location.pathname}${window.location.search}`) return
    window.history[replace ? 'replaceState' : 'pushState'](null, '', to)
    setLocation(read())
    if (!replace) window.scrollTo?.(0, 0)
  }, [])
  // The list's repository is in its address alone; another view's address has none, so the last one is kept here until the list changes it.
  const repo = useRef<string | null>(null)
  if (location.path === '/') repo.current = location.query.get('repo')
  const home = repo.current ? `/?repo=${encodeURIComponent(repo.current)}` : '/'
  const value = useMemo(() => ({ location, home, navigate }), [location, home, navigate])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export const useRouter = (): RouterValue => useContext(RouterContext)

/** Matches `pattern` (`/jobs/:id/:tab?`) against a path; returns the parameters, or undefined. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const parts = pattern.split('/').filter(Boolean), segments = path.split('/').filter(Boolean)
  const params: Record<string, string> = {}
  for (let index = 0; index < Math.max(parts.length, segments.length); index++) {
    const part = parts[index], segment = segments[index]
    if (part === undefined) return undefined
    const optional = part.endsWith('?'), name = part.replace(/^:|\?$/gu, '')
    if (segment === undefined) { if (optional) continue; return undefined }
    if (part.startsWith(':')) { try { params[name] = decodeURIComponent(segment) } catch { return undefined } } else if (part !== segment) return undefined
  }
  return params
}

/** A link inside the dashboard: a real `<a>` (open in a new tab works), navigating in place on a plain click. */
export function Link({ to, children, onClick, ...rest }: { to: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const { navigate } = useRouter()
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }
  return <a href={to} onClick={click} {...rest}>{children}</a>
}
