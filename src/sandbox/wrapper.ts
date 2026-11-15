/**
 * The sandbox wrapper (`T10.3`): DSH's `dsh-sandbox-local` `runnerCommand` in the Linux container. It reads its configuration and
 * the job's file, plans the command with `planSandbox`, and runs `bwrap` with the plan's arguments and environment, passing on its
 * exit status and the signals it receives. Anything it cannot do safely, it refuses: it prints a `workbench-sandbox: ` line, which
 * DSH treats as "the command did not run", and exits 126.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { endLike } from './exit.ts'
import { CONFIG_VARIABLE, planSandbox, WRAPPER_PREFIX, type JobFile, type WrapperConfig } from './profile.ts'

function refuse(reason: string): never {
  process.stderr.write(`${WRAPPER_PREFIX}${reason}\n`)
  process.exit(126)
}

function real(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

function main(): void {
  const configPath = process.env[CONFIG_VARIABLE]
  if (!configPath) refuse(`${CONFIG_VARIABLE} is not set; the workbench has not configured its sandbox`)
  let config: WrapperConfig
  try { config = JSON.parse(readFileSync(configPath, 'utf8')) as WrapperConfig } catch (error) { refuse(`cannot read ${configPath}: ${String(error)}`) }
  const plan = planSandbox({
    args: process.argv.slice(2), env: process.env, cwd: process.cwd(), config, real, exists: existsSync,
    job: jobId => { try { return JSON.parse(readFileSync(join(config.jobs, `${jobId}.json`), 'utf8')) as JobFile } catch { return undefined } },
  })
  if (plan.kind === 'refuse') refuse(plan.reason)
  const [program, ...args] = plan.argv
  const child = spawn(program!, args, { stdio: 'inherit', env: plan.env })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => { child.kill(signal) })
  child.on('error', error => refuse(`cannot start ${program}: ${error.message}`))
  // End the way the command ended, so DSH sees the same signal (or its 128 + n status).
  child.on('exit', (code, signal) => { endLike(code, signal) })
}

main()
