/**
 * Phase 3 (`G4`) contract, context-gathering, and resilience test suite for the
 * Mattermost, Jira, and GitLab outbound-polling connectors (`F2`, `F8`, `F10`, `A4`, `A7`, `A8`, `D5`, `D7`).
 */
import { describe, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { GitLabConnector, pollGitLabOnce } from '../src/sources/gitlab.ts'
import { JiraConnector, buildJiraPollJql, isReadableTextAttachment, pollJiraOnce } from '../src/sources/jira.ts'
import { MattermostConnector, pollMattermostOnce } from '../src/sources/mattermost.ts'

describe('Phase 3 (G4) — Mattermost, Jira & GitLab Outbound-Polling Connectors', () => {
  describe('Mattermost Connector (D5, D7)', () => {
    it('polls both public (O) and private (P) channels the bot belongs to, suppresses bot self-loops, and persists cursors', async () => {
      const apiCalls: string[] = []
      const fakeFetch: typeof fetch = async (input, _init) => {
        const url = String(input)
        apiCalls.push(url)
        if (url.endsWith('/api/v4/users/me')) {
          return new Response(JSON.stringify({ id: 'bot-uid-1', username: 'workbench' }), { status: 200 })
        }
        if (url.endsWith('/api/v4/users/bot-uid-1/channels')) {
          return new Response(
            JSON.stringify([
              { id: 'ch-public-1', type: 'O', name: 'backend-dev', display_name: 'Backend Dev' },
              { id: 'ch-private-1', type: 'P', name: 'sec-incident', display_name: 'Security Private' },
            ]),
            { status: 200 },
          )
        }
        if (url.includes('/api/v4/channels/ch-public-1/posts')) {
          return new Response(
            JSON.stringify({
              order: ['post-bot-self', 'post-human-1'],
              posts: {
                'post-bot-self': {
                  id: 'post-bot-self',
                  create_at: 1000,
                  user_id: 'bot-uid-1',
                  channel_id: 'ch-public-1',
                  message: '@ivan Принято в работу',
                },
                'post-human-1': {
                  id: 'post-human-1',
                  create_at: 2000,
                  user_id: 'user-ivan',
                  channel_id: 'ch-public-1',
                  message: '@workbench Проверь задачу PROJ-105',
                },
              },
            }),
            { status: 200 },
          )
        }
        if (url.includes('/api/v4/channels/ch-private-1/posts')) {
          return new Response(
            JSON.stringify({
              order: ['post-private-1'],
              posts: {
                'post-private-1': {
                  id: 'post-private-1',
                  create_at: 3000,
                  user_id: 'user-anna',
                  channel_id: 'ch-private-1',
                  root_id: 'root-private-0',
                  message: ' аппрув ',
                },
              },
            }),
            { status: 200 },
          )
        }
        return new Response('Not found', { status: 404 })
      }

      const mm = new MattermostConnector({
        baseUrl: 'https://mm.example.com',
        token: 'mm-secret-token-xyz',
        fetchImpl: fakeFetch,
      })

      // `startedAt: 0`: polling started before these posts, so a first read of the channel delivers them.
      const poll1 = await mm.poll({ channelSince: {}, seenPostIds: [], startedAt: 0 })
      // Bot's own post (`post-bot-self`) must be suppressed; both public and private channel human posts must be returned!
      expect(poll1.triggers).toHaveLength(2)
      expect(poll1.triggers[0]).toMatchObject({
        id: 'mm_post-human-1',
        source: 'mattermost',
        addressed: 'mention',
        actor: { source: 'mattermost', id: 'user-ivan' },
        threads: [{ source: 'mattermost', id: 'ch-public-1:post-human-1' }],
      })
      expect(poll1.triggers[1]).toMatchObject({
        id: 'mm_post-private-1',
        source: 'mattermost',
        actor: { source: 'mattermost', id: 'user-anna' },
        threads: [{ source: 'mattermost', id: 'ch-private-1:root-private-0' }],
        meta: { channelType: 'P', channelId: 'ch-private-1' },
      })

      // Second poll with persisted cursor must deduplicate already-seen posts (`A8`).
      const poll2 = await mm.poll(poll1.nextCursor)
      expect(poll2.triggers).toHaveLength(0)
    })

  })

  describe('Jira Connector (D5, D7)', () => {
    it('supports both HTTP Basic and Bearer PAT auth, traverses Epics, subtasks, issuelinks, /remotelink URLs, and reads .log/.json/.txt attachments while rejecting binaries', async () => {
      const seenAuthHeaders: string[] = []
      let issueGetAttempts = 0

      const fakeFetch: typeof fetch = async (input, init) => {
        const url = String(input)
        const headers = init?.headers as Record<string, string> | undefined
        if (headers?.Authorization) seenAuthHeaders.push(headers.Authorization)

        if (url.endsWith('/rest/api/2/issue/PROJ-42')) {
          issueGetAttempts++
          // Simulate a transient 429 rate-limit on the first request (`A8`).
          if (issueGetAttempts === 1) {
            return new Response('Rate limited', { status: 429, headers: { 'retry-after': '0' } })
          }
          return new Response(
            JSON.stringify({
              key: 'PROJ-42',
              fields: {
                summary: 'Ошибка таймаута при оплате через СБП',
                description: 'При высокой нагрузке воркер падает с ошибкой таймаута. См. приложенный лог.',
                status: { name: 'In Progress' },
                issuetype: { name: 'Bug' },
                priority: { name: 'High' },
                labels: ['payments', 'sbp'],
                epic: { key: 'PROJ-10', summary: 'Стабилизация платежного шлюза Q4', status: { name: 'In Progress' } },
                subtasks: [
                  { key: 'PROJ-43', fields: { summary: 'Добавить метрики пула соединений', status: { name: 'Open' } } },
                ],
                issuelinks: [
                  {
                    id: 'link-1',
                    type: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
                    outwardIssue: {
                      key: 'PROJ-50',
                      fields: { summary: 'Запуск СБП в продакшн', status: { name: 'Blocked' } },
                    },
                  },
                  {
                    id: 'link-2',
                    type: { name: 'Relates', outward: 'relates to', inward: 'relates to' },
                    inwardIssue: {
                      key: 'PROJ-39',
                      fields: { summary: 'Миграция драйвера Redis', status: { name: 'Done' } },
                    },
                  },
                ],
                comment: {
                  comments: [
                    {
                      id: 'c-101',
                      author: { name: 'qa.olga' },
                      body: 'Воспроизводится при 500 RPS, лог прикрепила.',
                      created: '2026-11-06T01:00:00.000Z',
                    },
                  ],
                },
                attachment: [
                  {
                    id: 'att-log-1',
                    filename: 'payment-gateway-error.log',
                    mimeType: 'text/plain',
                    size: 184,
                    content: 'https://jira.example.com/secure/attachment/att-log-1/payment-gateway-error.log',
                  },
                  {
                    id: 'att-img-2',
                    filename: 'screenshot.png',
                    mimeType: 'image/png',
                    size: 40960,
                    content: 'https://jira.example.com/secure/attachment/att-img-2/screenshot.png',
                  },
                ],
              },
            }),
            { status: 200 },
          )
        }

        if (url.endsWith('/rest/api/2/issue/PROJ-42/remotelink')) {
          return new Response(
            JSON.stringify([
              {
                id: 701,
                relationship: 'Wiki Page',
                object: {
                  title: 'Confluence: Архитектура платежного шлюза СБП',
                  url: 'https://confluence.example.com/pages/viewpage.action?pageId=701',
                },
              },
            ]),
            { status: 200 },
          )
        }

        if (url.endsWith('/secure/attachment/att-log-1/payment-gateway-error.log')) {
          return new Response(
            '2026-11-06T00:59:12Z ERROR [PaymentWorker] Redis pool exhausted after 5000ms (maxConnections=10)',
            { status: 200 },
          )
        }

        if (url.endsWith('/rest/api/2/issue/PROJ-42/comment') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'c-202' }), { status: 201 })
        }

        return new Response('Not found', { status: 404 })
      }

      // Test HTTP Basic Auth header encoding (`G4`)
      const basicJira = new JiraConnector({
        baseUrl: 'https://jira.example.com',
        auth: { kind: 'basic', username: 'svc.workbench', password: 'basic-secret-password' },
        fetchImpl: fakeFetch,
        baseBackoffMs: 1,
      })
      expect(basicJira.authHeader()).toBe(
        `Basic ${Buffer.from('svc.workbench:basic-secret-password', 'utf8').toString('base64')}`,
      )

      // Test Bearer PAT Auth + full issue context traversal (`D5`, `D7`)
      const bearerJira = new JiraConnector({
        baseUrl: 'https://jira.example.com',
        auth: { kind: 'bearer', token: 'jira-pat-token-999' },
        fetchImpl: fakeFetch,
        baseBackoffMs: 1,
      })

      const issue = await bearerJira.getIssue('PROJ-42')
      expect(issueGetAttempts).toBe(2) // Recovered from 429 on first attempt!
      expect(issue.key).toBe('PROJ-42')
      expect(issue.epic).toEqual({
        key: 'PROJ-10',
        summary: 'Стабилизация платежного шлюза Q4',
        status: 'In Progress',
      })
      expect(issue.subtasks).toEqual([
        { key: 'PROJ-43', summary: 'Добавить метрики пула соединений', status: 'Open' },
      ])
      expect(issue.issueLinks).toEqual([
        {
          id: 'link-1',
          type: 'Blocks',
          direction: 'outward',
          relationship: 'blocks',
          targetKey: 'PROJ-50',
          targetSummary: 'Запуск СБП в продакшн',
          targetStatus: 'Blocked',
        },
        {
          id: 'link-2',
          type: 'Relates',
          direction: 'inward',
          relationship: 'relates to',
          targetKey: 'PROJ-39',
          targetSummary: 'Миграция драйвера Redis',
          targetStatus: 'Done',
        },
      ])
      expect(issue.remoteLinks).toEqual([
        {
          id: '701',
          title: 'Confluence: Архитектура платежного шлюза СБП',
          url: 'https://confluence.example.com/pages/viewpage.action?pageId=701',
          relationship: 'Wiki Page',
        },
      ])
      expect(issue.attachments).toHaveLength(2)
      expect(issue.attachments[0]?.readableAsText).toBe(true)
      expect(issue.attachments[1]?.readableAsText).toBe(false)

      // Read `.log` attachment via `jira_read_attachment` (`D5`, `D7`).
      const logAttachment = await bearerJira.readTextAttachment({
        issueKey: 'PROJ-42',
        attachmentId: issue.attachments[0]!.id,
        filename: issue.attachments[0]!.filename,
        contentUrl: issue.attachments[0]!.contentUrl,
        mimeType: issue.attachments[0]!.mimeType,
      })
      expect(logAttachment.content).toContain('Redis pool exhausted after 5000ms')
      expect(logAttachment.truncated).toBe(false)

      // Binary/image attachment (`screenshot.png`) must be rejected (`D5`, `D7`).
      await expect(
        bearerJira.readTextAttachment({
          issueKey: 'PROJ-42',
          attachmentId: issue.attachments[1]!.id,
          filename: issue.attachments[1]!.filename,
          contentUrl: issue.attachments[1]!.contentUrl,
          mimeType: issue.attachments[1]!.mimeType,
        }),
      ).rejects.toThrow('Binary or image attachment "screenshot.png" (image/png) is not supported')

      expect(isReadableTextAttachment('dump.sql')).toBe(true)
      expect(isReadableTextAttachment('config.yaml')).toBe(true)
      expect(isReadableTextAttachment('payload.json')).toBe(true)
      expect(isReadableTextAttachment('archive.zip')).toBe(false)
    })
  })

  describe('GitLab Connector (D5, D6)', () => {

    it('paginates GitLab MR notes/discussions (>100 items) and Jira search (>50 issues), and builds cursor-based JQL across 3h outages', async () => {
      // 1. GitLab pagination: 125 notes and 125 discussions across 2 pages (100 + 25).
      const allNotes = Array.from({ length: 125 }, (_, idx) => ({
        id: idx + 1,
        body: `Ревью-комментарий #${idx + 1}`,
        created_at: new Date(Date.parse('2026-11-06T01:00:00.000Z') + idx * 1000).toISOString(),
        system: false,
        author: { id: 42, username: 'reviewer.sergey' },
      }))
      const allDiscussions = Array.from({ length: 125 }, (_, idx) => ({
        id: `disc_${idx + 1}`,
        notes: [
          {
            id: idx + 1001,
            body: `Тред #${idx + 1}`,
            created_at: '2026-11-06T01:00:00.000Z',
            system: false,
            author: { username: 'reviewer.sergey' },
          },
        ],
      }))

      const glFetch: typeof fetch = async input => {
        const parsed = new URL(String(input))
        const perPage = Number(parsed.searchParams.get('per_page') ?? '20')
        const page = Number(parsed.searchParams.get('page') ?? '1')
        const start = (page - 1) * perPage
        if (parsed.pathname.endsWith('/merge_requests/17/notes')) {
          const slice = allNotes.slice(start, start + perPage)
          const nextPage = start + perPage < allNotes.length ? String(page + 1) : ''
          return new Response(JSON.stringify(slice), { status: 200, headers: { 'x-next-page': nextPage } })
        }
        if (parsed.pathname.endsWith('/merge_requests/17/discussions')) {
          const slice = allDiscussions.slice(start, start + perPage)
          const nextPage = start + perPage < allDiscussions.length ? String(page + 1) : ''
          return new Response(JSON.stringify(slice), { status: 200, headers: { 'x-next-page': nextPage } })
        }
        if (parsed.pathname.endsWith('/merge_requests/17/pipelines')) {
          return new Response(JSON.stringify([]), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      }

      const gitlab = new GitLabConnector({
        baseUrl: 'https://gitlab.example.com',
        token: 'gl-tok',
        fetchImpl: glFetch,
      })

      // Notes are read through their discussions, oldest first, each with its discussion's id (trial 2026-11-14).
      const glPoll1 = await gitlab.poll([{ project: 'acme/payments', iid: 17 }])
      expect(glPoll1.triggers).toHaveLength(125)
      expect(glPoll1.triggers[0]?.text).toBe('Тред #1')
      expect(glPoll1.triggers[124]?.text).toBe('Тред #125')
      expect(glPoll1.triggers[124]?.meta).toMatchObject({ noteId: 1125, discussionId: 'disc_125' })

      // Repeated poll with nextCursor deduplicates all 125 notes.
      const glPoll2 = await gitlab.poll([{ project: 'acme/payments', iid: 17 }], glPoll1.nextCursor)
      expect(glPoll2.triggers).toHaveLength(0)

      const discRes = await gitlab.listDiscussions({ project: 'acme/payments', mrIid: 17 })
      expect(discRes.discussions).toHaveLength(125)
      expect(discRes.discussions[124]?.id).toBe('disc_125')

      // 2. Jira pagination (>50 matching issues) and simulated 3-hour outage recovery via cursor-based JQL.
      const baseTimeMs = Date.parse('2026-11-06T01:00:00.000Z')
      const jiraIssues = Array.from({ length: 120 }, (_, idx) => {
        // Issues 0..119 span 3 hours (every 90s from 01:00 to 04:00).
        const updatedIso = new Date(baseTimeMs + (idx + 1) * 90_000).toISOString()
        return {
          id: String(10000 + idx),
          key: `PAY-${idx + 1}`,
          fields: {
            summary: `Платежная задача #${idx + 1}`,
            description: 'Описание',
            updated: updatedIso,
            reporter: { name: 'ivan.petrov' },
            comment: { comments: [] },
          },
        }
      })

      const seenJqls: string[] = []
      let currentWallClockMs = baseTimeMs + 30 * 60_000 // First poll at 01:30 (20 issues exist so far)

      const jiraFetch: typeof fetch = async input => {
        const parsed = new URL(String(input))
        if (parsed.pathname.endsWith('/rest/api/2/search')) {
          const jql = parsed.searchParams.get('jql') ?? ''
          seenJqls.push(jql)
          const startAt = Number(parsed.searchParams.get('startAt') ?? '0')
          const maxResults = Number(parsed.searchParams.get('maxResults') ?? '50')

          // Simulate real Jira JQL evaluation:
          // - If query has relative `updated >= -1h`, only return issues within [currentWallClockMs - 1h, currentWallClockMs].
          // - If query has the cursor's `updated >= -<N>m`, return all issues of the last N minutes up to currentWallClockMs!
          let minUpdatedMs = 0
          const minutes = /updated\s*>=\s*-(\d+)m/iu.exec(jql)?.[1]
          if (/updated\s*>=\s*-1h/iu.test(jql)) {
            minUpdatedMs = currentWallClockMs - 3600_000
          } else if (minutes) {
            minUpdatedMs = currentWallClockMs - Number(minutes) * 60_000
          }

          const matching = jiraIssues.filter(iss => {
            const u = Date.parse(String(iss.fields.updated))
            return u >= minUpdatedMs && u <= currentWallClockMs
          })
          const pageSlice = matching.slice(startAt, startAt + maxResults)
          return new Response(
            JSON.stringify({ startAt, maxResults, total: matching.length, issues: pageSlice }),
            { status: 200 },
          )
        }
        return new Response('Not found', { status: 404 })
      }

      const jira = new JiraConnector({
        baseUrl: 'https://jira.example.com',
        auth: { kind: 'bearer', token: 'j-tok' },
        jql: 'project = PAY AND updated >= -1h ORDER BY updated ASC',
        fetchImpl: jiraFetch,
      })

      // Poll 1 at 01:30 (no cursor yet -> uses relative `-1h`, gets issues 1..20).
      const jPoll1 = await jira.poll()
      expect(jPoll1.triggers).toHaveLength(20)
      expect(seenJqls[0]).toBe('project = PAY AND updated >= -1h ORDER BY updated ASC')

      // Simulate a 3-hour outage: advance wall clock to 04:30 (issues 21..120 were created between 01:31 and 04:00, including >2h ago!).
      currentWallClockMs = baseTimeMs + 3.5 * 3600_000
      const jPoll2 = await jira.poll(jPoll1.nextCursor)
      // The cursor is 01:30 (issue 20); at 04:30 the window is the 180 minutes since, plus 5 minutes of overlap.
      expect(buildJiraPollJql('project = PAY AND updated >= -1h ORDER BY updated ASC', jPoll1.nextCursor.lastUpdatedIso, currentWallClockMs))
        .toBe('project = PAY AND updated >= -185m ORDER BY updated ASC')
      // All 100 remaining issues (21..120) are fetched across 3 paginated requests and deduplicated against issues 1..20!
      expect(jPoll2.triggers).toHaveLength(100)
      expect(jPoll2.triggers[0]?.id).toBe('jira_issue_PAY-21')
      expect(jPoll2.triggers[99]?.id).toBe('jira_issue_PAY-120')

      // Poll 3 immediately after -> 0 new triggers (all 120 deduplicated).
      const jPoll3 = await jira.poll(jPoll2.nextCursor)
      expect(jPoll3.triggers).toHaveLength(0)
    })

    it('saves cursor incrementally so aborting mid-batch does not drop remaining triggers, and isolates per-MR 404 errors in health', async () => {
      // 1. Aborting in the middle of a Jira poll batch delivers trigger 1, and triggers 2 & 3 arrive on the next poll.
      // A system that already ran: an existing cursor, so the first poll delivers (a fresh state directory only records a baseline).
      const jiraState = new Map<string, unknown>([[KV.jira.cursor, { seenEventIds: [] }]])
      const stateAdapter = {
        get: (k: string) => jiraState.get(k) as never,
        set: (k: string, v: unknown) => { jiraState.set(k, v) },
      }
      const jiraFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            issues: ['PAY-1', 'PAY-2', 'PAY-3'].map((key, idx) => ({
              id: String(idx + 1),
              key,
              fields: {
                summary: `Задача ${key}`,
                updated: `2026-11-06T01:0${idx + 1}:00.000Z`,
                reporter: { name: 'alice' },
                comment: { comments: [] },
              },
            })),
          }),
          { status: 200 },
        )
      const jira = new JiraConnector({
        baseUrl: 'https://jira.example.com',
        auth: { kind: 'bearer', token: 'j-tok' },
        fetchImpl: jiraFetch,
      })

      const abort1 = new AbortController()
      const received1: string[] = []
      await pollJiraOnce({
        connector: jira,
        state: stateAdapter,
        receive: async trig => {
          received1.push(trig.id)
          // Abort right after receiving the first trigger!
          abort1.abort()
        },
        report: () => {},
        signal: abort1.signal,
      })
      expect(received1).toEqual(['jira_issue_PAY-1'])

      // Next poll with a fresh AbortSignal receives PAY-2 and PAY-3 (without re-delivering PAY-1).
      const abort2 = new AbortController()
      const received2: string[] = []
      await pollJiraOnce({
        connector: jira,
        state: stateAdapter,
        receive: async trig => {
          received2.push(trig.id)
        },
        report: () => {},
        signal: abort2.signal,
      })
      expect(received2).toEqual(['jira_issue_PAY-2', 'jira_issue_PAY-3'])

      // 2. GitLab poll where MR !404 returns 404 still delivers notes from MR !18 and reports the failing MR in health.
      const glState = new Map<string, unknown>()
      const glStateAdapter = {
        get: (k: string) => glState.get(k) as never,
        set: (k: string, v: unknown) => { glState.set(k, v) },
      }
      const glFetch: typeof fetch = async input => {
        const url = String(input)
        if (url.includes('/merge_requests/404/')) {
          return new Response('MR Not Found', { status: 404 })
        }
        if (url.includes('/merge_requests/18/discussions')) {
          return new Response(
            JSON.stringify([{ id: 'd901', notes: [
              {
                id: 901,
                body: 'Комментарий из здорового MR !18',
                created_at: '2026-11-06T02:00:00.000Z',
                system: false,
                author: { id: 10, username: 'reviewer.olga' },
              },
            ] }]),
            { status: 200 },
          )
        }
        if (url.includes('/merge_requests/18/pipelines')) {
          return new Response(JSON.stringify([]), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      }

      const gitlab = new GitLabConnector({
        baseUrl: 'https://gitlab.example.com',
        token: 'gl-tok',
        fetchImpl: glFetch,
      })
      const glReceived: string[] = []
      const glHealthReports: { state: string; detail: string }[] = []

      await pollGitLabOnce({
        connector: gitlab,
        watchedMrs: [
          { project: 'acme/payments', iid: 404 },
          { project: 'acme/payments', iid: 18 },
        ],
        state: glStateAdapter,
        receive: async trig => {
          glReceived.push(trig.text)
        },
        report: (_name, status) => {
          glHealthReports.push(status)
        },
        signal: new AbortController().signal,
      })

      expect(glReceived).toEqual(['Комментарий из здорового MR !18'])
      expect(glHealthReports).toHaveLength(1)
      expect(glHealthReports[0]?.state).toBe('error')
      expect(glHealthReports[0]?.detail).toContain('acme/payments!mr_404')
      expect((glState.get(KV.gitlab.cursor) as { seenNoteIds: string[] })?.seenNoteIds).toContain('acme/payments!mr_18#note_901')

      // 3. Mattermost mid-batch abort preserves remaining posts for the next poll.
      const mmState = new Map<string, unknown>([[KV.mattermost.cursor, { channelSince: {}, seenPostIds: [], startedAt: 0 }]])
      const mmStateAdapter = {
        get: (k: string) => mmState.get(k) as never,
        set: (k: string, v: unknown) => { mmState.set(k, v) },
      }
      const mmFetch: typeof fetch = async input => {
        const url = String(input)
        if (url.endsWith('/api/v4/users/me')) {
          return new Response(JSON.stringify({ id: 'bot_1', username: 'bot' }), { status: 200 })
        }
        if (url.endsWith('/api/v4/users/bot_1/channels')) {
          return new Response(JSON.stringify([{ id: 'ch_1', type: 'O', name: 'dev', display_name: 'Dev' }]), { status: 200 })
        }
        if (url.includes('/api/v4/channels/ch_1/posts')) {
          return new Response(
            JSON.stringify({
              order: ['p1', 'p2'],
              posts: {
                p1: { id: 'p1', channel_id: 'ch_1', user_id: 'u1', message: '@bot Первый пост', create_at: 1000 },
                p2: { id: 'p2', channel_id: 'ch_1', user_id: 'u1', message: '@bot Второй пост', create_at: 2000 },
              },
            }),
            { status: 200 },
          )
        }
        return new Response('Not found', { status: 404 })
      }
      const mm = new MattermostConnector({
        baseUrl: 'https://mm.example.com',
        token: 'mm-tok',
        botUserId: 'bot_1',
        fetchImpl: mmFetch,
      })
      const mmAbort1 = new AbortController()
      const mmReceived1: string[] = []
      await pollMattermostOnce({
        connector: mm,
        state: mmStateAdapter,
        receive: async trig => {
          mmReceived1.push(trig.id)
          mmAbort1.abort()
        },
        report: () => {},
        signal: mmAbort1.signal,
      })
      expect(mmReceived1).toEqual(['mm_p1'])

      const mmReceived2: string[] = []
      await pollMattermostOnce({
        connector: mm,
        state: mmStateAdapter,
        receive: async trig => {
          mmReceived2.push(trig.id)
        },
        report: () => {},
        signal: new AbortController().signal,
      })
      expect(mmReceived2).toEqual(['mm_p2'])
    })
  })
})

