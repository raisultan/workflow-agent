/**
 * A job's activity (`D13`): its events and the workbench's own posts as one story, grouped by stage visit. Each item says who did
 * what, where, and carries the raw value for its JSON. People's words are quoted in full; the workbench's posts are clamped by the
 * page. Stage attempts become cards with their agent trace.
 */
import type { AttemptRow, EventRow, JobDetail, OutboundRow } from '../../app/panel-api.ts'
import type { IconName, Tone } from '../controls.tsx'
import { actorName } from '../format.ts'
import { known, type Key, type T } from '../locales.ts'
import { blockReason, outcomeLabel, subjectLabel } from '../status.tsx'

export type FeedKind = 'agent' | 'people' | 'system'
export interface FeedItem {
  readonly key: string
  readonly at: number
  readonly kind: FeedKind
  readonly tone: Tone
  readonly icon: IconName
  /** Who: a person's name, `@workbench`, or none for the system. */
  readonly who?: string
  readonly workbench?: boolean
  readonly text: string
  readonly thread?: string
  /** Quoted words; `markdown` for the workbench's own posts, which `render()` writes as Markdown. */
  readonly quote?: { readonly text: string; readonly out: boolean; readonly markdown?: boolean }
  readonly evidence?: { readonly summary: string; readonly text: string }
  /** A review's notes (`P16`): what it said that fails nothing, one per line. */
  readonly notes?: string
  readonly attempt?: AttemptRow
  readonly json: { readonly title: string; readonly value: unknown }
}
export interface Visit { readonly stageId: string | null; readonly items: FeedItem[] }

type Data = Record<string, unknown>
const s = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value)

/** Why a reply was not counted: the decider's fixed reasons (`src/domain/decider.ts`), each to its key. */
const REFUSALS: Readonly<Record<string, Key>> = {
  'the workbench cannot answer its own gate': 'refusal.own', 'not on the gate\'s thread': 'refusal.thread', 'not an eligible approver': 'refusal.approver',
  'not an eligible respondent': 'refusal.respondent', 'posted before the gate\'s current revision': 'refusal.stale', 'a question back': 'refusal.questionBack',
  'it answered no item': 'refusal.noItem', 'the reading was malformed': 'refusal.malformed', unclear: 'refusal.unclear', 'low confidence': 'refusal.lowConfidence',
  unrelated: 'refusal.unrelated', 'unrelated to the questions': 'refusal.unrelatedRound',
}
/** The reasons that carry a value: a pattern, the key, and the name its value fills (a gate's status is said in words). */
const REFUSAL_PATTERNS: readonly (readonly [RegExp, Key, 'detail' | 'status' | 'verdict'])[] = [
  [/^no reading: ([\s\S]*)$/u, 'refusal.noReading', 'detail'], [/^the round was (\w+) before the reply was read$/u, 'refusal.roundClosed', 'status'],
  [/^the gate was (\w+) before the verdict$/u, 'refusal.gateClosed', 'status'], [/^a (\w+) reply does not resume a blocked job$/u, 'refusal.noResume', 'verdict'],
]
/** A refusal's reason in the viewer's language; a reason the page does not know is shown as written. */
export function refusalReason(t: T, reason: string): string {
  if (Object.hasOwn(REFUSALS, reason)) return t(REFUSALS[reason]!)
  for (const [pattern, key, name] of REFUSAL_PATTERNS) {
    const value = pattern.exec(reason)?.[1]
    if (value !== undefined) return t(key, { [name]: name === 'status' ? known(t, `gate.${value}`, value) : value })
  }
  return reason
}

