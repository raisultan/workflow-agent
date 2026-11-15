/**
 * Thread keys: how a conversation on a source is named in the inbox, in bindings and in gates. Sources produce them (`T9.6`) and
 * writers parse them to post back (`T9.2`).
 *
 * - Mattermost: `mattermost:<channelId>:<rootPostId>`, or `mattermost:<channelId>:` for the channel itself;
 * - Jira: `jira:<ISSUE-KEY>`;
 * - GitLab: `gitlab:<project path>!<merge request iid>`.
 */
export type Thread =
  | { readonly source: 'mattermost'; readonly channelId: string; readonly rootId?: string }
  | { readonly source: 'jira'; readonly issueKey: string }
  | { readonly source: 'gitlab'; readonly project: string; readonly mrIid: number }

export function threadKey(thread: Thread): string {
  switch (thread.source) {
    case 'mattermost': return `mattermost:${thread.channelId}:${thread.rootId ?? ''}`
    case 'jira': return `jira:${thread.issueKey}`
    case 'gitlab': return `gitlab:${thread.project}!${thread.mrIid}`
  }
}

/** The thread a key names; throws on a key no source produces. */
export function parseThread(key: string): Thread {
  const mattermost = /^mattermost:([^:]+):([^:]*)$/u.exec(key)
  if (mattermost) return { source: 'mattermost', channelId: mattermost[1]!, ...mattermost[2] ? { rootId: mattermost[2] } : {} }
  const jira = /^jira:([A-Z][A-Z0-9_]*-\d+)$/u.exec(key)
  if (jira) return { source: 'jira', issueKey: jira[1]! }
  const gitlab = /^gitlab:(.+)!(\d+)$/u.exec(key)
  if (gitlab) return { source: 'gitlab', project: gitlab[1]!, mrIid: Number(gitlab[2]) }
  throw new Error(`Unknown thread key ${key}`)
}
