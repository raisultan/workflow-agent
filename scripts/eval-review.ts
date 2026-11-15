/**
 * `pnpm eval:review` (`P16`, `T16.8`): runs labelled review cases through the clean-context review check (`reviewChange`, the call
 * the `review` check makes) several times each, since its verdict is not stable on the same input, and prints per case how often
 * it reached the expected verdict, which labelled issues it found, which forbidden claims it made as blocking findings, and its
 * tokens. Cases: the synthetic set (`tests/fixtures/reviews.ts`), and with `--cases <file.json>` a set in the same shape (the
 * owner's trial replays, kept out of the repository).
 *
 * It exits 1 when a case labelled `pass` fails in any run (a false failure), or a forbidden claim blocks.
 *
 * It calls a real model, so it is manual and not part of `pnpm check`. The route is `eval:replies`' (`LITELLM_BASE_URL` and
 * `LITELLM_API_KEY`, or `DEEPSEEK_API_KEY`); the model is `WORKBENCH_REVIEW_MODEL`, else `LITELLM_MODEL` or `DEEPSEEK_MODEL`.
 * Options: `--runs <n>` (default 3; a case may set its own), `--only <ids>` (comma-separated), `--json <file>` (all results).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { parseUnifiedDiff } from '../src/adapters/work-diff.ts'
import { blocking, reviewChange, type ReviewOutcome } from '../src/adapters/review-check.ts'
import { REVIEW_CASES, type ReviewCase } from '../tests/fixtures/reviews.ts'

/** One run of a case: the outcome, and what it found or wrongly claimed. */
export interface RunResult {
  readonly verdict: 'pass' | 'changes' | 'unavailable'
  readonly tokens: number
  readonly found: readonly string[]
  readonly forbidden: readonly string[]
  readonly findings: readonly { readonly blocking: boolean; readonly text: string }[]
  /** Serious findings whose evidence the host did not find (`P16`), and test audit rows that are not "checks". */
  readonly demoted: number
  readonly audit: readonly string[]
  readonly reason?: string
}

const lower = (text: string) => text.toLowerCase()

/** What a run concluded about a case: the labelled issues it mentions anywhere, and the forbidden claims it made as blocking ones. */
export function score(review: ReviewCase, outcome: ReviewOutcome): RunResult {
  if (outcome.kind === 'unavailable') return { verdict: 'unavailable', tokens: outcome.tokens, found: [], forbidden: [], findings: [], demoted: 0, audit: [], reason: outcome.reason }
  const findings = outcome.review.findings.map(finding => ({ blocking: blocking(finding),
    text: `[${finding.severity}${finding.unverified ? `, unverified: ${finding.unverified}` : ''}] ${finding.file ?? ''}${finding.line ? `:${finding.line}` : ''} ${finding.issue}` }))
  const all = [outcome.review.summary, ...findings.map(finding => finding.text)].map(lower)
  const blockingTexts = findings.filter(finding => finding.blocking).map(finding => lower(finding.text))
  const mentions = (texts: readonly string[], terms: readonly string[]) => texts.some(text => terms.some(term => text.includes(lower(term))))
  return { verdict: outcome.review.verdict, tokens: outcome.tokens, findings,
    demoted: outcome.review.findings.filter(finding => finding.unverified).length,
    audit: outcome.review.tests.filter(test => test.verdict !== 'checks').map(test => `${test.verdict} ${test.file} ${test.name}`),
    // A "must" issue counts only as a blocking finding; a "should" one anywhere (a note, the audit, the summary).
    found: review.issues.filter(issue => mentions(issue.must ? blockingTexts : all, issue.match)).map(issue => issue.id),
    forbidden: outcome.review.verdict === 'changes' ? review.forbid.filter(claim => mentions(blockingTexts, claim.match)).map(claim => claim.id) : [] }
}

/** Whether a run reached the case's expected verdict. */
export const expected = (review: ReviewCase, run: RunResult) => review.expect === 'any' ? run.verdict !== 'unavailable' : run.verdict === review.expect

