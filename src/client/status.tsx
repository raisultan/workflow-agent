/**
 * How a job's status shows (`D13`): a tone, a glyph (a ring with the stage's progress, or a form of its own for blocked, parked,
 * failed, done and cancelled), a label, and the "Now" sentence: what the job waits for, from whom, where and since when (`A3`).
 */
import type { ReactNode } from 'react'
import type { JobDetail, JobRow, Links } from '../app/panel-api.ts'
import type { BlockReason } from '../domain/job.ts'
import { ThreadLink, type Tone } from './controls.tsx'
import { actorName, ago, thread } from './format.ts'
import { known, type Key, type Lang, type T } from './locales.ts'

/** The tone of a job's status. */
export function toneOf(status: string): Tone {
  if (status === 'completed') return 'ok'
  if (status === 'failed' || status === 'blocked') return 'bad'
  if (status === 'awaiting_gate' || status === 'parked') return 'wait'
  if (status === 'cancelled') return 'mute'
  return 'run'
}
/** Which group of the board a job is in. */
export const groupOf = (status: string): 'people' | 'running' | 'finished' =>
  status === 'awaiting_gate' || status === 'blocked' || status === 'parked' ? 'people' : status === 'completed' || status === 'failed' || status === 'cancelled' ? 'finished' : 'running'

/** Which group a job is in: one with proposed requirement changes to decide needs people, whatever its status (`D12`). */
export const groupOfJob = (job: Pick<JobRow, 'status' | 'proposals'>) => job.proposals ? 'people' : groupOf(job.status)
/** Since when a job waits on people, else when it last changed. */
export const waitSince = (job: Pick<JobRow, 'waiting' | 'proposals' | 'updatedAt'>) => job.waiting?.since ?? job.proposals?.since ?? job.updatedAt

export const statusLabel = (t: T, status: string) => known(t, `status.${status}`, status)
/** Whether a job is done on the workbench's side and waits on people: it completed plainly and its merge request is still to be reviewed and merged. */
export const awaitsReview = (job: Pick<JobRow, 'status' | 'detail' | 'mergeRequest' | 'closedBy'>): boolean =>
  job.status === 'completed' && job.detail === 'completed' && Boolean(job.mergeRequest) && !job.closedBy
/** A job's status in words: a completed job whose merge request waits on people is ready for review, not finished for them. */
export const jobLabel = (t: T, job: Pick<JobRow, 'status' | 'detail' | 'mergeRequest' | 'closedBy'>) =>
  awaitsReview(job) ? t('status.review') : job.status === 'completed' && job.closedBy ? t('status.closed') : statusLabel(t, job.status)
/** How a job ended, in words: a fact the workflow completes on has its own; any other outcome is shown as written. */
export const outcomeLabel = (t: T, outcome: string) => known(t, `outcome.${outcome}`, outcome)

/** How far along a job is: the current stage's index plus a half, over the stage count (0 before the first, 1 when done). */
export function progress(job: Pick<JobRow, 'status' | 'stageId' | 'stages'>): number {
  if (job.status === 'completed') return 1
  const index = job.stages.findIndex(stage => stage.id === job.stageId)
  return index < 0 || job.stages.length === 0 ? 0 : Math.min(1, (index + 0.5) / job.stages.length)
}

