/**
 * A reverse proxy sidecar for Docker Compose, in front of DSH's own web UI (`D13`). It runs only with the Compose profile `dsh-ui`;
 * the dashboard has its own server.
 *
 * DSH's web server listens on the container's loopback, which Docker cannot publish. The proxy joins the
 * `workbench` service's network namespace (`network_mode: "service:workbench"`), listens on `0.0.0.0:25400` there (published only
 * to the host's `127.0.0.1:25400`), checks the incoming `Host` and `Origin` against the loopback authority, and forwards to
 * `127.0.0.1:<targetPort>` with both rewritten: `25402` (`workbench-full`) when it answers, else `25401` (the demo `workbench`).
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'

export function isAllowedIncomingHost(hostHeader: string | undefined, publicPort: number): boolean {
  if (!hostHeader || typeof hostHeader !== 'string') return false
  const normalized = hostHeader.trim().toLowerCase()
  const allowed = new Set([
    '127.0.0.1',
    'localhost',
    '[::1]',
    `127.0.0.1:${publicPort}`,
    `localhost:${publicPort}`,
    `[::1]:${publicPort}`,
  ])
  return allowed.has(normalized)
}

function forwardToTarget(params: {
  req: IncomingMessage
  bodyBuffer: Buffer
  targetHost: string
  targetPort: number
  incomingOrigin: string | undefined
}): Promise<IncomingMessage> {
  const { req, bodyBuffer, targetHost, targetPort, incomingOrigin } = params
  return new Promise((resolveForward, rejectForward) => {
    const targetAuthority = `${targetHost}:${targetPort}`
    const forwardedHeaders: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: targetAuthority,
    }
    if (incomingOrigin !== undefined) {
      forwardedHeaders.origin = `http://${targetAuthority}`
    } else {
      delete forwardedHeaders.origin
    }

    const upstream = httpRequest(
      {
        hostname: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders,
      },
      upstreamRes => {
        resolveForward(upstreamRes)
      },
    )

    upstream.on('error', rejectForward)
    if (bodyBuffer.length > 0) {
      upstream.write(bodyBuffer)
    }
    upstream.end()
  })
}

export interface LoopbackProxyOptions {
  listenHost?: string
  listenPort?: number
  publicPort?: number
  targetHost?: string
  targetPort?: number
  preferredTargetPort?: number
}

export function startLoopbackProxy(options: LoopbackProxyOptions = {}): Promise<{
  server: Server
  port: number
  close: () => Promise<void>
}> {
  const listenHost = options.listenHost ?? process.env.PROXY_LISTEN_HOST ?? '0.0.0.0'
  const listenPort = Number(options.listenPort ?? process.env.PROXY_LISTEN_PORT ?? 25400)
  const publicPort = Number(options.publicPort ?? process.env.PROXY_PUBLIC_PORT ?? listenPort)
  const targetHost = options.targetHost ?? process.env.PROXY_TARGET_HOST ?? '127.0.0.1'
  const targetPort = Number(options.targetPort ?? process.env.PROXY_TARGET_PORT ?? 25401)
  const preferredTargetPort =
    options.preferredTargetPort
    ?? (process.env.PROXY_PREFERRED_TARGET_PORT ? Number(process.env.PROXY_PREFERRED_TARGET_PORT) : undefined)

  const server = createServer((req, res) => {
    const incomingHost = req.headers.host
    const effectivePublicPort = publicPort || req.socket?.localPort || listenPort
    if (!isAllowedIncomingHost(incomingHost, effectivePublicPort)) {
      res.writeHead(403, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({ error: 'Forbidden: loopback Host header required' }))
      return
    }

    const incomingOrigin = req.headers.origin
    if (incomingOrigin !== undefined && incomingOrigin !== `http://${incomingHost}`) {
      res.writeHead(403, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({ error: 'Forbidden: cross-origin request rejected' }))
      return
    }

    const chunks: Buffer[] = []
    req.on('data', chunk => {
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', async () => {
      const bodyBuffer = Buffer.concat(chunks)
      const candidatePorts =
        preferredTargetPort && preferredTargetPort !== targetPort
          ? [preferredTargetPort, targetPort]
          : [targetPort]

      let lastError: unknown
      for (const port of candidatePorts) {
        try {
          const upstreamRes = await forwardToTarget({
            req,
            bodyBuffer,
            targetHost,
            targetPort: port,
            incomingOrigin,
          })
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          upstreamRes.pipe(res)
          return
        } catch (err) {
          lastError = err
        }
      }

      if (!res.headersSent) {
        res.writeHead(502, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
      }
      res.end(
        JSON.stringify({
          error: 'Bad Gateway',
          detail: lastError instanceof Error ? lastError.message : String(lastError),
        }),
      )
    })
  })

  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(listenPort, listenHost, () => {
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : listenPort
      resolvePromise({
        server,
        port: boundPort,
        close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startLoopbackProxy().then(
    ({ port }) => {
      process.stdout.write(
        `Loopback proxy sidecar listening on 0.0.0.0:${port} -> 127.0.0.1:${process.env.PROXY_PREFERRED_TARGET_PORT ?? process.env.PROXY_TARGET_PORT ?? 25401}\n`,
      )
    },
    err => {
      process.stderr.write(`Failed to start loopback proxy sidecar: ${String(err)}\n`)
      process.exitCode = 1
    },
  )
}
