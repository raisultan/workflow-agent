/**
 * Serves the built dashboard (`lib/dashboard`) without a running workbench (`D13`, `T15.10`), for looking at it and for screenshots:
 *
 *   node scripts/dashboard-preview.ts --fixture [--many] [--empty] [--port 25420]
 *     the synthetic data in tests/fixtures/dashboard.ts, edge cases included;
 *   node scripts/dashboard-preview.ts --state <dir> [--sessions <dir>] [--settings <file.json>] [--links jira=…,mattermost=…,gitlab=…]
 *     a copy of a workbench's state directory (never the live one: the database is opened for writing), the DSH session logs of its
 *     attempts (`sessions/` under DSH's home, `session.v4.jsonl.zstd`), and a saved `GET settings` answer.
 *
 * It serves through the dashboard's own server, so the page, its headers and its API are the deployed ones; nothing is sent anywhere.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { normalizeTrace, type AgentTrace } from '../src/app/agent-trace.ts'
import { startDashboard } from '../src/app/dashboard-server.ts'
import { routes, RouteError, type Links, type PanelHost, type Routes, type SettingsView } from '../src/app/panel-api.ts'
import { render } from '../src/adapters/messages.ts'
import { Workbench } from '../src/domain/workbench.ts'
import { syntheticHotfix } from '../src/workflows/synthetic-hotfix.ts'
import { standardDelivery } from '../src/workflows/standard-delivery.ts'
import { dashboardFixture } from '../tests/fixtures/dashboard.ts'

const { values } = parseArgs({ options: { fixture: { type: 'boolean' }, many: { type: 'boolean' }, empty: { type: 'boolean' }, state: { type: 'string' },
  sessions: { type: 'string' }, settings: { type: 'string' }, links: { type: 'string' }, port: { type: 'string', default: '25420' } } })

/** A session log as text. DSH appends one zstd frame per write; Node before 24 decodes only the first, so there the `zstd` tool reads it. */
function decompress(file: string): string {
  if (Number(process.versions.node.split('.')[0]) >= 24) return zstdDecompressSync(readFileSync(file)).toString('utf8')
  return execFileSync('zstd', ['-dcq', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** Finds a session's log under a copy of DSH's `sessions/` directory and normalizes it. */
function sessionTrace(root: string | undefined, sessionId: string): AgentTrace {
  if (!root) return { sessionId, steps: [], unavailable: { reason: 'missing', detail: 'no --sessions directory' } }
  for (const workspace of existsSync(root) ? readdirSync(root) : []) {
    const file = join(root, workspace, sessionId, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const events = decompress(file).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    return normalizeTrace(sessionId, events.filter(event => event.type !== 'session'))
  }
  return { sessionId, steps: [], unavailable: { reason: 'missing', detail: `no log for ${sessionId}` } }
}

function fixtureRoutes(): Routes {
  const data = dashboardFixture(Date.now(), { many: values.many ?? false, empty: values.empty ?? false })
  return {
    'GET state': () => data.state,
    'GET jobs/:id': params => { const detail = data.details[params.id!]; if (!detail) throw new RouteError(404, `No job ${params.id!}`); return detail },
    'GET jobs/:id/attempts/:attemptId/trace': params => {
      const attempt = data.details[params.id!]?.attempts.find(candidate => candidate.id === params.attemptId)
      if (!attempt) throw new RouteError(404, `No attempt ${params.attemptId!}`)
      return data.traces[attempt.sessionId] ?? { sessionId: attempt.sessionId, steps: [], unavailable: { reason: 'missing', detail: 'not in the fixture' } }
    },
    'GET inbox': () => data.inbox,
    'GET settings': () => data.settings,
  }
}

function stateRoutes(dir: string): Routes {
  const workbench = new Workbench({ path: join(resolve(dir), 'workbench.sqlite'), profile: { defaultModel: 'litellm/deepseek-flash', verdictModel: 'litellm/deepseek-flash' } as never,
    policy: () => ({ senders: {}, approvers: {}, bots: {} }) })
  for (const spec of [standardDelivery(), syntheticHotfix()]) workbench.register(spec)
  const settings = values.settings ? JSON.parse(readFileSync(values.settings, 'utf8')) as SettingsView : undefined
  const links: Links = values.links ? Object.fromEntries(values.links.split(',').map(pair => pair.split('=') as [string, string])) : settings?.links ?? {}
  const policy = settings?.policy
  const host: PanelHost = {
    workbench, health: () => ({ preview: { state: 'ready', detail: `A copy of ${dir}, read by scripts/dashboard-preview.ts` } }),
    settings: () => settings ?? (() => { throw new RouteError(404, 'Pass --settings with a saved GET settings answer') })(),
    secrets: () => [], people: () => ({}), links: () => links, locale: () => settings?.locale ?? 'ru', demo: () => false,
    // As `eligible()` rules: the repository's approvers when it lists any; else the requester (an allowed sender), the workflow's approvers and `*`.
    deciders: (workflowId, repository, requester) => {
      const names = (record: Readonly<Record<string, readonly string[]>>) => [...new Set(Object.values(record).flat().filter(name => !/^[a-z0-9]{26}$/u.test(name)))]
      const byRepository = repository ? policy?.repositoryApprovers?.[repository] : undefined
      if (byRepository) return names(byRepository)
      const approvers = names(policy?.approvers[workflowId] ?? {})
      const sender = (policy?.senders[requester.source] ?? []).some(id => id.toLowerCase() === requester.id.toLowerCase())
      return sender && !approvers.includes('*') ? [...new Set([requester.id, ...approvers])] : approvers
    },
    ticketTitle: () => undefined,
    renderPost: (jobId, threadKey, message) => {
      const source = threadKey.startsWith('jira:') ? 'jira' : threadKey.startsWith('gitlab:') ? 'gitlab' : 'mattermost'
      const job = workbench.kernel.engine.job(jobId)
      try {
        const pinned = job ? workbench.workflow(job.manifestId) : undefined
        return render(message as never, { locale: (settings?.locale ?? 'ru') as never, source, stageTitle: (id: string) => pinned?.declaration.stages.find(stage => stage.id === id)?.title ?? id,
          artifactText: (digest: string) => workbench.kernel.blobs.text(digest), name: (actor: { id: string }) => `@${actor.id}`, maxChars: 16_000, ticketUrl: () => undefined,
          reportOutput: () => undefined, delivered: () => ({}) } as never)
      } catch { return null }
    },
    trace: async sessionId => sessionTrace(values.sessions, sessionId),
  }
  return routes(host)
}

const routeTable = values.state ? stateRoutes(values.state) : fixtureRoutes()
const dashboard = await startDashboard({ host: '127.0.0.1', port: Number(values.port), assets: resolve('lib/dashboard'), routes: routeTable, ready: async () => {},
  secrets: () => [], log: message => { console.error(message) } })
console.log(`dashboard preview: http://127.0.0.1:${dashboard.port}/ (${values.state ? `state ${values.state}` : `fixture${values.many ? ', 200 jobs' : ''}${values.empty ? ', empty' : ''}`})`)
