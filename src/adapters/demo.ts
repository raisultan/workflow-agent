/**
 * Demo mode (`T9.7`, `A1`): one synthetic job runs end to end in the real bundle, with no connector account and no model key, so
 * the Compose demo shows the workbench working. Everything else is the production path: the inbox, the router, the job's rules,
 * its gates, effects and projections.
 *
 * - A demo source delivers one hotfix request on a fresh database, from a demo requester, on a `demo:` thread.
 * - A scripted stage driver plays the synthetic hotfix's stages: each attempt reports what a model would.
 * - Posts to `demo:` threads are logged in the database instead of sent; checks pass.
 * - A scripted approver answers each approval gate the job opens with "ok".
 */
import type { AttemptPayload, CheckPayload, PostPayload } from '../domain/job.ts'
import type { Policy } from '../domain/policy.ts'
import type { Workbench } from '../domain/workbench.ts'
import type { EffectHandler } from '../kernel/effects.ts'

export const DEMO_SOURCE = 'demo'
export const DEMO_THREAD = 'demo:1'
export const DEMO_REQUESTER = { source: DEMO_SOURCE, id: 'demo-requester' }
export const DEMO_APPROVER = { source: DEMO_SOURCE, id: 'demo-lead' }

/** Who may do what in the demo. */
export function demoPolicy(policy: Policy): Policy {
  return { ...policy, senders: { ...policy.senders, [DEMO_SOURCE]: [DEMO_REQUESTER.id, DEMO_APPROVER.id] },
    approvers: { ...policy.approvers, 'synthetic-hotfix': { ...policy.approvers['synthetic-hotfix'], [DEMO_SOURCE]: [DEMO_APPROVER.id] } } }
}

/** What each stage of the synthetic hotfix reports in the demo. */
const SCRIPT: Record<string, { report: Record<string, unknown>; artifact?: string }> = {
  triage: { report: { outcome: 'completed', summary: 'The login handler dereferences a missing session.', output: { cause: 'null session in login' } } },
  patch: { report: { outcome: 'completed', summary: 'Guarded the missing session and added a regression test.', output: {} } },
  notes: { report: { outcome: 'completed', summary: 'Rollout notes written.', output: {} },
    artifact: '## Rollout notes\n- Change: login returns 401 instead of 500 without a session.\n- Risk: low.\n- Verify: log in with an expired cookie.\n- Roll back: revert the commit.' },
}

/**
 * The demo's effect handlers: its posts, stage driver and checks. `posts` wraps the real post handler for other threads; `render` gives
 * a demo post's text, kept on its result as a real post keeps it.
 */
export function demoHandlers(workbench: Pick<Workbench, 'report' | 'kernel'>, posts: EffectHandler<PostPayload>, render?: (payload: PostPayload) => string | null) {
  const log = (entry: unknown) => workbench.kernel.db.run(`INSERT INTO kv (key, value) VALUES ('demo:posts', json_array(json(?)))
    ON CONFLICT (key) DO UPDATE SET value = json_insert(value, '$[#]', json(?))`, JSON.stringify(entry), JSON.stringify(entry))
  const post: EffectHandler<PostPayload> = {
    ...posts,
    run: async (payload, key, attempt) => {
      if (!payload.threadKey.startsWith(`${DEMO_SOURCE}:`)) return posts.run(payload, key, attempt)
      const postedAt = workbench.kernel.env.clock.now()
      log({ key, threadKey: payload.threadKey, message: payload.message, postedAt })
      const text = render?.(payload)
      return { ok: { postId: key, postedAt, threadKey: payload.threadKey, ...typeof text === 'string' ? { text } : {} } }
    },
    reconcile: async (payload, key) => payload.threadKey.startsWith(`${DEMO_SOURCE}:`) ? { absent: true } : posts.reconcile!(payload, key),
  }
  const attempt: EffectHandler<AttemptPayload> = {
    idempotent: true, long: true, limit: () => 1, cancel: async () => {},
    run: async payload => {
      const step = SCRIPT[payload.stageId]
      if (!step) return { fail: `the demo has no script for stage ${payload.stageId}` }
      const submitted = workbench.report(payload.jobId, payload.attemptId, { session: `demo-${payload.attemptId}`, id: 'report' }, step.report,
        step.artifact ? { text: step.artifact, title: 'Rollout notes' } : undefined)
      return submitted.outcome.kind === 'decided' ? { ok: { reported: true } } : { fail: JSON.stringify(submitted.outcome) }
    },
  }
  const check: EffectHandler<CheckPayload> = { idempotent: true, limit: () => 2, run: async payload => ({ ok: { outcome: 'passed', evidence: `demo: ${payload.check.id} passed` } }) }
  return { post, attempt, check }
}

/** The demo's source: one request on a fresh database, and "ok" from the demo approver to each approval gate once it is posted. */
export function startDemoSource(workbench: Pick<Workbench, 'receive' | 'kernel'>, everyMs = 1000): () => void {
  const { db, env } = workbench.kernel
  if (!db.get('SELECT 1 FROM job LIMIT 1')) {
    workbench.receive({ source: DEMO_SOURCE, externalId: 'demo-request-1', threadKey: DEMO_THREAD, actor: DEMO_REQUESTER, human: true,
      payload: { kind: 'message', text: '@workbench hotfix: login fails with 500 when the session cookie has expired', addressed: 'mention', postedAt: env.clock.now() } })
  }
  const answer = () => {
    for (const gate of db.all<{ gate_id: string; job_id: string }>(`SELECT gate_id, job_id FROM open_gate WHERE thread_key LIKE 'demo:%' AND kind = 'approval'`)) {
      const job = (db.get<{ state: string }>('SELECT state FROM job WHERE id = ?', gate.job_id))
      const posted = job && (JSON.parse(job.state) as { gates: Record<string, { postedAt?: number; threadKey: string }> }).gates[gate.gate_id]
      if (!posted?.postedAt) continue
      workbench.receive({ source: DEMO_SOURCE, externalId: `demo-approval-${gate.gate_id}`, threadKey: posted.threadKey, actor: DEMO_APPROVER, human: true,
        payload: { kind: 'message', text: 'ok', addressed: 'none', postedAt: Math.max(env.clock.now(), posted.postedAt + 1) } })
    }
  }
  const timer = setInterval(answer, everyMs)
  timer.unref?.()
  return () => { clearInterval(timer) }
}
