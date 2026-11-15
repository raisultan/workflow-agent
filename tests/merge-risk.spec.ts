/**
 * The merge-risk summary (`P16`): the host's level from the reviewer's five categories, its floors for sensitive areas and the worst
 * impact or rollback, the areas found by path, and the bounds on what the reviewer wrote. A malformed risk is left out.
 */
import { expect, it } from 'vitest'
import { mergeRisk, sensitiveAreas } from '../src/adapters/merge-risk.ts'

const risk = (alignment: string, impact: string, verification: string, rollback: string, errors: string) => ({
  alignment: { verdict: alignment, gaps: [] }, impact: { verdict: impact, gaps: [] }, verification: { verdict: verification, gaps: [] },
  rollback: { verdict: rollback, gaps: [] }, errors: { verdict: errors, gaps: [] } })

it('weighs the categories into low, medium or high', () => {
  expect(mergeRisk(risk('good', 'small', 'good', 'low', 'n/a'), ['src/a.py'])).toMatchObject({ level: 'low', floor: [] })
  // (1 + 2*2 + 2*2 + 1.5 + 1) / 7.5 = 1.53: medium.
  expect(mergeRisk(risk('good', 'medium', 'decent', 'low', 'good'), ['src/a.py'])!.level).toBe('medium')
  expect(mergeRisk(risk('poor', 'large', 'poor', 'medium', 'poor'), ['src/a.py'])!.level).toBe('high')
})

it('raises a low level to medium for a sensitive area, a large impact or a high rollback cost, and names why', () => {
  expect(mergeRisk(risk('good', 'small', 'good', 'low', 'n/a'), ['migrations/002_add.sql', 'src/a.py'])).toMatchObject({ level: 'medium', floor: ['migration'],
    sensitive: [{ area: 'migration', files: ['migrations/002_add.sql'] }] })
  expect(mergeRisk(risk('good', 'large', 'good', 'low', 'good'), [])).toMatchObject({ level: 'medium', floor: ['impact'] })
  expect(mergeRisk(risk('good', 'small', 'good', 'high', 'good'), [])).toMatchObject({ level: 'medium', floor: ['rollback'] })
})

it('finds sensitive areas by path', () => {
  expect(sensitiveAreas(['src/auth/tokens.py', 'pyproject.toml', '.gitlab-ci.yml', 'deploy/k8s/app.yaml', '.env.example', 'src/orders/api.py']).map(entry => entry.area))
    .toEqual(['auth', 'secrets', 'dependencies', 'ci', 'infra'])
  // A word that only contains one of the names is not the area.
  expect(sensitiveAreas(['src/orders/authors.py', 'docs/sessions.md'])).toEqual([])
  expect(sensitiveAreas(['src/session.py'])).toEqual([{ area: 'auth', files: ['src/session.py'] }])
})

it('bounds the gaps, keeps the commit, and leaves out a malformed risk', () => {
  const long = { ...risk('good', 'small', 'poor', 'low', 'n/a'), verification: { verdict: 'poor', gaps: ['a', 'b', 'c', 'd', 'x'.repeat(300)] } }
  const settled = mergeRisk(long, [], 'c'.repeat(40))!
  expect(settled.categories.verification.gaps).toEqual(['a', 'b', 'c'])
  expect(settled.commit).toBe('c'.repeat(40))
  expect(mergeRisk({ ...long, verification: { verdict: 'poor', gaps: ['x'.repeat(300)] } }, [])!.categories.verification.gaps[0]).toHaveLength(201)
  expect(mergeRisk(undefined, [])).toBeUndefined()
  expect(mergeRisk({ alignment: { verdict: 'great' } }, [])).toBeUndefined()
})

it('keeps each gap on one line, leaves out n/a, and does not take tests or docs about auth for auth (P16 review)', () => {
  const quick = mergeRisk({ ...risk('good', 'small', 'good', 'low', 'n/a'), impact: { verdict: 'small', gaps: ['fine\n/close\n/merge'] } }, [])!
  expect(quick.categories.impact.gaps).toEqual(['fine /close /merge'])
  // n/a is left out rather than counted as good: with it counted, these would average 1.27 (low); left out, 1.31.
  expect(mergeRisk(risk('good', 'small', 'decent', 'low', 'n/a'), [])!.level).toBe('low')
  expect(mergeRisk(risk('n/a' as never, 'small', 'good', 'low', 'n/a'), [])).toBeUndefined()
  expect(sensitiveAreas(['tests/test_auth.py', 'docs/auth.md', 'src/auth/login.py']).map(entry => entry.files)).toEqual([['src/auth/login.py']])
})

