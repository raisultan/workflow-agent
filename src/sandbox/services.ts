/**
 * Test services (`T12.2`, `D11`): Postgres, RabbitMQ and Kafka, each started inside the sandbox of the command that connects to it.
 *
 * The in-sandbox launcher listens on each service's usual port on the sandbox's own loopback. The first connection to a port starts
 * that service from a data directory prepared when the image was built, copied into the sandbox's `/tmp`; the launcher holds the
 * connection until the service answers its own protocol, then carries it, and every later one, to the service's hidden port. A
 * command that never connects starts nothing. Everything ends with the command: the sandbox's PID namespace and `/tmp` go with it.
 *
 * A service that does not start in time prints `workbench-services: <name> did not start: …` with its log tail to the command's
 * error output, and its connections are closed; a host check reads that line as the environment's failure (`T12.5`).
 *
 * This file uses only Node's own modules, so the image build runs it directly (`node services.ts --build <root>`) to prepare the
 * data directories, before the rest of the workbench is copied in.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

/** The prefix of everything the launcher prints about a service. */
export const SERVICES_PREFIX = 'workbench-services: '
/** The Postgres majors the image has (`D11`, decision 5), newest last; the newest is used when a repository names none. */
export const POSTGRES_MAJORS = ['15', '16', '17', '18'] as const
/** The names that resolve to the sandbox's loopback, as service names do in GitLab CI (`D11`, decision 4). */
export const SERVICE_HOSTS = ['postgres', 'rabbitmq', 'kafka'] as const

export type ServiceName = 'postgres' | 'rabbitmq' | 'kafka'
export type Probe = 'postgres' | 'amqp' | 'kafka'

/** How the command finds the services: the defaults of each project's official container image. */
export const SERVICE_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres',
  PGHOST: 'localhost', PGPORT: '5432', PGUSER: 'postgres', PGPASSWORD: 'postgres', PGDATABASE: 'postgres',
  AMQP_URL: 'amqp://guest:guest@localhost:5672/', RABBITMQ_URL: 'amqp://guest:guest@localhost:5672/',
  KAFKA_BOOTSTRAP_SERVERS: 'localhost:9092',
}

/**
 * The hostname of a sandbox with services (its own UTS namespace), which its `hosts` file names: Erlang and Java look up their own
 * host's name, and with no network an unknown name waits for DNS that never answers.
 */
export const SANDBOX_HOSTNAME = 'workbench-sandbox'
/** The sandbox's `/etc/hosts` (`T12.3`): only IPv4 loopback, so `localhost` never resolves to an address the launcher does not serve. */
export const HOSTS_FILE = `127.0.0.1\tlocalhost ${SANDBOX_HOSTNAME} ${SERVICE_HOSTS.join(' ')}\n`

/** Where the launcher keeps a service's copy of its data, its log, and its sockets, inside the sandbox. */
export const RUN_DIR = '/tmp/.workbench-services'

/**
 * Each service's own ports, behind the launcher's. All are below Linux's ephemeral range (32768–60999 by default): a port in it can be
 * taken as the source port of an outgoing local connection made just before the service binds (Erlang's connection to its port mapper,
 * for one), which failed the image's build once on `eaddrinuse` (`P17`).
 */
const PORTS = { postgres: { port: 5432, hidden: 15432 }, rabbitmq: { port: 5672, hidden: 15672 }, kafka: { port: 9092, hidden: 19092 } } as const
const RABBITMQ_DIST_PORT = 15673
const EPMD_PORT = 14369
const KAFKA_CONTROLLER_PORT = 19093
const SERVICE_PATH = '/usr/local/bin:/usr/bin:/bin'

