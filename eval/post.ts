/**
 * Posts in Mattermost as a synthetic person of the eval (`T11.7`), and reads a thread back.
 *
 *   node eval/post.ts <dev-ivan|lead-1> <channel name> "<message>" [--root <post id>]
 *   node eval/post.ts --read <post id>
 *
 * The password comes from eval/.state/services.env and is never printed.
 */
import { join } from 'node:path'
import { login, readEnv, STATE_DIR } from './bootstrap.ts'

const services = readEnv(join(STATE_DIR, 'services.env'))
const baseUrl = `http://127.0.0.1:${services.EVAL_MATTERMOST_PORT ?? '8065'}`
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

if (process.argv[2] === '--read') {
  const { token } = await login(baseUrl, 'lead-1', services.EVAL_USER_PASSWORD!)
  const thread = await (await fetch(`${baseUrl}/api/v4/posts/${process.argv[3]}/thread`, { headers: headers(token) })).json() as
    { order: string[]; posts: Record<string, { id: string; user_id: string; message: string; create_at: number }> }
  const users = new Map<string, string>()
  for (const id of thread.order) {
    const post = thread.posts[id]!
    if (!users.has(post.user_id)) users.set(post.user_id, ((await (await fetch(`${baseUrl}/api/v4/users/${post.user_id}`, { headers: headers(token) })).json()) as { username: string }).username)
  }
  for (const post of thread.order.map(id => thread.posts[id]!).sort((a, b) => a.create_at - b.create_at)) {
    console.log(`--- ${post.id} ${users.get(post.user_id)} ${new Date(post.create_at).toISOString()}\n${post.message}`)
  }
} else {
  const [user, channelName, message] = process.argv.slice(2)
  const root = process.argv.indexOf('--root') === -1 ? undefined : process.argv[process.argv.indexOf('--root') + 1]
  if (!user || !channelName || !message) throw new Error('usage: node eval/post.ts <user> <channel> "<message>" [--root <post id>]')
  const { token } = await login(baseUrl, user, services.EVAL_USER_PASSWORD!)
  const channel = await (await fetch(`${baseUrl}/api/v4/teams/name/engineering/channels/name/${channelName}`, { headers: headers(token) })).json() as { id: string }
  const post = await (await fetch(`${baseUrl}/api/v4/posts`, { method: 'POST', headers: headers(token),
    body: JSON.stringify({ channel_id: channel.id, message, ...root ? { root_id: root } : {} }) })).json() as { id: string }
  console.log(post.id)
}
