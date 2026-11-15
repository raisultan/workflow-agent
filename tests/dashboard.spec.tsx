// @vitest-environment jsdom
/**
 * The dashboard's page (`D13`, `T15.5`–`T15.8`), rendered from the synthetic fixture: jobs grouped by who must act, what each waits
 * for and where (`A3`), any workflow's stages (`A6`), a job's "Now" sentence, its activity newest first with the agent's trace and the
 * JSON of every event, its other tabs at their own addresses, the inbox, health and settings; every request a marked `GET`; what a
 * review says for people (`P16`): the merge risk, its notes and the findings' severities; the workbench's own posts as Markdown.
 */
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/client/shell.tsx'
import { en, ru, translator } from '../src/client/locales.ts'
import { jsonTokens } from '../src/client/json.tsx'
import { ApiError, get } from '../src/client/api.ts'
import { day, duration, tokens, when } from '../src/client/format.ts'
import { whyIgnored } from '../src/client/views/inbox.tsx'
import { matchPath } from '../src/client/router.tsx'
import { diffLines } from '../src/client/job/steps.tsx'
import { Markdown } from '../src/client/job/markdown.tsx'
import { refusalReason } from '../src/client/job/feed.ts'
import { waitingWho } from '../src/client/status.tsx'
import { dashboardFixture, type DashboardFixture } from './fixtures/dashboard.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement
let data: DashboardFixture
let down = false
/** Per test: answers a request itself (an error, a page that is not JSON, a slow answer), or returns undefined to serve the fixture. */
let intercept: ((url: string) => Response | Promise<Response> | undefined) | undefined
const calls: { url: string; method: string; marked: boolean }[] = []

function serve(url: string): { status: number; body: unknown } {
  const path = url.replace(/^\/api\//u, '')
  const job = /^jobs\/([^/]+)$/u.exec(path), trace = /^jobs\/([^/]+)\/attempts\/([^/]+)\/trace$/u.exec(path)
  if (path === 'state') return { status: 200, body: data.state }
  if (path === 'inbox') return { status: 200, body: data.inbox }
  if (path === 'settings') return { status: 200, body: data.settings }
  if (trace) {
    const attempt = data.details[decodeURIComponent(trace[1]!)]?.attempts.find(candidate => candidate.id === decodeURIComponent(trace[2]!))
    return attempt ? { status: 200, body: data.traces[attempt.sessionId] ?? { sessionId: attempt.sessionId, steps: [], unavailable: { reason: 'missing', detail: '' } } } : { status: 404, body: { error: 'No attempt' } }
  }
  if (job) { const detail = data.details[decodeURIComponent(job[1]!)]; return detail ? { status: 200, body: detail } : { status: 404, body: { error: 'No job' } } }
  return { status: 404, body: { error: 'Unknown operation' } }
}

beforeEach(() => {
  data = dashboardFixture(Date.now())
  down = false
  intercept = undefined
  calls.length = 0
  localStorage.clear()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    calls.push({ url, method: init.method ?? 'GET', marked: headers.get('x-workbench-dashboard') === '1' })
    if (down) throw new TypeError('fetch failed')
    const own = intercept?.(url)
    if (own) return own
    const { status, body } = serve(url)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
})

async function settle(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function open(path: string): Promise<void> {
  window.history.replaceState(null, '', path)
  root = createRoot(container)
  await act(async () => { root!.render(<App />) })
  await settle()
}
const text = () => container.textContent ?? ''
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => { (element as HTMLElement).click() })
  await settle()
}
const button = (label: string) => [...container.querySelectorAll('button, a, [role="button"]')].find(element => element.textContent?.trim().startsWith(label))

describe('the dictionaries', () => {
  it('cover the same words in Russian and English, none empty, and fill placeholders', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort())
    expect(Object.entries(ru).filter(([, value]) => !value.trim())).toEqual([])
    expect(translator('ru')('live.updated', { n: 3 })).toBe('обновлено 3 с назад')
    expect(translator('en')('showAll', { n: 170 })).toBe('Show all · 170')
  })
})

describe('the jobs list', () => {
  it('groups jobs by who must act, longest wait first, and says what each waits for, from whom and where', async () => {
    await open('/')
    const groups = [...container.querySelectorAll('.gh')].map(heading => heading.textContent)
    expect(groups.map(group => group?.replace(/\d+.*$/u, ''))).toEqual(['Ждут людей', 'Идут', 'Завершены'])
    const rows = [...container.querySelectorAll('.row')]
    expect(rows.map(row => row.querySelector('.c-key')?.textContent).slice(0, 5)).toEqual(['ORD-298', 'ORD-309', 'ORD-312', 'без тикета', 'ORD-305'])
    const first = rows[0]!
    expect(first.querySelector('.c-wait')?.textContent).toBe('lead-1 · решение: проверкиM')
    expect(first.querySelector('.c-age')?.className).toContain('old')
    expect(rows.find(row => row.textContent?.includes('ORD-305'))?.querySelector('.c-tok')?.className).toContain('over')
    // A second workflow's own stages (`A6`).
    expect(rows.find(row => row.textContent?.includes('HOT-17'))?.querySelector('.c-stage')?.textContent).toBe('Исправление')
    expect(text()).toContain('Токенов сегодня')
    expect(text()).toContain('jira: Jira polling failed 3 times')
  })

  it('filters by the address (problems, a repository) and by search, and opens a job on Enter', async () => {
    await open('/?filter=problems')
    expect([...container.querySelectorAll('.row .c-key')].map(cell => cell.textContent)).toEqual(['ORD-298', 'ORD-305', 'ORD-286'])
    act(() => { root!.unmount() })
    await open('/?repo=billing-api')
    expect([...container.querySelectorAll('.row .c-key')].map(cell => cell.textContent)).toEqual(['ORD-305'])
    act(() => { root!.unmount() })
    await open('/')
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'flaky')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(text()).toContain('Ничего не найдено')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'anna')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...container.querySelectorAll('.row .c-key')].map(cell => cell.textContent)).toEqual(['ORD-305', 'HOT-17'])
    const row = container.querySelector<HTMLElement>('.row')!
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await settle()
    expect(window.location.pathname).toBe('/jobs/job_0mwh9bill305')
  })

  it('shows the first 20 finished jobs of 200, and an empty workbench\'s first steps', async () => {
    data = dashboardFixture(Date.now(), { many: true })
    await open('/')
    expect(container.querySelectorAll('.row').length).toBeLessThan(200)
    await click(button('Показать все'))
    expect(container.querySelectorAll('.row').length).toBe(200)
    act(() => { root!.unmount() })
    data = dashboardFixture(Date.now(), { empty: true })
    await open('/')
    expect(text()).toContain('Задач пока нет')
    expect(text()).toContain('@workbench сделай ORD-123')
  })
})

