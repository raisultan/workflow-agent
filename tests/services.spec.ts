/**
 * Test services (`T12.2`, `T12.4`, `D11`): the launcher against fake servers (start on first connection, early bytes kept, one start
 * for many connections, failures reported), the Postgres major chosen from a repository's CI and Compose files, and the reader of
 * those files.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readServiceImages } from '../src/adapters/service-files.ts'
import { chooseServices, imageParts, majorOf } from '../src/domain/services.ts'
import { HOSTS_FILE, startLauncher, type Service } from '../src/sandbox/services.ts'

/** A free loopback port. */
function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/**
 * A fake AMQP-like server: after `delayMs` it listens on `port`; it answers the AMQP header with a method frame, and echoes anything
 * else. With `exit`, it exits instead of listening.
 */
const FAKE = `
const net = require('node:net')
const [port, delay, mode] = process.argv.slice(1)
console.log('fake starting in', process.cwd())
if (mode === 'exit') { console.log('cannot start: broken'); process.exit(3) }
setTimeout(() => net.createServer(s => s.on('data', d => s.write(d[0] === 0x41 && d[1] === 0x4d ? Buffer.from([1, 0, 0]) : d))).listen(Number(port), '127.0.0.1'), Number(delay))
`

function fakeService(name: Service['name'], port: number, hidden: number, options: { delayMs?: number; mode?: 'exit' | 'hang'; starts: string[] }): Service {
  return { name, port, hidden, probe: 'amqp', prepare: dir => {
    options.starts.push(dir)
    // `hang` listens on a port nobody asks, so the service never answers.
    return { command: process.execPath, args: ['-e', FAKE, String(options.mode === 'hang' ? hidden + 1 : hidden), String(options.delayMs ?? 0), options.mode ?? ''],
      env: { PATH: process.env.PATH ?? '' } }
  } }
}

function exchange(port: number, send: string): Promise<string> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1', () => socket.write(send))
    let got = ''
    socket.on('data', chunk => { got += chunk.toString(); if (got.length >= send.length) { socket.end(); resolve(got) } })
    socket.on('close', () => resolve(got))
    // The launcher closes a failed service's connections; a reset is a close here.
    socket.on('error', () => resolve(got))
  })
}

