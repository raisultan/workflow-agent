/**
 * The GitLab connector's contract against the mock GitLab (`T11.7`): every call the workbench makes, through the real connector and
 * the real git transport, over loopback HTTP. If the connector starts asking for something the mock does not serve (or the mock
 * drifts from what the connector reads), this suite fails; a live gitlab.com smoke stays a manual check. Every
 * assertion runs twice: against the plain mock, and with GitLab's own behaviour on (system notes on merge requests, a job log sent
 * whole whatever `Range` asks), which the connector must cope with (review). There are no recorded gitlab.com responses in the
 * repository to replay; the connector's other suites use hand-written fakes.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockGitLab } from '../eval/services/mock-gitlab.ts'
import { createGitTransport } from '../src/sources/git-transport.ts'
import { GitLabConnector } from '../src/sources/gitlab.ts'

const TOKEN = 'mock-token-for-tests-0123456789'
const PROJECT = 'eval/orders'
let dir: string, mock: MockGitLab, gitlab: GitLabConnector
const reviewer = { id: 7, username: 'lead-1', name: 'Lead' }

const MODES = [{ name: 'plain', quirks: {} }, { name: 'with GitLab\'s own behaviour', quirks: { systemNotes: true, ignoreRange: true } }] as const

describe.each(MODES)('the connector against the mock ($name)', ({ quirks }) => {
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mock-gitlab-')))
  mock = new MockGitLab({ root: join(dir, 'repos'), token: TOKEN, quirks })
  await mock.listen()
  mock.createProject(PROJECT, { files: { 'package.json': '{"name":"orders"}\n', 'src/index.js': 'export const x = 1\n' } })
  gitlab = new GitLabConnector({ baseUrl: mock.url, token: TOKEN, maxRetries: 0 })
})
afterEach(async () => {
  await mock.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Clones the project with the workbench's transport, commits a change, and pushes it to `branch`. */
async function pushChange(branch: string, file = 'src/feature.js'): Promise<string> {
  const transport = createGitTransport({ baseUrl: mock.url, token: TOKEN })
  // A second push to a branch continues from its first one's worktree, as a job's next attempt does.
  const worktree = join(dir, `wt-${branch.replace(/\//gu, '-')}`)
  if (!existsSync(worktree)) await transport.clone({ project: PROJECT, directory: worktree })
  writeFileSync(join(worktree, file), `export const feature = ${JSON.stringify(branch)}\n`)
  execFileSync('git', ['add', '-A'], { cwd: worktree })
  execFileSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.test', 'commit', '-qm', 'feature file', '--allow-empty'], { cwd: worktree })
  return (await transport.push({ worktreeDir: worktree, project: PROJECT, branch })).commitSha
}

describe('git over smart HTTP', () => {
  it('clones with the token, pushes a branch, and refuses another token', async () => {
    const transport = createGitTransport({ baseUrl: mock.url, token: TOKEN })
    const { head } = await transport.clone({ project: PROJECT, directory: join(dir, 'clone') })
    expect(head).toBe(mock.branchSha(mock.project(PROJECT)!, 'main'))
    const sha = await pushChange('agent/pay-1-feature')
    expect(mock.branchSha(mock.project(PROJECT)!, 'agent/pay-1-feature')).toBe(sha)
    expect(mock.fileAt(PROJECT, 'agent/pay-1-feature', 'src/feature.js')).toContain('agent/pay-1-feature')
    await expect(createGitTransport({ baseUrl: mock.url, token: 'wrong' }).clone({ project: PROJECT, directory: join(dir, 'denied') })).rejects.toThrow()
  })

  it('refuses the REST API without the token', async () => {
    await expect(new GitLabConnector({ baseUrl: mock.url, token: 'wrong', maxRetries: 0 }).getMergeRequest({ project: PROJECT, mrIid: 1 })).rejects.toThrow(/401/u)
  })
})