/** A process to start, and where its output goes. */
export interface Start {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** One service: its ports, how to tell it is ready, and how to prepare and start it in `dir`. */
export interface Service {
  readonly name: ServiceName
  readonly port: number
  readonly hidden: number
  readonly probe: Probe
  /** Copies the service's prepared data into `dir`, and returns what to run. */
  prepare(dir: string): Start
}

/** The paths of the image's services (`T12.1`). */
export interface ServicePaths {
  /** The prepared data directories: `<root>/postgres/<major>`, `<root>/rabbitmq`, `<root>/kafka`. */
  readonly root: string
  readonly postgresBin: (major: string) => string
  readonly rabbitmqServer: string
  readonly kafkaHome: string
}

export const IMAGE_PATHS = (root: string): ServicePaths => ({
  root, postgresBin: major => `/usr/lib/postgresql/${major}/bin`, rabbitmqServer: '/usr/lib/rabbitmq/bin/rabbitmq-server', kafkaHome: '/opt/kafka',
})

const baseEnv = (home: string): Record<string, string> => ({ PATH: SERVICE_PATH, HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })

function rabbitmqEnv(dir: string, port: number): Record<string, string> {
  return { ...baseEnv(dir), RABBITMQ_NODENAME: 'rabbit@localhost', RABBITMQ_NODE_IP_ADDRESS: '127.0.0.1', RABBITMQ_NODE_PORT: String(port),
    RABBITMQ_DIST_PORT: String(RABBITMQ_DIST_PORT), ERL_EPMD_PORT: String(EPMD_PORT), ERL_EPMD_ADDRESS: '127.0.0.1',
    RABBITMQ_MNESIA_BASE: join(dir, 'mnesia'), RABBITMQ_LOG_BASE: join(dir, 'log'), RABBITMQ_ENABLED_PLUGINS_FILE: join(dir, 'enabled_plugins'),
    RABBITMQ_CONFIG_FILE: join(dir, 'rabbitmq'), RABBITMQ_ADVANCED_CONFIG_FILE: join(dir, 'advanced.config'), RABBITMQ_CONF_ENV_FILE: join(dir, 'rabbitmq-env.conf'),
    RABBITMQ_PID_FILE: join(dir, 'rabbitmq.pid'),
    // Erlang's schedulers busy-wait by default, which starves a VM shared with other work: measured 7–22 s to start without these
    // flags in the full container, 4–6 s with them (`T12.7`). Two schedulers are plenty for a test broker.
    RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS: '+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none' }
}

function kafkaProperties(dir: string, advertised: number): string {
  return [
    'process.roles=broker,controller', 'node.id=1', `controller.quorum.voters=1@127.0.0.1:${KAFKA_CONTROLLER_PORT}`,
    `listeners=PLAINTEXT://127.0.0.1:${PORTS.kafka.hidden},CONTROLLER://127.0.0.1:${KAFKA_CONTROLLER_PORT}`,
    // Clients come back through the launcher's port, never to the hidden one.
    `advertised.listeners=PLAINTEXT://127.0.0.1:${advertised}`, 'controller.listener.names=CONTROLLER',
    'listener.security.protocol.map=PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT', 'inter.broker.listener.name=PLAINTEXT', `log.dirs=${join(dir, 'data')}`,
    'num.partitions=1', 'offsets.topic.replication.factor=1', 'transaction.state.log.replication.factor=1', 'transaction.state.log.min.isr=1',
    'share.coordinator.state.topic.replication.factor=1', 'share.coordinator.state.topic.min.isr=1', 'group.initial.rebalance.delay.ms=0',
    'auto.create.topics.enable=true', '',
  ].join('\n')
}

function kafkaEnv(paths: ServicePaths, dir: string, extra = ''): Record<string, string> {
  const archive = join(paths.root, 'kafka', 'classes.jsa')
  return { ...baseEnv(dir), LOG_DIR: join(dir, 'logs'), KAFKA_HEAP_OPTS: '-Xms256m -Xmx256m',
    // A class-data archive made at build halves the start; a JVM that cannot use it starts without it (`-Xshare:auto`).
    KAFKA_OPTS: `${existsSync(archive) && !extra ? `-XX:SharedArchiveFile=${archive} ` : ''}-Xshare:auto -XX:TieredStopAtLevel=1 ${extra}`.trim() }
}

/** The three services, for one job's Postgres major (`D11`, decisions 2 and 6). */
export function imageServices(paths: ServicePaths, postgres: string): Service[] {
  const copy = (from: string, to: string) => { cpSync(from, to, { recursive: true }) }
  return [
    { name: 'postgres', ...PORTS.postgres, probe: 'postgres', prepare: dir => {
      const data = join(dir, 'data')
      copy(join(paths.root, 'postgres', postgres), data)
      chmodSync(data, 0o700)
      return { command: join(paths.postgresBin(postgres), 'postgres'), env: baseEnv(dir), args: ['-D', data, '-c', 'listen_addresses=127.0.0.1',
        '-c', `port=${PORTS.postgres.hidden}`, '-c', `unix_socket_directories=${dir}`, '-c', 'fsync=off', '-c', 'synchronous_commit=off',
        '-c', 'full_page_writes=off', '-c', 'shared_buffers=32MB', '-c', 'jit=off', '-c', 'logging_collector=off'] }
    } },
    { name: 'rabbitmq', ...PORTS.rabbitmq, probe: 'amqp', prepare: dir => {
      copy(join(paths.root, 'rabbitmq'), dir)
      chmodSync(join(dir, '.erlang.cookie'), 0o400)
      return { command: paths.rabbitmqServer, args: [], env: rabbitmqEnv(dir, PORTS.rabbitmq.hidden) }
    } },
    { name: 'kafka', ...PORTS.kafka, probe: 'kafka', prepare: dir => {
      copy(join(paths.root, 'kafka', 'data'), join(dir, 'data'))
      writeFileSync(join(dir, 'server.properties'), kafkaProperties(dir, PORTS.kafka.port))
      return { command: join(paths.kafkaHome, 'bin', 'kafka-server-start.sh'), args: [join(dir, 'server.properties')], env: kafkaEnv(paths, dir) }
    } },
  ]
}

// ---- Readiness: each service's own protocol, so "ready" means it answers, not only that a port is open. ----

/** The first bytes a client sends, and whether a reply means the service is serving. */
const PROBES: Readonly<Record<Probe, { hello(): Buffer; ready(reply: Buffer): boolean | undefined }>> = {
  // A startup message for the trusted `postgres` user: `R` is an authentication reply, `E` an error such as "starting up".
  postgres: {
    hello: () => {
      const body = Buffer.from('user\0postgres\0database\0postgres\0\0')
      const head = Buffer.alloc(8)
      head.writeInt32BE(8 + body.length, 0)
      head.writeInt32BE(196608, 4)
      return Buffer.concat([head, body])
    },
    ready: reply => reply.length === 0 ? undefined : reply[0] === 0x52,
  },
  // The AMQP 0-9-1 header: a serving broker answers with a method frame (type 1), Connection.Start.
  amqp: { hello: () => Buffer.from([0x41, 0x4d, 0x51, 0x50, 0, 0, 9, 1]), ready: reply => reply.length === 0 ? undefined : reply[0] === 1 },
  // ApiVersions v0 with correlation id 7: a serving broker answers with that id and no error.
  kafka: {
    hello: () => {
      const id = Buffer.from('workbench')
      const request = Buffer.alloc(14 + id.length)
      request.writeInt32BE(10 + id.length, 0)
      request.writeInt16BE(18, 4)
      request.writeInt16BE(0, 6)
      request.writeInt32BE(7, 8)
      request.writeInt16BE(id.length, 12)
      id.copy(request, 14)
      return request
    },
    ready: reply => reply.length < 10 ? undefined : reply.readInt32BE(4) === 7 && reply.readInt16BE(8) === 0,
  },
}

/** Whether the service on `port` answers its protocol, within `timeoutMs`. */
export function probeOnce(probe: Probe, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1')
    let reply = Buffer.alloc(0)
    const done = (ok: boolean) => { socket.destroy(); resolve(ok) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.on('error', () => done(false))
    socket.on('close', () => done(false))
    socket.on('connect', () => socket.write(PROBES[probe].hello()))
    socket.on('data', (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk])
      const ready = PROBES[probe].ready(reply)
      if (ready !== undefined) done(ready)
    })
  })
}

