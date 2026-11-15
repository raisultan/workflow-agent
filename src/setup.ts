/** Startup errors the operator can fix, each with a fixed sentence. */
import { fill } from './infra/text.ts'

const SETUP_PROBLEMS = {
  foreignFile: '{file} was not written by workflow-agent; move it, or choose another state directory.',
} as const
export type SetupCode = keyof typeof SETUP_PROBLEMS

/** Thrown at startup when the state directory holds a file the workbench did not write (`infra/environment.ts`). */
export class SetupError extends Error {
  readonly code: SetupCode
  readonly values: Record<string, string>
  constructor(code: SetupCode, values: Record<string, string> = {}) {
    super(fill(SETUP_PROBLEMS[code], values))
    this.code = code
    this.values = values
  }
}
