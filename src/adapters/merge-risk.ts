/**
 * The merge-risk summary (`P16`, `D8` amendment): what the person who merges should know, from the same clean-context review call.
 * The reviewer judges five categories from the plan and the diff, each with its gaps; the host computes the level and never gates
 * on it. Adapted from the `merge-risk` skill (warpdotdev/common-skills, MIT; it credits Matt Pocock's `skills`, MIT): its
 * categories, verdict scale, weights and thresholds. Here the level is the host's, with floors: a sensitive area the change touches,
 * or the worst impact or rollback, makes it at least medium. See UPSTREAM.
 */
import { z } from 'zod'
import { isTestFile } from './test-integrity.ts'

// One line each: a gap can never start a line of the note the bot posts (a GitLab quick action such as `/merge`).
const gaps = z.array(z.string().transform(gap => gap.replace(/\s+/gu, ' ').trim()).pipe(z.string().min(1))).default([])
  .transform(list => list.slice(0, 3).map(gap => gap.length > 200 ? `${gap.slice(0, 200)}…` : gap))
const category = <T extends readonly [string, ...string[]]>(verdicts: T) => z.object({ verdict: z.enum(verdicts), gaps }).passthrough()

/** The reviewer's five categories (in the answer's `risk`). */
export const RiskSchema = z.object({
  alignment: category(['good', 'decent', 'poor']),
  impact: category(['small', 'medium', 'large']),
  verification: category(['good', 'decent', 'poor']),
  rollback: category(['low', 'medium', 'high']),
  errors: category(['good', 'decent', 'poor', 'n/a']),
}).passthrough()
export type Risk = z.output<typeof RiskSchema>
export type RiskCategory = 'alignment' | 'impact' | 'verification' | 'rollback' | 'errors'
export const RISK_CATEGORIES: readonly RiskCategory[] = ['alignment', 'impact', 'verification', 'rollback', 'errors']

/** A sensitive area a change touches, by its paths: these carry risk whatever the diff's size. */
export interface Sensitive { readonly area: 'migration' | 'auth' | 'dependencies' | 'ci' | 'infra' | 'secrets'; readonly files: readonly string[] }

/** What the host makes of a review's risk (`P16`): the level, why it was floored, the categories, and the areas touched. */
export interface MergeRisk {
  readonly level: 'low' | 'medium' | 'high'
  /** What raised the level to at least medium, when a floor did. */
  readonly floor: readonly string[]
  readonly categories: Risk
  readonly sensitive: readonly Sensitive[]
  /** The commit it is about. */
  readonly commit?: string
}

const AREAS: readonly [Sensitive['area'], RegExp][] = [
  ['migration', /(^|\/)(migrations?|alembic|db\/migrate)\/|\.sql$/iu],
  ['auth', /(^|\/|_|-)(auth|authn|authz|permissions?|acl|rbac|login|oauth|sso|session)(\/|\.|_|-|$)/iu],
  ['secrets', /(^|\/)\.env(\.|$)|(^|\/|_|-)(secrets?|credentials?)(\/|\.|_|-|$)/iu],
  ['dependencies', /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?)$/iu],
  ['ci', /(^|\/)(\.gitlab-ci\.yml|\.github\/|Jenkinsfile|\.circleci\/)/iu],
  ['infra', /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|k8s\/|helm\/|charts\/|terraform\/)|\.tf$/iu],
]

/** The sensitive areas a change's files touch (plain path rules). */
export function sensitiveAreas(files: readonly string[]): Sensitive[] {
  // Tests and documentation about auth or secrets are not auth or secrets.
  const code = files.filter(path => !isTestFile(path) && !/(^|\/)docs?\/|\.(md|rst|txt)$/iu.test(path))
  return AREAS.flatMap(([area, rule]) => {
    const hit = (area === 'auth' || area === 'secrets' ? code : files).filter(path => rule.test(path))
    return hit.length ? [{ area, files: hit }] : []
  })
}

const SCORE: Record<string, number> = { good: 1, small: 1, low: 1, 'n/a': 1, decent: 2, medium: 2, poor: 3, large: 3, high: 3 }
const WEIGHT: Record<RiskCategory, number> = { impact: 2, verification: 2, rollback: 1.5, errors: 1, alignment: 1 }

/**
 * The host's level from the reviewer's categories (`P16`): the weighted mean of the verdicts (1 good to 3 poor; impact and
 * verification count twice, rollback one and a half) — low under 1.5, high from 2.25 — then floors: a sensitive area touched, a
 * large impact or a high rollback cost makes it at least medium. `undefined` when the answer has no valid risk.
 */
export function mergeRisk(raw: unknown, files: readonly string[], commit?: string): MergeRisk | undefined {
  const parsed = RiskSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const categories = parsed.data
  // A category that does not apply ("n/a") is left out rather than counted as good.
  const judged = RISK_CATEGORIES.filter(name => categories[name].verdict !== 'n/a')
  const total = judged.reduce((sum, name) => sum + SCORE[categories[name].verdict]! * WEIGHT[name], 0)
  const mean = judged.length ? total / judged.reduce((sum, name) => sum + WEIGHT[name], 0) : 1
  const sensitive = sensitiveAreas(files)
  const floor = [...sensitive.map(entry => entry.area), ...categories.impact.verdict === 'large' ? ['impact'] : [], ...categories.rollback.verdict === 'high' ? ['rollback'] : []]
  const computed = mean < 1.5 ? 'low' : mean < 2.25 ? 'medium' : 'high'
  return { level: computed === 'low' && floor.length > 0 ? 'medium' : computed, floor, categories, sensitive, ...commit ? { commit } : {} }
}
