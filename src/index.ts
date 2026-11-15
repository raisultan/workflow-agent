/** Main plugin entry: mounts the Workflow Agent runtime and stops it with the plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { dashboardEnv } from './app/dashboard-server.ts'
import { WorkbenchRuntime } from './app/workbench-runtime.ts'
import { Config, resolveConfig, type PluginConfig } from './config.ts'

export const name = 'workflow-agent'
// Services the plugin waits for. Cordis has no optional form (an object maps service names to config), so the optional ones
// (`sandbox`, `jobs`, `subagents`) are not listed: they are read with `ctx.get` where used.
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt',
  'skills', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const resolved = resolveConfig(config)
  // Settings are deployment configuration (`D9`), shown read-only on the dashboard, so DSH's generated settings page is turned off.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // The dashboard is served on its own port (`D13`); `WORKBENCH_DASHBOARD_PORT=off` leaves it out.
  const dashboard = dashboardEnv(process.env)
  const runtime = new WorkbenchRuntime(ctx, resolved, dashboard ? { dashboard } : {})
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info('workflow-agent ready')
}
export type { PluginConfig, WorkbenchConfig } from './config.ts'
export type { WorkflowSpec } from './domain/definition.ts'
export type { GuardInput } from './domain/decider.ts'
