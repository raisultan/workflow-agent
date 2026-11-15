/** `jira_transition_issue` accepts a transition id or a transition or status name, resolved against the issue's own transitions. */
import { describe, expect, it } from 'vitest'
import { JiraConnector } from '../src/sources/jira.ts'

interface Fixture { calls: { method: string; path: string; body?: unknown }[]; jira: JiraConnector }

function fixture(options: { status?: string; transitions?: { id: string; name: string; to: { name: string } }[] } = {}): Fixture {
  const calls: Fixture['calls'] = []
  const transitions = options.transitions ?? [
    { id: '11', name: 'Start work', to: { name: 'В работе' } },
    { id: '12', name: 'Send to review', to: { name: 'На ревью' } },
  ]
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    calls.push({ method, path: `${url.pathname}${url.search}`, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (method === 'GET' && url.pathname.endsWith('/transitions')) return new Response(JSON.stringify({ transitions }), { status: 200 })
    if (method === 'GET' && url.pathname.includes('/issue/')) return new Response(JSON.stringify({ fields: { status: { name: options.status ?? 'Backlog' } } }), { status: 200 })
    return new Response(null, { status: 204 })
  }
  return {
    calls,
    jira: new JiraConnector({ baseUrl: 'https://jira.example.test', auth: { kind: 'bearer', token: 'tok' }, fetchImpl, maxRetries: 0 }),
  }
}
const transition = (f: Fixture, transitionId: string) => f.jira.moveIssue('PAY-1', transitionId)
const posts = (f: Fixture) => f.calls.filter(call => call.method === 'POST')

describe('Jira transitions by id or name', () => {
  it('posts a numeric id as it is, without listing the issue\'s transitions', async () => {
    const f = fixture()
    await transition(f, '31')
    expect(posts(f)).toEqual([{ method: 'POST', path: '/rest/api/2/issue/PAY-1/transitions', body: { transition: { id: '31' } } }])
    expect(f.calls.some(call => call.method === 'GET')).toBe(false)
  })

  it('resolves a status name (any case, Cyrillic included) and a transition name to the issue\'s own transition id', async () => {
    const byStatus = fixture()
    await transition(byStatus, 'в РАБОТЕ')
    expect(posts(byStatus)[0]!.body).toEqual({ transition: { id: '11' } })
    const byName = fixture()
    await transition(byName, 'send to review')
    expect(posts(byName)[0]!.body).toEqual({ transition: { id: '12' } })
  })

  it('leaves an issue that is already in the named status as it is', async () => {
    const f = fixture({ status: 'В работе', transitions: [{ id: '12', name: 'Send to review', to: { name: 'На ревью' } }] })
    const result = await transition(f, 'В работе')
    expect(result).toEqual({ moved: false })
    expect(posts(f)).toEqual([])
  })

  it('fails with the available transitions when no transition or status has the name, and posts nothing', async () => {
    const f = fixture()
    await expect(transition(f, 'Готово')).rejects.toThrow(/no transition or status named "Готово".*11: Start work → В работе; 12: Send to review → На ревью/u)
    expect(posts(f)).toEqual([])
  })

  it('refuses an ambiguous name instead of guessing', async () => {
    const f = fixture({ transitions: [
      { id: '11', name: 'Done', to: { name: 'Closed' } },
      { id: '12', name: 'Finish', to: { name: 'Done' } },
    ] })
    await expect(transition(f, 'done')).rejects.toThrow(/ambiguous \(ids 11, 12\)/u)
    expect(posts(f)).toEqual([])
  })
})
