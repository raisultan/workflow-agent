/**
 * The core `workbench` plugin (`T9.1`, `D8` decision 13): one long-lived plugin that owns the kernel and the domain, so the store,
 * inbox, policy, workflow engine and effects share one transaction boundary. It provides typed services:
 *
 * - `wbStore`: the database, blobs and projections, for read models (the dashboard);
 * - `wbInbox`: where Sources deliver events (appended durably, then routed);
 * - `wbWorkflows`: the domain (`Workbench`): definitions, guards, stage reports, usage and safe-output requests;
 * - `wbEffects`: effect handler registration;
 * - `wbPolicy`: the current policy (`D9`: from configuration).
 *
 * Contributor plugins (workflows, sources, tools, effect handlers) inject these and register disposables; the composition root then
 * calls `wbWorkflows.start()`, which recovers and starts the kernel once. Disposal stops the loops, waits for short work in flight,
 * and closes the database; a running stage attempt returns to its job as interrupted after the next start.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JobEvent } from '../domain/job.ts'
import type { Policy } from '../domain/policy.ts'
import { Workbench, type WorkbenchOptions } from '../domain/workbench.ts'
import type { KernelDb } from '../kernel/db.ts'
import type { Effects } from '../kernel/effects.ts'
import type { Blobs, Projections } from '../kernel/projections.ts'

/** Read access to the kernel's state: the database, the blob store and the projections. */
export interface WbStore { readonly db: KernelDb; readonly blobs: Blobs; readonly projections: Projections<JobEvent> }
/** Where Sources deliver events. */
export interface WbInbox { receive: Workbench['receive'] }
/** The current policy, as configuration states it. */
export interface WbPolicy { current(): Policy }

declare module '@deepseek-ai/cordis' {
  interface Context {
    wbStore: WbStore
    wbInbox: WbInbox
    wbWorkflows: Workbench
    wbEffects: Effects
    wbPolicy: WbPolicy
  }
}

/** Provides `workbench`'s services on `ctx` for as long as `ctx` lives. */
export function provideWorkbench(ctx: Context, workbench: Workbench, policy: () => Policy): void {
  const { kernel } = workbench
  ctx.effect(() => ctx.reflect.provide('wbStore', { db: kernel.db, blobs: kernel.blobs, projections: kernel.projections }), 'workbench: wbStore')
  const inbox: WbInbox = { receive: input => workbench.receive(input) }
  ctx.effect(() => ctx.reflect.provide('wbInbox', inbox), 'workbench: wbInbox')
  ctx.effect(() => ctx.reflect.provide('wbWorkflows', workbench), 'workbench: wbWorkflows')
  ctx.effect(() => ctx.reflect.provide('wbEffects', kernel.effects), 'workbench: wbEffects')
  ctx.effect(() => ctx.reflect.provide('wbPolicy', { current: policy }), 'workbench: wbPolicy')
}

/** The `workbench` plugin over a domain with `options` (its database path, models and policy). */
export function workbenchPlugin(options: WorkbenchOptions) {
  return {
    name: 'workbench',
    apply(ctx: Context): void {
      const workbench = new Workbench(options)
      ctx.effect(() => async () => {
        await workbench.stop()
        workbench.close()
      }, 'workbench: kernel')
      provideWorkbench(ctx, workbench, options.policy)
    },
  }
}
