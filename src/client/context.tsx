/**
 * What every view reads (`D13`): the viewer's language and theme, the translator, the workbench's state (polled once for all views),
 * and the frame of a page: its sticky bar with breadcrumbs and actions, and the "not answering" note.
 */
import { createContext, useContext, useEffect, type ReactNode } from 'react'
import type { Links, StateView } from '../app/panel-api.ts'
import type { Resource } from './api.ts'
import { Icon } from './controls.tsx'
import { hm } from './format.ts'
import { translator, type Lang, type T } from './locales.ts'

export type Theme = 'system' | 'light' | 'dark'
export interface DashboardValue {
  readonly lang: Lang
  readonly t: T
  readonly theme: Theme
  setLang(lang: Lang): void
  setTheme(theme: Theme): void
  readonly state: Resource<StateView>
  readonly links: Links
  readonly people: Readonly<Record<string, string>>
}

export const DashboardContext = createContext<DashboardValue>({
  lang: 'en', t: translator('en'), theme: 'system', setLang: () => {}, setTheme: () => {},
  state: { data: undefined, error: undefined, at: undefined, reload: async () => {} }, links: {}, people: {},
})
export const useDashboard = (): DashboardValue => useContext(DashboardContext)

/** Whether the workbench stopped answering after it had answered once. */
export const notAnswering = (state: Resource<StateView>) => state.error !== undefined && state.data !== undefined

export function SwitchButtons() {
  const { t, lang, setLang, theme, setTheme } = useDashboard()
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
  return <div className="pills">
    <button type="button" className="pbtn" title={t('lang.label')} onClick={() => { setLang(lang === 'ru' ? 'en' : 'ru') }}>{t('lang.switch')}</button>
    <button type="button" className="pbtn" title={t('theme.label')} onClick={() => { setTheme(next[theme]) }}>{t(`theme.${theme}`)}</button>
  </div>
}

/** A page: the sticky bar (breadcrumbs and actions), the "not answering" note, and the content; `title` names it in the browser's tab. */
export function Page({ crumbs, actions, title, children }: { crumbs: ReactNode; actions?: ReactNode; title?: string; children: ReactNode }) {
  const { t, state } = useDashboard()
  const appName = t('appName')
  useEffect(() => { document.title = title ? `${title} · ${appName}` : appName }, [title, appName])
  return <>
    <div className="mtop"><div className="ws"><span className="logo">AW</span><span className="ws-name">{t('appName')}</span></div><SwitchButtons /></div>
    <div className="bar"><div className="crumbs">{crumbs}</div>{actions ? <div className="right">{actions}</div> : null}</div>
    <div className="content"><div className="wrap">
      {notAnswering(state) ? <div className="note k-bad" role="status"><Icon name="off" /><div><b>{t('down.title', { time: state.at ? hm(state.at) : '—' })}</b> {t('down.body')}</div></div> : null}
      {children}
    </div></div>
  </>
}