/** One event as a feed item, or none for an event the story does not need (it is still in Details). */
function eventItem(event: EventRow, detail: JobDetail, t: T, people: Readonly<Record<string, string>>): FeedItem | undefined {
  const data = event.data as Data
  const json = { title: `${event.type} · #${event.seq}`, value: event }
  const base = { key: `e${event.seq}`, at: event.at, json }
  const who = (actor: unknown) => actorName(actor as { source: string; id: string } | undefined, people)
  const stages = detail.job.stages
  switch (event.type) {
    case 'JobStarted': {
      const intake = data.intake as { actor?: { source: string; id: string }; threadKey?: string; text?: string } | undefined
      return { ...base, kind: 'people', tone: 'mute', icon: 'message', who: who(intake?.actor), text: t('ev.started'), ...intake?.threadKey ? { thread: intake.threadKey } : {},
        ...intake?.text ? { quote: { text: intake.text, out: false } } : {} }
    }
    case 'SetupStarted': return { ...base, kind: 'system', tone: 'run', icon: 'gear', text: t('ev.setup') }
    case 'SetupCompleted': {
      const toolchains = (data.toolchains as { tool: string; version: string; from: string }[] | undefined) ?? []
      return { ...base, kind: 'system', tone: 'ok', icon: 'gear', text: t('ev.setupDone', { toolchains: toolchains.length ? `: ${toolchains.map(tc => `${tc.tool} ${tc.version}`).join(', ')}` : '' }),
        ...s(data.evidence) ? { evidence: { summary: toolchains.map(tc => `${tc.tool} ← ${tc.from}`).join(', ') || t('step.output'), text: s(data.evidence) } } : {} }
    }
    case 'ChatOpened': return { ...base, kind: 'system', tone: 'mute', icon: 'send', workbench: true, who: '@workbench', text: t('ev.chat'), thread: s(data.threadKey) }
    case 'ThreadBound': return data.role === 'artifact' ? { ...base, kind: 'system', tone: 'mute', icon: 'branch', text: t('ev.mr'), thread: s(data.threadKey) } : undefined
    case 'AttemptStarted': {
      const attempt = detail.attempts.find(candidate => candidate.id === data.attemptId)
      return attempt ? { ...base, kind: 'agent', tone: 'acc', icon: 'agent', text: '', attempt } : undefined
    }
    case 'VerificationStarted': return { ...base, kind: 'system', tone: 'run', icon: 'play',
      text: t('ev.checks', { checks: ((data.checks as { id: string }[] | undefined) ?? []).map(check => check.id).join(', ') }) }
    case 'CheckCompleted': {
      const outcome = s(data.outcome)
      return { ...base, kind: 'system', tone: outcome === 'passed' ? 'ok' : 'bad', icon: outcome === 'passed' ? 'check' : 'alert',
        text: t(outcome === 'passed' ? 'ev.check.passed' : outcome === 'blocked' ? 'ev.check.blocked' : 'ev.check.failed', { id: s(data.checkId) }),
        ...s(data.evidence) ? { evidence: { summary: s(data.evidence).split('\n').find(line => line.trim())?.slice(0, 140) ?? t('step.output'), text: s(data.evidence) } } : {},
        ...typeof data.notes === 'string' && data.notes ? { notes: data.notes } : {} }
    }
    case 'AttemptFailed': return { ...base, kind: 'system', tone: 'bad', icon: 'alert', text: t('ev.attemptFailed', { reason: s(data.reason) }) }
    case 'ArtifactRecorded': {
      const revision = data.revision as { kind: string; n: number } | undefined
      return { ...base, kind: 'agent', tone: 'mute', icon: 'file', text: t('ev.artifact', { subject: subjectLabel(t, `${revision?.kind ?? ''} r${revision?.n ?? 0}`) }) }
    }
    case 'GateOpened': {
      const gate = data.gate as { kind: string; threadKey: string; subject?: { kind: string; n: number }; items?: { text: string }[]; blocked?: unknown }
      const text = gate.kind === 'approval' ? t('ev.gate.approval', { subject: gate.subject ? subjectLabel(t, `${gate.subject.kind} r${gate.subject.n}`) : '' })
        : gate.kind === 'question' ? t('ev.gate.question', { n: gate.items?.length ?? 0 }) : gate.kind === 'proposal' ? t('ev.gate.proposal') : t('ev.gate.resume')
      return { ...base, kind: 'system', tone: gate.kind === 'resume' ? 'bad' : 'wait', icon: 'hand', workbench: true, who: '@workbench', text, thread: gate.threadKey,
        ...gate.items?.length ? { quote: { text: gate.items.map((item, index) => `${index + 1}. ${item.text}`).join('\n'), out: true } } : {} }
    }
    case 'GateResponded': {
      const response = data.response as { actor: { source: string; id: string }; accepted: boolean; reason: string }
      return { ...base, kind: 'people', tone: response.accepted ? 'ok' : 'bad', icon: response.accepted ? 'check' : 'message', who: who(response.actor),
        text: response.accepted ? t('ev.accepted') : t('ev.refused', { reason: refusalReason(t, response.reason) }), ...s(data.text) ? { quote: { text: s(data.text), out: false } } : {} }
    }
    case 'GateInterpreting': return { ...base, kind: 'system', tone: 'mute', icon: 'agent', text: t('ev.reading'), who: who(data.actor),
      ...s(data.text) ? { quote: { text: s(data.text), out: false } } : {} }
    case 'GateRestated': return { ...base, kind: 'system', tone: 'wait', icon: 'reply', workbench: true, who: '@workbench', text: t('ev.restated'), quote: { text: s(data.reading), out: true } }
    case 'GateReminded': return { ...base, kind: 'system', tone: 'mute', icon: 'hand', workbench: true, who: '@workbench', text: t('ev.reminded') }
    // A proposal request that closes satisfied was decided, whatever the decisions (`D12`): nothing was approved by it.
    case 'GateClosed': return { ...base, kind: 'system', tone: data.status === 'satisfied' || data.status === 'answered' ? 'ok' : 'mute', icon: 'check',
      text: detail.state.gates[s(data.gateId)]?.kind === 'proposal' && data.status === 'satisfied' ? t('ev.gate.proposalClosed')
        : t('ev.closed', { status: known(t, `gate.${s(data.status)}`, s(data.status)) }), ...data.by ? { who: who(data.by) } : {}, ...s(data.notes) ? { quote: { text: s(data.notes), out: false } } : {} }
    case 'Backtracked': {
      const title = (id: unknown) => stages.find(stage => stage.id === id)?.title ?? s(id)
      return { ...base, kind: 'agent', tone: 'wait', icon: 'back', text: t('ev.backtracked', { from: title(data.from), to: title(data.to) }), quote: { text: s(data.reason), out: true } }
    }
    case 'Blocked': return { ...base, kind: 'system', tone: 'bad', icon: 'alert', text: t('ev.blocked', { reason: blockReason(t, data.reason as never, stages) }) }
    case 'BudgetExtended': return { ...base, kind: 'people', tone: 'ok', icon: 'check', who: who(data.by), text: t('ev.extended') }
    case 'Parked': return { ...base, kind: 'system', tone: 'wait', icon: 'pause', text: t('ev.parked', { missing: ((data.missing as string[] | undefined) ?? []).join(', ') }) }
    case 'Unparked': return { ...base, kind: 'system', tone: 'run', icon: 'play', text: t('ev.unparked') }
    case 'FollowUpReceived': {
      const message = data.message as { actor?: { source: string; id: string }; text?: string; threadKey?: string } | undefined
      return { ...base, kind: 'people', tone: 'mute', icon: 'message', who: who(message?.actor), text: t('ev.followUp'), ...message?.threadKey ? { thread: message.threadKey } : {},
        ...message?.text ? { quote: { text: message.text, out: false } } : {} }
    }
    case 'FactRecorded': return { ...base, kind: 'system', tone: 'mute', icon: 'file', text: `${t('ev.fact')}: ${s(data.fact)}`, thread: s(data.threadKey) }
    case 'ActionRequested': return { ...base, kind: 'agent', tone: 'mute', icon: 'play', text: t('ev.action', { action: s(data.action) }) }
    case 'ActionSettled': return { ...base, kind: 'system', tone: data.ok ? 'ok' : 'bad', icon: data.ok ? 'check' : 'alert', text: t('ev.actionDone', { action: s(data.action), detail: s(data.detail) }) }
    case 'AnswersRecorded': {
      const answers = (data.answers as { item: number; text: string }[] | undefined) ?? []
      const redirects = (data.redirects as { item: number; to: string }[] | undefined) ?? []
      const text = [answers.length ? t('ev.answers', { items: answers.map(answer => answer.item).join(', ') }) : '',
        ...redirects.map(redirect => t('ev.redirect', { to: redirect.to, item: redirect.item }))].filter(Boolean).join('; ')
      return { ...base, kind: 'people', tone: 'mute', icon: 'reply', who: who(data.actor), text: text || t('ev.answers', { items: '—' }),
        ...answers.length ? { quote: { text: answers.map(answer => `${answer.item}: ${answer.text}`).join('\n'), out: false } } : {} }
    }
    case 'AnswersUnread': return { ...base, kind: 'system', tone: 'wait', icon: 'alert', text: t('ev.answersUnread') }
    case 'AnswerRequested': return { ...base, kind: 'people', tone: 'mute', icon: 'message', who: who(data.actor), text: t('ev.question'), thread: s(data.threadKey),
      quote: { text: s(data.question), out: false } }
    case 'AnswerGiven': return { ...base, kind: 'agent', tone: 'acc', icon: 'reply', workbench: true, who: '@workbench', text: t('ev.answerGiven', { tokens: s(data.tokens) }),
      thread: s(data.threadKey), quote: { text: s(data.text), out: true } }
    case 'AnswerFailed': return { ...base, kind: 'system', tone: 'bad', icon: 'alert', text: t('ev.answerFailed', { reason: s(data.reason) }), thread: s(data.threadKey) }
    // A reopening says which stage it went to when that is not the usual one (a requirement change goes to the plan, `D12`).
    case 'JobReopened': return { ...base, kind: 'people', tone: 'run', icon: 'play', who: who(data.by), ...s(data.threadKey) ? { thread: s(data.threadKey) } : {},
      text: s(data.stage) ? t('ev.reopenedAt', { stage: stages.find(stage => stage.id === data.stage)?.title ?? s(data.stage) }) : t('ev.reopened') }
    // `D12`: an approval from someone who may not approve, which does not count.
    case 'NonApproverReplied': return { ...base, kind: 'people', tone: 'wait', icon: 'reply', who: who(data.actor), text: t('ev.notApprover') }
    // `D12`: a proposed change to the requirements: an approver's own is accepted at once, any other is put to the approvers.
    case 'ProposalRaised': {
      const proposal = data.proposal as { text?: string; by?: { source: string; id: string }; thread?: string; status?: string } | undefined
      const accepted = proposal?.status === 'accepted'
      return { ...base, kind: 'people', tone: accepted ? 'ok' : 'wait', icon: accepted ? 'check' : 'message', who: who(proposal?.by),
        text: t(accepted ? 'ev.proposal.raisedAccepted' : 'ev.proposal.raised'), ...proposal?.thread ? { thread: proposal.thread } : {},
        ...proposal?.text ? { quote: { text: proposal.text, out: false } } : {} }
    }
    case 'ProposalDecided': {
      const proposal = detail.state.proposals?.find(candidate => candidate.id === data.id)
      return { ...base, kind: 'people', tone: data.accepted ? 'ok' : 'mute', icon: data.accepted ? 'check' : 'stop', who: who(data.by),
        text: t(data.accepted ? 'ev.proposal.accepted' : 'ev.proposal.declined'), ...proposal ? { quote: { text: proposal.text, out: false } } : {} }
    }
    case 'ProposalGiven': return { ...base, kind: 'agent', tone: 'mute', icon: 'message', text: t('ev.proposal.given') }
    case 'ProposalsDropped': return { ...base, kind: 'system', tone: 'mute', icon: 'stop', text: t(data.reason === 'unasked' ? 'ev.proposal.unasked' : 'ev.proposal.expired') }
    case 'JobClosedByFact': return { ...base, kind: 'system', tone: 'mute', icon: 'check', text: t('ev.closedByFact', { fact: outcomeLabel(t, s(data.fact)) }) }
    case 'JobClosed': return { ...base, kind: 'people', tone: 'mute', icon: 'check', who: who(data.by), text: t('ev.jobClosed'), thread: s(data.threadKey) }
    case 'CloseRefused': return { ...base, kind: 'people', tone: 'wait', icon: 'reply', who: who(data.actor), text: t('ev.closeRefused'), thread: s(data.threadKey) }
    case 'ClosedJobAddressed': return { ...base, kind: 'system', tone: 'mute', icon: 'message', text: t('ev.closedTold'), thread: s(data.threadKey) }
    case 'ApprovalElsewhere': return { ...base, kind: 'people', tone: 'wait', icon: 'reply', who: who(data.actor), text: t('ev.approvalElsewhere'), thread: s(data.threadKey) }
    case 'JobCompleted': return { ...base, kind: 'system', tone: 'ok', icon: 'check', text: data.outcome === 'completed' ? t('ev.completedPlain') : t('ev.completed', { outcome: outcomeLabel(t, s(data.outcome)) }) }
    case 'JobFailed': return { ...base, kind: 'system', tone: 'bad', icon: 'alert', text: t('ev.failed', { reason: s(data.reason) }) }
    case 'JobCancelled': return { ...base, kind: 'system', tone: 'mute', icon: 'stop', ...data.by ? { who: who(data.by) } : {}, text: t('ev.cancelled', { reason: s(data.reason) }) }
    default: return undefined
  }
}

