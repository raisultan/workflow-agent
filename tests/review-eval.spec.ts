/**
 * The review eval (`P16`, `T16.8`): its scoring of a run against a labelled case, and the synthetic cases' diffs (every file in
 * them parses, so the reviewer gets the paths they name). The model run itself is `pnpm eval:review`, manual.
 */
import { expect, it } from 'vitest'
import { expected, score } from '../scripts/eval-review.ts'
import { parseUnifiedDiff } from '../src/adapters/work-diff.ts'
import { REVIEW_CASES } from './fixtures/reviews.ts'

const F = REVIEW_CASES.find(review => review.id === 'F')!
const G = REVIEW_CASES.find(review => review.id === 'G')!

it('counts a labelled issue found in any finding or the summary, and a forbidden claim only as a blocking finding of a failure', () => {
  const settled = { tests: [], unaudited: [] }
  const run = score(F, { kind: 'verdict', tokens: 900, review: { verdict: 'changes', summary: 'Tests miss the cap.', ...settled, findings: [
    { file: 'tests/test_api.py', line: 45, side: 'new', severity: 'important', verified: true, issue: 'creates 3 codes, so the default of 20 is never reached' },
    { side: 'new', severity: 'suggestion', verified: false, issue: 'no test that limit=100 is accepted' }] } })
  expect(run).toMatchObject({ verdict: 'changes', tokens: 900, found: ['default-cap', 'limit-100'], forbidden: [] })
  // A must-block issue mentioned only in a note is not found: it did not block.
  const noted = score(F, { kind: 'verdict', tokens: 1, review: { verdict: 'pass', summary: 'cap of 20 never reached', ...settled, findings: [
    { side: 'new', severity: 'suggestion', verified: false, issue: 'the default of 20 is never reached' }] } })
  expect(noted.found).toEqual([])
  expect(expected(F, run)).toBe(true)
  const wrong = score(G, { kind: 'verdict', tokens: 1, review: { verdict: 'changes', summary: '', ...settled, findings: [
    { side: 'new', severity: 'important', verified: true, issue: 'This re-implements the endpoint from scratch instead of removing the filter' }] } })
  expect(wrong.forbidden).toEqual(['not-the-rollback'])
  expect(expected(G, wrong)).toBe(false)
  // A doubt left as a note is no forbidden claim, and a pass blocks nothing.
  expect(score(G, { kind: 'verdict', tokens: 1, review: { verdict: 'pass', summary: '', ...settled, findings: [
    { side: 'new', severity: 'suggestion', verified: false, issue: 'is this from scratch?' }] } }).forbidden).toEqual([])
  expect(score(G, { kind: 'unavailable', reason: 'timeout', tokens: 0 })).toMatchObject({ verdict: 'unavailable', reason: 'timeout' })
})

it('gives every synthetic case a diff whose files parse, with added lines', () => {
  for (const review of REVIEW_CASES) {
    const files = parseUnifiedDiff(review.diff)
    expect(files.length, review.id).toBeGreaterThan(0)
    expect(files.every(file => file.added.length > 0 || file.removed.length > 0), review.id).toBe(true)
  }
  expect(new Set(REVIEW_CASES.map(review => review.id)).size).toBe(REVIEW_CASES.length)
})
