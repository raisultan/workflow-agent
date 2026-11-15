# Workflow Agent

A self-hosted coding agent that works through your team's own tools: it takes a request from Mattermost or Jira, asks its
questions in the channel, puts its plan in the Jira issue for a person to approve, writes the change with tests in a sandbox, and
hands over a merge request in GitLab for people to review and merge.

- **It works where your team already talks.** No new app to adopt: questions in a Mattermost thread, the plan and its approval in
  the Jira issue, code discussion on the merge request. A read-only dashboard shows every job, who it waits on, and what the agent
  did.
- **People decide; the host enforces it.** A plan counts only when an approver approves that exact revision. The host, not the
  model, decides when a stage is done: it runs the tests, CI, a test-integrity check and an independent review first. The agent
  never merges.
- **It waits without holding anything.** A job waiting for an answer holds no worker and no session, and survives restarts: every
  step is an event in a durable log, and every write to Jira, Mattermost or GitLab is idempotent.
- **It is contained.** Each command runs in an OS sandbox: read-only and offline while it analyses and plans, writable only in its
  own worktree and online only to public package registries while it implements. It holds no credential.
- **Your workflow, not ours.** The built-in workflow goes from an issue to a reviewed merge request; your own is a small
  declarative module of stages, gates and checks ([writing a workflow](docs/workflows.md)).

Workflow Agent is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), adapted from DeepSeek's
`dsh-superagent-prototype`, and talks to any OpenAI-compatible model endpoint (LiteLLM). It writes in English or Russian.

## Try it

```bash
git clone https://github.com/raisultan/workflow-agent.git
cd workflow-agent
docker compose up -d
```

Open `http://127.0.0.1:25409/`: a synthetic job runs through its stages with a scripted approver, with no account and no model
key. [Getting started](docs/getting-started.md) connects it to your Jira, Mattermost and GitLab.

## How a job goes

1. **Request.** `@workflow-agent do APP-123` in the repository's Mattermost channel, or a mention in the Jira issue.
2. **Inspect.** It reads the issue and the code, read-only and offline, and asks its questions in the channel's thread. Anyone
   there may answer.
3. **Plan.** It posts a plan in the Jira issue, with what it will test, and waits for an approver. A change request makes a new
   revision; only an approval of the current revision lets it continue.
4. **Implement.** It changes the code with tests in its sandbox, pushes an `agent/…` branch and opens a merge request once the
   host's checks pass.
5. **Review.** A comment on the merge request puts it back to work; a change to the requirements goes back to the plan first. A
   merge closes the job.

## Status

Version 0.1.0, the first public release. It has run end to end on real models (DeepSeek) against GitLab, a Mattermost server and a
Jira mock, in English and in Russian; its isolation smoke passes on Docker Desktop for Mac and on a stock Ubuntu 24.04 host. Known
limits:

- **Jira** is tested against a mock of Jira Server's REST v2 API; Jira Cloud is untested.
- **GitLab and Mattermost only** for now; GitHub and Slack are not supported.
- **Models:** the prompts are tuned and tested on DeepSeek models; others work through LiteLLM but are untested.
- **One replica:** the state is SQLite with one writer.
- **The container's confinement is relaxed** so the sandbox can run inside it, and Linux hosts that restrict unprivileged user
  namespaces (Ubuntu 23.10 and later) must allow them; see [getting started](docs/getting-started.md) and [SECURITY](SECURITY.md).
- A merge counts only with a green pipeline; an approver can close a job with `close` otherwise.

Possible next steps, none of them promised: Jira Cloud (its newer search API), GitHub and Slack connectors, a Kubernetes deployment
and Helm chart, prompts tested on more models, OpenTelemetry export, an optional read-only GitHub token so toolchain installs do not
hit GitHub's unauthenticated rate limit on busy hosts, and English prompts that ask about a vague ticket as reliably as the Russian
ones (in the release eval, one vague-ticket scenario passed 1 of 4 English runs against 2 of 2 Russian).

## Documentation

- [Getting started](docs/getting-started.md): the demo, connecting your tools, a first job.
- [Writing your own workflow](docs/workflows.md), with a [working example](examples/workflows/docs-update.ts).
- [Deployment](docs/DEPLOYMENT.md): every setting and environment variable, operations, Kubernetes notes.
- [Design](docs/DESIGN.md): the kernel, the workflow domain, the sandboxes and the dashboard.
- [Requirements](docs/PRD.md) and [decisions](docs/DECISIONS.md): what it must do, and why it is built as it is.
- [Upstream](docs/UPSTREAM.md): what comes from DSH and the prototype.
- [Security](SECURITY.md) and [contributing](CONTRIBUTING.md).

## Licence

Apache-2.0 ([LICENSE](LICENSE)). The code adapted from `dsh-superagent-prototype` keeps its MIT notice; [NOTICE](NOTICE) lists it
and everything else the project and its image include.
