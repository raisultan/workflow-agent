/** Markdown to Jira wiki markup (`D12`, `T14.6`). */
import { describe, expect, it } from 'vitest'
import { toJiraMarkup } from '../src/infra/jira-markup.ts'
import { JiraConnector } from '../src/sources/jira.ts'

describe('toJiraMarkup', () => {
  it('converts a plan', () => {
    const plan = [
      '### 📋 Технический план (ORD-1)',
      '#### 1. Причина и контекст',
      'Нужен **фильтр** по `status` и *пагинация*, см. [доку](https://example.test/doc).',
      '- первый пункт',
      '  - вложенный',
      '1. шаг один',
      '2. шаг два',
      '> цитата',
      '---',
      '| Файл | Что |',
      '| --- | --- |',
      '| `api.py` | новый маршрут |',
      '```python',
      'def f(x): return x ** 2  # **not bold**',
      '```',
    ].join('\n')
    expect(toJiraMarkup(plan)).toBe([
      'h3. 📋 Технический план (ORD-1)',
      'h4. 1. Причина и контекст',
      'Нужен *фильтр* по {{status}} и _пагинация_, см. [доку|https://example.test/doc].',
      '* первый пункт',
      '** вложенный',
      '# шаг один',
      '# шаг два',
      'bq. цитата',
      '----',
      '||Файл||Что||',
      '|{{api.py}}|новый маршрут|',
      '{code:python}',
      'def f(x): return x ** 2  # **not bold**',
      '{code}',
    ].join('\n'))
  })

  it('leaves plain text, and closes an unclosed code block', () => {
    expect(toJiraMarkup('ok, 2 * 3 = 6')).toBe('ok, 2 * 3 = 6')
    expect(toJiraMarkup('```\nx')).toBe('{code}\nx\n{code}')
  })
})

describe('Jira comments', () => {
  it('are posted as Jira markup, and found again by their Markdown', async () => {
    const posted: string[] = []
    const jira = new JiraConnector({ baseUrl: 'https://jira.example.test', auth: { kind: 'bearer', token: 't' }, maxRetries: 0,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        if (init?.method === 'POST') { posted.push((JSON.parse(String(init.body)) as { body: string }).body); return new Response(JSON.stringify({ id: 7, created: '2026-11-13T10:00:00.000Z' }), { status: 201 }) }
        return new Response(JSON.stringify({ comments: posted.map((body, index) => ({ id: index + 7, body, created: '2026-11-13T10:00:00.000Z' })) }), { status: 200 })
      }) as typeof fetch })
    await jira.postComment('ORD-1', '### План\n- **шаг**')
    expect(posted).toEqual(['h3. План\n* *шаг*'])
    expect(await jira.findComment('ORD-1', '### План\n- **шаг**')).toMatchObject({ id: '7' })
  })
})
