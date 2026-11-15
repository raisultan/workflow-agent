/**
 * The domain under random crashes (`T8.11`, `G8`), on the `T7.12` harness's crash points. Each run drives the delivery workflow on a
 * real database through random steps: mentions, replies and commands in RU/EN from eligible and ineligible people, stage reports
 * for whatever stage is running, usage, safe-output requests, handler outcomes, clock jumps, crashes and restarts. After every step
 * and after a final drain it checks that:
 * - every job's stored state equals the fold of its events, and its status agrees with its attempts and gates;
 * - no post was written twice, and no approval happened without an admitted reply from an approver after the gate's post;
 * - the routing projections match the jobs' states, and rebuilding them changes nothing;
 * - every inbox event was consumed, and nothing is left to run after the drain except stage attempts;
 * - (`T11.1`, `T11.4`) a job with a repository runs no stage before its setup step completes, has one setup effect for its current
 *   run, and a mention naming no repository (`repo:nope`) starts no job and is settled with exactly one notice, written once.
 */
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AttemptPayload, InterpretPayload, JobEvent, JobState, NoticePayload, PostPayload, SetupPayload, Verdict } from '../src/domain/job.ts'
import { RepositoryProfileSchema, repositoryParameters } from '../src/domain/repositories.ts'
import { Workbench } from '../src/domain/workbench.ts'
import type { EffectResult } from '../src/kernel/effects.ts'
import { testEnv } from '../src/kernel/env.ts'
import { ANNA, basePolicy, delivery, EVE, LEAD, PROFILE, reviewApproved } from './fixtures/domain-workflow.ts'

type Point = 'beforeCommit' | 'afterCommit' | 'inHandler' | 'afterHandler' | 'duringRecovery'
type Run = 'ok' | 'retry' | 'fail' | 'unknown' | 'throw'
type Report = 'complete' | 'approve' | 'reject' | 'question' | 'backtrack' | 'failed' | 'blocked'
type Step =
  /** A mention: on the default repository, naming none (`repo:nope`), or naming one only `lead` may use (`repo:scoped`). */
  | { t: 'start'; thread: number; target: 'default' | 'nope' | 'scoped'; who: number }
  /** Ends a running setup step: passed, or blocked by the environment. */
  | { t: 'setup'; pass: boolean }
  | { t: 'say'; who: number; text: number; thread: number; routeNow: boolean }
  | { t: 'report'; job: number; report: Report; call: number }
  | { t: 'usage'; job: number; turns: number }
  | { t: 'action'; job: number }
  | { t: 'end'; job: number }
  | { t: 'checks'; pass: boolean }
  | { t: 'dispatch'; runs: Run[] }
  | { t: 'advance'; ms: number }
  | { t: 'crash'; point: Point }
  | { t: 'restart' }

const PEOPLE = [ANNA, LEAD, EVE]
const TEXTS = ['ok', 'LGTM', 'Ок, но добавь индекс', 'why redis?', 'hmm', 'стоп', 'повтори', '1: redis', '@workbench do it', 'sure, I guess?']
const VERDICTS: Record<string, Verdict> = {
  'Ок, но добавь индекс': { verdict: 'request_changes', notes: 'add an index', confidence: 0.9 },
  'why redis?': { verdict: 'question', confidence: 0.9 },
  'sure, I guess?': { verdict: 'approve', confidence: 0.5, reading: 'you may approve' },
}
const THREADS = ['mattermost:t0', 'mattermost:t1', 'gitlab:group/app!1']

