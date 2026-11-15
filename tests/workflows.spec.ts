/** The shipped workflows (`T9.7`, `T10.1`, `T11.1`): `standard-delivery@13` end to end with deployment parameters, and the synthetic hotfix (`A6`). */
import { afterEach, describe, expect, it } from 'vitest'
import { defineWorkflow, fill } from '../src/domain/definition.ts'
import { definitionHash } from '../src/kernel/registry.ts'
import { STANDARD_DELIVERY_PARAMETERS, standardDelivery } from '../src/workflows/standard-delivery.ts'
import { syntheticHotfix } from '../src/workflows/synthetic-hotfix.ts'
import { ANNA, EVE, Harness, LEAD } from './fixtures/domain-workflow.ts'

const PARAMETERS = { repository: 'group/app', targetBranch: 'main', testCommand: 'pnpm test', ci: 'required', 'jira.inProgress': 'В работе', 'jira.inReview': 'На ревью' }
let h: Harness | undefined
afterEach(() => { h?.cleanup(); h = undefined })

describe('standard-delivery@13', () => {
  it('is a valid, stable definition whose prompts name only the parameters a deployment sets', () => {
    const definition = defineWorkflow(standardDelivery())
    expect(definitionHash(defineWorkflow(standardDelivery()))).toBe(definitionHash(definition))
    const named = new Set(Object.values(standardDelivery().prompts).flatMap(text => [...text.matchAll(/\{\{([^}]+)\}\}/gu)].map(match => match[1]!)))
    expect([...named].sort()).toEqual([...STANDARD_DELIVERY_PARAMETERS].filter(name => named.has(name)).sort())
    expect(fill(standardDelivery().prompts.inspect!, PARAMETERS)).toContain('the status "В работе"')
    expect(fill(standardDelivery().prompts['inspect.ru']!, PARAMETERS)).toContain('статус «В работе»')
  })

  it('runs inspect, plan, approval and implement with the host\'s checks to completion, and MR feedback reopens it at review', async () => {
    h = new Harness({ workflows: [standardDelivery()], parameters: { 'standard-delivery': PARAMETERS } })
    h.policy = { ...h.policy, approvers: { 'standard-delivery': { mattermost: ['lead'], gitlab: ['lead'] } } }
    const job = await h.start('@workbench сделай PAY-1')
    expect(h.wb.workflow(h.state(job).manifestId).extra.parameters).toEqual(PARAMETERS)
    await h.complete(job, { clarifiedScope: 'Сессии в Redis', filesInspected: ['auth/'] })
    // Plan must say what will be tested (T10.1).
    expect((await h.report(job, { outcome: 'completed', summary: 'plan', output: { steps: ['Добавить хранилище'] } }, 'plan')).outcome)
      .toMatchObject({ kind: 'rejected', reason: expect.stringContaining('tests') })
    await h.complete(job, { steps: ['Добавить хранилище'], tests: 'Тест на истечение TTL сессии' }, '### 📋 Технический план (PAY-1)')
    expect(h.gate(job)).toMatchObject({ kind: 'approval', subject: { kind: 'plan', n: 1 } })
    await h.say(LEAD, 'ок')
    expect(h.state(job).attempt!.stageId).toBe('implement')
    h.wb.action(job, h.attempt(job), { session: 's', id: 'mr' }, 'gitlab.createMr', {})
    await h.settle()
    await h.complete(job, { branch: 'agent/pay-1-sessions' })
    expect(h.wb.kernel.engine.events(job).filter(event => event.type === 'CheckCompleted').map(event => (event as { checkId: string }).checkId).sort())
      .toEqual(['ci', 'integrity', 'review', 'tests'])
    expect(h.state(job).status).toMatchObject({ kind: 'completed', outcome: 'completed' })
    await h.say({ source: 'gitlab', id: 'lead' }, 'Добавь тест на истечение TTL', { thread: 'gitlab:group/app!1', source: 'gitlab' })
    expect(h.state(job).attempt).toMatchObject({ stageId: 'review', entry: 'reopen' })
  })

  it('closes a finished job when its merge request is merged, and takes no more feedback (trial, 2026-11-15)', async () => {
    h = new Harness({ workflows: [standardDelivery()], parameters: { 'standard-delivery': PARAMETERS } })
    h.policy = { ...h.policy, approvers: { 'standard-delivery': { mattermost: ['lead'], gitlab: ['lead'] } } }
    expect(standardDelivery().declaration).toMatchObject({ completeOn: ['mr_merged', 'mr_closed'] })
    const job = await h.start('@workbench сделай PAY-1')
    await h.complete(job, { clarifiedScope: 'Сессии в Redis', filesInspected: ['auth/'] })
    await h.complete(job, { steps: ['Добавить хранилище'], tests: 'Тест на истечение TTL сессии' }, '### План')
    await h.say(LEAD, 'ок')
    h.wb.action(job, h.attempt(job), { session: 's', id: 'mr' }, 'gitlab.createMr', {})
    await h.settle()
    await h.complete(job, { branch: 'agent/pay-1-sessions' })
    expect(h.state(job).status).toMatchObject({ kind: 'completed', outcome: 'completed' })
    await h.fact('mr_merged', 'gitlab:group/app!1')
    expect(h.state(job).closedBy).toBe('mr_merged')
    const last = h.state(job).attempt
    const before = h.posts.length
    await h.say({ source: 'gitlab', id: 'lead' }, 'Добавь тест на истечение TTL', { thread: 'gitlab:group/app!1', source: 'gitlab' })
    expect(h.state(job).attempt).toEqual(last)
    expect(h.state(job).status).toMatchObject({ kind: 'completed', outcome: 'completed' })
    // The merge request is told once that the job is closed; a second comment is ignored.
    expect(h.posts.slice(before).map(post => [post.threadKey, post.message])).toEqual([['gitlab:group/app!1', { kind: 'jobClosed', fact: 'mr_merged' }]])
    await h.say({ source: 'gitlab', id: 'lead' }, 'И ещё одно', { thread: 'gitlab:group/app!1', source: 'gitlab' })
    expect(h.posts).toHaveLength(before + 1)
  })

  /** A standard-delivery job taken to its merge request, completed. */
  async function finished(harness: Harness, ticket = 'PAY-1'): Promise<string> {
    const job = await harness.start(`@workbench сделай ${ticket}`)
    await harness.complete(job, { clarifiedScope: 'Сессии в Redis', filesInspected: ['auth/'] })
    await harness.complete(job, { steps: ['Добавить хранилище'], tests: 'Тест на истечение TTL сессии' }, '### План')
    await harness.say(LEAD, 'ок')
    harness.wb.action(job, harness.attempt(job), { session: 's', id: 'mr' }, 'gitlab.createMr', {})
    await harness.settle()
    await harness.complete(job, { branch: 'agent/pay-1-sessions' })
    expect(harness.state(job).status).toMatchObject({ kind: 'completed', outcome: 'completed' })
    return job
  }

  it('closes a finished job on an approver\'s «закрой» on any of its threads; anyone else is told who may', async () => {
    h = new Harness({ workflows: [standardDelivery()], parameters: { 'standard-delivery': PARAMETERS } })
    h.policy = { ...h.policy, approvers: { 'standard-delivery': { mattermost: ['lead'], gitlab: ['lead'] } } }
    const job = await finished(h)
    let before = h.posts.length
    // The job's Mattermost thread is not its merge request: only a close reaches the finished job there. A participant who is no
    // approver is told who may; without the repository's own approvers, the requester counts as one (`eligible`).
    await h.say(EVE, 'закрой')
    expect(h.state(job).closedBy).toBeUndefined()
    expect(h.posts.slice(before).map(post => [post.threadKey, post.message])).toEqual([['mattermost:ch1:p1', { kind: 'closeNotAllowed', to: EVE }]])
    before = h.posts.length
    await h.say(EVE, 'спасибо всем')
    expect(h.posts).toHaveLength(before)
    before = h.posts.length
    await h.say(LEAD, '@workbench закрой задачу')
    expect(h.state(job)).toMatchObject({ closedBy: 'person', closer: LEAD, status: { kind: 'completed', outcome: 'completed' } })
    expect(h.posts.slice(before).map(post => [post.threadKey, post.message])).toEqual([['mattermost:ch1:p1', { kind: 'closed', by: LEAD }]])
    // Feedback on the merge request no longer reopens it; the merge request is told once.
    const last = h.state(job).attempt
    before = h.posts.length
    await h.say({ source: 'gitlab', id: 'lead' }, 'Добавь тест на истечение TTL', { thread: 'gitlab:group/app!1', source: 'gitlab' })
    expect(h.state(job).attempt).toEqual(last)
    expect(h.posts.slice(before).map(post => post.message)).toEqual([{ kind: 'jobClosed', by: LEAD }])
    // A merge afterwards changes nothing.
    await h.fact('mr_merged', 'gitlab:group/app!1')
    expect(h.state(job).closedBy).toBe('person')
  })

  it('does not reopen a job closed while a merge request comment was being read', async () => {
    h = new Harness({ workflows: [standardDelivery()], parameters: { 'standard-delivery': PARAMETERS } })
    h.policy = { ...h.policy, approvers: { 'standard-delivery': { mattermost: ['lead'], gitlab: ['lead'] } } }
    const job = await finished(h)
    const last = h.state(job).attempt
    // The comment's reading is requested but not settled when the close arrives.
    const { event } = h.wb.kernel.inbox.append({ source: 'gitlab', externalId: 'late', threadKey: 'gitlab:group/app!1', actor: { source: 'gitlab', id: 'lead' },
      human: true, payload: { kind: 'message', text: 'Добавь тест', addressed: 'none', postedAt: h.env.clock.now() } })
    h.wb.handle(event)
    await h.say(LEAD, 'закрой')
    await h.settle()
    expect(h.state(job)).toMatchObject({ closedBy: 'person', status: { kind: 'completed', outcome: 'completed' } })
    expect(h.state(job).attempt).toEqual(last)
  })

  it('closes a finished job whose merge request is closed without a merge (since @12)', async () => {
    h = new Harness({ workflows: [standardDelivery()], parameters: { 'standard-delivery': PARAMETERS } })
    h.policy = { ...h.policy, approvers: { 'standard-delivery': { mattermost: ['lead'], gitlab: ['lead'] } } }
    const job = await finished(h)
    await h.fact('mr_closed', 'gitlab:group/app!1')
    expect(h.state(job).closedBy).toBe('mr_closed')
  })

  it('closes a job on a version without completeOn by «закрой», which a merge does not close (ORD-301, trial 2026-11-15)', async () => {
    const old = standardDelivery()
    const v9 = { ...old, version: 9, declaration: { ...old.declaration, completeOn: [] } }
    h = new Harness({ workflows: [v9], parameters: { 'standard-delivery': PARAMETERS } })
    h.policy = { ...h.policy, approvers: { 'standard-delivery': { mattermost: ['lead'], gitlab: ['lead'] } } }
    const job = await finished(h)
    await h.fact('mr_merged', 'gitlab:group/app!1')
    expect(h.state(job).closedBy).toBeUndefined()
    await h.say({ source: 'gitlab', id: 'lead' }, 'закрой', { thread: 'gitlab:group/app!1', source: 'gitlab' })
    expect(h.state(job)).toMatchObject({ closedBy: 'person', closer: { source: 'gitlab', id: 'lead' } })
  })

  it('keeps a running job on the parameters it started with', async () => {
    h = new Harness({ workflows: [standardDelivery()], parameters: { 'standard-delivery': PARAMETERS } })
    const first = await h.start('@workbench сделай PAY-1')
    h.parameters['standard-delivery'] = { ...PARAMETERS, testCommand: 'npm test' }
    const second = await h.start('@workbench сделай PAY-2', 'mattermost:ch1:p2')
    expect(h.wb.workflow(h.state(first).manifestId).extra.parameters.testCommand).toBe('pnpm test')
    expect(h.wb.workflow(h.state(second).manifestId).extra.parameters.testCommand).toBe('npm test')
  })
})

