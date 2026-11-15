/** Typed keys of the Sources' records (their poll cursors), kept in the kernel's `kv` table under `source:`. */

/** Key of a record whose value has type `V`. */
export type Key<V> = string & { readonly __value?: V }
const record = <V>(key: string) => key as Key<V>

/** Jira, Mattermost, and GitLab poll cursors. */
export const KV = {
  jira: { cursor: record<{ lastUpdatedIso?: string; seenEventIds: string[] }>('jira-cursor') },
  mattermost: { cursor: record<{ channelSince: Record<string, number>; seenPostIds: string[] }>('mattermost-cursor') },
  gitlab: { cursor: record<{ seenNoteIds: string[]; lastPipelineStatusByMr: Record<string, string> }>('gitlab-cursor') },
}
