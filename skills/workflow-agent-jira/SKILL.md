---
name: workflow-agent-jira
description: Read Jira issues, parent Epics, subtasks, linked issues, remote links, and text/log attachments, and post comments or transitions via host-brokered tools.
---

Workers interact with Jira exclusively through host-brokered tools. Never invoke raw curl commands with credentials; the host holds Jira authentication and records an idempotent action receipt for every write.

Context gathering (`read` tools):
- Use `jira_get_issue` with `issue_key` (for example `PROJ-42`) to read the issue summary, description, status, priority, assignee, reporter, labels, comments, parent Epic, subtasks, `issuelinks` (blocks, relates to, duplicates), remote web links (`/remotelink`, such as Confluence specs or architecture docs), and attachment metadata (`fields.attachment`).
- Follow connected Epics, subtasks, and linked issues with `jira_get_issue_links`, `jira_get_epic_context`, `jira_get_attachments`, or `jira_search_issues` (bounded JQL search) whenever full requirements context is spread across linked tasks.
- Use `jira_read_attachment_text` (`{ issue_key, attachment_id }`) to inspect plain-text, log, or configuration attachments (`.log`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.md`, `.sql`, `.xml`, `.diff`) up to the host size limit. Binary and image attachments are not parsed.

Mutations (`write` tools, available only in stages whose preset enables them):
- Use `jira_link_issue` (`{ issueKey }`) to make an issue this job's issue.
- Use `jira_add_comment` (`{ issueKey?, body }`) to post clarified requirements, investigation findings, or implementation plans back to the Jira issue.
- Use `jira_transition_issue` (`{ issueKey?, transition }`, a transition id or name) to move an issue across allowed workflow transitions.
- Use `jira_update_fields` (`{ issueKey?, fields }`) to update configured Jira fields when authorized by the active workflow stage.
- `issueKey` defaults to the job's issue. The read tools take `issue_key`.
