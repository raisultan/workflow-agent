/**
 * Effect handlers for external writes (`T9.2`), on the real connectors over fake source APIs: each write carries its key, an
 * unknown outcome is reconciled instead of repeated, a refusal fails, and a post returns the server's time.
 */
import { describe, expect, it } from 'vitest'
import { hardBreaks, render, type RenderContext } from '../src/adapters/messages.ts'
import { parseThread, threadKey } from '../src/adapters/threads.ts'
import { actionHandler, gitlabMarker, MATTERMOST_KEY_PROP, notFastForward, postHandler, type Connectors } from '../src/adapters/writers.ts'
import type { ActionPayload, PostPayload } from '../src/domain/job.ts'
import { GitLabConnector } from '../src/sources/gitlab.ts'
import { JiraConnector } from '../src/sources/jira.ts'
import { MattermostConnector } from '../src/sources/mattermost.ts'
import { Harness, LEAD } from './fixtures/domain-workflow.ts'

type Route = (request: { method: string; path: string; body: unknown }) => { status?: number; body?: unknown } | undefined
/** A fake source API: every request is recorded, and the first route that answers wins. */
function api(...routes: Route[]) {
  const requests: { method: string; path: string; body: unknown }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const request = { method: init?.method ?? 'GET', path: parsed.pathname + parsed.search, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    requests.push(request)
    const answer = routes.map(route => route(request)).find(Boolean) ?? { status: 404, body: { message: 'not found' } }
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { requests, fetchImpl, writes: () => requests.filter(request => request.method !== 'GET') }
}

const context = (overrides: Partial<RenderContext> = {}): RenderContext => ({ locale: 'en', stageTitle: id => id[0]!.toUpperCase() + id.slice(1),
  artifactText: () => 'Use Redis for sessions.', name: actor => `@${actor.id}`, maxChars: 12_000, ...overrides })

const deps = (connectors: Connectors, extra: { worktree?: string } = {}) => ({ connectors: () => connectors, renderContext: () => context(),
  worktree: () => extra.worktree })
const post = (thread: string): PostPayload => ({ jobId: 'job_1', threadKey: thread, message: { kind: 'reminder', gateId: 'g1' } })
const action = (name: string, payload: unknown): ActionPayload => ({ jobId: 'job_1', attemptId: 'job_1.a1', actionId: 'job_1.a1.x1', action: name, payload })

describe('post', () => {
  it('posts to Mattermost with its key in props and returns the server time; reconcile finds it by that key', async () => {
    const posts: Record<string, unknown>[] = []
    const mm = api(
      ({ method, path, body }) => method === 'POST' && path === '/api/v4/posts'
        ? (posts.push({ ...(body as object), id: 'p9', create_at: 1700 }), { status: 201, body: posts.at(-1) }) : undefined,
      ({ path }) => path === '/api/v4/posts/root1/thread' ? { body: { posts: Object.fromEntries(posts.map(p => [p.id, p])) } } : undefined)
    const handler = postHandler(deps({ mattermost: new MattermostConnector({ baseUrl: 'http://mm', token: 't', fetchImpl: mm.fetchImpl }) }))
    // The result keeps the text as posted, for the dashboard (2026-11-15).
    const text = '⏰ A reminder: I am waiting for your reply above in this thread.'
    expect(await handler.run(post('mattermost:ch1:root1'), 'key-1', 1)).toEqual({ ok: { postId: 'p9', postedAt: 1700, threadKey: 'mattermost:ch1:root1', text } })
    expect(mm.writes()[0]!.body).toEqual({ channel_id: 'ch1', root_id: 'root1', message: '⏰ A reminder: I am waiting for your reply above in this thread.',
      props: { [MATTERMOST_KEY_PROP]: 'key-1' } })
    expect(await handler.reconcile!(post('mattermost:ch1:root1'), 'key-1')).toEqual({ found: { postId: 'p9', postedAt: 1700, threadKey: 'mattermost:ch1:root1', text } })
    expect(await handler.reconcile!(post('mattermost:ch1:root1'), 'key-2')).toEqual({ absent: true })
  })

  it('comments on Jira and reconciles by the exact body; marks GitLab notes and reconciles by the marker', async () => {
    const jira = api(
      ({ method, path }) => method === 'POST' && path === '/rest/api/2/issue/PAY-1/comment' ? { status: 201, body: { id: 77, created: '2026-01-01T00:00:01.000+0300' } } : undefined,
      ({ path }) => path.startsWith('/rest/api/2/issue/PAY-1/comment?') ? { body: { comments: [
        { id: 77, body: '⏰ A reminder: I am waiting for your reply above in this thread.', created: '2026-01-01T00:00:01.000+0300' }] } } : undefined)
    const gitlab = api(
      ({ method, path }) => method === 'POST' && path === '/api/v4/projects/group%2Fapp/merge_requests/4/notes' ? { status: 201, body: { id: 5, created_at: '2026-01-01T00:00:02Z' } } : undefined,
      ({ method, path }) => method === 'POST' && path === '/api/v4/projects/group%2Fapp/merge_requests/4/discussions/d1/notes' ? { status: 201, body: { id: 6, created_at: '2026-01-01T00:00:03Z' } } : undefined,
      ({ path }) => path.startsWith('/api/v4/projects/group%2Fapp/merge_requests/4/notes?') ? { body: [{ id: 5, body: `x\n\n${gitlabMarker('key-g')}`, created_at: '2026-01-01T00:00:02Z' }] } : undefined)
    const handler = postHandler(deps({ jira: new JiraConnector({ baseUrl: 'http://jira', auth: { kind: 'bearer', token: 't' }, fetchImpl: jira.fetchImpl }),
      gitlab: new GitLabConnector({ baseUrl: 'http://gl', token: 't', fetchImpl: gitlab.fetchImpl }) }))
    expect(await handler.run(post('jira:PAY-1'), 'key-j', 1)).toEqual({ ok: { postId: '77', postedAt: Date.parse('2026-01-01T00:00:01.000+0300'), threadKey: 'jira:PAY-1',
      text: '⏰ A reminder: I am waiting for your reply above in this thread.' } })
    expect(await handler.reconcile!(post('jira:PAY-1'), 'key-j')).toMatchObject({ found: { postId: '77' } })
    expect(await handler.run(post('gitlab:group/app!4'), 'key-g', 1)).toMatchObject({ ok: { postId: '5', threadKey: 'gitlab:group/app!4' } })
    expect((gitlab.writes()[0]!.body as { body: string }).body).toMatch(/waiting for your reply above in this thread\.\n\n<!-- workbench:key-g -->$/u)
    expect(await handler.reconcile!(post('gitlab:group/app!4'), 'key-g')).toMatchObject({ found: { postId: '5' } })
    expect(await handler.reconcile!(post('gitlab:group/app!4'), 'other')).toEqual({ absent: true })
    // An answer to a merge request comment goes into its discussion (trial 2026-11-14).
    expect(await handler.run({ ...post('gitlab:group/app!4'), replyTo: 'd1' }, 'key-d', 1)).toMatchObject({ ok: { postId: '6' } })
    expect(gitlab.writes().at(-1)!.path).toBe('/api/v4/projects/group%2Fapp/merge_requests/4/discussions/d1/notes')
    // A discussion GitLab refuses to take a reply in gets a new note instead, so the answer is not lost.
    expect(await handler.run({ ...post('gitlab:group/app!4'), replyTo: 'gone' }, 'key-e', 1)).toMatchObject({ ok: { postId: '5' } })
    expect(gitlab.writes().slice(-2).map(write => write.path)).toEqual(['/api/v4/projects/group%2Fapp/merge_requests/4/discussions/gone/notes',
      '/api/v4/projects/group%2Fapp/merge_requests/4/notes'])
  })

  it('fails on a refusal, leaves a server error unknown, and fails when the source is not configured', async () => {
    const refused = api(() => ({ status: 403, body: { message: 'no permission' } }))
    const handler = postHandler(deps({ mattermost: new MattermostConnector({ baseUrl: 'http://mm', token: 't', fetchImpl: refused.fetchImpl }) }))
    expect(await handler.run(post('mattermost:ch1:r'), 'k', 1)).toMatchObject({ fail: expect.stringContaining('HTTP 403') })
    const broken = api(() => ({ status: 502, body: { message: 'bad gateway' } }))
    const unknown = postHandler(deps({ mattermost: new MattermostConnector({ baseUrl: 'http://mm', token: 't', fetchImpl: broken.fetchImpl, maxRetries: 0 }) }))
    await expect(unknown.run(post('mattermost:ch1:r'), 'k', 1)).rejects.toThrow('HTTP 502')
    expect(await postHandler(deps({})).run(post('jira:PAY-1'), 'k', 1)).toEqual({ fail: 'Jira is not configured' })
  })

  it('writes a gate\'s post once when the response is lost, and the gate opens at the server\'s time', async () => {
    const posts: Record<string, unknown>[] = []
    let lose = true
    const mm = api(
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== '/api/v4/posts') return undefined
        posts.push({ ...(body as object), id: `p${posts.length + 1}`, create_at: 1_767_225_700_000 + posts.length })
        if (lose) { lose = false; return { status: 502, body: { message: 'the gateway dropped the response' } } }
        return { status: 201, body: posts.at(-1) }
      },
      ({ path }) => path.startsWith('/api/v4/posts/') && path.endsWith('/thread') ? { body: { posts: Object.fromEntries(posts.map(p => [p.id, p])) } } : undefined)
    const h = new Harness({ without: ['post'] })
    try {
      const mattermost = new MattermostConnector({ baseUrl: 'http://mm', token: 't', fetchImpl: mm.fetchImpl, maxRetries: 0 })
      h.wb.kernel.effects.register('post', postHandler(deps({ mattermost })))
      const job = await h.start('@workbench add sessions', 'mattermost:ch1:root1')
      expect(posts).toHaveLength(1)
      await h.report(job, { outcome: 'question', items: [{ text: 'Which store?' }] })
      const gate = h.gate(job)!
      expect(gate.postedAt).toBe(posts.at(-1)!.create_at)
      // The "started" post whose response was lost was found again, not written twice; the question is the second write.
      expect(posts).toHaveLength(2)
      expect(new Set(posts.map(p => (p.props as Record<string, string>)[MATTERMOST_KEY_PROP])).size).toBe(2)
    } finally { h.cleanup() }
  })
})

