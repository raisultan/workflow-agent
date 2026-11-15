/**
 * Health (`D13`): are the connections, the effect queues, the timers and the kernel well. A card per runtime and connector entry,
 * the queues with zero counts dimmed, the counts, and the kernel's last dispatch error.
 */
import type { ReactNode } from 'react'
import { Tag, type Tone } from '../controls.tsx'
import { Page, useDashboard } from '../context.tsx'
import { clock } from '../format.ts'
import { known } from '../locales.ts'
import { statusLabel } from '../status.tsx'

const TONE: Record<string, Tone> = { ready: 'ok', error: 'bad', starting: 'wait', paused: 'mute' }

export function HealthView() {
  const { t, lang, state } = useDashboard()
  const health = state.data?.health
  const cell = (value: number, warn = false): ReactNode => <td className={`n${value ? (warn ? ' warn' : '') : ' zero'}`}>{value || '·'}</td>
  const counts = (record: Readonly<Record<string, number>>, label: (key: string) => string) => Object.entries(record).map(([key, n]) => `${label(key)} ${n}`).join(' · ') || '—'
  return <Page crumbs={<span>{t('nav.health')}</span>}>
    {!health ? <p className="t3">{state.error ? state.error.message : t('loading')}</p> : <>
      <h3 className="h-sec">{t('health.connections')}</h3>
      <div className="cards">{Object.entries(health.runtime).map(([name, entry]) => {
        return <div key={name} className="panel hc"><div className="top"><span className="nm">{name}</span>
          <Tag tone={TONE[entry.state] ?? 'mute'}>{known(t, `health.${entry.state}`, entry.state)}</Tag></div>
          <div className="t2 small">{entry.detail || '—'}</div>{entry.at ? <div className="mono t3">{clock(Date.parse(entry.at), lang)}</div> : null}</div>
      })}</div>
      <h3 className="h-sec">{t('health.queues')}</h3>
      <div className="panel tbl"><table><thead><tr><th /><th className="n">{t('health.running')}</th><th className="n">{t('health.waiting')}</th><th className="n">{t('health.retrying')}</th>
        <th className="n">{t('health.reconciling')}</th><th>{t('health.lastError')}</th></tr></thead>
        <tbody>{Object.entries(health.effects).map(([kind, queue]) => <tr key={kind}><td className="mono ink">{kind}</td>{cell(queue.running)}{cell(queue.waiting)}
          {cell(queue.retrying, true)}{cell(queue.unknown, true)}<td className="t2 small">{queue.lastError ?? <span className="t3">—</span>}</td></tr>)}</tbody></table></div>
      <h3 className="h-sec">{t('health.counts')}</h3>
      <div className="panel kvp">
        <div className="k">{t('health.jobs')}</div><div className="mono">{counts(health.jobs, key => statusLabel(t, key).toLowerCase())}</div>
        <div className="k">{t('health.inbox')}</div><div className="mono">{counts(health.inbox, key => known(t, `inbox.${key}`, key).toLowerCase())}</div>
        <div className="k">{t('health.timers')}</div><div className="mono">{health.timers.armed}{health.timers.nextDue ? ` · ${t('health.next', { time: clock(health.timers.nextDue, lang) })}` : ''}</div>
        <div className="k">{t('health.kernelError')}</div><div className={health.kernelError ? 'mono bad' : 't3'}>{health.kernelError ?? t('health.none')}</div>
      </div>
    </>}
  </Page>
}
