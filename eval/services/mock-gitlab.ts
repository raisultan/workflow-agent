/**
 * A mock GitLab for the eval and the connector's contract tests (`T11.7`). Synthetic data only.
 *
 * - **REST**, the subset the workbench's GitLab connector uses (`src/sources/gitlab.ts`): a project and its branches; merge
 *   requests (list by state and source branch, create, read with the head pipeline, update); notes (paginated, either order) and
 *   discussions (paginated, with replies); pipelines by commit and by merge request; a pipeline's jobs (by scope); a job's log
 *   (with `Range: bytes=-N`). Every `/api/v4` call needs the token (`PRIVATE-TOKEN` or `Authorization: Bearer`).
 * - **Git**, smart HTTP over bare repositories under `root`, through `git http-backend`, with HTTP Basic auth (any user, the token
 *   as password, as `oauth2:<token>`). Clone, fetch and push work as against GitLab.
 * - **CI**, scripted per project: each push of a branch creates a pipeline from the project's script (a queue of runs, then its
 *   default): `none` creates none (a repository without CI); `success` or `failed` runs `running` for `delayMs`, then ends so,
 *   with its jobs and their logs.
 * - **GitLab's own behaviour**, which a connector must cope with (`quirks`): system notes when a merge request's branch moves, its
 *   title changes or it is merged; a job log sent whole, with `200`, whatever `Range` asks for. A second open merge request for one
 *   branch is always refused as GitLab refuses it: `409` with the message as an array.
 * - **Control**, under `/__mock` (same token): create a project from files, set its CI script, post a note as a person, merge or
 *   close a merge request, and read the whole state. Tests use the class directly.
 *
 *   MOCK_GITLAB_ROOT=… MOCK_GITLAB_TOKEN=… PORT=8929 node eval/services/mock-gitlab.ts [--seed eval/repos]
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

export interface CiJob { readonly name: string; readonly stage: string; readonly status: 'success' | 'failed'; readonly log: string }
export type CiRun = { readonly status: 'none' } | { readonly status: 'success' | 'failed'; readonly delayMs?: number; readonly jobs?: readonly CiJob[] }
export interface User { readonly id: number; readonly username: string; readonly name: string }
interface Note { id: number; body: string; author: User; created_at: string; updated_at: string; system: boolean; resolvable: boolean; resolved?: boolean; noteable_iid: number }
interface Discussion { id: string; individual_note: boolean; notes: Note[] }
interface MergeRequest {
  id: number; iid: number; project_id: number; title: string; description: string; state: 'opened' | 'merged' | 'closed'; source_branch: string
  target_branch: string; author: User; created_at: string; updated_at: string; discussions: Discussion[]
}
interface Job { id: number; name: string; stage: string; status: string; web_url: string; log: string; pipeline_id: number }
interface Pipeline { id: number; project_id: number; sha: string; ref: string; status: string; web_url: string; created_at: string; updated_at: string; jobs: Job[] }
interface Project { id: number; path: string; bare: string; defaultBranch: string; mrs: MergeRequest[]; pipelines: Pipeline[]; ci: { queue: CiRun[]; default: CiRun } }

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u

export interface MockGitLabOptions {
  /** Where the bare repositories live. */
  readonly root: string
  readonly token: string
  /** The URL the mock is reached at, for `web_url`; the listening address by default. */
  readonly publicUrl?: string
  /** The person the token belongs to (GitLab runs on a person's token, as the workbench's does). */
  readonly owner?: User
  /** GitLab's own behaviour: system notes, and a job log that ignores `Range`. Off by default, so tests can run both ways. */
  readonly quirks?: { readonly systemNotes?: boolean; readonly ignoreRange?: boolean }
}

export class MockGitLab {
  readonly options: MockGitLabOptions
  readonly projects: Project[] = []
  private server: Server | undefined
  private ids = { project: 0, mr: 0, note: 0, pipeline: 0, job: 0 }
  private readonly timers = new Set<NodeJS.Timeout>()
  url = ''