describe('a job', () => {
  it('says now what a blocked job needs, from whom and where, and lists its stages with visits', async () => {
    await open('/jobs/job_0mwf3x5c40000p5ly4m')
    const now = container.querySelector('.callout')!.textContent!
    expect(now).toContain('проверки ci не смогли выполниться')
    expect(now).toContain('lead-1')
    expect(container.querySelector('.callout a')?.getAttribute('href')).toBe('https://chat.example.test/_redirect/pl/fpfb7y18u7b3ibr6tkzkfdagah')
    expect([...container.querySelectorAll('.step')].map(step => step.textContent)).toEqual(['Анализ требований×1', 'План реализации×1', 'Реализация и MR×1', 'Ревью MR'])
    expect(text()).toContain('ждём здесь')
  })

  it('says now what an approval, a question round, a parked and a cancelled job wait for or ended with', async () => {
    const cases: [string, string][] = [['job_0mwg11aa0000ord312', 'Ждёт, пока lead-1 одобрит план r2 в'], ['job_0mwh2dm7f3', 'Ждёт ответов на вопросы (1/3) в'], ['job_0mwh2dm7f3', 'ответить может любой в треде'],
      ['job_0mwe1done290', 'Завершена: merge request влит.'],
      ['job_0mwh0park309', 'Отложена: нет standard-delivery@6'], ['job_0mwf3x5bc0000ord307', 'Отменена lead-1: «стоп»']]
    for (const [id, expected] of cases) {
      await open(`/jobs/${id}`)
      expect(container.querySelector('.callout')!.textContent).toContain(expected)
      act(() => { root!.unmount() })
    }
  })

  it('tells the story newest first, filters it, reverses it, and keeps the choice', async () => {
    await open('/jobs/job_0mwf3x5c40000p5ly4m')
    const headings = () => [...container.querySelectorAll('.visit-h .vt')].map(heading => heading.textContent)
    expect(headings()).toEqual(['Реализация и MR', 'План реализации', 'Анализ требований', 'Начало'])
    await click(button('Сначала новые'))
    expect(headings()).toEqual(['Начало', 'Анализ требований', 'План реализации', 'Реализация и MR'])
    expect(localStorage.getItem('awb.newest')).toBe('0')
    await click(button('Агент'))
    expect(container.querySelectorAll('.acard').length).toBe(4)
    expect(text()).not.toContain('ок, согласовано')
    await click(button('Люди'))
    expect(text()).toContain('ок, согласовано')
    expect(text()).toContain('не учтено: нет права одобрять')
  })

  it('reads an attempt\'s agent trace on demand: what it said, ran, edited and reported', async () => {
    await open('/jobs/job_0mwf3x5c40000p5ly4m')
    const card = [...container.querySelectorAll('.acard')].find(element => element.textContent?.includes('попытка 2'))!
    expect(card.textContent).toContain('tests')
    expect(card.textContent).toContain('ci')
    await click([...card.querySelectorAll('button')].find(element => element.textContent?.includes('Ход работы агента')))
    const steps = [...card.querySelectorAll('.tr')]
    expect(steps.length).toBe(15)
    expect(steps[0]!.textContent).toContain('Ход завершён')
    expect(card.textContent).toContain('$ python -m pytest -q')
    expect(card.textContent).toContain('export/amounts.py+1−1')
    expect(card.textContent).toContain('currency_code с подстановкой RUB')
    expect(card.textContent).toContain('registry.npmjs.org is not on this job\'s allowlist')
    expect(calls.some(call => call.url.endsWith('/attempts/job_0mwf3x5c40000p5ly4m.a4/trace'))).toBe(true)
  })

  it('shows a running attempt\'s command as still running', async () => {
    await open('/jobs/job_0mwh5run301')
    await click([...container.querySelectorAll('.acard button')].find(element => element.textContent?.includes('Ход работы агента') && element.closest('.acard')?.textContent?.includes('идёт')))
    expect(text()).toContain('выполняется')
  })

  it('opens any event\'s JSON in a drawer, pretty-printed, and closes it with Escape', async () => {
    await open('/jobs/job_0mwf3x5c40000p5ly4m')
    const drawer = () => container.ownerDocument.querySelector('.drawer')!
    expect(drawer().hasAttribute('hidden')).toBe(true)
    await click(container.querySelector('.it .jbtn'))
    expect(drawer().hasAttribute('hidden')).toBe(false)
    // Newest first, the first item is the workbench's last post: its JSON is the post as sent.
    expect(drawer().getAttribute('aria-label')).toBe('post · resume')
    expect([...drawer().querySelectorAll('.jk')].map(key => key.textContent)).toEqual(['"id":', '"at":', '"threadKey":', '"status":', '"kind":', '"text":', '"recorded":'])
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(drawer().hasAttribute('hidden')).toBe(true)
  })

  it('has a tab at its own address for conversations, artifacts, network and details', async () => {
    await open('/jobs/job_0mwf3x5c40000p5ly4m/network')
    expect(container.querySelector('.tabs a[aria-current="page"]')?.textContent).toMatch(/^Сеть/u)
    const hosts = [...container.querySelectorAll('tbody tr td:first-child')].map(cell => cell.textContent)
    expect(hosts.slice(0, 2).sort()).toEqual(['pypi-mirror.corp.internal:443', 'registry.npmjs.org:443'])
    await click(container.querySelector('.tabs a[href$="/artifacts"]'))
    expect(window.location.pathname).toBe('/jobs/job_0mwf3x5c40000p5ly4m/artifacts')
    expect([...container.querySelectorAll('.doc h4')].map(heading => heading.textContent)).toContain('Цель')
    await click(container.querySelector('.tabs a[href$="/conversations"]'))
    expect(container.querySelectorAll('.thread').length).toBe(2)
    await click(container.querySelector('.tabs a[href$="/details"]'))
    expect(text()).toContain('Манифест запуска')
    expect(text()).toContain('CheckCompleted')
  })
})