/** The Russian variants of a workflow's prompts (`<name>.ru`, `D14`), by their base names: the prompts the tests below were written for. */
const russian = (prompts: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(prompts).filter(([name]) => name.endsWith('.ru')).map(([name, text]) => [name.slice(0, -3), text]))

describe('the self-audit, the merge request description and repository conventions (T16.7)', () => {
  const spec = standardDelivery()
  const prompts = russian(spec.prompts)
  /** The numbered step of a stage's instructions that contains `text`. */
  const step = (stage: string, text: string) => Number(prompts[stage]!.split('\n').find(line => /^\d+\. /u.test(line) && line.includes(text))?.split('.')[0])

  it('is version 13', () => {
    expect(spec.version).toBe(13)
    expect(defineWorkflow(spec).version).toBe(13)
  })

  it('has implement and review audit their own diff before the commit, with the three checks of the owner\'s trial', () => {
    for (const name of ['implement', 'review']) {
      const text = prompts[name]!
      expect(text).toContain('«Самопроверка»')
      // (1) The diff, line by line, against the plan; what is left over is removed or declared.
      expect(text).toMatch(/\(1\)[^\n]*`git diff \{\{targetBranch\}\}\.\.\.` построчно[^\n]*Каждое изменение служит плану[^\n]*убери[^\n]*«Вне плана»/u)
      // (2) Every item of the test plan has a test whose data reaches its boundary.
      expect(text).toMatch(/\(2\)[^\n]*«План тестирования»[^\n]*на каждый его пункт есть тест[^\n]*доходят до границы[^\n]*по умолчанию 20[^\n]*больше чем на 20 записях[^\n]*максимум — своим значением/u)
      // (3) The other users of a changed shared name.
      expect(text).toMatch(/\(3\)[^\n]*общая константа, схема или вспомогательная функция[^\n]*`grep`[^\n]*проверь или покрой тестом/u)
      expect(step(name, '«Самопроверка»')).toBeLessThan(step(name, 'gitlab_push_branch'))
      expect(fill(text, PARAMETERS)).toContain('`git diff main...`')
    }
    expect(prompts.implement).toContain('3. «Самопроверка» — до коммита')
    expect(step('implement', 'Реализуй план с тестами')).toBeLessThan(step('implement', '«Самопроверка»'))
    for (const name of ['inspect', 'plan']) expect(prompts[name]).not.toContain('Самопроверка')
  })

  it('gives the merge request description one shape, written at implement and kept current at review', () => {
    const headings = ['## Что изменено', '## Допущения', '## Вне плана', '## Как проверено']
    for (const name of ['implement', 'review']) {
      const lines = prompts[name]!.split('\n').map(line => line.trim())
      const at = headings.map(heading => lines.indexOf(heading))
      expect(at.every(index => index >= 0)).toBe(true)
      expect(at).toEqual([at[0]!, at[0]! + 1, at[0]! + 2, at[0]! + 3])
      expect(prompts[name]).toMatch(/«Вне плана»[^\n]*или «нет»/u)
      expect(prompts[name]).toMatch(/«Как проверено» — команды, которые ты запускал, и что они показали/u)
    }
    expect(prompts.implement).toMatch(/`gitlab_create_mr`[^\n]*`gitlab_update_mr`[^\n]*\n\s*Описание MR \(`description`\) — всегда по шаблону/u)
    expect(prompts.review).toMatch(/Приведи описание MR к текущему состоянию ветки \(`gitlab_update_mr`/u)
    expect(step('review', 'gitlab_push_branch')).toBeLessThan(step('review', 'gitlab_update_mr'))
    // The tools the description is written with are the ones the stages are given.
    const tools = (id: string) => spec.declaration.stages.find(stage => stage.id === id)!.tools
    expect(tools('implement')).toEqual(expect.arrayContaining(['gitlab.createMr', 'gitlab.updateMr']))
    expect(tools('review')).toContain('gitlab.updateMr')
    for (const name of ['inspect', 'plan']) expect(prompts[name]).not.toContain('## Что изменено')
  })

  it('tells plan, implement and review to follow the repository\'s own conventions', () => {
    for (const name of ['plan', 'implement', 'review']) expect(prompts[name]).toMatch(/`AGENTS\.md` или `CONTRIBUTING\.md`, сначала прочитай их и следуй им/u)
    expect(prompts.inspect).not.toContain('CONTRIBUTING.md')
  })
})

describe('standard-delivery in English (D14)', () => {
  const spec = standardDelivery()
  const { prompts } = spec
  const stages = ['inspect', 'plan', 'implement', 'review']
  const step = (stage: string, text: string) => Number(prompts[stage]!.split('\n').find(line => /^\d+\. /u.test(line) && line.includes(text))?.split('.')[0])

  it('has English base prompts and a Russian variant of each, with English stage titles and Russian ones', () => {
    for (const name of stages) {
      expect(prompts[name]).not.toMatch(/[А-Яа-яЁё]/u)
      expect(prompts[`${name}.ru`]).toMatch(/[А-Яа-яЁё]/u)
    }
    expect(spec.declaration.stages.map(stage => [stage.title, stage.titles?.ru]))
      .toEqual([['Requirements analysis', 'Анализ требований'], ['Implementation plan', 'План реализации'], ['Implementation and MR', 'Реализация и MR'], ['MR review', 'Ревью MR']])
  })

  it('keeps every rule of the Russian prompts: the self-audit, the description\'s shape, conventions, layout, names, sources and answers', async () => {
    const { ANSWER_MARKS_BY_LOCALE } = await import('../src/adapters/stage-runner.ts')
    for (const name of ['implement', 'review']) {
      const text = prompts[name]!
      expect(text).toMatch(/\(1\)[^\n]*`git diff \{\{targetBranch\}\}\.\.\.` line by line[^\n]*Every change serves the plan[^\n]*"Outside the plan"/u)
      expect(text).toMatch(/\(2\)[^\n]*"Test plan"[^\n]*every item of it has a test[^\n]*default of 20 is tested with more than 20 records/u)
      expect(text).toMatch(/\(3\)[^\n]*shared constant, schema or helper[^\n]*`grep`/u)
      expect(step(name, '"Self-audit"')).toBeLessThan(step(name, 'gitlab_push_branch'))
      const lines = text.split('\n').map(line => line.trim())
      const at = ['## What changed', '## Assumptions', '## Outside the plan', '## How it was checked'].map(heading => lines.indexOf(heading))
      expect(at).toEqual([at[0]!, at[0]! + 1, at[0]! + 2, at[0]! + 3])
      expect(at[0]).toBeGreaterThan(0)
    }
    for (const name of ['plan', 'implement', 'review']) expect(prompts[name]).toContain('`AGENTS.md` or `CONTRIBUTING.md`, read them first and follow them')
    for (const name of stages) {
      expect(prompts[name]).toContain('in English, short and to the point')
      expect(prompts[name]).toMatch(/the first line is an emoji and a short bold headline[^\n]*a blank line between blocks[^\n]*GitLab joins the lines/u)
      expect(prompts[name]).toContain('is `👉 …`')
      expect(prompts[name]).toMatch(/by their name as it appears in the inputs[^\n]*Jira comment ids/u)
    }
    for (const name of ['inspect', 'plan']) {
      // The mark the stage runner puts on a corrected answer in an English job is the one the English prompts name.
      expect(prompts[name]).toContain(`Ignore an answer marked "${ANSWER_MARKS_BY_LOCALE.en.replaced}"`)
      expect(prompts[name]).toContain('`— @name`')
      expect(prompts[name]).toContain('`— assumption`')
    }
    expect(prompts.plan).toContain('A plan is decisions, not a train of thought')
    expect(prompts.plan).toContain('`exempt <rule> <path>: <why>`')
    expect(prompts.implement).toContain('`🔗 **MR for review:** [<project>!<number>](<link>)`')
    expect(prompts.review).toContain('"✅ **Fixed** in `<short commit hash>`"')
    // The parameters a deployment sets are the same in both languages.
    const named = (text: string) => [...text.matchAll(/\{\{([^}]+)\}\}/gu)].map(match => match[1]!).sort()
    for (const name of stages) expect([...new Set(named(prompts[name]!))]).toEqual([...new Set(named(prompts[`${name}.ru`]!))])
  })

  it('starts a job in the deployment\'s language and keeps it there when the deployment switches', async () => {
    h = new Harness({ workflows: [standardDelivery()], parameters: { 'standard-delivery': PARAMETERS }, locale: 'en' })
    const english = await h.start('@workbench do PAY-1')
    const instructions = (job: string) => h!.wb.kernel.blobs.text(h!.wb.workflow(h!.state(job).manifestId).extra.stages.inspect!.instructions)
    expect(h.wb.workflow(h.state(english).manifestId).extra.locale).toBe('en')
    expect(instructions(english)).toBe(prompts.inspect)
    h.locale = 'ru'
    await h.restart()
    const russianJob = await h.start('@workbench сделай PAY-2', 'mattermost:ch1:p2')
    expect(instructions(russianJob)).toBe(prompts['inspect.ru'])
    expect(instructions(english)).toBe(prompts.inspect)
  })
})

