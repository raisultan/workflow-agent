/**
 * Shared resilient HTTP client for outbound-polling connectors (Jira, Mattermost, GitLab — `F2`, `F8`, `A8`).
 * Implements exponential backoff on `429` (`Retry-After`) and `5xx` responses and redacts credentials from error details.
 */
/** Replaces `secret` in `text`, so credentials never reach logs or the panel. */
export function scrubSecret(text: string, secret: string): string {
  return secret ? text.replaceAll(secret, '[REDACTED]') : text
}

/** Error thrown when a connector HTTP request fails after exhausting retries or with a non-retryable `4xx` status. */
export class ConnectorHttpError extends Error {
  readonly connector: string
  readonly status: number
  constructor(
    connector: string,
    status: number,
    message: string,
  ) {
    super(`[${connector}] HTTP ${status}: ${message}`)
    this.connector = connector
    this.status = status
    this.name = 'ConnectorHttpError'
  }
}

/** Options for `fetchWithRetry`. */
export interface ConnectorFetchOptions {
  connector: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Set true only when a POST carries a server-honoured idempotency token (e.g. Mattermost `pending_post_id`). */
  idempotentPost?: boolean
  secretsToRedact?: readonly string[]
  maxRetries?: number
  baseBackoffMs?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/**
 * Executes an HTTP request with automatic retry on `429` (all methods) and on `5xx` / network errors for idempotent
 * methods (`GET`, `HEAD`, or `POST` with `idempotentPost: true`, `A8`) and secret redaction (`F10`).
 */
export async function fetchWithRetry(options: ConnectorFetchOptions): Promise<Response> {
  const {
    connector,
    url,
    method = 'GET',
    headers = {},
    body,
    idempotentPost = false,
    secretsToRedact = [],
    maxRetries = 3,
    baseBackoffMs = 50,
    fetchImpl = fetch,
    signal,
  } = options

  const upperMethod = method.toUpperCase()
  const idempotent = upperMethod === 'GET' || upperMethod === 'HEAD' || (upperMethod === 'POST' && idempotentPost)

  const redactAll = (text: string): string => {
    let out = text
    for (const secret of secretsToRedact) {
      out = scrubSecret(out, secret)
    }
    return out
  }

  let attempt = 0
  for (;;) {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if (idempotent && attempt < maxRetries) {
        attempt++
        await delay(baseBackoffMs * 2 ** (attempt - 1))
        continue
      }
      const raw = error instanceof Error ? error.message : String(error)
      throw new ConnectorHttpError(connector, 0, redactAll(raw))
    }

    if (response.ok) {
      return response
    }

    const retryable = response.status === 429 || (idempotent && response.status >= 500 && response.status <= 599)
    if (retryable && attempt < maxRetries) {
      attempt++
      const retryAfterHeader = response.headers.get('retry-after')
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN
      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 5000)
        : baseBackoffMs * 2 ** (attempt - 1)
      await delay(waitMs)
      continue
    }

    const errorBody = await response.text().catch(() => '')
    throw new ConnectorHttpError(connector, response.status, redactAll(errorBody.slice(0, 500) || response.statusText))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
