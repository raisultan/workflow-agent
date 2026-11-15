/**
 * A fake OpenAI-compatible server (`T9.5`): chat completions, streamed or not, with scripted replies (text, tool calls, HTTP
 * errors, hangs), and every request recorded. It backs the LiteLLM contract tests and the stage-runner runtime tests, through DSH's
 * own LLM runtime and its OpenAI-compatible provider, so tests exercise the same route production uses.
 */
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'

/** One scripted reply: assistant text, tool calls, an HTTP error, or no answer at all. */
export type FakeReply =
  | { text: string; usage?: { prompt: number; completion: number } }
  | { toolCalls: readonly { id: string; name: string; arguments: unknown }[]; text?: string }
  | { status: number; body?: string }
  | { hang: true }

export interface FakeRequest {
  readonly model: string
  readonly stream: boolean
  readonly authorization?: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: { messages: { role: string; content: unknown }[]; tools?: unknown[]; [key: string]: unknown }
}

/** A running fake server; `replies` is consumed in order, and `fallback` answers once it runs out. */
export class FakeLlm {
  readonly requests: FakeRequest[] = []
  readonly replies: FakeReply[] = []
  fallback: FakeReply = { text: 'ok' }
  private readonly server: Server
  private readonly hanging = new Set<() => void>()
  url = ''

  constructor() {
    this.server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += String(chunk)
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.statusCode = 404; res.end(); return }
      const body = JSON.parse(raw) as FakeRequest['body'] & { model: string; stream?: boolean }
      this.requests.push({ model: body.model, stream: body.stream === true, headers: req.headers, body,
        ...req.headers.authorization ? { authorization: req.headers.authorization } : {} })
      const reply = this.replies.shift() ?? this.fallback
      if ('hang' in reply) {
        await new Promise<void>(resolve => { this.hanging.add(resolve); req.on('close', resolve) })
        return
      }
      if ('status' in reply) { res.statusCode = reply.status; res.end(reply.body ?? JSON.stringify({ error: { message: `fake ${reply.status}` } })); return }
      const message = 'toolCalls' in reply
        ? { role: 'assistant', content: reply.text ?? null, tool_calls: reply.toolCalls.map((call, index) => ({ index, id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
        : { role: 'assistant', content: reply.text }
      const usage = 'usage' in reply && reply.usage
        ? { prompt_tokens: reply.usage.prompt, completion_tokens: reply.usage.completion, total_tokens: reply.usage.prompt + reply.usage.completion }
        : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      const finish = 'toolCalls' in reply ? 'tool_calls' : 'stop'
      if (!body.stream) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'cmpl', object: 'chat.completion', created: 1, model: body.model, usage,
          choices: [{ index: 0, message, finish_reason: finish }] }))
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
      send({ id: 'cmpl', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: message }] })
      send({ id: 'cmpl', object: 'chat.completion.chunk', created: 1, model: body.model, usage,
        choices: [{ index: 0, delta: {}, finish_reason: finish }] })
      res.end('data: [DONE]\n\n')
    })
  }

  async start(): Promise<this> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/v1`
    return this
  }

  async close(): Promise<void> {
    for (const release of this.hanging) release()
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}

/** DSH's LLM runtime with the OpenAI-compatible provider routed to `fake` as `litellm`, serving `models`. */
export async function llmContext(fake: FakeLlm, models: readonly string[]): Promise<{ ctx: Context; llm: LlmRuntime; dispose(): Promise<void> }> {
  process.env.FAKE_LLM_KEY = 'sk-fake'
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(piAi, { providers: { litellm: { displayName: 'Fake LiteLLM', apiKeyEnv: 'FAKE_LLM_KEY', api: 'openai-completions',
    baseURL: fake.url, models: models.map(id => ({ id, name: id, contextWindow: 128_000, maxTokens: 8192 })) } } })
  const llm = (ctx as unknown as { llm: LlmRuntime }).llm
  for (let wait = 0; wait < 50 && !llm.listProviders().some(provider => provider.id === 'litellm'); wait++) await new Promise(resolve => setTimeout(resolve, 10))
  return { ctx, llm, dispose: () => ctx.fiber.dispose() }
}
