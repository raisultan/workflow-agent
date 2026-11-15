/**
 * Stateful Mock Jira Server for the eval's local services (`T11.7`). Synthetic data only.
 *
 * Implements the Jira REST v2 endpoints used by `JiraConnector`:
 * - `GET /rest/api/2/search`
 * - `POST /rest/api/2/issue` (the eval creates its tickets, `T13.2`)
 * - `GET /rest/api/2/issue/:key`
 * - `GET /rest/api/2/issue/:key/remotelink`
 * - `POST /rest/api/2/issue/:key/comment`
 * - `POST /rest/api/2/issue/:key/transitions`
 * - `PUT /rest/api/2/issue/:key`
 * - `DELETE /rest/api/2/issue/:key` (the eval removes each run's ticket once it is collected, `T14.10`)
 * - `GET /secure/attachment/:id/:filename`
 * Plus an interactive browser UI at `GET /` to inspect issues, status transitions,
 * attachments, and comments or post new human comments.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** The mock's people (`D12`): the eval's synthetic users with the emails `eval/bootstrap.ts` gives them in Mattermost. */
export const MOCK_JIRA_USERS: Readonly<Record<string, { displayName: string; emailAddress: string }>> = {
  'dev-ivan': { displayName: 'Иван Петров (Backend)', emailAddress: 'ivan@example.test' },
  'lead-1': { displayName: 'Алексей Тимлид', emailAddress: 'lead@example.test' },
  workbench: { displayName: 'Workflow Agent Bot', emailAddress: 'bot@example.test' },
}
/** A person as Jira shows them, with their email when the mock knows it. */
export function mockJiraUser(name: string): { name: string; displayName: string; emailAddress?: string } {
  const known = MOCK_JIRA_USERS[name]
  return known ? { name, ...known } : { name, displayName: name }
}

export interface MockJiraComment {
  id: string
  author: { name: string; displayName: string; emailAddress?: string }
  body: string
  created: string
}

export interface MockJiraAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  textContent: string
}

export interface MockJiraIssue {
  id: string
  key: string
  summary: string
  description: string
  status: string
  issueType: string
  priority: string
  labels: string[]
  reporter: { name: string; displayName: string; emailAddress?: string }
  assignee?: { name: string; displayName: string }
  updated: string
  epic?: { key: string; summary: string; status: string }
  subtasks: { key: string; summary: string; status: string }[]
  issueLinks: {
    id: string
    type: { name: string; inward: string; outward: string }
    outwardIssue?: { key: string; fields: { summary: string; status: { name: string } } }
  }[]
  remoteLinks: {
    id: string
    relationship: string
    object: { url: string; title: string }
  }[]
  comments: MockJiraComment[]
  attachments: MockJiraAttachment[]
}

const TRANSITION_STATUS_MAP: Record<string, string> = {
  '11': 'К выполнению (To Do)',
  '21': 'В работе (In Progress)',
  '31': 'На ревью (In Review)',
  '41': 'Готово (Done)',
  in_progress: 'В работе (In Progress)',
  in_review: 'На ревью (In Review)',
  done: 'Готово (Done)',
}