describe('first start on a fresh state directory (A17)', () => {
  const mmFetch = (posts: { id: string; create_at: number }[]): typeof fetch => async input => {
    const url = String(input)
    if (url.endsWith('/api/v4/users/me')) return new Response(JSON.stringify({ id: 'bot_1', username: 'bot' }), { status: 200 })
    if (url.endsWith('/api/v4/users/bot_1/channels')) {
      return new Response(JSON.stringify([{ id: 'ch_1', type: 'O', name: 'dev', display_name: 'Dev' }]), { status: 200 })
    }
    if (url.includes('/api/v4/channels/ch_1/posts')) {
      const since = Number(new URL(url).searchParams.get('since') ?? 0)
      const fresh = posts.filter(post => post.create_at > since)
      return new Response(JSON.stringify({ order: fresh.map(post => post.id), posts: Object.fromEntries(fresh.map(post =>
        [post.id, { ...post, channel_id: 'ch_1', user_id: 'u1', message: `@bot ${post.id}` }])) }), { status: 200 })
    }
    return new Response('Not found', { status: 404 })
  }
  const adapter = (state: Map<string, unknown>) => ({ get: (k: string) => state.get(k) as never, set: (k: string, v: unknown) => { state.set(k, v) } })

  it('records a Mattermost baseline without delivering old posts, then delivers only newer ones', async () => {
    const start = Date.now()
    const posts = [{ id: 'old', create_at: start - 60_000 }]
    const mm = new MattermostConnector({ baseUrl: 'https://mm.example.com', token: 'mm-tok', botUserId: 'bot_1', fetchImpl: mmFetch(posts) })
    const state = new Map<string, unknown>()
    const received: string[] = []
    const poll = () => pollMattermostOnce({ connector: mm, state: adapter(state), receive: trigger => { received.push(trigger.id) },
      report: () => {}, signal: new AbortController().signal })
    await poll()
    expect(received).toEqual([])
    const baseline = state.get(KV.mattermost.cursor) as { channelSince: Record<string, number>; startedAt: number }
    expect(baseline.startedAt).toBeGreaterThanOrEqual(start)
    expect(baseline.channelSince.ch_1).toBe(baseline.startedAt)
    posts.push({ id: 'new', create_at: Date.now() + 1000 })
    await poll()
    expect(received).toEqual(['mm_new'])
  })

  it('records a Mattermost baseline even when one channel fails, and that channel later delivers nothing from before the start', async () => {
    const start = Date.now()
    const posts = [{ id: 'old', create_at: start - 60_000 }]
    const base = mmFetch(posts)
    let broken = true
    const brokenPosts = [{ id: 'b_old', create_at: start - 60_000 }, { id: 'b_new', create_at: start + 60_000 }]
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/v4/users/bot_1/channels')) return new Response(JSON.stringify([{ id: 'ch_1', type: 'O', name: 'dev' },
        { id: 'ch_broken', type: 'O', name: 'broken' }]), { status: 200 })
      if (url.includes('/api/v4/channels/ch_broken/')) {
        if (broken) return new Response('Forbidden', { status: 403 })
        return Response.json({ order: brokenPosts.map(post => post.id), posts: Object.fromEntries(brokenPosts.map(post =>
          [post.id, { ...post, channel_id: 'ch_broken', user_id: 'u1', message: `@bot ${post.id}` }])) })
      }
      return base(input, init)
    }
    const mm = new MattermostConnector({ baseUrl: 'https://mm.example.com', token: 'mm-tok', botUserId: 'bot_1', fetchImpl })
    const state = new Map<string, unknown>()
    const received: string[] = []
    const reports: string[] = []
    const poll = () => pollMattermostOnce({ connector: mm, state: adapter(state), receive: trigger => { received.push(trigger.id) },
      report: (_name, status) => { reports.push(status.state) }, signal: new AbortController().signal })
    await poll()
    expect(reports).toEqual(['error'])
    expect(Object.keys((state.get(KV.mattermost.cursor) as { channelSince: object }).channelSince)).toEqual(['ch_1'])
    posts.push({ id: 'new', create_at: Date.now() + 1000 })
    broken = false
    await poll()
    expect(received).toEqual(['mm_new', 'mm_b_new'])
  })

  it('reads a Mattermost channel joined after the first start from the bot\'s join, and a new direct channel from its creation', async () => {
    const start = Date.now() - 3_600_000
    const at = (minutes: number) => start + minutes * 60_000
    const channels = [{ id: 'ch_new', type: 'O', name: 'later', create_at: at(-600) }, { id: 'dm_1', type: 'D', name: 'bot__u1', create_at: at(30) }]
    const posts: Record<string, { id: string; create_at: number; user_id: string; message: string; type?: string; props?: object }[]> = {
      ch_new: [
        { id: 'before_start', create_at: at(-10), user_id: 'u1', message: '@bot old ask' },
        { id: 'before_join', create_at: at(10), user_id: 'u1', message: '@bot asked before the bot was here' },
        { id: 'join', create_at: at(20), user_id: 'u2', message: 'added', type: 'system_add_to_channel', props: { addedUserId: 'bot_1' } },
        { id: 'after_join', create_at: at(25), user_id: 'u1', message: '@bot take ORD-7' },
      ],
      dm_1: [{ id: 'first_dm', create_at: at(30), user_id: 'u1', message: 'hi, please look at ORD-8' }],
    }
    const fetchImpl: typeof fetch = async input => {
      const url = String(input)
      if (url.endsWith('/api/v4/users/me')) return Response.json({ id: 'bot_1', username: 'bot' })
      if (url.endsWith('/api/v4/users/bot_1/channels')) return Response.json(channels)
      const channel = /\/channels\/([^/]+)\/posts/u.exec(url)?.[1]
      if (channel) return Response.json({ order: posts[channel]!.map(post => post.id),
        posts: Object.fromEntries(posts[channel]!.map(post => [post.id, { ...post, channel_id: channel }])) })
      return new Response('{}', { status: 200 })
    }
    const mm = new MattermostConnector({ baseUrl: 'https://mm.example.com', token: 'mm-tok', botUserId: 'bot_1', fetchImpl })
    const { triggers } = await mm.poll({ channelSince: {}, seenPostIds: [], startedAt: start })
    expect(triggers.map(trigger => trigger.id)).toEqual(['mm_after_join', 'mm_first_dm'])
  })

  it('starts the Jira cursor at first start and never delivers events created before it', async () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    type Issue = { key: string; created: string; updated: string; comments: { id: string; body: string; created: string }[] }
    const issues: Issue[] = [
      { key: 'PAY-1', created: minutesAgo(600), updated: minutesAgo(300), comments: [{ id: '10', body: 'old ask', created: minutesAgo(300) }] },
      { key: 'PAY-2', created: minutesAgo(500), updated: minutesAgo(500), comments: [] },
    ]
    // Like Jira, answer the JQL's `updated >= -<N>m` clause; a search without one returns every issue.
    const jiraFetch: typeof fetch = async input => {
      const minutes = /updated >= -(\d+)m/u.exec(new URL(String(input)).searchParams.get('jql') ?? '')?.[1]
      const from = minutes ? Date.now() - Number(minutes) * 60_000 : 0
      const found = issues.filter(issue => Date.parse(issue.updated) >= from)
      return new Response(JSON.stringify({ total: found.length, issues: found.map((issue, index) => ({ id: String(index + 1), key: issue.key,
        fields: { summary: issue.key, created: issue.created, updated: issue.updated, reporter: { name: 'alice' },
          comment: { comments: issue.comments.map(comment => ({ ...comment, author: { name: 'alice' } })) } } })) }), { status: 200 })
    }
    const jira = new JiraConnector({ baseUrl: 'https://jira.example.com', auth: { kind: 'bearer', token: 'j-tok' }, fetchImpl: jiraFetch })
    const state = new Map<string, unknown>()
    const received: string[] = []
    const poll = () => pollJiraOnce({ connector: jira, state: adapter(state), receive: trigger => { received.push(trigger.id) },
      report: () => {}, signal: new AbortController().signal })
    await poll()
    expect(received).toEqual([])
    expect(Date.parse((state.get(KV.jira.cursor) as { lastUpdatedIso: string }).lastUpdatedIso)).toBeGreaterThan(Date.parse(minutesAgo(1)))
    // After the start, an old issue is edited and commented on, and a new issue is filed: only the new events are delivered.
    issues[0]!.updated = new Date(Date.now() + 1000).toISOString()
    issues[0]!.comments.push({ id: '11', body: 'new ask', created: issues[0]!.updated })
    issues[1]!.updated = issues[0]!.updated
    issues.push({ key: 'PAY-3', created: issues[0]!.updated, updated: issues[0]!.updated, comments: [] })
    await poll()
    expect(received).toEqual(['jira_comment_PAY-1_11', 'jira_issue_PAY-3'])
  })
})

