/**
 * The RU/EN vocabulary fast path (`T8.9`), ported from `src/core/approval.ts`, whose copy is deleted in `P9`. A short standalone
 * reply decides a gate without a model: an approval (`ок`, `LGTM`, `go ahead`), a cancellation (`стоп`, `/cancel`) or a retry
 * (`повтори`, `/retry`); on a finished job, a close (`закрой`). A reply with a qualifier (`"Ок, но…"`) or anything longer never matches, so it goes to the model.
 */

const STANDALONE_APPROVAL_TOKENS = new Set([
  'ок', 'окей', 'аппрув', 'аппрувлю', 'согласен', 'согласна', 'согласовано', 'подтверждаю', 'принято', 'годится', 'делай', 'делаем',
  'погнали', 'вперед', 'вперёд', 'добро',
  '+', '++', '+1', 'lgtm', 'ok', 'okay', 'approve', 'approved', '/approve', 'ship it', 'go ahead', 'looks good',
])

const QUALIFIER_PATTERN = /(?:^|[\s,.;:!?\-—])(но|только|кроме|однако|за исключением|исправь|переделай|поменяй|добавь|убери|нужно|надо|but|except|however|only|unless|change|fix|update|modify|instead)(?=$|[\s,.;:!?\-—])/iu

const CANCEL_PHRASES = new Set([
  '/cancel', '/stop', '/abort', 'отмена', 'отмени', 'отмени задачу', 'отменить', 'отменить задачу', 'останови', 'останови задачу',
  'остановить', 'остановить задачу', 'стоп', 'прекрати', 'cancel', 'cancel job', 'stop', 'stop job', 'abort',
  'abort job',
])

/**
 * Closing a finished job. No slash form: `/close` is a GitLab quick action (it would close the merge request, and the note is not
 * kept) and an unknown Mattermost command.
 */
const CLOSE_PHRASES = new Set([
  'закрой', 'закрыть', 'закрой задачу', 'закрыть задачу', 'закрывай', 'close', 'close job', 'close task', 'close it',
])

const RETRY_PHRASES = new Set([
  '/retry', 'повтори', 'повтори этап', 'повторить', 'повторить этап', 'перезапусти', 'перезапусти этап', 'перезапустить',
  'перезапустить этап', 'заново', 'ещё раз', 'еще раз', 'попробуй ещё раз', 'попробуй еще раз', 'retry', 'retry stage',
])

const SLASH_CANCEL = /^\/(?:cancel|stop|abort)(?![\p{L}\p{N}_])(?:\s+(.*))?$/isu
const SLASH_RETRY = /^\/retry(?![\p{L}\p{N}_])(?:\s+.*)?$/isu
const LEADING_MENTIONS = /^\s*(?:@[a-zA-Z0-9_.-]+[:,]?\s*)+/u
const DEFAULT_BOT_HANDLES = ['workbench', 'workflow-agent', 'bot', 'agent', 'dsh', 'ai']
const BROADCAST = new Set(['here', 'channel', 'all', 'everyone'])

/** Removes code, quotes and URLs, whose `@` signs are not mentions. */
function stripCodeQuotesAndUrls(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, ' ').replace(/`[^`\r\n]*`/gu, ' ').replace(/^\s*>.*$/gmu, ' ').replace(/https?:\/\/\S+/giu, ' ')
}

/** Whether `text` mentions a person other than the workbench, outside code, quotes and URLs (a reply addressed to someone else). */
function mentionsSomeoneElse(text: string, botHandles: readonly string[]): boolean {
  const bots = new Set([...DEFAULT_BOT_HANDLES, ...botHandles.map(handle => handle.trim().replace(/^@+/u, '').toLowerCase())])
  const sanitized = stripCodeQuotesAndUrls(text)
  const handles = [
    ...[...sanitized.matchAll(/(?:^|[^\p{L}\p{N}_.@/])@([a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?)(?![a-zA-Z0-9_/-]|\s*\()/gu)].map(match => match[1]!),
    ...[...sanitized.matchAll(/\[~(?:accountid:)?([a-zA-Z0-9_.-]+)\]/giu)].map(match => match[1]!),
  ].map(handle => handle.toLowerCase())
  return handles.some(handle => !bots.has(handle) && !BROADCAST.has(handle)) && !handles.some(handle => bots.has(handle))
}

const normalize = (text: string) => text.toLowerCase().replace(/[!.,;:)(\s—-]+$/gu, '').replace(/\s+/gu, ' ').trim()

/** Whether `text` is a standalone approval with no qualifier (`"ок"`, `"@workbench LGTM"`, but not `"ок, но…"`). */
export function isStandaloneApproval(text: string, botHandles: readonly string[] = []): boolean {
  if (mentionsSomeoneElse(text, botHandles)) return false
  const clean = text.replace(LEADING_MENTIONS, '').trim()
  if (!clean || clean.length > 80 || QUALIFIER_PATTERN.test(clean)) return false
  return STANDALONE_APPROVAL_TOKENS.has(normalize(clean))
}

/** Whether `text` has a qualifying clause (`но`, `только`, `but`, `except`), which makes an approval conditional. */
export function hasQualifier(text: string): boolean {
  return QUALIFIER_PATTERN.test(text.replace(LEADING_MENTIONS, ''))
}

/** A command-shaped cancellation (`стоп`, `/cancel reason`), with its reason; longer sentences never match. */
export function matchCancel(text: string): { reason: string } | undefined {
  const clean = text.replace(LEADING_MENTIONS, '').trim()
  if (!clean) return undefined
  const slash = SLASH_CANCEL.exec(clean)
  if (slash) return { reason: slash[1]?.trim() || clean }
  return CANCEL_PHRASES.has(normalize(clean)) ? { reason: clean } : undefined
}

/** Whether `text` is a standalone close (`закрой`, `close job`); longer sentences never match. */
export function isClose(text: string): boolean {
  const clean = text.replace(LEADING_MENTIONS, '').trim()
  return clean !== '' && CLOSE_PHRASES.has(normalize(clean))
}

/** Whether `text` is a command-shaped retry (`повтори`, `/retry`). */
export function isRetry(text: string): boolean {
  const clean = text.replace(LEADING_MENTIONS, '').trim()
  return clean !== '' && (SLASH_RETRY.test(clean) || RETRY_PHRASES.has(normalize(clean)))
}
