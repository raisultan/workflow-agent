# PRD — Workflow Agent

This document says what Workflow Agent must do. How it works is in [DESIGN](DESIGN.md), why in [DECISIONS](DECISIONS.md), how to run it in [DEPLOYMENT](DEPLOYMENT.md).

The ids are stable and referenced from the code and tests: `F` for requirements, `A` for acceptance criteria, `D` for the decision in [DECISIONS](DECISIONS.md) a rule comes from. "The workbench" is Workflow Agent's host process: the one that runs the jobs and talks to Jira, Mattermost and GitLab.

## 1. Product and problem

Build a portable, self-hosted adaptation of DeepSeek Harness and its super-agent prototype that operates across Jira, Mattermost, and GitLab. Organizations supply their own confidential workflows and playbooks as external configuration/extensions without placing them in the framework repository.

The product connects requests, clarifications, version-bound approvals, repository work, and review feedback across sessions while giving operators a read-only view of progress and evidence. It provides execution and observation foundations rather than prescribing a fixed software development lifecycle.

## 2. Users and outcome

- **Requester:** initiates work and receives results in an existing work tool.
- **Participant** (`D12`): anyone in a job's Mattermost thread; answers its clarifying questions, and may bring others in.
- **Approver** (`D12`): listed per repository; approves the plan in the Jira ticket, and extends, resumes or cancels a blocked job in its Mattermost thread.
- **Observer:** inspects progress, stage outputs, and evidence in the read-only dashboard without controlling execution.
- **Operator/workflow author:** installs the service, configures integrations, and supplies trusted private extensions.

Success means a job can span conversations across Jira, Mattermost, and GitLab, wait for people without holding an active worker, survive a restart, and produce a traceable result where any observer can see the current stage, blocker, and evidence without reading raw process logs.

## 3. Fixed product decisions

