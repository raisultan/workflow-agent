/**
 * Network egress (`T10.2`, `A15`): allowlist matching, the refusal of non-public addresses, the per-job `CONNECT` proxy over a real
 * Unix socket (name resolution injected, so no test reaches the internet), its connection log, and the bridge's refusal message.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EGRESS_PRESETS, EgressProxy, hostAllowed, isPublicAddress, type EgressRecord } from '../src/adapters/egress.ts'
import { resolveConfig, type PluginConfig } from '../src/config.ts'
import { refusalOf } from '../src/sandbox/bridge.ts'
import { exitStatus } from '../src/sandbox/exit.ts'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

describe('the allowlist', () => {
  it('matches exact hosts and *.suffix wildcards, never the bare suffix or a look-alike', () => {
    const list = ['registry.npmjs.org', '*.pythonhosted.org']
    expect(hostAllowed('registry.npmjs.org', list)).toBe(true)
    expect(hostAllowed('REGISTRY.npmjs.org.', list)).toBe(true)
    expect(hostAllowed('files.pythonhosted.org', list)).toBe(true)
    expect(hostAllowed('pythonhosted.org', list)).toBe(false)
    expect(hostAllowed('evilpythonhosted.org', list)).toBe(false)
    expect(hostAllowed('registry.npmjs.org.evil.com', list)).toBe(false)
    expect(hostAllowed('npmjs.org', list)).toBe(false)
  })

  it('comes from the presets and a deployment\'s extra public hosts, and refuses open, private or address entries', () => {
    const config = (egress: unknown) => resolveConfig({ stateDir: '/s', egress } as PluginConfig, {})
    expect(config(undefined).egress.allowlist).toEqual(EGRESS_PRESETS.npm)
    expect(config({ hosts: ['*.example.org', 'Docs.Example.com'] }).egress.allowlist).toEqual([...EGRESS_PRESETS.npm!, '*.example.org', 'docs.example.com'])
    expect(config({ presets: [] }).egress.allowlist).toEqual([])
    // T11.6: PyPI's index and files, and Go's module proxy and checksum database.
    expect(config({ presets: ['pypi', 'go'] }).egress.allowlist).toEqual(['pypi.org', 'files.pythonhosted.org', 'proxy.golang.org', 'sum.golang.org'])
    for (const host of ['*', '*.com', '10.0.0.1', 'localhost', 'nexus.corp', 'registry.internal', 'http://x.org']) {
      expect(() => config({ hosts: [host] }), host).toThrow(/egress/u)
    }
    expect(() => config({ presets: ['maven'] })).toThrow(/egress/u)
  })
})

describe('addresses', () => {
  it('accepts public unicast and refuses loopback, private, link-local, metadata, shared, reserved and multicast addresses', () => {
    for (const address of ['104.16.0.35', '2606:4700::6810:22']) expect(isPublicAddress(address), address).toBe(true)
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.100.100.200', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fd00:ec2::254', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1',
      '::ffff:10.0.0.1', '64:ff9b::a00:1', 'not-an-ip']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })
})

describe('the egress proxy', () => {
  let dir: string, upstream: Server, records: EgressRecord[], proxy: EgressProxy, dns: Record<string, string[]>
  const upstreamPort = () => (upstream.address() as { port: number }).port
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'awb-egress-'))
    records = []
    dns = { 'registry.npmjs.org': ['104.16.0.35'], 'evil.example.com': ['104.16.9.9'], 'rebind.npmjs.org': ['104.16.0.36', '127.0.0.1'] }
    // The "registry": an echo server on loopback that the proxy reaches through its injected connect.
    upstream = createServer(socket => { socket.on('data', chunk => socket.write(`echo:${chunk.toString()}`)) })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    proxy = new EgressProxy({ dir, allowlist: ['registry.npmjs.org', '*.npmjs.org'], record: entry => { records.push(entry) }, attemptOf: () => 'job_1.a2',
      resolve: async host => { if (!dns[host]) throw new Error('ENOTFOUND'); return dns[host] },
      connect: (address, port) => { expect([address, port]).toEqual([dns['registry.npmjs.org']![0], 443]); return connect(upstreamPort(), '127.0.0.1') } })
  })
  afterEach(async () => {
    proxy.closeAll()
    await new Promise(resolve => upstream.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  /** Sends `request` on the job's socket; returns what came back before the proxy closed or `wait` passed. */
  async function exchange(socket: string, request: string, then?: string): Promise<string> {
    const client: Socket = connect(socket)
    let received = ''
    client.on('data', chunk => {
      received += chunk.toString()
      if (then && received.startsWith('HTTP/1.1 200')) { client.write(then); then = undefined }
    })
    client.write(request)
    await new Promise<void>(resolve => { client.on('close', () => resolve()); setTimeout(() => { client.destroy(); resolve() }, 300) })
    return received
  }

  it('tunnels an allowed registry on 443 to the address it checked, and records it against the job and attempt', async () => {
    const socket = await proxy.open('job_1')
    expect(await proxy.open('job_1')).toBe(socket)
    const reply = await exchange(socket, 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n', 'hello')
    expect(reply).toBe('HTTP/1.1 200 Connection Established\r\n\r\necho:hello')
    expect(records).toEqual([{ jobId: 'job_1', attemptId: 'job_1.a2', host: 'registry.npmjs.org', port: 443, address: '104.16.0.35', allowed: true, reason: 'allowed' }])
  })

  it('refuses a host off the allowlist, a private address behind an allowed name, another port, an address and plain HTTP, and names why', async () => {
    const socket = await proxy.open('job_1')
    const refused = async (request: string) => {
      const reply = await exchange(socket, request)
      expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden/u)
      return refusalOf(reply)
    }
    expect(await refused('CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n')).toBe('evil.example.com is not on the egress allowlist')
    expect(await refused('CONNECT rebind.npmjs.org:443 HTTP/1.1\r\n\r\n')).toBe('rebind.npmjs.org resolves to a non-public address (127.0.0.1)')
    expect(await refused('CONNECT registry.npmjs.org:22 HTTP/1.1\r\n\r\n')).toBe('port 22 is not allowed; only 443')
    expect(await refused('CONNECT 104.16.0.35:443 HTTP/1.1\r\n\r\n')).toMatch(/is an address/u)
    expect(await refused('GET http://registry.npmjs.org/left-pad HTTP/1.1\r\n\r\n')).toMatch(/only CONNECT/u)
    expect(await refused('CONNECT nothing.npmjs.org:443 HTTP/1.1\r\n\r\n')).toMatch(/could not be resolved/u)
    expect(records.map(record => [record.host, record.allowed])).toEqual([['evil.example.com', false], ['rebind.npmjs.org', false], ['registry.npmjs.org', false],
      ['104.16.0.35', false], ['registry.npmjs.org', false], ['nothing.npmjs.org', false]])
  })

  it('checks each job against its own allowlist when one is given: its repository\'s registries (T11.1)', async () => {
    proxy.closeAll()
    const allowlists: Record<string, string[]> = { job_npm: ['registry.npmjs.org'], job_none: [] }
    proxy = new EgressProxy({ dir, allowlist: ['registry.npmjs.org'], allowlistOf: jobId => allowlists[jobId] ?? [], record: entry => { records.push(entry) },
      resolve: async host => dns[host] ?? [], connect: () => connect(upstreamPort(), '127.0.0.1') })
    expect(await exchange(await proxy.open('job_npm'), 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 200/u)
    expect(refusalOf(await exchange(await proxy.open('job_none'), 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n')))
      .toBe('registry.npmjs.org is not on the egress allowlist')
  })

  it('gives each job its own socket and stops listening when the job\'s attempt ends', async () => {
    const first = await proxy.open('job_1'), second = await proxy.open('job_2')
    expect(first).not.toBe(second)
    proxy.close('job_1')
    await expect(new Promise((resolve, reject) => { const client = connect(first); client.on('connect', resolve); client.on('error', reject) })).rejects.toThrow()
  })
})

describe('the in-sandbox bridge', () => {
  it('reads the proxy\'s refusal reason, and nothing from an accepted tunnel', () => {
    expect(refusalOf('HTTP/1.1 403 Forbidden\r\nX-Workbench-Egress: evil.example.com%20is%20not%20on%20the%20egress%20allowlist\r\n\r\n'))
      .toBe('evil.example.com is not on the egress allowlist')
    expect(refusalOf('HTTP/1.1 200 Connection Established\r\n\r\n')).toBeUndefined()
    expect(refusalOf('HTTP/1.1 502 Bad Gateway\r\n\r\n')).toBe('the egress proxy answered 502')
  })
})

describe('ending like the command (final review)', () => {
  it('gives 128 + n for a signal and the code otherwise', () => {
    expect(exitStatus(0, null)).toBe(0)
    expect(exitStatus(3, null)).toBe(3)
    expect(exitStatus(null, 'SIGPIPE')).toBe(141)
    expect(exitStatus(null, 'SIGKILL')).toBe(137)
  })

  it('makes the bridge exit 141, not 0, when its command dies of SIGPIPE, which Node ignores', () => {
    const bridge = fileURLToPath(new URL('../src/sandbox/bridge.ts', import.meta.url))
    const result = spawnSync(process.execPath, [bridge, '--egress', '--', 'sh', '-c', 'kill -PIPE $$'], { encoding: 'utf8', timeout: 20_000 })
    // Port 3128 may be taken on a developer machine; the bridge then refuses to start, which this test cannot judge.
    if (result.stderr.includes('cannot listen')) return
    expect(result.status ?? 128 + 13).toBe(141)
  })
})