describe('merge requests, notes and discussions', () => {
  it('opens, finds, edits and reads a merge request, with its head pipeline', async () => {
    mock.scriptCi(PROJECT, [], { status: 'success' })
    await pushChange('agent/pay-2')
    expect(await gitlab.openMergeRequest(PROJECT, 'agent/pay-2')).toBeUndefined()
    const created = await gitlab.openNewMergeRequest({ project: PROJECT, sourceBranch: 'agent/pay-2', targetBranch: 'main', title: 'PAY-2', description: 'Adds it' })
    expect(created).toEqual({ iid: 1, webUrl: `${mock.url}/${PROJECT}/-/merge_requests/1` })
    expect(await gitlab.openMergeRequest(PROJECT, 'agent/pay-2')).toEqual(created)
    // A second open merge request for the branch is refused as GitLab refuses it: 409, its message an array.
    await expect(gitlab.openNewMergeRequest({ project: PROJECT, sourceBranch: 'agent/pay-2', targetBranch: 'main', title: 'again', description: '' }))
      .rejects.toThrow(/409.*Another open merge request already exists for this source branch: !1/u)
    expect(await gitlab.editMergeRequest({ project: PROJECT, mrIid: 1, title: 'PAY-2: sessions' })).toEqual(created)
    expect(await gitlab.getMergeRequest({ project: PROJECT, mrIid: 1 })).toMatchObject({ iid: 1, title: 'PAY-2: sessions', description: 'Adds it',
      state: 'opened', sourceBranch: 'agent/pay-2', targetBranch: 'main', headPipeline: { status: 'success' } })
  })

  it('posts notes and discussion replies, finds a note by its marker, and lists discussions', async () => {
    await pushChange('agent/pay-3')
    await gitlab.openNewMergeRequest({ project: PROJECT, sourceBranch: 'agent/pay-3', targetBranch: 'main', title: 'PAY-3', description: '' })
    const review = mock.postNote(PROJECT, 1, 'Please add a TTL test', reviewer)
    const discussion = (await gitlab.listDiscussions({ project: PROJECT, mrIid: 1 })).discussions[0]!
    expect(discussion.notes).toEqual([{ id: review.id, author: 'lead-1', body: 'Please add a TTL test', createdAt: review.created_at }])
    const reply = await gitlab.createNote({ project: PROJECT, mrIid: 1, body: 'Added.\n<!-- wb:key-1 -->', discussionId: discussion.id })
    const note = await gitlab.createNote({ project: PROJECT, mrIid: 1, body: 'Summary\n<!-- wb:key-2 -->' })
    expect(await gitlab.findNote({ project: PROJECT, mrIid: 1, marker: 'wb:key-1' })).toEqual(reply)
    expect(await gitlab.findNote({ project: PROJECT, mrIid: 1, marker: 'wb:key-2' })).toEqual(note)
    expect(await gitlab.findNote({ project: PROJECT, mrIid: 1, marker: 'wb:absent' })).toBeUndefined()
    const listed = (await gitlab.listDiscussions({ project: PROJECT, mrIid: 1 })).discussions
    expect(listed.map(entry => entry.notes.map(item => item.author))).toEqual([['lead-1', 'workbench-owner'], ['workbench-owner']])
  })
})

