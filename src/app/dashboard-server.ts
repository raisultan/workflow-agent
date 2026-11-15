/**
 * The dashboard's own server (`D13`, `T15.1`): the page, its files and the read-only API on a port of its own, apart from DSH's web
 * app. It is strictly read-only and signs nobody in:
 *
 * - only `GET` and `HEAD`; every other method gets `405`;
 * - only a `Host` that names loopback or a name in `WORKBENCH_DASHBOARD_HOSTS` (against DNS rebinding); others get `403`;
 * - API requests (`/api/…`) must carry `x-workbench-dashboard: 1`, which a cross-site page cannot send without a preflight this server
 *   never answers;
 * - the deployment's secrets are redacted from every answer, and answers carry an `ETag`, so an unchanged poll costs a `304`;
 * - static files come from a fixed map read at start; no part of a URL reaches the file system. Any other path gets the page, whose
 *   client routes it.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { redact, RouteError, type Routes } from './panel-api.ts'

export interface DashboardOptions {
  /** The address to listen on (`127.0.0.1` unless the deployment publishes the port from a container). */
  readonly host: string
  /** `0` picks a free port (tests). */
  readonly port: number
  /** Names besides loopback the page may be reached by (an SSO proxy's or an ingress's name). */
  readonly hosts?: readonly string[]
  /** The built page: `index.html`, `app.js`, `app.css` and `fonts/`. */
  readonly assets: string
  readonly routes: Routes
  /** API requests wait for it (the workbench's start); read per request, so a failed start is no unhandled rejection. */
  readonly ready: () => Promise<void>
  readonly secrets: () => readonly string[]
  readonly log?: (message: string) => void
}

export interface Dashboard {
  readonly server: Server
  /** The bound port. */
  readonly port: number
  close(): Promise<void>
}

/** The page's settings via the environment: `WORKBENCH_DASHBOARD_HOST`, `WORKBENCH_DASHBOARD_PORT`, `WORKBENCH_DASHBOARD_HOSTS`. */
export function dashboardEnv(env: NodeJS.ProcessEnv): { host: string; port: number; hosts: string[] } | undefined {
  if (env.WORKBENCH_DASHBOARD_PORT === 'off') return undefined
  const port = env.WORKBENCH_DASHBOARD_PORT === undefined || env.WORKBENCH_DASHBOARD_PORT === '' ? 25410 : Number(env.WORKBENCH_DASHBOARD_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`WORKBENCH_DASHBOARD_PORT must be a port number or off, not ${env.WORKBENCH_DASHBOARD_PORT}`)
  return { host: env.WORKBENCH_DASHBOARD_HOST || '127.0.0.1', port,
    hosts: (env.WORKBENCH_DASHBOARD_HOSTS ?? '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean) }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Whether a request's `Host` header names this page: loopback, or one of `hosts`; any port. */
export function allowedHost(header: string | undefined, hosts: readonly string[] = []): boolean {
  if (!header) return false
  // The whole value is a name or `[address]`, then an optional port: `[::1]evil.example` names nothing.
  const name = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/u.exec(header.trim().toLowerCase())?.[1]
  return name !== undefined && (LOOPBACK.has(name) || hosts.includes(name))
}

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const COMMON = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' }

interface Asset { readonly body: Buffer; readonly type: string; readonly etag: string }
const etagOf = (body: string | Buffer) => `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`

/** The page's files, read once: the URL path each is served at, and its body. */
export function loadAssets(dir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>()
  const add = (path: string, file: string) => {
    const ext = file.slice(file.lastIndexOf('.'))
    if (!TYPES[ext] || !existsSync(file)) return
    const body = readFileSync(file)
    assets.set(path, { body, type: TYPES[ext]!, etag: etagOf(body) })
  }
  add('/', join(dir, 'index.html'))
  for (const name of ['app.js', 'app.css', 'favicon.svg']) add(`/assets/${name}`, join(dir, name))
  const fonts = join(dir, 'fonts')
  if (existsSync(fonts)) for (const name of readdirSync(fonts)) if (/^[\w.-]+\.(?:woff2|txt)$/u.test(name)) add(`/assets/fonts/${name}`, join(fonts, name))
  return assets
}

const NOT_BUILT = '<!doctype html><meta charset="utf-8"><title>Workflow Agent</title><p>The dashboard is not built: run <code>pnpm build</code>.</p>'

/** Whether `If-None-Match` names `etag`: a list of tags, each strong or weak (`W/"…"`, which a proxy that compresses makes of ours), or `*`. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  return (header ?? '').split(',').map(tag => tag.trim()).some(tag => tag === '*' || tag.replace(/^W\//u, '') === etag)
}

function send(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer, etag?: string): void {
  if (etag && etagMatches(req.headers['if-none-match'], etag)) { res.writeHead(304, { ...COMMON, etag, ...headers['cache-control'] ? { 'cache-control': headers['cache-control'] } : {} }); res.end(); return }
  res.writeHead(status, { ...COMMON, ...headers, ...etag ? { etag } : {}, 'content-length': String(Buffer.byteLength(body)) })
  res.end(req.method === 'HEAD' ? undefined : body)
}

const json = (req: IncomingMessage, res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) => {
  const body = JSON.stringify(value)
  send(req, res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }, body, status === 200 ? etagOf(body) : undefined)
}

/** Finds the route for an API path (after `/api/`) and its parameters. */
function match(routes: Routes, path: string): { handler: (params: Record<string, string>) => unknown; params: Record<string, string> } | undefined {
  let segments: string[]
  try { segments = path.split('/').map(segment => decodeURIComponent(segment)) } catch { return undefined }
  for (const [route, handler] of Object.entries(routes)) {
    const pattern = route.slice(4).split('/')
    if (pattern.length !== segments.length || !pattern.every((part, index) => part.startsWith(':') || part === segments[index])) continue
    const params = Object.fromEntries(pattern.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1), segments[index]!]] : []))
    return { handler: handler as (params: Record<string, string>) => unknown, params }
  }
  return undefined
}