/** A started service process: it is running until `exited` resolves. */
interface Running { readonly child: ChildProcess; readonly log: string; readonly exited: Promise<string> }

function startProcess(start: Start, log: string, cwd: string): Running {
  const out = openSync(log, 'a')
  // In the service's own directory: a crash dump (`erl_crash.dump`, `hs_err_pid*.log`) never lands in the worktree.
  const child = spawn(start.command, [...start.args], { cwd, env: { ...start.env }, stdio: ['ignore', out, out], detached: false })
  closeSync(out)
  const exited = new Promise<string>(resolve => {
    child.on('error', error => resolve(`it could not run: ${error.message}`))
    child.on('exit', (code, signal) => resolve(`it exited (${signal ?? `status ${code}`})`))
  })
  return { child, log, exited }
}

/** Polls until the service answers, it exits, or the time runs out; the reason when it is not ready. */
async function waitReady(service: Pick<Service, 'probe' | 'hidden'>, running: Running, timeoutMs: number): Promise<string | undefined> {
  let exited: string | undefined
  void running.exited.then(reason => { exited = reason })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited) return exited
    if (await probeOnce(service.probe, service.hidden)) return undefined
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return exited ?? `it did not answer within ${Math.round(timeoutMs / 1000)} s`
}

function tail(path: string, bytes = 2000): string {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > bytes ? `…${text.slice(-bytes)}` : text
  } catch { return '' }
}

