/** Sources to the inbox (`T9.6`): Source deliveries as inbox events in the domain's inbound contract. */
import { describe, expect, it } from 'vitest'
import { inboundThread, inboxInput, ownPost } from '../src/adapters/inbound.ts'
import { route } from '../src/domain/router.ts'
import type { Trigger } from '../src/sources/types.ts'
import type { InboxEvent } from '../src/kernel/inbox.ts'
import { basePolicy } from './fixtures/domain-workflow.ts'

const trigger = (over: Partial<Trigger>): Trigger => ({ id: 't1', source: 'mattermost', threads: [{ source: 'mattermost', id: 'ch1:p1' }],
  actor: { source: 'mattermost', id: 'anna' }, human: true, at: '2026-01-01T10:00:00.000Z', text: 'hi', meta: {}, ...over })
const asEvent = (input: ReturnType<typeof inboxInput>): InboxEvent => ({ id: 'in_1', receivedAt: 0, status: 'received', human: input.human,
  source: input.source, externalId: input.externalId, payload: input.payload,
  ...input.threadKey ? { threadKey: input.threadKey } : {}, ...input.actor ? { actor: input.actor } : {} })

describe('inbox events from Sources', () => {
  it('maps a Mattermost mention, a direct message and an unaddressed post', () => {
    expect(inboxInput(trigger({ id: 'mm_p1', addressed: 'mention', text: '@workbench add sessions' }))).toEqual({ source: 'mattermost', externalId: 'mm_p1',
      threadKey: 'mattermost:ch1:p1', actor: { source: 'mattermost', id: 'anna' }, occurredAt: Date.parse('2026-01-01T10:00:00.000Z'), human: true,
      payload: { kind: 'message', text: '@workbench add sessions', addressed: 'mention', postedAt: Date.parse('2026-01-01T10:00:00.000Z') } })
    expect(inboxInput(trigger({ addressed: 'direct' })).payload).toMatchObject({ addressed: 'direct' })
    expect(inboxInput(trigger({})).payload).toMatchObject({ addressed: 'none' })
  })

  it('times a Jira issue at its creation and a comment at its own time', () => {
    const issue = inboxInput(trigger({ id: 'jira_issue_PAY-1', source: 'jira', threads: [{ source: 'jira', id: 'PAY-1' }], actor: { source: 'jira', id: 'anna' },
      at: '2026-01-02T00:00:00.000Z', addressed: 'mention', meta: { issueKey: 'PAY-1', createdAt: '2026-01-01T08:00:00.000+0300' } }))
    expect(issue).toMatchObject({ threadKey: 'jira:PAY-1', payload: { postedAt: Date.parse('2026-01-01T08:00:00.000+0300'), addressed: 'mention' } })
    const comment = inboxInput(trigger({ id: 'jira_comment_PAY-1_7', source: 'jira', threads: [{ source: 'jira', id: 'PAY-1' }], at: '2026-01-03T00:00:00.000Z',
      meta: { createdAt: '2026-01-01T08:00:00.000Z' } }))
    expect(comment.payload).toMatchObject({ postedAt: Date.parse('2026-01-03T00:00:00.000Z') })
  })

  it('makes merges and pipeline results facts, and GitLab notes never addressed', () => {
    const gitlab = { source: 'gitlab', threads: [{ source: 'gitlab', id: 'group/app!mr_4' }] }
    expect(inboxInput(trigger({ ...gitlab, id: 'gl_merged_x', human: true, addressed: 'mention', meta: { mrState: 'merged', pipelineStatus: 'success' } })))
      .toMatchObject({ threadKey: 'gitlab:group/app!4', human: false, payload: { kind: 'fact', fact: 'mr_merged', data: { pipelineStatus: 'success' } } })
    expect(inboxInput(trigger({ ...gitlab, id: 'gl_closed_x', human: true, addressed: 'mention', meta: { mrState: 'closed' } })))
      .toMatchObject({ threadKey: 'gitlab:group/app!4', human: false, payload: { kind: 'fact', fact: 'mr_closed', data: {} } })
    expect(inboxInput(trigger({ ...gitlab, id: 'gl_pipe_x', human: false, meta: { pipelineStatus: 'failed' } })).payload)
      .toEqual({ kind: 'fact', fact: 'pipeline', data: { status: 'failed' } })
    expect(inboxInput(trigger({ ...gitlab, id: 'gl_note_x', addressed: 'mention', text: '@anna please look' })).payload).toMatchObject({ kind: 'message', addressed: 'none' })
  })

  it('recognizes the workbench\'s own GitLab notes by their marker, but not a person quoting one', () => {
    const note = (text: string) => asEvent(inboxInput(trigger({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'group/app!mr_4' }], text })))
    expect(ownPost(note('Fixed in abc123.\n\n<!-- workbench:job_1:effect:ef_1#1:0 -->'))).toBe(true)
    expect(ownPost(note('> Fixed in abc123.\n>\n> <!-- workbench:job_1:effect:ef_1#1:0 -->\n\nThanks!'))).toBe(false)
    expect(ownPost(note('Looks good'))).toBe(false)
  })

  it('never starts a job from a GitLab note or a fact, even from an allowed sender (A18)', () => {
    const lookups = { bindings: () => [], openGate: () => undefined, policy: { ...basePolicy(), senders: { gitlab: ['anna'] } },
      workflows: [{ id: 'delivery', version: 1, declaration: { triggers: [{ sources: ['mattermost', 'jira', 'gitlab'], on: ['mention' as const] }] } }],
      ownPost }
    const note = asEvent(inboxInput(trigger({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'group/app!mr_4' }], actor: { source: 'gitlab', id: 'anna' },
      addressed: 'mention', text: '@workbench do it' })))
    expect(route(note, lookups)).toEqual({ kind: 'ignore', reason: 'not addressed to the workbench' })
  })

  it('converts thread ids and refuses ones it does not know', () => {
    expect(inboundThread('mattermost', 'ch1:p1')).toBe('mattermost:ch1:p1')
    expect(inboundThread('jira', 'PAY-12')).toBe('jira:PAY-12')
    expect(inboundThread('gitlab', 'group/sub/app!mr_9')).toBe('gitlab:group/sub/app!9')
    expect(inboundThread('jira', 'not a key')).toBeUndefined()
    expect(inboundThread('slack', 'x')).toBeUndefined()
  })
})