export function createInitialMockJiraIssues(baseUrl: string): Map<string, MockJiraIssue> {
  const logText = [
    '2026-11-07T18:12:04.512Z WARN [order-checkout] POST /api/v1/orders/quote promoCode ignored in OrderPricingService.calculateQuote',
    'Request-ID: req_88102b, Customer-ID: cust_3091, Promo-Code: WINTER25',
    'Observed edge cases in production checkout traffic:',
    '  1) Customer passes an unknown, expired (nowMs >= expiresAtMs), or exhausted (usedCount >= maxUses) promo code',
    '  2) Customer subtotalCents is below promo.minOrderCents (e.g., subtotal 150000, minOrderCents 300000)',
    '  3) Fixed discount exceeds subtotalCents (e.g., fixed discount 50000 on subtotal 30000), or percentage discount produces fractional cents (e.g., 15% of 999)',
    '  4) When promoCode is applied, should PromoCodeStore.incrementUsage(code) be called inside calculateQuote or only when the order is finalized, and how should case sensitivity / whitespace in promoCode be normalized?',
    'Note: Error status codes (400 vs 422), rounding rule (Math.floor vs Math.round), minimum payable total (0 vs 1), and usage increment behavior are not yet specified.',
  ].join('\n')

  const issues = new Map<string, MockJiraIssue>()

  issues.set('ORD-201', {
    id: '20201',
    key: 'ORD-201',
    summary: 'Добавить расчёт скидок по промокодам в OrderPricingService.calculateQuote',
    description: [
      'Сейчас при расчёте стоимости заказа в `OrderPricingService.calculateQuote` (`src/orders/pricing.ts`) поле `req.promoCode` игнорируется и клиент всегда получает полную стоимость `subtotalCents`.',
      '',
      'Что нужно сделать:',
      '- Реализовать поддержку промокодов (`percent` и `fixed`) в `OrderPricingService.calculateQuote` с использованием `PromoCodeStore` (`src/orders/catalog.ts`).',
      '- Обработать валидацию промокода, минимальную сумму заказа (`minOrderCents`), расчёт итоговой суммы и пограничные случаи из прод-лога (`checkout-promo-errors.log`).',
      '- Примечание: точные правила по кодам ошибок для невалидных/истёкших/не подходящих по минимальной сумме промокодов, округлению процентной скидки и нижней границе итоговой стоимости, а также инкременту счётчика использований (`usedCount`) в тикете не зафиксированы — перед составлением плана обязательно уточнить у автора задачи в чате.',
    ].join('\n'),
    status: 'К выполнению (To Do)',
    issueType: 'Task',
    priority: 'High',
    labels: ['orders', 'pricing', 'promo-codes'],
    reporter: mockJiraUser('dev-ivan'),
    assignee: { name: 'workbench', displayName: 'Workflow Agent Bot' },
    updated: '2026-11-07T18:15:00.000Z',
    epic: {
      key: 'ORD-200',
      summary: 'Промо-кампании и корзина Q4',
      status: 'В работе (In Progress)',
    },
    subtasks: [
      { key: 'ORD-202', summary: 'Валидация промокода и расчёт скидки в calculateQuote', status: 'Open' },
      { key: 'ORD-203', summary: 'Покрыть unit-тестами промокоды и граничные случаи', status: 'Open' },
    ],
    issueLinks: [
      {
        id: 'link-1',
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        outwardIssue: {
          key: 'ORD-210',
          fields: { summary: 'Запуск зимней промо-акции в мобильном приложении', status: { name: 'Open' } },
        },
      },
    ],
    remoteLinks: [],
    comments: [],
    attachments: [
      {
        id: 'att-701',
        filename: 'checkout-promo-errors.log',
        mimeType: 'text/plain',
        size: Buffer.byteLength(logText, 'utf8'),
        textContent: logText,
      },
    ],
  })

  return issues
}

