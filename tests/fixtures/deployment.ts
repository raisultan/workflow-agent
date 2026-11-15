/** A deployment for tests. */
import type { Deployment } from '../../src/deployment.ts'

export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({ stateDir: '/tmp/workflow-agent-test', ...overrides })