/** The workbench's post as a feed item. */
const postItem = (post: OutboundRow, t: T): FeedItem => ({ key: `p${post.id}`, at: post.at, kind: 'system', tone: post.status === 'succeeded' ? 'mute' : 'bad', icon: 'send',
  workbench: true, who: '@workbench', text: `${post.status === 'succeeded' ? t('ev.posted') : `${t('ev.posted')} · ${known(t, `post.${post.status}`, post.status)}`}${
    post.status === 'succeeded' && !post.recorded ? ` · ${t('post.redrawn')}` : ''}`, thread: post.threadKey,
  ...post.text ? { quote: { text: post.text, out: true, markdown: true } } : {}, json: { title: `post · ${post.kind}`, value: post } })

/** The job's story, oldest first, grouped by stage visit: a new visit starts when an attempt starts in another stage. */
export function buildFeed(detail: JobDetail, t: T, people: Readonly<Record<string, string>>): Visit[] {
  const entries: { at: number; order: number; item: FeedItem; stageId?: string }[] = []
  detail.events.forEach((event, index) => {
    const item = eventItem(event, detail, t, people)
    if (item) entries.push({ at: event.at, order: index, item, ...event.type === 'AttemptStarted' ? { stageId: s((event.data as Data).stageId) } : {} })
  })
  detail.outbound.forEach((post, index) => { entries.push({ at: post.at, order: detail.events.length + index, item: postItem(post, t) }) })
  entries.sort((a, b) => a.at - b.at || a.order - b.order)
  const visits: Visit[] = []
  for (const entry of entries) {
    const current = visits.at(-1)
    if (entry.stageId !== undefined && current?.stageId !== entry.stageId) visits.push({ stageId: entry.stageId, items: [entry.item] })
    else if (current) current.items.push(entry.item)
    else visits.push({ stageId: null, items: [entry.item] })
  }
  return visits
}
