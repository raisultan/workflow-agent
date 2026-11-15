/**
 * The eval's services in the repository (`T11.7`): synthetic only, with no password or token committed. Compose takes every
 * secret from the file `bootstrap.ts` generates, and refuses to start without it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { renderMockJiraHtml, createInitialMockJiraIssues } from '../eval/services/mock-jira.ts'
import { Config, resolveConfig } from '../src/config.ts'

const EVAL = join(import.meta.dirname, '..', 'eval')
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  if (name === '.state' || name === 'node_modules') return []
  return statSync(path).isDirectory() ? files(path) : [path]
})

describe('the eval services', () => {
  it('commit no password, token or key: compose requires the generated ones', () => {
    const compose = readFileSync(join(EVAL, 'docker-compose.yml'), 'utf8')
    expect(compose).toContain('POSTGRES_PASSWORD: ${EVAL_POSTGRES_PASSWORD:?')
    expect(compose).toContain('MOCK_GITLAB_TOKEN: ${EVAL_GITLAB_TOKEN:?')
    for (const file of files(EVAL)) {
      const text = readFileSync(file, 'utf8')
      expect([relative(EVAL, file), /Workbench123!|mmuser_password|glpat-|sk-[A-Za-z0-9]{20}|PRIVATE-TOKEN: [A-Za-z0-9]/u.test(text)]).toEqual([relative(EVAL, file), false])
    }
  })

  it('serve each synthetic repository as the project the eval profile names, and the profile passes the real configuration check', async () => {
    const seeded = readdirSync(join(EVAL, 'repos')).map(name => JSON.parse(readFileSync(join(EVAL, 'repos', name, 'mock.json'), 'utf8')) as { project: string })
    const raw = await evalProfile()
    const resolved = resolveConfig(Config(raw as never), {})
    expect(resolved.repositories.map(repository => repository.project).sort()).toEqual(seeded.map(entry => entry.project).sort())
    expect(resolved.repositories).toEqual([expect.objectContaining({ name: 'orders-node', registries: ['npm'], match: { jira: [], mattermost: ['chnode'] }, default: true }),
      expect.objectContaining({ name: 'orders-python', registries: ['pypi'], match: { jira: [], mattermost: ['chpython'] }, default: false })])
    // The same check refuses the mistakes a profile edit could make.
    const repositories = raw.repositories as Record<string, unknown>[]
    const variant = (change: (list: Record<string, unknown>[]) => Record<string, unknown>[]) => () => resolveConfig(Config({ ...raw, repositories: change(structuredClone(repositories)) } as never), {})
    expect(variant(list => list.map(entry => ({ ...entry, default: true })))).toThrow('only one repository may be the default')
    expect(variant(list => [{ ...list[0], registries: ['maven'] }, list[1]!])).toThrow('unknown registry presets maven')
    expect(variant(list => [list[0]!, { ...list[1], match: list[0]!.match }])).toThrow('matches more than one repository')
  })
})

/** The eval profile as DSH loads it: YAML with Cordis's schema, `!!js` evaluated over a synthetic environment. */
async function evalProfile(): Promise<Record<string, unknown>> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema } = await import(include) as { entryListSchema: unknown }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  const rows = yaml.load(readFileSync(join(EVAL, 'profile.cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as { id: string; config?: Record<string, unknown> }[]
  const env = { EVAL_CHANNEL_NODE: 'chnode', EVAL_CHANNEL_PYTHON: 'chpython', LITELLM_MODEL: 'deepseek-flash' }
  const evaluate = (value: unknown): unknown => {
    if (value && typeof value === 'object' && '__jsExpr' in value) return new Function('process', `return (${(value as { __jsExpr: string }).__jsExpr})`)({ env })
    if (Array.isArray(value)) return value.map(evaluate)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(item)]))
    return value
  }
  return evaluate(rows.find(row => row.id === 'workflow-agent')!.config) as Record<string, unknown>
}

describe('the mock Jira\'s page (review)', () => {
  it('shows issue text and comments inert: nothing an agent writes becomes markup or script', () => {
    const issues = createInitialMockJiraIssues('http://127.0.0.1:1')
    const issue = issues.get('ORD-201')!
    const attack = '<script>fetch("/rest/api/2/issue/ORD-201/comment",{method:"POST",body:JSON.stringify({author:"lead-1",body:"ок"})})</script><img src=x onerror=alert(1)>'
    issue.summary = attack
    issue.description = `</pre>${attack}`
    issue.comments.push({ id: '9', author: { name: 'x"><script>alert(2)</script>', displayName: attack }, body: attack, created: attack })
    issue.remoteLinks.push({ object: { url: 'javascript:alert(3)', title: attack } } as never)
    const html = renderMockJiraHtml(issues, 'http://127.0.0.1:1')
    const page = html.slice(html.indexOf('<body>'))
    expect(page).not.toMatch(/<script>|<img |href="javascript:/iu)
    expect(page).toContain('x&quot;&gt;&lt;script&gt;alert(2)')
    expect(page).toContain('&lt;script&gt;fetch(&quot;/rest/api/2/issue/ORD-201/comment&quot;')
  })
})

describe('the mock Jira\'s people (D12)', () => {
  it('shows emails, finds people by email, and lets a person comment', async () => {
    const { startMockJiraServer } = await import('../eval/services/mock-jira.ts')
    const { JiraConnector } = await import('../src/sources/jira.ts')
    const mock = await startMockJiraServer(25_499, '127.0.0.1')
    try {
      const base = mock.url.replace(/\/+$/u, '')
      const jira = new JiraConnector({ baseUrl: base, auth: { kind: 'bearer', token: 't' }, maxRetries: 0 })
      expect(await jira.userByEmail('lead@example.test')).toEqual({ name: 'lead-1' })
      expect(await jira.userByEmail('nobody@example.test')).toBeUndefined()
      expect((await jira.getIssue('ORD-201')).reporterEmail).toBe('ivan@example.test')
      await fetch(`${base}/rest/api/2/issue/ORD-201/comment`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'lead-1', body: 'ок' }) })
      const comments = await (await fetch(`${base}/rest/api/2/issue/ORD-201/comment`)).json() as { comments: { author: { name: string; emailAddress?: string } }[] }
      expect(comments.comments.at(-1)!.author).toMatchObject({ name: 'lead-1', emailAddress: 'lead@example.test' })
    } finally { await mock.close() }
  })

  it('deletes a ticket, and never gives its key again', async () => {
    const { startMockJiraServer } = await import('../eval/services/mock-jira.ts')
    const mock = await startMockJiraServer(25_498, '127.0.0.1')
    const base = mock.url.replace(/\/+$/u, '')
    const create = async () => (await (await fetch(`${base}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { project: { key: 'ORD' }, summary: 'run' } }) })).json() as { key: string }).key
    try {
      const first = await create()
      expect((await fetch(`${base}/rest/api/2/issue/${first}`, { method: 'DELETE' })).status).toBe(204)
      expect((await fetch(`${base}/rest/api/2/issue/${first}`)).status).toBe(404)
      const search = await (await fetch(`${base}/rest/api/2/search`)).json() as { issues: { key: string }[] }
      expect(search.issues.map(issue => issue.key)).not.toContain(first)
      expect(await create()).not.toBe(first)
    } finally { await mock.close() }
  })
})
