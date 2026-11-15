/**
 * The isolation smoke's session probe (`T10.4`): DSH's file tools, called by a model inside a real stage attempt, under the path
 * guard the stage runner registers. Run by `smoke-worker-isolation.ts` as a child process, inside the full container; it prints
 * one JSON object.
 *
 * It boots a second copy of the `workflow-agent` profile in this process, through DSH's own `runProfile`, with a temporary `$DSH_HOME`
 * (a copy of the container's prepared profile, so the plugin is linked), its own state directory and work root, no connectors, and
 * the `litellm` route pointed at a scripted OpenAI-compatible model on loopback. A mention starts a job of `smoke-file-tools`
 * (`smoke-session-workflow.ts`); the real stage runner creates the attempt's session under the implement preset and registers the
 * guard; the scripted model then asks DSH to run `read`, `read_image`, `grep`, `glob` and `write`, and the results DSH sends back
 * in the next request are the evidence. Nothing here reaches outside the container.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

interface Tools { name: string }
interface Request { messages: { role: string; content: unknown; tool_call_id?: string }[]; tools?: { function?: Tools }[] }
type Call = { id: string; name: string; arguments: Record<string, unknown> }

const realHome = process.env.DSH_HOME ?? '/var/lib/workbench/dsh'
const realState = process.env.WORKBENCH_STATE_DIR ?? '/var/lib/workbench/state/data'
const root = '/tmp/smoke-session'
const home = join(root, 'dsh'), stateDir = join(root, 'state'), workRoot = join(root, 'work')
const sibling = join(workRoot, 'job_sibling')

async function main(): Promise<Record<string, unknown>> {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(home, 'profiles'), { recursive: true })
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(sibling, 'secret.txt'), 'SMOKE_SIBLING_SECRET')
  // The container's prepared profile (bundles and the linked plugin), with this smoke's own configuration.
  cpSync(join(realHome, 'profiles', 'workflow-agent'), join(home, 'profiles', 'workflow-agent'), { recursive: true, verbatimSymlinks: true })
  const module = join(dirname(fileURLToPath(import.meta.url)), 'smoke-session-workflow.ts')
  writeFileSync(join(home, 'profiles', 'workflow-agent', 'cordis.patch.yml'), [
    '- id: workflow-agent',
    '  config:',
    `    stateDir: ${stateDir}`,
    '    locale: en',
    '    models: { default: litellm/smoke-model }',
    `    executor: { maxWorkers: 1, workRoot: ${workRoot} }`,
    '    policy: { senders: { mattermost: [smoke] } }',
    `    workflows: { modules: [${module}] }`,
    '',
  ].join('\n'))

  // The scripted model: each request gets the next step; the requests DSH sends are the record.
  const requests: Request[] = []
  const steps: (Call[] | string)[] = [
    [
      { id: 'c1', name: 'read', arguments: { file_path: '/proc/self/environ' } },
      { id: 'c2', name: 'read', arguments: { file_path: join(realHome, '.credentials.yaml') } },
      { id: 'c3', name: 'grep', arguments: { pattern: 'SMOKE', path: sibling } },
      { id: 'c4', name: 'glob', arguments: { pattern: '**', path: realState } },
      { id: 'c5', name: 'read_image', arguments: { file_path: '/etc/hostname' } },
      { id: 'c6', name: 'read', arguments: { file_path: '../job_sibling/secret.txt' } },
      { id: 'c7', name: 'write', arguments: { file_path: 'notes.txt', content: 'SMOKE_WORKTREE_NOTE\n' } },
    ],
    [{ id: 'c8', name: 'read', arguments: { file_path: 'notes.txt' } }, { id: 'c9', name: 'grep', arguments: { pattern: 'SMOKE_WORKTREE_NOTE' } }],
    [{ id: 'c10', name: 'workbench_stage_report', arguments: { outcome: 'completed', summary: 'probed', output: {} } }],
    'done',
  ]
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = ''
    for await (const chunk of req) raw += String(chunk)
    if (!req.url?.endsWith('/chat/completions')) { res.statusCode = 404; res.end(); return }
    const body = JSON.parse(raw) as Request & { model: string; stream?: boolean }
    requests.push(body)
    const step = steps.shift() ?? 'done'
    const message = typeof step === 'string' ? { role: 'assistant', content: step }
      : { role: 'assistant', content: null, tool_calls: step.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
    const finish = typeof step === 'string' ? 'stop' : 'tool_calls'
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    if (!body.stream) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: body.model, usage, choices: [{ index: 0, message, finish_reason: finish }] }))
      return
    }
    res.setHeader('content-type', 'text/event-stream')
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
    send({ id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: message }] })
    send({ id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model, usage, choices: [{ index: 0, delta: {}, finish_reason: finish }] })
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  Object.assign(process.env, { DSH_HOME: home, HOST: '127.0.0.1', PORT: '25499', LITELLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    LITELLM_API_KEY: 'sk-smoke', LITELLM_MODEL: 'smoke-model', WORKBENCH_STATE_DIR: stateDir, WORKBENCH_WORK_DIR: workRoot, WORKBENCH_DEMO: 'false' })

  // DSH's own launcher: its environment loader and profile boot.
  const dsh = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
  const appBoot = await import(pathToFileURL(createRequire(dsh).resolve('@deepseek-ai/dsh-app-boot')).href) as { loadLayeredEnv(name: string): unknown }
  const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
  const { ctx } = await runProfile({ environment: appBoot.loadLayeredEnv('dsh') as never, profile: 'workflow-agent', patchFiles: [], args: ['--no-open', '--port', '25499'] })
  const runtime = ctx.get('orchestrator' as never) as unknown as { ready: Promise<void>; workbench: {
    kernel: { inbox: { append(input: unknown): { event: unknown } }; engine: { job(id: string): { state: { status: { kind: string } } } | undefined } }
    handle(event: unknown): { route: { kind: string }; submitted?: { outcome: { kind: string; jobId?: string } } } } }
  await runtime.ready
  const { event } = runtime.workbench.kernel.inbox.append({ source: 'mattermost', externalId: 'smoke-1', threadKey: 'mattermost:smoke:p1',
    actor: { source: 'mattermost', id: 'smoke' }, human: true, payload: { kind: 'message', text: '@workbench probe the file tools', addressed: 'mention', postedAt: Date.now() } })
  const handled = runtime.workbench.handle(event)
  const jobId = handled.submitted?.outcome.jobId
  if (!jobId) throw new Error(`no job started: ${JSON.stringify(handled)}`)
  let status = ''
  for (let wait = 0; wait < 600 && !['completed', 'failed', 'cancelled', 'blocked'].includes(status); wait++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    status = runtime.workbench.kernel.engine.job(jobId)?.state.status.kind ?? ''
  }

  // The evidence: the tools DSH offered the session, and each call's result as DSH sent it back.
  const offered = (requests[0]?.tools ?? []).map(tool => tool.function?.name ?? '')
  const results: Record<string, string> = {}
  for (const request of requests) {
    for (const message of request.messages) {
      if (message.role === 'tool' && message.tool_call_id) results[message.tool_call_id] = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    }
  }
  server.close()
  return { jobId, status, requests: requests.length, offered, results }
}

let output: Record<string, unknown>
try {
  output = await main()
} catch (error) {
  output = { error: error instanceof Error ? error.stack ?? error.message : String(error) }
}
process.stdout.write(`SMOKE_SESSION_RESULT ${JSON.stringify(output)}\n`)
rmSync(root, { recursive: true, force: true })
process.exit(0)
