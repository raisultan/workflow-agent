/**
 * The eval's workflow module (`T13.2`, scenario 10), mounted at `/workspace/eval/workflows/`, so it imports the image's `src` as it
 * imports the repository's, and named in the eval profile's `workflows.modules`. It registers a variant of `standard-delivery` with a small token budget, chosen by `[eval-budget]` in the
 * trigger, ahead of the standard workflow itself: intake takes the first workflow whose trigger matches, and the standard one
 * matches every mention. So the eval profile leaves `workflows.standardDelivery` out, and this module gives both their parameters.
 */
import type { WorkflowSpec } from '../../src/domain/definition.ts'
import { standardDelivery } from '../../src/workflows/standard-delivery.ts'

const JIRA = { 'jira.inProgress': 'In Progress', 'jira.inReview': 'In Review' }

export function workflows(): WorkflowSpec[] {
  const standard = standardDelivery()
  const declaration = standard.declaration
  // Its version follows the standard one's, so a changed standard workflow never meets a stored budget variant of the same version.
  const budget: WorkflowSpec = { ...standard, id: 'standard-delivery-budget', version: standard.version, declaration: { ...declaration,
    title: `${declaration.title} (eval: small budget)`,
    triggers: declaration.triggers.map(trigger => ({ ...trigger, pattern: '\\[eval-budget\\]' })),
    // The scenario's small ticket used about 52,000 tokens in a trial run (T13.3), so this runs out partway; an extension adds enough.
    budgets: { ...declaration.budgets, tokens: 30_000, extension: { ...declaration.budgets.extension, tokens: 400_000 } } } }
  return [budget, standard]
}

export function parameters(workflowId: string): Record<string, string> | undefined {
  return workflowId === 'standard-delivery' || workflowId === 'standard-delivery-budget' ? JIRA : undefined
}
