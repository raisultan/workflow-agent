/** The part of the deployment `writeEnvironment` needs: its state directory. Each job's repository is in its manifest (`T11.1`). */
export interface Deployment {
  readonly stateDir: string
}