export interface LauncherOptions {
  readonly services: readonly Service[]
  /** Where each service's copy lives (`RUN_DIR`). */
  readonly runDir: string
  readonly startTimeoutMs?: number
  /** Where the launcher reports a failed start (the command's error output). */
  report(line: string): void
}

/**
 * Listens on every service's port, and starts a service on its first connection. `close` stops listening and stops every service
 * it started (the sandbox would end them anyway).
 */
export async function startLauncher(options: LauncherOptions): Promise<{ close(): void; started(): ServiceName[] }> {
  const servers: Server[] = []
  const children: ChildProcess[] = []
  const state = new Map<ServiceName, Promise<boolean>>()

  const ensure = (service: Service): Promise<boolean> => {
    let ready = state.get(service.name)
    if (!ready) {
      ready = (async () => {
        const dir = join(options.runDir, service.name)
        let running: Running
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 })
          running = startProcess(service.prepare(dir), join(options.runDir, `${service.name}.log`), dir)
        } catch (error) {
          options.report(`${SERVICES_PREFIX}${service.name} did not start: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
        children.push(running.child)
        const reason = await waitReady(service, running, options.startTimeoutMs ?? 120_000)
        if (reason === undefined) return true
        running.child.kill('SIGKILL')
        const log = tail(running.log).trim()
        options.report(`${SERVICES_PREFIX}${service.name} did not start: ${reason}${log ? `\n${log}` : ''}`)
        return false
      })()
      state.set(service.name, ready)
    }
    return ready
  }

  const serve = (service: Service) => (client: Socket) => {
    // Bytes the client sends early wait in the paused socket until the service is ready.
    client.pause()
    client.on('error', () => client.destroy())
    void ensure(service).then(ok => {
      if (!ok || client.destroyed) { client.destroy(); return }
      const upstream = connect(service.hidden, '127.0.0.1')
      upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
      upstream.on('connect', () => { client.pipe(upstream); upstream.pipe(client); client.resume() })
    })
  }

  for (const service of options.services) {
    const server = createServer(serve(service))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(service.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    }).catch((error: unknown) => {
      options.report(`${SERVICES_PREFIX}${service.name} is not available: port ${service.port}: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (server.listening) servers.push(server)
  }
  return {
    started: () => [...state.keys()],
    close: () => {
      for (const server of servers) server.close()
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    },
  }
}

// ---- The image build (`T12.1`): each service's data prepared once, so a start copies it instead of initialising. ----

function run(command: string, args: readonly string[], env: Record<string, string>): void {
  const result = spawnSync(command, [...args], { env, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.signal ?? `status ${result.status}`})`)
}

async function bootOnce(service: Pick<Service, 'name' | 'probe' | 'hidden'>, start: Start, log: string): Promise<void> {
  const running = startProcess(start, log, start.env.HOME ?? '/tmp')
  const reason = await waitReady(service, running, 300_000)
  if (reason !== undefined) {
    running.child.kill('SIGKILL')
    throw new Error(`${service.name} did not start at build: ${reason}\n${tail(log)}`)
  }
  running.child.kill('SIGTERM')
  const stopped = await Promise.race([running.exited, new Promise<undefined>(resolve => setTimeout(resolve, 120_000))])
  if (stopped === undefined) throw new Error(`${service.name} did not stop at build`)
}

/** Prepares `<root>`: a data directory per Postgres major, RabbitMQ's home with its schema, Kafka's formatted log and class archive. */
export async function buildServices(paths: ServicePaths, majors: readonly string[] = POSTGRES_MAJORS): Promise<void> {
  const { root } = paths
  const scratch = join(root, '.build')
  mkdirSync(scratch, { recursive: true })
  for (const major of majors) {
    run(join(paths.postgresBin(major), 'initdb'), ['-D', join(root, 'postgres', major), '-U', 'postgres', '--auth=trust', '-E', 'UTF8',
      '--locale=C.UTF-8', '--wal-segsize=1', '--no-sync'], baseEnv(scratch))
  }

  const rabbit = join(root, 'rabbitmq')
  mkdirSync(rabbit, { recursive: true })
  writeFileSync(join(rabbit, '.erlang.cookie'), randomBytes(24).toString('hex'), { mode: 0o400 })
  writeFileSync(join(rabbit, 'enabled_plugins'), '[].\n')
  await bootOnce({ name: 'rabbitmq', probe: 'amqp', hidden: PORTS.rabbitmq.hidden },
    { command: paths.rabbitmqServer, args: [], env: rabbitmqEnv(rabbit, PORTS.rabbitmq.hidden) }, join(scratch, 'rabbitmq.log'))
  // Erlang's port mapper outlives the broker; stop it so the build step ends clean.
  spawnSync('epmd', ['-kill'], { env: { ...baseEnv(scratch), ERL_EPMD_PORT: String(EPMD_PORT) } })
  rmSync(join(rabbit, 'rabbitmq.pid'), { force: true })
  rmSync(join(rabbit, 'log'), { recursive: true, force: true })

  const kafka = join(root, 'kafka')
  mkdirSync(kafka, { recursive: true })
  const properties = join(scratch, 'server.properties')
  writeFileSync(properties, kafkaProperties(kafka, PORTS.kafka.hidden))
  run(join(paths.kafkaHome, 'bin', 'kafka-storage.sh'), ['format', '-t', randomUUID(), '-c', properties],
    { ...baseEnv(scratch), LOG_DIR: join(scratch, 'kafka-logs'), KAFKA_HEAP_OPTS: '-Xmx256m' })
  await bootOnce({ name: 'kafka', probe: 'kafka', hidden: PORTS.kafka.hidden },
    { command: join(paths.kafkaHome, 'bin', 'kafka-server-start.sh'), args: [properties],
      env: kafkaEnv(paths, scratch, `-XX:ArchiveClassesAtExit=${join(kafka, 'classes.jsa')}`) }, join(scratch, 'kafka.log'))
  writeFileSync(join(root, 'hosts'), HOSTS_FILE)
  rmSync(scratch, { recursive: true, force: true })
}

if (process.argv[2] === '--build' && process.argv[3] && /services\.[cm]?[jt]s$/u.test(process.argv[1] ?? '')) {
  buildServices(IMAGE_PATHS(process.argv[3])).then(() => { process.stdout.write('workbench services prepared\n') }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
}