describe('the other views', () => {
  it('lists the inbox with what each message became or why it was ignored', async () => {
    await open('/inbox')
    // The router's reasons and the engine's outcomes in the viewer's language; one this page does not know, as written.
    expect(text()).toContain('отправителю нельзя запускать задачи')
    expect(text()).toContain('нет репозитория с именем "s14b131416"')
    expect(text()).toContain('собственное сообщение workbench')
    expect(text()).toContain('передано задаче')
    expect(text()).toContain('not a workbench job')
    expect(container.querySelector('.segm[aria-label="Источник"]')).toBeTruthy()
    expect(container.querySelector('.inr a[href="/jobs/job_0mwf3x5bc0000ord307"]')?.textContent).toBe('ORD-307 →')
    await click(button('Пропущено'))
    expect(container.querySelectorAll('.inr').length).toBe(5)
  })

  it('shows health with zero counts dimmed and the kernel\'s last error, and settings as read only', async () => {
    await open('/health')
    expect(container.querySelectorAll('td.zero').length).toBeGreaterThan(5)
    expect(text()).toContain('SQLITE_BUSY')
    act(() => { root!.unmount() })
    await open('/settings')
    expect(text()).toContain('Только чтение')
    expect(text()).toContain('Аппруверы orders-api')
    expect(container.querySelectorAll('input, textarea, select, form').length).toBe(0)
  })

  it('switches the language and the theme, and remembers both', async () => {
    await open('/')
    await click(container.querySelector('.side .pbtn'))
    expect(text()).toContain('Needs people')
    expect(localStorage.getItem('awb.lang')).toBe('en')
    await click(container.querySelectorAll('.side .pbtn')[1])
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('keeps the last data and says so when the workbench stops answering', async () => {
    await open('/')
    down = true
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    expect(text()).toContain('Workbench не отвечает')
    expect(container.querySelectorAll('.row').length).toBeGreaterThan(5)
  })

  it('only reads: every request is a GET marked as the page\'s own', async () => {
    await open('/jobs/job_0mwf3x5c40000p5ly4m')
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every(call => call.method === 'GET' && call.marked && call.url.startsWith('/api/'))).toBe(true)
  })
})

describe('helpers', () => {
  it('match addresses, colour JSON, and draw an edit as a diff', () => {
    expect(matchPath('/jobs/:id/:tab?', '/jobs/job_1')).toEqual({ id: 'job_1' })
    expect(matchPath('/jobs/:id/:tab?', '/jobs/job_1/network')).toEqual({ id: 'job_1', tab: 'network' })
    expect(matchPath('/jobs/:id/:tab?', '/inbox')).toBeUndefined()
    expect(jsonTokens({ a: 1, b: 'x', c: null }).filter(token => token.kind).map(token => `${token.kind}:${token.text}`)).toEqual(['jk:"a":', 'jn:1', 'jk:"b":', 'js:"x"', 'jk:"c":', 'jl:null'])
    expect(diffLines([{ old: 'a\nb', new: 'c' }])).toEqual([{ kind: 'del', text: '-a' }, { kind: 'del', text: '-b' }, { kind: 'add', text: '+c' }])
    // Anyone in the thread answers a question round where the workflow has places, the allowed senders elsewhere; `*` is any allowed
    // sender, not anyone; an approval with no approver known yet waits on nobody named.
    const t = translator('en'), base = { subject: null, thread: null, since: 0 }
    expect(waitingWho(t, { ...base, kind: 'question', who: [] })).toBe('anyone in the thread')
    expect(waitingWho(t, { ...base, kind: 'question', who: ['*'] })).toBe('any allowed sender')
    expect(waitingWho(t, { ...base, kind: 'approval', who: ['*'] })).toBe('any allowed sender')
    expect(waitingWho(t, { ...base, kind: 'approval', who: ['dev-ivan', 'lead-1', '*'] })).toBe('dev-ivan, lead-1, any allowed sender')
    expect(waitingWho(translator('ru'), { ...base, kind: 'resume', who: ['*'] })).toBe('любой разрешённый отправитель')
    expect(waitingWho(t, { ...base, kind: 'approval', who: [] })).toBe('—')
    expect(waitingWho(t, { ...base, kind: 'approval', who: ['ir4hha1ut7rofm1ust7qtj11fe'] })).toBe('ir4hha1ut7rofm1ust7qtj11fe')
  })
})

describe('formatting', () => {
  it('never shows 1000k or 60 s, and shows the day of what ended before today', () => {
    expect([999, 1000, 96_400, 999_499, 999_500, 1_000_000, 1_234_000].map(tokens)).toEqual(['999', '1k', '96k', '999k', '1M', '1M', '1.23M'])
    expect([800, 9940, 9990, 42_000, 59_400, 59_500, 59_990, 60_000, 125_000].map(ms => duration(ms, 'en'))).toEqual(['0.8 s', '9.9 s', '10 s', '42 s', '59 s', '1m', '1m', '1m', '2m'])
    expect(duration(59_990, 'ru')).toBe('1 мин')
    const now = new Date(2026, 10, 14, 12, 0).getTime()
    expect(when(now - 3600_000, 'ru', now)).toBe('11:00')
    expect(when(now - 4 * 86_400_000, 'ru', now)).toBe('10 ноя')
    expect(when(now - 4 * 86_400_000, 'en', now)).toBe(day(now - 4 * 86_400_000, 'en', now))
    expect(when(new Date(2025, 11, 31, 23, 0).getTime(), 'en', now)).toBe('31 Dec 2025')
  })

  it('says why a message was ignored in the viewer\'s language, with the router\'s names in place', () => {
    const t = translator('ru')
    expect(whyIgnored(t, 'repo:billing-api contradicts this thread\'s repository orders-api')).toBe('repo:billing-api противоречит репозиторию этого треда (orders-api)')
    expect(whyIgnored(t, 'the sender may not start jobs on billing-api')).toBe('отправителю нельзя запускать задачи в billing-api')
    expect(whyIgnored(t, 'orders-api has no Mattermost channel for the job\'s questions')).toBe('у orders-api нет канала Mattermost для вопросов задачи')
    expect(whyIgnored(t, 'the trigger names no Jira ticket for the plan')).toBe('в запросе нет тикета Jira для плана')
    expect(whyIgnored(translator('en'), 'no verified actor')).toBe('no verified author')
    expect(whyIgnored(t, 'something a newer router says')).toBe('something a newer router says')
  })

  it('says треды for threads everywhere in Russian', () => {
    expect(Object.entries(ru).filter(([key, value]) => /ветк/iu.test(value) && key !== 'settings.col.branch')).toEqual([])
  })
})

describe('what the review found', () => {
  const poll = async () => { await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await settle() }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const jobsOf = () => (data.state as unknown as { jobs: { id: string; ticket: string | null; status: string; updatedAt: number; stages: unknown; waiting: { since: number } | null }[] }).jobs

  it('shows the day, not the hour, of a job that finished before today', async () => {
    const done = jobsOf().find(job => job.status === 'completed')!
    done.updatedAt = Date.now() - 3 * 86_400_000
    await open('/?filter=finished')
    const row = [...container.querySelectorAll('.row')].find(element => element.textContent?.includes(done.ticket!))!
    expect(row.querySelector('.c-age')?.textContent).toBe(day(done.updatedAt, 'ru'))
    expect(row.querySelector('.c-age')?.textContent).toMatch(/^\d+ \S+$/u)
    // A completed job says how it ended in the viewer's language; a failed one keeps its reason as written.
    expect(row.querySelector('.c-wait')?.textContent).toBe('Завершена · merge request влит')
    expect(text()).toContain('the model provider returned 429')
  })

  it('keeps the navigation when a view throws, shows the error, and starts afresh at another address', async () => {
    // React reports the view's error to the console and to the window; the test expects it.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const expected = (event: ErrorEvent) => { event.preventDefault() }
    window.addEventListener('error', expected)
    jobsOf()[0]!.stages = null
    await open('/')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Не удалось показать эту страницу.')
    expect(container.querySelector('[role="alert"] .mono')?.textContent).toMatch(/null|undefined/u)
    expect(container.querySelectorAll('.row').length).toBe(0)
    await click(container.querySelector('.side a[href="/inbox"]'))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelectorAll('.inr').length).toBe(9)
    errors.mockRestore()
    window.removeEventListener('error', expected)
  })

  it('refuses an answer that is not JSON, and shows a failed request instead of loading for ever', async () => {
    await expect(get('GET settings', {}, async () => new Response('<html>Sign in</html>', { status: 200 }))).rejects.toBeInstanceOf(ApiError)
    await expect(get('GET settings', {}, async () => new Response('<html>Bad gateway</html>', { status: 502 }))).rejects.toMatchObject({ status: 502, message: 'Request failed (502)' })
    intercept = url => url === '/api/settings' ? json(500, { error: 'the profile could not be read' }) : undefined
    await open('/settings')
    expect(text()).toContain('the profile could not be read')
    expect(text()).not.toContain('Загрузка')
    act(() => { root!.unmount() })
    intercept = url => url === '/api/settings' ? new Response('<html>Sign in</html>', { status: 200 }) : undefined
    await open('/settings')
    expect(text()).toContain('not JSON')
  })

  it('says quietly when a job\'s refresh fails, and keeps what it had', async () => {
    await open('/jobs/job_0mwf3x5c40000p5ly4m')
    expect(container.querySelector('.jmain [role="status"]')).toBeNull()
    intercept = url => url === '/api/jobs/job_0mwf3x5c40000p5ly4m' ? json(500, { error: 'database is locked' }) : undefined
    await poll()
    expect(container.querySelector('.jmain [role="status"]')?.textContent).toBe('Не удалось обновить задачу: database is locked. Показаны последние данные.')
    expect(container.querySelectorAll('.step').length).toBe(4)
    intercept = undefined
    await poll()
    expect(container.querySelector('.jmain [role="status"]')).toBeNull()
  })

  it('names the job in the tab\'s title and its tabs as sections, and closes the JSON drawer at another address', async () => {
    await open('/jobs/job_0mwf3x5c40000p5ly4m')
    expect(document.title).toBe('ORD-298 · Workflow Agent')
    expect(container.querySelector('nav.tabs')?.getAttribute('aria-label')).toBe('Разделы задачи')
    const drawer = () => document.querySelector('.drawer')!
    await click(container.querySelector('.it .jbtn'))
    expect(drawer().hasAttribute('hidden')).toBe(false)
    await click(container.querySelector('.tabs a[href$="/details"]'))
    expect(drawer().hasAttribute('hidden')).toBe(true)
    await click(container.querySelector('.side a[href="/inbox"]'))
    expect(document.title).toBe('Workflow Agent')
    act(() => { root!.unmount() })
    // A job with no ticket is named by its title.
    await open('/jobs/job_0mwh2dm7f3')
    expect(document.title).toMatch(/^почини флейки тест .* · Workflow Agent$/u)
  })

  it('opens a job in a new tab on a middle click', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    await open('/')
    const row = container.querySelector('.row')!
    await act(async () => { row.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })) })
    expect(opened.mock.calls).toEqual([['/jobs/job_0mwf3x5c40000p5ly4m', '_blank', 'noopener']])
    await act(async () => { row.dispatchEvent(new MouseEvent('auxclick', { button: 2, bubbles: true, cancelable: true })) })
    expect(opened).toHaveBeenCalledTimes(1)
    expect(window.location.pathname).toBe('/')
    opened.mockRestore()
  })

  it('keeps j/k\'s highlight on its job when a poll reorders the rows', async () => {
    await open('/')
    const keys = () => [...container.querySelectorAll('.row .c-key')].map(cell => cell.textContent)
    const press = async (key: string) => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) }) }
    await press('j')
    await press('j')
    expect(container.querySelector('.row.sel .c-key')?.textContent).toBe('ORD-309')
    expect(keys().indexOf('ORD-309')).toBe(1)
    // The job that waited longest is answered and waits anew: it moves down its group, and the rows above it shift.
    jobsOf().find(job => job.ticket === 'ORD-298')!.waiting!.since = Date.now()
    await poll()
    expect(keys().indexOf('ORD-309')).toBe(0)
    expect([...container.querySelectorAll('.row.sel .c-key')].map(cell => cell.textContent)).toEqual(['ORD-309'])
    await press('j')
    expect(container.querySelector('.row.sel .c-key')?.textContent).toBe(keys()[1])
    await press('k')
    await press('k')
    expect(container.querySelector('.row.sel .c-key')?.textContent).toBe('ORD-309')
  })

  it('keeps the artifact being read when a new revision arrives', async () => {
    await open('/jobs/job_0mwf3x5c40000p5ly4m/artifacts')
    const pressed = () => container.querySelector('.art-l button[aria-pressed="true"] .al-d')?.textContent
    expect(pressed()).toBe('plan · r1')
    await click([...container.querySelectorAll('.art-l button')].find(element => element.textContent?.includes('requirements')))
    expect(pressed()).toBe('requirements · r1')
    const detail = data.details['job_0mwf3x5c40000p5ly4m'] as unknown as { artifacts: unknown[] }
    detail.artifacts = [...detail.artifacts, { kind: 'plan', n: 2, digest: 'ab12'.padEnd(64, '3'), title: 'План r2', text: '### Шаги\n- Иначе.' }]
    await poll()
    expect(container.querySelectorAll('.art-l button').length).toBe(3)
    expect(pressed()).toBe('requirements · r1')
  })

  it('does not send a poll while the one before it is on its way', async () => {
    await open('/')
    const sent = () => calls.filter(call => call.url === '/api/state').length
    const before = sent()
    let answer: (response: Response) => void = () => {}
    intercept = url => url === '/api/state' ? new Promise<Response>(resolve => { answer = resolve }) : undefined
    await poll()
    await poll()
    await poll()
    expect(sent()).toBe(before + 1)
    intercept = undefined
    await act(async () => { answer(json(200, data.state)) })
    await settle()
    await poll()
    expect(sent()).toBe(before + 2)
  })

  it('says how many earlier steps a long trace leaves out, where they would stand', async () => {
    const session = data.details['job_0mwf3x5c40000p5ly4m']!.attempts.find(attempt => attempt.id.endsWith('a4'))!.sessionId
    ;(data.traces as Record<string, unknown>)[session] = { ...data.traces[session], omitted: 120 }
    await open('/jobs/job_0mwf3x5c40000p5ly4m')
    const card = [...container.querySelectorAll('.acard')].find(element => element.textContent?.includes('попытка 2'))!
    await click([...card.querySelectorAll('button')].find(element => element.textContent?.includes('Ход работы агента')))
    expect(card.querySelector('.tracebtn')?.textContent).toContain('· 135')
    // Newest first: the steps left out are the oldest, so the note comes last.
    expect(card.querySelector('.trace')?.lastElementChild?.textContent).toBe('Более ранние шаги не показаны: 120')
    expect(translator('en')('attempt.omitted', { n: 120 })).toBe('120 earlier steps not shown')
  })

  it('writes the settings\' headers, the health counts and the gates\' outcomes in the viewer\'s language', async () => {
    await open('/settings')
    expect([...container.querySelectorAll('th')].map(cell => cell.textContent)).toEqual(['Имя', 'Проект', 'Ветка', 'Тесты', 'Подготовка', 'CI', 'Реестры', 'Тулчейны', 'Привязка', 'Аппруверы'])
    expect(text()).toContain('По умолчанию')
    expect(text()).toContain('Вердикт по ответам')
    act(() => { root!.unmount() })
    await open('/health')
    expect(text()).toContain('ждёт 2 · остановлена 2 · отложена 1')
    expect(text()).toContain('направлено 7 · пропущено 73')
    expect(text()).not.toContain('awaiting_gate')
    act(() => { root!.unmount() })
    await open('/jobs/job_0mwf3x5c40000p5ly4m')
    expect(text()).toContain('закрыл ворота: одобрено')
    expect(text()).not.toContain('satisfied')
    act(() => { root!.unmount() })
    await open('/')
    expect(container.querySelector('.bar [title="С полуночи по часовому поясу workbench"]')?.textContent).toContain('Токенов сегодня')
  })
})

