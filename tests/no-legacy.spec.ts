/** No V1 code is left (`T9.10`, `G9`): no V1 module exists or is imported, and the package and bundle offer no V1 entry. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
/** The V1 work model and coordinator, its app layer, executor, tool plugins and admission policy (`T9.10`). */
const LEGACY = ['src/core', 'src/app/runtime.ts', 'src/app/store.ts', 'src/app/settings.ts', 'src/app/http.ts', 'src/app/views', 'src/app/sessions.ts',
  'src/app/stage-driver.ts', 'src/app/workflow-intake.ts', 'src/app/passes.ts', 'src/app/outbox.ts', 'src/app/effects.ts', 'src/app/prompts.ts',
  'src/app/notices.ts', 'src/app/resources.ts', 'src/app/allowed-senders.ts', 'src/app/role-models.ts', 'src/app/settings-history.ts',
  'src/app/standard-delivery.ts', 'src/app/tools', 'src/executor/dsh.ts', 'src/tools/jira.ts', 'src/tools/mattermost.ts', 'src/tools/gitlab.ts',
  'src/policy.ts', 'src/admission.ts', 'src/sources/admission-context.ts', 'src/client/eval.tsx', 'src/client/draft.tsx', 'src/client/prompts.tsx',
  'src/client/settings.tsx']
const sources = (dir: string): string[] => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }).filter(path => /\.tsx?$/.test(path))
  .map(path => join(dir, path))

it('keeps no V1 module', () => {
  expect(LEGACY.filter(path => existsSync(join(ROOT, path)))).toEqual([])
})

it('imports no V1 module from any source or test file', () => {
  const offenders = [...sources('src'), ...sources('tests')].flatMap(path => [...readFileSync(join(ROOT, path), 'utf8')
    .matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/gu)].flatMap(match => {
    const target = relative(ROOT, resolve(ROOT, dirname(path), match[1]!))
    return LEGACY.some(legacy => target === legacy || target.startsWith(`${legacy}/`)) ? [`${path} → ${target}`] : []
  }))
  expect(offenders).toEqual([])
})

it('offers no V1 entry: no connector tool plugins in the package, and none in the stage presets', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
  expect(Object.keys(pkg.exports).filter(key => key.startsWith('./tool-'))).toEqual([])
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  for (const name of ['workflow-agent', 'dsh-superagent']) expect(patch).not.toContain(`${name}/tool-`)
  expect(patch).not.toMatch(/(?:workflow-agent|dsh-superagent)-router/u)
})