export function StatusGlyph({ status, fraction, size = 14 }: { status: string; fraction: number; size?: number }) {
  const color = `var(--${toneOf(status)})`
  const ring = <circle cx="8" cy="8" r="6.3" fill="none" stroke={color} strokeWidth="1.5" />
  const body = (() => {
    if (status === 'completed') return <><circle cx="8" cy="8" r="7" fill={color} /><path d="M5 8.3l2 2 4-4.3" fill="none" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>
    if (status === 'failed') return <><circle cx="8" cy="8" r="7" fill={color} /><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" /></>
    if (status === 'cancelled') return <>{ring}<path d="M4 12L12 4" stroke={color} strokeWidth="1.5" /></>
    if (status === 'blocked') return <>{ring}<path d="M8 4.8v4M8 11.2v.01" stroke={color} strokeWidth="1.8" strokeLinecap="round" /></>
    if (status === 'parked') return <circle cx="8" cy="8" r="6.3" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="2 2.2" />
    if (status === 'setting_up' || status === 'new') return <g className="spin"><circle cx="8" cy="8" r="6.3" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="3 2" /></g>
    const circumference = 2 * Math.PI * 3.2
    return <>{ring}<circle cx="8" cy="8" r="3.2" fill="none" stroke={color} strokeWidth="6.4" strokeDasharray={`${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
      transform="rotate(-90 8 8)" /></>
  })()
  return <svg className="glyph" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">{body}</svg>
}

/** An approval's subject in words: `plan r2` → `план r2`; an artifact kind with no name is shown as it is. */
export function subjectLabel(t: T, subject: string | null): string {
  const match = /^([a-z_]+) r(\d+)$/u.exec(subject ?? '')
  if (!match) return subject ?? '—'
  const key = `artifact.${match[1]!}` as Key
  return `${t(key) === key ? match[1]! : t(key)} r${match[2]!}`
}

/** The label of what a job waits for: `approval of plan r2`, `answers 1/3`, `requirement changes (1)`. */
export function waitingLabel(t: T, waiting: NonNullable<JobRow['waiting']>): string {
  const reason = `reason.${waiting.subject ?? ''}` as Key
  const subject = waiting.kind === 'resume' && t(reason) !== reason ? t(reason) : waiting.kind === 'approval' ? subjectLabel(t, waiting.subject) : waiting.subject ?? '—'
  return t(`wait.${waiting.kind}` as Key, { subject })
}
/** Who a job waits on, in words. */
export function waitingWho(t: T, waiting: NonNullable<JobRow['waiting']>): string {
  if (waiting.kind === 'parked') return t('wait.deployment')
  // A question round with nobody listed is answered by anyone in its thread (a workflow with places); an approval with nobody listed
  // waits on nobody yet (approvers unresolved). `*` is any allowed sender, as the policy says it.
  if (waiting.kind === 'question' && waiting.who.length === 0) return t('wait.anyone')
  return waiting.who.map(name => name === '*' ? t('wait.senders') : name).join(', ') || t('none')
}

const stageTitle = (stages: readonly { id: string; title: string }[], id: string | undefined) => stages.find(stage => stage.id === id)?.title ?? id ?? '—'

/** Why a job is blocked, in words. */
export function blockReason(t: T, reason: BlockReason, stages: readonly { id: string; title: string }[]): string {
  switch (reason.kind) {
    case 'budget': return t('block.budget', { budget: t(`budget.${reason.budget}`) })
    case 'attempts': return t('block.attempts', { stage: stageTitle(stages, reason.stageId) })
    case 'backtracks': return t('block.backtracks', { from: stageTitle(stages, reason.from), to: stageTitle(stages, reason.to) })
    case 'stage_blocked': return t('block.stage_blocked', { stage: stageTitle(stages, reason.stageId), detail: reason.detail })
    case 'gate_expired': return t('block.gate_expired')
    case 'checks_blocked': return t('block.checks_blocked', { checks: reason.checks.join(', '), detail: reason.detail })
    case 'setup_blocked': return t('block.setup_blocked', { detail: reason.detail })
    default: return t('block.other', { kind: (reason as { kind: string }).kind })
  }
}

/** Fills a sentence's `{name}` placeholders with nodes (a thread link, a name in bold). */
function sentence(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/u).map((part, index) => {
    const name = /^\{(\w+)\}$/u.exec(part)?.[1]
    return name && name in nodes ? <span key={index}>{nodes[name]}</span> : part
  })
}

/** Under the "Now" sentence (`D12`): who must decide the pending requirement changes, and where; the job's status is not changed by it. */
export function proposalsSentence(t: T, lang: Lang, pending: NonNullable<JobRow['proposals']>, links: Links, now = Date.now()): ReactNode {
  return <>{sentence(t('now.proposals', { n: pending.subject ?? '' }), { who: <b>{waitingWho(t, pending)}</b>,
    place: pending.thread ? <ThreadLink info={thread(pending.thread, links, lang)} /> : '—' })}<span className="t3"> · {ago(now - pending.since, lang)}</span></>
}

/** The "Now" sentence of a job's page. */
export function nowSentence(t: T, lang: Lang, detail: JobDetail, links: Links, people: Readonly<Record<string, string>>, now = Date.now()): ReactNode {
  const { job, state } = detail
  const status = state.status
  const place = (key: string | null | undefined) => key ? <ThreadLink info={thread(key, links, lang)} /> : '—'
  const bold = (text: string) => <b>{text}</b>
  const since = (at: number | undefined) => at ? <span className="t3"> · {ago(now - at, lang)}</span> : null
  switch (status.kind) {
    case 'running': {
      const attempt = detail.attempts.find(candidate => candidate.id === status.attemptId)
      return <>{sentence(t('now.running', { n: attempt?.n ?? 1 }), { stage: bold(stageTitle(job.stages, status.stageId)) })}{since(attempt?.startedAt)}</>
    }
    case 'verifying': return sentence(t('now.verifying', { checks: status.checks.join(', ') }), { stage: bold(stageTitle(job.stages, status.stageId)) })
    case 'setting_up': return <>{t('now.setting_up', { n: status.n })}{since(status.since)}</>
    case 'awaiting_gate': {
      const gate = state.gates[status.gateId]
      const waiting = job.waiting
      if (gate?.kind === 'question') return <>{sentence(t('now.question'), { subject: bold(waiting?.subject ?? ''), who: bold(waiting ? waitingWho(t, waiting) : '—'), place: place(gate.threadKey) })}{since(gate.openedAt)}</>
      return <>{sentence(t('now.approval'), { who: bold(waiting ? waitingWho(t, waiting) : '—'), subject: bold(subjectLabel(t, waiting?.subject ?? null)), place: place(gate?.threadKey) })}{since(gate?.openedAt)}</>
    }
    case 'blocked': {
      const gate = state.gates[status.gateId]
      return <>{sentence(t('now.blocked'), { reason: bold(blockReason(t, status.reason, job.stages)) })} {
        sentence(t('now.decide'), { who: bold(job.waiting ? waitingWho(t, job.waiting) : '—'), place: place(gate?.threadKey) })}{since(status.since)}</>
    }
    case 'parked': return <>{sentence(t('now.parked'), { missing: bold(status.missing.join(', ')) })}{since(status.since)}</>
    case 'completed': {
      // Closed (by a person, or by a merge after it finished): nothing reopens it.
      if (state.closedBy === 'person' && state.closer) return <>{sentence(t('now.closed'), { by: bold(actorName(state.closer, people)) })}{since(status.at)}</>
      if (state.closedBy) return <>{t('now.closedByFact', { outcome: outcomeLabel(t, state.closedBy) })}{since(status.at)}</>
      // Done on the workbench's side; the merge request is open, and a comment on it reopens the job.
      if (status.outcome === 'completed' && job.mergeRequest) return <>{sentence(t('now.review'), { mr: place(job.mergeRequest) })}{since(status.at)}</>
      return <>{status.outcome === 'completed' ? t('now.completedPlain') : t('now.completed', { outcome: outcomeLabel(t, status.outcome) })}{since(status.at)}</>
    }
    case 'failed': return <>{t('now.failed', { reason: status.reason })}{since(status.at)}</>
    case 'cancelled': return <>{status.by ? sentence(t('now.cancelled', { reason: status.reason }), { by: bold(actorName(status.by, people)) })
      : t('now.cancelledNobody', { reason: status.reason })}{since(status.at)}</>
    default: return statusLabel(t, status.kind)
  }
}