describe('what the owner\'s trial found', () => {
  it('says why a reply was not counted in the viewer\'s language, and an unknown reason as written', () => {
    const tr = translator('ru'), te = translator('en')
    expect(refusalReason(tr, 'not an eligible approver')).toBe('нет права одобрять')
    expect(refusalReason(tr, 'not an eligible respondent')).toBe('нет права отвечать')
    expect(refusalReason(tr, 'not on the gate\'s thread')).toBe('не в треде запроса')
    expect(refusalReason(tr, 'a question back')).toBe('это встречный вопрос')
    expect(refusalReason(tr, 'no reading: the model timed out')).toBe('ответ не прочитан: the model timed out')
    expect(refusalReason(tr, 'the round was answered before the reply was read')).toBe('раунд вопросов закрыт до прочтения ответа (ответы получены)')
    expect(refusalReason(tr, 'the gate was cancelled before the verdict')).toBe('запрос закрыт до разбора ответа (отменено)')
    expect(refusalReason(tr, 'a question reply does not resume a blocked job')).toBe('такой ответ (question) не возобновляет остановленную задачу')
    expect(refusalReason(te, 'not an eligible approver')).toBe('not allowed to approve')
    expect(refusalReason(te, 'low confidence')).toBe('its meaning is not certain enough')
    // Every fixed reason of the decider has words; none is left in English in a Russian line.
    for (const reason of ['the workbench cannot answer its own gate', 'posted before the gate\'s current revision', 'it answered no item', 'the reading was malformed', 'unclear', 'unrelated']) {
      expect(refusalReason(tr, reason)).toMatch(/^[а-яёa-z ]*[а-яё][а-яёa-z ]*$/u)
    }
    expect(refusalReason(tr, 'not an approver of orders-api')).toBe('not an approver of orders-api')
    expect(refusalReason(tr, 'constructor')).toBe('constructor')
  })
  it('says a completed job with an open merge request is ready for review, and who must act', async () => {
    await open('/')
    const row = (ticket: string) => [...container.querySelectorAll('.row')].find(candidate => candidate.querySelector('.c-key')?.textContent === ticket)!
    // Still finished and green in the list, but not "Завершена": people review and merge.
    expect(row('ORD-303').querySelector('.c-wait')?.textContent).toBe('Готово к ревью')
    expect(row('ORD-303').className).toContain('k-ok')
    expect([...container.querySelectorAll('section')].find(section => section.contains(row('ORD-303')))?.querySelector('.gh')?.textContent).toContain('Завершены')
    expect(row('ORD-290').querySelector('.c-wait')?.textContent).toBe('Завершена · merge request влит')
    act(() => { root!.unmount() })
    await open('/jobs/job_0mwe3rev303')
    const now = container.querySelector('.callout')!
    expect(now.textContent).toContain('Реализация готова: G!44 — ревью и мёрж за людьми. Комментарий в MR вернёт задачу в работу.')
    expect(now.querySelector('a')?.getAttribute('href')).toBe('https://gitlab.example.test/shop/orders-api/-/merge_requests/44')
    expect(now.textContent).not.toContain('Завершена')
    await click(button('EN'))
    expect(container.querySelector('.callout')!.textContent).toContain('The implementation is ready: G!44 — review and merge are up to people.')
    act(() => { root!.unmount() })
    // No merge request: today's wording, in the list and on the page.
    localStorage.clear()
    const bare = { mergeRequest: null }
    Object.assign((data.state as unknown as { jobs: { id: string }[] }).jobs.find(job => job.id === 'job_0mwe3rev303')!, bare)
    Object.assign(data.details.job_0mwe3rev303!.job, bare)
    await open('/jobs/job_0mwe3rev303')
    expect(container.querySelector('.callout')!.textContent).toContain('Завершена.')
    act(() => { root!.unmount() })
    await open('/')
    expect(row('ORD-303').querySelector('.c-wait')?.textContent).toBe('Завершена')
  })

  it('says a closed job is closed, by whom, and that comments no longer reopen it', async () => {
    const lead = { source: 'jira', id: 'lead-1' }
    const detail = data.details.job_0mwe3rev303!
    Object.assign((data.state as unknown as { jobs: { id: string }[] }).jobs.find(job => job.id === 'job_0mwe3rev303')!, { closedBy: 'person' })
    Object.assign(detail.job, { closedBy: 'person' })
    Object.assign(detail, { state: { ...detail.state, closedBy: 'person', closer: lead } })
    const at = detail.events.at(-1)!.at + 60_000
    Object.assign(detail, { events: [...detail.events, { seq: detail.events.length + 1, type: 'JobClosed', at, causation: 'inbox:in_close',
      data: { v: 1, type: 'JobClosed', by: lead, eventId: 'in_close', threadKey: 'jira:ORD-303', at } }] })
    await open('/')
    const row = [...container.querySelectorAll('.row')].find(candidate => candidate.querySelector('.c-key')?.textContent === 'ORD-303')!
    expect(row.querySelector('.c-wait')?.textContent).toBe('Закрыта')
    act(() => { root!.unmount() })
    await open('/jobs/job_0mwe3rev303')
    const now = container.querySelector('.callout')!.textContent
    expect(now).toContain('Закрыта: lead-1. Комментарии её больше не откроют.')
    expect(now).not.toContain('Реализация готова')
    expect(container.textContent).toContain('закрыл задачу: комментарии её больше не откроют')
  })
  it('keeps the repository on a phone: the list offers the repositories, and the ways back to the jobs keep the one chosen', async () => {
    const keys = () => [...container.querySelectorAll('.row .c-key')].map(cell => cell.textContent)
    const tab = (path: string) => [...container.querySelectorAll<HTMLAnchorElement>('.tabbar a')].find(link => link.getAttribute('href')?.split('?')[0] === path)!
    const choose = async (value: string) => {
      const select = container.querySelector<HTMLSelectElement>('select.repo-m')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await settle()
    }
    await open('/?filter=problems')
    // The sidebar is hidden on a phone; the list's own control chooses a repository, and keeps the filter.
    expect([...container.querySelectorAll('select.repo-m option')].map(option => option.textContent)).toEqual(['Все репозитории', 'billing-api · 1', 'orders-api · 11', 'payments-gw · 1'])
    await choose('billing-api')
    expect(window.location.search).toBe('?filter=problems&repo=billing-api')
    expect(keys()).toEqual(['ORD-305'])
    expect(container.querySelector<HTMLSelectElement>('select.repo-m')!.value).toBe('billing-api')
    // Into a job and back by the breadcrumb or the tab bar: the repository is still chosen.
    await click(container.querySelector('.row'))
    expect(window.location.pathname).toBe('/jobs/job_0mwh9bill305')
    expect(container.querySelector('.crumbs a')?.getAttribute('href')).toBe('/?repo=billing-api')
    expect(tab('/').getAttribute('href')).toBe('/?repo=billing-api')
    await click(tab('/inbox'))
    expect(window.location.pathname).toBe('/inbox')
    await click(tab('/'))
    expect(`${window.location.pathname}${window.location.search}`).toBe('/?repo=billing-api')
    expect(keys()).toEqual(['ORD-305'])
    // The desktop's sidebar entry is still every job; the list's control clears the repository for good.
    expect(container.querySelector('.side a.nv')?.getAttribute('href')).toBe('/')
    await choose('')
    expect(window.location.search).toBe('')
    expect(tab('/').getAttribute('href')).toBe('/')
    await click(container.querySelector('.row'))
    expect(container.querySelector('.crumbs a')?.getAttribute('href')).toBe('/')
  })
})

