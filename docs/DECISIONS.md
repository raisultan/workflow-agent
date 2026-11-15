# Architectural Decisions (`D1`–`D14`)

This is the record of why Workflow Agent is built as it is. All fourteen decisions are accepted and implemented. Fixed product rules live in [PRD §3](PRD.md#3-fixed-product-decisions), and the system as it works today is described in [DESIGN](DESIGN.md).

How to read it:
- **It is a historical record.** Each decision is kept as it was made, with its date. Where a later decision revises an earlier one, the earlier text stands and the later one says what it changes; DESIGN has the current state.
- **`D1`–`D7`** were made for the first, pre-release build (called V1 below). `D8` replaced that build's work model, so some names in `D3` and `D4` no longer exist in the code.
- **"The workbench"** is Workflow Agent's host process. **"The maintainer's trial"** is a hands-on run of the pre-release build on a test repository, which several later amendments answer.
- **Russian examples** in `D12` date from when Russian was the only language; `D14` made English the default.

| ID | Area | Decision |
| --- | --- | --- |
| **D1** | **Upstream version lock** (revised 2026-11-11) | Pin runtime to **`@deepseek-ai/dsh@0.2.2-rc.1`** (`@deepseek-ai/cordis@4.1.0`, `@deepseek-ai/schemastery@3.19.0`, Node.js `>=24.9.0`) with exact pins in `devDependencies`, `peerDependencies` and `engines.dsh`, paired with **`dsh-superagent-prototype` `8c32a9dc5`**, booting via the official `npx dsh --profile workflow-agent` CLI and [`cordis.patch.yml`](../cordis.patch.yml). |
| **D2** | **Per-job worker isolation & OS sandboxes** (extended by `D8`: network egress) | Enforce stage OS sandboxes via `@deepseek-ai/dsh-sandbox-local` + `@deepseek-ai/dsh-permission-presets`: pin `inspect` and `plan` to **`workflow-agent-readonly`** (`sandbox: read-only`, `approval: never`) and `implement` and `review` to **`workflow-agent-worker`** (`sandbox: workspace-write`, `approval: never`), with separate `state` and `work` volumes, environment credential scrubbing (`WORKER_FORBIDDEN_ENV_PATTERN`), `/proc/<pid>/environ` kernel denial across `bwrap` user namespaces, and host-brokered connector/Git writes ([DESIGN §5](DESIGN.md#5-stage-presets-and-sandboxes)). |
| **D3** | **Deterministic workflow engine, 4 stage presets & backtracking** (revised by `D8`) | Replace upstream's permanent LLM `orchestrator` middleman session with a **deterministic TypeScript coordinator** (`src/core/workflow.ts` in V1, since replaced by `D8`). Spawn **one persistent DSH `Session` per stage** (`job-<jobId>-stage-<stageId>`) sharing **one Git worktree per `Job`**. Configure 4 declarative stage presets in [`cordis.patch.yml`](../cordis.patch.yml) (`workflow-agent-inspector`, `planner`, `implementer`, `reviewer`) backed by granular connector tool plugins (`lib/tool-{jira,mattermost,gitlab}.js`). Support re-entrant cross-stage backtracking (`plan → inspect`, `implement → plan \| inspect`, `review → plan \| inspect`), `workbench_stage_report`, `workbench_trigger_handback`, direct `steer` delivery, and unreported-turn auto-recovery ([DESIGN §3](DESIGN.md#3-domain-srcdomain)). |
| **D4** | **Hash-bound approvals & RU/EN reply classification** (revised by `D8`) | Verify `trigger.actor` (`{ source, id }`) deterministically against the gate's per-source `approvers` allowlist and bind approvals to the exact `artifact_revision` (`sha256` digest) for `stage.artifactKind`. Standalone short Russian/English approvals approve on a zero-LLM fast path; multi-clause replies (`"Ок, но..."`) run a stateless single-turn classifier (`changes_requested` → re-enter `plan` for revision `r + 1`, invalidating revision `r`). |
| **D5** | **Outbound-polling connectors** | Implement `jira`, `mattermost`, and `gitlab` connectors using **outbound cursor-based HTTP polling** (`KV`, plus optional outbound Mattermost WebSocket) so zero inbound webhook ports are required behind NAT or on local Docker Compose. Separate deterministic contract tests from recorded live smoke tests. |
| **D6** | **Russian (`ru`) & English (`en`) text handling** | Replace upstream's 100-word Chinese segmenter limit (`Intl.Segmenter('zh')`) with connector-appropriate character limits (`8,000`–`16,000` chars), replace `{ zh, en }` wrappers with `ru`/`en` localization and `\p{Script=Cyrillic}` support, and transliterate Cyrillic issue titles into ASCII-only Git branch/worktree slugs (`agent/<issue-key>-<ascii-slug>`). |
| **D7** | **Loopback read-only supervision & deep connector context** | Bind the supervision HTTP server to `127.0.0.1` and reject all mutation verbs (`POST`/`PUT`/`PATCH`/`DELETE` → `405`). Support Mattermost public/private channels, `@username` mentions, and public channel creation; support Jira deep context traversal (Epics, subtasks, `issuelinks`, `/remotelink`, JQL search, and plain-text/log attachment reading via `jira_read_attachment_text`). |
| **D8** | **Owned workflow domain on DSH** | Keep DSH as the agent runtime and keep the prototype's integration layer. Replace the prototype work model (Eval/Assessor, Ticket/Assignment/Executor, LLM main Session, Passes) and the V1 `WorkflowCoordinator` with an owned workflow domain: durable inbox, deterministic router, policy roles, and a single-writer engine whose state, events and effects commit in one transaction. See [D8 detail](#d8-owned-workflow-domain-on-dsh). |
| **D9** | **Settings are deployment configuration** | Operator settings (models, sender allowlists, policy, worker limits, team prompts) live in the deployment's versioned configuration and change by a reviewed change and a redeploy. The profile sets the default model; a workflow stage may override it; each job's run manifest freezes the resolved model per stage. The dashboard shows the effective values read-only and never writes. |
| **D10** | **Repository profiles and toolchains** | A deployment lists its repositories, each with its target branch, test and setup commands and registry presets; the router picks a job's repository deterministically and the run manifest freezes the profile. Each repository brings its own toolchain versions (`mise.toml` / `.tool-versions`). A host-run setup step installs them with `mise` into a shared, read-only cache before the first stage; repository files never run during that install, and agents never get the toolchain download hosts. No per-job containers. |
| **D11** | **Test services as sandboxed processes** | Every job can use Postgres, RabbitMQ and Kafka at their usual local ports, with no configuration per repository. Each runs inside the sandbox of the command that connects to it, started on first connection from binaries in the image, fresh for every command, and gone when the command ends; nothing outside that sandbox can reach it. No Docker daemon and no shared server. See [D11 detail](#d11-test-services-as-sandboxed-processes). |
| **D12** | **Each conversation in its place** | Clarifying requirements happens in a Mattermost thread, with whoever the ticket's author brings in; the plan, its revisions, its approval and questions about it happen in the Jira ticket; technical discussion happens on the merge request. A question to the workbench is answered where it was asked, without moving the job. Everything the workbench writes is Russian, short and structured (the language rule is revised by `D14`). Revises where `D8`'s gates live. See [D12 detail](#d12-each-conversation-in-its-place). |
| **D13** | **A standalone supervision dashboard** | The workbench serves its own read-only dashboard and API on its own port, apart from DSH's web app: a URL per job, the agent's trace read from its DSH session, no built-in sign-in (allowlisted `Host` names; an SSO proxy in front where it is reachable from elsewhere), and DSH's own UI opt-in. Revises how `D7` hosts the dashboard. See [D13 detail](#d13-a-standalone-supervision-dashboard). |
| **D14** | **Open-source release as Workflow Agent** | Release the project as **Workflow Agent** (`workflow-agent`) under **Apache-2.0**, keeping the adapted MIT code's notices; **English by default**, Russian kept, chosen per deployment and frozen per job; a fresh public history on GitHub; no upgrade from pre-release state. |

## D8: Owned workflow domain on DSH

**Status:** Accepted 2026-11-10; implemented. Revises `D3` and `D4`; extends `D2`.

### Context

V1 added a deterministic workflow coordinator *beside* the prototype's Eval → Ticket → Assignment → Executor work model, which was designed for an open-ended agent acting on implied intent. Running two orchestration models in one process broke the invariants of both:

- triggers are saved before an in-memory handling chain, so a restart can lose them;
- jobs get a synthetic mandate (`policyVersion: 'workflow-v1'`) and no recorded decision;
- an invited actor can pass a gate on message text alone;
- hand-back is a no-op, and idle handling targets a main session that workflow jobs don't have;
- job state is untyped, workflow definitions are unversioned, and a stage's self-reported `testsPassed` is trusted.

DSH has no durable multi-stage workflow engine, no budgets and no network isolation, so these belong to the product layer.

### Decision

1. **Keep** DSH (agent loop, sessions, presets, sandboxes) and the prototype integration layer (source kinds, channels, context readers, git transport). The prototype's SQLite store and effects/outbox are kept as patterns and rebuilt in the kernel, because decision 2 needs state, events and effects in one transaction. Sources write only to the inbox and never touch job state.
2. **One change path.** Every input (source event, gate reply, effect result, timer, agent tool call) becomes a command from a durable row. A per-job single-writer engine runs a pure `decide`/`evolve` core and commits the new state row, appended job events and emitted effects in one SQLite transaction (`BEGIN IMMEDIATE` plus a version check). The state row is the source of truth; the event log is for audit and projections.
3. **Intake.** A job starts only on an explicit trigger from an eligible actor, mapped to a known workflow by a deterministic policy check in the router. An immutable `IntakeDecision` records actor, policy version, definition and basis. No LLM routes.
4. **Versioned definitions and a frozen run manifest.** Each job pins its definition hash, prompt hashes, presets, model, sandbox and egress profiles, and policy version. Resume and backtrack use the manifest, never "latest". Jobs whose definition is not registered are parked.
5. **Stage execution.** A fresh DSH session per stage attempt, started from typed inputs, prior artifacts and a recovery note. Stage reports are proposals: transitions wait for host-run checks (check command, CI for the pushed SHA, test-integrity diff check, clean-context review).
6. **Safe outputs.** Agents request external writes through typed tools. The engine validates them against stage capabilities and the effects queue performs them with deterministic idempotency keys and marker-based reconciliation. Credentials never enter the sandbox.
7. **Gates.** Question and approval gates are typed records bound to an artifact revision digest and a thread; a new revision supersedes open gates.
   - A question gate holds every open item and allows follow-up rounds within a budget.
   - **Approvals are read from the meaning of the human's own message.** There are no buttons, commands, reactions or Jira transitions as approval inputs.
   - Admission is deterministic: an eligible, source-verified actor, on the bound thread, posted after the current revision.
   - Intent goes through the RU/EN vocabulary fast path, then a model verdict (`approve`, `approve_with_notes`, `request_changes`, `question`, `cancel`, `unrelated`, `unclear`).
   - Conditional replies count as change requests. An unclear reply, low confidence or an unavailable model never approves.
   - Every approval is acknowledged with what was approved.
   - The requester may approve their own job; the bot never can.
8. **Timers** are durable rows that become commands. They cover gate reminders, gate deadlines (expiry never approves), total wall-clock per attempt and effect retry backoff. When a timer fires, it is dropped if its subject is no longer current.
9. **Budgets.** Turns, attempts, backtracks per edge and in total, wall-clock time, and tokens/cost per job are enforced by the host. When a budget runs out, the job blocks and asks its owner to extend or cancel.
10. **Network egress** (extends `D2`). Inspect and plan stages have no network. Implement and review reach public package registries only, through an allowlisting proxy. Jira, GitLab and Mattermost are reached only through host tools. Documentation pages can be fetched through the host-side `web_fetch` tool for domains on a deployment allowlist (`GET` only, no private or loopback addresses); `web_search` stays off. (The documentation fetch was not built: it would have shipped switched off, so it is a follow-up.) No private registries or internal hosts until explicitly requested.
11. **Retention.** Job events, gate responses, effects and DSH session logs are kept indefinitely. Only worktrees are cleaned, because they can be rebuilt from git.
12. **Scope.** Only `standard-delivery` ships. Small tasks run the same stages faster; there is no lighter workflow without a plan gate.
13. **Packaging.** Everything is a Cordis plugin, in DSH's idiom.
    - A long-lived core plugin provides the store, inbox, policy, workflow engine (service `wbWorkflows`) and effects. These share one transaction boundary, and a plugin boundary never splits a transaction.
    - Workflow definitions, sources, checks and tools are contributor plugins, registered as disposable effects.
    - Stage runner, workspace and supervision are adapters.
14. **Outbound-only connectivity (`D5`) stays.**

### Alternatives rejected

- **Re-seat into the prototype work model** (a workflow Assessor plus a stage-aware Executor). It puts stages, gates and approvals behind the Executor port, outside the single writer, and keeps a work model built for the opposite approach.
- **Patch V1 in place.** Two models keep drifting, and every feature is built twice.
- **Adopt Temporal, Restate or DBOS.** A new runtime service on a single-node Compose deployment, against the agreed stack. We borrow their principles instead: pinned versions, inbox/outbox, single writer per key.
- **Write our own agent loop.** DSH is that loop.

### Consequences

- **Positive:** one change path; restart recovery is mechanical; intake is auditable; definitions can change safely; verification is done by the host; the core is smaller.
- **Negative:** a substantial rebuild of the domain layer and its tests; we own and must rigorously test an engine kernel (model-based property tests, crash simulation); old definition versions must stay loadable; approval quality depends on a model, so a labelled RU/EN reply corpus with a zero-false-approval bar gates releases.
- **Migration:** V1 has no users, so there is no stopgap patch and no V1 data migration, and v2 starts with a fresh schema. The order is: upgrade DSH to `0.2.2-rc.1` with exact pins and Node 24.9 (a separate decision that updates `D1`), then the kernel, then the domain, then verification and safety, then cut-over. Legacy Engine/Eval/Ticket/Executor/Passes and the V1 coordinator are deleted at cut-over.

### Amendment: review severity, evidence and merge risk (2026-11-14)

**Status:** Accepted 2026-11-14 by the maintainer; implemented. Amends decision 5 (the clean-context review) and builds on `D12` after-trial items 3 and 5. It adapts ideas from two MIT-licensed skills, `review-pr` and `merge-risk` (`warpdotdev/common-skills`; `merge-risk` credits Matt Pocock's `skills`); provenance in [UPSTREAM](UPSTREAM.md#4-adapted-ideas).

1. The clean-context review stays one model call with no tools that reads the approved plan, the follow-ups and the diff, and nothing else. It does not read the merge request description or the stage report.
2. Each finding has a severity: `critical` and `important` can fail the check; `suggestion` and `nit` are notes. Robustness (timeouts, retries, lifecycle) is a suggestion unless it risks correctness, security or data loss.
3. A finding fails the check only with evidence the host verified: a quote found on or near a changed line of the annotated diff, or, for something missing, a quote found in the plan or a follow-up plus a named token absent from the change. Anything else is demoted to a note. The check fails only when the model says `changes` **and** a verified critical/important finding remains; a `changes` answer that gives no evidence at all is asked again once, then blocks for a person. On failure the engineer gets only the verified blocking findings.
4. Before its verdict the reviewer audits each test the diff adds or changes against what the test claims.
5. The same call returns a merge-risk summary (alignment, impact, verification, rollback cost, error detection). The host computes low/medium/high, with floors for sensitive areas and the worst impact or rollback. It never gates. It is posted by the host: one line in the completion post, a note on the merge request (only when there is one), and on the dashboard, with any demoted serious findings.
6. The implement and review stages audit their own diff before reporting and write the MR description in a fixed shape (`standard-delivery@9`).

**Out of scope:** GitHub review JSON, suggestion blocks, the validator script, screenshot/profiling requirements, a second-opinion review call (beyond the one re-ask for missing evidence), gating on risk, the host editing the MR description, inline MR diff comments, validating the MR description's headings, repository conventions for the *reviewer* (a follow-up).

## D9: Settings are deployment configuration

**Status:** Accepted 2026-11-11; implemented. Extends `D7` and `D8` (decision 4).

### Context

V1 kept operator settings in the SQLite store and edited them on dashboard forms: policy rules and admission, the eval mode, the worker and orchestrator models, the worker count, the prepare command, Source settings and the team's prompts. `D7` makes the dashboard read-only, so those forms saved through a stub that wrote nothing and reported "Saved". The only writes were Source syncs and the `WORKBENCH_ALLOWED_SENDERS` seeding. As a result no deployment could choose a model.

### Decision

1. **Configuration owns settings.** Operator settings live in the deployment's configuration: the profile patch for structure and values, and environment variables or the DSH credential store for hosts and secrets. The configuration is versioned in git next to the workflow definitions and changes by a reviewed change and a redeploy.
2. **Models.** The profile sets the default model for agent stages and the model for approval verdicts. A workflow stage may name its own model and reasoning effort. The run manifest (`D8`, decision 4) freezes the resolved model of every stage, so a configuration change never moves a running job. Stages start on the one default; a stage gets its own model only when the end-to-end eval shows a better cost per accepted MR or better review findings. V1's two roles (`worker` for every stage, `orchestrator` for the LLM main session) do not carry over: `D8` removes the main session, so the V2 model uses are the four stages, the approval verdict and the clean-context review check (`D8`, decision 5).
3. **The dashboard reads, never writes** (`D7`). It shows the effective value of each setting and where it comes from.
4. **Secrets never go in the profile.**
5. **Interim.** The V1 settings and prompts pages were shown read-only, with no save, until the read-only dashboard replaced them.

### Alternatives rejected

- **A writable dashboard.** It reverses `D7`, needs authentication and authorization for writes and a proxy that carries WebSocket traffic, and keeps the change history outside code review.
- **Environment variables only.** No structure for per-stage models, and no history beyond the deployment's own.

### Consequences

- **Positive:** every change is reviewed and auditable in git; a job's models are reproducible from its manifest; the dashboard stays read-only.
- **Negative:** a setting change needs a redeploy; operators edit a file instead of a form.

## D10: Repository profiles and toolchains

**Status:** Accepted 2026-11-12; implemented. Extends `D2`, `D8` (decisions 3, 4 and 10) and `D9`.

### Context

- **One repository per deployment.** `standard-delivery` took one `repository`, one `targetBranch` and one `testCommand` from the deployment. A workplace has many repositories, often in different languages.
- **One language in the image.** The image is `node:24.22.2-bookworm-slim`: it has Node and npm and no Python, Go, Java or Rust. A Python repository cannot run its tests at all.
- **The network is closed** (`D8`, decision 10). Inspect and plan get no network; implement and review reach public package registries only. An agent cannot download a toolchain, and should not: toolchains come from hosts such as GitHub release assets, which would widen the paths out of the sandbox.

### Decision

1. **Repository profiles.** The deployment configuration (`D9`) lists repositories. Each profile has the GitLab project path, a short name, the target branch, the test command, an optional setup command, its registry presets, optional default toolchain versions, match rules, and whether the repository has CI (`ci: required | none`, default `required`).
   - **Choosing a repository is deterministic** (`D8`, decision 3): an explicit `repo:<name>` in the triggering message, else a Jira project key, else a Mattermost channel, else the deployment's default.
   - **No match and no default:** the workbench replies with the configured repository names, and no job starts.
   - **Amended 2026-11-12** (the maintainer's decision):
     - **Per-repository senders.** A profile may list `senders`, per source, in the forms the global sender policy accepts. When present, only those senders may start a job on that repository, and they must still be allowed globally (both rules apply); when absent, the global senders apply.
     - **No contradicting override.** When the trigger's thread maps to a repository by its Jira project or Mattermost channel, a `repo:` naming another repository is refused. A `repo:` naming the same one, or used where nothing maps (a direct message, an unmapped channel), is allowed, subject to the senders rule.
     - **Refusals start no job** and get a reply saying why (not allowed on that repository, or it contradicts this thread's repository). The no-match reply lists only the repositories this sender may use.
     - The choice and the sender check happen at intake, after the existing eligibility checks (`A18`), and are recorded in the intake decision; a later change to `senders` moves no running job (`A13`). Per-repository approvers are a follow-up.
   - **Frozen:** the run manifest freezes the chosen profile.
2. **The repository pins its toolchains** in `mise.toml` or `.tool-versions`, plus `.python-version` and `.nvmrc`. A profile's defaults apply only to tools the repository does not pin.
   - **The host parses these files itself.** It accepts only tools from an allowed list and plain version strings.
   - **It never runs repository configuration** (environment directives, hooks, tasks or plugins).
3. **A host-run setup step, once per job worktree, before the first stage.** It is a long effect, like a check, and is safe to repeat. It has two parts:
   - **Install the toolchains** with `mise`, in a sandbox of its own, not the agent's: only the toolchain cache is writable, and the network is a separate `toolchain` allowlist (the toolchain download hosts). Only the host selects this profile, never anything a stage can set.
   - **Run the profile's setup command** (for example `npm ci` or `uv sync --frozen`) inside the job's sandbox, with the `registries` egress profile and the toolchains on `PATH`.
   - **On failure the job blocks** with the log tail and asks its owner to retry or cancel. The cause is the environment, not the agent, so it is not retried as an attempt.
4. **The toolchain cache is shared and read-only to every sandbox and check.** Only the setup step writes it, one entry per tool and version, so one job cannot change another's toolchains. Global installs go to the job's own home instead, and no tool downloads a toolchain by itself (for example `GOTOOLCHAIN=local`).
5. **Languages.** Node and Python are tested end to end, and Go by a smoke test, with the registry presets `npm`, `pypi` and `go`. Only allowed tools are installed, from backends that verify checksums.
   - **Other `mise` toolchains work untested** once a deployment adds their public registry hosts.
   - **Private registries and internal hosts stay out of scope** (`D8`, decision 10).
6. **System libraries** that `mise` cannot provide (for example `libpq` or a browser) come from a deployment image built on ours. DEPLOYMENT documents how.
7. **Agents may still install packages** in implement and review: they edit the manifest and run the package manager through the proxy.

### Alternatives rejected

- **One large image with every language.** It is gigabytes, fixes one version of each tool, and still misses the versions a repository pins.
- **A container per job, built from the repository's devcontainer or Dockerfile.** The workbench would need the Docker daemon (root-equivalent access) or a separate sandbox service, replacing DSH's sandboxed execution against `D8` and the agreed stack.
- **Agents install toolchains themselves.** Agent egress would need the toolchain download hosts, and one job could poison a cache shared with others.
- **`asdf` and other plugin backends.** They run arbitrary scripts from plugin repositories.

### Consequences

- **Positive:**
  - any language `mise` supports, without rebuilding the image;
  - versions match each repository's pins;
  - one cache for all jobs;
  - agents get no extra network.
- **Negative:**
  - the first job on a new toolchain version waits for the download;
  - `mise` becomes a pinned dependency of the image;
  - the configuration shape changes: `repositories` replaces `standardDelivery.repository` and `testCommand`, and state is reset, not migrated;
  - only the host's setup step may reach the toolchain download hosts.

## D11: Test services as sandboxed processes

**Status:** Accepted 2026-11-12 by the maintainer, after a revision the same day at the maintainer's direction: no configuration per repository, the services a Python backend commonly needs (Postgres, RabbitMQ and Kafka), and the Postgres major taken from the repository, so two repositories on different majors each test against their own. Implemented. Extends `D2`, `D8` (decision 10) and `D10`.

### Context

- **Backend tests need services.** A Python service's tests often expect Postgres, a message broker (RabbitMQ, for example under Celery or taskiq) or Kafka. CI provides them as `services:` (in GitLab CI, a container per service, reached by names such as `postgres`). Today a job has none, so such a suite fails in the agent's shell and in the host's `tests` check, whatever the agent does.
- **One sandbox per command.** Every command, whether an agent's shell command, one of its background jobs or a host check, runs in its own `bwrap` sandbox: its own PID namespace (everything in it ends with the command), its own network namespace with only its own loopback (`--unshare-net`), and an empty `/tmp` (DESIGN §5). Two commands cannot reach each other, and nothing outside can reach either.
- **No containers inside.** The workbench has no Docker daemon, and `D10` rejected giving it one: it is root-equivalent, and it would replace DSH's sandboxed execution.
- **Probe.** In a throwaway container of the image, non-root, inside a sandbox with the wrapper's exact `bwrap` arguments, Debian's Postgres 15 ran `initdb` in 0.44 s; starting a copy of an initialised data directory and answering a query took another 0.16 s. RabbitMQ and Kafka were measured later (consequences).
- **Binaries for both architectures** (as of 2026-11-12; the image targets arm64 and amd64):
  - **Postgres:** the PostgreSQL project's apt repository (PGDG) has every supported major for Debian bookworm on amd64 and arm64, about 60 MB each installed. Postgres 14 reaches its end of life on 2026-11-12, so the supported majors are 15–18.
  - **RabbitMQ:** RabbitMQ's own Erlang packages for bookworm are amd64 only, and RabbitMQ 4 needs a newer Erlang than Debian's. Debian bookworm has RabbitMQ 3.10.8 on both, with Debian's security fixes.
  - **Kafka:** Apache's release is Java bytecode, the same on both (current release 4.4.0); it needs Java 17 or later, and Debian bookworm has OpenJDK 17 on both. It runs in KRaft mode, without ZooKeeper.

### Decision

1. **Every job has the same services, and nothing needs configuring per repository.** Postgres, RabbitMQ and Kafka are in the image. A repository's test command uses them as it would a developer's local services; it runs its own migrations and creates its own databases, queues and topics.
2. **A service runs inside the sandbox of the command that uses it, and only for as long as that command.**
   - The wrapper starts each command under a small launcher (like the egress bridge) that listens on each service's usual port on the sandbox's own loopback: `5432` (Postgres), `5672` (RabbitMQ, AMQP), `9092` (Kafka).
   - **The first connection starts the service.** The launcher copies a data directory initialised when the image was built into the sandbox's `/tmp`, starts the server, waits until it answers (holding the connection), and then carries it through. A command that never connects starts nothing, so `ls` or `ruff` costs nothing.
   - **Every command starts fresh,** as a CI job's services do. Nothing is left when the command ends: the PID namespace and the `/tmp` go with it.
   - **No new boundary.** The service runs as the same user, in the same sandbox, with the same masks, as the command that uses it. It is reachable from nothing else, and it reaches nothing: the network is unchanged.
3. **Where services exist:** agent shells in implement and review (and their background jobs), and the host's `check` profile. Not inspect or plan (no shell), and not `fetch`, `toolchain`, `verify` or `setup`.
4. **How tests find them.** The defaults of each project's official container image, so most CI settings work unchanged:
   - **Names:** `postgres`, `rabbitmq` and `kafka` resolve to the sandbox's loopback, as service names do in GitLab CI; so does the sandbox's own hostname (Erlang and Java look it up, and an unknown name waits for DNS that never answers).
   - **Postgres:** user `postgres`, password `postgres`, database `postgres`, a superuser, so tests can create their own databases.
   - **RabbitMQ:** user `guest`, password `guest`, virtual host `/`.
   - **Kafka:** one broker, plaintext, no authentication, topics created on first use.
   - **Variables**, set by the wrapper after it removes credential-shaped variables, because these name a server that exists only inside that sandbox: `DATABASE_URL` and `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`; `AMQP_URL` and `RABBITMQ_URL`; `KAFKA_BOOTSTRAP_SERVERS`.

   A repository whose tests expect other names or credentials sets them in its test command (for example `DATABASE_URL=postgresql://postgres:postgres@localhost/app_test pytest`).
5. **Versions come from the image,** like the compilers (`D10`, decision 6):
   - **Postgres 15, 16, 17 and 18** from PGDG's repository, server packages only, signing key pinned by fingerprint;
   - **RabbitMQ 3.10** from Debian;
   - **Kafka 4.4** from Apache's release, SHA-512 pinned, on Debian's OpenJDK 17.
6. **The repository says which Postgres major it uses,** as it pins its toolchains (`D10`, decision 2). The host's setup step reads the image tags its CI already names: the `services` of `.gitlab-ci.yml` (for example `postgres:15`) and the `image` of a Compose file's services (`docker-compose.yml`, `compose.yaml`). It reads them as data, at the job's start, from the target branch, so an agent's later edit does not change them; it takes only the leading major of a `postgres` tag and runs nothing.
   - **No tag, or a tag it cannot read** (`postgres:$PG_VERSION`, `latest`): the newest major, noted in the setup log.
   - **Two majors named:** the newest, noted.
   - **A CI or Compose file the host cannot read or parse:** the setup step blocks and asks for the profile's `postgres`, rather than guess.
   - **A major the image does not have:** the setup step blocks and says which, as it does for a toolchain it cannot install (`D10`, decision 3).
   - **An optional `postgres` field in the repository profile** overrides what is read, for a repository whose files mislead.
   - **RabbitMQ and Kafka have one version each.** A repository that names a different major gets a note in the setup log, and the job runs.

   The chosen major is recorded in the job's sandbox file, and every sandbox of the job uses it.

   The servers run tuned for tests: no `fsync`, small buffers, and a capped Java heap for Kafka. A deployment that needs another version, an extension (for example PostGIS) or another service builds its image on ours, as DEPLOYMENT describes for system libraries.
7. **A service that will not start** closes the connection and prints `workbench-services: <service> did not start` with its log tail. In a host check that is the environment, not the agent, so the check is `blocked` with the log, as other checks block on the environment. The line comes through the command's own output, so an agent's code could print it too; that can only block the job for a person, never pass a check, and the evidence keeps the end of the log.

### Alternatives rejected

- **Declaring services per repository** (this decision's first draft): configuration for every repository, for a few hundred megabytes of disk saved. Services that are not used cost nothing but disk (decision 2), and the repository's CI already names the Postgres major (decision 6).
- **One Postgres major for the deployment:** a repository on another major would test against the wrong one, and a test could pass here and fail in production.
- **Docker, Testcontainers or Compose services** for each job: the workbench would need the Docker daemon, which is root-equivalent (as in `D10`). A suite that starts its own containers needs a switch to use the provided services instead; many read a variable for that.
- **Services that run all the time,** for the deployment or for a job:
  - they hold memory while nothing uses them, and while a job waits at a gate;
  - every sandbox would need a path out to reach them, and jobs could reach each other's data;
  - data an agent left behind would reach the host's `tests` check, so a row seeded by the agent could make a test pass.
- **RabbitMQ 4 on both architectures:** it needs an Erlang built for arm64 outside Debian's and RabbitMQ's packages. Version 3.10 speaks the same AMQP 0-9-1 that Python clients use.
- **Swapping in SQLite or in-memory fakes:** the tests would no longer test what runs in production.

### Consequences

- **Positive:**
  - suites that need Postgres, RabbitMQ or Kafka run in the agent's shell and in the host's checks, as in CI, on both architectures, with no configuration;
  - each repository tests against the Postgres major its CI uses;
  - no network change, and no service is reachable outside its own sandbox;
  - every host check gets clean services, which the test-integrity check (`A14`) relies on.
- **Negative:**
  - the image grows by about 1 GB (1.45 GB to 2.44 GB, measured): four Postgres majors with the LLVM library their packages need, Java 17, Kafka and Erlang;
  - state does not survive between an agent's commands, so seeding data and running tests happen in one command, as in CI;
  - each command that connects pays the start-up time once (measured on Apple Silicon, Docker Desktop, with the image's files cached): 0.2–0.6 s for Postgres, 4–5 s for RabbitMQ (with two Erlang schedulers and no busy-waiting; 7–22 s without) and 1–2 s for Kafka (a topic, a message and its read-back with three Java clients: 3–7 s);
  - each running service holds memory for as long as its command runs: about 100 MB for Postgres, 140 MB for RabbitMQ and 360 MB for Kafka. Several commands using Kafka at once each run their own broker, so the host needs memory for them;
  - RabbitMQ and Kafka have one version each;
  - only these three. Others (Redis, MySQL, Elasticsearch or OpenSearch, MongoDB, S3-compatible storage) are follow-ups.

## D12: Each conversation in its place

**Status:** Accepted 2026-11-13 by the maintainer, after answering its seven questions the same day ([below](#maintainers-answers-2026-11-13)), including the proposal on budget, resume and cancel gates. Implemented. It follows the maintainer's description of how a delivery team works with a ticket, written here in general terms. It revises `D8` (decisions on gates and threads) and `D4` (where an approval is admitted, and who may approve), and changes PRD `F5`, the approval rules and `A12` (below).

### Context

**How a delivery team works a ticket.** Analysts, developers and testers share a ticket. The engineer who takes it:

1. moves it to *In Progress* and reads it;
2. clarifies what is unclear with the ticket's author in Mattermost. The author answers some questions, says someone else knows the rest, and brings that person into the thread; both may ask what a question means. This goes back and forth until the requirements are clear;
3. posts the plan in the Jira ticket, which is the source of truth for requirements and plan, and says in Mattermost only that the plan is there. The plan is discussed and approved only in Jira. A question about the plan is answered in Jira; a gap in the requirements goes back to Mattermost, and then the plan is revised in Jira;
4. implements, and discusses the code on the merge request in GitLab. A business question found there goes back to Mattermost and to the plan in Jira, and the code is redone;
5. finishes when the merge request passes.

**What the workbench did before this decision:**

- **One thread for everything.** Every gate (a question round, the plan's approval, a blocked job's resume) opens on the job's origin thread, the one the trigger was posted in (`openGate` uses `originThread`), and a reply counts only there. Started in Mattermost, the whole plan and its approval are in the chat; started in Jira, the questions go to Jira and Mattermost is not used.
- **The plan is in two places, approved in the wrong one.** The plan stage's agent comments the plan in Jira, and the host posts the whole plan with the approval request on the origin thread. A Jira reply never approves.
- **A question about the plan makes a new revision.** The verdict model reads it as `question`, and the plan stage writes a revision with a section that answers it. Nobody gets an answer where they asked.
- **A question round closes on the first reply.** That reply becomes the answers to every item and starts a new attempt. The rest can be asked in a later round, and inspect has three.
- **Only allowed senders may answer.** A person the author brings in is refused unless the deployment's global allowlist names them, and gets no reply. The agent cannot mention anyone; the host posts its questions.
- **Every reply costs a stage attempt.** "What does question 2 mean?" is taken as answers, uses a round, and starts an attempt of 1–3 minutes.
- **Merge request comments** steer the running attempt, wait for the next one, or reopen a completed job at `review`, where a question is taken as feedback to act on.
- **Language.** Fixed messages follow the profile's `locale` (default `ru`), and the stage instructions are Russian. No rule keeps messages short, and the approval post carries the whole plan into the chat.

The engine underneath fits: the single-writer kernel, effects, thread bindings (Jira issues and merge requests are already bound to their jobs), revision-bound approvals and the reply verdict model all carry over.

### Decision

1. **Each conversation has its place.** A workflow says, for each kind of conversation, where it happens, as data (PRD §5: the engine hardcodes no stage or place):
   - **clarification** (question rounds): the job's Mattermost thread;
   - **the plan** (the artifact, its revisions, its approval gate and questions about it): the Jira ticket;
   - **the code** (feedback and questions on the change): the merge request.

   A gate opens on its place's thread, not on the origin thread. A reply counts toward a gate only on that thread, as today.
2. **The job's Mattermost thread.** A job started in a Mattermost channel uses its trigger's thread. A job started in Jira, or by a direct message (which cannot take more people), gets a new thread in its repository's mapped channel: the workbench posts a short root message naming the ticket and its author, links it in a Jira comment, and binds it to the job.
3. **Clarifying with several people.**
   - **Questions are numbered, short, and addressed:** to the ticket's author (its Jira reporter, matched to a Mattermost user, decision 8), or to the requester when there is no ticket.
   - **A round stays open until every item has an answer.** A reply may answer some items (`1, 2 и 4: …`); the workbench records which, and asks only about what is left. "Не знаю, решай сам" is an answer: the item becomes an assumption, stated as one in the plan, where the approvers see it. Nothing else closes a round early. Its reminder (24 hours) and deadline (7 days, after which the job blocks) stay.
   - **Answers from anyone in the thread count:** anyone who can post in the job's Mattermost thread, which is everyone in its channel. When someone says "ask X about 3", the workbench asks X by name in the thread. Every answer is recorded with who gave it, and the plan names the source of each clarified requirement, so the approvers see who said what before they approve.
   - **The agent can be asked back.** "What does 2 mean?" or "that is out of scope" gets a short answer in the thread (decision 5) and keeps the round open; it uses no round and starts no stage attempt.
4. **The plan lives in Jira.**
   - **The host posts each revision** as a Jira comment headed with its number (`План, ревизия 2`), as an effect bound to the revision's digest; the agent no longer posts it itself. The Mattermost thread gets one line with a link: the plan is in the ticket.
   - **The approval gate opens on the Jira ticket,** and only a Jira comment approves: from one of the repository's approvers (decision 9), posted after the revision, read by the same rules (a short approval without a model; anything else by the verdict model; unclear never approves). The acknowledgement is a Jira comment.
   - **A question about the plan gets an answer in Jira** (decision 5), and the gate stays open: no new revision.
   - **A change to the plan** makes a new revision, posted in Jira. **A gap in the requirements** goes back to inspect: the questions go to the Mattermost thread, and the next revision comes to Jira.
5. **Answer turns.** A question to the workbench, in any of its places, gets a short answer in the same thread without moving the job: a single model turn, read-only, with the job's context (the ticket, the answers so far, the current plan revision and, on a merge request, the diff), no tools that change anything, and its tokens counted against the job's budget. The verdict model, which already tells a question from an approval or a change, decides when a reply is a question. If answering needs more than reading (the requirement is unclear, or the plan is wrong), the answer says so and the job takes the matching path (decisions 3 and 4).
6. **The code is discussed on the merge request.**
   - **A question about the code** gets an answer turn in that discussion, while the job runs and after it completes.
   - **A requested code change** is taken by the `review` stage, as now; while implement is still running, it is kept for review rather than steered into implement.
   - **A business question or a changed requirement** goes back to plan or inspect: clarified in Mattermost, revised and re-approved in Jira, then implemented on the same merge request (as a review check's finding already does).
7. **Russian, short and structured.** Everything the workbench and its agents write to people is Russian (the profile's `locale`, `ru`, applies to agent text through the stage instructions, and stage titles are localized). One style rule in every stage's instructions and in answer turns: lead with what is needed from the reader; numbered items; no preamble, no restating the ticket, no closing pleasantries. The plan is never posted in a chat; fixed messages are shortened to one or two lines.
8. **People across tools, by email.** A Jira user and a Mattermost user are the same person when their email addresses match. The Mattermost connector already looks users up by email; Jira must show users' emails to the workbench's account (on Jira Server, the administrator's user email visibility setting). A ticket's author without a match is named in plain text, and the requester is asked instead.
9. **Who may do what** (policy roles of `D8`, extended):
   - **start a job:** unchanged (`A18`: a mention or a direct message, by an allowed sender);
   - **answer clarifications:** anyone who can post in the job's Mattermost thread;
   - **approve a plan:** in Jira, only the approvers the repository's profile lists (a new `approvers` field listing their emails, resolved to each tool's user at startup). Neither the requester nor the ticket's author approves unless listed;
   - **extend a budget, resume or cancel a blocked job:** the same approvers. These gates are posted in the job's Mattermost thread, where the team follows the work, and decided there (approvers are matched to their Mattermost user by email, decision 8);
   - **request code changes:** anyone who may comment on the merge request, as now.

### Alternatives rejected

- **Keep one thread, and also accept approvals in Jira:** two places to approve the same revision, and the questions and the whole plan still go wherever the job started.
- **Let the agents post anywhere** (Mattermost and Jira write tools in every stage): the host would no longer own where a gate is and who may answer it, which `A5` and `A12` rely on.
- **A chat bot that answers every message with a full agent turn:** costly, and the job's progress would depend on the model rather than on the host's gates.
- **Treat every question as a request for a new revision** (today): a revision for each question, and the asker never gets a direct answer.

### Consequences

- **Positive:** the workbench works the way the team already does: requirements clarified in chat, the ticket as the source of truth for the plan, code discussed on the merge request. Questions are answered where they are asked, a partial answer no longer wastes a round, and people the author brings in can take part.
- **Negative:**
  - more moving parts: gates on three kinds of thread, people matched across tools, answer turns and round bookkeeping;
  - answer turns cost tokens on every question asked of the workbench (bounded by the job's budget);
  - a job started in Jira needs its repository mapped to a Mattermost channel;
  - anyone in a job's channel may answer its questions, so the channel's membership is the boundary of who shapes the requirements: a repository's channel should be one only the team can join (a private channel). Approval stays with the listed approvers, who see in the plan who gave each answer;
  - matching by email needs Jira to show emails to the workbench's account;
  - the requester no longer approves their own job unless listed as an approver (today they may);
  - the eval's scenarios and the reply set change: approvals move to Jira, and new cases cover partial answers, redirects and questions back.

### PRD changes on acceptance

- **§2 Users:** a *participant* (anyone in a job's clarification thread) answers questions; the repository's approvers approve in the ticket.
- **§3:** a new fixed decision: each conversation in its place (`D12`); all text Russian, short and structured.
- **`F5` Human interaction:** questions record their recipient and items; a round stays open until each item is answered; answers from several people count; a question back to the workbench is answered where it was asked.
- **Approval rules, admission:** the gate's thread is the plan's place, the Jira ticket.
- **New acceptance criteria**, numbered `A22`–`A26` in the PRD:
  - a job's questions are in its Mattermost thread; a job started in Jira opens one in its repository's channel and addresses the ticket's author;
  - a partial answer leaves the rest of the round open; anyone in the job's thread can answer; only the repository's listed approvers can approve, and only in Jira;
  - a question to the workbench in Mattermost, Jira or on the merge request gets an answer there, with no new revision and no stage attempt;
  - the plan and its revisions are posted only in Jira, only a Jira comment approves, and the Mattermost thread gets a link only;
  - everything the workbench writes is Russian, and no chat message carries the plan.

### Maintainer's answers (2026-11-13)

The seven questions this draft raised, with the maintainer's choice; decisions 3, 4, 8 and 9 above follow them.

1. **Who may answer clarifications?** Anyone in the job's Mattermost channel (the draft recommended only allowed senders, the ticket's author and people mentioned in the thread). The channel's membership is the boundary, and the plan names who gave each answer.
2. **Who may approve a plan?** Only the approvers listed per repository (the draft also offered the ticket's author). The requester no longer approves by default.
3. **What starts a job?** Unchanged: a mention of the bot, in Mattermost or in a Jira comment, or a direct message, by an allowed sender (`A18`). Assigning a ticket to the bot does not.
4. **How are people matched across tools?** By email (the draft recommended usernames).
5. **Where does a Jira-started job's thread go?** A new thread in the repository's mapped Mattermost channel. A repository with no mapped channel cannot take Jira-started jobs, and says so in the ticket.
6. **Merge request comments while implement runs?** A question gets an answer at once; a code change request waits for the review stage; a business question goes back through Mattermost and Jira.
7. **When does a question round close?** When every item has an answer; "не знаю, решай сам" counts as one, and becomes a stated assumption in the plan. No early close; the reminder and the deadline stay.

Not asked, proposed and accepted with the rest: budget, resume and cancel gates are posted in the job's Mattermost thread and decided by the repository's approvers (decision 9).

Asked later the same day, before the maintainer's manual trial: **a job with no ticket?** It is refused. A workflow whose plan lives in the ticket starts only from a Jira comment or from a trigger that names an issue key (`@workbench сделай ORD-123`); any other trigger gets a short notice where it was posted (`no_ticket`), so a plan never lands outside Jira. When the repository maps Jira projects, only a key of one of them counts, and a job whose ticket cannot be linked at start fails with the reason. (The first implementation had kept such a plan in the Mattermost thread.)

### After the maintainer's trial (2026-11-14)

The maintainer's trial on a test repository showed where people were left guessing. The maintainer decided the first three; the rest followed the recommendations put to the maintainer, who did not choose otherwise.

1. **Someone who may not approve is told so** (maintainer). Their «ок» on the plan gets one line naming who approves («@dev-ivan, одобрить план может только @lead-1. Вопросы — пожалуйста.»); their questions are still answered and their talk gets nothing. An «ок» in the Mattermost thread for a plan waiting in Jira gets «План одобряется в задаче ORD-300 (@lead-1).»
2. **Their change request goes to the approvers** (maintainer). It does not revise the plan and is not dropped: «@lead-1, @dev-ivan предлагает: … Изменить план?». The approver's answer decides: agreeing makes a revision, approving keeps the plan as it is.
3. **The completion post says the implementation is ready for review** (maintainer), not that the task is done, with the checks named in words and that comments on the merge request reopen the job. The dashboard says «Готово к ревью» for such a job.
4. **A merge request comment that changes the requirements goes to the plan first.** It is read with the approved plan; a change of behaviour, inputs, outputs, errors or interfaces reopens the job at `plan` (`reopen.requirements`) with a note on the merge request, and never reaches the code before a new approval. Plain thanks reopens nothing; anything else is still a follow-up. (In the trial a review attempt built the new behaviour and pushed it before going back to the plan.)
5. **The clean-context review fails work only on a concrete defect.** A doubt is a note that passes. A second opinion before failing was considered and left out, since it would double the review's cost.
6. **Answers on the merge request go into the comment's discussion.**

**Change proposals** (maintainer, 2026-11-14, revising 2 and 4 above). A change to the approved requirements is one record on the job, a *proposal*, from where it was asked until it is done; the forwarding of 2 and the routing of 4 become cases of it:
1. **Raised** when a comment is read as changing the requirements (a merge request comment, a message in the chat thread, or a change asked for on the plan by someone who may not approve). One from an approver is accepted at once; any other is put to the approvers.
2. **Decided by the approvers, in the ticket, whatever the job is doing**: on the open plan approval when there is one, else on a proposal request that does not stop the job. «да» accepts, «нет» declines, «1: да, 2: нет» decides each. On the plan approval, accepting any makes a revision, and «нет, ок» declines them and approves; a bare «ок» with a proposal pending is unclear.
3. **Accepted** goes to the plan: a finished job reopens there, a running one goes there when its attempt ends, an open approval becomes a revision. The revision lists the requested changes it includes.
4. **The person who asked hears back where they asked**, in the merge request discussion or the thread: passed to the approvers, declined, included in revision N and approved, done with the commit.

### Closing a finished job (2026-11-15)

The trial showed a gap: a finished job takes merge request feedback until a fact its version declares closes it, so a job whose version declares no `completeOn`, or one whose merge request is closed without a merge or left open, never closes, and any comment can reopen it on a branch that is gone. The maintainer chose, from the design put to them:
1. **An approver closes it in the work tools**, with a standalone `закрой` (`закрыть`, `close`, …) on any of the job's threads, not with an operator command or a dashboard control: operational requests stay in the work tools (PRD decision 6) and the dashboard stays read-only. Anyone else is told who may. No slash form: `/close` is a GitLab quick action.
2. **A merge request closed without a merge closes the job** (`mr_closed`, `standard-delivery@12`), as a merge does.
3. **A comment on a closed job is answered once per thread**: the job is closed, and new work is a new task. Silence had left people guessing in the trial.

Closing is host logic, so jobs pinned to earlier versions get it with no migration; moving a job to a newer version was rejected (`A13`). A merge is still reported only with a green pipeline, so a merge with a red or no pipeline closes nothing; `закрой` covers it.

## D13: A standalone supervision dashboard

**Status:** Accepted 2026-11-13 by the maintainer, with the design and the approved mockup; implemented. Revises how `D7` hosts the dashboard; the read-only rule stands.

### Context

The panel lived inside DSH's web app. An operator took a login token from the logs, opened DSH's home and chose the workbench's panel in its sidebar, next to DSH's own "New Session". `workbench-proxy` added the panel's request header to every request, so all of DSH's UI was published on `127.0.0.1:25400`. The panel had no URL per job, showed raw thread keys and user ids, none of the workbench's own posts, and nothing of what the agent thought or did.

### Decision

1. **Its own server.** The runtime starts a small `node:http` server on `WORKBENCH_DASHBOARD_HOST` (default `127.0.0.1`) and `WORKBENCH_DASHBOARD_PORT` (default `25410`) and stops it on shutdown. It serves the page and the API under `/api/`. The API leaves DSH's web server, and the DSH client plugin is removed.
2. **Still read-only** (`D7`, `D9`). Only `GET` and `HEAD`; every other method gets `405`. Nothing on the page changes anything. The values of the deployment's secrets are redacted from every answer, the agent's trace included.
3. **No built-in sign-in.** A request is served only when its `Host` names loopback or a name in `WORKBENCH_DASHBOARD_HOSTS` (against DNS rebinding), and an API request must carry `x-workbench-dashboard: 1`; no CORS headers are sent. On a Mac the port is published to the host's `127.0.0.1` only; on Kubernetes an SSO proxy or a network policy sits in front, and its name is listed.
4. **The agent's trace.** An attempt's DSH session is read through a session-persistence read handle, which never writes or takes ownership, and shown as steps: the agent's text, reasoning when the model stores it, each tool call with its result, and token usage.
5. **DSH's UI is opt-in.** `workbench-proxy` runs only with the Compose profile `dsh-ui`.

### Alternatives rejected

- **Keep the panel in DSH**: the problem above.
- **A built-in token**: the maintainer chose an SSO proxy where the page is reachable from elsewhere.
- **Server-sent events**: they need change hooks in the kernel and long-lived connections through ingress; polling with `ETag` is enough for one deployment's jobs.
- **A UI kit or a router library**: the page is lists, a feed and tables, built from a dozen primitives.

### Consequences

- The dashboard has its own address: `127.0.0.1:25410` (full) and `127.0.0.1:25409` (demo) in Compose.
- Opening an attempt's session in DSH's UI needs the `dsh-ui` profile; the trace shows the same steps without it.
- The page depends on DSH's session log format for the trace; an unknown format is refused with a message, and the rest of the page is unaffected.

## D14: Open-source release as Workflow Agent

**Status:** Accepted 2026-11-15 by the maintainer; implemented.

### Context

The workbench was built for one team: Russian by rule (`D12`, PRD `A26`), named after the upstream prototype it adapts (`dsh-superagent`, with that project's authors in its licence and package), documented as a project journal, and run from the authors' own machine. Releasing it for others to use and adapt needed a name, a licence, a language anyone can read, and a repository without the private history.

### Decision

1. **Name.** The product is **Workflow Agent**, `workflow-agent`: the package, its DSH plugin ids, the stage presets (`workflow-agent-inspector`, …), the skills, the DSH profile, the image and the Compose project. Upstream names (`@deepseek-ai/*`, `dsh-superagent-prototype`) stay. Environment variables keep their `WORKBENCH_*` names, as do the host's internal names (the workbench is the host process). Names persisted under the earlier name stay readable.
2. **Licence.** Apache-2.0 for the project's own code. The code adapted from `dsh-superagent-prototype` keeps its MIT notice; `NOTICE` lists it, the adapted ideas, what the dashboard bundles and what the image contains, and `third_party/` holds the licence texts.
3. **Language.** English by default, Russian supported. The deployment's `locale` picks the language of the host's posts, the dashboard's first language and, through a prompt's `<name>.<locale>` variant, the stage prompts and answer turns of new jobs. A job keeps the language it started in (its manifest records it); a job pinned before this decision is Russian. This revises `D12`'s rule that everything is Russian.
4. **History and hosting.** The public repository on GitHub starts from one commit; the private repository keeps the full history. Checks run on GitHub Actions.
5. **Upgrades.** Stored data is not migrated before 1.0, and there is no upgrade from pre-release state: the rename changes the stage presets' names, so a job pinned before it cannot start another attempt. Finished and cancelled jobs carry over; running jobs are finished or cancelled before an upgrade.

### Alternatives rejected

- **Keeping `dsh-superagent`**: readers would take the product for DeepSeek's prototype.
- **Renaming the environment variables**: the host's other internal names (its state paths, database, header, stage report tool) would keep "workbench", leaving three names for one thing.
- **Publishing the full history**: it holds a personal address in every commit and the trial's internal notes.
- **A source-available or copyleft licence**: the maintainer chose the most widely adoptable terms with a patent grant.

### Consequences

- `standard-delivery@13` and `synthetic-hotfix@2` (the preset ids are part of each definition).
- English prompts were written rule by rule from the tuned Russian ones; they are verified by the end-to-end eval in English.
- The PRD's language rules (`A26`, rule 12) read "in the deployment's language".

