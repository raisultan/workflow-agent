/**
 * The in-sandbox bridge (`T10.2`, `T12.2`): the parent of a command inside its sandbox when it has a network or test services.
 *
 * - `--egress`: the sandbox has no network but its own loopback, and the job's proxy socket is bound in at `SANDBOX_SOCKET`. The
 *   bridge listens on `127.0.0.1:BRIDGE_PORT` (the `HTTPS_PROXY` the command sees) and carries each connection to the socket. When
 *   the proxy refuses a connection, it prints the reason to the command's error output (`workbench-egress: …`), so the agent sees
 *   which host was refused and why.
 * - `--services <root> --postgres <major>`: the test-service launcher (`services.ts`, `D11`).
 *
 * Then it runs the command, passing on its exit status and the signals the bridge receives.
 */
import { spawn } from 'node:child_process'
import { connect, createServer, type Server } from 'node:net'
import { endLike } from './exit.ts'
import { BRIDGE_PORT, SANDBOX_SOCKET } from './profile.ts'
import { IMAGE_PATHS, imageServices, RUN_DIR, startLauncher } from './services.ts'

/** The proxy's refusal reason in its first response, or `undefined` when it accepted. */
export function refusalOf(response: string): string | undefined {
  const status = /^HTTP\/1\.[01] (\d{3})/u.exec(response)
  if (!status || status[1] === '200') return undefined
  const reason = /^X-Workbench-Egress: (.*)$/imu.exec(response)?.[1]
  return reason ? decodeURIComponent(reason.trim()) : `the egress proxy answered ${status[1]}`
}

/** The bridge's options: `--egress` serves the proxy socket; `--services <root> --postgres <major>` starts the launcher (`T12.2`). */
export function parseBridgeArgs(argv: readonly string[]): { egress: boolean; services?: { root: string; postgres: string }; command: string[] } | { error: string } {
  const separator = argv.indexOf('--')
  const command = separator === -1 ? [] : argv.slice(separator + 1)
  if (command.length === 0) return { error: 'the bridge has no command' }
  const options = argv.slice(0, separator)
  let egress = false, root: string | undefined, postgres: string | undefined
  for (let index = 0; index < options.length; index++) {
    const option = options[index]
    if (option === '--egress') egress = true
    else if (option === '--services') root = options[++index]
    else if (option === '--postgres') postgres = options[++index]
    else return { error: `the bridge does not know ${JSON.stringify(option)}` }
  }
  if ((root === undefined) !== (postgres === undefined) || root === '' || postgres === '') return { error: 'the bridge needs --services and --postgres together' }
  return { egress, ...root !== undefined && postgres !== undefined ? { services: { root, postgres } } : {}, command }
}

function serveEgress(): Promise<Server> {
  const server = createServer(client => {
    const upstream = connect(SANDBOX_SOCKET)
    let first = true
    upstream.on('data', (chunk: Buffer) => {
      if (first) {
        first = false
        const refusal = refusalOf(chunk.toString('latin1'))
        if (refusal) process.stderr.write(`workbench-egress: refused: ${refusal}\n`)
      }
    })
    client.pipe(upstream)
    upstream.pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(BRIDGE_PORT, '127.0.0.1', () => resolve(server))
  })
}

async function main(): Promise<void> {
  const parsed = parseBridgeArgs(process.argv.slice(2))
  if ('error' in parsed) { process.stderr.write(`workbench-sandbox: ${parsed.error}\n`); process.exit(126) }
  let egress: Server | undefined
  if (parsed.egress) {
    try { egress = await serveEgress() } catch (error) {
      process.stderr.write(`workbench-sandbox: the egress bridge cannot listen: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(126)
    }
  }
  const launcher = parsed.services
    ? await startLauncher({ services: imageServices(IMAGE_PATHS(parsed.services.root), parsed.services.postgres), runDir: RUN_DIR,
      report: line => { process.stderr.write(`${line}\n`) } })
    : undefined
  const [program, ...args] = parsed.command
  const child = spawn(program!, args, { stdio: 'inherit' })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => { child.kill(signal) })
  child.on('error', error => { process.stderr.write(`workbench-sandbox: cannot start ${program}: ${error.message}\n`); process.exit(126) })
  child.on('exit', (code, signal) => {
    egress?.close()
    launcher?.close()
    endLike(code, signal)
  })
}

if (process.argv[1] && /sandbox-bridge\.[cm]?js$|bridge\.ts$/u.test(process.argv[1])) void main()