describe('change proposals (D12)', () => {
  const RUNNING = 'job_0mwh7prop300', DONE = 'job_0mwe4prop296'
  const rowOf = (ticket: string) => [...container.querySelectorAll('.row')].find(row => row.querySelector('.c-key')?.textContent === ticket)
  const groupOfRow = (ticket: string) => rowOf(ticket)?.closest('section')?.querySelector('.gh')?.textContent?.replace(/\d+.*$/u, '')

  it('lists a job with a pending proposal among those that need people, under its own status', async () => {
    await open('/')
    expect(groupOfRow('ORD-300')).toBe('Ждут людей')
    const row = rowOf('ORD-300')!
    expect(row.querySelector('.c-wait')?.textContent).toBe('lead-1 · изменение требований (1)J')
    expect(row.querySelector('.c-wait .pill')?.getAttribute('title')).toContain('Идёт · lead-1')
    // Its status is still running: the tone and the stage say so.
    expect(row.className).toContain('k-run')
    expect(row.querySelector('.c-stage')?.textContent).toBe('Реализация и MR')
    // Decided proposals ask nothing of anyone.
    expect(groupOfRow('ORD-296')).toBe('Завершены')
    act(() => { root!.unmount() })
    await open('/?filter=people')
    expect([...container.querySelectorAll('.row .c-key')].map(cell => cell.textContent)).toContain('ORD-300')
    act(() => { root!.unmount() })
    await open('/?filter=running')
    expect([...container.querySelectorAll('.row .c-key')].map(cell => cell.textContent)).not.toContain('ORD-300')
  })

  it('says under the Now sentence who must decide a pending proposal and where, and shows the proposal with who asked', async () => {
    await open(`/jobs/${RUNNING}`)
    const now = container.querySelector('.callout')!
    expect(now.querySelector('.txt')?.textContent).toContain('Реализация и MR')
    expect(now.querySelector('.pend')?.textContent).toContain('Ждёт решения lead-1 в JORD-300: изменение требований (1).')
    expect(now.querySelector('.pend a')?.getAttribute('href')).toBe('https://jira.example.test/browse/ORD-300')
    const block = container.querySelector('.proposals')!
    expect(block.querySelector('h2')?.textContent).toBe('Изменения требований1')
    expect(block.textContent).toContain('Добавьте ещё фильтр по SKU')
    expect(block.querySelector('.tag')?.textContent).toBe('ждёт решения')
    expect(block.textContent).toContain('anna.k')
    expect(block.querySelector('a')?.getAttribute('href')).toContain('shop/orders-api/-/merge_requests/46')
    expect(block.textContent).not.toContain('решение:')
    expect(text()).toContain('предложил изменить требования: передано аппруверам')
    expect(text()).toContain('просит аппруверов решить об изменении требований')
  })

  it('shows what became of each proposal and who decided, and nothing on a job with none', async () => {
    await open(`/jobs/${DONE}`)
    expect(container.querySelector('.pend')).toBeNull()
    const proposals = [...container.querySelectorAll('.proposal')]
    expect(proposals.map(proposal => proposal.querySelector('.tag')?.textContent)).toEqual(['сделано', 'отклонено'])
    expect(proposals.every(proposal => proposal.textContent?.includes('решение: lead-1'))).toBe(true)
    for (const label of ['принял изменение требований', 'отклонил изменение требований', 'решение об изменении требований принято']) expect(text()).toContain(label)
    act(() => { root!.unmount() })
    await open('/jobs/job_0mwe1done290')
    expect(container.querySelector('.proposals')).toBeNull()
    expect(translator('ru')('proposal.included', { n: 2 })).toBe('в ревизии 2')
    expect(translator('en')('proposal.approved', { n: 2 })).toBe('approved in revision 2')
    expect(translator('ru')('ev.proposal.raisedAccepted')).toContain('принято сразу')
  })
})

