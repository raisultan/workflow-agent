# Self-Hosted Deployment Guide

This guide covers running Workflow Agent (`workflow-agent`) with the **DeepSeek Harness (`dsh`) CLI** or **Docker Compose**, and configuring it.

## 1. Prerequisites

- **Local CLI:** Node.js `>=24.9.0` (required by `@deepseek-ai/dsh@0.2.2-rc.1`; verified on `24.22.2`) and `pnpm@11.7.0`.
- **Docker Compose:** Docker Engine and Docker Compose v2 (`docker compose`). [`Dockerfile`](../Dockerfile) packages `node:24.22.2-bookworm-slim`, `git`, `bubblewrap` (`bwrap`) and `@deepseek-ai/dsh@0.2.2-rc.1`. The image installs the dependencies and builds the plugin itself, so Compose needs no Node.js or pnpm on the host.

## 2. Running Workflow Agent

`workflow-agent` is a DeepSeek Harness bundle. [`cordis.patch.yml`](../cordis.patch.yml) is the bundle layer (presets and plugin rows); the profile's own `cordis.patch.yml` holds the deployment's configuration (see [`examples/profile.cordis.patch.yml`](../examples/profile.cordis.patch.yml)).

### Option A: Local DSH CLI

First run only: `--from-default-profile` wipes and recreates the `workflow-agent` profile from the shipped `web` template, which deletes the plugin link and the profile's `cordis.patch.yml`. Do not repeat it on an existing profile.

```bash
pnpm build
npx dsh --profile workflow-agent --from-default-profile web --dump-config >/dev/null   # first run only
npx dsh plugin --profile workflow-agent link .
cp examples/profile.cordis.patch.yml "${DSH_HOME:-$HOME/.dsh}/profiles/workflow-agent/cordis.patch.yml"
export WORKBENCH_STATE_DIR="$HOME/.local/state/workflow-agent"   # any absolute path of your own
npx dsh --profile workflow-agent --no-open --port 25401
```

DSH keeps its profiles under `$DSH_HOME`, `~/.dsh` when it is unset. Export `WORKBENCH_STATE_DIR` before every start: the example profile's `stateDir` falls back to `/var/lib/workbench/state`, the container's path.

