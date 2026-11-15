/** What host commands and Sources know of the deployment: its state directory. Each job's repository is in its manifest (`T11.1`). */
export interface Deployment {
  readonly stateDir: string
}
