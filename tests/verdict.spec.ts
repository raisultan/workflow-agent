/**
 * The model verdict adapter and LiteLLM contract tests (`T9.5`): DSH's LLM runtime and its OpenAI-compatible provider, routed to
 * a fake server. The verdict travels as a strict JSON object; anything else, an error or no answer never approves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modelRoute, parseVerdict, VERDICT_SYSTEM, verdictHandler } from '../src/adapters/verdict.ts'
import type { InterpretPayload } from '../src/domain/job.ts'
import { FakeLlm, llmContext } from './fixtures/fake-llm.ts'
import { Harness, LEAD } from './fixtures/domain-workflow.ts'

let fake: FakeLlm
let llm: Awaited<ReturnType<typeof llmContext>>
beforeEach(async () => {
  fake = await new FakeLlm().start()
  llm = await llmContext(fake, ['deepseek-verdict'])
})
afterEach(async () => {
  await llm.dispose()
  await fake.close()
})

const payload = (text: string): InterpretPayload => ({ gateId: 'g1', eventId: 'e1', gateKind: 'approval', text, actor: LEAD,
  verdictModel: 'litellm/deepseek-verdict', subject: { kind: 'plan', n: 2, digest: 'a'.repeat(64), attemptId: 'a1' } })

describe('verdict handler over LiteLLM', () => {
  it('asks the frozen verdict model with the reply quoted as data, and returns its JSON verdict', async () => {
    fake.replies.push({ text: '{"verdict":"approve_with_notes","notes":"reuse the helper","confidence":0.92,"reading":"Approved, with a note."}' })
    const result = await verdictHandler(llm.llm).run(payload('Ок, только переиспользуй хелпер'), 'k', 1)
    expect(result).toEqual({ ok: { verdict: 'approve_with_notes', notes: 'reuse the helper', confidence: 0.92, reading: 'Approved, with a note.' } })
    const [request] = fake.requests
    expect(request).toMatchObject({ model: 'deepseek-verdict', stream: true, authorization: 'Bearer sk-fake' })
    // A reasoning model thinks before it answers; the cap leaves room for both (an answer cut short never approves).
    expect(request!.body.max_tokens ?? request!.body.max_completion_tokens).toBe(4096)
    const text = JSON.stringify(request!.body.messages)
    expect(text).toContain(JSON.stringify(VERDICT_SYSTEM).slice(1, 60))
    expect(text).toContain('approval of plan revision 2')
    expect(text).toContain('<<<REPLY\\nОк, только переиспользуй хелпер\\nREPLY>>>')
  })

  it('reads a fenced answer, and passes an answer with no JSON on as malformed', async () => {
    fake.replies.push({ text: 'Here you go:\n```json\n{"verdict":"unclear","confidence":0.4}\n```' }, { text: 'I think they approve.' })
    expect(await verdictHandler(llm.llm).run(payload('hmm'), 'k', 1)).toEqual({ ok: { verdict: 'unclear', confidence: 0.4 } })
    expect(await verdictHandler(llm.llm).run(payload('hmm'), 'k', 1)).toEqual({ ok: { malformed: 'I think they approve.' } })
  })

  it('retries when the model refuses or does not answer in time, and fails after the last attempt', async () => {
    fake.replies.push({ status: 400 }, { status: 400 }, { hang: true })
    const handler = verdictHandler(llm.llm, { maxAttempts: 2, timeoutMs: 300 })
    expect(await handler.run(payload('ok?'), 'k', 1)).toMatchObject({ retry: { reason: expect.stringContaining('the verdict model') } })
    expect(await handler.run(payload('ok?'), 'k', 2)).toMatchObject({ fail: expect.stringContaining('the verdict model') })
    expect(await handler.run(payload('ok?'), 'k', 2)).toEqual({ fail: 'the verdict model did not answer within 300 ms' })
  })

  it('parses model references and answers', () => {
    expect(modelRoute('litellm/deepseek-verdict')).toEqual({ provider: 'litellm', model: 'deepseek-verdict' })
    expect(modelRoute('deepseek-verdict')).toEqual({ provider: 'litellm', model: 'deepseek-verdict' })
    expect(modelRoute('openrouter/deepseek/deepseek-chat')).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-chat' })
    expect(parseVerdict('{"verdict":"approve","confidence":1}')).toEqual({ verdict: 'approve', confidence: 1 })
    expect(parseVerdict('{broken')).toBeUndefined()
  })
})

describe('a gate resolved through the real adapter', () => {
  it('moves a job on a confident model approval, and never on a malformed answer or an unavailable model', async () => {
    const h = new Harness({ without: ['interpretReply'] })
    try {
      h.wb.kernel.effects.register('interpretReply', verdictHandler(llm.llm, { maxAttempts: 1 }))
      const job = await h.toApproval()
      fake.replies.push({ text: 'they approve, I think' }, { status: 400 },
        { text: '{"verdict":"approve","confidence":0.95,"reading":"Approved."}' })
      await h.say(LEAD, 'looks reasonable, go for it')
      await h.say(LEAD, 'yes please proceed')
      expect(h.status(job)).toBe('awaiting_gate')
      expect(h.gate(job)!.responses.map(response => response.reason)).toEqual(['unclear', 'unclear'])
      await h.say(LEAD, 'approved, go ahead with it')
      expect(h.state(job).attempt!.stageId).toBe('implement')
      expect(fake.requests.map(request => request.model)).toEqual(['deepseek-verdict', 'deepseek-verdict', 'deepseek-verdict'])
    } finally { h.cleanup() }
  })
})

describe('reading handler over LiteLLM (D12)', () => {
  it('asks with the round\'s items and the reply quoted, and returns the JSON reading', async () => {
    const { readingHandler, READING_SYSTEM } = await import('../src/adapters/reading.ts')
    fake.replies.push({ text: '{"answers":[{"item":2,"text":"час"}],"redirects":[{"item":3,"to":"anna"}]}' })
    const result = await readingHandler(llm.llm).run({ gateId: 'g1', eventId: 'e1', text: '2: час, про 3 спросите @anna', actor: LEAD,
      model: 'litellm/deepseek-verdict', items: [{ n: 1, text: 'Хранилище?', answered: true }, { n: 2, text: 'TTL?', answered: false }, { n: 3, text: 'Лимит?', answered: false }] }, 'k', 1)
    expect(result).toEqual({ ok: { answers: [{ item: 2, text: 'час' }], redirects: [{ item: 3, to: 'anna' }] } })
    const text = JSON.stringify(fake.requests[0]!.body.messages)
    expect(text).toContain(JSON.stringify(READING_SYSTEM).slice(1, 60))
    // The reading may say a reply is talk unrelated to the questions; one that tries to answer never is.
    expect(READING_SYSTEM).toContain('"unrelated": <true or false>')
    expect(READING_SYSTEM).toMatch(/tries to answer[^\n]*is never unrelated/u)
    expect(text).toContain('1. Хранилище? (already answered)\\n2. TTL?\\n3. Лимит?')
    expect(text).toContain('<<<REPLY\\n2: час, про 3 спросите @anna\\nREPLY>>>')
  })

  it('says whom a question was redirected to and who replies, so an unnumbered reply from that person is read as about it', async () => {
    const { readingHandler } = await import('../src/adapters/reading.ts')
    fake.replies.push({ text: '{"answers":[{"item":3,"text":"решение за исполнителем"}],"redirects":[]}' })
    await readingHandler(llm.llm, { username: () => 'anna' }).run({ gateId: 'g1', eventId: 'e2', text: 'не знаю, решай сам', actor: LEAD,
      model: 'litellm/deepseek-verdict', items: [{ n: 2, text: 'TTL?', answered: false }, { n: 3, text: 'Лимит?', answered: false, askedOf: ['anna'] }] }, 'k', 1)
    const text = JSON.stringify(fake.requests[0]!.body.messages)
    expect(text).toContain('2. TTL?\\n3. Лимит? (asked of @anna)\\nThe reply is from @anna.\\nThe reply, between the markers')
  })
})

describe('follow-up and answer handlers over LiteLLM (D12)', () => {
  it('tells a question from a follow-up, with the message quoted', async () => {
    const { followUpHandler, FOLLOW_UP_SYSTEM } = await import('../src/adapters/verdict.ts')
    fake.replies.push({ text: '{"verdict":"question","notes":"почему таблица?","confidence":0.9}' })
    const result = await followUpHandler(llm.llm).run({ message: { eventId: 'e', actor: LEAD, threadKey: 'gitlab:g/a!1', text: 'почему таблица?', postedAt: 1 },
      verdictModel: 'litellm/deepseek-verdict' }, 'k', 1)
    expect(result).toEqual({ ok: { verdict: 'question', notes: 'почему таблица?', confidence: 0.9 } })
    const text = JSON.stringify(fake.requests[0]!.body.messages)
    expect(text).toContain(JSON.stringify(FOLLOW_UP_SYSTEM).slice(1, 60))
    expect(text).toContain('<<<MESSAGE\\nпочему таблица?\\nMESSAGE>>>')
  })

  it('gives the follow-up reading the approved plan, so a change of its requirements is told from a fix (trial 2026-11-14)', async () => {
    const { followUpHandler, followUpPrompt, FOLLOW_UP_SYSTEM } = await import('../src/adapters/verdict.ts')
    fake.replies.push({ text: '{"verdict":"changes_requirements","notes":"фильтр по sku","confidence":0.9}' })
    const plans: string[] = []
    const result = await followUpHandler(llm.llm, { plan: jobId => { plans.push(jobId); return 'GET /orders: status, limit, offset.' } })
      .run({ message: { eventId: 'e', actor: LEAD, threadKey: 'gitlab:g/a!1', text: 'добавь фильтр по sku', postedAt: 1 }, verdictModel: 'litellm/deepseek-verdict', jobId: 'j1' }, 'k', 1)
    expect(result).toEqual({ ok: { verdict: 'changes_requirements', notes: 'фильтр по sku', confidence: 0.9 } })
    expect(plans).toEqual(['j1'])
    expect(JSON.stringify(fake.requests[0]!.body.messages)).toContain('<<<PLAN\\nGET /orders: status, limit, offset.\\nPLAN>>>\\n\\nThe message, between the markers')
    expect(followUpPrompt('ок')).toBe('The message, between the markers:\n<<<MESSAGE\nок\nMESSAGE>>>')
    expect(FOLLOW_UP_SYSTEM).toContain('"changes_requirements"')
  })

  it('reads an approver\'s reply with the proposals put to them, numbered as posted, and their decisions (D12)', async () => {
    const { verdictPrompt } = await import('../src/adapters/verdict.ts')
    const proposals = [{ id: 'p1', text: 'обычный 422', by: { source: 'jira', id: 'dev-ivan' } }, { id: 'p2', text: 'фильтр по sku', by: { source: 'gitlab', id: 'anna' } }]
    const text = verdictPrompt({ gateId: 'g', eventId: 'e', gateKind: 'approval', text: '1: да, 2: нет', actor: LEAD, verdictModel: 'm',
      subject: { kind: 'plan', n: 1, digest: 'a'.repeat(64), attemptId: 'a1' }, proposals })
    expect(text).toContain('<<<PROPOSALS\n[{"number":1,"id":"p1","from":"dev-ivan","text":"обычный 422"},{"number":2,"id":"p2","from":"anna","text":"фильтр по sku"}]\nPROPOSALS>>>')
    expect(verdictPrompt({ gateId: 'g', eventId: 'e', gateKind: 'proposal', text: 'да', actor: LEAD, verdictModel: 'm', proposals }))
      .toContain('The bot asked for: a decision on proposed changes to the approved requirements.')
    expect(VERDICT_SYSTEM).toContain('"proposals": [{"id": "p1", "accept": true}]')
    // The verdict carries the decisions.
    const { VerdictSchema } = await import('../src/domain/job.ts')
    expect(VerdictSchema.parse({ verdict: 'request_changes', confidence: 0.9, proposals: [{ id: 'p1', accept: true }, { id: 'p2', accept: false }] }).proposals).toHaveLength(2)
  })

  it('answers from the job\'s context, quoted, and returns the answer with its tokens', async () => {
    const { answerHandler, ANSWER_SYSTEM } = await import('../src/adapters/answers.ts')
    fake.replies.push({ text: '  Потому что так быстрее.  ' })
    const contexts: string[] = []
    const result = await answerHandler(llm.llm, async (jobId, thread) => { contexts.push(`${jobId} ${thread}`); return 'План: таблица quotes' })
      .run({ jobId: 'j1', answerId: 'a', threadKey: 'jira:ORD-1', question: 'зачем таблица?', actor: LEAD, model: 'litellm/deepseek-verdict' }, 'k', 1)
    expect(result).toMatchObject({ ok: { text: 'Потому что так быстрее.' } })
    expect((result as { ok: { tokens: number } }).ok.tokens).toBeGreaterThanOrEqual(0)
    expect(contexts).toEqual(['j1 jira:ORD-1'])
    const text = JSON.stringify(fake.requests[0]!.body.messages)
    expect(text).toContain(JSON.stringify(ANSWER_SYSTEM).slice(1, 40))
    expect(text).toContain('<<<CONTEXT\\nПлан: таблица quotes\\nCONTEXT>>>')
  })

  it('answers in the job\'s language: English for an English job, Russian for one pinned before D14', async () => {
    const { answerHandler, answerText, roundsContext } = await import('../src/adapters/answers.ts')
    fake.replies.push({ text: 'Because it is faster.' })
    const locales: string[] = []
    await answerHandler(llm.llm, async () => 'Plan: a quotes table', { locale: jobId => { locales.push(jobId); return 'en' } })
      .run({ jobId: 'j2', answerId: 'a', threadKey: 'jira:ORD-1', question: 'why a table?', actor: LEAD, model: 'litellm/deepseek-verdict' }, 'k', 1)
    const text = JSON.stringify(fake.requests.at(-1)!.body.messages)
    expect(locales).toEqual(['j2'])
    expect(text).toContain('Answer in English, briefly')
    expect(text).toContain('Task context:\\n<<<CONTEXT\\nPlan: a quotes table\\nCONTEXT>>>\\nQuestion:')
    expect(answerText('en').round(2, true)).toBe('Questions, round 2 (awaiting answers):')
    expect(answerText('xx')).toBe(answerText('ru'))
    expect(roundsContext([], 'en')).toEqual([])
  })

  it('gives an answer turn every question round, the open one before any answer too, with the answers so far', async () => {
    const { roundsContext } = await import('../src/adapters/answers.ts')
    const gate = (id: string, status: 'open' | 'answered', round: number, answers?: Record<string, { text: string; by: typeof LEAD }[]>) => ({
      id, kind: 'question' as const, stageId: 'inspect', threadKey: 't', openedAt: 1, status, responses: [], interpreting: [], round,
      items: [{ text: 'Какой лимит?', choices: ['10', '100'] }, { text: 'Код ошибки?' }], ...answers ? { answers } : {} })
    const approval = { id: 'g3', kind: 'approval' as const, stageId: 'plan', threadKey: 'jira:ORD-1', openedAt: 1, status: 'open' as const, responses: [], interpreting: [] }
    expect(roundsContext([gate('g1', 'answered', 1, { 1: [{ text: '100', by: LEAD }] }), gate('g2', 'open', 2), approval])).toEqual([
      'Вопросы, раунд 1:\n1. Какой лимит? (10 / 100)\n   — 100\n2. Код ошибки?',
      'Вопросы, раунд 2 (ждёт ответов):\n1. Какой лимит? (10 / 100)\n2. Код ошибки?',
    ])
  })
})
