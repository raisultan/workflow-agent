/** A host command that failed: its stderr (or how it ended) as the message, and its exit status when it exited. */
export class CliError extends Error {
  readonly exitCode?: number
  constructor(message: string, exitCode?: number) {
    super(message)
    this.exitCode = exitCode
  }
}