function route(env: NodeJS.ProcessEnv): { baseURL: string; apiKeyEnv: string; model: string } {
  const apiKeyEnv = env.LITELLM_API_KEY ? 'LITELLM_API_KEY' : env.DEEPSEEK_API_KEY ? 'DEEPSEEK_API_KEY' : undefined
  const baseURL = apiKeyEnv === 'LITELLM_API_KEY' ? env.LITELLM_BASE_URL : env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  const model = env.WORKBENCH_REVIEW_MODEL || env.LITELLM_MODEL || env.DEEPSEEK_MODEL
  if (!apiKeyEnv || !baseURL || !model) {
    throw new Error('set LITELLM_BASE_URL and LITELLM_API_KEY, or DEEPSEEK_API_KEY, and a model (WORKBENCH_REVIEW_MODEL, LITELLM_MODEL or DEEPSEEK_MODEL)')
  }
  return { baseURL, apiKeyEnv, model: model.replace(/^litellm\//u, '') }
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

async function main(): Promise<number> {
  const { baseURL, apiKeyEnv, model } = route(process.env)
  const runs = Number(option('runs') ?? 3)
  const only = option('only')?.split(',')
  // A case's diff may be a file beside the cases file, named by its `diff`.
  const file = option('cases')
  const extra = file ? (JSON.parse(readFileSync(file, 'utf8')) as ReviewCase[]).map(review => /\n/u.test(review.diff) ? review
    : { ...review, diff: readFileSync(join(dirname(file), review.diff), 'utf8') }) : []
  const cases = [...REVIEW_CASES, ...extra].filter(review => !only || only.includes(review.id))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(piAi, { providers: { litellm: { displayName: 'Review eval', apiKeyEnv, api: 'openai-completions', baseURL,
    models: [{ id: model, name: model, contextWindow: 128_000, maxTokens: 32_768 }] } } })
  const llm = (ctx as unknown as { llm: LlmRuntime }).llm
  for (let wait = 0; wait < 100 && !llm.listProviders().some(provider => provider.id === 'litellm'); wait++) await new Promise(resolve => setTimeout(resolve, 20))
  console.log(`Review model: litellm/${model} at ${new URL(baseURL).host}; ${cases.length} cases.\n`)

  const jobs = cases.flatMap(review => Array.from({ length: review.runs ?? runs }, (_, n) => ({ review, n })))
  const results = new Map<string, RunResult[]>(cases.map(review => [review.id, []]))
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < jobs.length) {
      const { review } = jobs[next++]!
      const files = parseUnifiedDiff(review.diff).map(file => file.path)
      const outcome = await reviewChange(llm, { model: `litellm/${model}`, plan: review.planText, ...review.followUps.length ? { followUps: review.followUps } : {},
        diff: review.diff, files, timeoutMs: 10 * 60_000 })
      results.get(review.id)!.push(score(review, outcome))
      process.stderr.write('.')
    }
  }))
  process.stderr.write('\n\n')

  let falseFailures = 0, blockedClaims = 0, missedMusts = 0, unavailable = 0, tokens = 0
  for (const review of cases) {
    const all = results.get(review.id)!
    const right = all.filter(run => expected(review, run)).length
    tokens += all.reduce((sum, run) => sum + run.tokens, 0)
    const pct = (id: string) => `${all.filter(run => run.found.includes(id)).length}/${all.length}`
    console.log(`${review.id} ${review.title}`)
    console.log(`  expected ${review.expect}: ${right}/${all.length}; verdicts ${all.map(run => run.verdict).join(', ')}; ~${Math.round(all.reduce((sum, run) => sum + run.tokens, 0) / Math.max(1, all.length))} tokens/run`)
    for (const issue of review.issues) {
      console.log(`  ${issue.must ? 'must block on' : 'should find'} ${issue.id}: ${pct(issue.id)}`)
      if (issue.must) missedMusts += all.filter(run => run.verdict !== 'unavailable' && !run.found.includes(issue.id)).length
    }
    unavailable += all.filter(run => run.verdict === 'unavailable').length
    for (const claim of review.forbid) {
      const made = all.filter(run => run.forbidden.includes(claim.id)).length
      blockedClaims += made
      console.log(`  must not block on ${claim.id}: ${made === 0 ? 'never' : `${made}/${all.length} runs`}`)
    }
    if (review.expect === 'pass') falseFailures += all.filter(run => run.verdict === 'changes').length
    for (const run of all.filter(run => run.verdict === 'unavailable')) console.log(`  unavailable: ${run.reason}`)
    const demoted = all.reduce((sum, run) => sum + run.demoted, 0)
    if (demoted) console.log(`  serious findings demoted for unverified evidence: ${demoted}`)
  }
  console.log(`\nFalse failures of pass cases: ${falseFailures}; forbidden blocking claims: ${blockedClaims}; missed must-block issues: ${missedMusts}; `
    + `runs with no verdict: ${unavailable}; ${tokens} tokens in all.`)
  const out = option('json')
  if (out) writeFileSync(out, JSON.stringify(Object.fromEntries(results), null, 1))
  await ctx.fiber.dispose()
  return falseFailures === 0 && blockedClaims === 0 && missedMusts === 0 && unavailable === 0 ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main()