  constructor(options: MockGitLabOptions) {
    this.options = options
    mkdirSync(options.root, { recursive: true })
  }

  get owner(): User { return this.options.owner ?? { id: 1, username: 'workbench-owner', name: 'Workbench Owner' } }
  private get publicUrl(): string { return (this.options.publicUrl ?? this.url).replace(/\/+$/u, '') }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(error => { if (!res.headersSent) send(res, 500, { message: String(error) }); else res.destroy() }) })
    await new Promise<void>(resolve => this.server!.listen(port, host, resolve))
    const address = this.server.address() as { port: number }
    this.url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`
    return this.url
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
    this.server?.closeAllConnections?.()
  }

  /** Creates a project whose default branch holds `files` (or the files under directory `from`), with CI script `ci`. */
  createProject(path: string, content: { files?: Record<string, string>; from?: string; ci?: CiRun; defaultBranch?: string } = {}): Project {
    if (!PROJECT_PATH.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw new Error(`invalid project path ${path}`)
    const existing = this.project(path)
    if (existing) return existing
    const bare = join(this.options.root, `${path}.git`)
    const branch = content.defaultBranch ?? 'main'
    const ci = { queue: [], default: content.ci ?? { status: 'none' as const } }
    // A repository kept from an earlier run is served as it is; merge requests and pipelines start empty.
    if (existsSync(bare)) {
      const kept: Project = { id: ++this.ids.project, path, bare, defaultBranch: branch, mrs: [], pipelines: [], ci }
      this.projects.push(kept)
      return kept
    }
    mkdirSync(dirname(bare), { recursive: true })
    git(dirname(bare), 'init', '-q', '--bare', '-b', branch, bare)
    git(bare, 'config', 'http.receivepack', 'true')
    const work = mkdtempSync(join(tmpdir(), 'mock-gitlab-seed-'))
    try {
      git(work, 'init', '-q', '-b', branch)
      const files = { ...content.from ? readTree(content.from) : {}, ...content.files ?? {} }
      if (Object.keys(files).length === 0) files['README.md'] = `# ${path}\n`
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(work, name)), { recursive: true })
        writeFileSync(join(work, name), text)
      }
      git(work, 'add', '-A')
      git(work, '-c', 'user.name=Eval Seed', '-c', 'user.email=seed@example.test', 'commit', '-q', '-m', 'Initial commit')
      git(work, 'push', '-q', bare, `HEAD:refs/heads/${branch}`)
    } finally { rmSync(work, { recursive: true, force: true }) }
    const project: Project = { id: ++this.ids.project, path, bare, defaultBranch: branch, mrs: [], pipelines: [], ci }
    this.projects.push(project)
    return project
  }

  /** Sets a project's CI: runs taken one per push, then `fallback` for every later push. */
  scriptCi(path: string, runs: readonly CiRun[], fallback?: CiRun): void {
    const project = this.need(path)
    project.ci.queue = [...runs]
    if (fallback) project.ci.default = fallback
  }

  /** Posts a note on a merge request as a person (a reviewer), in a discussion when given. */
  postNote(path: string, iid: number, body: string, author: User, discussionId?: string): Note {
    return this.addNote(this.mr(this.need(path), iid), body, author, discussionId)
  }

  /** Merges or closes a merge request. Merging moves the target branch to the source branch's commit. */
  setState(path: string, iid: number, state: 'merged' | 'closed'): void {
    const project = this.need(path)
    const mr = this.mr(project, iid)
    if (state === 'merged') {
      const sha = this.branchSha(project, mr.source_branch)
      if (sha) git(project.bare, 'update-ref', `refs/heads/${mr.target_branch}`, sha)
    }
    this.systemNote(mr, state === 'merged' ? 'merged' : 'closed')
    mr.state = state
    mr.updated_at = now()
  }

  project(path: string): Project | undefined { return this.projects.find(project => project.path === path) }

  /** The commit a branch points at, if it exists. */
  branchSha(project: Project, branch: string): string | undefined {
    try { return git(project.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).trim() || undefined } catch { return undefined }
  }

  /** The repository's files at a branch, for assertions. */
  fileAt(path: string, branch: string, file: string): string | undefined {
    try { return git(this.need(path).bare, 'show', `refs/heads/${branch}:${file}`) } catch { return undefined }
  }

  private need(path: string): Project {
    const project = this.project(path)
    if (!project) throw new HttpError(404, '404 Project Not Found')
    return project
  }

  private mr(project: Project, iid: number): MergeRequest {
    const mr = project.mrs.find(candidate => candidate.iid === iid)
    if (!mr) throw new HttpError(404, '404 Not found')
    return mr
  }

  private addNote(mr: MergeRequest, body: string, author: User, discussionId?: string, system = false): Note {
    if (typeof body !== 'string' || body.length === 0) throw new HttpError(400, 'body is missing')
    const at = now()
    const note: Note = { id: ++this.ids.note, body, author, created_at: at, updated_at: at, system, resolvable: discussionId !== undefined, noteable_iid: mr.iid }
    if (discussionId) {
      const discussion = mr.discussions.find(candidate => candidate.id === discussionId)
      if (!discussion) throw new HttpError(404, '404 Discussion Not Found')
      discussion.notes.push(note)
      discussion.individual_note = false
    } else mr.discussions.push({ id: randomBytes(20).toString('hex'), individual_note: true, notes: [note] })
    mr.updated_at = at
    return note
  }

  /** A system note, as GitLab adds one, when quirks are on. */
  private systemNote(mr: MergeRequest, body: string): void {
    if (this.options.quirks?.systemNotes) this.addNote(mr, body, this.owner, undefined, true)
  }

  private mrJson(project: Project, mr: MergeRequest) {
    const sha = this.branchSha(project, mr.source_branch)
    const head = project.pipelines.filter(pipeline => pipeline.sha === sha).sort((a, b) => b.id - a.id)[0]
    const { discussions: _discussions, ...rest } = mr
    return { ...rest, sha: sha ?? null, web_url: `${this.publicUrl}/${project.path}/-/merge_requests/${mr.iid}`,
      head_pipeline: head ? pipelineJson(head) : null, merge_status: 'can_be_merged', draft: false }
  }

  /** After a push: a pipeline for each branch that moved, from the project's CI script. */
  private pushed(project: Project, before: Map<string, string>): void {
    for (const [ref, sha] of refs(project.bare)) {
      if (before.get(ref) === sha || !ref.startsWith('refs/heads/')) continue
      for (const mr of project.mrs) if (mr.state === 'opened' && `refs/heads/${mr.source_branch}` === ref) this.systemNote(mr, 'added 1 commit')
      const run = project.ci.queue.shift() ?? project.ci.default
      if (run.status === 'none') continue
      const at = now()
      const pipeline: Pipeline = { id: ++this.ids.pipeline, project_id: project.id, sha, ref: ref.slice('refs/heads/'.length), status: 'running',
        web_url: '', created_at: at, updated_at: at, jobs: [] }
      pipeline.web_url = `${this.publicUrl}/${project.path}/-/pipelines/${pipeline.id}`
      const jobs = run.jobs ?? [{ name: 'test', stage: 'test', status: run.status, log: run.status === 'success' ? 'All tests passed.\n' : 'FAIL tests/example.test\nAssertionError: expected 1 to equal 2\n' }]
      pipeline.jobs = jobs.map(job => {
        const id = ++this.ids.job
        return { id, name: job.name, stage: job.stage, status: 'running', web_url: `${this.publicUrl}/${project.path}/-/jobs/${id}`, log: job.log, pipeline_id: pipeline.id }
      })
      project.pipelines.push(pipeline)
      const finish = () => {
        pipeline.jobs.forEach((job, index) => { job.status = jobs[index]!.status })
        pipeline.status = run.status
        pipeline.updated_at = now()
      }
      if ((run.delayMs ?? 0) <= 0) finish()
      else {
        const timer = setTimeout(() => { this.timers.delete(timer); finish() }, run.delayMs)
        timer.unref?.()
        this.timers.add(timer)
      }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock')
    const method = req.method ?? 'GET'
    const gitPath = /^\/(.+?\.git)(\/(?:info\/refs|git-upload-pack|git-receive-pack|HEAD))$/u.exec(url.pathname)
    if (gitPath) { await this.git(req, res, gitPath[1]!, gitPath[2]!, url); return }
    const token = req.headers['private-token'] ?? /^Bearer (.+)$/u.exec(req.headers.authorization ?? '')?.[1]
    if (token !== this.options.token) { send(res, 401, { message: '401 Unauthorized' }); return }
    try {
      if (url.pathname.startsWith('/__mock/')) { await this.control(req, res, url, method); return }
      await this.api(req, res, url, method)
    } catch (error) {
      if (error instanceof HttpError) send(res, error.status, { message: error.body })
      else throw error
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const match = /^\/api\/v4\/projects\/([^/]+)(\/.*)?$/u.exec(url.pathname)
    if (!match) throw new HttpError(404, '404 Not Found')
    const project = this.need(decodeURIComponent(match[1]!))
    const rest = match[2] ?? ''
    const q = url.searchParams
    let m: RegExpExecArray | null
    if (rest === '' && method === 'GET') {
      send(res, 200, { id: project.id, path_with_namespace: project.path, default_branch: project.defaultBranch, web_url: `${this.publicUrl}/${project.path}`,
        http_url_to_repo: `${this.publicUrl}/${project.path}.git` })
      return
    }
    if (rest === '/repository/branches' && method === 'GET') {
      const branches = [...refs(project.bare)].filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { id: sha }, default: ref === `refs/heads/${project.defaultBranch}` }))
      page(res, q, branches)
      return
    }
    if ((m = /^\/repository\/branches\/(.+)$/u.exec(rest)) && method === 'GET') {
      const name = decodeURIComponent(m[1]!)
      const sha = this.branchSha(project, name)
      if (!sha) throw new HttpError(404, '404 Branch Not Found')
      send(res, 200, { name, commit: { id: sha }, default: name === project.defaultBranch })
      return
    }
    if (rest === '/merge_requests' && method === 'GET') {
      const list = project.mrs.filter(mr => (!q.get('state') || q.get('state') === 'all' || mr.state === q.get('state'))
        && (!q.get('source_branch') || mr.source_branch === q.get('source_branch'))).sort((a, b) => b.iid - a.iid)
      page(res, q, list.map(mr => this.mrJson(project, mr)))
      return
    }
    if (rest === '/merge_requests' && method === 'POST') {
      const body = await json(req) as { source_branch?: string; target_branch?: string; title?: string; description?: string }
      if (!body.source_branch || !body.target_branch || !body.title) throw new HttpError(400, 'source_branch, target_branch and title are required')
      if (!this.branchSha(project, body.source_branch)) throw new HttpError(400, `source branch ${body.source_branch} does not exist`)
      if (project.mrs.some(mr => mr.state === 'opened' && mr.source_branch === body.source_branch && mr.target_branch === body.target_branch)) {
        const existing = project.mrs.find(mr => mr.state === 'opened' && mr.source_branch === body.source_branch && mr.target_branch === body.target_branch)!
        throw new HttpError(409, [`Another open merge request already exists for this source branch: !${existing.iid}`])
      }
      const at = now()
      const mr: MergeRequest = { id: ++this.ids.mr, iid: project.mrs.length + 1, project_id: project.id, title: body.title, description: body.description ?? '',
        state: 'opened', source_branch: body.source_branch, target_branch: body.target_branch, author: this.owner, created_at: at, updated_at: at, discussions: [] }
      project.mrs.push(mr)
      send(res, 201, this.mrJson(project, mr))
      return
    }
    if (!(m = /^\/merge_requests\/(\d+)(\/.*)?$/u.exec(rest))) {
      if (rest === '/pipelines' && method === 'GET') {
        const list = project.pipelines.filter(pipeline => (!q.get('sha') || pipeline.sha === q.get('sha')) && (!q.get('ref') || pipeline.ref === q.get('ref')))
          .sort((a, b) => q.get('sort') === 'asc' ? a.id - b.id : b.id - a.id)
        page(res, q, list.map(pipelineJson))
        return
      }
      if ((m = /^\/pipelines\/(\d+)\/jobs$/u.exec(rest)) && method === 'GET') {
        const pipeline = project.pipelines.find(candidate => candidate.id === Number(m![1]))
        if (!pipeline) throw new HttpError(404, '404 Pipeline Not Found')
        const scopes = q.getAll('scope[]')
        page(res, q, pipeline.jobs.filter(job => scopes.length === 0 || scopes.includes(job.status)).map(jobJson))
        return
      }
      if ((m = /^\/jobs\/(\d+)\/trace$/u.exec(rest)) && method === 'GET') {
        const job = project.pipelines.flatMap(pipeline => pipeline.jobs).find(candidate => candidate.id === Number(m![1]))
        if (!job) throw new HttpError(404, '404 Job Not Found')
        const log = Buffer.from(job.log)
        const range = this.options.quirks?.ignoreRange ? null : /^bytes=-(\d+)$/u.exec(String(req.headers.range ?? ''))
        const part = range ? log.subarray(Math.max(0, log.length - Number(range[1]))) : log
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': part.length })
        res.end(part)
        return
      }
      throw new HttpError(404, '404 Not Found')
    }
    const mr = this.mr(project, Number(m[1]))
    const sub = m[2] ?? ''
    if (sub === '' && method === 'GET') { send(res, 200, this.mrJson(project, mr)); return }
    if (sub === '' && method === 'PUT') {
      const body = await json(req) as { title?: string; description?: string; state_event?: string }
      if (body.title !== undefined && body.title !== mr.title) { this.systemNote(mr, `changed title from **${mr.title}** to **${body.title}**`); mr.title = body.title }
      if (body.description !== undefined) mr.description = body.description
      if (body.state_event === 'close') mr.state = 'closed'
      if (body.state_event === 'reopen') mr.state = 'opened'
      mr.updated_at = now()
      send(res, 200, this.mrJson(project, mr))
      return
    }
    const notes = () => mr.discussions.flatMap(discussion => discussion.notes)
    if (sub === '/notes' && method === 'GET') {
      const list = notes().sort((a, b) => (a.created_at.localeCompare(b.created_at) || a.id - b.id) * (q.get('sort') === 'asc' ? 1 : -1))
      page(res, q, list)
      return
    }
    if (sub === '/notes' && method === 'POST') { send(res, 201, this.addNote(mr, ((await json(req)) as { body?: string }).body ?? '', this.owner)); return }
    if (sub === '/discussions' && method === 'GET') { page(res, q, mr.discussions); return }
    if ((m = /^\/discussions\/([0-9a-f]+)\/notes$/u.exec(sub)) && method === 'POST') {
      send(res, 201, this.addNote(mr, ((await json(req)) as { body?: string }).body ?? '', this.owner, m[1]))
      return
    }
    if (sub === '/pipelines' && method === 'GET') {
      const shas = new Set([this.branchSha(project, mr.source_branch), ...project.pipelines.filter(pipeline => pipeline.ref === mr.source_branch).map(pipeline => pipeline.sha)])
      page(res, q, project.pipelines.filter(pipeline => shas.has(pipeline.sha)).sort((a, b) => b.id - a.id).map(pipelineJson))
      return
    }
    throw new HttpError(404, '404 Not Found')
  }

  private async control(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const body = method === 'GET' ? {} : await json(req) as Record<string, unknown>
    if (url.pathname === '/__mock/state' && method === 'GET') {
      send(res, 200, this.projects.map(project => ({ path: project.path, branches: Object.fromEntries(refs(project.bare)), ci: project.ci,
        mergeRequests: project.mrs.map(mr => ({ ...this.mrJson(project, mr), notes: mr.discussions.flatMap(discussion => discussion.notes) })),
        pipelines: project.pipelines.map(pipeline => ({ ...pipelineJson(pipeline), jobs: pipeline.jobs.map(jobJson) })) })))
      return
    }
    if (url.pathname === '/__mock/projects' && method === 'POST') {
      const project = this.createProject(String(body.path), { files: body.files as Record<string, string> | undefined, ci: body.ci as CiRun | undefined })
      send(res, 201, { id: project.id, path: project.path })
      return
    }
    const m = /^\/__mock\/projects\/([^/]+)\/(ci|merge_requests\/(\d+)\/(notes|merge|close))$/u.exec(url.pathname)
    if (!m || method !== 'POST') throw new HttpError(404, '404 Not Found')
    const path = decodeURIComponent(m[1]!)
    if (m[2] === 'ci') { this.scriptCi(path, (body.runs ?? []) as CiRun[], body.default as CiRun | undefined); send(res, 200, this.need(path).ci); return }
    const iid = Number(m[3])
    if (m[4] === 'notes') {
      const author = (body.author ?? {}) as Partial<User>
      if (!author.username) throw new HttpError(400, 'author.username is required')
      send(res, 201, this.postNote(path, iid, String(body.body ?? ''), { id: author.id ?? 1000 + author.username.length, username: author.username,
        name: author.name ?? author.username }, body.discussionId as string | undefined))
      return
    }
    this.setState(path, iid, m[4] === 'merge' ? 'merged' : 'closed')
    send(res, 200, this.mrJson(this.need(path), this.mr(this.need(path), iid)))
  }

  /** Git's smart HTTP, through `git http-backend` as CGI. */
  private async git(req: IncomingMessage, res: ServerResponse, repo: string, rest: string, url: URL): Promise<void> {
    const basic = /^Basic (.+)$/u.exec(req.headers.authorization ?? '')?.[1]
    const [user, password] = basic ? Buffer.from(basic, 'base64').toString('utf8').split(/:(.*)/su) : []
    if (password !== this.options.token) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitLab"', 'Content-Type': 'text/plain' })
      res.end('HTTP Basic: Access denied\n')
      return
    }
    const project = this.project(repo.replace(/\.git$/u, ''))
    if (!project) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('The project you were looking for could not be found.\n'); return }
    const receive = rest === '/git-receive-pack'
    const before = receive ? refs(project.bare) : undefined
    const child = spawn('git', ['http-backend'], { env: { ...process.env, ...GIT_ENV, GIT_PROJECT_ROOT: this.options.root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${relative(this.options.root, project.bare)}${rest}`, REQUEST_METHOD: req.method ?? 'GET', QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: user || 'oauth2', REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
      ...req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {},
      ...req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {} }, stdio: ['pipe', 'pipe', 'pipe'] })
    req.pipe(child.stdin)
    let head = Buffer.alloc(0), started = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (started) { res.write(chunk); return }
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n') !== -1 ? head.indexOf('\r\n\r\n') : head.indexOf('\n\n')
      if (end === -1) return
      const separator = head.indexOf('\r\n\r\n') === end ? 4 : 2
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of head.subarray(0, end).toString('latin1').split(/\r?\n/u)) {
        const [name, ...value] = line.split(':')
        if (!name) continue
        if (name.toLowerCase() === 'status') status = Number.parseInt(value.join(':').trim(), 10)
        else headers[name] = value.join(':').trim()
      }
      res.writeHead(status, headers)
      started = true
      res.write(head.subarray(end + separator))
    })
    await new Promise<void>(resolve => child.on('close', () => resolve()))
    if (!started) res.writeHead(500)
    res.end()
    if (before) this.pushed(project, before)
  }
}

class HttpError extends Error {
  readonly status: number
  /** GitLab sends some errors' message as an array (a `409` for a second merge request). */
  readonly body: string | string[]
  constructor(status: number, message: string | string[]) { super(Array.isArray(message) ? message.join('; ') : message); this.status = status; this.body = message }
}

const now = () => new Date().toISOString()
const pipelineJson = (pipeline: Pipeline) => ({ id: pipeline.id, project_id: pipeline.project_id, sha: pipeline.sha, ref: pipeline.ref, status: pipeline.status,
  web_url: pipeline.web_url, created_at: pipeline.created_at, updated_at: pipeline.updated_at })
const jobJson = (job: Job) => ({ id: job.id, name: job.name, stage: job.stage, status: job.status, web_url: job.web_url, pipeline: { id: job.pipeline_id } })

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

/** GitLab's offset pagination: `per_page` (20 by default, at most 100) and `page`, with `X-Next-Page` and `X-Total`. */
function page(res: ServerResponse, q: URLSearchParams, items: readonly unknown[]): void {
  const perPage = Math.min(100, Math.max(1, Number(q.get('per_page') ?? 20) || 20))
  const current = Math.max(1, Number(q.get('page') ?? 1) || 1)
  const slice = items.slice((current - 1) * perPage, current * perPage)
  const next = current * perPage < items.length ? String(current + 1) : ''
  send(res, 200, slice, { 'X-Next-Page': next, 'X-Page': String(current), 'X-Per-Page': String(perPage), 'X-Total': String(items.length) })
}

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 4 << 20) throw new HttpError(413, 'request too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { throw new HttpError(400, 'the body is not JSON') }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] })
}

function refs(bare: string): Map<string, string> {
  const out = git(bare, 'for-each-ref', '--format=%(objectname) %(refname)')
  return new Map(out.split('\n').filter(Boolean).map(line => { const [sha, ref] = line.split(' '); return [ref!, sha!] }))
}

/** A directory's files as text, skipping `.git` and the seed's own `mock.json`. */
function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'mock.json' || name === 'node_modules' || name === '__pycache__' || name === '.venv') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[relative(root, path)] = readFileSync(path, 'utf8')
    }
  }
  walk(root)
  return files
}

/** Seeds a project from each directory of `dir` that has a `mock.json` (`{ "project": "group/name", "ci": {…} }`). */
export function seed(mock: MockGitLab, dir: string): string[] {
  const seeded: string[] = []
  for (const name of readdirSync(dir)) {
    const config = join(dir, name, 'mock.json')
    if (!existsSync(config)) continue
    const { project, ci } = JSON.parse(readFileSync(config, 'utf8')) as { project: string; ci?: CiRun }
    mock.createProject(project, { from: join(dir, name), ...ci ? { ci } : {} })
    seeded.push(project)
  }
  return seeded
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.MOCK_GITLAB_TOKEN
  const root = process.env.MOCK_GITLAB_ROOT
  if (!token || !root) throw new Error('MOCK_GITLAB_TOKEN and MOCK_GITLAB_ROOT must be set')
  const mock = new MockGitLab({ root, token, ...process.env.MOCK_GITLAB_PUBLIC_URL ? { publicUrl: process.env.MOCK_GITLAB_PUBLIC_URL } : {} })
  const seedAt = process.argv.indexOf('--seed')
  await mock.listen(Number(process.env.PORT ?? 8929), process.env.HOST ?? '127.0.0.1')
  const seeded = seedAt === -1 ? [] : seed(mock, process.argv[seedAt + 1]!)
  console.log(`mock GitLab on ${mock.url}${seeded.length ? `; projects: ${seeded.join(', ')}` : ''}`)
}