describe('synthetic-hotfix (A6)', () => {
  it('loads beside standard delivery and takes the requests its trigger pattern matches', async () => {
    h = new Harness({ workflows: [standardDelivery(), syntheticHotfix()], parameters: { 'synthetic-hotfix': { testCommand: 'make test' } } })
    const hotfix = await h.start('@workbench hotfix: login fails with 500')
    const delivery = await h.start('@workbench сделай PAY-3', 'mattermost:ch1:p3')
    expect(h.state(hotfix).workflowId).toBe('synthetic-hotfix')
    expect(h.state(delivery).workflowId).toBe('standard-delivery')
    await h.complete(hotfix, { cause: 'null session' })
    await h.complete(hotfix)
    await h.complete(hotfix, {}, 'Rollout: deploy, watch login errors.')
    await h.say(ANNA, 'ok')
    expect(h.status(hotfix)).toBe('completed')
    expect(h.wb.kernel.db.all('SELECT workflow_id, status FROM job_summary ORDER BY workflow_id'))
      .toEqual([{ workflow_id: 'standard-delivery', status: 'running' }, { workflow_id: 'synthetic-hotfix', status: 'completed' }])
  })
})

describe('the style rule (D12)', () => {
  it('is in every stage\'s instructions of standard-delivery', async () => {
    const { standardDelivery } = await import('../src/workflows/standard-delivery.ts')
    const spec = standardDelivery()
    for (const name of ['inspect', 'plan', 'implement', 'review']) expect(russian(spec.prompts)[name]).toContain('по-русски, коротко и по делу')
  })

  it('lays out what the agents write as the host\'s posts are: a headline, facts on lines of their own, blank lines, a 👉 line (2026-11-15)', async () => {
    const { standardDelivery } = await import('../src/workflows/standard-delivery.ts')
    const prompts = russian(standardDelivery().prompts)
    for (const name of ['inspect', 'plan', 'implement', 'review']) {
      expect(prompts[name]).toMatch(/Оформление комментария в Jira и ответа в MR \(не вопросов в `questions` — их оформляет хост\): первая строка — эмодзи и короткий заголовок жирным/u)
      expect(prompts[name]).toMatch(/между блоками[^\n]*пустая строка: без неё GitLab склеит строки/u)
      expect(prompts[name]).toMatch(/последняя строка, после пустой: `👉 …`/u)
    }
    expect(prompts.implement).toContain('`🔗 **MR на ревью:** [<проект>!<номер>](<ссылка>)`')
    expect(prompts.review).toContain('«✅ **Исправлено** в `<короткий хеш коммита>`»')
  })

  it('tells the stages how to name people, sources and answers, and the plan to state decisions about the target state (owner\'s trial)', async () => {
    const { standardDelivery } = await import('../src/workflows/standard-delivery.ts')
    const { ANSWER_MARKS } = await import('../src/adapters/stage-runner.ts')
    const prompts = russian(standardDelivery().prompts)
    // People by @name, never a role or a raw id; no Jira comment ids.
    for (const name of ['inspect', 'plan', 'implement', 'review']) expect(prompts[name]).toMatch(/по имени, как во входных данных[^\n]*идентификаторы комментариев Jira/u)
    for (const name of ['inspect', 'plan']) {
      // The mark the stage runner puts on a corrected answer is the one the prompts name.
      expect(prompts[name]).toContain(`«${ANSWER_MARKS.replaced}» не учитывай`)
      expect(prompts[name]).toContain('действует последний ответ')
      expect(prompts[name]).toContain('чей ответ принят')
      expect(prompts[name]).toContain('`— @имя`')
      expect(prompts[name]).toContain('`— допущение`')
    }
    const plan = prompts.plan!
    expect(plan).toContain('1. <требование> — <источник>')
    expect(plan).toContain('План — это решения, а не ход рассуждений')
    expect(plan).toContain('целевое состояние кода после работы')
    expect(plan).toContain('без слова «план», ключа задачи и номера ревизии')
    expect(plan).toContain('`exempt <правило> <путь>: <почему>`')
    expect(prompts.implement).toContain('сам приведи её к плану')
  })
})
