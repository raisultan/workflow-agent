/**
 * The workbench's own Jira comments on a person's account (`A8`): the connector logs in as a person, so its comments' author is that
 * person, and it knows them by the ids it posted or found, by their exact body while a post is in flight, and by the ids the runtime
 * records from its post effects. The bot's name is then a name nobody has, so the person's own comments still count.
 */
import { describe, expect, it } from 'vitest'
import { jiraAccount, JiraConnector } from '../src/sources/jira.ts'

const AT = '2026-11-15T10:00:00.000Z'
interface Comment { id: string; body: string; author: string }

/** A Jira with one issue, `ORD-1`, whose comments the test controls; a POST of a comment waits for `release` when one is set. */
function fakeJira() {
  const comments: Comment[] = []
  let next = 100
  let hold: Promise<void> | undefined
  let posted: (() => void) | undefined
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url))
    if (pathname === '/rest/api/2/myself') return Response.json({ name: 'jordan.lee' })
    if (pathname === '/rest/api/2/issue/ORD-1/comment' && init?.method === 'POST') {
      const body = (JSON.parse(String(init.body)) as { body: string }).body
      const comment = { id: String(next++), body, author: 'jordan.lee' }
      comments.push(comment)
      posted?.()
      await hold
      return Response.json({ id: comment.id, created: AT })
    }
    if (pathname === '/rest/api/2/issue/ORD-1/comment') {
      return Response.json({ comments: [...comments].reverse().map(comment => ({ id: comment.id, body: comment.body, created: AT })) })
    }
    if (pathname === '/rest/api/2/search') {
      return Response.json({ total: 1, issues: [{ id: '1', key: 'ORD-1', fields: { summary: 'ORD-1', description: '', reporter: { name: 'jordan.lee' },
        created: AT, updated: AT, comment: { comments: comments.map(comment => ({ id: comment.id, body: comment.body, created: AT,
          author: { name: comment.author } })) } } }] })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  const jira = new JiraConnector({ baseUrl: 'https://jira.example.com', auth: { kind: 'basic', username: 'jordan.lee', password: 'p' },
    botUsername: 'workbench', fetchImpl })
  return {
    jira, comments,
    /** Holds the next POSTs until the returned function is called; resolves `inJira` once the comment is in Jira. */
    holdPosts() {
      let release!: () => void
      hold = new Promise(resolve => { release = resolve })
      const inJira = new Promise<void>(resolve => { posted = resolve })
      return { release, inJira }
    },
    say(id: string, body: string, author = 'jordan.lee') { comments.push({ id, body, author }) },
  }
}

const delivered = async (jira: JiraConnector) => (await jira.poll({ seenEventIds: [], lastUpdatedIso: '2026-11-15T09:00:00.000Z' })).triggers
  .filter(trigger => trigger.id.startsWith('jira_comment_')).map(trigger => ({ id: trigger.id, actor: trigger.actor.id, addressed: trigger.addressed ?? 'none' }))

describe('the workbench\'s own Jira comments on a person\'s account (A8)', () => {
  it('skips a comment it posted, and still delivers the person\'s own, a mention of the bot included', async () => {
    const { jira, say } = fakeJira()
    await jira.postComment('ORD-1', 'План r1: …')
    say('7', '@workbench сделай')
    say('8', 'ок')
    expect(await delivered(jira)).toEqual([
      { id: 'jira_comment_ORD-1_7', actor: 'jordan.lee', addressed: 'mention' },
      { id: 'jira_comment_ORD-1_8', actor: 'jordan.lee', addressed: 'none' }])
  })

  it('skips a comment still being posted, by its exact body on that issue, before Jira returns its id', async () => {
    const { jira, say, holdPosts } = fakeJira()
    const { release, inJira } = holdPosts()
    const posting = jira.postComment('ORD-1', 'Вопрос: какой лимит?')
    await inJira
    say('9', 'Вопрос: какой лимит? Отвечаю: 20')
    expect((await delivered(jira)).map(trigger => trigger.id)).toEqual(['jira_comment_ORD-1_9'])
    release()
    await posting
    expect(await delivered(jira)).toHaveLength(1)
  })

  it('skips a comment found again after an unknown outcome, and comments recorded before the connector was made', async () => {
    const { jira, say, comments } = fakeJira()
    say('50', 'Готово.', 'jordan.lee')
    expect(await jira.findComment('ORD-1', 'Готово.')).toMatchObject({ id: '50' })
    const fresh = fakeJira()
    fresh.comments.push(...comments, { id: '51', body: 'Старое', author: 'jordan.lee' })
    fresh.jira.recordOwn(['ORD-1#51'])
    expect(await delivered(jira)).toEqual([])
    expect((await delivered(fresh.jira)).map(trigger => trigger.id)).toEqual(['jira_comment_ORD-1_50'])
  })

  it('reads the account it logs in as', async () => {
    expect(await fakeJira().jira.myself()).toEqual({ name: 'jordan.lee' })
  })
})

describe('the Jira login account and the bot\'s name', () => {
  const people = new Set(['jordan.lee', 'lead-1'])
  it('is the bot when the login is the bot\'s name and nobody the policy names', () => {
    expect(jiraAccount({ name: 'workbench' }, { botUsername: 'workbench' }, people)).toBe('bot')
    expect(jiraAccount({ accountId: '557058:bot' }, { botAccountId: '557058:bot' }, people)).toBe('bot')
  })

  it('is a person when the bot\'s name is another, and a clash when the bot\'s name is a person the policy names', () => {
    expect(jiraAccount({ name: 'jordan.lee' }, { botUsername: 'workbench' }, people)).toBe('person')
    expect(jiraAccount({ name: 'jordan.lee' }, { botUsername: 'jordan.lee' }, people)).toBe('clash')
    expect(jiraAccount({ accountId: '5570:me' }, { botAccountId: '5570:me' }, new Set(['5570:me']))).toBe('clash')
    expect(jiraAccount({}, { botUsername: 'workbench' }, people)).toBeUndefined()
  })
})