Open the dashboard at `http://127.0.0.1:25410/` (`WORKBENCH_DASHBOARD_PORT` changes the port; [DESIGN §6](DESIGN.md#6-read-only-supervision-dashboard)). It needs no token on this machine. DSH's own web app is at the address DSH prints with its login token (`dsh web: http://127.0.0.1:25401/?token=…`); the workbench does not need it.

### Option B: Docker Compose, demo mode

The default `workbench` service runs with `WORKBENCH_DEMO=true`. On a fresh state volume a demo source delivers one synthetic hotfix request, a scripted driver plays its stages, a scripted approver approves its gate, and posts are logged instead of sent. No company account or model key is needed (`A1`):

```bash
docker compose up -d --build
```

Open the demo's dashboard at `http://127.0.0.1:25409/`. No token is needed: the port is published to the host's loopback only.

The demo job runs once per state volume. To watch it again, reset the state (`docker compose down -v`).

### Option C: Docker Compose, full mode (`--profile full`)

Runs the full DSH host (`dsh --profile workflow-agent --no-open --port 25402`, started directly under an init process so `docker stop` shuts it down cleanly) with LiteLLM model routing, the Jira, Mattermost and GitLab connectors, the sandbox wrapper (`bwrap`: masks, a network namespace per command, the egress proxy; [DESIGN §5](DESIGN.md#5-stage-presets-and-sandboxes)), and separate `workbench-state`, `workbench-work` and `workbench-toolchains` volumes. The repositories it works in are configured in the profile ([§3](#repositories)):

```bash
LITELLM_BASE_URL=http://host.docker.internal:4000/v1 \
LITELLM_API_KEY=sk-your-litellm-key \
LITELLM_MODEL=deepseek-v4-pro \
JIRA_BASE_URL=https://jira.example.com \
JIRA_TOKEN=your-jira-pat \
MATTERMOST_BASE_URL=https://mm.example.com \
MATTERMOST_TOKEN=your-mm-bot-token \
GITLAB_BASE_URL=https://gitlab.example.com \
GITLAB_TOKEN=your-gitlab-pat \
GITLAB_PROJECT=group/project \
WORKBENCH_ALLOWED_SENDERS=alice,bob \
docker compose --profile full up -d --build
```

Open the dashboard at `http://127.0.0.1:25410/` (the demo's stays at `:25409`).

The full service runs with `seccomp=unconfined` (unprivileged `bwrap` namespaces) and `systempaths=unconfined` (so `bwrap` can mount a fresh `/proc` per sandbox; without it the kernel refuses while Docker's masked `/proc` paths cover the container's own). The container stays non-root, read-only, with no capabilities. The image sets `WORKBENCH_SANDBOX_WRAPPER`; on Linux outside the demo the workbench refuses to start without it.

**The dashboard's ports.** Both runtimes share the `workbench` service's network namespace, so each has its own port: the demo `25409`, the full workbench `25410`. Each listens on `0.0.0.0` inside the container, and Compose publishes both to the host's `127.0.0.1` only. A request must name a loopback host (or one in `WORKBENCH_DASHBOARD_HOSTS`); the project's network holds only the workbench's own services.

**DSH's own UI** (its sessions, and its "New Session" button) is not published by default (`D13`). To open an attempt's session there, start the proxy too:

```bash
docker compose --profile full --profile dsh-ui up -d
docker compose --profile full logs workbench-full | grep 'dsh web'   # DSH's login token
```

Then open `http://127.0.0.1:25400/?token=<token>`. `workbench-proxy` (`scripts/loopback-proxy.ts`) validates the `Host` and `Origin` headers and forwards to `127.0.0.1:25402` (`workbench-full`) or `127.0.0.1:25401` (`workbench`). It does not forward WebSocket, so DSH's live views show "Reconnecting". The dashboard shows each attempt's trace without it.

### Linux hosts

Full mode's sandboxes need unprivileged user namespaces and mounts inside the container. On a stock Ubuntu 24.04 host (checked by
the isolation smoke, `P17`): the full-mode service runs with `apparmor=unconfined` besides `seccomp=unconfined` and
`systempaths=unconfined` (as `docker-compose.yml` sets), and the host allows unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns=0`, in `/etc/sysctl.d/`). With either missing every sandbox fails closed: a command
is refused, and jobs block. [Getting started](getting-started.md) has the commands; [SECURITY](../SECURITY.md) what they cost.

### Kubernetes

The sandbox needs the same on a node: `seccompProfile: Unconfined` and `appArmorProfile: Unconfined` (or profiles that allow
`bwrap`'s namespaces and mounts), `procMount: Unmasked` (which needs the pod in its own user namespace, `hostUsers: false`), and
nodes that allow unprivileged user namespaces. Many clusters' pod security rules forbid these; the platform team must allow them for
the namespace. The state is SQLite with one writer: one replica, a `ReadWriteOnce` volume, and updates that stop the old pod first.
Kubernetes is untested.

The dashboard has no sign-in of its own (`D13`). On a cluster:
- Set `WORKBENCH_DASHBOARD_HOST=0.0.0.0` and expose `25410` through a Service, reached only through an authenticating proxy (an SSO proxy in front of the ingress, for example) or a network policy that admits only it.
- List the name people open it at in `WORKBENCH_DASHBOARD_HOSTS` (for example `workbench.example.com`); any other `Host` is refused.
- `kubectl port-forward` reaches it at `127.0.0.1` without either.
- Set `dashboard.links` in the profile when people open Jira, Mattermost or GitLab at other addresses than the workbench does.

## 3. Configuration

Settings are deployment configuration (`D9`). They live in the profile's `cordis.patch.yml`, under the `workflow-agent` entry, and change by an edit and a restart. Hosts and secrets come from the environment ([§4](#4-environment-variables-and-credentials)). The dashboard shows each effective setting and where it comes from, and cannot change any of them. A new value applies to jobs started after the restart; running jobs keep the models, presets, parameters and policy version their run manifest froze. Policy eligibility is the exception: it is checked against the current policy, so removing an approver applies to running jobs too.

An unknown key or an invalid value stops the plugin at startup with a message naming it.

| Key | Type | Description |
| --- | --- | --- |
| `stateDir` | `string`, required | Absolute path of the state directory: `workbench.sqlite`, locks and the isolated worker git config. |
| `executor.workRoot` | `string` | Absolute path where job worktrees live (`<workRoot>/<jobId>`). Default: `WORKBENCH_WORK_DIR`, else beside the state directory (`<parent>/work` for a directory named `state`, `<stateDir>-work` otherwise). It is never inside the state directory. |
| `executor.maxWorkers` | `number`, `1`–`64`, default `2` | Stage attempts that run at once. A job waiting on a person holds no worker. |
| `models.default` | `provider/model` | The model of every agent stage that does not name its own. Default: `litellm/$LITELLM_MODEL` (`deepseek-v4-pro`). |
| `models.effort` | `string` | The default reasoning effort for agent stages. |
| `models.verdict` | `provider/model` | The model that reads replies to approval and resume gates, reads replies to question rounds item by item, tells questions from other follow-ups, and writes answer turns (`D12`). Default: `models.default`. Measure a new one with `pnpm eval:replies` first ([§5](#5-operations-and-verification)). |
| `policy.senders` | `{ <source>: string[] }` | Who may start a job, per source (`jira`, `mattermost`, `gitlab`). `WORKBENCH_ALLOWED_SENDERS` adds to every source. Mattermost entries may be usernames. |
| `policy.approvers` | `{ <workflowId>: { <source>: string[] } }` | Who may approve a workflow's gates besides the requester. `'*'` means every allowed sender of that source. A repository's own `approvers` take its jobs over from this list ([repositories](#repositories)). |
| `policy.bots` | `{ <source>: string[] }` | The workbench's own identities. The configured Jira and Mattermost bot identities are added automatically. |
| `locale` | `en` or `ru`, default `en` | The language the workbench writes in: its fixed messages (notices, gate posts, reminders), the stage instructions new jobs get (a workflow's `<prompt>.<locale>` variant, else its base prompt) and answer turns (`D14`). A job keeps the language it started in; one started before `D14` is Russian. |
| `demo` | `boolean`, default `false` | Demo mode ([§2](#option-b-docker-compose-demo-mode)). |
| `repositories` | `object[]` | The repositories jobs work in ([below](#repositories)). Required by `standard-delivery`. |
| `workflows.standardDelivery` | `object` | Registers `standard-delivery@13` with its Jira status names (`jiraStatuses: { inProgress, inReview }`). Its repository, target branch and commands come from the job's repository profile. |
| `workflows.synthetic` | `boolean`, default `false` | Registers the synthetic hotfix workflow (`A6`). Demo mode registers it too. |
| `workflows.modules` | `string[]` | Absolute paths of private workflow modules. Each exports `workflows()` (a `WorkflowSpec` or a list), and optionally `guards()` and `parameters(workflowId)`. |
| `egress.presets` | `string[]`, default `['npm']` | The registry presets of a repository that names none. `npm`: `registry.npmjs.org`, `registry.yarnpkg.com`; `pypi`: `pypi.org`, `files.pythonhosted.org`; `go`: `proxy.golang.org`, `sum.golang.org`. `[]` allows no registry. |
| `egress.hosts` | `string[]` | Extra public hosts: exact names or `*.suffix` (any name under the suffix). A bare `*`, an address and a private-looking name (`localhost`, `*.internal`, `*.corp`, …) are refused at startup; private registries are out of scope for V2. Only port 443 is reachable, and a name that resolves to a non-public address is refused when it is used. |
| `dashboard.links` | `{ jira?, mattermost?, gitlab? }` (URLs) | Where the dashboard links threads, when people open the tools at other addresses than the workbench reaches them (`D13`). Default: each connector's base URL. |

### Repositories

`repositories` lists the GitLab projects jobs work in (`D10`, `T11.1`). Each profile:

| Field | Description |
| --- | --- |
| `name` | The short name people use in `repo:<name>`: lowercase letters, digits, `-` and `_`. |
| `project` | The GitLab project path, such as `acme/payments`. |
| `targetBranch` | Default `main`: where merge requests go. |
| `testCommand` | The host-run test check ([checks](#checks-and-ci)), with the job's toolchains on `PATH`. |
| `setupCommand` | Optional: run once per job before the first stage, in the job's sandbox, with its `registries` presets and toolchains (for example `npm ci`, `uv sync --frozen`, `python -m pip install -r requirements-dev.txt`). |
| `registries` | The presets the job's implement, review and setup command may reach; `egress.presets` when not given. |
| `toolchains` | Versions for allowed tools the repository does not pin, such as `{ python: '3.12' }` ([toolchains](#toolchains)). |
| `postgres` | Optional: the Postgres major for the job's test services, only when the repository's CI and Compose files name the wrong one or none ([test services](#test-services)). |
| `match` | `jira: [<project key>…]` and `mattermost: [<channel id>…]`: triggers on those threads choose this repository. |
| `ci` | `required` (default) or `none`. `none` leaves the CI check out for this repository's jobs. |
| `default` | At most one profile: the repository of a trigger no rule matches. |
| `approvers` | Optional (`D12`): the emails of the only people who may approve this repository's plans and resume its blocked jobs, the requester included. Each is looked up in Jira and Mattermost at startup ([conversations](#conversations-d12)); until both answer, nobody approves. Absent: `policy.approvers`. |
| `senders` | Optional: who may start a job on this repository, per source (`{ mattermost: [...], jira: [...] }`), in the forms `policy.senders` accepts (Mattermost usernames are resolved to ids at startup). A sender must be allowed both globally and here. Absent: the global senders. |

A job's repository is chosen from its trigger: a `repo:<name>` or `repo:<group/project>` token in the message, else the Jira project of the trigger's thread, its Mattermost channel, then the default; [DESIGN §3.2](DESIGN.md#32-router-and-intake) has the exact rules. A Jira project or channel in two profiles, two defaults, a duplicate name or project, or an unknown preset stops the plugin at startup, so the choice never depends on order. Three triggers start no job, and the workbench replies on the thread saying why: a `repo:` that names no configured repository exactly (or no match and no default), which gets the names of the repositories that sender may use; a `repo:` naming another repository than the one the thread maps to; and a sender the chosen repository's `senders` do not list. The job's run manifest freezes its profile, so changing one affects only new jobs.

```yaml
repositories:
  - name: payments
    project: acme/payments
    testCommand: npm test
    setupCommand: npm ci
    registries: [npm]
    match: { jira: [PAY], mattermost: [<channel id>] }
    approvers: [lead@acme.example]   # only the lead approves payments plans, in the Jira ticket
    default: true
  - name: ledger
    project: acme/ledger
    testCommand: python -m pytest -q
    setupCommand: uv sync --frozen
    registries: [pypi]
    toolchains: { python: '3.12', uv: '0.9.5' }
    match: { jira: [LED] }
    ci: none
    senders:                    # only these may start ledger jobs (and they must be allowed globally too)
      mattermost: [lead-1, dev-ivan]
      jira: [lead-1]
```

### Conversations (`D12`)

`standard-delivery@13` keeps each conversation in its place: clarifying questions and blocked-job resumes in the job's Mattermost thread, the plan, its revisions and its approval in the Jira ticket, and code discussion on the merge request ([DESIGN §3.6](DESIGN.md#36-places-and-conversations)). Everything it writes to people is short. Its fixed messages, and what a model writes (plans, questions, answer turns), are in the deployment's `locale`, as the stage instructions and the answer prompt ask (`A26`, `D14`). For this to work:
- **A mapped channel per repository.** A job started in Jira or by a direct message opens its thread in its repository's first `match.mattermost` channel; a repository with none refuses such jobs and says so. Use a private channel, one per repository, with the bot as a member: anyone in the channel may answer a job's questions, so its membership decides who shapes the requirements.
- **Approvers by email.** Each `approvers` email is found in Jira with `/rest/api/2/user/search` (with emails hidden from the bot's account, a single match is taken) and in Mattermost with `/api/v4/users/email/<email>`, which needs the bot to see emails (`PrivacySettings.ShowEmailAddress`, or a role that may). A person not found in one of them cannot approve there; the log names them, and the dashboard's settings show who was resolved.
- **The ticket's author.** Question rounds are addressed to the Jira issue's reporter, matched to a Mattermost user by email, else to the requester. Anyone in the thread may answer.
- **Jira mentions.** Set `JIRA_BOT_USERNAME` (or `JIRA_BOT_ACCOUNT_ID`) so `@workbench` in a Jira comment can start a job, and the workbench's own comments are skipped. Comments are posted as Jira wiki markup. On a person's account, see [A shared Jira account](#a-shared-jira-account).
- **A ticket in the trigger.** `@workbench сделай PAY-123` links the job to that ticket at start, so its plan goes there. A trigger in Mattermost must name the issue key: one that names none starts no job and gets a short reply saying so, with the Jira projects whose keys count (`match.jira`). A mention in a Jira comment needs none.

### A shared Jira account

The workbench may log in to Jira as a person, for example its owner, when there is no account for it. Its comments then appear under that person's name, and Jira does not notify that person of them. The workbench tells its own comments from the person's by their ids, not by their author: the ids it posted or found again, a post still in flight by its exact text, and after a restart the ids of the last week from its post effects.

- **Credentials.** Prefer a token to the password. On Jira Server or Data Center, set `JIRA_TOKEN` to a Personal Access Token: it can be revoked, it keeps working when the password changes or sign-in goes through SSO, and the password stays out of the deployment. On Jira Cloud, set `JIRA_USERNAME` to the email and `JIRA_PASSWORD` to an API token: Jira Cloud refuses passwords on its API.
- **The bot's name.** Set `JIRA_BOT_USERNAME` to a name nobody in Jira has, such as `workbench`. It is the mention that starts a job (`@workbench`, typed as plain text, not picked from the @-menu), and comments written by that name are skipped. Left unset, it is the login account's name: that person's own comments, answers and approvals in Jira are then skipped, and a mention of that person by an allowed sender starts a job.
- **The check.** At startup the workbench reads the login account (`/rest/api/2/myself`). When it is the bot's name and the policy also names it as a sender or an approver, it logs a warning; it does not stop. When it is not the bot's name, it logs that it runs on a person's account.
- **What it can do.** The workbench acts with that person's Jira rights and its comments are audited as theirs, though it only reads issues, adds comments, links tickets, moves them through the configured statuses and sets the fields a stage asks for. Check your organization's rules on giving a person's credentials to a service, and keep them in the deployment's secrets. A dedicated account remains the better choice: its posts are its own and its rights can be narrow.

### Toolchains

A repository pins its toolchains in its own files: `mise.toml` (`[tools]` only), `.tool-versions`, `.python-version` or `.nvmrc`, by that precedence; the profile's `toolchains` fill in tools it does not pin. Before the first stage, the host's setup step installs them with `mise` into the shared `workbench-toolchains` volume ([DESIGN §4.9](DESIGN.md#49-setup-step)), and every sandbox of the job gets them on `PATH`. The allowed tools, their sources and how each is verified are in [DESIGN §5.5](DESIGN.md#55-toolchains): `node`, `python`, `go`, `uv` and `pnpm`.

- **Pins.** Only plain versions (`22.12.0`, `3.12`, `v20`): an alias (`lts/*`, `latest`, `system`), a range, or a pin with hooks blocks the job's setup with the reason. Other tools in those files are left out. The repository's `mise` configuration is never run: environment directives, hooks, tasks and plugins are ignored.
- **Python** comes only from python-build-standalone builds that carry a GitHub attestation. A pin older than those (for example `3.12.7`, whose only build is from October 2024) fails closed at setup; pin the line (`3.12`) or a current patch instead.
- **What blocks a job's setup**, with the log in the thread: a pin it cannot honour, a download that fails (GitHub's API allows 60 unauthenticated requests an hour per address, and each install uses one to three), a tool that does not print its version, or a setup command that fails. Fix the cause and reply `ок` to run the setup again, or `стоп`.
- **Installs at run time.** The cache is read-only in every sandbox. `npm install -g` goes to the job's home, `pip install` to the job's virtual environment (`.home/venv`, first on `PATH` for a job with Python), and Go to `$HOME/go`; none of it is committed. No tool downloads a toolchain itself.
- **Yarn** is not installed by the host (no checksum-verified source). A repository that uses it enables it through corepack, from the pinned Node, in its setup command; the yarn version comes from `packageManager` in its `package.json` and is fetched from the npm registry (so the repository needs the `npm` preset):

  ```yaml
  setupCommand: mkdir -p "$HOME/.npm-global/bin" && corepack enable --install-directory "$HOME/.npm-global/bin" && yarn install --immutable
  ```

  `corepack enable` on its own fails: it writes next to Node, in the read-only cache.
- **Poetry** is not installed by the host either. Install a pinned version into the job's virtual environment from PyPI (the `pypi` preset): `setupCommand: python -m pip install poetry==<version> && poetry install`.
- **The volume** grows with each new version. To reclaim it, stop the workbench and remove the volume; the next job of each repository installs what it needs again.

**Building native packages.** The image has a C/C++ toolchain (`build-essential`, `pkg-config`) and the headers most backend dependencies build against: `libpq-dev`, `default-libmysqlclient-dev`, `libffi-dev`, `libssl-dev`, `zlib1g-dev`, `libbz2-dev`, `libreadline-dev`, `libsqlite3-dev`, `liblzma-dev`, `libxml2-dev` and `libxslt1-dev`. So `pip install` or `npm install` can compile a package that has no wheel or prebuilt binary for the platform (`psycopg2`, `mysqlclient`, `lxml`, `bcrypt`, node-gyp modules). node-gyp also needs a Python: a Node repository with native modules pins one too (`toolchains: { python: '3.12' }`). These packages follow the base image's Debian release (bookworm) and its security updates, not exact versions, which the archive drops; they add about 340 MB to the image (1.11 GB to 1.45 GB).

**Other system libraries** (for example a browser for end-to-end tests, or a header not in that list) come from an image built on the workbench's: `FROM agent-workbench:<tag>`, then `USER root`, `apt-get install` the packages, and `USER node` again. Every sandbox mounts the image's root read-only, so they are available to every job. Keep the image's environment and entrypoint.

### Test services

Every job's commands in implement and review, and the host's test check, can use **Postgres**, **RabbitMQ** and **Kafka** at their usual local ports ([DESIGN §5.6](DESIGN.md#56-test-services), `D11`). Nothing is configured per repository: a test suite that passes in GitLab CI with `services:` should pass with just its test command.

| Service | Address | Variables | Defaults |
| --- | --- | --- | --- |
| Postgres 15, 16, 17 or 18 | `localhost:5432`, or `postgres:5432` | `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | user and password `postgres`, database `postgres`, a superuser (tests may create databases) |
| RabbitMQ 3.10 | `localhost:5672`, or `rabbitmq:5672` | `AMQP_URL`, `RABBITMQ_URL` | user `guest`, password `guest`, virtual host `/` |
| Kafka 4.4 (KRaft) | `localhost:9092`, or `kafka:9092` | `KAFKA_BOOTSTRAP_SERVERS` | one broker, plaintext, topics created on first use |

- **Started on first use, fresh for each command.** A service starts when a command first connects to its port (Postgres in under a second, RabbitMQ in 4–5 s, Kafka in 1–2 s; RabbitMQ is slower when several start at once, below) and is gone when that command ends. Nothing persists between commands, so migrations and fixtures run in the same command as the tests, as in CI (`testCommand: alembic upgrade head && pytest`). Agents are told so in their stage instructions.
- **The Postgres major** comes from the repository: the setup step reads the image tags in `.gitlab-ci.yml` (`services:` at the top, under `default` and in each job) and in `docker-compose.yml` or `compose.yaml` (`services.*.image`), on the target branch, as data. Two majors take the newest; none, or a tag with no plain major (`$PG_VERSION`, `latest`), takes the newest the image has (18); each is noted in the setup log. A major the image lacks, or a CI or Compose file the setup cannot read or parse, blocks the setup with the reason; set `postgres` in the profile for such a repository. The profile's `postgres` overrides what is read. RabbitMQ and Kafka have one version each; a CI tag naming another major is noted, and the job runs.
- **Names and credentials different from these** are set in the test command: `DATABASE_URL=postgresql://postgres:postgres@localhost/app_test pytest`.
- **A service that does not start** prints `workbench-services: <name> did not start: …` in the command's output; in the host's test check that blocks the job with the log, and `ок` re-runs the checks.
- **Memory.** Each running command with its services uses about 100 MB for Postgres, 140 MB for RabbitMQ and 360 MB for Kafka (256 MB heap), for as long as the command runs. Size the host for `executor.maxWorkers` jobs testing at once.
- **CPU, and RabbitMQ's start.** RabbitMQ's start takes about 5 CPU-seconds, so it slows when several commands start it at once: on an 8-CPU host, about 4 s alone, 8 s with two and 17 s with four. A client that gives up sooner fails the tests: `pika`'s default is 15 s (`stack_timeout`, which `?stack_timeout=60` in the URL raises). Allow about 4 CPUs for each job that may test at once (`executor.maxWorkers`), or have the repository's tests wait 30 s or more for the broker, as they would for a CI service.
- **Not supported:** a suite that starts its own containers (Testcontainers, `docker compose` in tests): the workbench has no Docker daemon. Many such suites read a variable to use an existing service instead.
- **Other versions or services** (Redis, MySQL, a Postgres extension such as PostGIS) come from an image built on the workbench's, as for system libraries ([toolchains](#toolchains)); a new service also needs an entry in the launcher (`src/sandbox/services.ts`).

### Checks and CI

`standard-delivery@13` finishes implement and review only when the host-run checks pass: the test command, GitLab CI for the pushed commit (unless the repository has `ci: none`), test integrity and a clean-context review ([DESIGN §4.5](DESIGN.md#45-checks)). A check that fails because of the work retries the attempt; one held up by the environment blocks the job, and an approver's `ок` re-runs the checks on the same commit (`стоп` cancels).

The CI check waits up to 10 minutes for a pipeline to start and an hour for it to finish, so a repository with no CI must say `ci: none`, or every job blocks ten minutes after its push.

The review check calls the stage's model once per verification, with the approved plan, any follow-ups since it, and the diff; its tokens count against the job's token budget. A diff over 120,000 characters is not reviewed: the check fails and asks for a smaller change.

If a plan deliberately does what the integrity rules call a weakening (removing an obsolete test, changing test configuration), its `tests` field names the rule and the reason (`exempt deleted-test tests/legacy.test.ts: the legacy API is removed`); the approver sees it in the approval post and approves it with the plan.

### Private workflows

A workflow is declarative data (`WorkflowSpec`, `src/domain/definition.ts`): its triggers, stages (presets, instructions, tools, output schema, checks, limits), transitions, gates, backtracks, budgets and the stage a merge request's feedback reopens. [`src/workflows/standard-delivery.ts`](../src/workflows/standard-delivery.ts) is a complete example. Prompts may use `{{name}}` placeholders, which `parameters(workflowId)` fills.

A definition is identified by `(id, version)` and a hash of its declaration and prompts. Changing the content without raising `version` is refused at startup. Keep workplace workflows outside this repository and point `workflows.modules` at them.

## 4. Environment variables and credentials

The host process reads credentials from environment variables (or a git-ignored `.env` file). Connector tokens never reach a worker's environment, and write tools hold no credential. Every sandbox has `$DSH_HOME`, the state directory and other jobs' worktrees masked, and DSH's file tools may read only the job's worktree ([DESIGN §5](DESIGN.md#5-stage-presets-and-sandboxes)). Supported connector APIs: **Jira Server/Data Center REST API v2** (Bearer PAT or Basic auth), **Mattermost API v4** (REST), and **GitLab REST API v4 with Git over HTTP(S)**.

| Variable | Used by | Description |
| --- | --- | --- |
| `WORKBENCH_STATE_DIR` / `WORKBENCH_WORK_DIR` | Profile, runtime | The state directory (`state` volume) and the job worktrees (`work` volume). |
| `WORKBENCH_ALLOWED_SENDERS` | Policy | Comma-separated usernames or actor ids added to every source's allowed senders. Mattermost usernames are resolved to user ids through the bot at startup (retried every minute while Mattermost is unreachable); a 26-character Mattermost user id is used as given. To remove someone, remove them here and in `policy.senders`, then restart. |
| `WORKBENCH_DEMO` | Example profile | `true` turns on demo mode (`demo: true`). |
| `WORKBENCH_DASHBOARD_HOST` / `WORKBENCH_DASHBOARD_PORT` | Dashboard (`D13`) | Where the dashboard listens: `127.0.0.1` and `25410` by default; `0.0.0.0` in a container whose port is published; `off` serves none. |
| `WORKBENCH_DASHBOARD_HOSTS` | Dashboard | Comma-separated names besides loopback the dashboard may be reached by (an SSO proxy's or an ingress's). A request naming any other host gets `403`. |
| `WORKBENCH_SANDBOX_WRAPPER` | `cordis.patch.yml` (`sandbox` row) | Path of `lib/sandbox-wrapper.js`; set in the image. When set, every confined command runs through the wrapper. Required on Linux outside the demo. |
| `WORKBENCH_SANDBOX_CONFIG` | Sandbox wrapper | Set by the workbench in its own process at startup (`<stateDir>/sandbox/config.json`); not an operator setting. |
| `WORKBENCH_MISE` / `WORKBENCH_TOOLCHAINS_DIR` | Setup step | The `mise` binary and the toolchain cache (the `workbench-toolchains` volume); set in the image. Without them, a job that needs toolchains blocks at setup. |
| `WORKBENCH_SERVICES_DIR` | Sandbox | The image's prepared test services (`/opt/workbench-services`; [test services](#test-services)); set in the image. Without it, no job has test services. |
| `LITELLM_BASE_URL` | LiteLLM route (`@deepseek-ai/dsh-llm-pi-ai`) | OpenAI-compatible base URL of the LiteLLM gateway (for example `http://host.docker.internal:4000/v1`). Without a gateway, point it at DeepSeek's own OpenAI-compatible API (`https://api.deepseek.com/v1`, with the DeepSeek key as `LITELLM_API_KEY`); the model names are the same. |
| `LITELLM_API_KEY` | LiteLLM route | API key for the gateway. While it is unset, the `litellm` route lists no models. In Compose, `DEEPSEEK_API_KEY` fills it when it is unset ([below](#compose-fallbacks-for-the-model-variables)). |
| `LITELLM_MODEL` | LiteLLM route, profile | The model the `litellm` route lists, and the default of `models.default`; `deepseek-v4-pro` by default. |
| `DEEPSEEK_API_KEY` | DeepSeek (`@deepseek-ai/dsh-llm-deepseek-api-key`) | Key for the direct `deepseek-official` provider, which runs a stage only when a model names that provider. In Compose, it also stands in for an unset `LITELLM_API_KEY`, and `LITELLM_API_KEY` for it ([below](#compose-fallbacks-for-the-model-variables)). |
| `JIRA_BASE_URL` | `JiraConnector` | Base URL of Jira Server/Data Center (`https://jira.example.com`). |
| `JIRA_TOKEN` | `JiraConnector` | Personal Access Token (Bearer auth) for Jira REST API v2. |
| `JIRA_USERNAME` / `JIRA_PASSWORD` | `JiraConnector` | Basic auth credentials for Jira when `JIRA_TOKEN` is not used. |
| `JIRA_JQL` / `JIRA_BOT_USERNAME` / `JIRA_BOT_ACCOUNT_ID` | `JiraConnector` | Optional polling JQL filter, and the bot identity used to skip the workbench's own comments and to detect mentions. Only a mention of the bot (`@name`, `[~name]` or `[~accountid:id]`) in a new issue or a comment starts a job; being in the filter (for example, assigned to the bot) does not. With no bot identity set (`JIRA_BOT_USERNAME`, `JIRA_BOT_ACCOUNT_ID`, or the basic-auth username), nothing in Jira counts as a mention. On a person's account, set `JIRA_BOT_USERNAME` to a name nobody has ([A shared Jira account](#a-shared-jira-account)). |
| `MATTERMOST_BASE_URL` | `MattermostConnector` | Base URL of Mattermost (`https://mm.example.com`). |
| `MATTERMOST_TOKEN` | `MattermostConnector` | Bot access token for Mattermost API v4. |
| `MATTERMOST_BOT_USER_ID` / `MATTERMOST_TEAM_ID` | `MattermostConnector` | Bot user ID and team ID in Mattermost. |
| `GITLAB_BASE_URL` | `GitLabConnector`, `GitTransport` | Base URL of GitLab (`https://gitlab.example.com`). |
| `GITLAB_TOKEN` | `GitLabConnector`, `GitTransport` | Personal or project access token with API and repository read/write access. It may be a person's token: the workbench marks the notes it posts, so that person's own review comments still count as human. |
| `GITLAB_PROJECT` | `GitLabConnector`, example profile | The connector's default project: the one of a watched merge request whose thread names none (`src/sources/gitlab.ts`). The example profile also uses it as the project of its one repository (`REPOSITORY_NAME`, `app` by default; [getting started](getting-started.md)). A deployment lists its repositories in the profile. |

### Compose fallbacks for the model variables

The `workbench-full` service in [`docker-compose.yml`](../docker-compose.yml) fills the model variables from each other, so one key and one address are enough. The `litellm` route reads only the `LITELLM_*` names, and the workbench reads `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` nowhere (only `pnpm eval:replies` does, [§5](#reply-set-eval)); outside Compose, set the `LITELLM_*` names directly.

| Variable in the container | Value |
| --- | --- |
| `LITELLM_API_KEY` | `LITELLM_API_KEY`, else `DEEPSEEK_API_KEY`. |
| `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY`, else `LITELLM_API_KEY`. |
| `LITELLM_BASE_URL` | `LITELLM_BASE_URL`, else `DEEPSEEK_BASE_URL`, else `http://host.docker.internal:4000/v1`. |
| `LITELLM_MODEL` | `LITELLM_MODEL`, else `DEEPSEEK_MODEL`, else `deepseek-v4-pro`. |

So with only `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL=https://api.deepseek.com/v1` set, the `litellm` route calls DeepSeek's own API. `WORKBENCH_ALLOWED_SENDERS` has no default: until it or `policy.senders` names someone, nobody may start a job.

### First start and restarts

- **Fresh state volume.** On first start each source records where it stands (its cursor baseline) and delivers nothing, so messages and issue updates from before the first start never start a job (`A17`). Jira reads only from the moment of first start; later polls also skip comments and issues created before their read window, so editing an old issue does not replay its old comments. A Mattermost channel the bot joins later (or one that failed at first start) delivers only posts from after the bot joined, or after the first start; a new direct-message channel delivers from its first message.
- **Restarts.** Nothing is lost or repeated across a restart (`A11`): unconsumed inbound events and due timers are processed, and a write whose outcome was unknown is reconciled before it is repeated. A stage attempt or check that was running is returned to its job as interrupted, and the job retries it within its attempt budget.
- **State lock.** A process that stopped without releasing the state lock (for example after a kill) leaves `<stateDir>/.lock`. The next start waits up to about 35 seconds for it to go stale instead of failing.
- **Recreating `workbench`.** `workbench-full` (and `workbench-proxy`, with `dsh-ui`) share its network namespace, so recreate them with it: `docker compose --profile full up -d --force-recreate`. Otherwise they keep the old namespace and their ports stop answering.
- **Upgrades.** Stored data is not migrated. Reset the state volumes (`docker compose --profile full down -v`) when upgrading from V1, or from a build with an earlier `standard-delivery` version: only the current one (`@13`) is registered for new jobs. A job started on an earlier version keeps the declaration and prompts its manifest froze, and runs on with them (it parks only if a guard it names is missing); the host code it runs with, the checks among it, is the new build's. So a job started on `@8` keeps its `@8` prompts (no self-audit before the commit, no merge request description template, no repository conventions line) and gets the new host-side review check, with severity, verified evidence, the test audit and the merge-risk note, from its next verification on; nothing about it needs a reset. `standard-delivery` names no guard, so its open jobs do not park. A job started before `@11` is not closed by its merge request's merge, since its manifest declares no `completeOn`, nor one before `@12` by closing its merge request without a merge; an approver closes such a job with `закрой` on any of its threads (the merge request, the Jira ticket or the Mattermost thread). A job started before `@13` names its stage presets by the project's earlier name (`dsh-superagent-*`), which this build no longer defines, so a running one cannot start another attempt: finish or cancel running jobs before upgrading to it (`D14`). (Between `P9` and `P10` check results also changed shape.)

### Model credentials (DSH `0.2.2`)

- A key stored in `$DSH_HOME/.credentials.yaml` (for example, saved through the DSH web settings) takes precedence over `LITELLM_API_KEY` and `DEEPSEEK_API_KEY` in the environment. In Compose that file lives in the `workbench-dsh` volume.
- Stages run on `models.default` unless their workflow names a model. Replies are read by `models.verdict`. Both are frozen into each job's run manifest.

### Outbound delivery

- **Connector settings.** For each source (`jira`, `mattermost`, `gitlab`), a non-empty value in its plugin settings (`baseUrl`, `jql`, `botUsername`, `botAccountId`, `botUserId`, `teamId`, `project` or `projectId`) takes precedence over the environment variable; an empty value falls back to it. A missing required setting shows as an error in the source's health, and writes to that source fail.
- **At least once, recorded at most once.** Reads (`GET`, `HEAD`) retry on `429`, `5xx` and transient network errors; writes retry on their own only on `429`. Every external write is an effect with an idempotency key. A `4xx` fails it for good; after a `5xx` or a network error the earlier write is looked up before anything is sent again ([DESIGN §4.4](DESIGN.md#44-writers-and-reconciliation)).

## 5. Operations and verification

```bash
# Container status and logs
docker compose --profile full ps
docker compose --profile full logs -f workbench-full

# The dashboard's read-only API: jobs and health (the header marks the request as the page's own)
curl -s -H 'x-workbench-dashboard: 1' http://127.0.0.1:25410/api/state

# The extended isolation smoke (T10.4, T11.5, T12.6): DSH's confine with the wrapper, host checks, egress, the file-tool guard,
# test integrity, test services, and the setup step with real toolchain installs; prints PASS/FAIL per probe and exits 1 on any FAIL. Add --offline
# to skip the probes that download (npm, PyPI, Go modules, toolchains).
docker compose --profile full exec -T workbench-full node scripts/smoke-worker-isolation.ts

# Stop all containers
docker compose --profile full down

# Reset all state (state, work, DSH and toolchain volumes); nothing is kept
docker compose --profile full down -v
```

### Local eval services

[`eval/`](../eval/README.md) runs synthetic stand-ins for Mattermost, Jira and GitLab on the host (a real Mattermost, the mock Jira, and a mock GitLab with scripted CI), with two synthetic repositories, so a job runs end to end with no outside writes. Its passwords and tokens are generated at bootstrap and never committed.

`pnpm eval:e2e` runs the end-to-end eval against them: every scenario as a real-model job, with simulated people and hidden tests ([`eval/README.md`](../eval/README.md#end-to-end-eval)). It calls a real model and starts containers, so it is manual and not part of `pnpm check`.

### Network connections

Each job's page in the dashboard lists every connection its sandboxes asked the egress proxy for, allowed or refused, with the attempt, host, address and reason. A refused connection also appears in the agent's tool output as `workbench-egress: refused: <reason>`.

### Reply-set eval

`pnpm eval:replies` runs the labelled RU/EN reply set (`tests/fixtures/replies.ts`, over 150 replies) the way a gate reads replies: the vocabulary first, then the verdict model with the 0.8 confidence rule. It prints a confusion table of label against outcome. Then it reads the labelled reading cases (`tests/fixtures/readings.ts`) the way a reply to a question round is read (`D12`), and lists each mismatch. It exits `1` if any reply labelled other than an approval would approve (`A12`), or if a reading records an answer the reply does not give. It calls a real model, so it is manual and not part of `pnpm check`. Run it before changing `models.verdict` or the verdict prompt:

```bash
LITELLM_BASE_URL=http://127.0.0.1:4000/v1 LITELLM_API_KEY=sk-your-key WORKBENCH_VERDICT_MODEL=deepseek-flash pnpm eval:replies
```

Without a gateway, set `DEEPSEEK_API_KEY` instead (`DEEPSEEK_BASE_URL` defaults to `https://api.deepseek.com`). The model is `WORKBENCH_VERDICT_MODEL`, else `DEEPSEEK_FAST_MODEL`, `LITELLM_MODEL` or `DEEPSEEK_MODEL`.
