/**
 * A job's other tabs (`D13`): Conversations (each thread's messages, in and out), Artifacts (each revision, rendered), Network (the
 * egress proxy's decisions, refusals first) and Details (the run manifest, then every event and effect with its JSON).
 */
import { Fragment, useState } from 'react'
import type { JobDetail } from '../../app/panel-api.ts'
import { Avatar, CopyButton, Tag, ThreadLink } from '../controls.tsx'
import { useDashboard } from '../context.tsx'
import { clock, person, thread } from '../format.ts'
import { JsonButton } from '../json.tsx'
import type { Key } from '../locales.ts'
import { useNewestFirst } from './activity.tsx'
import { Markdown } from './markdown.tsx'

export function ConversationsTab({ detail }: { detail: JobDetail }) {
  const { t, lang, links, people } = useDashboard()
  const [newest] = useNewestFirst()
  const gateThread = detail.job.waiting?.thread ?? detail.job.gateThread
  const roles = new Map(detail.state.bindings.map(binding => [binding.threadKey, binding.role]))
  if (detail.state.chatThread) roles.set(detail.state.chatThread, 'chat' as never)
  const messages = [
    ...detail.communication.filter(message => message.threadKey).map(message => ({ key: `in${message.id}`, at: message.receivedAt, thread: message.threadKey!,
      who: person(message.actor, people), out: false, text: message.text ?? '', bot: !message.human, redrawn: false, json: message })),
    ...detail.outbound.map(post => ({ key: `out${post.id}`, at: post.at, thread: post.threadKey, who: { name: '@workbench', known: true }, out: true, text: post.text ?? `(${post.kind})`, bot: false, redrawn: post.status === 'succeeded' && !post.recorded, json: post })),
  ]
  const threads = [...new Set(messages.map(message => message.thread))]
  if (threads.length === 0) return <p className="t3">{t('talk.empty')}</p>
  return <>{threads.map(key => {
    const list = messages.filter(message => message.thread === key).sort((a, b) => newest ? b.at - a.at : a.at - b.at)
    const role = roles.get(key)
    return <div key={key} className="panel thread">
      <div className="thread-h"><ThreadLink info={thread(key, links, lang)} />{role ? <span className="role">{t(`role.${role}` as Key)}</span> : null}
        {key === gateThread ? <span className="role g">{t('role.gate')}</span> : null}<span className="t3 mono end">{list.length}</span></div>
      <div className="msgs">{list.map(message => <div key={message.key} className={`msg${message.out ? ' out' : ''}`}>
        <Avatar name={message.who.name} workbench={message.out} known={message.who.known} />
        <div className="mbody"><div className="mh"><span className="who">{message.who.name}</span>{message.bot ? <span className="bot">{t('inbox.bot')}</span> : null}
          {message.redrawn ? <span className="bot" title={t('post.redrawnWhy')}>{t('post.redrawn')}</span> : null}
          <span className="mono">{clock(message.at, lang)}</span><span className="end"><JsonButton title={`${message.out ? 'post' : 'message'} · ${clock(message.at, lang)}`} value={message.json} /></span></div>
          {message.out ? <Markdown text={message.text} className="mb doc post" /> : <div className="mb">{message.text}</div>}</div>
      </div>)}</div>
    </div>
  })}</>
}

export function ArtifactsTab({ detail }: { detail: JobDetail }) {
  const { t } = useDashboard()
  const artifacts = [...detail.artifacts].reverse()
  // By digest, not by place: a new revision arriving with a poll does not move the reader to another one.
  const [selected, setSelected] = useState<string>()
  if (artifacts.length === 0) return <p className="t3">{t('art.empty')}</p>
  const artifact = artifacts.find(item => item.digest === selected) ?? artifacts[0]!
  return <div className="panel art">
    <div className="art-l" role="group" aria-label={t('tab.artifacts')}>{artifacts.map(item => <button key={item.digest} type="button" aria-pressed={item === artifact}
      onClick={() => { setSelected(item.digest) }}><span className="nm">{item.title ?? item.kind}</span><span className="al-d">{item.kind} · r{item.n}</span></button>)}</div>
    <div className="art-r">
      <div className="doc-h"><b>{artifact.title ?? artifact.kind}</b><span className="t3">{artifact.kind} · {t('art.revision', { n: artifact.n })}</span><span className="grow" />
        <CopyButton value={artifact.digest} label={`sha256 ${artifact.digest.slice(0, 12)}…`} copiedLabel={t('copied')} /></div>
      {artifact.text === null ? <p className="doc t3">—</p> : <Markdown text={artifact.text} />}
    </div>
  </div>
}

