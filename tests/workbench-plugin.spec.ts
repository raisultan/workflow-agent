/** The core `workbench` plugin (`T9.1`): typed services, contributor registration as disposables, start once, clean disposal. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { workbenchPlugin } from '../src/adapters/workbench-plugin.ts'
import type { AttemptPayload } from '../src/domain/job.ts'
import { testEnv } from '../src/kernel/env.ts'
import { ANNA, basePolicy, delivery, PROFILE, reviewApproved, THREAD } from './fixtures/domain-workflow.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'workbench-plugin-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A contributor: the delivery workflow, its guard, and handlers that record what they are asked to do. */
const contributor = (attempts: AttemptPayload[]) => ({
  name: 'delivery-contributor',
  inject: ['wbWorkflows', 'wbEffects'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.wbWorkflows.register(delivery()))
    ctx.effect(() => ctx.wbWorkflows.registerGuard('review.approved', reviewApproved))
    ctx.effect(() => ctx.wbEffects.register<AttemptPayload>('stage.attempt', { idempotent: true, long: true, limit: () => 1,
      run: payload => { attempts.push(payload); return new Promise(() => {}) }, cancel: async () => {} }))
    ctx.effect(() => ctx.wbEffects.register('post', { idempotent: true, limit: () => 1, run: async () => ({ ok: { postId: 'p', postedAt: 1 } }) }))
  },
})

const message = (externalId: string, text: string) => ({ source: 'mattermost', externalId, threadKey: THREAD, actor: ANNA, human: true,
  payload: { kind: 'message', text, addressed: 'mention', postedAt: Date.UTC(2026, 0, 1) } })

it('provides typed services, routes inbox events once started, and on disposal removes them and recovers on the next load', async () => {
  const ctx = new Context()
  const path = join(dir, 'workbench.sqlite')
  const options = { path, env: testEnv(), profile: PROFILE, policy: basePolicy, kernel: { pollMs: 60_000 } }
  const attempts: AttemptPayload[] = []
  const fiber = await ctx.plugin(workbenchPlugin(options))
  const contributed = await ctx.plugin(contributor(attempts))
  expect(ctx.wbPolicy.current()).toEqual(basePolicy())

  // Before start, an event waits in the inbox; start routes it during recovery.
  const early = ctx.wbInbox.receive(message('p1', '@workbench add sessions'))
  expect(early).toMatchObject({ duplicate: false, event: { status: 'received' } })
  expect(early.route).toBeUndefined()
  const report = ctx.wbWorkflows.start()
  expect(report).toMatchObject({ routed: 1 })
  expect(ctx.wbWorkflows.start()).toBe(report)
  const job = ctx.wbStore.db.get<{ id: string; status: string }>('SELECT id, status FROM job')!
  expect(job.status).toBe('running')
  await ctx.wbEffects.dispatch()
  expect(attempts).toHaveLength(1)

  // Once started, an event is routed as it arrives; a redelivery is not.
  const later = ctx.wbInbox.receive(message('p2', 'also handle logout'))
  expect(later.route).toMatchObject({ kind: 'followUp', jobId: job.id })
  expect(ctx.wbInbox.receive(message('p2', 'also handle logout'))).toMatchObject({ duplicate: true })

  // Disposing the contributor removes its registrations.
  await contributed.dispose()
  expect(ctx.wbWorkflows.kernel.registry.definition('delivery')).toBeUndefined()
  expect(ctx.wbWorkflows.kernel.registry.guard('review.approved')).toBeUndefined()

  await fiber.dispose()
  expect(ctx.get('wbInbox')).toBeUndefined()
  expect(ctx.get('wbWorkflows')).toBeUndefined()

  // The next load recovers the stage attempt the disposal interrupted.
  const again = await ctx.plugin(workbenchPlugin(options))
  await ctx.plugin(contributor(attempts))
  expect(ctx.wbWorkflows.start()).toMatchObject({ interrupted: 1 })
  expect(ctx.wbWorkflows.kernel.engine.job(job.id)!.state.attempt).toMatchObject({ entry: 'recovery', n: 2 })
  await again.dispose()
  await ctx.fiber.dispose()
})
