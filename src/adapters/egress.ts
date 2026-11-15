/**
 * Network egress (`T10.2`, `D8` decision 10, `A15`). Every sandbox runs in its own network namespace with only its own loopback
 * (`src/sandbox/`). A stage whose manifest froze the `registries` profile (implement, review) reaches public package registries,
 * and nothing else, through this proxy:
 *
 * - **One Unix socket per job.** The host listens on `<stateDir>/sandbox/proxy/<n>.sock` for each job that runs a `registries`
 *   stage; the wrapper binds only that job's socket into its sandbox, so every connection is attributed to its job and attempt.
 *   The socket directory is under the state directory, which every sandbox has masked.
 * - **`CONNECT` only, to port 443.** The proxy sees the host name a client asks for, never the request inside the tunnel.
 * - **Allowlist.** Exact host names or `*.suffix` wildcards, from named presets (`npm`) plus a deployment's extra public hosts.
 * - **Addresses.** The proxy resolves the name itself, refuses it if any address it resolves to is loopback, private, link-local
 *   (cloud metadata), shared, reserved or multicast, and connects to the address it checked (so a second lookup cannot differ).
 * - **Visibility.** Every allowed and refused connection is recorded against its job and attempt; a refusal says why, and the
 *   in-sandbox bridge prints it to the command's error output, so the agent can report it.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { mkdirSync, rmSync } from 'node:fs'
import { BlockList, connect as netConnect, createServer, isIP, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

/**
 * Named allowlists; a repository names the ones its jobs may reach (`T11.1`). `pypi` is the index and its file host (pip and uv);
 * `go` is Google's module proxy and checksum database, which Go uses with no `direct` fallback (`T11.6`, `sandboxEnv`).
 */
export const EGRESS_PRESETS: Readonly<Record<string, readonly string[]>> = {
  npm: ['registry.npmjs.org', 'registry.yarnpkg.com'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  go: ['proxy.golang.org', 'sum.golang.org'],
}

/**
 * The toolchain download hosts (`T11.0`): only the setup step's toolchain sandbox reaches them, through a proxy instance of its own.
 * Node from nodejs.org, Go from dl.google.com (its version list from github.com), Python builds, `uv` and `pnpm` from GitHub
 * releases (and their attestations and digests from api.github.com), Python's build list from mise's author's host, Sigstore's
 * trust root, and PyPy's version list.
 */
export const TOOLCHAIN_HOSTS: readonly string[] = ['nodejs.org', 'dl.google.com', 'github.com', 'release-assets.githubusercontent.com', 'api.github.com',
  'mise-versions.jdx.dev', 'tuf-repo-cdn.sigstore.dev', 'downloads.python.org']

/** An allowlist entry: an exact host name, or `*.suffix` (any name under the suffix, not the suffix itself). */
export const HOST_PATTERN = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/u

/** Whether `host` is on the allowlist. */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/u, '')
  return allowlist.some(entry => entry.startsWith('*.') ? name.endsWith(entry.slice(1)) && name.length > entry.length - 1 : name === entry)
}

const BLOCKED = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) BLOCKED.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(network, prefix, 'ipv6')

/** Whether `address` is a public unicast address: not loopback, private, link-local, shared, documentation, reserved or multicast. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  // An IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)
  if (mapped) return isPublicAddress(mapped[1]!)
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/** One connection the proxy allowed or refused. */
export interface EgressRecord {
  readonly jobId: string
  readonly attemptId?: string
  readonly host: string
  readonly port: number
  readonly address?: string
  readonly allowed: boolean
  readonly reason: string
}

export interface EgressProxyOptions {
  /** The directory of the sockets; under the state directory. */
  readonly dir: string
  /** The hosts every job may reach, unless `allowlistOf` names a job's own. */
  readonly allowlist: readonly string[]
  /** A job's own allowlist (its repository's registry presets, `T11.1`), read for every connection. */
  allowlistOf?(jobId: string): readonly string[]
  record(entry: EgressRecord): void
  /** The attempt a job runs now, for the record. */
  attemptOf?(jobId: string): string | undefined
  /** Name resolution (all addresses); `dns.lookup` by default. */
  resolve?(host: string): Promise<readonly string[]>
  /** Opens the outbound connection; `net.connect` by default. */
  connect?(address: string, port: number): Socket
}

const MAX_HEAD = 8192

/** The per-job allowlisting `CONNECT` proxy. */
export class EgressProxy {
  private readonly options: EgressProxyOptions
  private readonly servers = new Map<string, { server: Server; path: string; sockets: Set<Socket> }>()
  private sequence = 0

  constructor(options: EgressProxyOptions) {
    this.options = options
    mkdirSync(options.dir, { recursive: true, mode: 0o700 })
  }

