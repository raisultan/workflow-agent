# Changelog

## 0.1.0 (2026-11-15)

The first public release.

- A self-hosted, human-gated coding agent over Jira, Mattermost and GitLab, on DeepSeek Harness: a durable job kernel, declarative
  workflows with approval gates bound to artifact revisions, host-run checks (tests, CI, test integrity, an independent review),
  budgets and backtracking, an OS sandbox per command with registry-only egress, and a read-only dashboard with each attempt's
  agent trace.
- `standard-delivery@13`: a Jira issue to a reviewed merge request, with each conversation in its place (questions in Mattermost,
  the plan in Jira, code on the merge request), change proposals, merge risk, and closing on merge or by an approver.
- English by default, Russian supported, chosen per deployment and frozen per job.
- Per-repository toolchains installed by the host, and Postgres, RabbitMQ and Kafka for every job's tests.
- Apache-2.0, adapted from the MIT-licensed `dsh-superagent-prototype` (see NOTICE).
