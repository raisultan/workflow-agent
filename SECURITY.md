# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's **Report a vulnerability** button on this repository's Security tab,
not in a public issue. Say what you found, how to reproduce it, and what it lets an attacker do. You will get an answer within a
week. Workflow Agent is maintained by one person, so a fix may take longer; you will hear how it is going.

Only the latest release is supported.

## What Workflow Agent protects, and how

Workflow Agent runs a coding agent on your code, driven by text from tickets, chat and merge requests. It assumes that text may
be hostile (prompt injection) and limits what the agent can do with it. [DESIGN §5](docs/DESIGN.md#5-stage-presets-and-sandboxes)
has the details; this is the summary.

- **No credentials in the agent's reach.** Connector tokens and the model key stay in the host process. The agent's shells run with
  a scrubbed environment, and every write to Jira, Mattermost or GitLab is a request the host checks and performs: comments, status
  changes, pushes, merge requests.
- **An OS sandbox per command.** Each agent command runs in its own `bwrap` sandbox (Linux): read-only for the inspect and plan
  stages, and writable only in the job's own worktree for implement and review. The state directory, the DSH home, other jobs'
  worktrees and other processes' environments are not visible. DSH's file tools, which run in the host process, may read only the
  job's worktree.
- **Network.** Inspect and plan have no network. Implement and review reach only public package registries, through the host's
  proxy, which refuses private and loopback addresses and logs every connection per job.
- **Git.** The agent pushes only to its own `agent/<issue>-<slug>` branches, never with force, and never to a protected branch. It
  never merges: a person reviews and merges every change.
- **People decide.** A plan is approved only by an eligible person, on the right thread, for its exact revision; an unclear reply
  never approves. The host runs the tests, CI, a test-integrity check and an independent review before a change is handed over.

## What it does not protect against

- **A hostile ticket can still steer the work.** Injected text can make the agent write unwanted code into a merge request. People
  approve the plan and review the merge request; read both.
- **Package registries are a way out.** Implement and review can install packages, so injected text could make the agent send data
  out through an install script, or publish to a public registry with a token planted in the ticket. Every connection is logged
  per job; a GET-only proxy or registry mirrors are not built yet.
- **A file-tool race.** DSH's file tools check a path before opening it; a background command of the same session could swap the
  path for a symbolic link in between.

## Running it safely

- **The dashboard has no sign-in.** It answers only requests whose `Host` is loopback or a name in `WORKBENCH_DASHBOARD_HOSTS`, and
  it is read-only, but it shows plans, diffs, agent traces and everyone's messages. Never publish its port (25410, or 25409 in the
  demo) beyond loopback without an authenticating proxy in front. DSH's own UI (25400, the `dsh-ui` Compose profile) is off by
  default; keep it that way outside a developer's machine.
- **The container's confinement is relaxed** so `bwrap` can build its sandboxes inside it: Docker's default seccomp and AppArmor
  profiles and its masked `/proc` paths are turned off for the full-mode service (`seccomp=unconfined`, `apparmor=unconfined`,
  `systempaths=unconfined`). The container runs as a non-root user with no capabilities and `no-new-privileges`. On Linux hosts that
  restrict unprivileged user namespaces (Ubuntu 23.10 and later), the host must allow them too
  (`kernel.apparmor_restrict_unprivileged_userns=0`), which lifts that hardening for every program on the host. Run it on a host you
  trust, preferably one that runs only Workflow Agent, and do not add capabilities.
- **Give the bot accounts narrow rights.** A dedicated Jira account, a Mattermost bot in only the repositories' channels, and a
  GitLab token scoped to the projects it works on.
- **Keep secrets in `.env` or your platform's secret store**, never in the profile or the repository.