1. Adapt the **DeepSeek stack** (`deepseek-harness` + `dsh-superagent-prototype`); do not build a competing agent loop or runtime-selection platform.
2. Run on one host with **Docker Compose** (Docker Desktop for Mac, or Linux) and persisted SQLite/workspace volumes. A Helm chart is deferred, and Kubernetes is untested.
3. Route model requests through **LiteLLM**, configured by base URL, API key, and model alias.
4. Deliver generic, reusable **Jira, Mattermost, and GitLab connectors**. Workplace mappings and credentials remain external configuration.
5. Supply workflows and playbooks as trusted, versioned code/configuration extensions.
6. Keep the dashboard **read-only**. Questions, answers, approvals, and operational requests stay in work tools.
7. Develop and verify with synthetic data; no confidential workflow is required to build the framework.
8. Workflows have one active stage per job, **host-deterministic conditional transitions** (no LLM router turn between stages), and bounded loops (including cross-stage backtracking). Agents choose how to work inside stages while the host engine enforces gates and checks. Independent jobs may run concurrently; parallel workflow branches inside a job are deferred.
9. **Settings are deployment configuration** (`D9`): models, policy, limits, language and workflow parameters live in the profile and environment, change by a reviewed edit and a redeploy, and are frozen into each job's run manifest.
10. **One deployment serves several repositories, each with its own toolchains** (`D10`). The configuration lists repository profiles; a job's repository is chosen deterministically from its trigger and frozen in its manifest. A repository pins its toolchain versions in its own files, and the host installs them before the first stage without running anything from the repository; no sandbox can change the shared toolchains ([DESIGN §4.9](DESIGN.md#49-setup-step)). Languages beyond the image's come without rebuilding it; system libraries come from a deployment image built on Workflow Agent's.
11. **Every job gets Postgres, RabbitMQ and Kafka for its tests** (`D11`), at their usual local ports and with no configuration per repository. Each runs only inside the sandbox of the command that uses it ([DESIGN §5.6](DESIGN.md#56-test-services)).
12. **Each conversation in its place** (`D12`): requirements are clarified in a Mattermost thread; the plan, its revisions, its approval and questions about it are in the Jira ticket; the code is discussed on the merge request. A question to the workbench is answered where it was asked. Everything the workbench writes to people is short and structured, in the deployment's language (English by default, Russian supported, `D14`), and no chat message carries the plan.

## 4. Scope and requirements

| ID | Requirement | Observable result |
| --- | --- | --- |
| F1 | DeepSeek execution | A real Harness session executes a stage attempt with authorized tools; tool calls, results, failures, and completion are observable. |
| F2 | Pluggable integrations | Connectors ingest events, read bounded context, perform scoped actions, and report health. A connector that is not configured shows it in its health and does not stop startup. |
| F3 | Private workflow extension | A workflow declares trigger match rules (`Trigger → workflowId + target repo/inputs`), stable stage IDs, stage agent/permission presets, instructions, structured output schemas, deterministic host transition rules, waits, and approval gates. A private extension loads without editing framework core. |
| F4 | Durable jobs & thread binding | Persist job identity, the pinned run manifest, stage attempts, sessions, pending questions, approvals, and outcomes as an append-only event log. Outbound questions and created artifacts (Jira issues, Mattermost threads, GitLab MRs) bind their external thread IDs to the job so follow-up replies and MR review comments route back to that job and can resume a wait or trigger bounded stage re-entry. |
| F5 | Human interaction | A question records its intended recipient, destination thread, blocking stage gate, and correlated answer. Missing, unauthorized, or wrong-channel replies do not satisfy a gate. Each kind (`D12`) of conversation has its place (clarification: the job's Mattermost thread; the plan: the Jira ticket; the code: the merge request); a question round stays open until every item has an answer, from anyone in the thread, each recorded with who gave it; a question to the workbench gets a short answer where it was asked, without moving the job; for a workflow whose plan lives in the ticket, a trigger outside Jira must name the Jira issue key, and one that names none starts no job and gets a short refusal (`no_ticket`). |
| F6 | Version-bound approval | Required approvals verify the source-native actor and bind to the exact artifact revision digest (`sha256` / revision). Generating a new artifact revision invalidates prior approvals deterministically; the model cannot approve its own work. |
| F7 | Read-only supervision | Show work overview, job detail, communication, artifacts, stage attempt outputs, action history, and system/connector health. No operational or configuration mutations are exposed by the monitoring interface. |
| F8 | Idempotent external actions | Append every inbound event to a durable inbox, deduplicated by source ID; execute outbound writes as effects in the same transaction as the decision that caused them, with deterministic idempotency keys, and reconcile a write whose outcome is unknown before repeating it (comments, posts, status transitions, MR create/update, non-force `git push`). |
| F9 | Controlled execution | Enforce stage tool presets, OS sandbox boundaries, cancellation, per-attempt limits and per-job budgets outside prompts; a stage finishes only when its host-run checks pass. Isolate workers per job; keep service write credentials behind host-validated connector actions, including branch pushes. |
| F10 | Portable configuration | Separate reusable code, synthetic examples, private extensions, secrets, and runtime state. Logs/exports exclude credentials; displayed content is policy-filtered. |

### Connector capability boundary

- **Jira:**
  - **Context gathering (`read`):** read issue details, comments, parent **Epics**, subtasks, **linked issues** (`issuelinks`), **remote/web links** (`/remotelink`), **attachment metadata + plain-text/log file contents** (`jira_read_attachment_text`; binary/image parsing is excluded), and run bounded JQL searches.
  - **Mutations (`write`):** post comments, perform allowed status transitions, and update configured fields. Support HTTP Basic (`username/password`) and Personal Access Token authentication.
- **Mattermost:**
  - **Context & intake (`read`):** receive mentions and thread replies across **any public or private channel the bot is added to** (plus DMs), read thread context, and resolve users by username/email.
  - **Mutations (`write`):** post messages/questions/plans in threads or channels, **tag people (`@username`)**, and **create new public channels** when requested by a workflow stage.
- **GitLab:** read project/MR context, prepare a repository workspace, publish a scoped branch via non-force Git transport, create/update an MR, observe pipelines, and read/reply to MR discussions. Bind the MR thread and commit SHA to the job. Delivery stops at a merge request that a person reviews; automatic merging is excluded.

### Approval and budget rules

- **Admission.** A reply counts toward a gate only when it comes from an eligible actor (the requester while still an allowed sender, or a configured approver), on the gate's bound thread, posted after the gate. The workbench never answers its own gate. Where a repository lists approvers (`D12`), only they approve: a plan only by a comment in its Jira ticket, and a blocked job in its Mattermost thread.
- **Meaning.** A short standalone approval (`ok`, `LGTM`, `ок`) or cancel (`stop`, `/cancel`, `стоп`) is read without a model. Any other reply is read by the verdict model as data. Only a clear approval, with or without notes, at confidence 0.8 or more, approves. A conditional approval ("ok, but add an index") is a change request.
- **Never approves.** Unclear, sarcastic, resigned, low-confidence or malformed readings, and an unavailable model, never approve. The workbench says how it read the reply and keeps the gate open. Every approval is acknowledged with what was approved.
- **Closing** (`D12`). A finished job closes when its merge request is merged or closed without a merge, or when one of its approvers writes `close` (`закрой`) on any of its threads; a closed job takes no more feedback, and a comment on it gets one reply saying so.
- **Revisions.** An approval binds to one artifact revision digest. A new revision needs a new approval, and replies posted before it don't count. An expired gate blocks the job; it never approves.
- **Budgets.** Each attempt has turn, token and wall-clock limits; an attempt over its limits fails and is retried within the stage's attempt budget. Each job has turn, token and backtrack budgets. When one runs out, the job blocks and asks its approvers to extend it (by the amount the workflow declares) or cancel it.

### What monitoring records

For each job, show stages and stage attempts (reported summary and structured output), sessions/tools, questions/answers, artifact revisions (`sha256`/revision), approvals, pipeline checks, and outbound action states (`pending/retrying | completed | failed`). Mark truncated tool output explicitly and exclude credentials and raw API headers from observer views.

## 5. Synthetic demonstration workflow

The standard delivery workflow (`standard-delivery`) and synthetic extensions demonstrate: `request → set up the repository's toolchains → inspect → ask questions → wait → record answers → publish plan (with what will be tested) → await version-bound approval → implement → host-run tests, CI, test integrity and a clean-context review → open review MR → complete`. Review feedback on the MR reopens the job at `review`, with cross-stage backtracking to plan or inspect when requirements or architecture change. Neither the engine nor the dashboard hardcodes these stage names, Jira status names, or ticket templates: they are workflow data and deployment parameters.

## 6. Acceptance criteria

| ID | Accepted when… |
| --- | --- |
| A1 | One documented Compose startup, from the published image (`ghcr.io/raisultan/workflow-agent`), works on the supported architectures; a deterministic synthetic demonstration requires no company accounts or model key. |
| A2 | A separate real-model smoke path runs through configurable LiteLLM and DeepSeek, demonstrating a tool request, result, error feedback, and stage completion. |
| A3 | The synthetic job pauses for an external answer or approval without holding an active worker slot; the dashboard shows what, whom, and which thread it awaits. |
| A4 | Repeated inbound events or a restart while effects are being delivered do not create duplicate jobs, duplicate comments/MRs, or lost state. |
| A5 | Unauthorized actors and approvals referencing an older artifact revision digest cannot unlock a stage gate; a valid approval on the current digest resumes the job. |
| A6 | A second workflow extension with different stages and trigger match rules loads and renders in the dashboard without core or UI code changes. |
| A7 | An observer can reconstruct a job's cross-service communication (`Jira ↔ Mattermost ↔ GitLab MR`), stage attempts, artifacts, checks, and result; monitoring clients cannot mutate jobs or settings. |
| A8 | Connector contract tests cover authentication, bot-loop suppression, pagination, idempotent retries, and rate/error backoff, paired with recorded live smoke tests against nonconfidential test services. |
| A9 | Cancellation and stage limits stop worker trees and further actions; isolation and smoke tests ([DESIGN §5](DESIGN.md#5-stage-presets-and-sandboxes)) verify read-only (`workflow-agent-readonly`) and worktree-write (`workflow-agent-worker`) OS sandboxing, environment credential scrubbing, `/proc/<pid>/environ` denial across `bwrap`'s user namespace, and host-brokered connector writes. |
| A10 | Startup, configuration, private workflow extension authoring, and supported connector versions are documented ([DEPLOYMENT](DEPLOYMENT.md)). |
| A11 | A crash or restart at any point loses no inbound event, timer or tool result, and repeats no external write. |
| A12 | An approval counts only from an eligible actor, on the gate's bound thread, posted after the current revision. Unclear replies, low confidence or an unavailable model never approve. Every approval is acknowledged with what was approved. The labelled RU/EN reply set has zero false approvals. |
| A13 | Each job pins a run manifest. Changing a workflow definition, a prompt or a configured model (`D9`) affects only new jobs. A job parks instead of failing when a guard its manifest names is not registered. |
| A14 | A stage passes only on host-run checks. Claiming tests passed, or editing tests to pass, does not pass a stage. |
| A15 | Inspect and plan stages have no network. Implement and review reach only public package registries through the proxy, never a private or loopback address. Credential files, state and other jobs' worktrees are unreadable from any sandbox or file tool. |
| A16 | When a budget runs out, the job blocks and asks its approvers to extend or cancel. |
| A17 | On a fresh database, events that happened before first start never start a job. |
| A18 | A job starts only from an explicit mention of the bot or a direct message, by an eligible actor. A new Jira issue, being in a source's filter (for example, assigned to the bot), an unaddressed post or a GitLab event never starts one. |
| A19 | A job on a Node or Python repository gets the toolchain versions the repository pins (Go is smoke-tested), installed by the host before the first stage. Nothing from the repository runs during that install, and no sandbox can change the shared toolchains. |
| A20 | One deployment serves several repositories. Each job's repository is chosen deterministically from its trigger and frozen in its manifest. A trigger that matches no repository, in a deployment with no default, starts no job and gets the list of repository names; so do a sender not allowed on the chosen repository, and a `repo:` that contradicts the thread's mapped repository, each with a reply saying why. |
| A21 | Every job's commands in implement and review, and the host's checks, can use Postgres, RabbitMQ and Kafka at their usual local ports, with no configuration per repository; Postgres runs the major the repository's CI names. Each runs only inside the sandbox of the command that connects to it, starts fresh for that command, and is gone when it ends: no other sandbox reaches it, it reaches no network, and no host check sees data an agent's command left. |
| A22 | (`D12`) A job's clarifying questions are in its Mattermost thread; a job started in Jira opens one in its repository's mapped channel and addresses the ticket's author, matched by email. |
| A23 | (`D12`) A partial answer leaves the rest of a question round open; anyone in the job's thread can answer, and each answer is recorded with who gave it; "I don't know, you decide" becomes an assumption stated in the plan. |
| A24 | (`D12`) A question to the workbench in the Mattermost thread, the Jira ticket or on the merge request gets an answer there, with no new plan revision and no stage attempt. |
| A25 | (`D12`) The plan and its revisions are posted only in the Jira ticket; only a Jira comment by one of the repository's listed approvers approves; the Mattermost thread gets a link only. A Mattermost trigger that names no Jira issue key starts no job and gets a short reply saying so (`no_ticket`). |
| A26 | (`D12`, `D14`) Everything the workbench writes to people is short and structured, in the deployment's language (English by default, Russian supported), and no chat message carries the plan. |
| A27 | (`D8`) The review check fails work only on a critical or important finding whose evidence the host found in the diff, the plan or a follow-up; a reply without evidence is asked again, then blocks for a person. A job that hands over a merge request reports a merge-risk summary (low, medium or high, never gating) in its completion post and on the merge request. |

## 7. Explicit exclusions

No real workplace workflow, production deployment, SaaS multi-tenancy, workflow visual editor, plugin marketplace, automatic merging/deployment, general-purpose long-term memory service, runtime comparison framework, horizontal scale, Helm chart, or dashboard approval/chat/admin controls.
