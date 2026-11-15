/**
 * Synthetic dashboard data (`D13`, `T15.10`), in the API's own shapes, with the edge cases the approved mockup showed: a gate on
 * another thread than the origin; a job with no ticket (a direct message moved to a channel thread); a question round partly
 * answered, redirected, and an answer taken as an assumption; an approval refused (not an approver); an answer turn on a plan; checks
 * failed then retried; `ci` blocked for days; a token budget used up after an extension; a parked job whose workflow is gone; a job
 * setting up; a running attempt with a running command; a second workflow with two stages (`A6`); cancelled, completed and failed
 * jobs, and one completed with its merge request still open; change proposals (`D12`): a running job with one pending before its
 * approver, and a completed job with one done and one declined, whose review failed once on a finding and then passed with a
 * merge risk and notes (`P16`); a requester whose id did not resolve; a refused connection to a private
 * address; secrets redacted in a message and in evidence; a very long Russian title; a degraded connector, a retrying effect and a kernel error. `many` adds volume (200 jobs).
 * Every name, address and ticket is invented.
 */
import { attempts as attemptsOf, type EventRow, type JobDetail, type JobRow, type MessageRow, type OutboundRow, type SettingsView, type StateView } from '../../src/app/panel-api.ts'
import type { AgentTrace, TraceStep } from '../../src/app/agent-trace.ts'
import type { JobState } from '../../src/domain/job.ts'

const MIN = 60_000
const STD = [{ id: 'inspect', title: 'Анализ требований' }, { id: 'plan', title: 'План реализации' }, { id: 'implement', title: 'Реализация и MR' }, { id: 'review', title: 'Ревью MR' }]
const HOT = [{ id: 'diagnose', title: 'Диагностика' }, { id: 'fix', title: 'Исправление' }]
const MM = 'mattermost:9nq8wi9b8pyniqjq89jueaq9xh'
const PEOPLE = { ir4hha1ut7rofm1ust7qtj11fe: 'dev-ivan', '517b9fdim7rxjpzfajzeqo5kdy': 'lead-1', k3n7c2a9b8d4e5f6g7h8i9j0ka: 'anna.k', q9w8e7r6t5y4u3i2o1p0a9s8dz: 'qa-olga', '6wezgm4tsif9ubs1boudpk381o': 'workbench' }
const IVAN = { source: 'mattermost', id: 'ir4hha1ut7rofm1ust7qtj11fe' }, LEAD = { source: 'mattermost', id: '517b9fdim7rxjpzfajzeqo5kdy' }
const ANNA = { source: 'mattermost', id: 'k3n7c2a9b8d4e5f6g7h8i9j0ka' }, JLEAD = { source: 'jira', id: 'lead-1' }, JIVAN = { source: 'jira', id: 'dev-ivan' }, JANNA = { source: 'jira', id: 'anna.k' }

interface Spec {
  id: string; ticket: string | null; repository: string | null; title: string; status: string; stageId: string | null; detail: string | null
  requester: string; origin: string; gateThread?: string | null; started: number; updated: number; tokens: number; budget: number
  waiting?: JobRow['waiting']; proposals?: JobRow['proposals']; stages?: typeof STD; workflow?: string; version?: number; mergeRequest?: string; risk?: JobRow['risk']; closedBy?: string
}
const row = (spec: Spec): JobRow => ({ id: spec.id, workflowId: spec.workflow ?? 'standard-delivery', workflowVersion: spec.version ?? 7, status: spec.status, stageId: spec.stageId,
  gateId: spec.waiting && spec.waiting.kind !== 'parked' ? `${spec.id}.g1` : null, detail: spec.detail, requester: spec.requester, originThread: spec.origin,
  gateThread: spec.gateThread ?? null, startedAt: spec.started, updatedAt: spec.updated, title: spec.title, ticket: spec.ticket, mergeRequest: spec.mergeRequest ?? null, closedBy: spec.closedBy ?? null, repository: spec.repository,
  tokens: spec.tokens, budget: spec.budget, waiting: spec.waiting ?? null, proposals: spec.proposals ?? null, stages: spec.stages ?? STD, risk: spec.risk ?? null })

/** A job's events from `[minutes ago, type, data]`, in order. */
const events = (now: number, list: readonly [number, string, Record<string, unknown>][]): EventRow[] =>
  list.map(([ago, type, data], index) => ({ seq: index + 1, type, at: now - ago * MIN, causation: `inbox:in_${index}`, data: { v: 1, type, ...data } }))
const post = (now: number, id: string, ago: number, threadKey: string, kind: string, text: string, status = 'succeeded', recorded = true): OutboundRow =>
  ({ id, at: now - ago * MIN, threadKey, status, kind, text, recorded })
const message = (now: number, id: string, ago: number, threadKey: string | null, actor: string | null, text: string, status: string, outcome: unknown, human = true): MessageRow =>
  ({ id, source: threadKey?.split(':')[0] ?? 'mattermost', threadKey, actor, human, receivedAt: now - ago * MIN, text, status, outcome })

const MANIFEST = (stages: readonly { id: string; title: string }[], workflow = 'standard-delivery@13', repository = 'shop/orders-api'): JobDetail['manifest'] => ({
  definition: workflow, hash: 'cf4cbb6bb4e934dca80565d835dfab667340df0804d144ce1411d9cc49d08ce7', verdictModel: 'litellm/deepseek-flash', policyVersion: 'pv_1eeb88bb70db2c4f',
  parameters: { repository, 'repository.name': repository.split('/')[1] ?? repository, targetBranch: 'main', testCommand: 'python -m pytest -q', ci: 'required' },
  stages: stages.map(stage => ({ id: stage.id, title: stage.title, model: 'litellm/deepseek-flash', agentPreset: `workflow-agent-${stage.id === 'implement' || stage.id === 'fix' ? 'implementer' : stage.id === 'review' ? 'reviewer' : 'inspector'}`,
    permissionPreset: stage.id === 'implement' || stage.id === 'review' || stage.id === 'fix' ? 'workflow-agent-worker' : 'workflow-agent-readonly',
    egress: stage.id === 'implement' || stage.id === 'review' || stage.id === 'fix' ? 'registries' : 'none', tools: stage.id === 'implement' ? ['gitlab.createMr'] : [] })),
  budgets: { turns: 400, tokens: 400_000, backtracks: 3 },
})

function detailOf(job: JobRow, state: Partial<JobState> & { status: JobState['status'] }, list: EventRow[], extra: Partial<JobDetail> = {}): JobDetail {
  const full = { v: 1, jobId: job.id, manifestId: `rm_${job.id}`, workflowId: job.workflowId, attemptCount: 0, visitAttempts: 0, questionRounds: 0, gateCount: 0, gates: {}, artifacts: {},
    backtracks: { total: 0, edges: {} }, usage: { turns: 0, tokens: job.tokens }, extended: { turns: 0, tokens: 0, backtracks: 0, attempts: 0 }, inputs: [], bindings: [{ threadKey: job.originThread, role: 'origin' }],
    actions: 0, ...state } as unknown as JobState
  return { job: { ...job, kernelStatus: job.status, version: list.length }, manifest: MANIFEST(job.stages, `${job.workflowId}@${job.workflowVersion}`, `shop/${job.repository ?? 'orders-api'}`),
    state: full, events: list, effects: [], timers: [], artifacts: [], communication: [], outbound: [], attempts: attemptsOf(list, full), egress: [], ...extra }
}

const PLAN = `### Цель
Выгрузка заказов в CSV содержит валюту каждого заказа и корректно отражает возвраты, частичные возвраты и отменённые позиции.

### Что меняется
- \`export/orders_csv.py\`: колонка \`currency\` (ISO 4217 из \`order.currency_code\`, ответ @lead-1 на вопрос 1).
- Частичные возвраты — по строкам: \`unit_price_cents * quantity_refunded\` (допущение: «не знаю, решай сам»).
- Отменённые позиции не входят в сумму, но остаются в выгрузке со статусом \`cancelled\`.

### Порядок колонок
\`\`\`
order_id;created_at;customer_id;line_no;sku;quantity;unit_price_cents;currency;line_type;status;amount_cents
\`\`\`

### Что будет проверено
- \`python -m pytest -q\`: новые **test_export_currency**, **test_export_refunds_partial**.
- CI: обязательный пайплайн merge request.

### Откат
Флаг \`EXPORT_CSV_V2=false\` возвращает прежний формат.`

export interface DashboardFixture {
  readonly state: StateView
  readonly details: Readonly<Record<string, JobDetail>>
  readonly traces: Readonly<Record<string, AgentTrace>>
  readonly inbox: { readonly messages: readonly MessageRow[] }
  readonly settings: SettingsView
}

