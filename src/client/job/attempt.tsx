/**
 * A stage attempt as a card (`D13`): its entry, turns, tokens and time, its checks on one line, its DSH session id, and its agent
 * trace on demand, read from the session (re-read every few seconds while the attempt runs). Steps follow the page's order.
 * Beside a review's check stands its merge risk (`P16`), or how many notes it left; either opens what the review said for people.
 */
import { Fragment, useState } from 'react'
import type { AttemptRow } from '../../app/panel-api.ts'
import { useResource } from '../api.ts'
import { CopyButton, Icon, Tag, type IconName, type Tone } from '../controls.tsx'
import { useDashboard } from '../context.tsx'
import { duration, tokens } from '../format.ts'
import { JsonButton } from '../json.tsx'
import { known, type Key } from '../locales.ts'
import { noteCount, ReviewDetails, riskHead, riskTag, riskTone } from './review.tsx'
import { Step } from './steps.tsx'

const CHECK: Record<string, [Tone, IconName]> = { passed: ['ok', 'check'], failed: ['bad', 'x'], blocked: ['bad', 'alert'] }
const OUTCOME: Record<string, Tone> = { completed: 'ok', question: 'wait', backtrack: 'wait', blocked: 'bad', failed: 'bad' }

export function AttemptCard({ jobId, attempt, newest }: { jobId: string; attempt: AttemptRow; newest: boolean }) {
  const { t, lang } = useDashboard()
  const [open, setOpen] = useState(false)
  const [review, setReview] = useState<string>()
  const trace = useResource(open ? 'GET jobs/:id/attempts/:attemptId/trace' : null, { id: jobId, attemptId: attempt.id }, attempt.running ? 5000 : 0)
  const entry = known(t, `attempt.entry.${attempt.entry}`, attempt.entry)
  const took = (attempt.endedAt ?? (attempt.running ? Date.now() : attempt.startedAt)) - attempt.startedAt
  const outcome = attempt.running ? <Tag tone="run">{t('attempt.running')}</Tag>
    : attempt.checks.length === 0 ? <Tag tone={OUTCOME[attempt.outcome ?? ''] ?? 'mute'}>{t(`attempt.outcome.${attempt.outcome ?? 'none'}` as Key)}</Tag> : null
  const steps = trace.data ? (newest ? [...trace.data.steps].reverse() : trace.data.steps) : []
  const omitted = trace.data?.omitted ?? 0
  const shown = attempt.checks.find(check => `${check.id}${check.at}` === review)
  // The steps left out are the earliest: the note stands where they would, after the rest when the newest come first.
  const note = omitted ? <p className="trace-msg t3">{t('attempt.omitted', { n: omitted })}</p> : null
  return <div className="acard">
    <div className="acard-h">
      <span className="k-acc kc"><Icon name="agent" /></span>
      <span className="ttl">{t('attempt.title', { n: attempt.n })}</span><span className="t3">{entry}</span>{outcome}
      <span className="grow" />
      <span className="st mono"><span>{t('attempt.turns', { n: attempt.turns })}</span><span>{tokens(attempt.tokens)}</span><span>{duration(took, lang)}</span></span>
      <JsonButton title={`attempt ${attempt.id}`} value={attempt} />
    </div>
    {attempt.summary ? <div className="acard-s t2">{attempt.summary}</div> : null}
    <div className="acard-b">
      <span className="cks">{attempt.checks.map(check => { const [tone, icon] = CHECK[check.outcome] ?? ['mute', 'dot'] as [Tone, IconName]
        const key = `${check.id}${check.at}`
        return <Fragment key={key}><span className={`ck k-${tone}`} title={`${check.id}: ${check.outcome}`}><Icon name={icon} size={12} />{check.id}</span>
          {check.risk || check.notes ? <button type="button" className={`tag rtag k-${check.risk ? riskTone(check.risk) : 'mute'}`} aria-expanded={review === key}
            title={check.risk ? riskHead(t, check.risk) : undefined} onClick={() => { setReview(review === key ? undefined : key) }}>
            {check.risk ? riskTag(t, check.risk) : t('review.notesCount', { n: noteCount(check.notes) })}<Icon name="chevron" size={11} className={review === key ? 'rot' : undefined} /></button> : null}
        </Fragment> })}</span>
      <button type="button" className="tracebtn" aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <Icon name="chevron" size={12} className={open ? 'rot' : undefined} />{open ? t('attempt.hide') : t('attempt.trace')}{trace.data ? ` · ${trace.data.steps.length + omitted}` : ''}</button>
      <CopyButton quiet value={attempt.sessionId} label={t('attempt.session')} title={`${t('attempt.session')}: ${attempt.sessionId}`} copiedLabel={t('copied')} />
    </div>
    {shown ? <ReviewDetails check={shown} t={t} /> : null}
    {open ? <div className="trace">
      <div className="trace-h"><Icon name="lock" size={12} />{t('attempt.note')}</div>
      {!trace.data ? <p className="trace-msg t3">{trace.error ? trace.error.message : t('loading')}</p>
        : trace.data.unavailable ? <p className="trace-msg t3">{trace.data.unavailable.reason === 'missing' ? t('attempt.missing') : t('attempt.unreadable', { detail: trace.data.unavailable.detail })}</p>
          : steps.length === 0 ? <p className="trace-msg t3">{t('attempt.empty')}</p>
            : <>{newest ? null : note}{steps.map(step => <Step key={`${step.seq}-${step.kind}-${'callId' in step ? step.callId : ''}`} t={t} step={step} startedAt={attempt.startedAt} attemptId={attempt.id} />)}
              {newest ? note : null}</>}
    </div> : null}
  </div>
}
