/**
 * The workflow the session probe of the isolation smoke runs (`scripts/smoke-session-tools.ts`): one stage, under the implement
 * stage's real agent and permission presets, that a scripted model drives through DSH's file tools. Synthetic; loaded only by the
 * smoke's own profile, through `workflows.modules`.
 */
import type { WorkflowSpec } from '../src/domain/definition.ts'

export function workflows(): WorkflowSpec {
  return {
    id: 'smoke-file-tools',
    version: 1,
    prompts: { probe: 'Call the tools the test asks for, then report the stage completed.' },
    declaration: {
      title: 'Isolation smoke: file tools',
      start: 'probe',
      triggers: [{ sources: ['mattermost'], on: ['mention'] }],
      stages: [{ id: 'probe', title: 'Probe', agentPreset: 'workflow-agent-implementer', permissionPreset: 'workflow-agent-worker', egress: 'none',
        instructions: 'probe', output: { type: 'object', properties: {}, additionalProperties: true },
        limits: { attempts: 1, turns: 20, tokens: 1_000_000, wallClockMs: 300_000 } }],
      transitions: [{ from: 'probe', to: '$complete' }],
      budgets: { turns: 50, tokens: 2_000_000, backtracks: 0, extension: { turns: 1, tokens: 1, attempts: 1, backtracks: 1 } },
    },
  }
}
