/** Typed keys of the Sources' records (their poll cursors), kept in the kernel's `kv` table under `source:`. */

/** Key of a record whose value has type `V`. */
export type Key<V> = string & { readonly __value?: V }
/** Family of records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** A single typed key; Source plugins use `record` and `family` to type their own. */
export const record = <V>(key: string) => key as Key<V>
/** A key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Jira, Mattermost, and GitLab poll cursors. */
  jira: { cursor: record<{ lastUpdatedIso?: string; seenEventIds: string[] }>('jira-cursor') },
  mattermost: { cursor: record<{ channelSince: Record<string, number>; seenPostIds: string[] }>('mattermost-cursor') },
  gitlab: { cursor: record<{ seenNoteIds: string[]; lastPipelineStatusByMr: Record<string, string> }>('gitlab-cursor') },
}