describe('CI', () => {
  it('finds no pipeline for a repository without CI', async () => {
    const sha = await pushChange('agent/no-ci')
    expect(await gitlab.latestPipeline(PROJECT, sha)).toBeUndefined()
  })

  it('runs scripted pipelines per push: a failed one with its failed jobs and their logs, the token redacted, then a passing one', async () => {
    mock.scriptCi(PROJECT, [{ status: 'failed', jobs: [{ name: 'unit', stage: 'test', status: 'failed', log: `${'noise\n'.repeat(500)}export GITLAB_TOKEN=${TOKEN}\nFAIL orders.test.js\n` },
      { name: 'lint', stage: 'test', status: 'success', log: 'ok\n' }] }], { status: 'success' })
    const failedSha = await pushChange('agent/ci')
    const failed = (await gitlab.latestPipeline(PROJECT, failedSha))!
    expect(failed).toMatchObject({ status: 'failed', webUrl: expect.stringContaining('/-/pipelines/') })
    const jobs = await gitlab.failedJobs(PROJECT, failed.id)
    expect(jobs).toEqual([{ id: expect.any(Number), name: 'unit', stage: 'test', webUrl: expect.stringContaining('/-/jobs/') }])
    const tail = await gitlab.jobLogTail(PROJECT, jobs[0]!.id, 200)
    expect(tail).toContain('FAIL orders.test.js')
    expect(tail).not.toContain(TOKEN)
    const fixedSha = await pushChange('agent/ci', 'src/fix.js')
    expect(await gitlab.latestPipeline(PROJECT, fixedSha)).toMatchObject({ status: 'success' })
  })

  it('shows a pipeline running until its scripted delay ends', async () => {
    mock.scriptCi(PROJECT, [{ status: 'success', delayMs: 200 }])
    const sha = await pushChange('agent/slow')
    expect(await gitlab.latestPipeline(PROJECT, sha)).toMatchObject({ status: 'running' })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await gitlab.latestPipeline(PROJECT, sha)).toMatchObject({ status: 'success' })
  })
})

describe('polling bound merge requests', () => {
  it('delivers a person\'s notes (paginated), a failed pipeline, and a merge with a green pipeline, and skips the workbench\'s own notes', async () => {
    mock.scriptCi(PROJECT, [{ status: 'failed' }], { status: 'success' })
    await pushChange('agent/poll')
    await gitlab.openNewMergeRequest({ project: PROJECT, sourceBranch: 'agent/poll', targetBranch: 'main', title: 'Poll', description: '' })
    for (let n = 1; n <= 130; n++) mock.postNote(PROJECT, 1, `note ${n}`, reviewer)
    const own = await gitlab.createNote({ project: PROJECT, mrIid: 1, body: 'from the workbench' })
    const first = await gitlab.poll([{ project: PROJECT, iid: 1 }], undefined, key => key.endsWith(`#note_${own.id}`))
    expect(first.errors).toEqual([])
    const notes = first.triggers.filter(trigger => trigger.id.startsWith('gl_note_'))
    expect(notes).toHaveLength(130)
    expect(notes[0]).toMatchObject({ actor: { source: 'gitlab', id: 'lead-1' }, text: 'note 1', threads: [{ source: 'gitlab', id: `${PROJECT}!mr_1` }] })
    expect(first.triggers.filter(trigger => trigger.id.startsWith('gl_pipe_')).map(trigger => trigger.text)).toEqual([expect.stringMatching(/failed/u)])
    await pushChange('agent/poll', 'src/fixed.js')
    mock.setState(PROJECT, 1, 'merged')
    const second = await gitlab.poll([{ project: PROJECT, iid: 1, checkMergeState: true }], first.nextCursor)
    // GitLab's system notes (`added 1 commit`, `merged`) are never delivered as a person's review.
    expect(second.triggers.map(trigger => trigger.id)).toEqual([`gl_merged_${PROJECT.replace('/', '_')}_1`])
    const discussions = (await gitlab.listDiscussions({ project: PROJECT, mrIid: 1 })).discussions
    expect(discussions.flatMap(entry => entry.notes.map(note => note.body)).some(body => /added 1 commit|merged/u.test(body))).toBe(false)
    expect(mock.branchSha(mock.project(PROJECT)!, 'main')).toBe(mock.branchSha(mock.project(PROJECT)!, 'agent/poll'))
  })

  it('delivers a merge request closed without a merge once, and still reports a later merge', async () => {
    mock.scriptCi(PROJECT, [], { status: 'success' })
    await pushChange('agent/abandon')
    const { iid } = await gitlab.openNewMergeRequest({ project: PROJECT, sourceBranch: 'agent/abandon', targetBranch: 'main', title: 'Abandon', description: '' })
    const watched = [{ project: PROJECT, iid, checkMergeState: true }]
    const open = await gitlab.poll(watched)
    expect(open.triggers.filter(trigger => trigger.id.startsWith('gl_closed_'))).toEqual([])
    mock.setState(PROJECT, iid, 'closed')
    const closed = await gitlab.poll(watched, open.nextCursor)
    expect(closed.triggers.filter(trigger => !trigger.id.startsWith('gl_pipe_'))).toEqual([expect.objectContaining({
      id: `gl_closed_${PROJECT.replace('/', '_')}_${iid}`, threads: [{ source: 'gitlab', id: `${PROJECT}!mr_${iid}` }], meta: expect.objectContaining({ mrState: 'closed' }) })])
    expect(closed.nextCursor.closedMrKeys).toEqual([`${PROJECT}!mr_${iid}`])
    const again = await gitlab.poll(watched, closed.nextCursor)
    expect(again.triggers.filter(trigger => trigger.id.startsWith('gl_closed_'))).toEqual([])
    // Reopened and merged, it is still reported merged.
    mock.setState(PROJECT, iid, 'merged')
    expect((await gitlab.poll(watched, again.nextCursor)).triggers.map(trigger => trigger.id)).toContain(`gl_merged_${PROJECT.replace('/', '_')}_${iid}`)
  })
})
})

