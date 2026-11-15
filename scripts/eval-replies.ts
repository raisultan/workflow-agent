/**
 * `pnpm eval:replies` (`T9.11`, `A12`): runs the labelled reply set (`tests/fixtures/replies.ts`) through the same path a gate
 * reply takes — the vocabulary fast path first, then the verdict model with the job's confidence rule — and prints a confusion
 * table of label against outcome. Then it reads the labelled reading cases (`tests/fixtures/readings.ts`, `D12`) the way a reply to
 * a question round is read. It exits 1 when any reply labelled outside `approve`/`approve_with_notes` would approve, or when a
 * reading records an answer the reply does not give.
 *
 * It calls a real model, so it is manual and not part of `pnpm check`. The route comes from the environment:
 * - `LITELLM_BASE_URL` and `LITELLM_API_KEY`, or `DEEPSEEK_API_KEY` (with `DEEPSEEK_BASE_URL`, default `https://api.deepseek.com`);
 * - the model: `WORKBENCH_VERDICT_MODEL`, else `DEEPSEEK_FAST_MODEL`, `LITELLM_MODEL` or `DEEPSEEK_MODEL`.
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { readingHandler } from '../src/adapters/reading.ts'
import { verdictHandler } from '../src/adapters/verdict.ts'
import { MIN_CONFIDENCE, ReadingSchema, VerdictSchema, type InterpretPayload, type ReadPayload } from '../src/domain/job.ts'
import { isStandaloneApproval, matchCancel } from '../src/domain/vocabulary.ts'
import { READINGS, type ReadingCase } from '../tests/fixtures/readings.ts'
import { APPROVING, REPLIES, type LabelledReply, type ReplyLabel } from '../tests/fixtures/replies.ts'

/** What a reply does to an open approval gate: a verdict it acts on, or `restated` when the workbench asks again. */
type Outcome = Exclude<ReplyLabel, 'unclear'> | 'restated' | 'failed'
const OUTCOMES: readonly Outcome[] = ['approve', 'approve_with_notes', 'request_changes', 'question', 'cancel', 'unrelated', 'restated', 'failed']
const LABELS: readonly ReplyLabel[] = ['approve', 'approve_with_notes', 'request_changes', 'question', 'cancel', 'unrelated', 'unclear']

interface Result { readonly reply: LabelledReply; readonly outcome: Outcome; readonly by: 'vocabulary' | 'model'; readonly detail: string }