export function NetworkTab({ detail }: { detail: JobDetail }) {
  const { t } = useDashboard()
  const byHost = new Map<string, { host: string; port: number; allowed: boolean; count: number; attempts: Set<string>; reason: string }>()
  for (const connection of detail.egress) {
    const key = `${connection.allowed}:${connection.host}:${connection.port}`
    const entry = byHost.get(key) ?? { host: connection.host, port: connection.port, allowed: connection.allowed, count: 0, attempts: new Set<string>(), reason: connection.reason }
    entry.count++
    entry.attempts.add(connection.attemptId?.split('.').at(-1) ?? '—')
    byHost.set(key, entry)
  }
  const rows = [...byHost.values()].sort((a, b) => Number(a.allowed) - Number(b.allowed) || b.count - a.count)
  if (rows.length === 0) return <p className="t3">{t('net.empty')}</p>
  return <div className="panel tbl"><table><thead><tr><th>{t('net.host')}</th><th>{t('net.decision')}</th><th className="n">{t('net.connections')}</th><th>{t('net.attempts')}</th><th>{t('net.reason')}</th></tr></thead>
    <tbody>{rows.map(row => <tr key={`${row.allowed}${row.host}${row.port}`}><td className="mono ink">{row.host}:{row.port}</td>
      <td><Tag tone={row.allowed ? 'ok' : 'bad'}>{row.allowed ? t('net.allowed') : t('net.refused')}</Tag></td><td className="n">{row.count}</td>
      <td className="mono t3">{[...row.attempts].join(', ')}</td><td className="t2">{row.reason}</td></tr>)}</tbody></table></div>
}

export function DetailsTab({ detail }: { detail: JobDetail }) {
  const { t, lang } = useDashboard()
  const [newest] = useNewestFirst()
  const { manifest } = detail
  const events = newest ? [...detail.events].reverse() : detail.events
  return <>
    <h3 className="h-sec">{t('det.manifest')}</h3>
    <div className="panel tbl"><table><thead><tr><th>{t('det.stage')}</th><th>{t('det.model')}</th><th>{t('det.presets')}</th><th>{t('det.egress')}</th><th>{t('det.tools')}</th></tr></thead>
      <tbody>{manifest.stages.map(stage => <tr key={stage.id}><td>{stage.title} <span className="mono t3">{stage.id}</span></td>
        <td className="mono">{stage.model}{stage.effort ? ` (${stage.effort})` : ''}</td><td className="t2">{stage.agentPreset} · {stage.permissionPreset}</td>
        <td className="mono">{stage.egress}</td><td className="mono t3">{stage.tools.join(', ') || '—'}</td></tr>)}</tbody></table></div>
    <div className="panel kvp">
      <div className="k">{t('det.definition')}</div><div className="mono">{manifest.definition} · sha256 {manifest.hash.slice(0, 12)}…</div>
      <div className="k">{t('det.budgets')}</div><div className="mono">{t('budget.line', { turns: manifest.budgets.turns, tokens: manifest.budgets.tokens, backtracks: manifest.budgets.backtracks })}</div>
      <div className="k">{t('det.parameters')}</div><div className="mono">{Object.entries(manifest.parameters).map(([key, value]) => `${key}=${value}`).join(' · ') || '—'}</div>
      <div className="k">{t('det.verdict')}</div><div className="mono">{manifest.verdictModel} · {manifest.policyVersion}</div>
    </div>
    <h3 className="h-sec">{t('det.events')} · {detail.events.length}</h3>
    <div className="panel tbl"><table><thead><tr><th className="n">#</th><th>{t('det.type')}</th><th>{t('det.at')}</th><th /></tr></thead>
      <tbody>{events.map(event => <tr key={event.seq}><td className="n">{event.seq}</td><td className="mono ink">{event.type}</td><td className="mono t3">{clock(event.at, lang)}</td>
        <td className="end"><JsonButton title={`${event.type} · #${event.seq}`} value={event} /></td></tr>)}</tbody></table></div>
    <h3 className="h-sec">{t('det.effects')} · {detail.effects.length}</h3>
    <div className="panel tbl"><table><thead><tr><th>{t('det.type')}</th><th>{t('det.status')}</th><th className="n">#</th><th>{t('det.at')}</th><th /></tr></thead>
      <tbody>{detail.effects.map(effect => <Fragment key={effect.id}><tr><td className="mono ink">{effect.kind}</td>
        <td><Tag tone={effect.status === 'succeeded' ? 'ok' : effect.status === 'failed' ? 'bad' : effect.status === 'running' ? 'run' : 'mute'}>{effect.status}</Tag></td>
        <td className="n">{effect.attempts}</td><td className="mono t3">{clock(effect.dueAt, lang)}</td><td className="end"><JsonButton title={`${effect.kind} · ${effect.id}`} value={effect} /></td></tr></Fragment>)}</tbody></table></div>
    {detail.timers.length ? <><h3 className="h-sec">{t('det.timers')}</h3><div className="panel tbl"><table><tbody>{detail.timers.map(timer =>
      <tr key={`${timer.kind}${timer.subject}`}><td className="mono ink">{timer.kind}</td><td className="mono t3">{timer.subject}</td><td className="mono">{clock(timer.dueAt, lang)}</td><td>{timer.status}</td></tr>)}</tbody></table></div></> : null}
  </>
}