describe('the mock in GitLab\'s own mode', () => {
  it('adds system notes and sends a job log whole, so the quirks the suite runs against are real', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mock-gitlab-q-')))
    const quirky = new MockGitLab({ root: join(root, 'repos'), token: TOKEN, quirks: { systemNotes: true, ignoreRange: true } })
    try {
      const url = await quirky.listen()
      quirky.createProject(PROJECT, { ci: { status: 'failed', jobs: [{ name: 'unit', stage: 'test', status: 'failed', log: 'x'.repeat(10_000) }] } })
      const transport = createGitTransport({ baseUrl: url, token: TOKEN })
      const worktree = join(root, 'wt')
      await transport.clone({ project: PROJECT, directory: worktree })
      writeFileSync(join(worktree, 'a.txt'), 'a\n')
      execFileSync('git', ['add', '-A'], { cwd: worktree })
      execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@example.test', 'commit', '-qm', 'a'], { cwd: worktree })
      await transport.push({ worktreeDir: worktree, project: PROJECT, branch: 'agent/pay-9-quirks' })
      const client = new GitLabConnector({ baseUrl: url, token: TOKEN, maxRetries: 0 })
      await client.openNewMergeRequest({ project: PROJECT, sourceBranch: 'agent/pay-9-quirks', targetBranch: 'main', title: 'Q', description: '' })
      await client.editMergeRequest({ project: PROJECT, mrIid: 1, title: 'Q2' })
      const raw = await (await fetch(`${url}/api/v4/projects/${encodeURIComponent(PROJECT)}/merge_requests/1/notes`, { headers: { 'PRIVATE-TOKEN': TOKEN } })).json() as { system: boolean }[]
      expect(raw.filter(note => note.system)).toHaveLength(1)
      const pipeline = (await client.latestPipeline(PROJECT, quirky.branchSha(quirky.project(PROJECT)!, 'agent/pay-9-quirks')!))!
      const job = (await client.failedJobs(PROJECT, pipeline.id))[0]!
      const trace = await fetch(`${url}/api/v4/projects/${encodeURIComponent(PROJECT)}/jobs/${job.id}/trace`, { headers: { 'PRIVATE-TOKEN': TOKEN, Range: 'bytes=-100' } })
      expect([trace.status, (await trace.text()).length]).toEqual([200, 10_000])
    } finally {
      await quirky.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