/** The request handler, apart from the server (tests call it directly). */
export function dashboardHandler(options: Omit<DashboardOptions, 'host' | 'port'>, assets = loadAssets(options.assets)) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') { json(req, res, 405, { error: 'Method Not Allowed: the dashboard is read-only' }, { allow: 'GET, HEAD' }); return }
    if (!allowedHost(req.headers.host, options.hosts)) { json(req, res, 403, { error: 'This dashboard is not served under that host name' }); return }
    const url = (() => { try { return new URL(req.url ?? '/', 'http://dashboard') } catch { return undefined } })()
    if (!url) { json(req, res, 400, { error: 'Bad Request' }); return }
    const path = url.pathname
    if (path === '/api' || path.startsWith('/api/')) {
      if (req.headers['x-workbench-dashboard'] !== '1') { json(req, res, 403, { error: 'The dashboard\'s own requests only' }); return }
      const found = match(options.routes, path.slice('/api/'.length))
      if (!found) { json(req, res, 404, { error: 'Unknown operation' }); return }
      try {
        await options.ready()
        json(req, res, 200, redact(await found.handler(found.params), options.secrets()))
      } catch (error) {
        const status = error instanceof RouteError ? error.status : 500
        if (status === 500) options.log?.(`dashboard: ${req.url ?? ''}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        json(req, res, status, redact({ error: error instanceof Error ? error.message : String(error) }, options.secrets()))
      }
      return
    }
    const asset = assets.get(path)
    if (asset && path !== '/') { send(req, res, 200, { 'content-type': asset.type, 'cache-control': 'no-cache' }, asset.body, asset.etag); return }
    if (path.startsWith('/assets/')) { json(req, res, 404, { error: 'Not found' }); return }
    const page = assets.get('/')
    send(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': CSP },
      page?.body ?? NOT_BUILT, page?.etag)
  }
}

/** Starts the dashboard; resolves once it listens. */
export async function startDashboard(options: DashboardOptions): Promise<Dashboard> {
  const handler = dashboardHandler(options)
  const server = createServer((req, res) => { void handler(req, res).catch(error => { options.log?.(`dashboard: ${String(error)}`); res.destroy() }) })
  server.headersTimeout = 20_000
  server.requestTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return { server, port, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