/** The steps; `withRepository` adds the setup step's ending and starts that name a repository (`T11.1`, `T11.4`). */
const steps = (repository: boolean): fc.Arbitrary<Step> => fc.oneof(
  { weight: 2, arbitrary: repository ? fc.record({ t: fc.constant('start' as const), thread: fc.nat(1),
    target: fc.oneof({ weight: 6, arbitrary: fc.constant('default' as const) }, fc.constantFrom('nope' as const, 'scoped' as const)),
    who: fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, fc.constant(1)) })
    : fc.record({ t: fc.constant('start' as const), thread: fc.nat(1) }).map(start => ({ ...start, target: 'default' as const, who: 0 })) },
  ...repository ? [{ weight: 3, arbitrary: fc.record({ t: fc.constant('setup' as const), pass: fc.oneof({ weight: 9, arbitrary: fc.constant(true) }, fc.constant(false)) }) }] : [],
  { weight: 5, arbitrary: fc.record({ t: fc.constant('say' as const),
    // Mostly the approver, mostly approvals, mostly on the first job's thread, so runs get past their gates.
    who: fc.oneof({ weight: 3, arbitrary: fc.constant(1) }, fc.constantFrom(0, 2)),
    text: fc.oneof({ weight: 4, arbitrary: fc.constantFrom(0, 1) }, { weight: 2, arbitrary: fc.constantFrom(2, 5) }, fc.nat(TEXTS.length - 1)),
    thread: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, fc.nat(2)), routeNow: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, fc.constant(false)) }) },
  { weight: 8, arbitrary: fc.record({ t: fc.constant('report' as const), job: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, fc.constant(1)), call: fc.nat(6),
    report: fc.oneof({ weight: 8, arbitrary: fc.constantFrom<Report>('complete', 'approve') }, fc.constantFrom<Report>('reject', 'question', 'backtrack', 'failed', 'blocked')) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('usage' as const), job: fc.nat(1), turns: fc.integer({ min: 1, max: 30 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('action' as const), job: fc.nat(1) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('end' as const), job: fc.nat(1) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('checks' as const), pass: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('dispatch' as const), runs: fc.array(fc.oneof({ weight: 6, arbitrary: fc.constant('ok' as const) },
    fc.constantFrom<Run>('retry', 'fail', 'unknown', 'throw')), { maxLength: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('advance' as const), ms: fc.constantFrom(1000, 60_000, 700_000, 3_700_000, 90_000_000) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('crash' as const), point: fc.constantFrom<Point>('beforeCommit', 'afterCommit', 'inHandler', 'afterHandler', 'duringRecovery') }) },
  { weight: 1, arbitrary: fc.constant({ t: 'restart' as const }) },
)

class Crash extends Error {}
const fired: Record<Point, number> = { beforeCommit: 0, afterCommit: 0, inHandler: 0, afterHandler: 0, duringRecovery: 0 }
/** How often the runs reached the paths that matter, so the suite fails if the steps stop exercising one. */
const reachedPlain: Record<string, number> = { approved: 0, changesRequested: 0, completed: 0, blocked: 0, extended: 0, backtracked: 0, restated: 0,
  refused: 0, cancelled: 0, retried: 0, recovered: 0 }
const reachedRepository: Record<string, number> = { approved: 0, setUp: 0, setupBlocked: 0, setupRerun: 0, noticed: 0, scopedJob: 0, scopedRefused: 0 }
/** Which property runs: the delivery workflow with no repository, or in one (`T11.1`, `T11.4`). */
let withRepository = false
let reached: Record<string, number> = reachedPlain
const count = (path: string) => { if (path in reached) reached[path]!++ }
/** The deployment's one repository, the default; the delivery workflow works in it, so every job sets up first. */
const REPOSITORY = RepositoryProfileSchema.parse({ name: 'app', project: 'group/app', testCommand: 'npm test', default: true })
/** A repository only `lead` may start jobs on (`D10`, 2026-11-12). */
const SCOPED = RepositoryProfileSchema.parse({ name: 'scoped', project: 'group/scoped', testCommand: 'npm test', senders: { mattermost: ['lead'] } })
const deliveryInRepository = () => { const spec = delivery(); return { ...spec, declaration: { ...spec.declaration, repository: true } } }

async function check(steps: readonly Step[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'domain-props-'))
  const path = join(dir, 'workbench.sqlite')
  const env = testEnv(11)
  const policy = basePolicy()
  const writes = new Map<string, number>()
  const violations: string[] = []
  const runs: Run[] = []
  const running = new Map<string, { payload: AttemptPayload; end: (result: EffectResult) => void }>()
  const setups = new Map<string, (result: EffectResult) => void>()
  let checksPass = true
  let armed: Point | undefined
  let dead = false
  let counter = 0
  const crashAt = (point: Point) => { if (armed === point) { armed = undefined; dead = true; fired[point]++; throw new Crash(point) } }
  const outcome = (): Run => runs.shift() ?? 'ok'
  const flaky = async <T>(work: () => T): Promise<EffectResult> => {
    const run = outcome()
    if (run === 'retry') return { retry: { reason: 'busy', afterMs: 50 } }
    if (run === 'fail') return { fail: 'refused' }
    if (run === 'throw') throw new Error('connection reset')
    const result = work()
    crashAt('inHandler')
    return run === 'unknown' ? { unknown: 'timeout after the write' } : { ok: result }
  }

  const open = () => {
    dead = false
    running.clear()
    setups.clear()
    const wb = new Workbench({ path, env, profile: PROFILE, policy: () => policy, kernel: { baseBackoffMs: 50, maxBackoffMs: 200 },
      ...withRepository ? { repositories: [REPOSITORY, SCOPED], parameters: (_id: string, repository: typeof REPOSITORY | undefined) => repository ? repositoryParameters(repository) : {} } : {} })
    wb.register(withRepository ? deliveryInRepository() : delivery())
    wb.registerGuard('review.approved', reviewApproved)
    const { db } = wb.kernel
    const run = db.run.bind(db), get = db.get.bind(db), all = db.all.bind(db), tx = db.tx.bind(db)
    const alive = () => { if (dead) throw new Crash('dead') }
    Object.assign(db, {
      run: (sql: string, ...params: never[]) => {
        alive()
        if (sql.startsWith('INSERT INTO consumed_origin')) crashAt('beforeCommit')
        if (sql.startsWith("UPDATE effect SET status = 'succeeded'")) crashAt('afterHandler')
        // Inside intake's transaction for a mention that starts no job, before the notice is queued.
        if (sql.startsWith('INSERT INTO effect') && sql.includes('VALUES (?, NULL')) crashAt('beforeCommit')
        return run(sql, ...params)
      },
      get: (sql: string, ...params: never[]) => { alive(); return get(sql, ...params) },
      all: (sql: string, ...params: never[]) => { alive(); return all(sql, ...params) },
      tx: <T>(fn: () => T) => { alive(); return tx(fn) },
    })
    const wake = wb.kernel.wake.bind(wb.kernel)
    wb.kernel.wake = () => { crashAt('afterCommit'); wake() }
    const { effects } = wb.kernel
    effects.register<AttemptPayload>('stage.attempt', {
      idempotent: true, long: true, limit: () => 2,
      run: payload => new Promise(resolve => { running.set(payload.attemptId, { payload, end: resolve }) }),
      cancel: async payload => { running.get(payload.attemptId)?.end({ ok: { stopped: true } }); running.delete(payload.attemptId) },
    })
    // Posts are not idempotent, as on the real services: an unknown outcome is reconciled by key.
    effects.register<PostPayload>('post', {
      idempotent: false, limit: () => 2,
      run: (_payload, key) => flaky(() => { writes.set(key, (writes.get(key) ?? 0) + 1); return { postId: key, postedAt: env.clock.now() } }),
      reconcile: async (_payload, key) => writes.has(key) ? { found: { postId: key, postedAt: env.clock.now() } } : { absent: true },
    })
    effects.register<SetupPayload>('setup', {
      idempotent: true, long: true, limit: () => 2,
      run: payload => new Promise(resolve => { setups.set(`${payload.jobId}#${payload.n}`, resolve) }),
      cancel: async payload => { setups.get(`${payload.jobId}#${payload.n}`)?.({ fail: 'cancelled' }); setups.delete(`${payload.jobId}#${payload.n}`) },
    })
    effects.register<NoticePayload>('notice', {
      idempotent: false, limit: () => 2,
      run: (_payload, key) => flaky(() => { writes.set(key, (writes.get(key) ?? 0) + 1); return { postId: key } }),
      reconcile: async (_payload, key) => writes.has(key) ? { found: { postId: key } } : { absent: true },
    })
    effects.register<InterpretPayload>('interpretReply', { idempotent: true, limit: () => 2,
      run: payload => flaky(() => VERDICTS[payload.text] ?? { verdict: 'unclear', confidence: 0.9, reading: 'unclear' }) })
    effects.register('check', { idempotent: true, limit: () => 2, run: () => flaky(() => ({ outcome: checksPass ? 'passed' : 'failed', evidence: 'log' })) })
    effects.register('stage.steer', { idempotent: true, limit: () => 2, run: () => flaky(() => ({})) })
    effects.register<{ action: string }>('action', { idempotent: true, limit: () => 2, run: () => flaky(() => ({ bind: THREADS[2] })) })
    return wb
  }
  const restart = (previous?: Workbench) => {
    try { previous?.close() } catch { /* a dead process's database */ }
    for (;;) {
      const wb = open()
      try {
        wb.kernel.recover({ route: event => { crashAt('duringRecovery'); wb.handle(event) }, active: status => !['completed', 'failed', 'cancelled'].includes(status) })
        return wb
      } catch (error) {
        if (!(error instanceof Crash)) throw error
        wb.close()
      }
    }
  }

  const jobs = (wb: Workbench) => wb.kernel.db.all<{ id: string }>('SELECT id FROM job ORDER BY created_at, id').map(row => row.id)
  const state = (wb: Workbench, id: string) => wb.kernel.engine.job(id)!.state
  const reportFor = (s: JobState, kind: Report): { report: Record<string, unknown>; artifact?: { text: string } } => {
    const stage = s.attempt!.stageId
    switch (kind) {
      case 'question': return { report: { outcome: 'question', items: [{ text: 'Which store?' }] } }
      case 'backtrack': return { report: { outcome: 'backtrack', to: stage === 'plan' ? 'inspect' : 'plan', reason: 'requirements changed' } }
      case 'failed': return { report: { outcome: 'failed', reason: 'flaky tool' } }
      case 'blocked': return { report: { outcome: 'blocked', reason: 'no access' } }
      default: {
        const output = stage === 'inspect' ? { findings: 'x' } : stage === 'review' ? { approved: kind !== 'reject' } : {}
        return { report: { outcome: 'completed', summary: 'done', output }, ...stage === 'plan' ? { artifact: { text: `Plan ${kind}` } } : {} }
      }
    }
  }

  const observe = (wb: Workbench) => {
    const { db, engine } = wb.kernel
    for (const [key, count] of writes) if (count > 1) violations.push(`post ${key} was written ${count} times`)
    const open = new Set<string>()
    for (const id of jobs(wb)) {
      const job = engine.job(id)!
      const s = job.state
      if (JSON.stringify(engine.foldedState(id)) !== JSON.stringify(s)) violations.push(`job ${id} state differs from the fold of its events`)
      if (job.status === 'faulted') violations.push(`job ${id} faulted`)
      const gates = Object.values(s.gates).filter(gate => gate.status === 'open')
      for (const gate of gates) open.add(gate.id)
      if (gates.length > 1) violations.push(`job ${id} has ${gates.length} open gates`)
      const { status } = s
      if (status.kind === 'running' && (s.attempt?.id !== status.attemptId || s.attempt.ended)) violations.push(`job ${id} runs an ended attempt`)
      if ((status.kind === 'awaiting_gate' || status.kind === 'blocked') && s.gates[status.gateId]?.status !== 'open') violations.push(`job ${id} waits on a closed gate`)
      if (['completed', 'failed', 'cancelled'].includes(status.kind) && gates.length > 0) violations.push(`ended job ${id} has an open gate`)
      // Every admitted reply came from an eligible person, on the gate's thread, after the gate's post.
      for (const gate of Object.values(s.gates)) {
        for (const response of gate.responses.filter(candidate => candidate.accepted)) {
          const inbound = db.get<{ thread_key: string; payload: string }>('SELECT thread_key, payload FROM inbox_event WHERE id = ?', response.eventId)!
          const postedAt = (JSON.parse(inbound.payload) as { postedAt: number }).postedAt
          if (!['anna', 'lead'].includes(response.actor.id) || inbound.thread_key !== gate.threadKey || gate.postedAt === undefined || postedAt <= gate.postedAt) {
            violations.push(`gate ${gate.id} admitted ${JSON.stringify(response)} posted at ${postedAt} on ${inbound.thread_key}`)
          }
        }
      }
      const events = engine.events(id) as JobEvent[]
      // A gate is satisfied only by a reply whose text approves: a standalone approval, or a retry on a resume gate.
      const responded = events.filter(event => event.type === 'GateResponded')
      for (const event of events) {
        if (event.type !== 'GateClosed' || event.status !== 'satisfied') continue
        const gate = s.gates[event.gateId]!
        const last = responded.filter(candidate => candidate.gateId === gate.id && candidate.response.accepted).at(-1)
        if (!last || !(['ok', 'LGTM'].includes(last.text ?? '') || (gate.kind === 'resume' && last.text === 'повтори'))) {
          violations.push(`gate ${gate.id} was satisfied by ${JSON.stringify(last)}`)
        }
      }
      // A job on a repository with its own senders was started by one of them.
      const repository = wb.workflow(s.manifestId).extra.repository
      if (repository?.senders && s.requester && !(repository.senders[s.requester.source] ?? []).includes(s.requester.id)) {
        violations.push(`job ${id} on ${repository.name} was started by ${s.requester.id}, whom its senders do not list`)
      }
      // No stage before the setup step completes; one setup effect for the run the job waits on.
      const firstAttempt = events.findIndex(event => event.type === 'AttemptStarted')
      if (withRepository && firstAttempt !== -1 && !events.slice(0, firstAttempt).some(event => event.type === 'SetupCompleted')) violations.push(`job ${id} started a stage before its setup`)
      if (status.kind === 'setting_up') {
        const live = db.get<{ n: number }>(`SELECT count(*) AS n FROM effect WHERE job_id = ? AND kind = 'setup' AND status IN ('pending', 'running', 'unknown')
          AND json_extract(payload, '$.n') = ?`, id, status.n)!.n
        if (live !== 1) violations.push(`job ${id} sets up (run ${status.n}) with ${live} live setup effects`)
      }
      const reports = new Map<string, number>()
      for (const event of events) if (event.type === 'AttemptReported') reports.set(event.attemptId, (reports.get(event.attemptId) ?? 0) + 1)
      for (const [attemptId, count] of reports) if (count > 1) violations.push(`attempt ${attemptId} reported ${count} times`)
    }
    // A mention naming no repository starts no job, and is settled with exactly one notice unless a job's thread took it.
    for (const row of withRepository ? db.all<{ id: string; status: string; payload: string }>("SELECT id, status, payload FROM inbox_event WHERE payload LIKE '%repo:nope%'") : []) {
      const notices = db.get<{ n: number }>("SELECT count(*) AS n FROM effect WHERE kind = 'notice' AND job_id IS NULL AND idempotency_key = ?", `notice:${row.id}`)!.n
      // On a thread bound to a job it is that job's follow-up (routed, no notice); otherwise it is ignored with one notice.
      if ((row.status === 'ignored') !== (notices === 1) || notices > 1) {
        violations.push(`mention ${row.id} naming no repository is ${row.status} with ${notices} notices`)
      }
    }
    if (withRepository && db.get("SELECT 1 FROM job WHERE id IN (SELECT replace(id, 'in_', 'job_') FROM inbox_event WHERE payload LIKE '%repo:nope%')")) {
      violations.push('a mention naming no repository started a job')
    }
    const projected = new Set(db.all<{ gate_id: string }>('SELECT gate_id FROM open_gate').map(row => row.gate_id))
    if ([...open].sort().join() !== [...projected].sort().join()) violations.push(`open_gate ${[...projected]} differs from open gates ${[...open]}`)
    const attempts = db.get<{ n: number }>("SELECT count(*) AS n FROM effect WHERE kind = 'stage.attempt' AND status = 'running'")!.n
    if (attempts > 2) violations.push(`${attempts} attempts running with two slots`)
  }

  let wb = restart()
  try {
    for (const current of steps) {
      try {
        const ids = jobs(wb)
        const job = 'job' in current ? ids[current.job] : undefined
        switch (current.t) {
          case 'start':
          case 'say': {
            env.clock.advance(1000)
            // Without repositories every job starts as before: a mention from Anna.
            const who = current.t === 'start' ? (withRepository && current.who === 1 ? LEAD : ANNA) : PEOPLE[current.who]!
            const thread = current.t === 'start' ? THREADS[current.thread]! : THREADS[current.thread]!
            const text = current.t === 'start' ? (!withRepository || current.target === 'default' ? '@workbench add sessions' : `@workbench repo:${current.target} add sessions`) : TEXTS[current.text]!
            const actor = thread.startsWith('gitlab') ? { source: 'gitlab', id: who.id } : who
            const { event, duplicate } = wb.kernel.inbox.append({ source: actor.source, externalId: `m${++counter}`, threadKey: thread, actor, human: true,
              payload: { kind: 'message', text, addressed: current.t === 'start' ? 'mention' : 'none', postedAt: env.clock.now() } })
            // A message left waiting is routed by the next recovery, in arrival order.
            if (!duplicate && (current.t === 'start' || current.routeNow)) wb.handle(event)
            break
          }
          case 'report': {
            if (!job) break
            const s = state(wb, job)
            // A resumed session may repeat a report for an attempt that already reported, under a new call id.
            if (!s.attempt) break
            const { report, artifact } = reportFor(s, current.report)
            const submitted = wb.report(job, s.attempt.id, { session: s.attempt.id, id: `c${current.call}` }, report, artifact)
            if (submitted.outcome.kind === 'decided') { running.get(s.attempt.id)?.end({ ok: { ended: true } }); running.delete(s.attempt.id) }
            break
          }
          case 'usage': {
            const s = job ? state(wb, job) : undefined
            if (s?.attempt) wb.usage(job!, s.attempt.id, { session: s.attempt.id, id: `u${++counter}` }, { turns: s.attempt.turns + current.turns, tokens: s.attempt.tokens + 10 })
            break
          }
          case 'action': {
            const s = job ? state(wb, job) : undefined
            if (s?.attempt) wb.action(job!, s.attempt.id, { session: s.attempt.id, id: `a${++counter}` }, 'gitlab.createMr', {})
            break
          }
          case 'end': {
            const s = job ? state(wb, job) : undefined
            const attempt = s?.attempt && running.get(s.attempt.id)
            if (attempt) { attempt.end({ ok: { ended: true } }); running.delete(s!.attempt!.id) }
            break
          }
          case 'checks': checksPass = current.pass; break
          case 'setup': {
            const [key, end] = [...setups][0] ?? []
            if (key && end) { setups.delete(key); end(current.pass ? { ok: { outcome: 'passed', toolchains: [], ignored: [], evidence: 'ok' } } : { ok: { outcome: 'blocked', evidence: 'download failed' } }) }
            break
          }
          case 'dispatch': runs.push(...current.runs); await wb.kernel.effects.dispatch(); break
          case 'advance': env.clock.advance(current.ms); wb.kernel.timers.fireDue(); break
          case 'crash': armed = current.point; break
          case 'restart': wb = restart(wb); break
        }
        // Let attempt results that just settled reach their jobs.
        await new Promise(resolve => setImmediate(resolve))
      } catch (error) {
        if (!(error instanceof Crash)) throw error
        wb = restart(wb)
      }
      if (!dead) observe(wb)
    }
    armed = undefined
    runs.length = 0
    wb = restart(wb)
    for (let pass = 0; pass < 25; pass++) {
      env.clock.advance(400_000)
      wb.kernel.timers.fireDue()
      await wb.kernel.effects.dispatch()
    }
    observe(wb)
    const { db, projections } = wb.kernel
    // Stage attempts and setup steps are long and end only when the test ends them.
    const left = db.all<{ kind: string; status: string }>("SELECT kind, status FROM effect WHERE kind NOT IN ('stage.attempt', 'setup') AND status IN ('pending', 'running', 'unknown')")
    if (left.length > 0) violations.push(`unfinished effects after the drain: ${JSON.stringify(left)}`)
    if (db.get("SELECT 1 FROM inbox_event WHERE status = 'received'")) violations.push('an inbox event was never consumed')
    const tables = () => ['binding', 'open_gate', 'job_summary'].map(table => JSON.stringify(db.all(`SELECT * FROM ${table} ORDER BY 1, 2`)))
    const before = tables()
    for (const name of ['binding', 'open_gate', 'job_summary']) projections.rebuild(name)
    if (JSON.stringify(tables()) !== JSON.stringify(before)) violations.push('rebuilding the projections changed them')
    if ('noticed' in reached) reached.noticed! += db.get<{ n: number }>("SELECT count(*) AS n FROM effect WHERE kind = 'notice' AND status = 'succeeded'")!.n
    if ('scopedRefused' in reached) reached.scopedRefused! += db.get<{ n: number }>("SELECT count(*) AS n FROM effect WHERE kind = 'notice' AND json_extract(payload, '$.notice.reason') = 'not_allowed'")!.n
    for (const id of jobs(wb)) {
      for (const event of wb.kernel.engine.events(id)) {
        if (event.type === 'GateClosed' && event.status === 'satisfied') count('approved')
        if (event.type === 'GateClosed' && event.status === 'changes_requested') count('changesRequested')
        if (event.type === 'JobCompleted') count('completed')
        if (event.type === 'Blocked') count('blocked')
        if (event.type === 'BudgetExtended') count('extended')
        if (event.type === 'Backtracked') count('backtracked')
        if (event.type === 'GateRestated') count('restated')
        if (event.type === 'GateResponded' && !event.response.accepted) count('refused')
        if (event.type === 'JobCancelled') count('cancelled')
        if (event.type === 'AttemptStarted' && event.entry === 'retry') count('retried')
        if (event.type === 'AttemptStarted' && event.entry === 'recovery') count('recovered')
        if (event.type === 'SetupCompleted') count('setUp')
        if (event.type === 'JobStarted' && event.intake.repository?.name === 'scoped') count('scopedJob')
        if (event.type === 'Blocked' && event.reason.kind === 'setup_blocked') count('setupBlocked')
        if (event.type === 'SetupStarted' && event.afterInterruption) count('setupRerun')
      }
    }
  } finally {
    try { wb.close() } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true })
  }
  expect(violations).toEqual([])
}

