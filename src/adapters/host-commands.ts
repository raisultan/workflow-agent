/**
 * Commands the host runs for a job (`T9.13`): a check command confined by DSH's sandbox service under `workspace-write` (writes only
 * in the job's worktree), with no credentials in its environment. Without a sandbox it refuses to run: a check runs code the agent
 * wrote, so it never runs unconfined. The job and the host profile go to the sandbox wrapper in the spawn's environment (`T10.3`),
 * which only the host sets; the wrapper picks the masks and the network from them.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { workerEnvironment } from '../infra/environment.ts'
import { shellCommand } from '../infra/git-layout.ts'
import { CONFIG_VARIABLE, HOST_JOB_VARIABLE, HOST_PROFILE_VARIABLE, type HostProfile } from '../sandbox/profile.ts'

/** What the host needs of DSH's sandbox service. */
interface Sandbox { confine(argv: readonly string[], policy: { mode: 'workspace-write' | 'read-only'; workspaceRoot: string }, signal?: AbortSignal): Promise<{ argv: string[] }> }

/**
 * Runs `argv` in `cwd`, confined to it, and returns its exit code (`null` when stopped), its output, and its standard output alone.
 * The `toolchain` and `verify` profiles ask DSH for a read-only sandbox: the wrapper gives them no worktree, and binds the toolchain
 * cache itself, writable for `toolchain` only.
 */
export async function runConfined(ctx: Context, command: { argv: readonly string[]; cwd: string; timeoutMs: number; signal: AbortSignal; jobId: string;
  profile: HostProfile }):
  Promise<{ exitCode: number | null; output: string; stdout: string }> {
  const sandbox = ctx.get('sandbox') as Sandbox | undefined
  if (!sandbox) throw new Error('no sandbox is available to confine the command, so it was not run')
  const signal = AbortSignal.any([command.signal, AbortSignal.timeout(command.timeoutMs)])
  const readOnly = command.profile === 'toolchain' || command.profile === 'verify'
  const confined = await sandbox.confine(command.argv, { mode: readOnly ? 'read-only' : 'workspace-write', workspaceRoot: command.cwd }, signal)
  const handle = ctx.subprocess.spawn({ argv: confined.argv, cwd: command.cwd, graceMs: 2000, signal, env: { ...workerEnvironment(command.cwd), [HOST_JOB_VARIABLE]: command.jobId, [HOST_PROFILE_VARIABLE]: command.profile },
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4 << 20 }, stderr: { maxBytes: 1 << 20 } } })
  const { exitCode } = await handle.done
  const read = (reader: { readFrom(offset: number): { text: string } } | undefined) => reader?.readFrom(0).text ?? ''
  const stderr = read(handle.collected.stderr)
  const stdout = read(handle.collected.stdout)
  return { exitCode, output: `${stdout}${stderr ? `\n${stderr}` : ''}`, stdout }
}

/**
 * The `upload-pack` a host fetch from the job's worktree should run: DSH's confined `git-upload-pack` under the host
 * profile `fetch` (the worktree read-only, every other repository, the state and `$DSH_HOME` masked, no network), as the command
 * line git starts (git appends the repository path) and the variables the wrapper reads. `undefined` when there is no sandbox
 * (tests); a deployment on Linux always has one (`assertSandboxWrapper`).
 */
export async function confinedUploadPack(ctx: Context, jobId: string, worktree: string): Promise<{ command: string; env: Record<string, string> } | undefined> {
  const sandbox = ctx.get('sandbox') as Sandbox | undefined
  if (!sandbox) return undefined
  const { argv } = await sandbox.confine(['git-upload-pack'], { mode: 'read-only', workspaceRoot: worktree })
  return { command: shellCommand(argv), env: { [HOST_JOB_VARIABLE]: jobId, [HOST_PROFILE_VARIABLE]: 'fetch',
    ...process.env[CONFIG_VARIABLE] ? { [CONFIG_VARIABLE]: process.env[CONFIG_VARIABLE] } : {} } }
}
