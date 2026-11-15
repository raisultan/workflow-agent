/**
 * Jobs (`D13`): what is running, what waits on whom and where, and what failed. One row per job, grouped by who must act next:
 * people first (longest wait first), then running, then finished (newest first, the first 20 shown). Filters and the repository are
 * in the address, so a filtered list can be shared; `/` searches, `j`/`k` move, `Enter` opens.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { JobRow } from '../../app/panel-api.ts'
import { Avatar, Icon, Segmented, ToolBadge, type Tone } from '../controls.tsx'
import { Page, useDashboard } from '../context.tsx'
import { clock, person, short, thread, tokens, when } from '../format.ts'
import type { T } from '../locales.ts'
import { riskHead, riskTone } from '../job/review.tsx'
import { useRouter } from '../router.tsx'
import { groupOf, groupOfJob, jobLabel, outcomeLabel, progress, StatusGlyph, toneOf, waitingLabel, waitingWho, waitSince } from '../status.tsx'

type Filter = 'all' | 'people' | 'running' | 'problems' | 'finished'
const FILTERS: readonly Filter[] = ['all', 'people', 'running', 'problems', 'finished']
const FINISHED_SHOWN = 20
/** A wait longer than this shows its age in red. */
const LONG_WAIT_MS = 24 * 3600_000

const inFilter = (job: JobRow, filter: Filter) => filter === 'all' || (filter === 'problems' ? job.status === 'blocked' || job.status === 'failed'
  : groupOfJob(job) === filter)

export function matches(job: JobRow, query: string, people: Readonly<Record<string, string>>): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [job.ticket, job.title, job.repository, person(job.requester, people).name, ...job.waiting?.who ?? [], ...job.proposals?.who ?? [], job.id].some(value => value?.toLowerCase().includes(q))
}

/** The repositories that have jobs, by name, each with how many. */
export const repositoriesOf = (jobs: readonly JobRow[]): [string, number][] =>
  [...jobs.reduce((map, job) => job.repository ? map.set(job.repository, (map.get(job.repository) ?? 0) + 1) : map, new Map<string, number>())].sort()

/** What the row says about where the job is: the wait for people, or what it is doing. */
function Activity({ job, t }: { job: JobRow; t: T }) {
  const { links, lang } = useDashboard()
  // Proposed requirement changes wait on people too (`D12`): with the job's own wait when it has one, else alone, under its status.
  const wait = job.waiting ?? job.proposals
  if (wait) {
    const where = wait.thread ? thread(wait.thread, links, lang) : undefined
    const text = `${waitingWho(t, wait)} · ${waitingLabel(t, wait)}${job.waiting && job.proposals ? ` · ${waitingLabel(t, job.proposals)}` : ''}`
    return <span className="pill w" title={`${job.waiting ? '' : `${jobLabel(t, job)} · `}${where ? `${text} · ${where.title}` : text}`}><Icon name="hand" size={13} /><span>{text}</span>{where ? <ToolBadge tool={where.tool} /> : null}</span>
  }
  const stage = job.stages.find(candidate => candidate.id === job.stageId)?.title
  // A completed job's detail is its outcome (the label already says a plain one); a failed or cancelled job's is its reason, as written.
  const outcome = job.closedBy && job.closedBy !== 'person' ? job.closedBy : job.detail
  const detail = job.status === 'completed' ? (outcome && outcome !== 'completed' ? outcomeLabel(t, outcome) : null)
    : groupOf(job.status) === 'finished' ? job.detail : stage
  return <span className={`pill k-${toneOf(job.status)}`}><span><b className="pk">{jobLabel(t, job)}</b>{detail ? ` · ${detail}` : ''}</span></span>
}