it('keeps the domain invariants over 120 seeded runs with random crashes', async () => {
  withRepository = false
  reached = reachedPlain
  await fc.assert(fc.asyncProperty(fc.array(steps(false), { minLength: 50, maxLength: 90 }), check), { numRuns: 120, seed: 20261111, endOnFailure: true })
  for (const [point, n] of Object.entries(fired)) expect(n, `crashes fired ${point}`).toBeGreaterThanOrEqual(5)
  for (const [path, n] of Object.entries(reachedPlain)) expect(n, `runs reached ${path}`).toBeGreaterThanOrEqual(5)
}, 300_000)

it('keeps them with a repository too: the setup step and the notice for a mention naming none, under random crashes (T11.1, T11.4)', async () => {
  withRepository = true
  reached = reachedRepository
  for (const point of Object.keys(fired) as Point[]) fired[point] = 0
  await fc.assert(fc.asyncProperty(fc.array(steps(true), { minLength: 50, maxLength: 90 }), check), { numRuns: 180, seed: 20261112, endOnFailure: true })
  for (const [point, n] of Object.entries(fired)) expect(n, `crashes fired ${point}`).toBeGreaterThanOrEqual(5)
  for (const [path, n] of Object.entries(reachedRepository)) expect(n, `runs reached ${path}`).toBeGreaterThanOrEqual(5)
}, 300_000)
