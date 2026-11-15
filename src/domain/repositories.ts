/**
 * Repository profiles (`T11.1`, `D10` decision 1): the repositories a deployment serves, and the deterministic choice of one for a
 * new job. A profile names the GitLab project, the target branch, the test command, an optional setup command, the registry
 * presets its stages may reach, toolchain versions for tools the repository does not pin, its match rules, and whether it has CI.
 *
 * The choice is made at intake, from the trigger only, in this order:
 * 1. an explicit `repo:<name>` (or `repo:<project path>`) in the triggering message, in any case, with markdown, quotes or
 *    brackets around it and a space after the colon allowed. Any `repo:` token decides: if what it names is not exactly a
 *    configured name or project, or two tokens disagree, nothing is chosen, so a mistyped name never falls back to another
 *    repository;
 * 2. the Jira project of the trigger's thread (`jira:<PROJECT>-<n>`);
 * 3. the Mattermost channel of the trigger's thread;
 * 4. the deployment's default.
 *
 * A `repo:` naming no profile, or no rule and no default, chooses nothing: the workbench replies with the names of the repositories
 * this sender may use, and no job starts. Two refusals start no job either, with a reply that says why (`D10`): a `repo:`
 * naming another repository than the one the thread maps to by its Jira project or channel, and a sender that the chosen
 * repository's own `senders` do not list. Rules that match more than one profile are refused when the configuration is loaded, so a
 * choice never depends on order. The chosen profile is frozen in the job's run manifest.
 */
import { z } from 'zod'
import type { Actor } from './policy.ts'

export const REPOSITORY_NAME = /^[a-z][a-z0-9_-]{0,39}$/u
/** Tool names a profile may give default versions for; the toolchain resolver (`T11.3`) accepts only these. */
export const TOOLCHAIN_TOOLS = ['node', 'python', 'go', 'uv', 'pnpm'] as const
/** A plain version: digits and dots, optionally with a leading `v` (Node's `.nvmrc` style). */
export const PLAIN_VERSION = /^v?\d{1,4}(?:\.\d{1,4}){0,2}$/u

const Text = z.string().trim().min(1)
const JiraProject = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,31}$/u, 'a Jira project key, such as ORD')
const ChannelId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/u, 'a Mattermost channel id')

export const RepositoryProfileSchema = z.object({
  /** The short name people use in `repo:<name>`. */
  name: z.string().trim().regex(REPOSITORY_NAME, 'lowercase letters, digits, "-" and "_", starting with a letter'),
  /** The GitLab project path, such as `acme/payments`. */
  project: z.string().trim().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u, 'a GitLab project path, such as group/project'),
  targetBranch: Text.default('main'),
  testCommand: Text,
  /** Run once per job worktree, before the first stage, in the job's sandbox with the `registries` egress profile. */
  setupCommand: Text.optional(),
  /**
   * The registry presets (`npm`, `pypi`, `go`) the job's `registries` stages and setup command may reach; the deployment's
   * `egress.presets` when not given.
   */
  registries: z.array(Text).optional(),
  /** Versions for tools the repository does not pin. */
  toolchains: z.partialRecord(z.enum(TOOLCHAIN_TOOLS), z.string().trim().regex(PLAIN_VERSION, 'a plain version, such as 3.12 or 22.12.0')).default({}),
  /**
   * The Postgres major for the job's test services (`T12.4`), only when the repository's CI and Compose files name the wrong one or
   * none; otherwise it is read from them.
   */
  postgres: z.coerce.string().trim().regex(/^\d{2}$/u, 'a Postgres major, such as 16').optional(),
  match: z.object({
    jira: z.array(JiraProject).default([]),
    mattermost: z.array(ChannelId).default([]),
  }).strict().default({ jira: [], mattermost: [] }),
  /**
   * Who may start a job on this repository, per source, in the global policy's forms (ids, or Mattermost usernames); both this and
   * the global sender policy must allow the sender. Absent: the global senders only.
   */
  senders: z.record(z.string().min(1), z.array(z.string().trim().min(1))).optional(),
  /**
   * Who approves this repository's plans, and extends, resumes or cancels its blocked jobs (`D12`), by email; the host resolves each to
   * its user in every tool at startup. When given, only they do, the requester included. Absent: the global approvers, as before.
   */
  approvers: z.array(z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+$/u, 'an email address')).optional(),
  /** `required`: the job's stages wait for CI on the pushed commit. `none`: the repository has no CI, so that check is left out. */
  ci: z.enum(['required', 'none']).default('required'),
  /** The deployment's default repository; at most one. */
  default: z.boolean().default(false),
}).strict()
export type RepositoryProfile = z.output<typeof RepositoryProfileSchema>
export type RepositoryProfileInput = z.input<typeof RepositoryProfileSchema>

/** The `repositories` configuration: profiles with unique names and projects, at most one default, and no overlapping rules. */
export const RepositoriesSchema = z.array(RepositoryProfileSchema).superRefine((profiles, issue) => {
  const fail = (message: string) => issue.addIssue({ code: 'custom', message })
  const twice = <T>(values: readonly T[]) => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
  for (const name of twice(profiles.map(profile => profile.name))) fail(`repository name ${name} is used twice`)
  for (const project of twice(profiles.map(profile => profile.project))) fail(`project ${project} is configured twice`)
  const defaults = profiles.filter(profile => profile.default).map(profile => profile.name)
  if (defaults.length > 1) fail(`only one repository may be the default, not ${defaults.join(', ')}`)
  for (const key of twice(profiles.flatMap(profile => profile.match.jira))) fail(`Jira project ${key} matches more than one repository`)
  for (const channel of twice(profiles.flatMap(profile => profile.match.mattermost))) fail(`Mattermost channel ${channel} matches more than one repository`)
})