function Row({ job, selected, now }: { job: JobRow; selected: boolean; now: number }) {
  const { t, lang, people } = useDashboard()
  const { navigate } = useRouter()
  const to = `/jobs/${encodeURIComponent(job.id)}`
  const requester = person(job.requester, people)
  const finished = groupOfJob(job) === 'finished'
  const since = waitSince(job)
  const stage = job.status === 'completed' ? '✓' : job.stages.find(candidate => candidate.id === job.stageId)?.title ?? '—'
  const open = (event: { metaKey?: boolean; ctrlKey?: boolean }) => { if (event.metaKey || event.ctrlKey) window.open(to, '_blank', 'noopener'); else navigate(to) }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => { if (event.key === 'Enter') { event.preventDefault(); open(event) } }
  return <div className={`row k-${toneOf(job.status)}${selected ? ' sel' : ''}`} role="link" tabIndex={0} data-href={to} aria-label={`${job.ticket ?? t('noTicket')} ${job.title}`}
    onClick={event => { if (!(event.target as HTMLElement).closest('a')) open(event) }} onKeyDown={onKey}
    onAuxClick={event => { if (event.button === 1 && !(event.target as HTMLElement).closest('a')) { event.preventDefault(); window.open(to, '_blank', 'noopener') } }}>
    <span className="c-ic"><StatusGlyph status={job.status} fraction={progress(job)} /></span>
    <span className="c-key mono">{job.ticket ?? t('noTicket')}</span>
    <span className="c-title" title={job.title}>{job.title || job.id}</span>
    <span className="c-wait">{/* A finished job's merge risk, when it is worth a look before merging (`P16`). */}
      {finished && job.risk && job.risk.level !== 'low' ? <span className={`rmark k-${riskTone(job.risk)}`} role="img" title={riskHead(t, job.risk)} aria-label={riskHead(t, job.risk)}><Icon name="alert" size={13} /></span> : null}
      <Activity job={job} t={t} /></span>
    <span className="c-stage" title={stage}>{stage}</span>
    <span className={`c-tok mono${job.budget > 0 && job.tokens > job.budget ? ' over' : ''}`} title={`${job.tokens} / ${job.budget}`}>{tokens(job.tokens)}</span>
    <span className="c-av"><Avatar name={requester.name} known={requester.known} /></span>
    <span className={`c-age mono${(job.waiting || job.proposals) && now - since > LONG_WAIT_MS ? ' old' : ''}`} title={clock(since, lang, now)}>
      {finished ? when(job.updatedAt, lang, now) : short(now - since, lang)}</span>
  </div>
}

const GROUPS: readonly { id: 'people' | 'running' | 'finished'; tone: Tone }[] = [{ id: 'people', tone: 'wait' }, { id: 'running', tone: 'run' }, { id: 'finished', tone: 'mute' }]

