/**
 * A job (`D13`): where it is and why, who it waits on (`A3`), what the agent did, what it produced and what it cost. The title, the
 * "Now" sentence, the workflow's stages with their visits (any workflow, `A6`), the properties, and the tabs, each at its own address.
 */
import type { ReactNode } from 'react'
import type { JobDetail } from '../../app/panel-api.ts'
import { useResource } from '../api.ts'
import { Avatar, CopyButton, Icon, Tabs, Tag, ThreadLink, ToolBadge, type Tone } from '../controls.tsx'
import { notAnswering, Page, useDashboard } from '../context.tsx'
import { actorName, ago, clock, person, thread, tokens } from '../format.ts'
import type { Key } from '../locales.ts'
import { Link, useRouter } from '../router.tsx'
import { nowSentence, progress, proposalsSentence, StatusGlyph, toneOf } from '../status.tsx'
import { JOB_TABS } from '../job/tabs.ts'

function Properties({ detail }: { detail: JobDetail }) {
  const { t, lang, links, people } = useDashboard()
  const { job, state, manifest } = detail
  const requester = person(job.requester, people)
  const threads = [...new Map([...state.bindings.map(binding => [binding.threadKey, binding.role] as const),
    ...state.chatThread ? [[state.chatThread, 'chat'] as const] : []]).entries()]
  const gateThread = job.waiting?.thread ?? job.gateThread
  const extension = state.extended.tokens
  const cap = Math.max(job.budget, 1), total = Math.max(cap, job.tokens)
  const base = Math.min(job.tokens, job.budget - extension), extended = Math.max(0, Math.min(job.tokens, job.budget) - (job.budget - extension))
  const props: [Key, ReactNode][] = [
    ['prop.requester', <span className="pr"><Avatar name={requester.name} known={requester.known} /><span className="ink">{requester.name}</span></span>],
    ['prop.repository', <span className="mono ink">{manifest.parameters.repository || job.repository || '—'}</span>],
    ['prop.workflow', <span className="mono ink">{manifest.definition}</span>],
    ['prop.started', <><span className="mono ink">{clock(job.startedAt, lang)}</span><span className="t3">{t('prop.ago', { ago: ago(Date.now() - job.startedAt, lang) })}</span></>],
    ['prop.threads', <>{threads.map(([key, role]) => <span key={key} className="pr"><ThreadLink info={thread(key, links, lang)} />
      <span className={`role${key === gateThread ? ' g' : ''}`}>{t(`role.${role}` as Key)}{key === gateThread ? ` · ${t('role.gate')}` : ''}</span></span>)}</>],
    ['prop.tokens', <><span className={`mono ${job.tokens > job.budget ? 'bad' : 'ink'}`}>{tokens(job.tokens)} / {tokens(job.budget)}</span>
      {extension ? <span className="t3">{tokens(job.budget - extension)} + {tokens(extension)}</span> : null}
      <span className="meterbar"><i className={job.tokens > cap * 0.85 ? 'hi' : ''} style={{ width: `${base / total * 100}%` }} />
        {extended ? <i className="ext" style={{ width: `${extended / total * 100}%` }} /> : null}
        {job.tokens > cap ? <i className="over" style={{ width: `${(job.tokens - cap) / total * 100}%` }} /> : null}</span></>],
    ['prop.backtracks', <span className="mono ink">{state.backtracks.total} / {manifest.budgets.backtracks + state.extended.backtracks}</span>],
  ]
  return <>{props.map(([label, value]) => <div key={label} className="prop"><span className="pl">{t(label)}</span><span className="pv">{value}</span></div>)}</>
}

const PROPOSAL_TONES: Readonly<Record<string, Tone>> = { pending: 'wait', accepted: 'run', declined: 'mute', included: 'run', approved: 'ok', done: 'ok', dropped: 'mute' }

/** The proposed changes to the requirements (`D12`): what was asked, by whom and where, what became of each, and who decided. */
function Proposals({ detail }: { detail: JobDetail }) {
  const { t, lang, links, people } = useDashboard()
  const proposals = detail.state.proposals ?? []
  if (proposals.length === 0) return null
  return <section className="panel proposals" aria-label={t('proposals.title')}>
    <h2 className="proposals-h">{t('proposals.title')}<span className="cnt">{proposals.length}</span></h2>
    {proposals.map(proposal => {
      const by = actorName(proposal.by, people)
      return <div key={proposal.id} className="proposal">
        <div className="proposal-t">{proposal.text}</div>
        <div className="proposal-m"><Tag tone={PROPOSAL_TONES[proposal.status] ?? 'mute'} {...proposal.status === 'pending' ? { icon: 'hand' as const } : {}}>
          {t(`proposal.${proposal.status}` as Key, { n: proposal.revision ?? '—' })}</Tag>
          <span className="pr"><Avatar name={by} /><span className="ink">{by}</span></span>
          <ThreadLink info={thread(proposal.thread, links, lang)} />
          <span className="t3 mono">{clock(proposal.at, lang)}</span>
          {proposal.decidedBy ? <span className="t3">{t('proposal.decidedBy', { who: actorName(proposal.decidedBy, people) })}</span> : null}</div>
      </div>
    })}
  </section>
}

