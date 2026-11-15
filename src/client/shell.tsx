/**
 * The dashboard's shell (`D13`): the sidebar (views, repositories, the live indicator, language and theme), the phone's tab bar,
 * the state every view reads (polled once), the JSON drawer, and the view the address names.
 */
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useResource } from './api.ts'
import { Icon } from './controls.tsx'
import { DashboardContext, notAnswering, SwitchButtons, useDashboard, type DashboardValue, type Theme } from './context.tsx'
import { hm } from './format.ts'
import { JsonProvider } from './json.tsx'
import { langOf, translator, type Lang } from './locales.ts'
import { Link, matchPath, Router, useRouter } from './router.tsx'
import { groupOfJob } from './status.tsx'
import { VIEWS } from './views.ts'
import { repositoriesOf } from './views/jobs.tsx'

const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* private window */ } }

/** Applies the theme: `system` follows the viewer's setting. */
function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

function Live() {
  const { t, state } = useDashboard()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()) }, 1000); return () => { clearInterval(timer) } }, [])
  if (notAnswering(state)) return <span className="live k-bad"><i />{t('live.down', { time: state.at ? hm(state.at) : '—' })}</span>
  if (!state.at) return <span className="live k-mute"><i />{t('loading')}</span>
  return <span className="live k-ok"><i />{t('live.updated', { n: Math.max(0, Math.round((now - state.at) / 1000)) })}</span>
}

function current(path: string) {
  for (const view of VIEWS) { const params = matchPath(view.path, path); if (params) return { view, params } }
  return undefined
}

function Navigation() {
  const { t, state } = useDashboard()
  const { location, home } = useRouter()
  const found = current(location.path)
  const active = found ? found.view.parent ?? found.view.id : ''
  const repo = location.query.get('repo')
  const jobs = state.data?.jobs ?? []
  const waiting = jobs.filter(job => groupOfJob(job) === 'people').length
  const unwell = (!state.data?.demo && Object.values(state.data?.health.runtime ?? {}).some(entry => entry.state === 'error')) || notAnswering(state)
  const repositories = repositoriesOf(jobs)
  const nav = VIEWS.filter(view => view.nav)
  return <>
    <nav className="side" aria-label={t('appName')}>
      <div className="ws"><span className="logo">WA</span><div className="wsn"><div className="ws-name">{t('appName')}</div><div className="ws-sub">{t('readOnly')}</div></div></div>
      {nav.map(view => <Link key={view.id} to={view.path} className="nv" aria-current={active === view.id && !(view.id === 'jobs' && repo) ? 'page' : undefined}>
        <Icon name={view.nav!.icon} /><span>{t(view.nav!.label)}</span>
        {view.id === 'jobs' && waiting ? <span className="ct w">{waiting}</span> : null}
        {view.id === 'health' && unwell ? <span className="dt k-bad" /> : null}</Link>)}
      {repositories.length ? <><div className="sec">{t('nav.repositories')}</div>{repositories.map(([name, count]) =>
        <Link key={name} to={`/?repo=${encodeURIComponent(name)}`} className="nv" aria-current={active === 'jobs' && repo === name ? 'page' : undefined}>
          <span className="sq" /><span className="ell">{name}</span><span className="ct">{count}</span></Link>)}</> : null}
      <div className="sfoot"><Live /><SwitchButtons /></div>
    </nav>
    {/* The phone has no sidebar to choose a repository again, so its way back to the jobs keeps the one chosen (the list's own control clears it). */}
    <nav className="tabbar" aria-label={t('appName')}>{nav.map(view => <Link key={view.id} to={view.id === 'jobs' ? home : view.path} aria-current={active === view.id ? 'page' : undefined}>
      <Icon name={view.nav!.icon} size={19} />{view.id === 'health' && unwell ? <span className="dt k-bad" /> : null}<span>{t(view.nav!.label)}</span></Link>)}</nav>
  </>
}

/** Keeps a view that threw from taking the whole page with it: the navigation stays, and another address starts afresh. */
class Boundary extends Component<{ path: string; title: string; children: ReactNode }, { error?: Error; path?: string }> {
  override state: { error?: Error; path?: string } = {}
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) } }
  static getDerivedStateFromProps(props: { path: string }, state: { error?: Error; path?: string }) {
    return state.path === props.path ? null : { path: props.path, error: undefined }
  }
  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return <div className="content"><div className="wrap"><div className="note k-bad" role="alert"><Icon name="alert" />
      <div><b>{this.props.title}</b> <span className="mono">{error.message}</span></div></div></div></div>
  }
}

function Main() {
  const { t } = useDashboard()
  const { location } = useRouter()
  const found = current(location.path)
  // A view's page names itself in the tab; an address with no view has only the name.
  const missing = !found
  useEffect(() => { if (missing) document.title = t('appName') }, [missing, t])
  return <main className="main">{found ? <Boundary path={location.path} title={t('error.title')}><found.view.Component params={found.params} /></Boundary>
    : <div className="content"><p>{t('notFound')}</p></div>}</main>
}

export function App() {
  const state = useResource('GET state')
  const [lang, setLangState] = useState<Lang | undefined>(() => { const value = stored('awb.lang'); return value ? langOf(value) : undefined })
  const [theme, setThemeState] = useState<Theme>(() => { const value = stored('awb.theme'); return value === 'light' || value === 'dark' ? value : 'system' })
  const effective = lang ?? langOf(state.data?.locale ?? (typeof navigator !== 'undefined' && navigator.language.startsWith('ru') ? 'ru' : 'en'))
  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => { document.documentElement.lang = effective }, [effective])
  const value = useMemo<DashboardValue>(() => ({
    lang: effective, t: translator(effective), theme, state, links: state.data?.links ?? {}, people: state.data?.people ?? {},
    setLang: next => { setLangState(next); store('awb.lang', next) },
    setTheme: next => { setThemeState(next); store('awb.theme', next) },
  }), [effective, theme, state])
  return <DashboardContext.Provider value={value}>
    <Router><JsonProvider t={value.t}><div className="app"><Navigation /><Main /></div></JsonProvider></Router>
  </DashboardContext.Provider>
}
