/**
 * The dashboard's own server (`D13`, `T15.1`): read-only, served only under loopback or allowlisted names, API requests marked as
 * the page's own, secrets redacted, `ETag`s, a fixed map of files and the page for every other path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allowedHost, CSP, dashboardEnv, etagMatches, startDashboard, type Dashboard } from '../src/app/dashboard-server.ts'
import { RouteError, type Routes } from '../src/app/panel-api.ts'

let dir: string
let dashboard: Dashboard
const API = { 'x-workbench-dashboard': '1' }

/** One request with exactly the given headers (`fetch` would set `Host` itself). */
function get(path: string, { method = 'GET', headers = {} as Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: dashboard.port, path, method, headers: { host: `127.0.0.1:${dashboard.port}`, ...headers } }, res => {
      let body = ''
      res.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body }) })
    })
    req.on('error', reject).end()
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dashboard-server-'))
  mkdirSync(join(dir, 'fonts'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>')
  writeFileSync(join(dir, 'app.js'), 'console.log(1)')
  writeFileSync(join(dir, 'app.css'), 'body{}')
  writeFileSync(join(dir, 'fonts', 'onest.woff2'), 'font')
  writeFileSync(join(dir, 'secret.txt'), 'not served')
  const routes = {
    'GET state': () => ({ jobs: [], note: 'token sk-dashboard-secret' }),
    'GET jobs/:id': (params: Record<string, string>) => { if (params.id === 'nope') throw new RouteError(404, 'No job nope'); return { id: params.id } },
    'GET jobs/:id/attempts/:attemptId/trace': async (params: Record<string, string>) => ({ sessionId: `wb-${params.attemptId}`, steps: [] }),
    'GET inbox': () => { throw new Error('broke with sk-dashboard-secret') },
    'GET settings': () => ({}),
  } as unknown as Routes
  dashboard = await startDashboard({ host: '127.0.0.1', port: 0, hosts: ['workbench.example.test'], assets: dir, routes, ready: async () => {},
    secrets: () => ['sk-dashboard-secret'] })
})
afterAll(async () => {
  await dashboard.close()
  rmSync(dir, { recursive: true, force: true })
})

it('is read-only: every method but GET and HEAD gets 405', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await get('/api/state', { method, headers: API })
    expect(response.status).toBe(405)
    expect(response.headers.allow).toBe('GET, HEAD')
  }
  expect((await get('/api/state', { method: 'HEAD', headers: API })).body).toBe('')
})

it('is served only under loopback and the allowlisted names', async () => {
  expect((await get('/', { headers: { host: 'evil.example.test' } })).status).toBe(403)
  expect((await get('/', { headers: { host: '127.0.0.1.evil.example.test:80' } })).status).toBe(403)
  for (const host of [`localhost:${dashboard.port}`, '[::1]:8080', 'workbench.example.test', 'WORKBENCH.example.test:443']) {
    expect((await get('/', { headers: { host } })).status).toBe(200)
  }
  expect(allowedHost(undefined)).toBe(false)
  expect(allowedHost('127.0.0.1:25410')).toBe(true)
  expect(allowedHost('a b')).toBe(false)
})

it('takes a Host only when the whole of it is a name or [address] with an optional port', async () => {
  for (const host of ['[::1]', '[::1]:25410', 'localhost', 'LOCALHOST:80', '127.0.0.1:1']) expect(allowedHost(host), host).toBe(true)
  for (const host of ['[::1]evil.example.test', '[::1]evil.example.test:80', '[::1]:80:80', '[::1]:', 'localhost:', 'localhost:80:80', 'localhost:port',
    '::1', '[::1', 'evil.example.test[::1]', 'localhost evil.example.test', 'localhost,evil.example.test', '']) {
    expect(allowedHost(host), host).toBe(false)
  }
  expect(allowedHost('[::1]evil.example.test', ['evil.example.test'])).toBe(false)
  expect((await get('/', { headers: { host: '[::1]evil.example.test' } })).status).toBe(403)
})

