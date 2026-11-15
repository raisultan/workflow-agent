/**
 * The stage runner (`T9.4`) on a fake DSH surface: a fresh session per attempt under the stage's presets and model, the report as
 * a job command, usage into budgets, reminders, cancel, steering, and a failed setup that the job retries.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attemptSessionId, StageRunner } from '../src/adapters/stage-runner.ts'
import { ANNA, Harness } from './fixtures/domain-workflow.ts'
import { FakeDsh } from './fixtures/fake-dsh.ts'

let h: Harness
let dsh: FakeDsh
let runner: StageRunner
let workspaceError: Error | undefined
const stopped: string[] = []

beforeEach(() => {
  h = new Harness({ without: ['stage.attempt', 'stage.steer'] })
  dsh = new FakeDsh()
  workspaceError = undefined
  stopped.length = 0
  runner = new StageRunner({ ctx: dsh.ctx, workbench: h.wb, maxWorkers: () => 2, workTools: ['read', 'write', 'bash', 'grep'], turnStartGraceMs: 50,
    prepareWorkspace: async jobId => { if (workspaceError) throw workspaceError; return `/work/${jobId}` },
    stopWork: async sessionId => { stopped.push(sessionId) } })
  h.wb.kernel.effects.register('stage.attempt', runner.handler())
  h.wb.kernel.effects.register('stage.steer', runner.steerHandler())
})
afterEach(() => { h.cleanup() })

/** Waits until `condition` holds, dispatching effects meanwhile. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (condition()) return
    await h.wb.kernel.effects.dispatch()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('stage attempts on DSH', () => {
  it('prepares the job\'s sandbox, names the job of the attempt\'s session, and confines file tools to the worktree (T10.3)', async () => {
    const sandboxes: unknown[] = []
    h.cleanup()
    h = new Harness({ without: ['stage.attempt', 'stage.steer'] })
    runner = new StageRunner({ ctx: dsh.ctx, workbench: h.wb, maxWorkers: () => 2, workTools: ['read', 'write', 'bash', 'grep'], turnStartGraceMs: 50,
      prepareWorkspace: async jobId => `/work/${jobId}`, prepareSandbox: (jobId, sandbox) => { sandboxes.push({ jobId, ...sandbox }) },
      skillRoots: ['/opt/skills'] })
    h.wb.kernel.effects.register('stage.attempt', runner.handler())
    const seen: Record<string, unknown> = {}
    dsh.script = async ({ agent, text }) => {
      if (!text.includes('# Stage: Inspect')) return
      seen.job = runner.jobOfSession(agent.id)
      seen.other = runner.jobOfSession('another-session')
      seen.inside = await agent.call('read', { file_path: 'src/auth.ts' })
      seen.credentials = await agent.call('read', { file_path: '/var/lib/workbench/dsh/.credentials.yaml' })
      seen.environ = await agent.call('read', { file_path: '/proc/self/environ' })
      seen.sibling = await agent.call('write', { file_path: '../job_other/x.ts', content: '' })
      seen.skill = await agent.call('read', { file_path: '/opt/skills/jira/SKILL.md' })
      seen.writeSkill = await agent.call('write', { file_path: '/opt/skills/jira/SKILL.md', content: '' })
      await agent.call('workbench_stage_report', { outcome: 'completed', summary: 's', output: { findings: 'f' } })
    }
    const job = await h.start()
    await until(() => h.state(job).attempt?.stageId === 'plan', 'the plan stage')
    expect(sandboxes[0]).toEqual({ jobId: job, worktree: `/work/${job}`, egress: 'none' })
    expect(seen.job).toBe(job)
    expect(seen.other).toBeUndefined()
    expect(seen.inside).toEqual({ value: { ran: 'read', args: { file_path: 'src/auth.ts' } } })
    expect(seen.credentials).toEqual({ error: expect.stringContaining('/var/lib/workbench/dsh/.credentials.yaml is outside this job\'s worktree') })
    expect(seen.environ).toEqual({ error: expect.stringContaining('outside this job\'s worktree') })
    expect(seen.sibling).toEqual({ error: expect.stringContaining('may write only inside the job\'s worktree') })
    expect(seen.skill).toEqual({ value: expect.objectContaining({ ran: 'read' }) })
    expect(seen.writeSkill).toEqual({ error: expect.stringContaining('may write only') })
  })

  it('runs an attempt in a fresh session under the stage\'s presets and model, and turns its report into the job\'s next step', async () => {
    let allowed: string[] | undefined, first: string | undefined, reported: unknown
    // The scripted model acts in the inspect session only; later stages' sessions stay idle.
    dsh.script = async ({ agent, text }) => {
      if (!text.includes('# Stage: Inspect')) return
      first = text
      allowed = agent.allowed
      agent.usage(1200, 300)
      reported = await agent.call('workbench_stage_report', { outcome: 'completed', summary: 'Found the auth module', output: { findings: 'auth/' } })
    }
    const job = await h.start()
    const firstAttempt = h.attempt(job)
    await until(() => h.state(job).attempt?.stageId === 'plan', 'the plan stage')
    const session = attemptSessionId(firstAttempt)
    expect(first).toContain('# Request\n@workbench add sessions')
    expect(first).toContain('# Stage: Inspect (attempt 1, initial)')
    expect(reported).toEqual({ value: { accepted: true } })
    expect(dsh.created[0]).toEqual({ sessionId: session, workspaceId: `ws:/work/${job}`, agentPreset: 'inspector' })
    expect(dsh.permissions.get(session)).toBe('readonly')
    expect(dsh.agents.get(session)!.selected).toEqual({ provider: 'litellm', model: 'deepseek-flash' })
    expect(dsh.agents.get(session)!.sections[0]!.text()).toBe('Inspect the request.')
    // During the turn the session had only its preset's work tools and the report tool; the restriction ends with the attempt.
    expect(allowed).toEqual(['read', 'write', 'bash'])
    expect(dsh.agents.get(session)!.allowed).toBeUndefined()
    expect(h.state(job).usage).toEqual({ turns: 1, tokens: 1500 })
    await until(() => dsh.archived.includes(session), 'the archive')
    expect(stopped).toContain(session)
    // The next stage runs in a new session of its own.
    await until(() => dsh.created.length === 2, 'the plan session')
    expect(dsh.created[1]).toMatchObject({ sessionId: attemptSessionId(`${job}.a2`), agentPreset: 'planner' })
  })

  it('returns a refused report to the model as the tool\'s error, and takes the corrected one', async () => {
    const errors: (string | undefined)[] = []
    dsh.script = async ({ agent, text }) => {
      if (!text.includes('# Stage: Inspect')) return
      errors.push((await agent.call('workbench_stage_report', { outcome: 'completed', summary: 'x', output: { findings: 7 } })).error)
      errors.push((await agent.call('workbench_stage_report', { outcome: 'completed', summary: 'x', output: { findings: 'seven' } })).error)
      errors.push((await agent.call('read', {})).error)
    }
    const job = await h.start()
    await until(() => h.state(job).attempt?.stageId === 'plan', 'the plan stage')
    expect(errors[0]).toContain('does not match stage inspect')
    expect(errors[1]).toBeUndefined()
    // After its report, the attempt's session changes nothing more.
    expect(errors[2]).toBe('This stage attempt has ended')
  })

  it('reminds a turn that ends without a report twice, then ends the attempt and the job retries it', async () => {
    dsh.script = () => {}
    const job = await h.start()
    const first = h.attempt(job)
    await until(() => h.state(job).attempt?.id !== first, 'a retry')
    const agent = dsh.agents.get(attemptSessionId(first))!
    expect(agent.delivered).toHaveLength(3)
    expect(agent.delivered[1]).toContain('without `workbench_stage_report`')
    expect(h.state(job).attempt).toMatchObject({ entry: 'retry', n: 2 })
  })

  it('stops a running attempt the job cancels, and steers a follow-up into it', async () => {
    let release!: () => void
    dsh.script = ({ index }) => index === 0 ? new Promise<void>(resolve => { release = resolve }) : undefined
    const job = await h.start()
    const first = h.attempt(job)
    await until(() => dsh.agents.get(attemptSessionId(first))?.status === 'running', 'the running turn')
    await h.say(ANNA, 'also handle logout')
    await until(() => dsh.agents.get(attemptSessionId(first))!.steered.length === 1, 'the steer')
    expect(dsh.agents.get(attemptSessionId(first))!.steered).toEqual(['also handle logout'])
    // Going over the stage's turn limit stops the attempt.
    h.wb.usage(job, first, { session: 's', id: 'u' }, { turns: 25, tokens: 10 })
    await until(() => dsh.agents.get(attemptSessionId(first))!.cancelled > 0, 'the cancel')
    release()
    await until(() => h.state(job).attempt?.id !== first && dsh.archived.includes(attemptSessionId(first)), 'the next attempt')
    expect(h.state(job).attempt).toMatchObject({ entry: 'retry' })
  })

  it('fails an attempt whose workspace cannot be prepared, so the job retries it within its budget', async () => {
    workspaceError = new Error('clone failed: no access')
    const job = await h.start()
    await until(() => h.state(job).status.kind === 'blocked', 'the block')
    expect(h.state(job).status).toMatchObject({ kind: 'blocked', reason: { kind: 'attempts', stageId: 'inspect' } })
    expect(h.wb.kernel.engine.events(job).filter(event => event.type === 'AttemptFailed').map(event => (event as { reason: string }).reason))
      .toEqual(['clone failed: no access', 'clone failed: no access', 'clone failed: no access'])
  })
})