type Unplaced<S> = S extends unknown ? Omit<S, 'seq' | 'at'> : never
const step = (seq: number, at: number, value: Unplaced<TraceStep>): TraceStep => ({ seq, at, ...value }) as TraceStep

export function dashboardFixture(now = Date.now(), { many = false, empty = false } = {}): DashboardFixture {
  const ago = (minutes: number) => now - minutes * MIN
  const jobs: JobRow[] = []
  const details: Record<string, JobDetail> = {}
  const traces: Record<string, AgentTrace> = {}

  // ORD-298: blocked for days on a CI pipeline that never started; asks its approvers in its Mattermost thread (not the origin, Jira).
  {
    const thread = `${MM}:fpfb7y18u7b3ibr6tkzkfdagah`, mr = 'gitlab:shop/orders-api!41'
    const job = row({ id: 'job_0mwf3x5c40000p5ly4m', ticket: 'ORD-298', repository: 'orders-api', title: 'Экспорт заказов в CSV: добавить колонку с валютой и учесть возвраты, частичные возвраты и отменённые позиции заказа',
      status: 'blocked', stageId: 'implement', detail: 'checks_blocked', requester: 'jira:dev-ivan', origin: 'jira:ORD-298', gateThread: thread, mergeRequest: mr, started: ago(4900), updated: ago(4560),
      tokens: 351_000, budget: 400_000, waiting: { kind: 'resume', subject: 'checks_blocked', who: ['lead-1'], thread, since: ago(4560) } })
    const list = events(now, [
      [4900, 'JobStarted', { intake: { actor: JIVAN, threadKey: 'jira:ORD-298', text: '@workbench сделай, подробности в описании' } }],
      [4899, 'ChatOpened', { threadKey: thread }], [4898, 'SetupStarted', { n: 1 }],
      [4897, 'SetupCompleted', { n: 1, toolchains: [{ tool: 'python', requested: '3.12', from: '.python-version', version: '3.12.16', bin: '/x' }], ignored: [], evidence: 'python 3.12.16 installed in 71 s' }],
      [4896, 'AttemptStarted', { attemptId: 'job_0mwf3x5c40000p5ly4m.a1', stageId: 'inspect', n: 1, entry: 'initial' }],
      [4881, 'UsageRecorded', { attemptId: 'job_0mwf3x5c40000p5ly4m.a1', turns: 9, tokens: 18_000, added: { turns: 9, tokens: 18_000 } }],
      [4881, 'AttemptReported', { attemptId: 'job_0mwf3x5c40000p5ly4m.a1', report: { outcome: 'question', summary: 'Неясно, откуда валюта и как считать частичный возврат', items: [] } }],
      [4880, 'GateOpened', { gate: { id: 'g1', kind: 'question', stageId: 'inspect', threadKey: thread, openedAt: ago(4880), status: 'open', responses: [], interpreting: [],
        items: [{ text: 'Валюта — из заказа или из настроек магазина? @lead-1' }, { text: 'Частичный возврат — по строкам или одной суммой? @dev-ivan' }] } }],
      [4861, 'AnswersRecorded', { gateId: 'g1', actor: LEAD, answers: [{ item: 1, text: 'ISO-код из заказа, не из настроек магазина.' }], redirects: [] }],
      [4839, 'AnswersRecorded', { gateId: 'g1', actor: IVAN, answers: [{ item: 2, text: 'не знаю, решай сам (принято как допущение)' }], redirects: [] }],
      [4838, 'GateClosed', { gateId: 'g1', status: 'answered' }],
      [4830, 'AttemptStarted', { attemptId: 'job_0mwf3x5c40000p5ly4m.a2', stageId: 'plan', n: 1, entry: 'answer' }],
      [4801, 'UsageRecorded', { attemptId: 'job_0mwf3x5c40000p5ly4m.a2', turns: 12, tokens: 31_000, added: { turns: 12, tokens: 31_000 } }],
      [4801, 'AttemptReported', { attemptId: 'job_0mwf3x5c40000p5ly4m.a2', report: { outcome: 'completed', summary: 'План r1: валюта, возвраты, флаг отката' } }],
      [4801, 'ArtifactRecorded', { revision: { kind: 'plan', n: 1, digest: '9f2c41'.padEnd(64, '0') } }],
      [4800, 'GateOpened', { gate: { id: 'g2', kind: 'approval', stageId: 'plan', threadKey: 'jira:ORD-298', openedAt: ago(4800), status: 'open', responses: [], interpreting: [], subject: { kind: 'plan', n: 1 } } }],
      [4785, 'AnswerRequested', { answerId: 'q1', actor: JANNA, threadKey: 'jira:ORD-298', question: 'Ок, но частичные возвраты как считаем — по строкам?' }],
      [4783, 'AnswerGiven', { answerId: 'q1', threadKey: 'jira:ORD-298', text: 'Да, по строкам: unit_price_cents × quantity_refunded. Это допущение из ответа на вопрос 2.', tokens: 3100 }],
      [4779, 'GateResponded', { gateId: 'g2', response: { eventId: 'in_x', actor: JIVAN, accepted: false, reason: 'not an eligible approver' }, text: 'ок' }],
      [4762, 'GateResponded', { gateId: 'g2', response: { eventId: 'in_y', actor: JLEAD, accepted: true, reason: 'approve' }, text: 'ок, согласовано' }],
      [4762, 'GateClosed', { gateId: 'g2', status: 'satisfied', by: JLEAD }],
      [4740, 'AttemptStarted', { attemptId: 'job_0mwf3x5c40000p5ly4m.a3', stageId: 'implement', n: 1, entry: 'next' }],
      [4702, 'UsageRecorded', { attemptId: 'job_0mwf3x5c40000p5ly4m.a3', turns: 41, tokens: 92_000, added: { turns: 41, tokens: 92_000 } }],
      [4702, 'AttemptReported', { attemptId: 'job_0mwf3x5c40000p5ly4m.a3', report: { outcome: 'completed', summary: 'Колонка currency, line_type, amounts.py; тесты добавлены' } }],
      [4700, 'VerificationStarted', { attemptId: 'job_0mwf3x5c40000p5ly4m.a3', stageId: 'implement', checks: [{ id: 'tests' }] }],
      [4690, 'CheckCompleted', { attemptId: 'job_0mwf3x5c40000p5ly4m.a3', checkId: 'tests', outcome: 'failed',
        evidence: 'FAILED tests/test_export.py::test_export_currency\nE    assert row[7] == "RUB"\nE    AssertionError: \'\' != \'RUB\'\nFAILED tests/test_export.py::test_export_refunds_partial\n2 failed, 214 passed in 9.81s' }],
      [4688, 'AttemptStarted', { attemptId: 'job_0mwf3x5c40000p5ly4m.a4', stageId: 'implement', n: 2, entry: 'retry' }],
      [4620, 'ThreadBound', { threadKey: mr, role: 'artifact' }],
      [4645, 'UsageRecorded', { attemptId: 'job_0mwf3x5c40000p5ly4m.a4', turns: 52, tokens: 210_000, added: { turns: 52, tokens: 118_000 } }],
      [4644, 'AttemptReported', { attemptId: 'job_0mwf3x5c40000p5ly4m.a4', report: { outcome: 'completed', summary: 'currency_code с подстановкой RUB; частичный возврат по quantity_refunded' } }],
      [4600, 'CheckCompleted', { attemptId: 'job_0mwf3x5c40000p5ly4m.a4', checkId: 'tests', outcome: 'passed', evidence: '217 passed in 9.62s' }],
      [4600, 'CheckCompleted', { attemptId: 'job_0mwf3x5c40000p5ly4m.a4', checkId: 'test integrity', outcome: 'passed', evidence: 'no test removed, skipped or weakened' }],
      [4598, 'AnswerRequested', { answerId: 'q2', actor: { source: 'gitlab', id: 'lead-1' }, threadKey: mr, question: 'Почему разделитель «;», а не «,»?' }],
      [4596, 'AnswerGiven', { answerId: 'q2', threadKey: mr, text: 'Так в плане: Excel в русской локали открывает «;» без мастера импорта.', tokens: 2400 }],
      [4561, 'CheckCompleted', { attemptId: 'job_0mwf3x5c40000p5ly4m.a4', checkId: 'ci', outcome: 'blocked',
        evidence: 'GET https://ci.example.test/api/v4/projects/shop%2Forders-api/pipelines?ref=agent/ord-298&private_token=[REDACTED]\n→ 200 []  (polled 30 times over 15 min)' }],
      [4560, 'Blocked', { reason: { kind: 'checks_blocked', stageId: 'implement', checks: ['ci'], detail: 'no pipeline started on !41 within 15 min' }, gateId: 'g3', at: ago(4560) }],
      [4560, 'GateOpened', { gate: { id: 'g3', kind: 'resume', stageId: 'implement', threadKey: thread, openedAt: ago(4560), status: 'open', responses: [], interpreting: [] } }],
    ])
    const state = { status: { kind: 'blocked', reason: { kind: 'checks_blocked', stageId: 'implement', checks: ['ci'], detail: 'no pipeline started on !41 within 15 min' }, gateId: 'g3', since: ago(4560) },
      gates: { g3: { id: 'g3', kind: 'resume', stageId: 'implement', threadKey: thread, openedAt: ago(4560), status: 'open', responses: [], interpreting: [] } },
      bindings: [{ threadKey: 'jira:ORD-298', role: 'origin' }, { threadKey: mr, role: 'artifact' }], chatThread: thread } as never
    details[job.id] = detailOf(job, state, list, {
      outbound: [post(now, 'p1', 4899, thread, 'chat', '🧵 Задача [ORD-298](https://jira.example.test/browse/ORD-298) от @dev-ivan.\n💬 Вопросы по ней — в этой ветке.', 'succeeded', false),
        post(now, 'p2', 4880, thread, 'question', '❓ Нужны ответы:\n\n1. Валюта — из заказа или из настроек магазина? @lead-1\n2. Частичный возврат — по строкам или одной суммой? @dev-ivan\n\n'
          + '👉 Отвечайте в этой ветке, можно частями: «1: …, 2: …».'),
        post(now, 'p3', 4800, 'jira:ORD-298', 'approval', `📋 **План, ревизия 1 — План r1** — нужно ваше решение.\n\n---\n\n${PLAN}\n\n---\n\n`
          + '🧪 **Тесты:** `python -m pytest -q`: test_export_currency, test_export_refunds_partial\n\n👉 Ответьте комментарием: «ок» — одобрить; вопрос — уточнить; иначе — что изменить.'),
        post(now, 'p4', 4799, thread, 'planPosted', '📋 **План, ревизия 1** — в задаче [ORD-298](https://jira.example.test/browse/ORD-298).\n\n👉 Обсуждение и одобрение — там.'),
        post(now, 'p5', 4560, thread, 'resume', '⏸ **Работа остановлена:** проверки (ci) не дали результата по причине окружения, а не кода.\n\n> no pipeline started on !41 within 15 min\n\n'
          + '👉 Когда причина устранена, ответьте «ок», чтобы перезапустить проверки на том же коммите, или «стоп», чтобы отменить задачу.')],
      communication: [message(now, 'in_1', 4900, 'jira:ORD-298', 'jira:dev-ivan', '@workbench сделай, подробности в описании', 'routed', { jobId: job.id }),
        message(now, 'in_2', 4861, thread, `mattermost:${LEAD.id}`, '1: ISO-код из заказа.', 'routed', { jobId: job.id }),
        message(now, 'in_3', 4839, thread, `mattermost:${IVAN.id}`, 'не знаю, решай сам', 'routed', { jobId: job.id }),
        message(now, 'in_4', 4785, 'jira:ORD-298', 'jira:anna.k', 'Ок, но частичные возвраты как считаем — по строкам?', 'routed', { jobId: job.id }),
        message(now, 'in_5', 4779, 'jira:ORD-298', 'jira:dev-ivan', 'ок', 'routed', { jobId: job.id }),
        message(now, 'in_6', 4762, 'jira:ORD-298', 'jira:lead-1', 'ок, согласовано', 'routed', { jobId: job.id })],
      artifacts: [{ kind: 'requirements', n: 1, digest: '1c7d0e'.padEnd(64, '1'), title: 'Анализ требований', text: '### Требования\n- Колонка `currency`.\n- Возвраты — отдельными строками.\n\n### Вопросы и ответы\n- 1 — @lead-1: из заказа.\n- 2 — @dev-ivan: «не знаю, решай сам» → по строкам.' },
        { kind: 'plan', n: 1, digest: '9f2c41'.padEnd(64, '0'), title: 'План r1', text: PLAN }],
      egress: [
        ...Array.from({ length: 41 }, (_, index) => ({ at: ago(4720 - index), attemptId: `${job.id}.a${index < 20 ? 3 : 4}`, host: 'files.pythonhosted.org', port: 443, address: '151.101.0.223', allowed: true, reason: 'allowed' })),
        { at: ago(4650), attemptId: `${job.id}.a3`, host: 'pypi-mirror.corp.internal', port: 443, address: '10.12.4.7', allowed: false, reason: '10.12.4.7 is a private address' },
        { at: ago(4681), attemptId: `${job.id}.a4`, host: 'registry.npmjs.org', port: 443, address: null, allowed: false, reason: 'registry.npmjs.org is not on this job\'s allowlist (registries: pypi)' },
        { at: ago(4897), attemptId: 'setup', host: 'downloads.python.org', port: 443, address: '151.101.64.223', allowed: true, reason: 'allowed' }],
      timers: [{ kind: 'gate.reminder', subject: 'g3', dueAt: now + 50 * MIN, status: 'armed' }],
    })
    jobs.push(job)
    const a4 = details[job.id]!.attempts.find(attempt => attempt.id.endsWith('a4'))!
    const t0 = a4.startedAt, s = (seconds: number) => t0 + seconds * 1000
    traces[a4.sessionId] = { sessionId: a4.sessionId, steps: [
      step(1, s(0), { kind: 'input', text: '# Повтор после проверки tests\n\nДва теста упали: test_export_currency, test_export_refunds_partial. Доказательства ниже.\n\nFAILED tests/test_export.py::test_export_currency' }),
      step(2, s(4), { kind: 'text', text: 'Повтор после проверки tests: currency пустая, а сумма частичного возврата вдвое меньше ожидаемой. Начну с currency.', usage: { input: 5400, output: 120, cached: 3200 } }),
      step(3, s(20), { kind: 'tool', callId: 'c1', name: 'read', args: { file_path: 'export/orders_csv.py', offset: 20, limit: 60 }, result: '<path>export/orders_csv.py</path>…', durationMs: 40 }),
      step(4, s(65), { kind: 'text', text: 'Сериализатор берёт order.currency, а после миграции 0042 поле называется currency_code. Для заказов до 2024 года — RUB, как в плане.' }),
      step(5, s(100), { kind: 'tool', callId: 'c2', name: 'grep', args: { pattern: 'currency_code', path: 'export' }, result: 'export/orders_csv.py:52\nexport/models.py:18\nmigrations/0042.py:9', durationMs: 120 }),
      step(6, s(150), { kind: 'tool', callId: 'c3', name: 'edit', args: { file_path: 'export/orders_csv.py', old_string: '        currency=order.currency,', new_string: '        currency=order.currency_code or LEGACY_CURRENCY,' }, result: 'ok', durationMs: 30 }),
      step(7, s(190), { kind: 'tool', callId: 'c4', name: 'bash', args: { command: 'python -m pytest -q tests/test_export.py::test_export_currency' }, result: '1 passed in 0.81s', durationMs: 1800 }),
      step(8, s(315), { kind: 'tool', callId: 'c5', name: 'edit', args: { file_path: 'export/amounts.py', old_string: '        return -line.unit_price_cents * line.quantity', new_string: '        return -line.unit_price_cents * line.quantity_refunded' }, result: 'ok', durationMs: 25 }),
      step(9, s(390), { kind: 'tool', callId: 'c6', name: 'bash', args: { command: 'python -m pytest -q' }, result: '217 passed in 9.62s', durationMs: 10_400 }),
      step(10, s(432), { kind: 'tool', callId: 'c7', name: 'bash', args: { command: 'npx --yes prettier --check docs/export.md' }, error: true, durationMs: 1200,
        result: 'workbench-egress: refused: registry.npmjs.org is not on this job\'s allowlist (registries: pypi)' }),
      step(11, s(460), { kind: 'text', text: 'npm этому репозиторию недоступен — так задумано, в профиле только pypi. Проверять форматирование Markdown не обязательно.' }),
      step(12, s(545), { kind: 'tool', callId: 'c8', name: 'write', args: { file_path: 'docs/export.md', content: '| currency | ISO 4217 |\n| line_type | sale, refund |\n| amount_cents | со знаком |' }, result: 'ok' }),
      step(13, s(680), { kind: 'tool', callId: 'c9', name: 'gitlab_push', args: { branch: 'agent/ord-298-eksport', message: 'ORD-298: валюта и возвраты в CSV' }, result: 'pushed 3f9a1c2', durationMs: 3400 }),
      step(14, s(730), { kind: 'tool', callId: 'c10', name: 'workbench_stage_report', args: { outcome: 'completed', summary: 'currency_code с подстановкой RUB; частичный возврат по quantity_refunded; docs' }, result: 'recorded' }),
      step(15, s(731), { kind: 'end', reason: 'completed' }),
    ] }
  }

  // ORD-312: plan r2 waits for its approver in Jira; r1 was sent back.
  {
    const job = row({ id: 'job_0mwg11aa0000ord312', ticket: 'ORD-312', repository: 'orders-api', title: 'Скидка по промокоду не должна опускать заказ ниже минимальной суммы', status: 'awaiting_gate',
      stageId: 'plan', detail: 'approval', requester: 'jira:dev-ivan', origin: 'jira:ORD-312', gateThread: 'jira:ORD-312', started: ago(300), updated: ago(134), tokens: 96_000, budget: 400_000,
      waiting: { kind: 'approval', subject: 'plan r2', who: ['lead-1'], thread: 'jira:ORD-312', since: ago(134) } })
    const list = events(now, [[300, 'JobStarted', { intake: { actor: JIVAN, threadKey: 'jira:ORD-312', text: '@workbench сделай' } }],
      [296, 'AttemptStarted', { attemptId: `${job.id}.a1`, stageId: 'inspect', n: 1, entry: 'initial' }], [282, 'AttemptReported', { attemptId: `${job.id}.a1`, report: { outcome: 'completed', summary: 'Требования ясны, вопросов нет' } }],
      [240, 'AttemptStarted', { attemptId: `${job.id}.a2`, stageId: 'plan', n: 1, entry: 'next' }], [221, 'AttemptReported', { attemptId: `${job.id}.a2`, report: { outcome: 'completed', summary: 'План r1' } }],
      [220, 'GateOpened', { gate: { id: 'g1', kind: 'approval', stageId: 'plan', threadKey: 'jira:ORD-312', openedAt: ago(220), subject: { kind: 'plan', n: 1 } } }],
      [171, 'GateResponded', { gateId: 'g1', response: { eventId: 'e', actor: JLEAD, accepted: true, reason: 'request_changes' }, text: 'Порог считаем после скидки, а не до. Переделай.' }],
      [171, 'GateClosed', { gateId: 'g1', status: 'changes_requested', by: JLEAD }],
      [150, 'AttemptStarted', { attemptId: `${job.id}.a3`, stageId: 'plan', n: 2, entry: 'revision' }], [135, 'UsageRecorded', { attemptId: `${job.id}.a3`, turns: 13, tokens: 44_000, added: { turns: 13, tokens: 44_000 } }],
      [135, 'AttemptReported', { attemptId: `${job.id}.a3`, report: { outcome: 'completed', summary: 'План r2: порог после промокода' } }],
      [134, 'GateOpened', { gate: { id: 'g2', kind: 'approval', stageId: 'plan', threadKey: 'jira:ORD-312', openedAt: ago(134), subject: { kind: 'plan', n: 2 } } }]])
    details[job.id] = detailOf(job, { status: { kind: 'awaiting_gate', gateId: 'g2', stageId: 'plan' },
      gates: { g2: { id: 'g2', kind: 'approval', stageId: 'plan', threadKey: 'jira:ORD-312', openedAt: ago(134), status: 'open', responses: [], interpreting: [] } } } as never, list, {
      outbound: [post(now, 'p1', 220, 'jira:ORD-312', 'approval', '📋 **План, ревизия 1 — План r1** — нужно ваше решение.\n\n---\n\n### Шаги\n- Проверять порог до промокода.\n\n---\n\n👉 Ответьте комментарием: «ок» — одобрить; вопрос — уточнить; иначе — что изменить.'),
        post(now, 'p2', 134, 'jira:ORD-312', 'approval', '📋 **План, ревизия 2 — План r2** — нужно ваше решение.\n\n---\n\n### Шаги\n- Проверять порог **после** промокода.\n- Тесты `test_promo_exact_threshold`.\n\n---\n\n'
          + '👉 Ответьте комментарием: «ок» — одобрить; вопрос — уточнить; иначе — что изменить.')],
      artifacts: [{ kind: 'plan', n: 1, digest: '77c0aa'.padEnd(64, '2'), title: 'План r1', text: '### Шаги\n- Проверять порог до промокода.' },
        { kind: 'plan', n: 2, digest: 'a41f09'.padEnd(64, '3'), title: 'План r2', text: '### Шаги\n- Проверять порог **после** промокода.\n- Тесты `test_promo_exact_threshold`.' }] })
    jobs.push(job)
  }

  // A direct message with no ticket: its questions moved to a thread in the repository's channel; one answered, one redirected.
  {
    const dm = `${MM}:dm7f3a0`, thread = `${MM}:k1r8w2nqe4`
    const job = row({ id: 'job_0mwh2dm7f3', ticket: null, repository: 'orders-api', title: 'почини флейки тест test_refund_partial, падает примерно раз в 10 прогонов на CI, локально не воспроизводится',
      status: 'awaiting_gate', stageId: 'inspect', detail: 'question', requester: `mattermost:${IVAN.id}`, origin: dm, gateThread: thread, started: ago(95), updated: ago(17), tokens: 14_000, budget: 400_000,
      waiting: { kind: 'question', subject: '1/3', who: [], thread, since: ago(70) } })
    const list = events(now, [[95, 'JobStarted', { intake: { actor: IVAN, threadKey: dm, text: 'почини флейки тест test_refund_partial. токен для стенда: [REDACTED]' } }],
      [94, 'ChatOpened', { threadKey: thread }], [78, 'AttemptStarted', { attemptId: `${job.id}.a1`, stageId: 'inspect', n: 1, entry: 'initial' }],
      [71, 'AttemptReported', { attemptId: `${job.id}.a1`, report: { outcome: 'question', summary: 'Три вопроса о раннере, фикстурах и релизе' } }],
      [70, 'GateOpened', { gate: { id: 'g1', kind: 'question', stageId: 'inspect', threadKey: thread, openedAt: ago(70), items: [{ text: 'На каком раннере падает — shared или docker?' },
        { text: 'Можно ли менять порядок фикстур в conftest?' }, { text: 'Нужен ли фикс в релиз 4.12?' }] } }],
      [52, 'AnswersRecorded', { gateId: 'g1', actor: IVAN, answers: [{ item: 1, text: 'docker-раннеры' }], redirects: [{ item: 2, to: '@anna.k' }] }],
      [18, 'AnswerRequested', { answerId: 'q1', actor: ANNA, threadKey: thread, question: 'а что значит «порядок фикстур»? autouse?' }],
      [17, 'AnswerGiven', { answerId: 'q1', threadKey: thread, text: 'Да: autouse-фикстура reset_clock сейчас идёт после db_session; хочу поменять их местами.', tokens: 1200 }]])
    details[job.id] = detailOf(job, { status: { kind: 'awaiting_gate', gateId: 'g1', stageId: 'inspect' },
      gates: { g1: { id: 'g1', kind: 'question', stageId: 'inspect', threadKey: thread, openedAt: ago(70), status: 'open', responses: [], interpreting: [] } }, chatThread: thread } as never, list, {
      outbound: [post(now, 'p1', 94, thread, 'chat', '🧵 Новая задача от @dev-ivan.\n💬 Вопросы по ней — в этой ветке.'),
        post(now, 'p2', 51, thread, 'answersRecorded', '✅ Принял ответы: 1.\n↪️ Передал вопрос 2 → @anna.k: Можно ли менять порядок фикстур в conftest?\n⏳ Жду ответов: 2, 3.')],
      communication: [message(now, 'in_1', 95, dm, `mattermost:${IVAN.id}`, 'почини флейки тест test_refund_partial. токен для стенда: [REDACTED]', 'routed', { jobId: job.id }),
        message(now, 'in_2', 52, thread, `mattermost:${IVAN.id}`, '1: docker-раннеры. про 2 спроси @anna.k', 'routed', { jobId: job.id }),
        message(now, 'in_3', 18, thread, `mattermost:${ANNA.id}`, 'а что значит «порядок фикстур»? autouse?', 'routed', { jobId: job.id })] })
    jobs.push(job)
  }

  // ORD-305: the token budget used up again after a 100k extension, after a backtrack from review to plan.
  {
    const thread = `${MM}:b7aa21x0`
    const job = row({ id: 'job_0mwh9bill305', ticket: 'ORD-305', repository: 'billing-api', title: 'Округление НДС в счёте до копеек по строкам, а не по итогу', status: 'blocked', stageId: 'review',
      detail: 'budget', requester: `mattermost:${ANNA.id}`, origin: thread, gateThread: thread, started: ago(1260), updated: ago(41), tokens: 512_000, budget: 500_000,
      waiting: { kind: 'resume', subject: 'budget', who: ['lead-1'], thread, since: ago(41) } })
    const list = events(now, [[1260, 'JobStarted', { intake: { actor: ANNA, threadKey: thread, text: '@workbench repo:billing-api ORD-305' } }],
      [700, 'Backtracked', { from: 'review', to: 'plan', reason: 'Округление по строкам расходится со сверкой 1С на копейку в 3 из 40 счетов.' }],
      [420, 'Blocked', { reason: { kind: 'budget', budget: 'tokens' }, gateId: 'g4', at: ago(420) }],
      [390, 'BudgetExtended', { reason: { kind: 'budget', budget: 'tokens' }, by: LEAD, added: { tokens: 100_000 } }],
      [75, 'AttemptStarted', { attemptId: `${job.id}.a7`, stageId: 'review', n: 2, entry: 'backtrack' }],
      [42, 'UsageRecorded', { attemptId: `${job.id}.a7`, turns: 61, tokens: 90_000, added: { turns: 61, tokens: 90_000 } }],
      [41, 'Blocked', { reason: { kind: 'budget', budget: 'tokens' }, gateId: 'g9', at: ago(41) }],
      [41, 'GateOpened', { gate: { id: 'g9', kind: 'resume', stageId: 'review', threadKey: thread, openedAt: ago(41) } }]])
    details[job.id] = detailOf(job, { status: { kind: 'blocked', reason: { kind: 'budget', budget: 'tokens' }, gateId: 'g9', since: ago(41) },
      gates: { g9: { id: 'g9', kind: 'resume', stageId: 'review', threadKey: thread, openedAt: ago(41), status: 'open', responses: [], interpreting: [] } },
      extended: { turns: 0, tokens: 100_000, backtracks: 0, attempts: 0 }, backtracks: { total: 1, edges: { 'review>plan': 1 } } } as never, list,
    { outbound: [post(now, 'p1', 41, thread, 'blocked', '⏸ **Работа остановлена:** закончился бюджет токенов.\n\n👉 Ответьте «ок», чтобы продлить (+100000 токенов), или «стоп», чтобы отменить задачу.')] })
    jobs.push(job)
  }

  // ORD-309: parked; the deployment no longer registers the workflow version its manifest pins.
  {
    const job = row({ id: 'job_0mwh0park309', ticket: 'ORD-309', repository: null, title: 'Фильтр по статусу оплаты в отчёте по заказам', status: 'parked', stageId: 'inspect',
      detail: 'standard-delivery@6', requester: 'jira:lead-1', origin: 'jira:ORD-309', started: ago(1520), updated: ago(1450), tokens: 0, budget: 0, stages: [], version: 6,
      waiting: { kind: 'parked', subject: 'standard-delivery@6', who: [], thread: null, since: ago(1450) } })
    details[job.id] = detailOf(job, { status: { kind: 'parked', missing: ['standard-delivery@6'], since: ago(1450) } } as never,
      events(now, [[1520, 'JobStarted', { intake: { actor: JLEAD, threadKey: 'jira:ORD-309', text: '@workbench сделай' } }], [1450, 'Parked', { missing: ['standard-delivery@6'], stageId: 'inspect', attemptId: 'x' }]]))
    jobs.push(job)
  }

  // ORD-314: setting up its toolchains.
  {
    const job = row({ id: 'job_0mwh4set314', ticket: 'ORD-314', repository: 'orders-api', title: 'Пагинация в /orders: курсор вместо offset', status: 'setting_up', stageId: null, detail: 'setup 1',
      requester: 'jira:dev-ivan', origin: 'jira:ORD-314', started: ago(5), updated: ago(4), tokens: 0, budget: 400_000 })
    details[job.id] = detailOf(job, { status: { kind: 'setting_up', n: 1, since: ago(4) } } as never,
      events(now, [[5, 'JobStarted', { intake: { actor: JIVAN, threadKey: 'jira:ORD-314', text: '@workbench сделай' } }], [4, 'SetupStarted', { n: 1 }]]),
    { egress: [{ at: ago(3), attemptId: 'setup', host: 'nodejs.org', port: 443, address: '104.20.22.46', allowed: true, reason: 'allowed' }] })
    jobs.push(job)
  }

  // ORD-301: implement, attempt 3 after two failed checks; its trace ends in a command still running.
  {
    const job = row({ id: 'job_0mwh5run301', ticket: 'ORD-301', repository: 'orders-api', title: 'Повторная отправка webhook при 5xx с экспоненциальной задержкой', status: 'running', stageId: 'implement',
      detail: null, requester: `mattermost:${LEAD.id}`, origin: `${MM}:r01x77ya`, started: ago(410), updated: ago(1), tokens: 210_000, budget: 400_000 })
    const list = events(now, [[410, 'JobStarted', { intake: { actor: LEAD, threadKey: `${MM}:r01x77ya`, text: '@workbench ORD-301' } }],
      [200, 'AttemptStarted', { attemptId: `${job.id}.a3`, stageId: 'implement', n: 1, entry: 'next' }], [160, 'CheckCompleted', { attemptId: `${job.id}.a3`, checkId: 'tests', outcome: 'failed', evidence: 'E   assert 312.4 <= 300\nFAILED tests/test_retry.py::test_retry_backoff_cap' }],
      [150, 'AttemptStarted', { attemptId: `${job.id}.a4`, stageId: 'implement', n: 2, entry: 'retry' }], [120, 'CheckCompleted', { attemptId: `${job.id}.a4`, checkId: 'tests', outcome: 'failed', evidence: 'E   assert 305.0 <= 300' }],
      [5, 'AttemptStarted', { attemptId: `${job.id}.a5`, stageId: 'implement', n: 3, entry: 'retry' }], [1, 'UsageRecorded', { attemptId: `${job.id}.a5`, turns: 41, tokens: 58_000, added: { turns: 1, tokens: 900 } }]])
    const detail = detailOf(job, { status: { kind: 'running', stageId: 'implement', attemptId: `${job.id}.a5` }, attempt: { id: `${job.id}.a5`, ended: false } } as never, list)
    details[job.id] = detail
    jobs.push(job)
    const a5 = detail.attempts.at(-1)!
    traces[a5.sessionId] = { sessionId: a5.sessionId, steps: [
      step(1, a5.startedAt + 2000, { kind: 'text', text: 'Третья попытка: потолок задержки применяется до jitter, а должен после.' }),
      step(2, a5.startedAt + 35_000, { kind: 'tool', callId: 'c1', name: 'read', args: { file_path: 'webhooks/retry.py' }, result: '…', durationMs: 30 }),
      step(3, a5.startedAt + 120_000, { kind: 'tool', callId: 'c2', name: 'edit', args: { file_path: 'webhooks/retry.py', old_string: '    delay = min(base * 2 ** attempt, CAP) + jitter()', new_string: '    delay = min(base * 2 ** attempt + jitter(), CAP)' }, result: 'ok' }),
      step(4, a5.startedAt + 200_000, { kind: 'tool', callId: 'c3', name: 'bash', args: { command: 'python -m pytest -q' } }),
    ] }
  }

  // HOT-17: a second workflow, two stages, verifying (`A6`).
  {
    const job = row({ id: 'job_0mwh6hot17', ticket: 'HOT-17', repository: 'payments-gw', title: 'Таймаут при обращении к банку-эквайеру после смены сертификата', status: 'verifying', stageId: 'fix',
      detail: null, requester: `mattermost:${ANNA.id}`, origin: `${MM}:h0t17aa`, started: ago(95), updated: ago(12), tokens: 58_000, budget: 150_000, stages: HOT, workflow: 'synthetic-hotfix', version: 2 })
    details[job.id] = detailOf(job, { status: { kind: 'verifying', stageId: 'fix', attemptId: `${job.id}.a2`, checks: ['tests', 'ci'] } } as never,
      events(now, [[95, 'JobStarted', { intake: { actor: ANNA, threadKey: `${MM}:h0t17aa`, text: '@workbench hotfix: таймауты к эквайеру после ротации сертификата' } }],
        [90, 'AttemptStarted', { attemptId: `${job.id}.a1`, stageId: 'diagnose', n: 1, entry: 'initial' }], [70, 'AttemptReported', { attemptId: `${job.id}.a1`, report: { outcome: 'completed', summary: 'Причина: старый CA в trust store' } }],
        [60, 'AttemptStarted', { attemptId: `${job.id}.a2`, stageId: 'fix', n: 1, entry: 'next' }], [12, 'VerificationStarted', { attemptId: `${job.id}.a2`, stageId: 'fix', checks: [{ id: 'tests' }, { id: 'ci' }] }]]))
    details[job.id] = { ...details[job.id]!, manifest: { ...details[job.id]!.manifest, budgets: { turns: 150, tokens: 150_000, backtracks: 1 } } }
    jobs.push(job)
  }

  // ORD-300: implementing, while a change to the requirements asked on the merge request waits for the approver in the ticket (`D12`).
  {
    const thread = `${MM}:p300chat`, mr = 'gitlab:shop/orders-api!46', GANNA = { source: 'gitlab', id: 'anna.k' }
    const proposal = { id: 'p1', text: 'Добавьте ещё фильтр по SKU: без него выгрузка складу не подходит.', by: GANNA, thread: mr, replyTo: 'disc-7', at: ago(25), status: 'pending' }
    const gate = { id: 'g2', kind: 'proposal', stageId: 'implement', threadKey: 'jira:ORD-300', openedAt: ago(25), status: 'open', responses: [], interpreting: [] }
    const job = row({ id: 'job_0mwh7prop300', ticket: 'ORD-300', repository: 'orders-api', title: 'Фильтр выгрузки заказов по складу', status: 'running', stageId: 'implement', detail: null,
      requester: 'jira:dev-ivan', origin: 'jira:ORD-300', mergeRequest: mr, started: ago(240), updated: ago(2), tokens: 141_000, budget: 400_000,
      proposals: { kind: 'proposal', subject: '1', who: ['lead-1'], thread: 'jira:ORD-300', since: ago(25) } })
    const list = events(now, [[240, 'JobStarted', { intake: { actor: JIVAN, threadKey: 'jira:ORD-300', text: '@workbench сделай' } }], [239, 'ChatOpened', { threadKey: thread }],
      [236, 'AttemptStarted', { attemptId: `${job.id}.a1`, stageId: 'inspect', n: 1, entry: 'initial' }], [220, 'AttemptReported', { attemptId: `${job.id}.a1`, report: { outcome: 'completed', summary: 'Требования ясны' } }],
      [218, 'AttemptStarted', { attemptId: `${job.id}.a2`, stageId: 'plan', n: 1, entry: 'next' }], [200, 'AttemptReported', { attemptId: `${job.id}.a2`, report: { outcome: 'completed', summary: 'План r1: параметр warehouse_id' } }],
      [199, 'GateOpened', { gate: { id: 'g1', kind: 'approval', stageId: 'plan', threadKey: 'jira:ORD-300', openedAt: ago(199), subject: { kind: 'plan', n: 1 } } }],
      [180, 'GateResponded', { gateId: 'g1', response: { eventId: 'e1', actor: JLEAD, accepted: true, reason: 'approve' }, text: 'ок' }], [180, 'GateClosed', { gateId: 'g1', status: 'satisfied', by: JLEAD }],
      [178, 'AttemptStarted', { attemptId: `${job.id}.a3`, stageId: 'implement', n: 1, entry: 'next' }], [60, 'ThreadBound', { threadKey: mr, role: 'artifact' }],
      [25, 'ProposalRaised', { proposal, eventId: 'in_p1' }], [25, 'GateOpened', { gate }],
      [2, 'UsageRecorded', { attemptId: `${job.id}.a3`, turns: 38, tokens: 97_000, added: { turns: 1, tokens: 1100 } }]])
    details[job.id] = detailOf(job, { status: { kind: 'running', stageId: 'implement', attemptId: `${job.id}.a3` }, attempt: { id: `${job.id}.a3`, ended: false }, gates: { g2: gate }, proposals: [proposal],
      bindings: [{ threadKey: 'jira:ORD-300', role: 'origin' }, { threadKey: mr, role: 'artifact' }], chatThread: thread } as never, list, {
      outbound: [post(now, 'p1', 25, 'jira:ORD-300', 'proposalAsk', '🔁 [~lead-1], anna.k просит изменить требования — учесть в плане?\n\n> Добавьте ещё фильтр по SKU: без него выгрузка складу не подходит.\n\n👉 Ответьте «да» или «нет».'),
        post(now, 'p2', 25, mr, 'proposalNews', '➡️ Это меняет требования — передал @lead-1 на решение в задаче [ORD-300](https://jira.example.test/browse/ORD-300).')],
      communication: [message(now, 'in_p1', 25, mr, 'gitlab:anna.k', 'Добавьте ещё фильтр по SKU: без него выгрузка складу не подходит.', 'routed', { jobId: job.id })] })
    jobs.push(job)
  }

  // ORD-296: completed; one change to the requirements went through the plan's revision 2 and is done, another was declined (`D12`).
  // Its review failed once on a verified finding, then passed with a merge risk (medium, floored by a dependency file) and notes (`P16`).
  {
    const risk: NonNullable<JobRow['risk']> = { level: 'medium', floor: ['dependencies'], commit: '5713515a9c0e4d2b8f61a7c3d90e12ab45cd67ef',
      sensitive: [{ area: 'dependencies', files: ['pyproject.toml'] }],
      categories: { alignment: { verdict: 'good', gaps: [] },
        impact: { verdict: 'medium', gaps: ['Общий форматтер сумм money.format() используется и в письмах о заказе'] },
        verification: { verdict: 'decent', gaps: ['Нет теста на возврат меньше рубля'] },
        rollback: { verdict: 'low', gaps: [] }, errors: { verdict: 'n/a', gaps: [] } } }
    const notes = ['- (suggestion) notify/refund.py:58: the amount template could be a constant',
      '- (unverified important: its quote is not on the new side of notify/refund.py) notify/refund.py: the refund amount is rounded twice',
      '- (test does not test its claim) tests/test_refund_notice.py test_refund_amount_kopecks: the fixture\'s amount has no kopecks',
      '- (test not audited) tests/test_money.py'].join('\n')
    const thread = `${MM}:p296chat`, mr = 'gitlab:shop/orders-api!39'
    const done = { id: 'p1', text: 'Округлять сумму возврата до копеек, а не до рублей.', by: ANNA, thread, at: ago(900), status: 'done', decidedBy: JLEAD, revision: 2, doneAt: ago(610) }
    const declined = { id: 'p2', text: 'Заодно переименуйте поле amount в total.', by: { source: 'gitlab', id: 'dev-ivan' }, thread: mr, replyTo: 'disc-2', at: ago(700), status: 'declined', decidedBy: JLEAD }
    const gates = { g2: { id: 'g2', kind: 'proposal', stageId: 'implement', threadKey: 'jira:ORD-296', openedAt: ago(900), status: 'satisfied', responses: [], interpreting: [] },
      g4: { id: 'g4', kind: 'proposal', stageId: 'implement', threadKey: 'jira:ORD-296', openedAt: ago(700), status: 'satisfied', responses: [], interpreting: [] } }
    const job = row({ id: 'job_0mwe4prop296', ticket: 'ORD-296', repository: 'orders-api', title: 'Сумма возврата в уведомлении покупателю', status: 'completed', stageId: 'review', detail: 'mr_merged',
      requester: 'jira:dev-ivan', origin: 'jira:ORD-296', mergeRequest: mr, started: ago(1300), updated: ago(610), tokens: 264_000, budget: 400_000, risk })
    const list = events(now, [[1300, 'JobStarted', { intake: { actor: JIVAN, threadKey: 'jira:ORD-296', text: '@workbench сделай' } }], [1299, 'ChatOpened', { threadKey: thread }],
      [1000, 'ThreadBound', { threadKey: mr, role: 'artifact' }],
      [900, 'ProposalRaised', { proposal: { ...done, status: 'pending', decidedBy: undefined, revision: undefined, doneAt: undefined }, eventId: 'in_q1' }], [900, 'GateOpened', { gate: { ...gates.g2, status: 'open' } }],
      [880, 'ProposalDecided', { id: 'p1', accepted: true, by: JLEAD, eventId: 'in_q2' }], [880, 'GateClosed', { gateId: 'g2', status: 'satisfied', by: JLEAD }],
      [840, 'AttemptStarted', { attemptId: `${job.id}.a4`, stageId: 'plan', n: 1, entry: 'reopen' }], [820, 'AttemptReported', { attemptId: `${job.id}.a4`, report: { outcome: 'completed', summary: 'План r2: округление до копеек' } }],
      [819, 'GateOpened', { gate: { id: 'g3', kind: 'approval', stageId: 'plan', threadKey: 'jira:ORD-296', openedAt: ago(819), subject: { kind: 'plan', n: 2 } } }],
      [800, 'GateClosed', { gateId: 'g3', status: 'satisfied', by: JLEAD }],
      [790, 'AttemptStarted', { attemptId: `${job.id}.a5`, stageId: 'implement', n: 1, entry: 'next' }],
      [760, 'AttemptReported', { attemptId: `${job.id}.a5`, report: { outcome: 'completed', summary: 'Сумма возврата в уведомлении, округление до копеек' } }],
      [759, 'VerificationStarted', { attemptId: `${job.id}.a5`, stageId: 'implement', checks: [{ id: 'tests' }, { id: 'review' }] }],
      [756, 'CheckCompleted', { attemptId: `${job.id}.a5`, checkId: 'tests', outcome: 'passed', evidence: '131 passed in 6.02s' }],
      [754, 'CheckCompleted', { attemptId: `${job.id}.a5`, checkId: 'review', outcome: 'failed', tokens: 21_400,
        evidence: 'review: changes — the notification drops the kopecks\n1. [important] notify/refund.py:41: the amount is cast to int before formatting, so 10.50 is sent as 10' }],
      [753, 'AttemptStarted', { attemptId: `${job.id}.a6`, stageId: 'implement', n: 2, entry: 'retry' }],
      [722, 'AttemptReported', { attemptId: `${job.id}.a6`, report: { outcome: 'completed', summary: 'Сумма форматируется из Decimal, без приведения к int' } }],
      [721, 'VerificationStarted', { attemptId: `${job.id}.a6`, stageId: 'implement', checks: [{ id: 'tests' }, { id: 'review' }] }],
      [718, 'CheckCompleted', { attemptId: `${job.id}.a6`, checkId: 'tests', outcome: 'passed', evidence: '132 passed in 6.11s' }],
      [716, 'CheckCompleted', { attemptId: `${job.id}.a6`, checkId: 'review', outcome: 'passed', tokens: 23_900, evidence: 'review: pass — the amount keeps its kopecks', notes, risk }],
      [700, 'ProposalRaised', { proposal: { ...declined, status: 'pending', decidedBy: undefined }, eventId: 'in_q3' }], [700, 'GateOpened', { gate: { ...gates.g4, status: 'open' } }],
      [690, 'ProposalDecided', { id: 'p2', accepted: false, by: JLEAD, eventId: 'in_q4' }], [690, 'GateClosed', { gateId: 'g4', status: 'satisfied', by: JLEAD }],
      [610, 'JobCompleted', { outcome: 'mr_merged', at: ago(610) }]])
    details[job.id] = detailOf(job, { status: { kind: 'completed', outcome: 'mr_merged', at: ago(610) }, gates, proposals: [done, declined],
      attempt: { id: `${job.id}.a6`, stageId: 'implement', n: 2, entry: 'retry', turns: 31, tokens: 58_000, ended: true,
        checks: { tests: { outcome: 'passed', evidence: '132 passed in 6.11s' }, review: { outcome: 'passed', evidence: 'review: pass — the amount keeps its kopecks', notes, risk } } },
      bindings: [{ threadKey: 'jira:ORD-296', role: 'origin' }, { threadKey: mr, role: 'artifact' }], chatThread: thread } as never, list, {
      outbound: [post(now, 'p1', 880, thread, 'proposalNews', '🔁 @lead-1 принял(а) изменение требований: сначала обновлю план в задаче [ORD-296](https://jira.example.test/browse/ORD-296), потом код.'),
        post(now, 'p2', 800, thread, 'proposalNews', '✅ Включено в план (ревизия 2), одобрено: @lead-1.'),
        post(now, 'p3', 690, mr, 'proposalNews', '✖️ @lead-1 отклонил(а) это изменение требований.'),
        // The hand-over (Mattermost) and the merge risk (GitLab, whose lines end in hard breaks) as `render()` writes them (2026-11-15).
        post(now, 'p5', 715, thread, 'completed', ['✅ **Реализация готова — нужен ваш ревью.**', '',
          '- **MR:** [orders-api!39](https://gitlab.example.test/shop/orders-api/-/merge_requests/39)', '- **Коммит:** `5713515a9c0e`', '- **Проверки пройдены:** тесты, ревью',
          '- 🟡 **Риск слияния: средний** (затронуто: зависимости)', '  - **Влияние:** Общий форматтер сумм money.format() используется и в письмах о заказе',
          '  - **Проверка:** Нет теста на возврат меньше рубля', '', '💬 Комментарии в MR вернут задачу в работу.'].join('\n')),
        post(now, 'p6', 715, mr, 'mergeRisk', ['🟡 **Риск слияния: средний** (затронуто: зависимости) · коммит `5713515a`', '', '- 🟢 **Соответствие плану:** хорошее',
          '- 🟡 **Влияние:** среднее', '  - Общий форматтер сумм money.format() используется и в письмах о заказе', '- 🟡 **Проверка:** достаточная', '  - Нет теста на возврат меньше рубля',
          '- 🟢 **Откат:** дешёвый', '- ⚪ **Обнаружение ошибок:** не применимо', '', '⚠️ **Замечания ревью без подтверждения в diff:**', '',
          '- notify/refund.py: the refund amount is rounded twice (важное: цитаты нет в diff файла notify/refund.py)', '',
          'ℹ️ Оценка модели по плану и diff; на слияние не влияет.  ', '💬 Комментарии в MR вернут задачу в работу.'].join('\n')),
        post(now, 'p4', 610, thread, 'proposalNews', '✅ Сделано: коммит `5713515a9c0e`.')] })
    jobs.push(job)
  }

  // Finished: cancelled by an approver, completed, and failed on the model provider with a requester whose id did not resolve.
  const finished: [Spec, JobState['status'], [number, string, Record<string, unknown>][]][] = [
    [{ id: 'job_0mwf3x5bc0000ord307', ticket: 'ORD-307', repository: 'orders-api', title: 'Порог минимальной суммы заказа', status: 'cancelled', stageId: 'inspect', detail: 'стоп',
      requester: 'jira:dev-ivan', origin: 'jira:ORD-307', started: ago(66), updated: ago(6), tokens: 12_000, budget: 400_000 },
    { kind: 'cancelled', by: JLEAD, reason: 'стоп', at: ago(6) } as never, [[66, 'JobStarted', { intake: { actor: JIVAN, threadKey: 'jira:ORD-307', text: '@workbench сделай' } }], [6, 'JobCancelled', { by: JLEAD, reason: 'стоп', at: ago(6) }]]],
    [{ id: 'job_0mwe1done290', ticket: 'ORD-290', repository: 'orders-api', title: 'Статус «частично возвращён» в карточке заказа', status: 'completed', stageId: 'review', detail: 'mr_merged',
      requester: 'jira:lead-1', origin: 'jira:ORD-290', started: ago(1700), updated: ago(268), tokens: 288_000, budget: 400_000 },
    { kind: 'completed', outcome: 'mr_merged', at: ago(268) } as never, [[1700, 'JobStarted', { intake: { actor: JLEAD, threadKey: 'jira:ORD-290', text: '@workbench сделай' } }], [268, 'JobCompleted', { outcome: 'mr_merged', at: ago(268) }]]],
    // Completed on the workbench's side, the merge request still open: review and merge are up to people.
    [{ id: 'job_0mwe3rev303', ticket: 'ORD-303', repository: 'orders-api', title: 'Сортировка заказов по дате оплаты', status: 'completed', stageId: 'review', detail: 'completed',
      requester: 'jira:dev-ivan', origin: 'jira:ORD-303', mergeRequest: 'gitlab:shop/orders-api!44', started: ago(300), updated: ago(95), tokens: 173_000, budget: 400_000 },
    { kind: 'completed', outcome: 'completed', at: ago(95) } as never, [[300, 'JobStarted', { intake: { actor: JIVAN, threadKey: 'jira:ORD-303', text: '@workbench сделай' } }],
      [150, 'ThreadBound', { threadKey: 'gitlab:shop/orders-api!44', role: 'artifact' }], [95, 'JobCompleted', { outcome: 'completed', at: ago(95) }]]],
    [{ id: 'job_0mwe2fail286', ticket: 'ORD-286', repository: 'orders-api', title: 'Логи запросов к складу без персональных данных', status: 'failed', stageId: 'plan',
      detail: 'stage.attempt: the model provider returned 429 Too Many Requests 5 times', requester: 'mattermost:zz9yx8wv7ut6sr5qp4on3ml2kj', origin: `${MM}:x286aa1`, started: ago(420), updated: ago(350), tokens: 41_000, budget: 400_000 },
    { kind: 'failed', reason: 'stage.attempt: the model provider returned 429 Too Many Requests 5 times', at: ago(350) } as never,
    [[420, 'JobStarted', { intake: { actor: { source: 'mattermost', id: 'zz9yx8wv7ut6sr5qp4on3ml2kj' }, threadKey: `${MM}:x286aa1`, text: '@workbench ORD-286' } }],
      [350, 'JobFailed', { reason: 'stage.attempt: the model provider returned 429 Too Many Requests 5 times', at: ago(350) }]]],
  ]
  for (const [spec, status, list] of finished) {
    const job = row(spec)
    jobs.push(job)
    details[job.id] = detailOf(job, { status, bindings: [{ threadKey: job.originThread, role: 'origin' }, ...job.mergeRequest ? [{ threadKey: job.mergeRequest, role: 'artifact' as const }] : []] }, events(now, list))
  }

  if (many) {
    const titles = ['Импорт прайс-листа из 1С', 'Отчёт по брошенным корзинам', 'Ограничение частоты запросов к /search', 'Миграция статусов доставки', 'Кэш справочника складов', 'Валидация ИНН юрлица']
    for (let index = 0; jobs.length < 200; index++) {
      const status = index % 23 === 0 ? 'awaiting_gate' : index % 17 === 0 ? 'running' : index % 11 === 0 ? 'cancelled' : index % 13 === 0 ? 'failed' : 'completed'
      const ticket = `ORD-${1000 + index}`
      jobs.push(row({ id: `job_many_${index}`, ticket, repository: index % 3 ? 'orders-api' : 'billing-api', title: titles[index % titles.length]!, status,
        stageId: status === 'completed' ? 'review' : 'implement', detail: status === 'completed' ? 'completed' : null, requester: index % 2 ? 'jira:dev-ivan' : 'jira:lead-1', origin: `jira:${ticket}`,
        started: ago(200 + index * 47), updated: ago(100 + index * 41), tokens: (index * 7919) % 380_000, budget: 400_000,
        ...status === 'awaiting_gate' ? { waiting: { kind: 'approval' as const, subject: 'plan r1', who: ['lead-1'], thread: `jira:${ticket}`, since: ago(100 + index * 41) } } : {} }))
    }
  }

  const inbox: MessageRow[] = [
    message(now, 'in_a', 6, 'jira:ORD-307', 'jira:lead-1', 'стоп', 'routed', { jobId: 'job_0mwf3x5bc0000ord307', outcome: 'decided' }),
    message(now, 'in_b', 18, `${MM}:k1r8w2nqe4`, `mattermost:${ANNA.id}`, 'а что значит «порядок фикстур»? autouse?', 'routed', { jobId: 'job_0mwh2dm7f3', outcome: 'decided' }),
    message(now, 'in_c', 24, `${MM}:gen1`, 'mattermost:x71kq0d9e3ofm1ust7qtj11fe', '@workbench сделай ORD-320', 'ignored', { reason: 'the sender may not start jobs' }),
    message(now, 'in_d', 33, `${MM}:oa1`, `mattermost:${IVAN.id}`, '@workbench repo:s14b131416 сделай ORD-305', 'ignored', { reason: 'no repository is named "s14b131416"' }),
    message(now, 'in_e', 40, `${MM}:oa2`, `mattermost:${LEAD.id}`, '1: ISO-код. 2: на усмотрение исполнителя.', 'ignored', { reason: 'not addressed to the workbench' }),
    message(now, 'in_f', 51, `${MM}:k1r8w2nqe4`, 'mattermost:6wezgm4tsif9ubs1boudpk381o', 'Записал: 1 — docker-раннеры. Осталось: 2, 3.', 'ignored', { reason: 'the workbench\'s own post' }, false),
    message(now, 'in_g', 95, `${MM}:dm7f3a0`, `mattermost:${IVAN.id}`, 'почини флейки тест test_refund_partial. токен для стенда: [REDACTED]', 'routed', { jobId: 'job_0mwh2dm7f3', outcome: 'decided' }),
    message(now, 'in_h', 200, 'gitlab:shop/orders-api!52', 'gitlab:renovate-bot', 'Update dependency pytest to v8.4.2', 'ignored', { reason: 'not a workbench job' }, false),
    message(now, 'in_i', 300, 'jira:ORD-312', 'jira:dev-ivan', '@workbench сделай', 'routed', { jobId: 'job_0mwg11aa0000ord312', outcome: 'decided' }),
  ]
  const shown = empty ? [] : jobs
  const state: StateView = {
    jobs: shown, people: PEOPLE, links: { jira: 'https://jira.example.test', mattermost: 'https://chat.example.test', gitlab: 'https://gitlab.example.test' },
    tokensToday: shown.filter(job => job.updatedAt > ago(930)).reduce((sum, job) => sum + job.tokens, 0), locale: 'ru', demo: false,
    health: {
      runtime: { runtime: { state: 'ready', detail: 'Ready; recovered 0 interrupted attempts, 0 waiting events, 0 overdue timers', at: new Date(ago(27)).toISOString() },
        mattermost: { state: 'ready', detail: 'Mattermost polling active', at: new Date(ago(1)).toISOString() },
        jira: empty ? { state: 'ready', detail: 'Jira polling active' } : { state: 'error', detail: 'Jira polling failed 3 times in a row: 502 Bad Gateway from jira.example.test; retrying in 40 s', at: new Date(ago(2)).toISOString() },
        gitlab: { state: 'ready', detail: 'GitLab polling active', at: new Date(ago(1)).toISOString() },
        dashboard: { state: 'ready', detail: 'Serving http://127.0.0.1:25410/' } },
      effects: { post: { running: 0, waiting: 2, retrying: 1, unknown: 0, lastError: 'jira: 502 Bad Gateway (comment on ORD-312)' }, 'stage.attempt': { running: 1, waiting: 0, retrying: 0, unknown: 0 },
        setup: { running: 1, waiting: 0, retrying: 0, unknown: 0 }, check: { running: 1, waiting: 1, retrying: 0, unknown: 0 }, interpretFollowUp: { running: 0, waiting: 0, retrying: 0, unknown: 1 } },
      inbox: { routed: 7, ignored: 73 }, jobs: { awaiting_gate: 2, blocked: 2, parked: 1, setting_up: 1, running: 1, verifying: 1, completed: 41, cancelled: 6, failed: 3 },
      timers: { armed: 7, nextDue: now + 11 * MIN }, kernelError: empty ? null : 'SQLITE_BUSY: database is locked (dispatch ef_0mwf3y8h2)',
    },
  }
  const settings: SettingsView = {
    models: { default: 'litellm/deepseek-flash', verdict: 'litellm/deepseek-flash', from: 'profile `models`, else LITELLM_MODEL' },
    policy: { senders: { jira: ['dev-ivan', 'lead-1'], mattermost: ['dev-ivan', IVAN.id, 'lead-1', LEAD.id, 'anna.k'] }, approvers: { 'standard-delivery': { jira: ['*'], mattermost: ['*'] } },
      bots: { jira: ['workbench'], mattermost: ['6wezgm4tsif9ubs1boudpk381o', 'workbench'] }, repositoryApprovers: { 'orders-api': { jira: ['lead-1'], mattermost: [LEAD.id, 'lead-1'] } },
      from: 'profile `policy`, WORKBENCH_ALLOWED_SENDERS, repositories\' `approvers`, and identities resolved at startup' },
    maxWorkers: 2, locale: 'ru', demo: false,
    repositories: [{ name: 'orders-api', project: 'shop/orders-api', targetBranch: 'main', testCommand: 'python -m pytest -q', setupCommand: 'python -m pip install -r requirements-dev.txt',
      registries: ['pypi'], toolchains: {}, match: { jira: ['ORD'], mattermost: ['9nq8wi9b8pyniqjq89jueaq9xh'] }, approvers: ['lead@example.test'], ci: 'required', default: true },
    { name: 'billing-api', project: 'shop/billing-api', targetBranch: 'develop', testCommand: 'go test ./...', registries: ['go'], toolchains: { go: '1.23' },
      match: { jira: ['BILL'], mattermost: [] }, approvers: ['lead@example.test', 'anna@example.test'], ci: 'required' }] as never,
    workflows: [{ id: 'standard-delivery', version: 11, title: 'Standard delivery', parameters: { 'jira.inProgress': 'In Progress', 'jira.inReview': 'In Review' },
      stages: STD.map(stage => ({ ...stage, model: 'litellm/deepseek-flash', agentPreset: `workflow-agent-${stage.id}`, egress: stage.id === 'implement' || stage.id === 'review' ? 'registries' : 'none' })),
      budgets: { turns: 400, tokens: 400_000, backtracks: 3 } },
    { id: 'synthetic-hotfix', version: 2, title: 'Synthetic hotfix', parameters: {}, stages: HOT.map(stage => ({ ...stage, model: 'litellm/deepseek-flash', agentPreset: 'workflow-agent-implementer', egress: 'none' })),
      budgets: { turns: 150, tokens: 150_000, backtracks: 1 } }],
    links: { jira: 'https://jira.example.test', mattermost: 'https://chat.example.test', gitlab: 'https://gitlab.example.test', from: 'profile `dashboard.links`, else the connectors\' base URLs' },
  }
  return { state, details, traces, inbox: { messages: empty ? [] : inbox }, settings }
}
