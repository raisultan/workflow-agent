/**
 * Safe-output tools (`T9.3`): requests checked against the job's scope, submitted as action commands, and answered with the
 * write's result, or `queued` with a later notice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeOutputTools, TOOLS } from '../src/adapters/safe-output.ts'
import type { StageTool } from '../src/adapters/stage-runner.ts'
import type { ActionPayload, AttemptPayload } from '../src/domain/job.ts'
import type { EffectResult } from '../src/kernel/effects.ts'
import { Harness, LEAD } from './fixtures/domain-workflow.ts'

let h: Harness
const writes: ActionPayload[] = []
let hold: Promise<void> | undefined
beforeEach(() => {
  h = new Harness({ without: ['action'] })
  writes.length = 0
  hold = undefined
  h.wb.kernel.effects.register<ActionPayload>('action', { idempotent: true, limit: () => 4, run: async (payload): Promise<EffectResult> => {
    writes.push(payload)
    await hold
    return { ok: payload.action === 'gitlab.createMr' ? { mrIid: 7, bind: 'gitlab:group/app!7' } : { done: payload.action } }
  } })
})
afterEach(() => { h.cleanup() })

const SHA = 'b'.repeat(40)
const deps = (awaitMs = 2000) => ({ workbench: h.wb, repository: () => 'group/app', headSha: async () => SHA, awaitMs })
const toolsOf = (job: string, awaitMs?: number) => {
  const state = h.state(job)
  const attempt = { jobId: job, manifestId: state.manifestId, attemptId: state.attempt!.id, stageId: state.attempt!.stageId } as AttemptPayload
  return new Map(safeOutputTools(deps(awaitMs))(attempt, 'session-1').map(tool => [tool.name, tool]))
}
const notes: string[] = []
let calls = 0
/** Runs a tool while the kernel dispatches, as it would in the runtime. */
async function call(tool: StageTool, args: unknown): Promise<unknown> {
  const running = tool.execute(args, { id: `c${++calls}`, signal: new AbortController().signal, notify: text => { notes.push(text) } })
  running.catch(() => {})
  // Dispatch without waiting on it: a held write keeps a dispatch pass open.
  for (let pass = 0; pass < 5; pass++) { await new Promise(resolve => setTimeout(resolve, 5)); void h.wb.kernel.effects.dispatch() }
  return running
}

describe('safe-output tools', () => {
  it('gives a stage only the tools of its capabilities', async () => {
    const job = await h.start()
    expect([...toolsOf(job).keys()]).toEqual([])
    await h.complete(job, { findings: 'ok' })
    await h.complete(job, {}, 'Plan r1')
    await h.say(LEAD, 'ok')
    expect([...toolsOf(job).keys()]).toEqual(['gitlab_create_mr', 'gitlab_push_branch'])
  })

  it('pushes the worktree\'s commit to an agent branch in the job\'s repository, and opens an MR the job then follows', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    const tools = toolsOf(job)
    expect(await call(tools.get('gitlab_push_branch')!, { branch: 'agent/sessions' })).toEqual({ done: 'gitlab.push' })
    expect(writes[0]).toMatchObject({ action: 'gitlab.push', payload: { project: 'group/app', branch: 'agent/sessions', sha: SHA } })
    expect(await call(tools.get('gitlab_create_mr')!, { sourceBranch: 'agent/sessions', title: 'Sessions' })).toEqual({ mrIid: 7, bind: 'gitlab:group/app!7' })
    expect(writes[1]!.payload).toEqual({ project: 'group/app', sourceBranch: 'agent/sessions', targetBranch: 'main', title: 'Sessions', description: '' })
    expect(h.state(job).bindings).toContainEqual({ threadKey: 'gitlab:group/app!7', role: 'artifact' })
  })

  it('refuses another repository, a protected branch, and a branch another job uses', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    const push = toolsOf(job).get('gitlab_push_branch')!
    await expect(call(push, { project: 'other/app', branch: 'agent/x-y' })).rejects.toThrow('GitLab writes are limited to this job\'s repository (group/app)')
    await expect(call(push, { branch: 'main' })).rejects.toThrow()
    await call(push, { branch: 'agent/shared' })
    const other = await h.start('@workbench another', 'mattermost:ch1:p2')
    await h.complete(other, { findings: 'ok' })
    await h.complete(other, {}, 'Plan')
    await h.say(LEAD, 'ok', { thread: 'mattermost:ch1:p2' })
    await expect(call(toolsOf(other).get('gitlab_push_branch')!, { branch: 'agent/shared' })).rejects.toThrow(`already used by another job (${job})`)
    expect(writes).toHaveLength(1)
  })

  it('answers queued when the write takes longer than the wait, then notifies the session of its result', async () => {
    const job = await h.toApproval()
    await h.say(LEAD, 'ok')
    let release!: () => void
    hold = new Promise(resolve => { release = resolve })
    const answer = await call(toolsOf(job, 20).get('gitlab_push_branch')!, { branch: 'agent/slow' })
    expect(answer).toMatchObject({ queued: true, effectId: expect.any(String) })
    release()
    for (let pass = 0; pass < 20 && notes.length === 0; pass++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(notes.at(-1)).toMatch(/gitlab_push_branch request .* finished: \{"done":"gitlab.push"\}/u)
  })
})