describe('what a review says for people (P16)', () => {
  const DONE = 'job_0mwe4prop296'
  const card = (n: string) => [...container.querySelectorAll('.acard')].find(element => element.querySelector('.ttl')?.textContent?.endsWith(` ${n}`)
    && element.querySelector('.cks')?.textContent?.includes('review'))!

  it('shows the merge risk beside the review\'s check, toned by its level, and on demand its categories, gaps, areas and commit', async () => {
    await open(`/jobs/${DONE}`)
    const tag = card('2').querySelector<HTMLButtonElement>('.rtag')!
    expect(tag.textContent).toBe('риск: средний')
    expect(tag.className).toContain('k-wait')
    expect(tag.getAttribute('title')).toBe('Риск слияния: средний (затронуто: зависимости)')
    // Closed until asked for.
    expect(card('2').querySelector('.review')).toBeNull()
    await click(tag)
    const risk = card('2').querySelector('.risk')!
    expect(risk.querySelector('.risk-h')?.textContent).toBe('Риск слияния: средний (затронуто: зависимости)коммит 5713515a')
    expect([...risk.querySelectorAll('.risk-r')].map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd > span')?.textContent])).toEqual([
      ['Соответствие плану', 'хорошее'], ['Влияние', 'среднее'], ['Проверка', 'достаточная'], ['Откат', 'дешёвый'], ['Обнаружение ошибок', 'не применимо']])
    expect([...risk.querySelectorAll('.risk-r li')].map(gap => gap.textContent)).toEqual(['Общий форматтер сумм money.format() используется и в письмах о заказе', 'Нет теста на возврат меньше рубля'])
    expect(risk.querySelector('.risk-s')?.textContent).toBe('затронуто: зависимостиpyproject.toml')
    expect(risk.textContent).toContain('на слияние не влияет')
    await click(button('EN'))
    expect(card('2').querySelector('.rtag')?.textContent).toBe('risk: medium')
    expect(card('2').querySelector('.risk-h')?.textContent).toContain('Merge risk: medium (touches: dependencies)')
    expect(card('2').querySelector('.risk-r dd > span')?.textContent).toBe('good')
    await click(card('2').querySelector('.rtag'))
    expect(card('2').querySelector('.review')).toBeNull()
  })

  it('lists the review\'s notes under the risk, an unverified serious claim marked as not confirmed, with why', async () => {
    await open(`/jobs/${DONE}`)
    await click(card('2').querySelector('.rtag'))
    const notes = [...card('2').querySelectorAll('.rnote')]
    expect(notes.map(note => note.querySelector('.tag')?.textContent)).toEqual(['предложение', 'не подтверждено', 'тест не проверяет заявленное', 'тест не проверен ревью'])
    const unverified = notes[1]!
    expect(unverified.className).toContain('n-unverified')
    // A note, not a defect: quiet, with what was claimed and why the host did not take it.
    expect(unverified.querySelector('.tag')?.className).toContain('k-mute')
    expect(unverified.textContent).toContain('notify/refund.py: the refund amount is rounded twice')
    expect(unverified.querySelector('.rnote-w')?.textContent).toBe('заявлено как «важно»: its quote is not on the new side of notify/refund.py')
    expect(notes[2]!.textContent).toContain('tests/test_refund_notice.py test_refund_amount_kopecks')
    // The failed review had no risk and no notes: its check has nothing to open.
    expect(card('1').querySelector('.rtag')).toBeNull()
    // Notes without a risk: the tag counts them.
    act(() => { root!.unmount() })
    const check = data.details[DONE]!.attempts.flatMap(attempt => attempt.checks).find(item => item.risk)!
    delete (check as { risk?: unknown }).risk
    await open(`/jobs/${DONE}`)
    expect(card('2').querySelector('.rtag')?.textContent).toBe('замечания ревью · 4')
    expect(card('2').querySelector('.rtag')?.className).toContain('k-mute')
    await click(card('2').querySelector('.rtag'))
    expect(card('2').querySelector('.risk')).toBeNull()
    expect(card('2').querySelectorAll('.rnote').length).toBe(4)
  })

  it('shows a finding\'s severity as a tag in a check\'s evidence, and the notes with the check in the feed', async () => {
    await open(`/jobs/${DONE}`)
    const item = (label: string) => [...container.querySelectorAll('.it')].filter(element => !element.querySelector('.acard') && element.textContent?.includes(label))
    const failed = item('проверка review не прошла')[0]!
    expect(failed.querySelector('summary')?.textContent).toBe('review: changes — the notification drops the kopecks')
    expect(failed.querySelector('pre .sev')?.textContent).toBe('важно')
    expect(failed.querySelector('pre .sev')?.className).toContain('k-wait')
    expect(failed.querySelector('pre')?.textContent).toContain('1. важно notify/refund.py:41: the amount is cast to int')
    expect(failed.querySelector('pre')?.textContent).not.toContain('[important]')
    expect(item('проверка review прошла')[0]!.querySelectorAll('.rnote').length).toBe(4)
    // Evidence that is no finding stays as written.
    const tests = item('проверка tests прошла')[0]!
    expect(tests.querySelector('pre')?.textContent).toMatch(/^13[12] passed in/u)
    expect(tests.querySelector('.sev')).toBeNull()
  })

  it('marks a finished job\'s row quietly when its merge risk is medium or high, and no other', async () => {
    await open('/')
    const row = (ticket: string) => [...container.querySelectorAll('.row')].find(candidate => candidate.querySelector('.c-key')?.textContent === ticket)!
    const mark = row('ORD-296').querySelector('.rmark')!
    expect(mark.getAttribute('title')).toBe('Риск слияния: средний (затронуто: зависимости)')
    expect(mark.className).toContain('k-wait')
    // The row reads and groups as before.
    expect(row('ORD-296').querySelector('.c-wait')?.textContent).toBe('Завершена · merge request влит')
    expect(row('ORD-296').closest('section')?.querySelector('.gh')?.textContent).toContain('Завершены')
    expect(container.querySelectorAll('.rmark').length).toBe(1)
    act(() => { root!.unmount() })
    const job = (data.state as unknown as { jobs: { id: string; risk: { level: string } }[] }).jobs.find(candidate => candidate.id === DONE)!
    job.risk = { ...job.risk, level: 'low' }
    await open('/')
    expect(container.querySelector('.rmark')).toBeNull()
  })
})

