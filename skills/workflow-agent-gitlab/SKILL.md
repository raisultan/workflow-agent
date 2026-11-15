---
name: workflow-agent-gitlab
description: Read GitLab Merge Requests, diffs, discussions, and pipeline status, push ASCII agent branches, and create or update Merge Requests via host-brokered tools.
---

Workers interact with GitLab through host-brokered tools. Never run raw `git push` with embedded credentials; all pushes and Merge Request mutations are brokered by the host.

Branch and repository rules:
- Every agent branch must use the ASCII-only naming convention `agent/<issue-key>-<ascii-slug>` (for example `agent/proj-42-fix-null-token`). Cyrillic titles are transliterated to ASCII automatically.
- Force pushes and pushes to protected branches (`main`, `master`, `develop`, `release/*`) are rejected by the host.

Host-brokered tools:
- Use `gitlab_get_mr` and `gitlab_list_discussions` (`{ project?, mr_iid }`) to inspect Merge Request metadata, changes, pipeline check status, and review discussion threads.
- Use `gitlab_push_branch` (`{ project?, branch, commitSha? }`) to push the job worktree's verified commit to the `agent/<issue-key>-<ascii-slug>` branch.
- Use `gitlab_create_mr` (`{ project?, sourceBranch, targetBranch?, title, description }`) and `gitlab_update_mr` (`{ project?, mrIid, title?, description? }`) to idempotently open or update the Merge Request and bind it to the job.
- Use `gitlab_reply_discussion` (`{ project?, mrIid, discussionId?, body }`) to respond to review comments on the Merge Request.
- `project` defaults to the job's repository, and `targetBranch` to its target branch.