describe('scope rules', () => {
  const scope = (bound: string[], extra: { createdChannels?: string[]; origin?: string } = {}) => ({
    jobId: 'job_1', state: { originThread: extra.origin ?? 'mattermost:ch1:p1' }, bound: new Set(bound), repository: 'group/app',
    createdChannels: new Set(extra.createdChannels ?? []), branchOwner: () => undefined,
  }) as never

  it('keeps Jira writes to the job\'s own issue', () => {
    const comment = TOOLS['jira.comment']
    expect(comment.payload({ body: 'Plan' } as never, scope(['jira:PAY-1']), deps())).toEqual({ issueKey: 'PAY-1', body: 'Plan' })
    expect(() => comment.payload({ issueKey: 'PAY-2', body: 'x' } as never, scope(['jira:PAY-1']), deps())).toThrow('PAY-2 is out of scope')
    expect(() => comment.payload({ body: 'x' } as never, scope([]), deps())).toThrow('This job has no Jira issue')
  })

  it('keeps Mattermost posts to the job\'s threads, new threads in its channels, and channels it created', () => {
    const post = TOOLS['mattermost.post']
    const own = scope(['mattermost:ch1:p1'], { createdChannels: ['war'] })
    expect(post.payload({ text: 'hi' } as never, own, deps())).toEqual({ thread: 'mattermost:ch1:p1', text: 'hi' })
    expect(post.payload({ channelId: 'ch1', text: 'new thread' } as never, own, deps())).toEqual({ thread: 'mattermost:ch1:', text: 'new thread' })
    expect(post.payload({ channelId: 'war', text: 'kick-off' } as never, own, deps())).toEqual({ thread: 'mattermost:war:', text: 'kick-off' })
    expect(() => post.payload({ thread: 'mattermost:ch1:other', text: 'x' } as never, own, deps())).toThrow('out of scope')
    expect(() => post.payload({ channelId: 'random', text: 'x' } as never, own, deps())).toThrow('out of scope')
  })

  it('changes only merge requests bound to the job, and branches named for its issue', () => {
    expect(() => TOOLS['gitlab.updateMr'].payload({ mrIid: 8, title: 't' } as never, scope(['gitlab:group/app!7']), deps())).toThrow('!8 in group/app is not this job\'s')
    expect(TOOLS['gitlab.reply'].payload({ mrIid: 7, body: 'Fixed' } as never, scope(['gitlab:group/app!7']), deps()))
      .toEqual({ project: 'group/app', mrIid: 7, body: 'Fixed' })
    expect(() => TOOLS['gitlab.createMr'].payload({ sourceBranch: 'agent/other-task', title: 't', description: '' } as never, scope(['jira:PAY-1']), deps()))
      .toThrow('must start with agent/pay-1-')
  })
})
