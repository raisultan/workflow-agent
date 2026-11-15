/**
 * What a review says for people (`P16`): the merge risk of the change it passed (the level, the five categories with their gaps, the
 * sensitive areas, the commit), its notes, and a check's evidence with the findings' severities as tags. The wording follows the
 * completion post and the merge request note (`messages.ts`). An unverified claim is shown as one: a note, not a defect.
 */
import type { AttemptRow, JobRow } from '../../app/panel-api.ts'
import { Tag, type Tone } from '../controls.tsx'
import { known, type Key, type T } from '../locales.ts'

export type Risk = NonNullable<JobRow['risk']>
type Check = AttemptRow['checks'][number]

const CATEGORIES = ['alignment', 'impact', 'verification', 'rollback', 'errors'] as const
const LEVEL: Record<string, Tone> = { low: 'ok', medium: 'wait', high: 'bad' }
const VERDICT: Record<string, Tone> = { good: 'ok', small: 'ok', low: 'ok', decent: 'wait', medium: 'wait', poor: 'bad', large: 'bad', high: 'bad' }
const SEVERITY: Record<string, Tone> = { critical: 'bad', important: 'wait' }

export const riskTone = (risk: Risk): Tone => LEVEL[risk.level] ?? 'mute'
const level = (t: T, risk: Risk) => known(t, `risk.level.${risk.level}`, risk.level)
/** «риск: средний», beside the review's check. */
export const riskTag = (t: T, risk: Risk) => t('risk.tag', { level: level(t, risk) })
/** The level and what floored it: «Риск слияния: средний (затронуто: миграции)». */
export function riskHead(t: T, risk: Risk): string {
  const floor = risk.floor.map(area => known(t, `risk.area.${area}`, area))
  return `${t('risk.title', { level: level(t, risk) })}${floor.length ? ` (${t('risk.touched', { areas: floor.join(', ') })})` : ''}`
}

const severity = (t: T, name: string) => known(t, `review.sev.${name}`, name)

/** One of a review's notes, as `reviewNotes()` writes them, one per line: `- (label) text`. */
export interface Note { readonly kind: 'unverified' | 'test' | 'note'; readonly label: string; readonly text: string; readonly claimed?: string; readonly reason?: string }
export function parseNotes(notes: string, t: T): Note[] {
  return notes.split('\n').map(line => line.trim()).filter(Boolean).map((line): Note => {
    const unverified = /^- \(unverified ([\w-]+): (.*?)\) (.*)$/u.exec(line)
    if (unverified) return { kind: 'unverified', label: t('review.unverified'), claimed: severity(t, unverified[1]!), reason: unverified[2]!, text: unverified[3]! }
    const test = /^- \(test (does not test its claim|partly tests its claim|not audited)\) (.*)$/u.exec(line)
    if (test) return { kind: 'test', label: t(test[1]!.startsWith('does') ? 'review.test.does_not' : test[1]!.startsWith('partly') ? 'review.test.partly' : 'review.test.unaudited'), text: test[2]! }
    const plain = /^- \(([^)]*)\) (.*)$/u.exec(line)
    return plain ? { kind: 'note', label: severity(t, plain[1]!), text: plain[2]! } : { kind: 'note', label: '', text: line.replace(/^- /u, '') }
  })
}
export const noteCount = (notes: string | undefined): number => notes ? notes.split('\n').filter(line => line.trim()).length : 0

export function ReviewNotes({ notes, t }: { notes: string; t: T }) {
  return <ul className="rnotes">{parseNotes(notes, t).map((note, index) => <li key={index} className={`rnote n-${note.kind}`}>
    {note.label ? <Tag tone={note.kind === 'test' ? 'wait' : 'mute'}>{note.label}</Tag> : null}
    <span className="rnote-t">{note.text}{note.kind === 'unverified' ? <span className="rnote-w t3">{t('review.claimed', { severity: note.claimed!, reason: note.reason! })}</span> : null}</span>
  </li>)}</ul>
}

function RiskSummary({ risk, t }: { risk: Risk; t: T }) {
  return <div className="risk">
    <div className="risk-h"><b className={`k-${riskTone(risk)} kc`}>{riskHead(t, risk)}</b>
      {risk.commit ? <span className="t3">{t('risk.commit')} <span className="mono">{risk.commit.slice(0, 8)}</span></span> : null}</div>
    <dl className="risk-c">{CATEGORIES.map(name => {
      const category = risk.categories[name] as { verdict?: string; gaps?: readonly string[] } | undefined
      if (!category?.verdict) return null
      return <div key={name} className="risk-r"><dt>{t(`risk.cat.${name}`)}</dt>
        <dd><span className={`k-${VERDICT[category.verdict] ?? 'mute'} kc`}>{known(t, `risk.verdict.${name}.${category.verdict}`, category.verdict)}</span>
          {category.gaps?.length ? <ul>{category.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul> : null}</dd></div>
    })}</dl>
    {risk.sensitive.map(entry => <div key={entry.area} className="risk-s t2">{t('risk.touched', { areas: known(t, `risk.area.${entry.area}`, entry.area) })}
      <span className="mono t3">{entry.files.join(', ')}</span></div>)}
    <p className="risk-f t3">{t('risk.footer')}</p>
  </div>
}

/** What a review's check says beyond its outcome: the risk summary, then its notes. */
export function ReviewDetails({ check, t }: { check: Check; t: T }) {
  return <div className="review">
    {check.risk ? <RiskSummary risk={check.risk} t={t} /> : null}
    {check.notes ? <><div className="review-h">{t('review.notes')}<span className="t3">{t('review.notesHint')}</span></div><ReviewNotes notes={check.notes} t={t} /></> : null}
  </div>
}

/** A check's evidence as written, a review finding's `[critical]`/`[important]` shown as a tag. */
export function Evidence({ text, t }: { text: string; t: T }) {
  return <pre className="code">{text.split('\n').map((line, index) => {
    const finding = /^(\s*(?:\d+\.\s+)?)\[(critical|important|suggestion|nit)\] (.*)$/u.exec(line)
    return <span key={index}>{index ? '\n' : ''}{finding ? <>{finding[1]}<span className={`sev k-${SEVERITY[finding[2]!] ?? 'mute'}`}>{t(`review.sev.${finding[2]!}` as Key)}</span> {finding[3]}</> : line}</span>
  })}</pre>
}
