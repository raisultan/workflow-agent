/**
 * The inbox (`D13`): did the workbench see my message, and what did it do with it. Every inbound message, newest first, with the
 * job it went to and what it became there, or why it was ignored.
 */
import { useState } from 'react'
import type { MessageRow } from '../../app/panel-api.ts'
import { useResource } from '../api.ts'
import { Avatar, Segmented, Tag, ThreadLink, ToolBadge } from '../controls.tsx'
import { Page, useDashboard } from '../context.tsx'
import { clock, person, thread } from '../format.ts'
import { known, type Key, type T } from '../locales.ts'
import { Link } from '../router.tsx'

type Route = 'all' | 'routed' | 'ignored'
type Source = 'all' | 'mattermost' | 'jira' | 'gitlab'

/** The router's reasons for ignoring a message (`domain/router.ts`), each with its text here; the named groups fill the text. */
const WHY: readonly [RegExp, Key][] = [
  [/^malformed payload$/u, 'inbox.why.malformed'], [/^resume from outside the workbench$/u, 'inbox.why.resume'], [/^no thread$/u, 'inbox.why.noThread'],
  [/^the workbench's own post$/u, 'inbox.why.own'], [/^a fact on a thread no active job is bound to$/u, 'inbox.why.fact'],
  [/^not from a person$/u, 'inbox.why.notPerson'], [/^no verified actor$/u, 'inbox.why.noActor'], [/^not addressed to the workbench$/u, 'inbox.why.notAddressed'],
  [/^the sender may not start jobs$/u, 'inbox.why.sender'], [/^the sender may not start jobs on (?<repository>.+)$/u, 'inbox.why.senderRepo'],
  [/^no workflow matches$/u, 'inbox.why.noWorkflow'], [/^repo:(?<repository>.+) contradicts this thread's repository (?<mapped>.+)$/u, 'inbox.why.contradicts'],
  [/^no repository is named (?<name>.+)$/u, 'inbox.why.noRepoNamed'], [/^no repository matches, and there is no default$/u, 'inbox.why.noRepo'],
  [/^the trigger names no Jira ticket for the plan$/u, 'inbox.why.noTicket'],
  [/^(?<repository>.+) has no Mattermost channel for the job's questions$/u, 'inbox.why.noChannel'],
]

/** Why a message was ignored, in the viewer's language; a reason this page does not know is shown as written. */
export function whyIgnored(t: T, reason: string): string {
  for (const [pattern, key] of WHY) { const match = pattern.exec(reason); if (match) return t(key, match.groups ?? {}) }
  return reason
}

/** What a routed message became (the engine's outcome), or why a message was ignored, from its outcome. */
export function outcomeOf(message: MessageRow, t: T): { jobId?: string; text: string } {
  const outcome = (message.outcome ?? {}) as { jobId?: string; outcome?: string; reason?: string; kind?: string }
  const routed = outcome.outcome ?? outcome.kind
  const text = outcome.reason !== undefined ? whyIgnored(t, outcome.reason) : routed !== undefined ? known(t, `inbox.outcome.${routed}`, routed)
    : known(t, `inbox.${message.status}`, message.status).toLowerCase()
  return { ...outcome.jobId ? { jobId: outcome.jobId } : {}, text }
}

export function InboxView() {
  const { t, lang, links, people, state } = useDashboard()
  const inbox = useResource('GET inbox')
  const [route, setRoute] = useState<Route>('all')
  const [source, setSource] = useState<Source>('all')
  const [humans, setHumans] = useState(false)
  const messages = inbox.data?.messages ?? []
  const jobs = new Map((state.data?.jobs ?? []).map(job => [job.id, job]))
  const shown = messages.filter(message => (route === 'all' || (route === 'routed' ? message.status === 'routed' : message.status !== 'routed'))
    && (source === 'all' || message.source === source) && (!humans || message.human))
  const count = (value: Route) => messages.filter(message => value === 'all' || (value === 'routed' ? message.status === 'routed' : message.status !== 'routed')).length
  return <Page crumbs={<span>{t('inbox.title')}</span>} actions={<span className="t3 small">{t('inbox.limit')}</span>}>
    <div className="toolbar">
      <Segmented label={t('inbox.title')} value={route} onChange={setRoute} items={(['all', 'routed', 'ignored'] as const).map(value => ({ value,
        label: value === 'all' ? t('filter.all') : t(`inbox.${value}`), count: count(value) }))} />
      <Segmented label={t('inbox.source')} value={source} onChange={setSource} items={(['all', 'mattermost', 'jira', 'gitlab'] as const).map(value => ({ value,
        label: value === 'all' ? t('filter.all') : value === 'mattermost' ? 'Mattermost' : value === 'jira' ? 'Jira' : 'GitLab' }))} />
      <div className="segm"><button type="button" aria-pressed={humans} onClick={() => { setHumans(!humans) }}>{t('inbox.peopleOnly')}</button></div>
    </div>
    {!inbox.data ? <p className="t3">{inbox.error ? inbox.error.message : t('loading')}</p>
      : shown.length === 0 ? <div className="panel empty"><p className="t2">{messages.length ? t('nothing') : t('inbox.empty')}</p></div>
        : <div className="panel">{shown.map(message => {
          const who = person(message.actor, people)
          const info = message.threadKey ? thread(message.threadKey, links, lang) : undefined
          const result = outcomeOf(message, t)
          const job = result.jobId ? jobs.get(result.jobId) : undefined
          return <div key={message.id} className="inr">
            <span className="src">{info ? <ToolBadge tool={info.tool} /> : null}</span>
            <div className="inm"><div className="top"><Avatar name={who.name} known={who.known} /><span className="who">{who.name}</span>
              {!message.human ? <span className="bot">{t('inbox.bot')}</span> : null}{info ? <ThreadLink info={info} /> : null}
              <span className="mono end">{clock(message.receivedAt, lang)}</span></div>
              <div className="tx" title={message.text ?? ''}>{message.text ?? '—'}</div></div>
            <div className="res">{result.jobId ? <><Link to={`/jobs/${encodeURIComponent(result.jobId)}`} className="acc">{job?.ticket ?? (job ? t('noTicket') : result.jobId)} →</Link>
              <div className="t3">{result.text}</div></> : <Tag tone="mute">{result.text}</Tag>}</div>
          </div>
        })}</div>}
  </Page>
}
