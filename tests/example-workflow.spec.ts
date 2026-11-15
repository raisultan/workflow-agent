/** The example workflow module of docs/workflows.md (`examples/workflows/docs-update.ts`, `T17.5`): valid, and runs end to end. */
import { afterEach, describe, expect, it } from 'vitest'
import { defineWorkflow } from '../src/domain/definition.ts'
import { parameters, workflows } from '../examples/workflows/docs-update.ts'
import { ANNA, Harness } from './fixtures/domain-workflow.ts'

let h: Harness | undefined
afterEach(() => { h?.cleanup(); h = undefined })

describe('the example workflow module', () => {
  it('is a valid definition with a Russian variant of one prompt and titles in Russian', () => {
    const [spec] = workflows()
    const definition = defineWorkflow(spec!)
    expect(definition).toMatchObject({ id: 'docs-update', version: 1, guards: [] })
    expect(Object.keys(spec!.prompts)).toEqual(['inspect', 'plan', 'write', 'plan.ru'])
    expect(parameters('docs-update')).toEqual({})
    expect(parameters('standard-delivery')).toBeUndefined()
  })

  it('takes a docs request through inspect, an approved plan and write to completion, in English and in Russian', async () => {
    for (const locale of ['en', 'ru']) {
      h = new Harness({ workflows: workflows(), parameters: { 'docs-update': { targetBranch: 'main', testCommand: 'npm test' } }, locale })
      const job = await h.start('@workbench update the docs for sessions')
      expect(h.state(job).workflowId).toBe('docs-update')
      const plan = h.wb.workflow(h.state(job).manifestId).extra.stages.plan!.instructions
      expect(h.wb.kernel.blobs.text(plan)).toContain(locale === 'ru' ? 'Составь короткий план' : 'Write a short plan')
      await h.complete(job, { pages: ['docs/sessions.md'] })
      await h.complete(job, {}, '1. docs/sessions.md: describe the session TTL.')
      expect(h.gate(job)).toMatchObject({ kind: 'approval', subject: { kind: 'plan', n: 1 } })
      await h.say(ANNA, 'ok')
      expect(h.state(job).attempt!.stageId).toBe('write')
      await h.complete(job, { branch: 'agent/docs-sessions' })
      expect(h.status(job)).toBe('completed')
      h.cleanup()
      h = undefined
    }
  })
})