describe('action', () => {
  it('posts the agent\'s merge request reply with its lines kept: GitLab joins lines a single newline separates (2026-11-15)', async () => {
    const gl = api(({ method, path }) => method === 'POST' && path.endsWith('/discussions/d1/notes') ? { status: 201, body: { id: 8, created_at: '2026-01-01T00:00:00Z' } } : undefined)
    const handler = actionHandler(deps({ gitlab: new GitLabConnector({ baseUrl: 'http://gl', token: 't', fetchImpl: gl.fetchImpl }) }))
    expect(await handler.run(action('gitlab.reply', { project: 'group/app', mrIid: 4, discussionId: 'd1', body: '✅ **Исправлено** в `abc123`\n\n- лог разделён\n- тест на лог\nℹ️ остальное без изменений\nвторая строка' }), 'k', 1))
      .toMatchObject({ ok: { postId: '8' } })
    expect((gl.writes()[0]!.body as { body: string }).body).toBe(
      '✅ **Исправлено** в `abc123`\n\n- лог разделён\n- тест на лог  \nℹ️ остальное без изменений  \nвторая строка\n\n<!-- workbench:k -->')
  })

  it('opens an MR once, finding the open one by its source branch, and binds its thread', async () => {
    let open: { iid: number; web_url: string } | undefined
    const gl = api(
      ({ method, path }) => method === 'GET' && path.includes('/merge_requests?state=opened') ? { body: open ? [open] : [] } : undefined,
      ({ method, path }) => method === 'POST' && path.endsWith('/merge_requests') ? (open = { iid: 12, web_url: 'http://gl/mr/12' }, { status: 201, body: open }) : undefined)
    const handler = actionHandler(deps({ gitlab: new GitLabConnector({ baseUrl: 'http://gl', token: 't', fetchImpl: gl.fetchImpl }) }))
    const request = action('gitlab.createMr', { project: 'group/app', sourceBranch: 'agent/pay-1-sessions', targetBranch: 'main', title: 'Sessions', description: '' })
    const created = { mrIid: 12, webUrl: 'http://gl/mr/12', bind: 'gitlab:group/app!12' }
    expect(await handler.reconcile!(request, 'k')).toEqual({ absent: true })
    expect(await handler.run(request, 'k', 1)).toEqual({ ok: created })
    expect(await handler.run(request, 'k', 2)).toEqual({ ok: created })
    expect(await handler.reconcile!(request, 'k')).toEqual({ found: created })
    expect(gl.writes()).toHaveLength(1)
  })

  it('pushes the requested commit from the job\'s worktree, and refuses a non-agent branch', async () => {
    const pushes: unknown[] = []
    const gitlab = new GitLabConnector({ baseUrl: 'http://gl', token: 't', gitPushRunner: async params => { pushes.push(params); return { pushed: true, commitSha: params.commitSha! } } })
    const handler = actionHandler(deps({ gitlab }, { worktree: '/work/job_1' }))
    const sha = 'a'.repeat(40)
    expect(await handler.run(action('gitlab.push', { project: 'group/app', branch: 'agent/pay-1-sessions', sha }), 'k', 1))
      .toEqual({ ok: { branch: 'agent/pay-1-sessions', sha } })
    expect(pushes).toEqual([{ worktreeDir: '/work/job_1', project: 'group/app', branch: 'agent/pay-1-sessions', commitSha: sha }])
    expect(await handler.run(action('gitlab.push', { project: 'group/app', branch: 'main', sha }), 'k', 1)).toMatchObject({ fail: expect.any(String) })
    expect(await handler.run(action('gitlab.push', { project: 'group/app', branch: 'agent/x', sha: 'HEAD' }), 'k', 1)).toMatchObject({ fail: expect.stringContaining('sha') })
    expect(await handler.run(action('gitlab.merge', {}), 'k', 1)).toEqual({ fail: 'Unknown action gitlab.merge' })
  })

  it('creates a channel and invites people (V1 never added them), posts a root message that the job then follows', async () => {
    const mm = api(
      ({ path }) => path.startsWith('/api/v4/teams/team1/channels/name/') ? { status: 404 } : undefined,
      ({ method, path }) => method === 'POST' && path === '/api/v4/channels' ? { status: 201, body: { id: 'c7', name: 'war-room' } } : undefined,
      ({ method, path }) => method === 'POST' && path === '/api/v4/users/usernames' ? { body: [{ id: 'u1', username: 'anna' }] } : undefined,
      ({ method, path }) => method === 'POST' && path === '/api/v4/channels/c7/members' ? { status: 201, body: {} } : undefined,
      ({ method, path }) => method === 'POST' && path === '/api/v4/posts' ? { status: 201, body: { id: 'p1', create_at: 5 } } : undefined)
    const handler = actionHandler(deps({ mattermost: new MattermostConnector({ baseUrl: 'http://mm', token: 't', teamId: 'team1', fetchImpl: mm.fetchImpl }) }))
    expect(await handler.run(action('mattermost.createChannel', { name: 'war-room', displayName: 'War room', invite: ['anna'] }), 'k', 1))
      .toEqual({ ok: { channelId: 'c7', name: 'war-room', invited: ['anna'] } })
    expect(mm.writes().map(write => write.path)).toEqual(['/api/v4/channels', '/api/v4/users/usernames', '/api/v4/channels/c7/members'])
    expect(await handler.run(action('mattermost.post', { thread: 'mattermost:c7:', text: 'Kick-off' }), 'k2', 1))
      .toEqual({ ok: { postId: 'p1', postedAt: 5, threadKey: 'mattermost:c7:', bind: 'mattermost:c7:p1' } })
  })
})

