/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment'
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by workflow-agent; move it, or choose another state directory.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }

/**
 * Thrown at startup when the state directory holds a file the workbench did not write (`infra/environment.ts`).
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  readonly code: SetupCode
  readonly values: Record<string, string>
  constructor(code: SetupCode, values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.code = code
    this.values = values
    this.place = place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}