function toJiraRestIssue(issue: MockJiraIssue): Record<string, unknown> {
  return {
    id: issue.id,
    key: issue.key,
    fields: {
      summary: issue.summary,
      description: issue.description,
      status: { name: issue.status },
      issuetype: { name: issue.issueType },
      priority: { name: issue.priority },
      labels: issue.labels,
      reporter: issue.reporter,
      assignee: issue.assignee,
      updated: issue.updated,
      ...(issue.epic
        ? {
            epic: {
              key: issue.epic.key,
              summary: issue.epic.summary,
              status: { name: issue.epic.status },
            },
          }
        : {}),
      subtasks: issue.subtasks.map(st => ({
        key: st.key,
        fields: { summary: st.summary, status: { name: st.status } },
      })),
      issuelinks: issue.issueLinks,
      comment: {
        comments: issue.comments,
      },
      attachment: issue.attachments.map(att => ({
        id: att.id,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        content: `/secure/attachment/${att.id}/${encodeURIComponent(att.filename)}`,
      })),
    },
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

/**
 * Text for the page, HTML-escaped: issue text and comments are written by agents and people during an eval, and the page
 * has a form that posts as a synthetic approver, so nothing interpolated may become markup or script.
 */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;')
}
/** Only an http(s) link is linked; anything else (`javascript:`) becomes `#`. */
function safeUrl(url: unknown): string {
  return typeof url === 'string' && /^https?:\/\//iu.test(url) ? url : '#'
}

export function renderMockJiraHtml(issues: Map<string, MockJiraIssue>, baseUrl: string): string {
  const cards = [...issues.values()]
    .map(issue => {
      const commentsHtml = issue.comments.length === 0
        ? '<p class="muted">Комментариев пока нет.</p>'
        : issue.comments
            .map(
              c => `<div class="comment">
                <div class="comment-meta"><strong>${esc(c.author.displayName)} (@${esc(c.author.name)})</strong> · <span>${esc(c.created)}</span></div>
                <pre>${esc(c.body)}</pre>
              </div>`,
            )
            .join('\n')

      const attachmentsHtml = issue.attachments
        .map(
          att => `<li><a href="/secure/attachment/${encodeURIComponent(att.id)}/${encodeURIComponent(att.filename)}" target="_blank">${esc(att.filename)}</a> (${esc(att.size)} bytes, <code>${esc(att.mimeType)}</code>)</li>`,
        )
        .join('\n')

      return `<section class="card">
        <div class="card-header">
          <div>
            <span class="issue-key">${esc(issue.key)}</span>
            <h2>${esc(issue.summary)}</h2>
          </div>
          <span class="status-badge">${esc(issue.status)}</span>
        </div>
        <p class="meta">Epic: <strong>${issue.epic ? `${esc(issue.epic.key)} (${esc(issue.epic.summary)})` : '—'}</strong> · Priority: <strong>${esc(issue.priority)}</strong> · Updated: <code>${esc(issue.updated)}</code></p>
        <pre class="desc">${esc(issue.description)}</pre>
        <h4>Вложения (лог/текст — D2):</h4>
        <ul>${attachmentsHtml}</ul>
        <h4>Связанные задачи и ссылки:</h4>
        <ul>
          ${issue.issueLinks.map(l => `<li>${esc(l.type.outward)}: <strong>${esc(l.outwardIssue?.key)}</strong> — ${esc(l.outwardIssue?.fields.summary)}</li>`).join('')}
          ${issue.remoteLinks.map(rl => `<li><a href="${esc(safeUrl(rl.object.url))}" target="_blank">${esc(rl.object.title)}</a></li>`).join('')}
        </ul>
        <h4>Комментарии (${issue.comments.length}):</h4>
        ${commentsHtml}
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #ebecf0">
          <form onsubmit="event.preventDefault(); const f=event.target; fetch('/rest/api/2/issue/${esc(encodeURIComponent(issue.key))}/comment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({author:f.author.value,body:f.body.value})}).then(()=>location.reload());" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select name="author" style="padding:6px 8px;border-radius:4px;border:1px solid #dfe1e6">
              <option value="lead-1">lead-1 (Тимлид / Approver)</option>
              <option value="dev-ivan">dev-ivan (Разработчик)</option>
            </select>
            <input name="body" required placeholder="Написать комментарий в Jira (напр.: аппрув, согласовано, или: Ок, но добавь логирование)..." style="flex:1;min-width:280px;padding:6px 10px;border-radius:4px;border:1px solid #dfe1e6" />
            <button type="submit" style="background:#0052cc;color:#fff;border:none;padding:7px 14px;border-radius:4px;cursor:pointer;font-weight:600">Отправить комментарий</button>
          </form>
        </div>
      </section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Mock Jira Server (E2E) — Workflow Agent</title>
  <script>
    // Auto-reload every 4s ONLY when the user is not typing in a comment input
    setInterval(() => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
      const inputs = Array.from(document.querySelectorAll('input[name="body"]'));
      if (inputs.some(el => el.value.trim().length > 0)) return;
      location.reload();
    }, 4000);
  </script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 28px auto; padding: 0 16px; background: #f4f5f7; color: #172b4d; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 2px solid #dfe1e6; padding-bottom: 12px; }
    .card { background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(9,30,66,0.13); }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .issue-key { background: #deebff; color: #0747a6; font-weight: 700; padding: 3px 8px; border-radius: 4px; font-size: 13px; }
    .status-badge { background: #e3fcef; color: #006644; font-weight: 700; padding: 5px 12px; border-radius: 999px; font-size: 13px; white-space: nowrap; }
    .desc, .comment pre { background: #f8f9fa; padding: 12px; border-radius: 6px; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; border: 1px solid #ebecf0; }
    .comment { margin-top: 10px; }
    .comment-meta { font-size: 12px; color: #5e6c84; margin-bottom: 4px; }
    .muted { color: #6b778c; font-style: italic; }
    .meta { font-size: 13px; color: #5e6c84; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Mock Jira REST v2 Server</h1>
      <p class="meta">Автообновление каждые 4 сек · Интеграция с Workflow Agent</p>
    </div>
    <code>${baseUrl}</code>
  </header>
  ${cards}
</body>
</html>`
}

export async function startMockJiraServer(
  port = Number(process.env.PORT ?? 25411),
  host = process.env.HOST ?? '127.0.0.1',
): Promise<{
  server: Server
  url: string
  issues: Map<string, MockJiraIssue>
  close: () => Promise<void>
}> {
  const baseUrl = `http://127.0.0.1:${port}`
  const issues = createInitialMockJiraIssues(baseUrl)
  // The highest number given per project: a deleted ticket's key is never given again, so a new ticket never lands on an old
  // job's `jira:<KEY>` thread.
  const highest = new Map<string, number>()

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? 'GET').toUpperCase()
    const parsedUrl = new URL(req.url ?? '/', baseUrl)
    const pathname = parsedUrl.pathname

    if (method === 'POST' && pathname === '/rest/api/2/reset') {
      issues.clear()
      for (const [k, v] of createInitialMockJiraIssues(baseUrl)) {
        issues.set(k, v)
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ reset: true, issues: [...issues.keys()] }))
      return
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/jira')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderMockJiraHtml(issues, baseUrl))
      return
    }

    if (method === 'GET' && pathname === '/specs/idempotency-rfc') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('RFC-019: Idempotency keys in Redis must use prefix idemp:payments:<key> and store JSON response status + body.')
      return
    }

    // Jira's create endpoint (`T13.2`): the eval makes one ticket per run. `fields.project.key`, `summary` and `description`.
    if (method === 'POST' && pathname === '/rest/api/2/issue') {
      const body = await readJsonBody(req)
      const fields = (body.fields as Record<string, unknown> | undefined) ?? {}
      const project = String((fields.project as { key?: unknown } | undefined)?.key ?? 'ORD')
      if (!/^[A-Z][A-Z0-9_]{0,31}$/u.test(project) || typeof fields.summary !== 'string' || !fields.summary.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ errorMessages: ['fields.project.key and fields.summary are required'] }))
        return
      }
      const numbers = [...issues.keys()].filter(key => key.startsWith(`${project}-`)).map(key => Number(key.slice(project.length + 1)))
      const n = Math.max(299, highest.get(project) ?? 0, ...numbers) + 1
      highest.set(project, n)
      const key = `${project}-${n}`
      const id = String(30_000 + issues.size)
      issues.set(key, { id, key, summary: fields.summary, description: typeof fields.description === 'string' ? fields.description : '',
        status: 'К выполнению (To Do)', issueType: 'Task', priority: 'Medium', labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
        reporter: mockJiraUser(typeof (fields.reporter as { name?: unknown } | undefined)?.name === 'string' ? String((fields.reporter as { name: string }).name) : 'dev-ivan'), updated: new Date().toISOString(), subtasks: [], issueLinks: [],
        remoteLinks: [], comments: [], attachments: [] })
      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ id, key, self: `${baseUrl}/rest/api/2/issue/${id}` }))
      return
    }

    // The account the workbench logs in as: the mock's bot.
    if (method === 'GET' && pathname === '/rest/api/2/myself') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(mockJiraUser('workbench')))
      return
    }

    // Jira Server's user search (`D12`): matches a username or an email, as the workbench resolves approvers and ticket authors.
    if (method === 'GET' && pathname === '/rest/api/2/user/search') {
      const wanted = (parsedUrl.searchParams.get('username') ?? '').toLowerCase()
      const users = Object.keys(MOCK_JIRA_USERS).map(mockJiraUser)
        .filter(user => wanted && (user.name.toLowerCase() === wanted || user.emailAddress?.toLowerCase() === wanted))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(users.map(user => ({ ...user, active: true }))))
      return
    }

    if (method === 'GET' && pathname === '/rest/api/2/search') {
      const list = [...issues.values()].map(i => toJiraRestIssue(i))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ issues: list, total: list.length }))
      return
    }

    const attachmentMatch = /^\/secure\/attachment\/([^/]+)\/(.+)$/.exec(pathname)
    if (method === 'GET' && attachmentMatch) {
      const attId = attachmentMatch[1]!
      for (const issue of issues.values()) {
        const found = issue.attachments.find(a => a.id === attId)
        if (found) {
          res.writeHead(200, { 'Content-Type': `${found.mimeType}; charset=utf-8` })
          res.end(found.textContent)
          return
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Attachment not found' }))
      return
    }

    const remoteLinkMatch = /^\/rest\/api\/2\/issue\/([^/]+)\/remotelink$/.exec(pathname)
    if (method === 'GET' && remoteLinkMatch) {
      const key = decodeURIComponent(remoteLinkMatch[1]!)
      const issue = issues.get(key)
      if (!issue) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ errorMessages: [`Issue ${key} not found`] }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(issue.remoteLinks))
      return
    }

    const commentMatch = /^\/rest\/api\/2\/issue\/([^/]+)\/comment$/.exec(pathname)
    if (commentMatch) {
      const key = decodeURIComponent(commentMatch[1]!)
      const issue = issues.get(key)
      if (!issue) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ errorMessages: [`Issue ${key} not found`] }))
        return
      }
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ comments: issue.comments }))
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const authorName = typeof body.author === 'string' ? body.author : 'workbench'
        const comment: MockJiraComment = {
          id: `c-${Date.now()}-${issue.comments.length + 1}`,
          author: mockJiraUser(authorName),
          body: String(body.body ?? ''),
          created: new Date().toISOString(),
        }
        issue.comments.push(comment)
        issue.updated = comment.created
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(comment))
        return
      }
    }

    const transitionMatch = /^\/rest\/api\/2\/issue\/([^/]+)\/transitions$/.exec(pathname)
    if (transitionMatch) {
      const key = decodeURIComponent(transitionMatch[1]!)
      const issue = issues.get(key)
      if (!issue) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ errorMessages: [`Issue ${key} not found`] }))
        return
      }
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            transitions: [
              { id: '11', name: 'To Do', to: { name: 'К выполнению (To Do)' } },
              { id: '11', name: 'К выполнению', to: { name: 'К выполнению (To Do)' } },
              { id: '21', name: 'In Progress', to: { name: 'В работе (In Progress)' } },
              { id: '21', name: 'В работе', to: { name: 'В работе (In Progress)' } },
              { id: '31', name: 'In Review', to: { name: 'На ревью (In Review)' } },
              { id: '31', name: 'На ревью', to: { name: 'На ревью (In Review)' } },
              { id: '41', name: 'Done', to: { name: 'Готово (Done)' } },
              { id: '41', name: 'Готово', to: { name: 'Готово (Done)' } },
            ],
          }),
        )
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const transitionObj = body.transition as { id?: string; name?: string } | undefined
        const transitionId = String(transitionObj?.id ?? transitionObj?.name ?? '21')
        issue.status = TRANSITION_STATUS_MAP[transitionId] ?? transitionId
        issue.updated = new Date().toISOString()
        res.writeHead(204)
        res.end()
        return
      }
    }

    const issueMatch = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(pathname)
    if (issueMatch) {
      const key = decodeURIComponent(issueMatch[1]!)
      const issue = issues.get(key)
      if (!issue) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ errorMessages: [`Issue ${key} not found`] }))
        return
      }
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(toJiraRestIssue(issue)))
        return
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req)
        const fields = (body.fields as Record<string, unknown> | undefined) ?? {}
        if (typeof fields.summary === 'string') issue.summary = fields.summary
        if (typeof fields.description === 'string') issue.description = fields.description
        if (Array.isArray(fields.labels)) issue.labels = fields.labels.map(String)
        issue.updated = new Date().toISOString()
        res.writeHead(204)
        res.end()
        return
      }
      if (method === 'DELETE') {
        issues.delete(key)
        res.writeHead(204)
        res.end()
        return
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not Found', path: pathname }))
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => resolveListen())
  })

  return {
    server,
    url: baseUrl,
    issues,
    close: async () => {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockJiraServer().then(({ url }) => {
    process.stdout.write(`Mock Jira server listening on ${url}\n`)
  })
}