/** What the choice reads of a trigger. */
export interface Trigger {
  readonly text: string
  readonly threadKey: string
}

export type RepositoryChoice =
  | { readonly kind: 'chosen'; readonly repository: RepositoryProfile; readonly basis: 'explicit' | 'jira' | 'mattermost' | 'default';
      /** Which rule let the sender start a job on it: the repository's own `senders`, or (with none) the global ones. */
      readonly allowedBy: 'repository' | 'global' }
  /** Nothing chosen: `names` are the repositories this sender may use, so the reply reveals no other. */
  | { readonly kind: 'none'; readonly requested?: string; readonly names: readonly string[] }
  /** Chosen, but refused: the sender may not use it, or a `repo:` contradicts the repository the thread maps to. */
  | { readonly kind: 'refused'; readonly reason: 'not_allowed'; readonly repository: string }
  | { readonly kind: 'refused'; readonly reason: 'contradicts'; readonly repository: string; readonly mapped: string }

/** A `repo:` token: not inside another word (`myrepo:`), in any case, with spaces allowed before and after the colon. */
const TOKEN = /(?<![\p{L}\p{N}./-])(?<![\p{L}\p{N}]_)repo\s*:/giu
/** What a token names: after optional spaces and opening markdown, quote or bracket marks, up to a space or a closing mark. */
const VALUE = /^\s*([`*_"'«\[(<]*)([^\s`*"'«»[\]()<>,;!?]*)/u

/**
 * The repositories the message's `repo:` tokens name, as written: a trailing full stop dropped, and closing `_` emphasis when the
 * token or its value opened with it. Empty when the message has no token.
 */
export function explicitRepositories(text: string): string[] {
  return [...text.matchAll(TOKEN)].map(match => {
    const [, open, value] = VALUE.exec(text.slice(match.index + match[0].length))!
    const plain = value!.replace(/\.+$/u, '')
    return open!.includes('_') || text[match.index - 1] === '_' ? plain.replace(/_+$/u, '') : plain
  })
}

/**
 * Whether `sender` may start a job on `profile` (`D10`): with no `senders`, anyone the global policy allows; with
 * `senders`, only those listed for the sender's source (case-insensitively, as the global policy compares). The global check runs
 * first, in the router; both apply.
 */
export function mayUse(profile: RepositoryProfile, sender: Actor | undefined): boolean {
  if (!profile.senders || !sender) return true
  return (profile.senders[sender.source] ?? []).some(id => id.toLowerCase() === sender.id.toLowerCase())
}

/** Chooses the repository of a new job from its trigger and its sender; see the module comment for the order and the refusals. */
export function chooseRepository(profiles: readonly RepositoryProfile[], trigger: Trigger, sender?: Actor): RepositoryChoice {
  const names = profiles.filter(profile => mayUse(profile, sender)).map(profile => profile.name)
  const jira = /^jira:([A-Z][A-Z0-9_]*)-\d+$/u.exec(trigger.threadKey)?.[1]
  const byJira = jira === undefined ? undefined : profiles.find(profile => profile.match.jira.includes(jira))
  const channel = /^mattermost:([^:]+):/u.exec(trigger.threadKey)?.[1]
  const byChannel = byJira || channel === undefined ? undefined : profiles.find(profile => profile.match.mattermost.includes(channel))
  const mapped = byJira ?? byChannel
  const explicit = explicitRepositories(trigger.text)
  let candidate: RepositoryProfile | undefined, basis: 'explicit' | 'jira' | 'mattermost' | 'default'
  if (explicit.length > 0) {
    const named = explicit.map(value => profiles.find(profile => profile.name === value.toLowerCase() || profile.project.toLowerCase() === value.toLowerCase()))
    const first = named[0]
    if (!first || !named.every(profile => profile === first)) {
      const odd = named.findIndex(profile => profile !== first)
      return { kind: 'none', requested: explicit[odd === -1 ? 0 : odd] || explicit[0]!, names }
    }
    // The thread already belongs to a repository: `repo:` may name it, never another.
    if (mapped && mapped !== first) return { kind: 'refused', reason: 'contradicts', repository: first.name, mapped: mapped.name }
    candidate = first
    basis = 'explicit'
  } else {
    candidate = mapped ?? profiles.find(profile => profile.default)
    basis = byJira ? 'jira' : byChannel ? 'mattermost' : 'default'
  }
  if (!candidate) return { kind: 'none', names }
  if (!mayUse(candidate, sender)) return { kind: 'refused', reason: 'not_allowed', repository: candidate.name }
  return { kind: 'chosen', repository: candidate, basis, allowedBy: candidate.senders && sender ? 'repository' : 'global' }
}

/** The workflow parameters a repository profile gives a job (`{{repository}}`, `{{testCommand}}`, …), frozen in its manifest. */
export function repositoryParameters(profile: RepositoryProfile): Record<string, string> {
  return {
    repository: profile.project, 'repository.name': profile.name, targetBranch: profile.targetBranch, testCommand: profile.testCommand,
    ...profile.setupCommand ? { setupCommand: profile.setupCommand } : {}, ci: profile.ci,
  }
}
