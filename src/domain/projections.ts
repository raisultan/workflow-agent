/**
 * The domain's read models (`T8.10`), kept up to date from job events inside each decision's transaction and rebuildable from
 * `job_event`: `binding` (thread → job, role) and `open_gate` (thread → gate) for the router, and `job_summary` for the dashboard.
 * Their tables are the domain's migration 1.
 */
import type { KernelDb, SchemaOwner } from '../kernel/db.ts'
import type { Projection } from '../kernel/projections.ts'
import { upcast, type JobEvent } from './job.ts'

export const DOMAIN_SCHEMA: SchemaOwner = {
  owner: 'domain',
  migrations: [{
    version: 1,
    up: `
CREATE TABLE binding (thread_key TEXT NOT NULL, job_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('origin','artifact')),
  PRIMARY KEY (thread_key, job_id));
CREATE TABLE open_gate (gate_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, thread_key TEXT NOT NULL, kind TEXT NOT NULL, opened_at INTEGER NOT NULL);
CREATE INDEX open_gate_thread ON open_gate(thread_key, opened_at);
CREATE TABLE job_summary (job_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
  requester_source TEXT NOT NULL, requester_id TEXT NOT NULL, origin_thread TEXT NOT NULL,
  status TEXT NOT NULL, stage_id TEXT, gate_id TEXT, detail TEXT, started_at INTEGER NOT NULL);`,
  }, {
    // The egress proxy's connection log (`T10.2`): written by the proxy adapter, read by the dashboard. Not a projection of events.
    version: 2,
    up: `
CREATE TABLE egress_connection (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, attempt_id TEXT, host TEXT NOT NULL,
  port INTEGER NOT NULL, address TEXT, allowed INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX egress_connection_job ON egress_connection(job_id, seq);`,
  }],
}

const project = (name: string, apply: (event: JobEvent, jobId: string, db: KernelDb) => void): Projection<JobEvent> =>
  ({ name, tables: [name], apply: (event, jobId, db) => apply(upcast(event), jobId, db) })

export const bindingProjection = project('binding', (event, jobId, db) => {
  if (event.type === 'ThreadBound') {
    db.run('INSERT INTO binding (thread_key, job_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', event.threadKey, jobId, event.role)
  }
})

export const openGateProjection = project('open_gate', (event, jobId, db) => {
  if (event.type === 'GateOpened') {
    db.run('INSERT INTO open_gate (gate_id, job_id, thread_key, kind, opened_at) VALUES (?, ?, ?, ?, ?)', event.gate.id, jobId,
      event.gate.threadKey, event.gate.kind, event.gate.openedAt)
  }
  if (event.type === 'GateClosed') db.run('DELETE FROM open_gate WHERE gate_id = ?', event.gateId)
})

export const jobSummaryProjection = project('job_summary', (event, jobId, db) => {
  const set = (status: string, fields: { stage?: string | null; gate?: string | null; detail?: string | null } = {}) => db.run(
    `UPDATE job_summary SET status = ?, stage_id = coalesce(?, stage_id), gate_id = ?, detail = ? WHERE job_id = ?`,
    status, fields.stage ?? null, fields.gate ?? null, fields.detail ?? null, jobId)
  switch (event.type) {
    case 'JobStarted': {
      const { intake } = event
      db.run(`INSERT INTO job_summary (job_id, workflow_id, workflow_version, requester_source, requester_id, origin_thread, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`, jobId, event.workflowId, intake.workflowVersion, intake.actor.source, intake.actor.id,
      intake.threadKey, event.at)
      break
    }
    case 'SetupStarted': set('setting_up', { detail: `setup ${event.n}` }); break
    case 'AttemptStarted': set('running', { stage: event.stageId }); break
    case 'VerificationStarted': set('verifying', { stage: event.stageId }); break
    case 'GateOpened': if (event.gate.kind !== 'resume' && event.gate.kind !== 'proposal') set('awaiting_gate', { stage: event.gate.stageId, gate: event.gate.id, detail: event.gate.kind }); break
    case 'Blocked': set('blocked', { gate: event.gateId, detail: event.reason.kind }); break
    case 'Parked': set('parked', { stage: event.stageId, detail: event.missing.join(', ') }); break
    case 'Unparked': set('verifying'); break
    case 'JobCompleted': set('completed', { detail: event.outcome }); break
    case 'JobFailed': set('failed', { detail: event.reason }); break
    case 'JobCancelled': set('cancelled', { detail: event.reason }); break
    default: break
  }
})

export const DOMAIN_PROJECTIONS = [bindingProjection, openGateProjection, jobSummaryProjection]