describe('the test-service launcher (T12.2)', () => {
  let runDir: string
  let close: (() => void) | undefined
  beforeEach(() => { runDir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-services-'))) })
  afterEach(() => { close?.(); close = undefined; rmSync(runDir, { recursive: true, force: true }) })

  it('starts nothing until a connection comes, then starts the service once and carries every connection, early bytes included', async () => {
    const [port, hidden] = [await freePort(), await freePort()]
    const starts: string[] = []
    const reports: string[] = []
    const launcher = await startLauncher({ services: [fakeService('rabbitmq', port, hidden, { delayMs: 300, starts })], runDir, report: line => reports.push(line) })
    close = launcher.close
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(starts).toEqual([])
    expect(launcher.started()).toEqual([])
    // Sent before the service listens: held until it answers, then carried through.
    const [first, second] = await Promise.all([exchange(port, 'hello'), exchange(port, 'again')])
    expect([first, second]).toEqual(['hello', 'again'])
    expect(await exchange(port, 'later')).toBe('later')
    expect(starts).toEqual([join(runDir, 'rabbitmq')])
    expect(launcher.started()).toEqual(['rabbitmq'])
    expect(reports).toEqual([])
  }, 30_000)

  it('reports a service that exits, with its log, and closes its connections', async () => {
    const [port, hidden] = [await freePort(), await freePort()]
    const reports: string[] = []
    const launcher = await startLauncher({ services: [fakeService('kafka', port, hidden, { mode: 'exit', starts: [] })], runDir, report: line => reports.push(line) })
    close = launcher.close
    expect(await exchange(port, 'hello')).toBe('')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/^workbench-services: kafka did not start: it exited \(status 3\)\n/u)
    expect(reports[0]).toContain('cannot start: broken')
    // The service runs in its own directory, so a crash dump never lands in the command's worktree (review).
    expect(reports[0]).toContain(`fake starting in ${join(runDir, 'kafka')}`)
    // A failed service stays failed for the command: the next connection is closed at once, and nothing more is printed.
    expect(await exchange(port, 'again')).toBe('')
    expect(reports).toHaveLength(1)
  }, 30_000)

  it('reports a service that never answers within the time limit', async () => {
    const [port, hidden] = [await freePort(), await freePort()]
    const reports: string[] = []
    const launcher = await startLauncher({ services: [fakeService('postgres', port, hidden, { mode: 'hang', starts: [] })], runDir, startTimeoutMs: 1500,
      report: line => reports.push(line) })
    close = launcher.close
    expect(await exchange(port, 'hello')).toBe('')
    expect(reports[0]).toMatch(/^workbench-services: postgres did not start: it did not answer within 2 s/u)
  }, 30_000)

  it('reports a port it cannot listen on, and serves the others', async () => {
    const taken = createServer()
    const port = await freePort()
    await new Promise<void>(resolve => taken.listen(port, '127.0.0.1', resolve))
    const reports: string[] = []
    try {
      const [other, hidden] = [await freePort(), await freePort()]
      const launcher = await startLauncher({ services: [fakeService('postgres', port, await freePort(), { starts: [] }),
        fakeService('rabbitmq', other, hidden, { starts: [] })], runDir, report: line => reports.push(line) })
      close = launcher.close
      expect(reports).toEqual([expect.stringMatching(new RegExp(`^workbench-services: postgres is not available: port ${port}: `, 'u'))])
      expect(await exchange(other, 'hi')).toBe('hi')
    } finally { taken.close() }
  }, 30_000)

  it('maps only IPv4 loopback in the sandbox\'s hosts file, with its hostname and the CI service names', () => {
    expect(HOSTS_FILE).toBe('127.0.0.1\tlocalhost workbench-sandbox postgres rabbitmq kafka\n')
  })
})

describe('the Postgres major (T12.4)', () => {
  const available = ['15', '16', '17', '18']
  const ci = (image: string) => ({ file: '.gitlab-ci.yml', image })

  it('reads image names and plain majors', () => {
    expect(imageParts('postgres:15')).toEqual({ name: 'postgres', tag: '15' })
    expect(imageParts('registry.example:5000/library/postgres:16.4-alpine@sha256:abc')).toEqual({ name: 'postgres', tag: '16.4-alpine' })
    expect(imageParts('bitnami/postgresql')).toEqual({ name: 'postgresql', tag: undefined })
    expect(['15', '15.4', '16-alpine', 'latest', '$PG_VERSION', undefined].map(majorOf)).toEqual(['15', '15', '16', undefined, undefined, undefined])
  })

  it('takes the major the CI names, the newest of two, and the newest the image has when none is named', () => {
    expect(chooseServices({ images: [ci('postgres:15')], available })).toEqual({ kind: 'chosen', services: { postgres: '15' }, notes: [] })
    expect(chooseServices({ images: [ci('postgres:15'), { file: 'compose.yaml', image: 'postgres:16-alpine' }], available }))
      .toEqual({ kind: 'chosen', services: { postgres: '16' }, notes: ['the repository names Postgres 15 and 16; using 16, the newest'] })
    expect(chooseServices({ images: [], available })).toEqual({ kind: 'chosen', services: { postgres: '18' },
      notes: ['no Postgres image is named in the repository\'s CI or Compose files; using Postgres 18'] })
    expect(chooseServices({ images: [ci('postgres:$PG_VERSION')], available })).toEqual({ kind: 'chosen', services: { postgres: '18' },
      notes: ['.gitlab-ci.yml names postgres:$PG_VERSION, with no plain major', 'using Postgres 18, the newest'] })
  })

  it('refuses to guess when a CI or Compose file could not be read, unless the profile names the major (review)', () => {
    const unreadable = ['.gitlab-ci.yml could not be parsed (bad indentation); it was not read']
    expect(chooseServices({ images: [], unreadable, available })).toEqual({ kind: 'error',
      error: '.gitlab-ci.yml could not be parsed (bad indentation); it was not read; so the Postgres major cannot be read: set `postgres` in the repository profile' })
    expect(chooseServices({ images: [], unreadable, override: '15', available })).toEqual({ kind: 'chosen', services: { postgres: '15' }, notes: unreadable })
  })

  it('lets the profile override, and refuses a major the image does not have', () => {
    expect(chooseServices({ images: [ci('postgres:12')], override: '16', available })).toMatchObject({ kind: 'chosen', services: { postgres: '16' } })
    expect(chooseServices({ images: [ci('postgres:12')], available }))
      .toEqual({ kind: 'error', error: '.gitlab-ci.yml names Postgres 12, which this image does not have (it has 15, 16, 17, 18)' })
    expect(chooseServices({ images: [], override: '13', available })).toMatchObject({ kind: 'error', error: expect.stringContaining('the repository profile names Postgres 13') })
  })

  it('notes a RabbitMQ or Kafka major other than the image\'s, and runs', () => {
    const choice = chooseServices({ images: [ci('rabbitmq:4.1-management'), ci('rabbitmq:3.13'), ci('apache/kafka:3.9.0'), ci('bitnami/kafka:4.0')], available })
    expect(choice).toMatchObject({ kind: 'chosen', notes: ['.gitlab-ci.yml names rabbitmq:4.1-management; jobs get RabbitMQ 3.10',
      '.gitlab-ci.yml names apache/kafka:3.9.0; jobs get Kafka 4.4', expect.stringContaining('using Postgres 18')] })
  })
})

describe('the repository\'s CI and Compose files (T12.4)', () => {
  let worktree: string
  beforeEach(() => { worktree = mkdtempSync(join(tmpdir(), 'wb-service-files-')) })
  afterEach(() => { rmSync(worktree, { recursive: true, force: true }) })

  it('reads services at the top, under default and in jobs, with anchors, and each Compose service\'s image', () => {
    writeFileSync(join(worktree, '.gitlab-ci.yml'), [
      'include: { project: acme/ci, file: base.yml }',
      'services: [redis:7]',
      'default:', '  services:', '    - name: rabbitmq:3.13', '      alias: broker',
      '.db: &db', '  services: [postgres:15]',
      'test:', '  <<: *db', '  script: [pytest]', '  image: python:3.12',
      'lint:', '  script: !reference [.scripts, lint]',
    ].join('\n'))
    writeFileSync(join(worktree, 'compose.yaml'), 'services:\n  db:\n    image: postgres:16\n  app:\n    build: .\n')
    expect(readServiceImages(worktree)).toEqual({ unreadable: [], images: [
      { file: '.gitlab-ci.yml', image: 'redis:7' }, { file: '.gitlab-ci.yml', image: 'rabbitmq:3.13' }, { file: '.gitlab-ci.yml', image: 'postgres:15' },
      { file: '.gitlab-ci.yml', image: 'postgres:15' }, { file: 'compose.yaml', image: 'postgres:16' }] })
  })

  it('notes a file it cannot parse or will not read, and never follows a link', () => {
    writeFileSync(join(worktree, '.gitlab-ci.yml'), 'services: [postgres:15\n')
    mkdirSync(join(worktree, 'elsewhere'))
    writeFileSync(join(worktree, 'elsewhere', 'compose.yml'), 'services: { db: { image: postgres:17 } }\n')
    symlinkSync(join(worktree, 'elsewhere', 'compose.yml'), join(worktree, 'docker-compose.yml'))
    const read = readServiceImages(worktree)
    expect(read.images).toEqual([])
    expect(read.unreadable).toEqual([expect.stringMatching(/^\.gitlab-ci\.yml could not be parsed/u),
      'docker-compose.yml is a symbolic link; it must be a regular file; it was not read'])
  })

  it('reads a large CI file whose jobs share nested anchors (review)', () => {
    const lines = ['.pg: &pg', '  services: [postgres:15]', '.base: &base', '  <<: *pg', '  image: python:3.12', '  before_script: [pip install -r requirements.txt]']
    for (let index = 0; index < 80; index++) lines.push(`job-${index}:`, '  <<: *base', `  script: [pytest -k part${index}]`)
    writeFileSync(join(worktree, '.gitlab-ci.yml'), lines.join('\n'))
    const read = readServiceImages(worktree)
    expect(read.unreadable).toEqual([])
    expect(new Set(read.images.map(image => image.image))).toEqual(new Set(['postgres:15']))
  })

  it('stops an alias bomb', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]']
    for (let index = 0; index < 12; index++) lines.push(`${String.fromCharCode(98 + index)}: &${String.fromCharCode(98 + index)} [${Array(10).fill(`*${String.fromCharCode(97 + index)}`).join(', ')}]`)
    lines.push('services: [postgres:15]')
    writeFileSync(join(worktree, '.gitlab-ci.yml'), lines.join('\n'))
    expect(readServiceImages(worktree).unreadable).toEqual([expect.stringMatching(/could not be parsed/u)])
  })
})
