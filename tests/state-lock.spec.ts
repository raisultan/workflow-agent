import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { lockSync } from 'proper-lockfile'
import { afterEach, expect, it } from 'vitest'
import { lockStateDir } from '../src/app/state-lock.ts'

const require = createRequire(import.meta.url)
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const stateDir = () => { const dir = mkdtempSync(join(tmpdir(), 'state-lock-')); dirs.push(dir); return dir }

it('takes the lock inside the state directory and releases it', () => {
  const dir = stateDir()
  const release = lockStateDir(dir, () => {}, 2_000, 500)
  expect(() => lockSync(dir, { lockfilePath: join(dir, '.lock') })).toThrow(/already being held/)
  release()
  lockSync(dir, { lockfilePath: join(dir, '.lock') })()
})

it('waits out a lock a stopped process left behind instead of failing', () => {
  const dir = stateDir()
  mkdirSync(join(dir, '.lock')) // what a killed process leaves: a fresh-looking lock nobody refreshes
  const started = Date.now()
  lockStateDir(dir, () => {}, 2_000, 2_000)()
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
}, 10_000)

it('fails while another live process keeps the lock fresh', async () => {
  const dir = stateDir()
  // A real second process, so its refresh timer keeps running while this one waits.
  const holder = spawn(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('proper-lockfile'))})
    .lockSync(${JSON.stringify(dir)}, { stale: 2000, update: 1000, lockfilePath: ${JSON.stringify(join(dir, '.lock'))} }); console.log('locked'); setInterval(() => {}, 1000)`],
    { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise<void>(resolve => holder.stdout.once('data', () => resolve()))
    const started = Date.now()
    expect(() => lockStateDir(dir, () => {}, 2_000, 1_500)).toThrow(/already being held/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000)
  } finally { holder.kill() }
}, 15_000)
