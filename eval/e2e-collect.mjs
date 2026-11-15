// The eval's collector (`T13.3`): run inside the workbench container, read-only, by `eval/e2e.ts`:
//   docker exec -i <container> node --input-type=module - <jobId> [<canary marker>] < eval/e2e-collect.mjs
// It prints one JSON object: the job's events, its connections, whether a marker appears in any effect it made, and, per attempt,
// the model usage DSH recorded in the attempt's session log (zstd JSON lines): tokens, peak context, and compactions.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const [jobId, marker] = process.argv.slice(2)
const stateDir = process.env.WORKBENCH_STATE_DIR ?? '/var/lib/workbench/state/data'
const dshHome = process.env.DSH_HOME ?? '/var/lib/workbench/dsh'
const db = new DatabaseSync(join(stateDir, 'workbench.sqlite'), { readOnly: true })

const events = db.prepare('SELECT seq, type, at, data FROM job_event WHERE job_id = ? ORDER BY seq').all(jobId)
  .map(row => ({ seq: row.seq, at: row.at, ...JSON.parse(row.data) }))
const egress = db.prepare('SELECT attempt_id, host, port, allowed, reason, at FROM egress_connection WHERE job_id = ? ORDER BY at').all(jobId)
const effects = db.prepare('SELECT kind, payload, result, status FROM effect WHERE job_id = ?').all(jobId)
const canary = marker ? {
  effects: effects.filter(row => `${row.payload ?? ''}${row.result ?? ''}`.includes(marker)).map(row => row.kind),
  egress: egress.filter(row => `${row.host}${row.reason}`.includes(marker)).length,
  events: events.filter(event => JSON.stringify(event).includes(marker)).map(event => event.type),
} : undefined

/** Each attempt's session: the sum of usage over its model replies, its largest prompt, its context window, and compactions. */
const sessions = {}
const dir = join(dshHome, 'sessions')
for (const workspace of existsSync(dir) ? readdirSync(dir) : []) {
  if (!workspace.includes(jobId)) continue
  for (const session of readdirSync(join(dir, workspace))) {
    const file = join(dir, workspace, session, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    let records
    try { records = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { continue }
    const usage = { replies: 0, input: 0, cacheRead: 0, output: 0, peakContext: 0, contextWindow: 0, compactions: 0, model: undefined, toolCalls: 0 }
    for (const record of records) {
      if (record.type === 'request/context') { usage.contextWindow = Math.max(usage.contextWindow, record.data?.contextWindow ?? 0); usage.model ??= record.data?.model }
      if (record.type === 'compaction/start') usage.compactions += 1
      if (record.type === 'tool/call') usage.toolCalls += 1
      if (record.type === 'assistant/message' && record.data?.usage) {
        const u = record.data.usage
        usage.replies += 1
        usage.input += u.inputTokens ?? 0
        usage.cacheRead += u.cacheReadTokens ?? 0
        usage.output += u.outputTokens ?? 0
        usage.peakContext = Math.max(usage.peakContext, (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0))
      }
    }
    // Session ids are `wb-<jobId>-a<n>`; attempt ids `<jobId>.a<n>`.
    sessions[session.replace(/^wb-/u, '').replace(/-(a\d+)$/u, '.$1')] = usage
  }
}

process.stdout.write(JSON.stringify({ jobId, events, egress: egress.map(row => ({ ...row, allowed: row.allowed === 1 })), sessions, canary,
  effectKinds: effects.map(row => `${row.kind}:${row.status}`) }))
