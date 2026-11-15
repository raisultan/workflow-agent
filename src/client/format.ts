/** Formatting for the dashboard (`D13`): times, durations, tokens, threads and people, in the viewer's language. */
import type { Links } from '../app/panel-api.ts'
import type { Lang } from './locales.ts'

const MONTHS: Record<Lang, readonly string[]> = {
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
}
const pad = (n: number) => String(n).padStart(2, '0')
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** `14:05`. */
export const hm = (ms: number) => { const date = new Date(ms); return `${pad(date.getHours())}:${pad(date.getMinutes())}` }
/** `сегодня` / `10 ноя`. */
export function day(ms: number, lang: Lang, now = Date.now()): string {
  const date = new Date(ms)
  if (sameDay(date, new Date(now))) return lang === 'ru' ? 'сегодня' : 'today'
  return `${date.getDate()} ${MONTHS[lang][date.getMonth()]}${date.getFullYear() === new Date(now).getFullYear() ? '' : ` ${date.getFullYear()}`}`
}
/** `14:05` today, `10 ноя, 14:05` before. */
export const clock = (ms: number, lang: Lang, now = Date.now()) => sameDay(new Date(ms), new Date(now)) ? hm(ms) : `${day(ms, lang, now)}, ${hm(ms)}`

/** `14:05` today, `10 ноя` before: when something ended, in a narrow column. */
export const when = (ms: number, lang: Lang, now = Date.now()) => sameDay(new Date(ms), new Date(now)) ? hm(ms) : day(ms, lang, now)

/** A span in words: `41 мин`, `2 ч 14 мин`, `3 д 4 ч`. */
export function ago(ms: number, lang: Lang): string {
  const ru = lang === 'ru'
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return ru ? 'меньше минуты' : 'under a minute'
  if (minutes < 60) return ru ? `${minutes} мин` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return ru ? `${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ''}` : `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  return ru ? `${days} д${hours % 24 ? ` ${hours % 24} ч` : ''}` : `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`
}
/** The largest unit only, for a list: `41 мин`, `2 ч`, `3 д`. */
export function short(ms: number, lang: Lang): string {
  const ru = lang === 'ru', minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return ru ? `${minutes} мин` : `${minutes}m`
  if (minutes < 1440) return ru ? `${Math.floor(minutes / 60)} ч` : `${Math.floor(minutes / 60)}h`
  return ru ? `${Math.floor(minutes / 1440)} д` : `${Math.floor(minutes / 1440)}d`
}
/** A duration: `0.8 s`, `42 s`, `38 мин`. */
export function duration(ms: number, lang: Lang): string {
  // What rounds to a minute is a minute: `60 s` is never shown.
  if (ms < 59_500) return `${ms < 9950 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} ${lang === 'ru' ? 'с' : 's'}`
  return ago(Math.max(ms, 60_000), lang)
}
/** `mm:ss` from an attempt's start. */
export const offset = (ms: number) => { const seconds = Math.max(0, Math.round(ms / 1000)); return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}` }

/** Tokens in thousands: `96k`, `1.23M`. */
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  // What rounds to a thousand thousands is a million: `1000k` is never shown.
  if (n < 999_500) return `${Math.round(n / 1000)}k`
  return `${Number.parseFloat((n / 1_000_000).toFixed(2))}M`
}

/** Where a thread is: its tool, a short label, and the address it opens at when the deployment knows it. */
export interface ThreadInfo { readonly tool: 'j' | 'm' | 'g' | 'o'; readonly label: string; readonly title: string; readonly href?: string }
export function thread(key: string, links: Links, lang: Lang): ThreadInfo {
  const [source, ...rest] = key.split(':')
  const body = rest.join(':')
  if (source === 'jira') return { tool: 'j', label: body, title: `Jira ${body}`, ...links.jira ? { href: `${links.jira}/browse/${encodeURIComponent(body)}` } : {} }
  if (source === 'gitlab') {
    const [project, iid] = body.split('!')
    return { tool: 'g', label: `!${iid ?? ''}`, title: `GitLab ${project ?? ''}!${iid ?? ''}`,
      ...links.gitlab && project && iid ? { href: `${links.gitlab}/${project}/-/merge_requests/${iid}` } : {} }
  }
  if (source === 'mattermost') {
    const [, root] = body.split(':')
    const label = root ? (lang === 'ru' ? 'тред' : 'thread') : (lang === 'ru' ? 'канал' : 'channel')
    return { tool: 'm', label, title: `Mattermost ${label}`, ...links.mattermost && root ? { href: `${links.mattermost}/_redirect/pl/${root}` } : {} }
  }
  return { tool: 'o', label: body || key, title: key }
}

/** A person as people know them: `@name` for a resolved Mattermost id, the id for Jira and GitLab, else `source:id`. */
export function person(actor: string | null | undefined, people: Readonly<Record<string, string>>): { name: string; known: boolean } {
  if (!actor) return { name: '—', known: false }
  const [source, ...rest] = actor.split(':')
  const id = rest.join(':')
  if (source === 'mattermost') return people[id] ? { name: `@${people[id]}`, known: true } : { name: actor, known: !/^[a-z0-9]{26}$/u.test(id) }
  if (source === 'jira' || source === 'gitlab') return { name: id, known: true }
  return { name: id || actor, known: true }
}
/** A domain actor (`{ source, id }`) as people know them. */
export const actorName = (actor: { source: string; id: string } | undefined, people: Readonly<Record<string, string>>) =>
  actor ? person(`${actor.source}:${actor.id}`, people).name : '—'