describe('the workbench\'s own posts, as Markdown (2026-11-15)', () => {
  const DONE = 'job_0mwe4prop296', BLOCKED = 'job_0mwf3x5c40000p5ly4m'
  const posts = () => [...container.querySelectorAll('.msg.out .mb')]
  const postWith = (words: string) => posts().find(post => post.textContent?.includes(words))!

  it('shows a post\'s bold, nested lists, code and links as such in Conversations', async () => {
    await open(`/jobs/${DONE}/conversations`)
    const handover = postWith('Реализация готова')
    expect(handover.classList.contains('post')).toBe(true)
    expect(handover.querySelector('p b')?.textContent).toBe('Реализация готова — нужен ваш ревью.')
    const items = [...handover.querySelectorAll(':scope > ul > li')]
    expect(items.map(item => item.querySelector('b')?.textContent)).toEqual(['MR:', 'Коммит:', 'Проверки пройдены:', 'Риск слияния: средний'])
    expect([...items[3]!.querySelectorAll(':scope > ul > li')].map(item => item.textContent)).toEqual(['Влияние: Общий форматтер сумм money.format() используется и в письмах о заказе',
      'Проверка: Нет теста на возврат меньше рубля'])
    expect(items[1]!.querySelector('code')?.textContent).toBe('5713515a9c0e')
    const link = items[0]!.querySelector('a')!
    expect(link.textContent).toBe('orders-api!39')
    expect(link.getAttribute('href')).toBe('https://gitlab.example.test/shop/orders-api/-/merge_requests/39')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
    expect(handover.textContent).not.toMatch(/\*\*|\]\(|`/u)
    // A GitLab post's hard breaks (two trailing spaces) keep its two closing lines one paragraph, a line apart.
    const risk = postWith('Соответствие плану')
    expect(risk.querySelectorAll(':scope > ul').length).toBe(2)
    expect(risk.querySelector(':scope > p:last-child')?.innerHTML).toBe('ℹ️ Оценка модели по плану и diff; на слияние не влияет.<br>💬 Комментарии в MR вернут задачу в работу.')
  })

  it('shows a quote, a numbered list and an artifact between rules; people\'s messages stay plain text', async () => {
    await open(`/jobs/${BLOCKED}/conversations`)
    expect(postWith('Работа остановлена').querySelector('blockquote')?.textContent).toBe('no pipeline started on !41 within 15 min')
    const question = postWith('Нужны ответы')
    expect([...question.querySelectorAll('ol > li')].map(item => item.textContent)).toEqual(['Валюта — из заказа или из настроек магазина? @lead-1',
      'Частичный возврат — по строкам или одной суммой? @dev-ivan'])
    const approval = postWith('нужно ваше решение')
    expect(approval.querySelectorAll(':scope > hr').length).toBe(2)
    expect([...approval.querySelectorAll('h4')].map(heading => heading.textContent)).toContain('Цель')
    expect(approval.querySelector('pre')?.textContent).toContain('order_id;created_at')
    const inbound = [...container.querySelectorAll('.msg:not(.out) .mb')]
    expect(inbound.length).toBeGreaterThan(0)
    expect(inbound.every(message => message.children.length === 0 && message.textContent !== '' && !message.classList.contains('post'))).toBe(true)
  })

  it('marks a post from before posts kept their text as redrawn now, in Conversations and in Activity', async () => {
    await open(`/jobs/${BLOCKED}/conversations`)
    const marks = [...container.querySelectorAll('.msg.out .bot')]
    expect(marks.map(mark => mark.textContent)).toEqual(['перерисовано'])
    expect(marks[0]!.getAttribute('title')).toMatch(/^Отправлено до того, как посты стали сохранять свой текст/u)
    expect(marks[0]!.closest('.msg')!.textContent).toContain('Задача ORD-298 от @dev-ivan')
    await open(`/jobs/${BLOCKED}`)
    expect([...container.querySelectorAll('.it')].filter(item => item.textContent?.includes('перерисовано'))).toHaveLength(1)
  })

  it('makes an anchor of no other address and no markup, and keeps the zero-width spaces that break mentions and links', async () => {
    root = createRoot(container)
    const zw = '\u200b'
    await act(async () => {
      root!.render(<Markdown className="doc post" text={['[click](javascript:alert(1)) and [data](data:text/html,x) and [rel](/jobs)',
        `[site](https:${zw}//evil.example) — @${zw}dev-ivan, [${zw}~lead-1], www${zw}.evil.example`,
        '<img src=x onerror="alert(1)"> **<b>bold</b>** [ok](HTTPS://chat.example.test/a)'].join('\n')} />)
    })
    const anchors = [...container.querySelectorAll('a')]
    expect(anchors.map(anchor => anchor.getAttribute('href'))).toEqual(['HTTPS://chat.example.test/a'])
    expect(container.querySelector('img')).toBeNull()
    const said = container.textContent!
    expect(said).toContain('[click](javascript:alert(1))')
    expect(said).toContain('[data](data:text/html,x)')
    expect(said).toContain('[rel](/jobs)')
    expect(said).toContain(`[site](https:${zw}//evil.example) — @${zw}dev-ivan, [${zw}~lead-1], www${zw}.evil.example`)
    expect(said).toContain('<img src=x onerror="alert(1)">')
    expect(container.querySelector('b')?.textContent).toBe('<b>bold</b>')
  })

  it('clamps a post in the Activity feed to two lines until clicked; a click on its link does not toggle it', async () => {
    await open(`/jobs/${DONE}`)
    const quote = [...container.querySelectorAll('.quote.out.md')].find(element => element.textContent?.includes('Реализация готова'))! as HTMLElement
    expect(quote.getAttribute('aria-expanded')).toBe('false')
    expect(quote.classList.contains('full')).toBe(false)
    expect(quote.querySelector('.doc.post > ul > li > ul > li:last-child')?.textContent).toContain('Нет теста на возврат меньше рубля')
    const link = quote.querySelector('a')!
    link.addEventListener('click', event => { event.preventDefault() })
    await click(link)
    expect(quote.getAttribute('aria-expanded')).toBe('false')
    await click(quote.querySelector('p'))
    expect(quote.getAttribute('aria-expanded')).toBe('true')
    expect(quote.classList.contains('full')).toBe(true)
    await act(async () => { quote.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(quote.getAttribute('aria-expanded')).toBe('false')
    // People's words are quoted as written, in full; the page clamps only the workbench's posts, Markdown or not.
    expect([...container.querySelectorAll('.quote:not(.out)')].every(element => element.children.length === 0)).toBe(true)
    const css = readFileSync('src/client/app.css', 'utf8')
    expect(css).toMatch(/\.quote\.out \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/u)
    expect(css).toMatch(/\.quote\.out\.md:not\(\.full\) \.doc\.post \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/u)
  })
})
