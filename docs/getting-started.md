# Getting started

This guide takes you from nothing to a first real job: the demo first, which needs no account and no key, then Workflow Agent
connected to your own Jira, Mattermost and GitLab. [DEPLOYMENT](DEPLOYMENT.md) has every setting; this guide names only the ones a
first deployment needs.

You need Docker with Compose v2 (Docker Desktop on a Mac, Docker Engine on Linux).

## 1. Try the demo

```bash
git clone https://github.com/raisultan/workflow-agent.git
cd workflow-agent
docker compose up -d
```

Open the dashboard at `http://127.0.0.1:25409/`. One synthetic job runs through its stages with a scripted approver and no
model: you can follow its activity, its posts and its stage attempts. The demo uses only the `workbench` service and its own
volumes; `docker compose down` stops it.

Compose pulls the published image. To build it from the source instead (it takes a while: the image carries Postgres, RabbitMQ
and Kafka for jobs' tests), run `docker compose up -d --build`.

## 2. Prepare your tools

Workflow Agent talks to people where they already work, and it needs an account in each tool.

**A model.** Any OpenAI-compatible endpoint: a LiteLLM gateway, or a provider's own API. The prompts are tuned and tested on
DeepSeek models (`deepseek-v4-pro`); others are untested.

**Mattermost.**
1. Create a bot account (System Console → Integrations → Bot Accounts) and an access token for it.
2. Note the bot's user id and your team's id (both are in the System Console, or `GET /api/v4/users/me` and `/api/v4/teams` with
   the token).
3. Create a channel for the repository (a private one is best: anyone in it may answer the agent's questions) and add the bot.
   Note the channel's id (channel menu → View Info).
4. If plans are approved by named people (`APPROVER_EMAILS`), let the bot see email addresses
   (`PrivacySettings.ShowEmailAddress`, or a role that may): approvers are found by email.

**Jira** (Server or Data Center; Jira Cloud is untested).
1. Use a dedicated account if you can, and create a Personal Access Token for it. On a person's account, read
   [A shared Jira account](DEPLOYMENT.md#a-shared-jira-account) first.
2. Choose the bot's name, the mention that starts a job (`JIRA_BOT_USERNAME`, for example `workflow-agent`): a name nobody in Jira has.
3. Note the Jira project key of the repository's issues (for example `APP`) and the names of two statuses the agent moves issues
   to: "In Progress" and "In Review" by default (`workflows.standardDelivery.jiraStatuses` in the profile).

**GitLab.** A token with `api` scope (and repository write) on the project, and the project's path (`group/project`).

## 3. Configure

```bash
cp .env.example .env
```

Fill in `.env`: the model, who may start jobs (`WORKBENCH_ALLOWED_SENDERS`), the three tools, and the repository block
(`REPOSITORY_*`, `JIRA_PROJECT`, `MATTERMOST_CHANNEL_ID`, `APPROVER_EMAILS`). The image's example profile reads that block, so one
repository needs no other file.

For more than one repository, or any other setting, copy the profile and edit it; Compose mounts `config/` into the container:

```bash
cp examples/profile.cordis.patch.yml config/profile.cordis.patch.yml
```

The built-in workflow (`standard-delivery`) is ready to use as it is. To change how it works (its prompts, budgets or checks), or
to add a process of your own, see [writing your own workflow](workflows.md#adapting-the-built-in-workflow).

## 4. Start

```bash
docker compose --profile full up -d
```

Open `http://127.0.0.1:25410/` and check **Health**: Jira, Mattermost and GitLab should say ready. A connector that is not
configured says so there and does not stop the others.

Full mode runs agent commands in OS sandboxes (`bwrap`), and the container needs relaxed confinement for them, as
`docker-compose.yml` sets. See [SECURITY](../SECURITY.md) for what that means and what the sandbox does and does not promise.

**On Linux** (Ubuntu 23.10 and later, and other hosts that restrict unprivileged user namespaces), also allow them on the host,
or every sandbox fails closed and jobs cannot run their commands:

```bash
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-workflow-agent.conf
sudo sysctl --system
```

This was checked on a stock Ubuntu 24.04 host: with it, and the container's `apparmor=unconfined` from `docker-compose.yml`, the
isolation smoke passes all its probes. It lifts a hardening Ubuntu applies to every program on the host, so prefer a host that runs
only Workflow Agent. Docker Desktop for Mac needs nothing.

## 5. Your first job

In the repository's Mattermost channel, mention the bot with a Jira issue key:

```text
@workflow-agent do APP-123
```

Or mention it in a comment on the Jira issue (`@workflow-agent do it`). What happens next:

1. It links the issue, moves it to "In Progress", reads the code (read-only, no network) and, if the requirements are unclear,
   asks its questions in the channel's thread. Anyone there may answer, item by item.
2. It posts a plan in the Jira issue, with what it will test, and waits. Only an approver's comment there approves it (`ok`), and
   only that revision: a new revision needs a new approval.
3. It implements the plan in a sandbox, with tests. The host runs the tests, CI and a review of the change before it opens a merge
   request and moves the issue to "In Review".
4. People review the merge request. A comment there puts the job back to work; a merge closes it. It never merges by itself.

Jobs wait for people without holding a worker, and survive restarts. An approver can stop a job with `stop` in its thread, and
close a finished one with `close`.

## 6. When something is off

- **Nothing happens on a mention.** The sender must be in `WORKBENCH_ALLOWED_SENDERS`, the message must name an issue key of the
  repository's Jira project, and the bot must be in the channel. The dashboard's **Inbox** shows every message the agent saw and
  why it ignored one.
- **A connector is not ready.** **Health** shows its last error; the container's log has more:
  `docker compose --profile full logs -f workbench-full`.
- **A job is blocked.** Its page says why and who must decide; an approver answers in its thread (`ok` to retry or extend,
  `stop` to cancel).
- **Upgrading.** Stored data is not migrated before 1.0: finish or cancel running jobs before you upgrade.
