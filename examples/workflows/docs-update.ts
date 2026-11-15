/**
 * An example workflow module (docs/workflows.md): a small documentation update, from a request to a merge request a person
 * reviews. Load it by naming its path in the profile's `workflows.modules`. It shows the parts most workflows need: a trigger rule,
 * a read-only stage, a plan a person approves, a stage that writes and opens a merge request with a host-run check, the merge that
 * closes the job, prompts with a parameter and a language variant, and the parameters the deployment gives it.
 *
 * Its only import is a type, which Node erases when it loads the file, so the module runs from any folder the container can read.
 */
import type { WorkflowSpec } from '../../src/domain/definition.ts'

/** The end of every stage's instructions: how a stage finishes (`workbench_stage_report`). */
const REPORT = 'Finish the stage with `workbench_stage_report`: `completed` with the output the stage asks for, `question` with all your '
  + 'questions at once, `backtrack` to an earlier stage, or `blocked` with the reason.'

/** The workflow: inspect (read-only) → plan (approved by a person) → write (opens a merge request) → done. */
export function workflows(): WorkflowSpec[] {
  const limits = { attempts: 2, turns: 60, tokens: 1_000_000, wallClockMs: 20 * 60_000 }
  return [{
    id: 'docs-update',
    // Raise the version whenever the declaration or a prompt changes: running jobs keep the version they started on.
    version: 1,
    prompts: {
      inspect: `Read the request and the repository's documentation (the working copy is your current directory, read-only). Find the pages the request concerns, and ask a person about anything unclear.\nOutput \`pages\`: the files to change.\n${REPORT}`,
      plan: `Write a short plan for the documentation change: each page, and what changes on it. A person approves it before anything is written.\nReturn the plan as the stage's \`artifact\`.\n${REPORT}`,
      write: `Make the approved change in the working copy, check that every link you touched still resolves, commit to a branch \`agent/docs-<slug>\`, publish it with \`gitlab_push_branch\` and open a merge request into \`{{targetBranch}}\` with \`gitlab_create_mr\`.\n${REPORT}`,
      // A variant for deployments whose `locale` is `ru`; a prompt without one is used in every language.
      'plan.ru': `Составь короткий план изменения документации: каждая страница и что на ней меняется. Человек одобрит его до того, как что-то будет написано.\nВерни план как \`artifact\` этапа.\n${REPORT}`,
    },
    declaration: {
      title: 'Documentation update',
      start: 'inspect',
      // A mention that says "docs" starts this workflow; intake tries workflows whose triggers all have a pattern first.
      triggers: [{ sources: ['mattermost'], on: ['mention', 'direct'], pattern: '\\bdocs?\\b' }],
      stages: [
        { id: 'inspect', title: 'Find the pages', titles: { ru: 'Поиск страниц' }, agentPreset: 'workflow-agent-inspector',
          permissionPreset: 'workflow-agent-readonly', egress: 'none', instructions: 'inspect', limits, questionRounds: 2,
          output: { type: 'object', properties: { pages: { type: 'array', items: { type: 'string' } } }, required: ['pages'] } },
        { id: 'plan', title: 'Plan', titles: { ru: 'План' }, agentPreset: 'workflow-agent-planner', permissionPreset: 'workflow-agent-readonly',
          egress: 'none', instructions: 'plan', limits, questionRounds: 0, artifact: 'plan', output: { type: 'object', properties: {} } },
        { id: 'write', title: 'Write and open the merge request', titles: { ru: 'Правка и MR' }, agentPreset: 'workflow-agent-implementer',
          permissionPreset: 'workflow-agent-worker', egress: 'none', instructions: 'write', limits, questionRounds: 0,
          tools: ['gitlab.push', 'gitlab.createMr'],
          // The host runs this before the stage may finish; the agent's word that it passed is not enough.
          checks: [{ id: 'tests', kind: 'command', params: { command: '{{testCommand}}' } }],
          output: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'] } },
      ],
      transitions: [
        { from: 'inspect', to: 'plan' },
        // The plan's approval: a person's reply on the job's thread, bound to this revision of the plan.
        { from: 'plan', to: 'write', gate: 'plan-approval' },
        { from: 'write', to: '$complete' },
      ],
      backtracks: [{ from: 'write', to: 'plan', budget: 1 }],
      gates: [{ id: 'plan-approval', kind: 'approval', reminderMs: 24 * 3_600_000 }],
      budgets: { turns: 300, tokens: 4_000_000, backtracks: 1, extension: { turns: 100, tokens: 1_000_000, attempts: 1, backtracks: 1 } },
      // Feedback on the merge request reopens the job at `write`; a merge, or closing it unmerged, closes the job.
      reopen: { stage: 'write' },
      completeOn: ['mr_merged', 'mr_closed'],
      // Its jobs work in one of the deployment's repositories, chosen from the trigger like standard-delivery's.
      repository: true,
    },
  }]
}

/** The deployment's parameters for this workflow, besides the repository's own (`{{targetBranch}}`, `{{testCommand}}`). */
export function parameters(workflowId: string): Record<string, string> | undefined {
  return workflowId === 'docs-update' ? {} : undefined
}
