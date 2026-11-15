/**
 * Approvers and participants (`D12`, `T14.3`): a repository that lists approvers by email is decided by them alone (the requester
 * included); a workflow with places lets anyone in the job's threads answer its questions; the connectors find users by email.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { eligible, policyVersion, type Actor, type Policy } from '../src/domain/policy.ts'
import { RepositoryProfileSchema } from '../src/domain/repositories.ts'
import { JiraConnector } from '../src/sources/jira.ts'
import { MattermostConnector } from '../src/sources/mattermost.ts'
import { ANNA, basePolicy, delivery, EVE, Harness, LEAD } from './fixtures/domain-workflow.ts'

const JIRA_LEAD: Actor = { source: 'jira', id: 'lead' }
const policy = (): Policy => ({ ...basePolicy(), repositoryApprovers: { app: { jira: ['lead'], mattermost: ['lead'] } } })
const job = { workflowId: 'delivery', requester: ANNA }

describe('eligibility (D12)', () => {
  it('lets only a repository\'s listed approvers approve, not the requester or the global approvers', () => {
    expect(eligible(policy(), JIRA_LEAD, 'approver', { ...job, repository: 'app' })).toBe(true)
    expect(eligible(policy(), ANNA, 'approver', { ...job, repository: 'app' })).toBe(false)
    expect(eligible({ ...policy(), repositoryApprovers: { app: { jira: ['lead'] } } }, LEAD, 'approver', { ...job, repository: 'app' })).toBe(false)
    // A repository the policy lists no approvers for keeps the global rule.
    expect(eligible(policy(), ANNA, 'approver', { ...job, repository: 'other' })).toBe(true)
    expect(eligible(policy(), LEAD, 'approver', { ...job, repository: 'other' })).toBe(true)
  })

  it('fails closed: a repository listed with nobody resolved yet has no approver', () => {
    expect(eligible({ ...basePolicy(), repositoryApprovers: { app: {} } }, LEAD, 'approver', { ...job, repository: 'app' })).toBe(false)
  })

  it('lets anyone answer on a job whose workflow has places, and only senders and approvers otherwise', () => {
    expect(eligible(policy(), EVE, 'respondent', job)).toBe(false)
    expect(eligible(policy(), EVE, 'respondent', { ...job, participants: true })).toBe(true)
    expect(eligible(policy(), EVE, 'approver', { ...job, participants: true })).toBe(false)
    expect(eligible({ ...policy(), bots: { mattermost: ['eve'] } }, EVE, 'respondent', { ...job, participants: true })).toBe(false)
  })

  it('keeps the policy version of a policy without repository approvers', () => {
    expect(policyVersion({ ...basePolicy(), repositoryApprovers: {} })).toBe(policyVersion(basePolicy()))
    expect(policyVersion(policy())).not.toBe(policyVersion(basePolicy()))
  })

  it('takes approvers as lowercased emails in a repository profile', () => {
    expect(RepositoryProfileSchema.parse({ name: 'app', project: 'group/app', testCommand: 'npm test', approvers: [' Lead@Example.test '] }).approvers)
      .toEqual(['lead@example.test'])
    expect(() => RepositoryProfileSchema.parse({ name: 'app', project: 'group/app', testCommand: 'npm test', approvers: ['lead'] })).toThrow(/email/)
  })
})

describe('a job on a repository with approvers', () => {
  let h: Harness
  afterEach(() => { h.cleanup() })

  it('takes the plan approval only from a listed approver', async () => {
    const workflow = delivery(1, declaration => { declaration.repository = true })
    h = new Harness({ workflows: [workflow], repositories: [{ name: 'app', project: 'group/app', testCommand: 'npm test', default: true }] })
    h.policy = { ...policy(), repositoryApprovers: { app: { mattermost: ['lead'] } } }
    const job = await h.toApproval()
    await h.say(ANNA, 'ok')
    expect(h.status(job)).toBe('awaiting_gate')
    expect(h.gate(job)!.responses).toContainEqual(expect.objectContaining({ actor: ANNA, accepted: false, reason: 'not an eligible approver' }))
    await h.say(LEAD, 'ok')
    expect(h.state(job).attempt!.stageId).toBe('implement')
  })
})

describe('users by email', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('Jira: takes the user whose email matches, or the only match when emails are hidden', async () => {
    const answers: Record<string, unknown> = {
      'lead@example.test': [{ name: 'lead', emailAddress: 'Lead@example.test' }, { name: 'lead2', emailAddress: 'lead2@example.test' }],
      'hidden@example.test': [{ name: 'hidden' }],
      'two@example.test': [{ name: 'a' }, { name: 'b' }],
      'gone@example.test': [{ name: 'gone', emailAddress: 'gone@example.test', active: false }],
    }
    const jira = new JiraConnector({ baseUrl: 'https://jira.example.test', auth: { kind: 'bearer', token: 't' }, maxRetries: 0,
      fetchImpl: (async (url: string | URL) => json(answers[new URL(String(url)).searchParams.get('username')!] ?? [])) as typeof fetch })
    expect(await jira.userByEmail('lead@example.test')).toEqual({ name: 'lead' })
    expect(await jira.userByEmail('hidden@example.test')).toEqual({ name: 'hidden' })
    expect(await jira.userByEmail('two@example.test')).toBeUndefined()
    expect(await jira.userByEmail('gone@example.test')).toBeUndefined()
    expect(await jira.userByEmail('nobody@example.test')).toBeUndefined()
  })

  it('Mattermost: an unknown email is undefined, an unreachable server rejects', async () => {
    let down = false
    const mattermost = new MattermostConnector({ baseUrl: 'https://mm.example.test', token: 't', botUserId: 'bot', maxRetries: 0,
      fetchImpl: (async (url: string | URL) => {
        if (down) return json({ message: 'down' }, 503)
        return new URL(String(url)).pathname.endsWith('/lead%40example.test') ? json({ id: 'leadid', username: 'lead' }) : json({ message: 'no' }, 404)
      }) as typeof fetch })
    expect(await mattermost.userByEmail('lead@example.test')).toEqual({ id: 'leadid', username: 'lead' })
    expect(await mattermost.userByEmail('nobody@example.test')).toBeUndefined()
    down = true
    await expect(mattermost.userByEmail('lead@example.test')).rejects.toThrow(/503/)
  })
})
