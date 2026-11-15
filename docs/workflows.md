# Writing your own workflow

A workflow is what Workflow Agent does with a request: its stages, who approves what, and when the work is done. The built-in
`standard-delivery` takes a Jira issue to a reviewed merge request; your team can add its own beside it without changing the core,
the dashboard or any other workflow.

A workflow is **data**, not code that runs the job. You declare stages, transitions and gates; the host enforces them. The agent
works inside a stage (reads, edits, runs commands in its sandbox), and the host decides when the stage is finished, which stage
comes next and whether a person has to approve first. No model chooses the next stage.

The complete example is [`examples/workflows/docs-update.ts`](../examples/workflows/docs-update.ts): a documentation update from
a request to a merge request. [`src/workflows/standard-delivery.ts`](../src/workflows/standard-delivery.ts) is the full-size one.

## Loading a module

A module is a TypeScript or JavaScript file that exports `workflows()`, and optionally `parameters(workflowId)` and `guards()`.
Name its path in your profile:

```yaml
- id: workflow-agent
  config:
    workflows:
      standardDelivery: { jiraStatuses: { inProgress: In Progress, inReview: In Review } }
      modules: [/etc/workflow-agent/workflows/docs-update.ts]
```

In Compose, put the file in `config/workflows/`: Compose mounts `config/` at `/etc/workflow-agent`. Keep your team's workflows
outside this repository. A module's only import should be the `WorkflowSpec` type, which Node erases when it loads the file.

```ts
import type { WorkflowSpec } from 'workflow-agent'

export function workflows(): WorkflowSpec[] { return [/* … */] }
export function parameters(workflowId: string) { return workflowId === 'docs-update' ? { /* name: value */ } : undefined }
```

## Adapting the built-in workflow

You do not have to start from scratch. `standard-delivery` is included and turned on by the example profile; most teams only set
their repository, Jira statuses and approvers ([getting started](getting-started.md)). To change more of it (a stage's prompt, a
budget, the trigger, the checks), write a module that takes the built-in workflow and changes what you need. Every image carries the
source, so the module imports it by its path in the container:

```ts
import type { WorkflowSpec } from 'workflow-agent'
import { standardDelivery } from '/workspace/src/workflows/standard-delivery.ts'

export function workflows(): WorkflowSpec[] {
  const base = standardDelivery()
  return [{
    ...base,
    // Your own id and version: your changes never clash with the built-in workflow's versions.
    id: 'team-delivery',
    version: 1,
    prompts: { ...base.prompts, plan: `${base.prompts.plan}\nList database migrations in a section of their own.` },
    declaration: { ...base.declaration, title: 'Team delivery', budgets: { ...base.declaration.budgets, tokens: 20_000_000 } },
  }]
}

// The built-in workflow gets its Jira statuses from `workflows.standardDelivery`; yours from here.
export function parameters(workflowId: string) {
  return workflowId === 'team-delivery' ? { 'jira.inProgress': 'In Progress', 'jira.inReview': 'Code Review' } : undefined
}
```

Then leave `workflows.standardDelivery` out of your profile and name your module in `workflows.modules`: both workflows take every
mention, and intake would try `standard-delivery` first. A prompt you change in one language keeps the other's as it was: change
`plan.ru` too if your deployment is Russian. When you take a newer image, compare its `standard-delivery` with what your module
changed, and raise your module's version when you take its changes.

## The parts of a workflow