it('asks Jira for a relative window, which reads the same in every time zone, and moves the cursor by instant, not by text', async () => {
  const now = Date.parse('2026-11-11T15:30:00Z')
  // Jira writes `updated` in the account's offset; 10:00 in New York is 15:00 UTC, so the window is 30 minutes plus 5 of overlap.
  expect(buildJiraPollJql(undefined, '2026-11-11T10:00:00.000-0500', now)).toBe('updated >= -35m ORDER BY updated ASC')
  // 09:00 New York (14:00 UTC) is newer than a 13:00 UTC cursor, though its text sorts lower.
  const jira = new JiraConnector({ baseUrl: 'https://jira.example.com', auth: { kind: 'bearer', token: 'j-tok' },
    fetchImpl: async () => Response.json({ total: 1, issues: [{ id: '1', key: 'PAY-9', fields: { summary: 'PAY-9', reporter: { name: 'alice' },
      created: '2026-11-11T09:00:00.000-0500', updated: '2026-11-11T09:00:00.000-0500', comment: { comments: [] } } }] }) })
  const { nextCursor } = await jira.poll({ seenEventIds: [], lastUpdatedIso: '2026-11-11T13:00:00.000Z' })
  expect(nextCursor.lastUpdatedIso).toBe('2026-11-11T09:00:00.000-0500')
})