function route(env: NodeJS.ProcessEnv): { baseURL: string; apiKeyEnv: string; model: string } {
  const apiKeyEnv = env.LITELLM_API_KEY ? 'LITELLM_API_KEY' : env.DEEPSEEK_API_KEY ? 'DEEPSEEK_API_KEY' : undefined
  const baseURL = apiKeyEnv === 'LITELLM_API_KEY' ? env.LITELLM_BASE_URL : env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  const model = env.WORKBENCH_VERDICT_MODEL || env.DEEPSEEK_FAST_MODEL || env.LITELLM_MODEL || env.DEEPSEEK_MODEL
  if (!apiKeyEnv || !baseURL || !model) {
    throw new Error('set LITELLM_BASE_URL and LITELLM_API_KEY, or DEEPSEEK_API_KEY, and a model (WORKBENCH_VERDICT_MODEL, DEEPSEEK_FAST_MODEL, LITELLM_MODEL or DEEPSEEK_MODEL)')
  }
  return { baseURL, apiKeyEnv, model: model.replace(/^litellm\//u, '') }
}

async function main(): Promise<number> {
  const { baseURL, apiKeyEnv, model } = route(process.env)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(piAi, { providers: { litellm: { displayName: 'Verdict eval', apiKeyEnv, api: 'openai-completions', baseURL,
    models: [{ id: model, name: model, contextWindow: 128_000, maxTokens: 8192 }] } } })
  const llm = (ctx as unknown as { llm: LlmRuntime }).llm
  for (let wait = 0; wait < 100 && !llm.listProviders().some(provider => provider.id === 'litellm'); wait++) await new Promise(resolve => setTimeout(resolve, 20))
  const handler = verdictHandler(llm, { timeoutMs: 60_000, maxAttempts: 3 })
  console.log(`Verdict model: litellm/${model} at ${new URL(baseURL).host}; ${REPLIES.length} replies; confidence threshold ${MIN_CONFIDENCE}.\n`)

  /** The decider's rule for an approval gate (`src/domain/decider.ts`, `reply` and `applyVerdict`). */
  const judge = async (reply: LabelledReply, index: number): Promise<Result> => {
    const cancel = matchCancel(reply.text)
    if (cancel) return { reply, outcome: 'cancel', by: 'vocabulary', detail: cancel.reason }
    if (isStandaloneApproval(reply.text)) return { reply, outcome: 'approve', by: 'vocabulary', detail: '' }
    const payload: InterpretPayload = { gateId: 'eval', eventId: `e${index}`, gateKind: 'approval', text: reply.text, actor: { source: 'eval', id: 'lead' },
      verdictModel: `litellm/${model}`, subject: { kind: 'plan', n: 1, digest: '0'.repeat(64), attemptId: 'eval' } }
    for (let attempt = 1; ; attempt++) {
      const result = await handler.run(payload, `eval:${index}`, attempt)
      if ('retry' in result) continue
      if ('fail' in result) return { reply, outcome: 'failed', by: 'model', detail: result.fail }
      const parsed = VerdictSchema.safeParse('ok' in result ? result.ok : undefined)
      if (!parsed.success) return { reply, outcome: 'restated', by: 'model', detail: 'malformed verdict' }
      const { verdict, confidence, reading = '' } = parsed.data
      if (verdict === 'unclear') return { reply, outcome: 'restated', by: 'model', detail: `unclear (${confidence}): ${reading}` }
      if (confidence < MIN_CONFIDENCE && verdict !== 'unrelated') return { reply, outcome: 'restated', by: 'model', detail: `${verdict} at ${confidence}: ${reading}` }
      // On an approval gate a change to the requirements is a change request like any other.
      return { reply, outcome: verdict === 'changes_requirements' ? 'request_changes' : verdict, by: 'model', detail: `${confidence}: ${reading}` }
    }
  }

  const results: Result[] = new Array(REPLIES.length)
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < REPLIES.length) {
      const index = next++
      results[index] = await judge(REPLIES[index]!, index)
      process.stderr.write('.')
    }
  }))
  process.stderr.write('\n\n')

  const width = Math.max(...LABELS.map(label => label.length)) + 2
  const head = ['label'.padEnd(width), ...OUTCOMES.map(outcome => outcome.slice(0, 9).padStart(10)), '  total'].join('')
  console.log(head)
  for (const label of LABELS) {
    const row = results.filter(result => result.reply.label === label)
    console.log([label.padEnd(width), ...OUTCOMES.map(outcome => String(row.filter(result => result.outcome === outcome).length || '·').padStart(10)),
      String(row.length).padStart(7)].join(''))
  }
  const expected = (result: Result) => result.reply.label === 'unclear' ? result.outcome === 'restated' : result.outcome === result.reply.label
  const exact = results.filter(expected).length
  const vocabulary = results.filter(result => result.by === 'vocabulary').length
  console.log(`\nExpected outcome: ${exact}/${results.length} (${Math.round(100 * exact / results.length)}%); ${vocabulary} decided by the vocabulary, ${results.length - vocabulary} by the model.`)
  for (const lang of ['ru', 'en', 'mixed'] as const) {
    const part = results.filter(result => result.reply.lang === lang)
    console.log(`  ${lang}: ${part.filter(expected).length}/${part.length}`)
  }

  const falseApprovals = results.filter(result => !APPROVING.has(result.reply.label) && APPROVING.has(result.outcome as ReplyLabel))
  const falseCancels = results.filter(result => result.reply.label !== 'cancel' && result.outcome === 'cancel')
  const missed = results.filter(result => !expected(result) && !falseApprovals.includes(result) && !falseCancels.includes(result))
  const list = (title: string, items: readonly Result[]) => {
    if (items.length === 0) return
    console.log(`\n${title} (${items.length}):`)
    for (const item of items) console.log(`  [${item.reply.label} → ${item.outcome}, ${item.by}] ${JSON.stringify(item.reply.text)}${item.detail ? ` — ${item.detail}` : ''}`)
  }
  list('FALSE APPROVALS', falseApprovals)
  list('False cancellations', falseCancels)
  list('Other mismatches', missed)
  console.log(falseApprovals.length === 0 ? '\nNo false approvals.' : `\n${falseApprovals.length} false approval(s): the release bar is zero.`)
  const invented = await readings(llm, model)
  await ctx.fiber.dispose()
  return falseApprovals.length === 0 && invented === 0 ? 0 : 1
}