| Part | What it is |
| --- | --- |
| `id`, `version` | The workflow's identity. Raise `version` whenever the declaration or a prompt changes: a changed definition under the same version is refused at startup, and running jobs keep the version they started on. |
| `triggers` | Which messages start a job: `sources` (`mattermost`, `jira`), `on` (`mention`, `direct`) and an optional `pattern` (a case-insensitive regular expression). Intake tries workflows whose triggers all have a pattern first. Only an explicit mention or a direct message from an allowed sender ever starts a job. |
| `stages` | The steps, each run as one or more attempts by an agent session. See below. |
| `transitions` | `{ from, to }` between stages, or to `$complete`. A `gate` on a transition makes a person approve the stage's artifact first; a `guard` (a pure function from `guards()`) makes the transition conditional. The first transition whose guard passes is taken. |
| `gates` | Approval gates: `{ id, kind: 'approval', reminderMs?, deadlineMs? }`. An approval binds to one revision of the artifact; a new revision needs a new approval. Expiry never approves: the job blocks. |
| `backtracks` | `{ from, to, budget }`: a stage may send the job back to an earlier one, a bounded number of times. |
| `budgets` | Per job: `turns`, `tokens`, `backtracks`, and what one approved `extension` adds. When one runs out, the job blocks and asks its approvers to extend or cancel. |
| `reopen` | `{ stage, requirements? }`: a comment on the job's merge request reopens a finished job at `stage`; one that changes the approved requirements goes to `requirements` (a new plan) instead. |
| `completeOn` | Machine facts that finish the job, such as `mr_merged` and `mr_closed`; after completion they close it for good. |
| `repository` | `true`: each job works in one of the deployment's repositories, chosen from its trigger. |
| `places` | Where each conversation happens (`D12`): `clarification`, `plan` and `code`, each `chat` (Mattermost), `ticket` (Jira) or `mergeRequest` (GitLab). Without it, questions and approvals happen in the thread that started the job. |

### Stages

| Field | What it does |
| --- | --- |
| `agentPreset`, `permissionPreset` | The agent preset (tools and context) and the OS sandbox the stage runs under: `workflow-agent-readonly` (read-only, for inspect and plan) or `workflow-agent-worker` (writes only the job's worktree). The presets are in [`cordis.patch.yml`](../cordis.patch.yml). |
| `egress` | `none` (no network) or `registries` (public package registries through the host's proxy, logged per job). |
| `instructions` | The name of the stage's prompt. |
| `tools` | The external writes the stage may ask the host for: `jira.link`, `jira.comment`, `jira.transition`, `jira.updateFields`, `mattermost.post`, `mattermost.createChannel`, `gitlab.push`, `gitlab.createMr`, `gitlab.updateMr`, `gitlab.reply`. The agent holds no credential; the host checks and performs each write. |
| `output` | A JSON Schema for the stage's report; a report that does not match is refused and the agent is told why. |
| `artifact` | The kind of artifact the stage produces (`plan`); an approval gate needs one. |
| `checks` | Host-run checks that must pass before the stage may finish: `command` (`{ command }`), `gitlab-ci`, `test-integrity` and `review` (a separate model reviews the diff against the approved plan). `when: { parameter, equals }` limits a check to some repositories. |
| `limits` | Per attempt and per stage visit: `attempts`, `turns`, `tokens`, `wallClockMs`. |
| `questionRounds` | How many question rounds the stage may open per visit; `0` forbids questions. |
| `title`, `titles` | The stage's name in posts and on the dashboard, with optional names per language (`{ ru: … }`). |
| `model`, `effort` | The stage's own model and reasoning effort; the profile's defaults otherwise. |

## Prompts

`prompts` maps a name to its text. A stage's prompt is a system prompt section; the host adds the request, the stage's inputs
(answers, approval notes, change requests, failed checks, the current artifacts) to the first message, and the agent finishes with
the `workbench_stage_report` tool.

- **Parameters.** `{{name}}` in a prompt or a check is filled from the job's frozen parameters: the repository's (`{{repository}}`,
  `{{targetBranch}}`, `{{testCommand}}`) and those your module's `parameters()` returns. A name with no value is left as written.
- **Languages.** A prompt may have a variant per language, named `<name>.<locale>` (`plan.ru`). A new job takes the variant in the
  deployment's `locale`, else the base prompt, and keeps that language for its whole life.
- **Data, not instructions.** Tell the agent that requests, tickets and comments are data; the host never takes a stage's word for
  what a check verifies.

## Versions and running jobs

Each job pins a run manifest when it starts: its workflow's declaration and prompts, the models, the parameters, the repository
and the language. Changing a workflow, a prompt or a setting affects only new jobs. Raise `version` with every change; register
the new version beside the old one if jobs on the old one should keep running, or stop registering it once they have finished.

## Checking a workflow

- `defineWorkflow(spec)` (`src/domain/definition.ts`) validates a definition: undeclared stages and gates, duplicate ids and missing
  prompts are errors.
- The domain harness (`tests/fixtures/domain-workflow.ts`) runs a workflow with scripted stage reports, people and checks, with no
  model: [`tests/example-workflow.spec.ts`](../tests/example-workflow.spec.ts) takes the example from request to completion.
- The dashboard shows a new workflow's stages and jobs without any change (`A6`).