it('marks a Jira issue or comment as addressed only when it mentions the bot, and nothing without a known bot identity', async () => {
  const issue = (key: string, description: string, comments: { id: string; body: string }[] = []) => ({ id: key, key, fields: {
    summary: key, description, created: '2026-11-11T10:00:00.000Z', updated: '2026-11-11T10:00:00.000Z', reporter: { name: 'alice' },
    comment: { comments: comments.map(comment => ({ ...comment, created: '2026-11-11T10:00:00.000Z', author: { name: 'alice' } })) } } })
  const issues = [issue('PAY-1', 'Plain request, nobody mentioned.'), issue('PAY-2', 'Please take it, [~workbench].'),
    issue('PAY-3', '', [{ id: '1', body: 'Status update.' }, { id: '2', body: '@workbench возьми в работу' },
      { id: '3', body: 'Cloud mention [~accountid:557058:bot]' }])]
  const poll = async (identity: { botUsername?: string; botAccountId?: string }) => {
    const jira = new JiraConnector({ baseUrl: 'https://jira.example.com', auth: { kind: 'bearer', token: 't' }, ...identity,
      fetchImpl: async () => Response.json({ total: issues.length, issues }) })
    const { triggers } = await jira.poll()
    return Object.fromEntries(triggers.map(trigger => [trigger.id, trigger.addressed ?? 'none']))
  }
  expect(await poll({ botUsername: 'workbench', botAccountId: '557058:bot' })).toEqual({
    'jira_issue_PAY-1': 'none', 'jira_issue_PAY-2': 'mention',
    'jira_comment_PAY-3_1': 'none', 'jira_comment_PAY-3_2': 'mention', 'jira_comment_PAY-3_3': 'mention' })
  expect(Object.values(await poll({})).every(addressed => addressed === 'none')).toBe(true)
})