/** Reads each reading case as the `readAnswers` effect does, and prints the mismatches; returns how many readings invented an answer. */
async function readings(llm: LlmRuntime, model: string): Promise<number> {
  const handler = readingHandler(llm, { timeoutMs: 60_000, maxAttempts: 3 })
  const read = async (reading: ReadingCase, index: number) => {
    const payload: ReadPayload = { gateId: 'eval', eventId: `r${index}`, text: reading.text, actor: { source: 'eval', id: 'requester' }, model: `litellm/${model}`,
      items: reading.items.map((text, at) => ({ n: at + 1, text, answered: reading.answered?.includes(at + 1) ?? false })) }
    for (let attempt = 1; ; attempt++) {
      const result = await handler.run(payload, `eval:r${index}`, attempt)
      if ('retry' in result) continue
      if ('fail' in result) return { reading, error: result.fail }
      const parsed = ReadingSchema.safeParse('ok' in result ? result.ok : undefined)
      return parsed.success ? { reading, got: parsed.data } : { reading, error: 'malformed reading' }
    }
  }
  console.log(`\nReading cases: ${READINGS.length}.`)
  const results = await Promise.all(READINGS.map(read))
  const items = (list: readonly { item: number }[] | undefined) => [...new Set(list?.map(entry => entry.item) ?? [])].sort().join(',')
  let exact = 0, invented = 0
  for (const result of results) {
    const { reading } = result
    if ('error' in result) { console.log(`  [failed] ${JSON.stringify(reading.text)} — ${result.error}`); continue }
    const { got } = result
    // The job keeps only open items it asked about; an answer to anything else is dropped there, and so is not counted here.
    const open = (item: number) => item >= 1 && item <= reading.items.length && !reading.answered?.includes(item)
    const answers = got.answers.filter(answer => open(answer.item))
    const extra = answers.filter(answer => !reading.expect.answers.includes(answer.item))
    const redirects = got.redirects.map(redirect => `${redirect.item}>${redirect.to.replace(/^@/u, '')}`).sort().join(' ')
    const wanted = (reading.expect.redirects ?? []).map(redirect => `${redirect.item}>${redirect.to}`).sort().join(' ')
    const same = items(answers) === [...reading.expect.answers].sort().join(',') && Boolean(got.question) === Boolean(reading.expect.question) && redirects === wanted
    if (same) { exact += 1; continue }
    if (extra.length > 0) invented += 1
    console.log(`  [${extra.length > 0 ? 'INVENTED' : 'mismatch'}] ${JSON.stringify(reading.text)}: answers ${items(answers) || '—'} (expected ${reading.expect.answers.join(',') || '—'}), `
      + `question ${got.question ? 'yes' : 'no'} (expected ${reading.expect.question ? 'yes' : 'no'}), redirects ${redirects || '—'} (expected ${wanted || '—'})`)
  }
  console.log(`Expected reading: ${exact}/${READINGS.length}.`)
  console.log(invented === 0 ? 'No invented answers.' : `${invented} reading(s) invented an answer: the release bar is zero.`)
  return invented
}

main().then(code => { process.exitCode = code }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 2
})