export function JobsView() {
  const { t, state, people } = useDashboard()
  const { location, navigate } = useRouter()
  const filter = (FILTERS as readonly string[]).includes(location.query.get('filter') ?? '') ? location.query.get('filter') as Filter : 'all'
  const repo = location.query.get('repo')
  const [query, setQuery] = useState('')
  const [allFinished, setAllFinished] = useState(false)
  // By job, not by place: a poll that reorders the rows does not move the highlight to another job.
  const [selected, setSelected] = useState<string>()
  const search = useRef<HTMLInputElement>(null)
  const now = state.at ?? Date.now()
  const all = useMemo(() => (state.data?.jobs ?? []).filter(job => !repo || job.repository === repo), [state.data, repo])
  const repositories = useMemo(() => repositoriesOf(state.data?.jobs ?? []), [state.data])
  const shown = all.filter(job => inFilter(job, filter) && matches(job, query, people))
  const groups = GROUPS.map(group => {
    const list = shown.filter(job => groupOfJob(job) === group.id)
      .sort((a, b) => group.id === 'finished' ? b.updatedAt - a.updatedAt : waitSince(a) - waitSince(b))
    return { ...group, total: list.length, list: group.id === 'finished' && !allFinished ? list.slice(0, FINISHED_SHOWN) : list }
  })
  const visible = groups.flatMap(group => group.list)
  const order = useRef<readonly string[]>([])
  order.current = visible.map(job => job.id)
  const setParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(location.query)
    if (value) next.set(name, value); else next.delete(name)
    const query = next.toString()
    navigate(query ? `/?${query}` : '/', { replace: true })
  }
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const typing = /^(?:INPUT|TEXTAREA|SELECT)$/u.test((event.target as HTMLElement).tagName)
      if (event.key === '/' && !typing) { event.preventDefault(); search.current?.focus(); return }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault()
        setSelected(current => {
          const ids = order.current
          const next = Math.max(0, Math.min(ids.length - 1, (current === undefined ? -1 : ids.indexOf(current)) + (event.key === 'j' ? 1 : -1)))
          document.querySelectorAll<HTMLElement>('.row')[next]?.focus()
          return ids[next]
        })
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [])
  const counts = { all: all.length, people: all.filter(job => groupOfJob(job) === 'people').length, running: all.filter(job => groupOfJob(job) === 'running').length,
    problems: all.filter(job => job.status === 'blocked' || job.status === 'failed').length, finished: all.filter(job => groupOfJob(job) === 'finished').length }
  // The demo has no connectors by design; their entries stay on the Health page.
  const unwell = state.data?.demo ? [] : Object.entries(state.data?.health.runtime ?? {}).filter(([, entry]) => entry.state === 'error')
  const crumbs = <>{repo ? <><a href="/" onClick={event => { event.preventDefault(); setParam('repo', null) }}>{t('nav.jobs')}</a><span className="sep">/</span><span className="cur">{repo}</span></>
    : <span>{t('nav.jobs')}</span>}</>
  const actions = state.data ? <span className="t3 small" title={t('jobs.tokensTodayHint')}>{t('jobs.tokensToday')} <span className="mono ink">{tokens(state.data.tokensToday)}</span></span> : undefined
  if (state.data && state.data.jobs.length === 0) {
    return <Page crumbs={crumbs} actions={actions}><div className="panel empty">
      <h2>{t('empty.title')}</h2><p className="t2">{t('empty.body')}</p>
      <h3 className="h-sec">{t('empty.connections')}</h3>
      <ul>{Object.entries(state.data.health.runtime).map(([name, entry]) => <li key={name}><span className={`k-${entry.state === 'ready' ? 'ok' : entry.state === 'error' ? 'bad' : 'wait'} kc`}>
        <Icon name={entry.state === 'ready' ? 'check' : 'alert'} size={14} /></span><b>{name}</b><span className="t3">{entry.detail}</span></li>)}</ul>
      <p className="t3">{t('empty.try', { example: '@workbench сделай ORD-123' })}</p>
    </div></Page>
  }
  return <Page crumbs={crumbs} actions={actions}>
    {unwell.map(([name, entry]) => <div key={name} className="note k-wait" role="status"><Icon name="plug" /><div><b>{name}</b>: {entry.detail} <a href="/health"
      onClick={event => { event.preventDefault(); navigate('/health') }} className="acc">{t('nav.health')} →</a></div></div>)}
    <div className="toolbar">
      <Segmented label={t('nav.jobs')} value={filter} onChange={value => { setParam('filter', value === 'all' ? null : value) }}
        items={FILTERS.map(value => ({ value, label: t(`filter.${value}`), count: counts[value] }))} />
      {/* The sidebar lists the repositories; a phone has no sidebar, so the list offers them itself. */}
      {repositories.length || repo ? <select className="repo-m" aria-label={t('nav.repositories')} value={repo ?? ''} onChange={event => { setParam('repo', event.target.value || null) }}>
        <option value="">{t('jobs.allRepositories')}</option>
        {repo && !repositories.some(([name]) => name === repo) ? <option value={repo}>{repo}</option> : null}
        {repositories.map(([name, count]) => <option key={name} value={name}>{name} · {count}</option>)}</select> : null}
      <label className="search"><Icon name="search" size={14} /><input ref={search} type="search" placeholder={t('jobs.search')} aria-label={t('jobs.search')} value={query}
        onChange={event => { setQuery(event.target.value); setSelected(undefined) }} onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.blur() }} /><span className="kbd">/</span></label>
    </div>
    {!state.data ? <p className="t3">{state.error ? state.error.message : t('loading')}</p>
      : visible.length === 0 ? <div className="panel empty"><p className="t2">{t('nothing')}</p></div>
        : <div className="panel list">{groups.filter(group => group.total > 0).map(group => <section key={group.id}>
          <div className="gh"><span className={`dot k-${group.tone}`} />{t(`group.${group.id}`)}<span className="cnt">{group.total}</span>
            {group.id !== 'running' ? <span className="hint">{t(group.id === 'people' ? 'group.peopleHint' : 'group.finishedHint')}</span> : null}</div>
          {group.list.map(job => <Row key={job.id} job={job} now={now} selected={job.id === selected} />)}
          {group.id === 'finished' && group.total > FINISHED_SHOWN ? <div className="more-row"><button type="button" className="ibtn" onClick={() => { setAllFinished(!allFinished) }}>
            {allFinished ? t('collapse') : t('showAll', { n: group.total })}</button></div> : null}
        </section>)}</div>}
  </Page>
}