describe('messages and threads', () => {
  it('renders in Russian and English, keeping the reply instruction when a long artifact is cut', () => {
    const subject = { kind: 'plan', n: 2, digest: 'd', attemptId: 'a' }
    // The artifact sits between rules; the reply instruction comes last, after a blank line (2026-11-15).
    expect(render({ kind: 'approval', gateId: 'g', subject }, context({ locale: 'ru' }))).toBe(
      '📋 **План, ревизия 2** — нужно ваше решение.\n\n---\n\nUse Redis for sessions.\n\n---\n\n👉 Ответьте в этой ветке: «ок» — одобрить, или напишите, что изменить.')
    // The plan's tests field is shown before the approval instruction (T10.1).
    expect(render({ kind: 'approval', gateId: 'g', subject }, context({ reportOutput: id => id === 'a' ? { steps: ['x'], tests: 'A test for session expiry' } : undefined })))
      .toBe('📋 **Plan, revision 2** — your decision is needed.\n\n---\n\nUse Redis for sessions.\n\n---\n\n🧪 **Tests:** A test for session expiry\n\n'
        + '👉 Reply in this thread: "ok" to approve, or say what to change.')
    // An exemption line of the tests field is machine text: people read it as a sentence that names the rule (trial finding 18).
    const exempting = (tests: string, locale: 'ru' | 'en') => render({ kind: 'approval', gateId: 'g', subject }, context({ locale, reportOutput: () => ({ tests }) })).split('\n\n').slice(4, -1).join('\n\n')
    expect(exempting('Тест на пагинацию.\nexempt deleted-test [tests/test_orders.py]: тест проверял удалённое поле\nисключение test-config: новый файл в pytest.ini', 'ru')).toBe(
      '🧪 **Тесты:** Тест на пагинацию.\n⚠️ **Исключение из проверки тестов** — удалённый тест (`tests/test_orders.py`): тест проверял удалённое поле\n'
      + '⚠️ **Исключение из проверки тестов** — изменённые настройки тестов: новый файл в pytest.ini')
    expect(exempting('exempt skip-marker tests/slow.test.ts: flaky upstream\nexempt binary-code: no', 'en')).toBe(
      '🧪 **Tests:** exempt binary-code: no\n⚠️ **Exemption from the test check** — skipped tests (`tests/slow.test.ts`): flaky upstream')
    expect(render({ kind: 'approved', gateId: 'g', subject, by: LEAD, next: 'implement', notes: 'reuse the helper' }, context()))
      .toBe('✅ **Plan revision 2 approved** by @lead.\n▶️ Moving on to "Implement".\n\n📝 **I will take these notes into account:** reuse the helper')
    expect(render({ kind: 'blocked', gateId: 'g', reason: { kind: 'budget', budget: 'turns' }, extension: { turns: 50 } }, context({ locale: 'ru' })))
      .toBe('⏸ **Работа остановлена:** закончился бюджет ходов.\n\n👉 Ответьте «ок», чтобы продлить (+50 ходов), или «стоп», чтобы отменить задачу.')
    // A check's evidence is quoted, line by line.
    expect(render({ kind: 'blocked', gateId: 'g', reason: { kind: 'checks_blocked', stageId: 'implement', checks: ['ci'],
      detail: 'ci: no CI pipeline started for abc within 10 min;\ndoes the repository have CI?' } }, context({ locale: 'ru' }))).toBe(
      '⏸ **Работа остановлена:** проверки (ci) не дали результата по причине окружения, а не кода.\n\n'
      + '> ci: no CI pipeline started for abc within 10 min;\n> does the repository have CI?\n\n'
      + '👉 Когда причина устранена, ответьте «ок», чтобы перезапустить проверки на том же коммите, или «стоп», чтобы отменить задачу.')
    // The completion post: a headline, the facts as a list, the merge request named by its project and number, and how to reopen.
    expect(render({ kind: 'completed', outcome: 'completed', checks: ['tests', 'ci'] }, context({ locale: 'ru',
      delivered: () => ({ mergeRequest: 'https://gitlab.example.com/acme/payments/-/merge_requests/5', commit: 'a'.repeat(40) }) }))).toBe(
      '✅ **Реализация готова — нужен ваш ревью.**\n\n- **MR:** [payments!5](https://gitlab.example.com/acme/payments/-/merge_requests/5)\n- **Коммит:** `aaaaaaaaaaaa`\n'
      + '- **Проверки пройдены:** тесты, CI\n\n💬 Комментарии в MR вернут задачу в работу.')
    // Trial 2026-11-14: a job that hands over a merge request is ready for review; one that finished again after MR feedback says so.
    expect(render({ kind: 'completed', outcome: 'completed', checks: ['integrity', 'review', 'lint'], reworked: true }, context({ locale: 'ru',
      delivered: () => ({ mergeRequest: 'https://gitlab.example.com/acme/payments/-/merge_requests/5' }) })).split('\n')[0]).toBe(
      '✅ **Доработал по комментариям в MR — нужен ваш ревью.**')
    expect(render({ kind: 'completed', outcome: 'completed' }, context({ locale: 'ru' }))).toBe('🏁 **Задача завершена**.')
    // An outcome is said in words; one the deployment named itself is shown as it is.
    expect(render({ kind: 'completed', outcome: 'mr_merged' }, context({ locale: 'ru' }))).toBe('🏁 **Задача завершена** — MR влит.')
    expect(render({ kind: 'completed', outcome: 'mr_merged' }, context())).toBe('🏁 **The job is done** — the merge request was merged.')
    expect(render({ kind: 'completed', outcome: 'shipped' }, context())).toBe('🏁 **The job is done** — shipped.')
    // P16: the review's merge risk — in the completion post the level and the two worst categories' first gaps; the whole on the MR.
    const risk = { level: 'medium', floor: ['migration'], sensitive: [{ area: 'migration', files: ['m.sql'] }], commit: 'c'.repeat(40), categories: {
      alignment: { verdict: 'good', gaps: [] }, impact: { verdict: 'medium', gaps: ['Общий ERRORS меняет документацию других маршрутов.'] },
      verification: { verdict: 'poor', gaps: ['нет теста на limit=100', 'тест не доходит до 20'] }, rollback: { verdict: 'low', gaps: [] }, errors: { verdict: 'n/a', gaps: [] } } }
    expect(render({ kind: 'completed', outcome: 'completed', risk }, context({ locale: 'ru', delivered: () => ({ mergeRequest: 'https://gl/mr/1' }) })).split('\n')).toEqual([
      '✅ **Реализация готова — нужен ваш ревью.**', '', '- **MR:** https://gl/mr/1',
      '- 🟡 **Риск слияния: средний** (затронуто: миграции)', '  - **Проверка:** нет теста на limit=100', '  - **Влияние:** Общий ERRORS меняет документацию других маршрутов.',
      '', '💬 Комментарии в MR вернут задачу в работу.'])
    expect(render({ kind: 'mergeRisk', risk, notes: '- (suggestion) rename\n- (unverified important: its quote is not in the diff of a.py) a.py: sorts @wrong' },
      context({ locale: 'ru' })).split('\n')).toEqual([
      '🟡 **Риск слияния: средний** (затронуто: миграции) · коммит `cccccccc`', '',
      '- 🟢 **Соответствие плану:** хорошее', '- 🟡 **Влияние:** среднее', '  - Общий ERRORS меняет документацию других маршрутов.',
      '- 🔴 **Проверка:** слабая', '  - нет теста на limit=100', '  - тест не доходит до 20', '- 🟢 **Откат:** дешёвый', '- ⚪ **Обнаружение ошибок:** не применимо',
      '', '⚠️ **Замечания ревью без подтверждения в diff:**', '', '- a.py: sorts @​wrong (важное: цитаты нет в diff файла a.py)',
      '', 'ℹ️ Оценка модели по плану и diff; на слияние не влияет.', '💬 Комментарии в MR вернут задачу в работу.'])
    expect(render({ kind: 'mergeRisk', risk: { ...risk, floor: [] }, notes: '- (unverified critical: "limit=100" is in the change) no test' }, context()).split('\n'))
      .toEqual(expect.arrayContaining(['🟡 **Merge risk: medium** · commit `cccccccc`', '- no test (critical: "limit=100" is in the change)']))
    // GitLab joins lines a single newline separates (trial, 2026-11-15): there each line that is not followed by a block ends in a hard break.
    const onGitlab = render({ kind: 'mergeRisk', risk }, context({ locale: 'ru', source: 'gitlab' })).split('\n')
    expect(onGitlab.slice(-2)).toEqual(['ℹ️ Оценка модели по плану и diff; на слияние не влияет.  ', '💬 Комментарии в MR вернут задачу в работу.'])
    expect(onGitlab.filter(line => line.startsWith('- ') || line.startsWith('  - ')).every(line => !line.endsWith('  '))).toBe(true)
    // D12: who may approve or change a plan, said to whoever may not, and a proposal put to the approvers.
    const people = context({ locale: 'ru', name: (actor: { id: string }) => `@${actor.id}`, approvers: () => ['@lead-1'],
      ticketUrl: (key: string) => `https://jira.example.com/browse/${key}` })
    expect(render({ kind: 'notApprover', to: { source: 'jira', id: 'dev-ivan' } }, people))
      .toBe('ℹ️ @dev-ivan, одобрить план может только @lead-1. Вопросы — пожалуйста.')
    expect(render({ kind: 'approveElsewhere', ticket: 'ORD-300' }, people)).toBe('ℹ️ План одобряется в задаче [ORD-300](https://jira.example.com/browse/ORD-300) — @lead-1.')
    // D12, change proposals: put to the approvers in the ticket (one, several, on the approval), and news where they were asked.
    const anna = { source: 'gitlab', id: 'anna' }
    expect(render({ kind: 'proposalAsk', gateId: 'g', proposals: [{ id: 'p1', text: 'обычный 422 от @fastapi', by: { source: 'jira', id: 'dev-ivan' } }], to: { source: 'jira', id: 'dev-ivan' } }, people))
      .toBe('ℹ️ @dev-ivan, менять план может только @lead-1.\n\n🔁 @lead-1, @dev-ivan просит изменить требования — учесть в плане?\n\n> обычный 422 от @​fastapi\n\n👉 Ответьте «да» или «нет».')
    // A proposal keeps its own number, which an ordered list would renumber.
    expect(render({ kind: 'proposalAsk', gateId: 'g', onApproval: true, proposals: [{ id: 'p2', text: 'фильтр по sku', by: anna }, { id: 'p5', text: 'фильтр по дате', by: anna }] }, people))
      .toBe('🔁 @lead-1, просят изменить требования:\n\n- **2.** «фильтр по sku» — @anna\n- **5.** «фильтр по дате» — @anna\n\n'
        + '👉 Ответьте «да» — сделаю новую ревизию с этим; «нет, ок» — отклоню и одобрю текущую ревизию. По пунктам: «2: да, 5: нет».')
    const lead = { source: 'jira', id: 'lead-1' }
    const ticket = '[ORD-300](https://jira.example.com/browse/ORD-300)'
    expect(render({ kind: 'proposalNews', news: 'passed', ticket: 'ORD-300' }, people)).toBe(`➡️ Это меняет требования — передал @lead-1 на решение в задаче ${ticket}.`)
    expect(render({ kind: 'proposalNews', news: 'accepted', ticket: 'ORD-300' }, people)).toBe(`🔁 Это меняет требования: сначала обновлю план в задаче ${ticket}, потом код.`)
    expect(render({ kind: 'proposalNews', news: 'accepted', by: lead, ticket: 'ORD-300' }, people)).toBe(`🔁 @lead-1 принял(а) изменение требований: сначала обновлю план в задаче ${ticket}, потом код.`)
    expect(render({ kind: 'proposalNews', news: 'declined', by: lead }, people)).toBe('✖️ @lead-1 отклонил(а) это изменение требований.')
    expect(render({ kind: 'proposalNews', news: 'approved', by: lead, revision: 3 }, people)).toBe('✅ Включено в план (ревизия 3), одобрено: @lead-1.')
    expect(render({ kind: 'proposalNews', news: 'done' }, { ...people, delivered: () => ({ commit: 'b'.repeat(40) }) })).toBe('✅ Сделано: коммит `bbbbbbbbbbbb`.')
    expect(render({ kind: 'proposalNews', news: 'expired' }, people)).toBe('⌛ Решения по этому изменению требований так и не было.\n\n👉 Если оно нужно, напишите о нём снова.')
    expect(render({ kind: 'proposalNews', news: 'passed' }, context())).toBe('➡️ This changes the requirements — I passed it to the approvers to decide.')
    expect(render({ kind: 'notApprover', to: { source: 'jira', id: 'dev-ivan' } }, context()))
      .toBe('ℹ️ @dev-ivan, your reply does not approve the plan: you may not approve it. Questions are welcome.')
    // An approval that leads to the end of the job says so, not the internal "$complete" (the demo, 2026-11-15).
    const plan = { kind: 'plan', n: 1, digest: 'd'.repeat(64), attemptId: 'a1' }
    expect(render({ kind: 'approved', gateId: 'g', subject: plan, by: lead, next: '$complete' }, { ...context(), stageTitle: id => id }))
      .toBe('✅ **Plan revision 1 approved** by @lead-1.\n🏁 That completes the job.')
    expect(render({ kind: 'approved', gateId: 'g', subject: plan, by: lead, next: '$complete' }, { ...people, stageTitle: id => id })).toContain('\n🏁 На этом задача завершена.')
    // Closing a finished job: the acknowledgement, the refusal, and what a closed job's thread is told once.
    expect(render({ kind: 'closed', by: lead }, people)).toBe('🔒 **Задача закрыта** — @lead-1.\nКомментарии её больше не откроют.')
    expect(render({ kind: 'closed', by: lead }, { ...people, source: 'gitlab' })).toBe('🔒 **Задача закрыта** — @lead-1.  \nКомментарии её больше не откроют.')
    expect(render({ kind: 'closeNotAllowed', to: { source: 'jira', id: 'dev-ivan' } }, people)).toBe('ℹ️ @dev-ivan, закрыть задачу может только @lead-1.')
    expect(render({ kind: 'jobClosed', fact: 'mr_merged' }, people)).toBe('🔒 Задача закрыта — MR влит: комментарии её больше не откроют.\n\n👉 Для новой работы начните новую задачу.')
    expect(render({ kind: 'jobClosed', by: lead }, people)).toContain('🔒 Задача закрыта — @lead-1: ')
    expect(render({ kind: 'jobClosed', fact: 'mr_closed' }, context())).toBe('🔒 This task is closed — the merge request was closed without merging: comments no longer reopen it.\n\n👉 For new work, start a new task.')
    expect(render({ kind: 'closeNotAllowed', to: { source: 'jira', id: 'dev-ivan' } }, context())).toBe('ℹ️ @dev-ivan, only the plan\'s approvers can close the task.')
    // D12: short Russian messages; a round is addressed, and says what it has and what is open.
    const items = [{ text: 'Какой TTL?' }, { text: 'Где хранить?', choices: ['redis', 'sql'] }]
    expect(render({ kind: 'question', gateId: 'g', round: 1, items }, context({ locale: 'ru', addressee: '@ivan' })))
      .toBe('❓ @ivan, нужны ответы:\n\n1. Какой TTL?\n2. Где хранить? (варианты: redis / sql)\n\n👉 Отвечайте в этой ветке, можно частями: «1: …, 2: …».')
    expect(render({ kind: 'question', gateId: 'g', round: 2, items }, context({ locale: 'ru' }))).toMatch(/^❓ Ещё вопросы \(раунд 2\):/u)
    expect(render({ kind: 'answersRecorded', gateId: 'g', answered: [1], remaining: [2], redirects: [{ item: 2, to: 'anna', text: 'Где хранить?' }] },
      context({ locale: 'ru' }))).toBe('✅ Принял ответы: 1.\n↪️ Передал вопрос 2 → @anna: Где хранить?\n⏳ Жду ответов: 2.')
    // The post says what this reply changed: one that only passed a question on accepts nothing (trial finding 2).
    expect(render({ kind: 'answersRecorded', gateId: 'g', answered: [], remaining: [1, 3], redirects: [{ item: 1, to: 'dev-ivan', text: 'Какой TTL?' }] },
      context({ locale: 'ru' }))).toBe('↪️ Передал вопрос 1 → @dev-ivan: Какой TTL?\n⏳ Жду ответов: 1, 3.')
    expect(render({ kind: 'answersRecorded', gateId: 'g', answered: [3], remaining: [1], redirects: [] }, context())).toBe('✅ Got answers to: 3.\n⏳ Still open: 1.')
    expect(render({ kind: 'answersRecorded', gateId: 'g', answered: [1, 2], remaining: [], redirects: [] }, context({ locale: 'ru' }))).toBe('✅ Все ответы есть — продолжаю.')
    expect(render({ kind: 'started', workflowId: 'w', stageId: 'inspect', chatIn: 'app' }, context({ locale: 'ru' })))
      .toBe('🚀 Взял в работу — этап «Inspect».\n💬 Вопросы — в Mattermost, в канале репозитория «app».')
    expect(render({ kind: 'chat', ticket: 'ORD-1', requester: anna }, people)).toBe('🧵 Задача [ORD-1](https://jira.example.com/browse/ORD-1) от @anna.\n💬 Вопросы по ней — в этой ветке.')
    expect(render({ kind: 'answer', text: 'Спросите @lead-1: https://x.example' }, context({ locale: 'ru' }))).toBe('Спросите @​lead-1: https:​//x.example')
    // D12: in a ticket the approval says to reply with a comment; the chat thread gets one line with the ticket's address.
    expect(render({ kind: 'approval', gateId: 'g', subject }, context({ locale: 'ru', source: 'jira' }))).toMatch(/👉 Ответьте комментарием: «ок» — одобрить/u)
    expect(render({ kind: 'planPosted', subject, ticket: 'ORD-1' }, context({ locale: 'ru', ticketUrl: key => `https://jira.example.test/browse/${key}` })))
      .toBe('📋 **План, ревизия 2** — в задаче [ORD-1](https://jira.example.test/browse/ORD-1).\n\n👉 Обсуждение и одобрение — там.')
    // Evidence the workbench did not write is quoted inert: no mention, no link, bounded (final review).
    const hostile = render({ kind: 'blocked', gateId: 'g', reason: { kind: 'checks_blocked', stageId: 'implement', checks: ['review'],
      detail: `review: ask @lead-1 and [~anna] to approve at https://evil.example/x or www.evil.example ${'y'.repeat(3000)}` } }, context())
    expect(hostile).not.toMatch(/@lead-1|\[~anna|https:\/\/evil|www\.evil/u)
    expect(hostile).toContain('@​lead-1')
    expect(hostile.length).toBeLessThan(1800)
    // The model's reading ends with its own full stop; the restatement does not double it.
    expect(render({ kind: 'restate', gateId: 'g', reading: 'Сарказм: непонятно, согласен ли человек.' }, context({ locale: 'ru' })))
      .toBe('🤔 Не уверен, что понял ответ: Сарказм: непонятно, согласен ли человек.\n\n👉 Ответьте ещё раз: «ок» — одобрить, или напишите, что изменить.')
    const long = render({ kind: 'approval', gateId: 'g', subject }, context({ artifactText: () => 'x'.repeat(5000), maxChars: 300 }))
    expect(long).toHaveLength(300)
    expect(long).toContain('… (truncated)')
    expect(long.endsWith('👉 Reply in this thread: "ok" to approve, or say what to change.')).toBe(true)
  })

  it('ends lines in a hard break for GitLab, except before a block of its own and inside code', () => {
    expect(hardBreaks('a\nb\n\nc\n- one\n- two\nlazy\n```\nx\ny\n```\n> q1\n> q2\n# h\nend')).toBe(
      'a  \nb\n\nc\n- one\n- two  \nlazy\n```\nx\ny\n```\n> q1  \n> q2\n# h\nend')
  })

  it('round-trips thread keys and refuses unknown ones', () => {
    for (const key of ['mattermost:ch1:root1', 'mattermost:ch1:', 'jira:PAY-12', 'gitlab:group/sub/app!42']) expect(threadKey(parseThread(key))).toBe(key)
    expect(() => parseThread('slack:x')).toThrow('Unknown thread key slack:x')
  })
})

describe('a push rejected as not a fast-forward (eval T13.4)', () => {
  it('names the job\'s last pushed commit and how to build on it; other errors pass through', () => {
    const rejected = new Error('git push failed: ! [rejected] 2db2067 -> agent/x (fetch first)')
    const hinted = notFastForward(rejected, 'a'.repeat(40)) as Error
    expect(hinted.message).toContain('! [rejected]')
    expect(hinted.message).toContain(`git reset --soft ${'a'.repeat(40)}`)
    expect(hinted.message).toContain('never force-pushed')
    expect((notFastForward(rejected, undefined) as Error).message).toContain('descendant of the branch\'s current commit')
    const other = new Error('git push failed: could not resolve host')
    expect(notFastForward(other, 'a'.repeat(40))).toBe(other)
  })
})
