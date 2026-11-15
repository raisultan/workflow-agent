# Upstream Adaptation and Module Map

Status: **Imported and adapted** (V1, `G1`–`G5`); the prototype's work model was replaced by the owned workflow domain in `P9` (`D8`).

## 1. Pinned Upstream Revisions

| Repository | Pinned Version / Commit | Role in Workflow Agent |
| --- | --- | --- |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `@deepseek-ai/dsh@0.2.2-rc.1` (`@deepseek-ai/cordis@4.1.0`, `@deepseek-ai/schemastery@3.19.0`), tag `dsh-v0.2.2-rc.1` = commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` | **Consumed runtime.** Composed via [`cordis.patch.yml`](../cordis.patch.yml), `npx dsh --profile workflow-agent`, and public service seams. |
| [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | `main` (`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`) | **Adapted application base.** Imported with upstream license and provenance notices ([`NOTICE`](../NOTICE), [`third_party/`](../third_party)) and adapted per the module map below. |

## 2. DeepSeek Harness (`deepseek-harness`) Seams Used

- **Cordis composition and presets (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent-preset`, `@deepseek-ai/dsh-permission-presets`):** [`cordis.patch.yml`](../cordis.patch.yml) declares the 4 stage agent presets (`workflow-agent-inspector`, `-planner`, `-implementer`, `-reviewer`) with isolated `shell`, `compaction` and `toolResultPruner` realms, and the 2 permission presets (`workflow-agent-readonly`, `workflow-agent-worker`). A job's run manifest names the presets per stage.
- **Sessions (`@deepseek-ai/dsh-api-session-controller`, `dsh-session`, `dsh-agent`, `dsh-workspace`):** the stage runner creates one session per attempt with `ctx.sessionController`, sets its model with `agent.model.select()`, prompts it, steers follow-ups into it (`src/app/delivery.ts`), reads its events through `ctx.sessionPersistence`, and retires it with `workspaceRegistry.archiveSession`. Background shell jobs (`ctx.jobs`) are stopped when an attempt ends, and so are subagents if any were started (`src/executor/background.ts`); since `P10` no stage preset offers the `subagent` tool.
- **Tool runtime (`@deepseek-ai/dsh-tools`):** the read tools, the safe-output tools and `workbench_stage_report` are registered on the attempt's session. `toDshParameterSchema()` (`src/tools/shared.ts`) converts their `zod` schemas into the JSON Schema subset DSH validates and renders.
- **LLM runtime (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-pi-ai`):** sessions use the `litellm` route configured in `cordis.patch.yml` (`api: 'openai-completions'`, `baseURL`, `apiKeyEnv: 'LITELLM_API_KEY'`). The reply verdict calls `ctx.llm.prepareCall` directly, with its own declared request purpose (`workbench-reply-verdict`).
- **Sandboxing (`@deepseek-ai/dsh-sandbox-local`, `dsh-fs-sandbox`, `dsh-bash-sandbox`, `dsh-shell-env`):** Seatbelt (macOS) and `bwrap`/Landlock (Linux) confine each session by its permission preset. In the container, the workbench's wrapper is `dsh-sandbox-local`'s `runnerCommand` (`src/sandbox/`), and the workbench registers `DSH_WORKBENCH_JOB` in `ctx.shellEnv` so the wrapper knows each shell's job ([DESIGN §5](DESIGN.md#5-stage-presets-and-sandboxes)). Host-run checks use the same service (`ctx.sandbox.confine`, `workspace-write`). A path guard (`ctx.tools.guard`) on each stage session confines DSH's file tools, which run outside the sandbox.
- **Web host:** not used by the workbench since `D13`. The dashboard and its read-only API are served by the workbench's own server on their own port; DSH's web app (its own UI) runs as upstream ships it, published only with the Compose profile `dsh-ui`.
- **Session persistence (`@deepseek-ai/dsh-session-persistence`):** the dashboard reads an attempt's session log through a read handle (`open(id, 'read')`) for its agent trace (`D13`).

## 3. Module Disposition (`dsh-superagent-prototype` → Workflow Agent)

| Upstream path | Upstream role | Workflow Agent (V2) |
| --- | --- | --- |
| `src/core/engine.ts` and the `src/core/` work model around it | Single-assignment `Ticket` state machine, driven by an always-on LLM `orchestrator` session. | **Replaced (`D3`, `D8`).** The kernel (`src/kernel/`: inbox, engine, effects, timers, projections, registry) and the domain (`src/domain/`: definitions, policy, router, job decider, vocabulary). No orchestrator session exists; routing and transitions are deterministic. |
| `src/app/store.ts`, `effects.ts`, `outbox.ts`, `versions.ts` | `node:sqlite` store with savepoints, an `Effects` queue and a per-conversation `Outbox`. | **Replaced (`D8`).** One kernel database (`workbench.sqlite`) where every change to a job is one transaction; effects with idempotency keys, ordering keys and reconciliation replace the outbox and action receipts. |
| `src/app/kv.ts` | Key-value records. | **Kept as a kernel table.** Source cursors live in the kernel's `kv` table under `source:` (`src/kv.ts`). |
| `src/executor/dsh.ts`, `src/app/sessions.ts` | Launches `worker-<ticketId>` DSH sessions and exposes worker tools. | **Rewritten (`D8` decision 5).** `src/adapters/stage-runner.ts`: a fresh session per stage attempt, presets and model from the run manifest, `workbench_stage_report` as a job command, usage feeding budgets. `src/executor/background.ts` and `src/app/delivery.ts` are kept. |
| `src/app/assessment.ts`, `src/app/tools/main.ts`, `src/core/evals.ts` | The `orchestrator` LLM session and its 14 router tools. | **Removed (`D3`, `D4`).** Replies to gates are read by the vocabulary or a single-turn verdict (`src/adapters/verdict.ts`). The `dsh-superagent-router` preset and the orchestrator prompts are gone. |
| `src/sources/*` | GitHub (`gh api`) and Feishu (`lark-cli`) sources. | **Replaced (`F2`, `D5`, `D7`).** Outbound-polling Jira, Mattermost and GitLab connectors (`src/sources/`) and the host-brokered `GitTransport`. Their events reach the inbox through `src/adapters/inbound.ts`; their writes are effect handlers (`src/adapters/writers.ts`). |
| Worker shell CLIs (`gh`, `lark-cli`) | Credentialed CLI calls from the worker. | **Replaced (`D8` decision 6).** Read tools (`src/adapters/read-tools.ts`) and safe-output write tools (`src/adapters/safe-output.ts`); no credential reaches a session. |
| `src/infra/text.ts`, `src/client/i18n.ts` | `IM_WORDS = 100` (`Intl.Segmenter('zh')`) and `{ zh, en }` localization. | **Replaced (`D6`).** Connector-sized character limits, `ru`/`en` messages (`src/adapters/messages.ts`), Cyrillic detection and Cyrillic-to-ASCII slugs; the dashboard speaks `ru` and `en`. |
| `src/infra/environment.ts`, `commands.ts`, `src/app/state-lock.ts` | Worker environment, host commands and the state lock. | **Adapted (`D2`).** Credential scrubbing, per-job `HOME` and git config, and confined host commands for checks. |
| `src/app/http.ts`, `src/app/views/*`, `src/client/*` | Loopback web panel with 11 `GET` routes and 12 mutation routes. | **Rewritten, read-only (`F7`, `D7`, `D9`).** `src/app/panel-api.ts` (5 `GET` routes, `405` for everything else, secret redaction) over V2 state and projections; `src/client/` pages for jobs, job detail, inbox, health and effective settings; since `D13` served on the workbench's own port, not as a DSH client page. |

## 4. Adapted Ideas (`P16`)

Ideas and some wording adapted, no file copied; both sources are MIT-licensed, and their notices are in [`NOTICE`](../NOTICE), with the licence texts in [`third_party/`](../third_party).

| Source | Pinned commit | What was taken | Where | Not taken |
| --- | --- | --- | --- | --- |
| [`review-pr`](https://github.com/warpdotdev/common-skills/blob/8792394ff1b655e0af451b8fabb68ef0cfcbd208/.agents/skills/review-pr/SKILL.md) skill, `warpdotdev/common-skills` (MIT, © 2026 Denver Technologies, Inc.) | `8792394ff1b655e0af451b8fabb68ef0cfcbd208` (file last changed in `c2b12b8`) | The severity labels and their meanings; the "V0" framing of robustness; the diff line annotation contract (`[OLD:n]`, `[NEW:m]`, `[OLD:n,NEW:m]`) and citing only annotated lines; the pre-verdict test audit; no tests that only vary inputs | `src/adapters/review-check.ts`, `annotatePatch` in `src/adapters/work-diff.ts` | The GitHub review JSON, suggestion blocks, the validator script, inline comments, comment-style audit, the repository companion skill |
| [`merge-risk`](https://github.com/warpdotdev/common-skills/blob/8792394ff1b655e0af451b8fabb68ef0cfcbd208/.agents/skills/merge-risk/SKILL.md) skill, same repository | same (file last changed in `8792394`) | The five categories and their verdict scale, the weights and the low/medium/high thresholds | `src/adapters/merge-risk.ts`, the reviewer's prompt | Screenshot and profiling requirements; the model computing the score (the host does, with floors) |
| [`pr`](https://github.com/mattpocock/skills/blob/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/engineering/pr/SKILL.md) skill, `mattpocock/skills` (MIT, © 2026 Matt Pocock), credited by `merge-risk` | `5863806dd4e15c63174bee4e7515a4256792ecfa` (file last changed in `e484a80`) | Credited as the origin of `merge-risk` | — | — |