it('answers the API only to the page\'s own requests, redacted, with an ETag', async () => {
  expect((await get('/api/state')).status).toBe(403)
  const state = await get('/api/state', { headers: API })
  expect(state.status).toBe(200)
  expect(state.headers['cache-control']).toBe('no-store')
  expect(JSON.parse(state.body)).toEqual({ jobs: [], note: 'token [REDACTED]' })
  const again = await get('/api/state', { headers: { ...API, 'if-none-match': state.headers.etag as string } })
  expect(again).toMatchObject({ status: 304, body: '' })
  // A proxy that compresses the answer makes the tag weak, and a client may send several.
  const etag = state.headers.etag as string
  for (const sent of [`W/${etag}`, `"other", W/${etag}`, `"a","b" , ${etag}`, '*']) {
    expect(await get('/api/state', { headers: { ...API, 'if-none-match': sent } }), sent).toMatchObject({ status: 304, body: '' })
  }
  for (const sent of ['"other"', 'W/"other", "another"', etag.slice(1, -1), '']) {
    expect((await get('/api/state', { headers: { ...API, 'if-none-match': sent } })).status, sent).toBe(200)
  }
  expect(etagMatches(undefined, etag)).toBe(false)
  expect(JSON.parse((await get('/api/jobs/job_1/attempts/job_1.a2/trace', { headers: API })).body)).toEqual({ sessionId: 'wb-job_1.a2', steps: [] })
  expect((await get('/api/jobs/nope', { headers: API })).status).toBe(404)
  expect((await get('/api/nothing', { headers: API })).status).toBe(404)
  const broken = await get('/api/inbox', { headers: API })
  expect(broken.status).toBe(500)
  expect(broken.body).not.toContain('sk-dashboard-secret')
})

it('serves its files from a fixed map, and the page with a strict CSP for any other path', async () => {
  const script = await get('/assets/app.js')
  expect(script).toMatchObject({ status: 200, body: 'console.log(1)' })
  expect(script.headers['content-type']).toContain('text/javascript')
  expect(script.headers['x-content-type-options']).toBe('nosniff')
  expect((await get('/assets/fonts/onest.woff2')).headers['content-type']).toBe('font/woff2')
  for (const path of ['/assets/secret.txt', '/assets/missing.js']) {
    expect((await get(path)).status).toBe(404)
  }
  // A dot segment is resolved before routing: `/secret.txt` is a page path, and the file never leaves the directory.
  for (const path of ['/assets/../secret.txt', '/assets/%2e%2e/secret.txt', '/assets/..%2fsecret.txt', '/../secret.txt']) expect((await get(path)).body).not.toContain('not served')
  for (const path of ['/', '/jobs/job_1', '/jobs/job_1/network', '/secret.txt']) {
    const page = await get(path)
    expect(page.status).toBe(200)
    expect(page.body).toContain('<div id="root">')
    expect(page.headers['content-security-policy']).toBe(CSP)
    expect(page.headers['referrer-policy']).toBe('no-referrer')
  }
})

describe('settings from the environment', () => {
  it('listens on loopback port 25410 by default, takes a port, extra names, or off', () => {
    expect(dashboardEnv({})).toEqual({ host: '127.0.0.1', port: 25410, hosts: [] })
    expect(dashboardEnv({ WORKBENCH_DASHBOARD_HOST: '0.0.0.0', WORKBENCH_DASHBOARD_PORT: '25409', WORKBENCH_DASHBOARD_HOSTS: 'Dash.Example.test, ,x.test' }))
      .toEqual({ host: '0.0.0.0', port: 25409, hosts: ['dash.example.test', 'x.test'] })
    expect(dashboardEnv({ WORKBENCH_DASHBOARD_PORT: 'off' })).toBeUndefined()
    expect(() => dashboardEnv({ WORKBENCH_DASHBOARD_PORT: 'eighty' })).toThrow(/port number/)
  })
})

it('says the page is not built when its files are missing', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'dashboard-empty-'))
  const bare = await startDashboard({ host: '127.0.0.1', port: 0, assets: empty, routes: {} as Routes, ready: async () => {}, secrets: () => [] })
  try {
    const page = await new Promise<string>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port: bare.port, path: '/', headers: { host: 'localhost' } }, res => {
        let body = ''; res.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => resolve(body))
      }).on('error', reject).end()
    })
    expect(page).toContain('pnpm build')
  } finally {
    await bare.close()
    rmSync(empty, { recursive: true, force: true })
  }
})
