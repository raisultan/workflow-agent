/**
 * A fake DSH surface for the stage runner (`T9.4`): the session controller, workspaces, permission presets, the LLM's route
 * resolution, persistence, and agents whose turns run a scripted "model". A script receives each delivered message and may record
 * usage, call the session's registered tools (as the model would), and end the turn.
 */
import { Context } from '@deepseek-ai/cordis'

type Tool = { name: string; parameters: unknown; execute(args: unknown, execution: { callId: string; signal: AbortSignal; concludeTurn(): void }): Promise<unknown> }
export type Script = (turn: { agent: FakeAgent; text: string; index: number }) => Promise<void> | void

export class FakeAgent {
  status: 'idle' | 'running' = 'idle'
  readonly session: { id: string; header: { agentPreset: string } }
  readonly inbox = { nextTurn: [] as unknown[], nextStep: [] as unknown[] }
  readonly tools = new Map<string, Tool>()
  readonly sections: { name: string; text: () => string }[] = []
  readonly steered: string[] = []
  readonly delivered: string[] = []
  allowed: string[] | undefined
  guards: ((execution: { name: string; arguments: unknown }) => string | undefined)[] = []
  selected: unknown
  cancelled = 0
  private idle: (() => void)[] = []
  private calls = 0
  private turnAbort = new AbortController()
  readonly ctx: unknown

  constructor(readonly id: string, preset: string, private readonly dsh: FakeDsh, readonly presetTools: readonly string[]) {
    this.session = { id, header: { agentPreset: preset } }
    this.ctx = {
      systemPrompt: { section: (section: { name: string; text: () => string }) => { this.sections.push(section); return () => {} } },
      tools: {
        register: (tool: Tool) => { this.tools.set(tool.name, tool); return () => { this.tools.delete(tool.name) } },
        // As DSH: read through a scope (the parent), only inherited preset tools are seen; the agent's own view adds its registrations.
        get: (name: string, ...scope: unknown[]) => this.presetTools.includes(name) || (scope.length === 0 && this.tools.has(name)) ? {} : undefined,
        // As DSH: `restrict` names only inherited tools, and refuses the agent's own registrations or unknown names.
        restrict: ({ allow }: { allow: string[] }) => {
          const unknown = allow.filter(name => !this.presetTools.includes(name))
          if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tools ${unknown.map(name => `"${name}"`).join(', ')}`)
          this.allowed = allow
          return () => { this.allowed = undefined }
        },
        guard: (guard: (execution: { name: string; arguments: unknown }) => string | undefined) => {
          this.guards.push(guard); return () => { this.guards = this.guards.filter(item => item !== guard) }
        },
      },
    }
  }
  readonly model = { select: (selection: unknown) => { this.selected = selection } }

  /** A model call of a registered tool; a refusal comes back as the error the model would see. */
  async call(name: string, args: unknown): Promise<{ value?: unknown; error?: string }> {
    // As DSH: every guard sees the call (its name and arguments) before the tool runs.
    const blocked = this.guards.map(guard => guard({ name, arguments: args })).find(Boolean)
    if (blocked) return { error: blocked }
    const tool = this.tools.get(name)
    // A preset's own DSH tool (`read`, `bash`, …) "runs" by echoing its call.
    if (!tool && this.presetTools.includes(name)) return { value: { ran: name, args } }
    if (!tool) return { error: `no tool ${name}` }
    try {
      return { value: await tool.execute(args, { callId: `call-${++this.calls}`, signal: this.turnAbort.signal, concludeTurn: () => {} }) }
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  }

  /** One model step's usage, as DSH records it. */
  usage(inputTokens: number, outputTokens: number, turn = 0): void {
    this.dsh.ctx.emit('session/event' as never, this.session as never, { type: 'assistant/message', data: { turn, step: ++this.calls, usage: { inputTokens, outputTokens } } } as never)
  }

  followup(message: { content: { text: string }[] }): void { this.run(message.content[0]!.text) }
  steer(message: { content: { text: string }[] }): void { this.steered.push(message.content[0]!.text) }
  inject(): void {}
  whenIdle(): Promise<void> { return this.status === 'idle' ? Promise.resolve() : new Promise(resolve => this.idle.push(resolve)) }
  cancel(): void {
    this.cancelled++
    this.turnAbort.abort()
    this.setStatus('idle')
  }

  private setStatus(status: 'idle' | 'running'): void {
    this.status = status
    this.dsh.ctx.emit('agent/status' as never, { agent: this, status } as never)
    if (status === 'idle') for (const resolve of this.idle.splice(0)) resolve()
  }

  private run(text: string): void {
    const index = this.delivered.length
    this.delivered.push(text)
    this.turnAbort = new AbortController()
    this.setStatus('running')
    void (async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      try { await this.dsh.script({ agent: this, text, index }) } finally { if (this.status === 'running') this.setStatus('idle') }
    })()
  }
}

/** The DSH services the stage runner uses, over a real Cordis context for events. */
export class FakeDsh {
  readonly ctx = new Context()
  readonly agents = new Map<string, FakeAgent>()
  readonly created: { sessionId: string; workspaceId: string; agentPreset: string }[] = []
  readonly archived: string[] = []
  readonly permissions = new Map<string, string>()
  readonly titles = new Map<string, string>()
  script: Script = () => {}
  /** Stored session logs by session id, as DSH's session persistence reads them (`D13`'s agent trace). */
  readonly sessionLogs = new Map<string, unknown[]>()
  /** Whether a session with no stored log is not found (as DSH answers), rather than read as empty. */
  sessionsMustExist = false

  constructor(presetTools: readonly string[] = ['read', 'write', 'edit', 'bash', 'web_fetch']) {
    const agents = this.agents
    const services: Record<string, unknown> = {
      sessionController: {
        resolveAgent: async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
        create: async (input: { sessionId: string; workspaceId: string; agentPreset: string }) => {
          this.created.push(input)
          agents.set(input.sessionId, new FakeAgent(input.sessionId, input.agentPreset, this, presetTools))
        },
        rename: async ({ sessionId, title }: { sessionId: string; title: string }) => { this.titles.set(sessionId, title) },
      },
      workspaceRegistry: {
        create: async (cwd: string) => ({ id: `ws:${cwd}` }),
        archiveSession: async (id: string) => { this.archived.push(id) },
      },
      permissionPresets: { set: (session: { id: string }, preset: string) => { this.permissions.set(session.id, preset) } },
      llm: { resolveCallConfig: async (config: object) => config },
      sessionPersistence: { flush: async () => {}, open: async (id: string) => {
        const events = this.sessionLogs.get(id) ?? (this.sessionsMustExist ? undefined : [])
        if (!events) throw Object.assign(new Error(`Session ${id} has no durable log`), { name: 'SessionPersistenceNotFoundError' })
        return { read: async () => ({ events }), close: async () => {}, [Symbol.asyncDispose]: async () => {} }
      } },
      agents: { get: (id: string) => agents.get(id) },
    }
    for (const [name, service] of Object.entries(services)) this.ctx.reflect.provide(name as never, service as never)
  }
}
