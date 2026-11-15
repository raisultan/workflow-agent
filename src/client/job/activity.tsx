/**
 * The Activity tab (`D13`): the job's story by stage visit, newest first by default (a toggle, remembered in this browser), filtered
 * to the agent, people or the system. The workbench's own posts show two lines until clicked.
 */
import { useMemo, useState } from 'react'
import type { JobDetail } from '../../app/panel-api.ts'
import { Avatar, Icon, Segmented, ThreadLink } from '../controls.tsx'
import { useDashboard } from '../context.tsx'
import { clock, day, hm, thread, tokens } from '../format.ts'
import { JsonButton } from '../json.tsx'
import { AttemptCard } from './attempt.tsx'
import { buildFeed, type FeedItem, type FeedKind } from './feed.ts'
import { Markdown } from './markdown.tsx'
import { Evidence, noteCount, ReviewNotes } from './review.tsx'

const ORDER_KEY = 'awb.newest'
const remembered = (): boolean => { try { return localStorage.getItem(ORDER_KEY) !== '0' } catch { return true } }

/** Whether the job's feeds read newest first, remembered per browser. */
export function useNewestFirst(): [boolean, (value: boolean) => void] {
  const [newest, setNewest] = useState(remembered)
  return [newest, value => { setNewest(value); try { localStorage.setItem(ORDER_KEY, value ? '1' : '0') } catch { /* private window */ } }]
}

/** Quoted words: people's as written; the workbench's two lines until clicked, its own posts as Markdown (a click on a link only opens it). */
function Quote({ text, out, markdown = false }: { text: string; out: boolean; markdown?: boolean | undefined }) {
  const [full, setFull] = useState(false)
  if (!out) return <div className="quote">{text}</div>
  const toggle = () => { setFull(!full) }
  return <div role="button" tabIndex={0} className={`quote out${markdown ? ' md' : ''}${full ? ' full' : ''}`} aria-expanded={full}
    onClick={event => { if (!(event.target instanceof Element && event.target.closest('a'))) toggle() }}
    onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle() } }}>
    {markdown ? <Markdown text={text} className="doc post" /> : text}</div>
}

function Item({ item, jobId, newest }: { item: FeedItem; jobId: string; newest: boolean }) {
  const { t, lang, links } = useDashboard()
  if (item.attempt) {
    return <div className="it k-acc"><span className="ico"><Icon name="agent" size={13} /></span>
      <div className="body flat"><AttemptCard jobId={jobId} attempt={item.attempt} newest={newest} /></div>
      <span className="side-r"><span className="tm mono" title={clock(item.at, lang)}>{hm(item.at)}</span></span></div>
  }
  const known = item.workbench || !item.who || !/^mattermost:/u.test(item.who)
  return <div className={`it k-${item.tone}`}>
    <span className="ico"><Icon name={item.icon} size={12} /></span>
    <div className="body">
      <div className="ln">{item.who ? <><Avatar name={item.who} workbench={item.workbench} known={known} /><span className="who">{item.who}</span></> : null}
        <span>{item.text}</span>{item.thread ? <ThreadLink info={thread(item.thread, links, lang)} /> : null}</div>
      {item.quote ? <Quote text={item.quote.text} out={item.quote.out} markdown={item.quote.markdown} /> : null}
      {item.evidence || item.notes ? <details className="x"><summary>{item.evidence?.summary ?? t('review.notesCount', { n: noteCount(item.notes) })}</summary>
        {item.evidence ? <Evidence text={item.evidence.text} t={t} /> : null}{item.notes ? <ReviewNotes notes={item.notes} t={t} /> : null}</details> : null}
    </div>
    <span className="side-r"><JsonButton title={item.json.title} value={item.json.value} /><span className="tm mono" title={clock(item.at, lang)}>{hm(item.at)}</span></span>
  </div>
}

export function ActivityTab({ detail }: { detail: JobDetail }) {
  const { t, lang, people } = useDashboard()
  const [kind, setKind] = useState<'all' | FeedKind>('all')
  const [newest, setNewest] = useNewestFirst()
  const visits = useMemo(() => buildFeed(detail, t, people), [detail, t, people])
  const shown = visits.map(visit => ({ ...visit, items: visit.items.filter(item => kind === 'all' || item.kind === kind) })).filter(visit => visit.items.length > 0)
  const ordered = newest ? [...shown].reverse().map(visit => ({ ...visit, items: [...visit.items].reverse() })) : shown
  const title = (stageId: string | null) => stageId === null ? t('feed.start') : detail.job.stages.find(stage => stage.id === stageId)?.title ?? stageId
  return <>
    <div className="feedbar">
      <Segmented label={t('tab.activity')} value={kind} onChange={setKind} items={(['all', 'agent', 'people', 'system'] as const).map(value => ({ value, label: t(`feed.${value}`) }))} />
      <button type="button" className="ibtn ghost" onClick={() => { setNewest(!newest) }}><Icon name="sort" size={13} />{newest ? t('feed.newest') : t('feed.oldest')}</button>
    </div>
    {ordered.length === 0 ? <p className="t3">{t('feed.empty')}</p> : <div className="feed">{ordered.map((visit, index) => {
      const days = [...new Set(visit.items.map(item => day(item.at, lang)))]
      const attempts = visit.items.filter(item => item.attempt).map(item => item.attempt!)
      return <section key={`${visit.stageId ?? 'start'}-${index}`}>
        <div className="visit-h"><span className="vt">{title(visit.stageId)}</span>
          {attempts.length ? <span className="vm">{t('feed.visit', { n: attempts.length, tokens: tokens(attempts.reduce((sum, attempt) => sum + attempt.tokens, 0)) })}</span> : null}
          <span className="vm end">{days.join(' – ')}</span></div>
        <div className="items">{visit.items.map(item => <Item key={item.key} item={item} jobId={detail.job.id} newest={newest} />)}</div>
      </section>
    })}</div>}
  </>
}
