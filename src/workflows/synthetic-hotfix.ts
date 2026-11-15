/**
 * A second, synthetic workflow (`A6`): different stages and its own trigger rule, loaded beside `standard-delivery` with no change to
 * the core or the dashboard. A hotfix is triaged, patched with its tests run by the host, and written up for the rollout.
 */
import type { WorkflowSpec } from '../domain/definition.ts'

const REPORT = 'Finish with `workbench_stage_report` (completed with the stage\'s output, question, backtrack, blocked or failed).'

/** The synthetic hotfix workflow. */
export function syntheticHotfix(): WorkflowSpec {
  const limits = { attempts: 2, turns: 60, tokens: 2_000_000, wallClockMs: 30 * 60_000 }
  return {
    id: 'synthetic-hotfix',
    version: 2,
    prompts: {
      triage: `Triage the incident in the request: find the failing code path in the working copy and say what the smallest safe fix is.\n${REPORT}`,
      patch: `Apply the smallest safe fix from the triage, with a regression test, and run the tests ({{testCommand}}).\n${REPORT}`,
      notes: `Write short rollout notes for the fix: what changed, the risk, how to verify, how to roll back.\n${REPORT}`,
    },
    declaration: {
      title: 'Synthetic hotfix',
      start: 'triage',
      triggers: [{ sources: ['mattermost', 'demo'], on: ['mention', 'direct'], pattern: '\\b(hotfix|инцидент)\\b' }],
      stages: [
        { id: 'triage', title: 'Triage', agentPreset: 'workflow-agent-inspector', permissionPreset: 'workflow-agent-readonly', egress: 'none',
          instructions: 'triage', limits, output: { type: 'object', properties: { cause: { type: 'string' } }, required: ['cause'] } },
        { id: 'patch', title: 'Patch', agentPreset: 'workflow-agent-implementer', permissionPreset: 'workflow-agent-worker', egress: 'registries',
          instructions: 'patch', limits, questionRounds: 0, checks: [{ id: 'tests', kind: 'command', params: { command: '{{testCommand}}' } }],
          output: { type: 'object', properties: {} } },
        { id: 'notes', title: 'Rollout notes', agentPreset: 'workflow-agent-planner', permissionPreset: 'workflow-agent-readonly', egress: 'none',
          instructions: 'notes', limits, questionRounds: 0, artifact: 'rollout-notes', output: { type: 'object', properties: {} } },
      ],
      transitions: [
        { from: 'triage', to: 'patch' },
        { from: 'patch', to: 'notes' },
        { from: 'notes', to: '$complete', gate: 'rollout-approval' },
      ],
      backtracks: [{ from: 'patch', to: 'triage', budget: 1 }],
      gates: [{ id: 'rollout-approval', kind: 'approval' }],
      budgets: { turns: 300, tokens: 8_000_000, backtracks: 1, extension: { turns: 100, tokens: 2_000_000, attempts: 1, backtracks: 1 } },
    },
  }
}