  /** Listens for `jobId` (once); returns its socket path. */
  async open(jobId: string): Promise<string> {
    const existing = this.servers.get(jobId)
    if (existing) return existing.path
    // Short names: a Unix socket path is limited to about 100 bytes.
    const path = join(this.options.dir, `${++this.sequence}-${process.pid}.sock`)
    rmSync(path, { force: true })
    const sockets = new Set<Socket>()
    const server = createServer(client => {
      sockets.add(client)
      client.on('close', () => sockets.delete(client))
      this.handle(jobId, client)
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve() }) })
    this.servers.set(jobId, { server, path, sockets })
    return path
  }

  /** Stops listening for `jobId` and ends its connections. */
  close(jobId: string): void {
    const entry = this.servers.get(jobId)
    if (!entry) return
    this.servers.delete(jobId)
    for (const socket of entry.sockets) socket.destroy()
    entry.server.close()
    rmSync(entry.path, { force: true })
  }

  closeAll(): void {
    for (const jobId of [...this.servers.keys()]) this.close(jobId)
  }

  private handle(jobId: string, client: Socket): void {
    let head = Buffer.alloc(0)
    client.on('error', () => client.destroy())
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) {
        if (head.length > MAX_HEAD) { client.off('data', onData); this.refuse(jobId, client, { host: '?', port: 0 }, 'the request header is too long') }
        return
      }
      client.off('data', onData)
      client.pause()
      void this.tunnel(jobId, client, head.subarray(0, end).toString('latin1'), head.subarray(end + 4))
    }
    client.on('data', onData)
  }

  private async tunnel(jobId: string, client: Socket, head: string, rest: Buffer): Promise<void> {
    const [method, target] = head.split('\r\n')[0]!.split(' ')
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/u.exec(target ?? '')
    const host = match?.[1]?.toLowerCase() ?? (target ?? '?'), port = Number(match?.[2] ?? 0)
    if (method !== 'CONNECT' || !match) return this.refuse(jobId, client, { host: hostOf(target), port }, `only CONNECT to host:443 is allowed, not ${method} ${target}`)
    if (port !== 443) return this.refuse(jobId, client, { host, port }, `port ${port} is not allowed; only 443`)
    if (isIP(host)) return this.refuse(jobId, client, { host, port }, `${host} is an address; only allowlisted host names are reachable`)
    if (!hostAllowed(host, this.options.allowlistOf?.(jobId) ?? this.options.allowlist)) return this.refuse(jobId, client, { host, port }, `${host} is not on the egress allowlist`)
    let addresses: readonly string[]
    try {
      addresses = await (this.options.resolve ?? (async (name: string) => (await dnsLookup(name, { all: true, verbatim: true })).map(entry => entry.address)))(host)
    } catch (error) {
      return this.refuse(jobId, client, { host, port }, `${host} could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
    }
    const hidden = addresses.filter(address => !isPublicAddress(address))
    if (addresses.length === 0 || hidden.length > 0) {
      return this.refuse(jobId, client, { host, port }, `${host} resolves to ${hidden.length > 0 ? `a non-public address (${hidden.join(', ')})` : 'no address'}`)
    }
    const address = addresses[0]!
    const upstream = (this.options.connect ?? ((ip: string, p: number) => netConnect({ host: ip, port: p })))(address, port)
    let connected = false
    upstream.on('error', error => {
      if (!connected) this.refuse(jobId, client, { host, port, address }, `${host} (${address}) could not be reached: ${error.message}`)
      else client.destroy()
    })
    upstream.once('connect', () => {
      connected = true
      this.record(jobId, { host, port, address, allowed: true, reason: 'allowed' })
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (rest.length > 0) upstream.write(rest)
      client.pipe(upstream)
      upstream.pipe(client)
      client.resume()
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
    })
  }

  private refuse(jobId: string, client: Socket, target: { host: string; port: number; address?: string }, reason: string): void {
    this.record(jobId, { ...target, allowed: false, reason })
    const body = `workbench egress refused: ${reason}\n`
    client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Workbench-Egress: ${encodeURIComponent(reason)}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
  }

  private record(jobId: string, entry: Omit<EgressRecord, 'jobId' | 'attemptId'>): void {
    const attemptId = this.options.attemptOf?.(jobId)
    try { this.options.record({ jobId, ...attemptId ? { attemptId } : {}, ...entry }) } catch { /* the record is best effort; the decision stands */ }
  }
}

function hostOf(target: string | undefined): string {
  if (!target) return '?'
  try { return new URL(target).hostname || target } catch { return target.replace(/:\d+$/u, '') }
}