function Stages({ detail }: { detail: JobDetail }) {
  const { job, events } = detail
  const visits = new Map<string, number>()
  let last: string | undefined
  for (const event of events) {
    if (event.type !== 'AttemptStarted') continue
    const stage = String(event.data.stageId)
    if (stage !== last) visits.set(stage, (visits.get(stage) ?? 0) + 1)
    last = stage
  }
  const current = job.stages.findIndex(stage => stage.id === job.stageId)
  const done = job.status === 'completed'
  return <div className="steps">{job.stages.map((stage, index) => {
    const state = done || index < current ? 'd' : index === current ? 'c' : ''
    return <span key={stage.id} className={`step ${state} k-${toneOf(job.status)}`}>
      {state === 'd' ? <Icon name="check" size={12} className="okc" /> : state === 'c' ? <StatusGlyph status={job.status} fraction={progress(job)} size={12} /> : <span className="dash" />}
      {stage.title}{visits.get(stage.id) ? <span className="cnt">×{visits.get(stage.id)}</span> : null}</span>
  })}</div>
}

export function JobView({ params }: { params: Record<string, string> }) {
  const { t, lang, links, people, state } = useDashboard()
  const { home } = useRouter()
  const id = params.id!
  const detail = useResource('GET jobs/:id', { id })
  const tab = JOB_TABS.find(candidate => candidate.id === params.tab) ?? JOB_TABS[0]!
  const data = detail.data
  const key = data?.job.ticket ?? (data ? t('noTicket') : id)
  const crumbs = <><Link to={home}>{t('nav.jobs')}</Link><span className="sep">/</span><span className="cur mono">{key}</span></>
  const ticket = data?.job.ticket ? thread(`jira:${data.job.ticket}`, links, lang) : undefined
  const actions = <><CopyButton value={typeof window === 'undefined' ? id : `${window.location.origin}/jobs/${encodeURIComponent(id)}`} label={t('copyLink')} copiedLabel={t('copied')} />
    {ticket?.href ? <a className="ibtn" href={ticket.href} target="_blank" rel="noopener noreferrer"><ToolBadge tool="j" /><span className="hide-s">{ticket.label}</span><Icon name="external" size={12} /></a> : null}</>
  if (!data) {
    return <Page crumbs={crumbs}><p className="t3">{detail.error ? (detail.error as { status?: number }).status === 404 ? t('notFound') : detail.error.message : t('loading')}</p></Page>
  }
  const properties = <Properties detail={data} />
  return <Page crumbs={crumbs} actions={actions} title={data.job.ticket ?? (data.job.title || data.job.id)}>
    <div className="jgrid">
      <div className="jmain">
        {/* The workbench not answering at all has its own note on every page; this is this job's refresh alone. */}
        {detail.error && !notAnswering(state) ? <p className="note-plain t3 small" role="status"><Icon name="alert" size={13} />{t('job.stale', { error: detail.error.message })}</p> : null}
        <h1>{data.job.title || data.job.id}</h1>
        <div className={`callout k-${toneOf(data.job.status)}`}><span className="cicon"><StatusGlyph status={data.job.status} fraction={progress(data.job)} size={16} /></span>
          <div><div className="lbl">{t('now')}</div><div className="txt">{nowSentence(t, lang, data, links, people)}</div>
            {data.job.proposals ? <div className="txt pend"><Icon name="hand" size={13} /><span>{proposalsSentence(t, lang, data.job.proposals, links)}</span></div> : null}</div></div>
        <Stages detail={data} />
        <Proposals detail={data} />
        <details className="x props-m panel"><summary>{t('prop.title')}</summary><div className="props">{properties}</div></details>
        <Tabs label={t('job.sections')} current={tab.id} items={JOB_TABS.map(item => ({ id: item.id, to: `/jobs/${encodeURIComponent(id)}${item.id === 'activity' ? '' : `/${item.id}`}`,
          label: t(item.label), ...item.count ? { count: item.count(data) } : {}, ...item.bad?.(data) ? { bad: true } : {} }))} />
        <div className="tabbody"><tab.Component detail={data} /></div>
      </div>
      <aside className="panel props props-d">{properties}</aside>
    </div>
  </Page>
}
