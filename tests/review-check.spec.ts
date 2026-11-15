/**
 * How the host settles a review (`P16`): each critical or important finding keeps its severity only with evidence the host finds
 * (a quote on or near a changed line of that file's side, or a plan quote with a token absent from the change); the verdict settles;
 * the engineer gets the blocking findings and people get the rest. No model: the answers are written here.
 */
import { describe, expect, it } from 'vitest'
import { blocking, reviewEvidence, reviewNotes, ReviewVerdictSchema, settle, type SettledReview } from '../src/adapters/review-check.ts'
import { annotatePatch } from '../src/adapters/work-diff.ts'

const PATCH = [
  'diff --git a/src/api.py b/src/api.py', '--- a/src/api.py', '+++ b/src/api.py', '@@ -10,8 +10,9 @@',
  ' ERRORS = {', '     400: {"model": ErrorOut},', '-    404: {"model": ErrorOut},', '+    404: {"model": NotFoundOut},', '+    410: {"model": ErrorOut},', ' }',
  ' ', ' ', ' def far_away():', '     return None',
  'diff --git a/tests/test_api.py b/tests/test_api.py', '--- a/tests/test_api.py', '+++ b/tests/test_api.py', '@@ -1,1 +1,4 @@', ' import pytest',
  '+def test_defaults_to_twenty(client):', '+    assert len(client.get("/codes").json()) == 3', '+',
].join('\n')
const annotated = annotatePatch(PATCH)
const PLAN = 'Tests: limit=100 is accepted; without limit at most 20 come back (create 25).'
const files = ['src/api.py', 'tests/test_api.py']
const review = (answer: Record<string, unknown>): SettledReview =>
  settle(ReviewVerdictSchema.parse({ summary: 's', ...answer }), { annotated, plan: PLAN, followUps: ['Also return 410 for expired codes'], files })
const one = (finding: Record<string, unknown>) => review({ verdict: 'changes', findings: [finding] }).findings[0]!

describe('evidence', () => {
  it('verifies a quote on a changed line of the named file, and takes the line from it', () => {
    expect(one({ file: 'src/api.py', line: 99, severity: 'important', issue: 'x', quote: '410: {"model": ErrorOut},' })).toMatchObject({ verified: true, line: 13 })
    // Prefixes copied with it, a quote across lines, and an elision all match.
    expect(one({ file: 'src/api.py', severity: 'critical', issue: 'x', quote: '[NEW:12] +    404: {"model": NotFoundOut},\n+    410:' })).toMatchObject({ verified: true, line: 12 })
    expect(one({ file: 'src/api.py', severity: 'important', issue: 'x', quote: 'ERRORS = { … 410: {"model": ErrorOut}' })).toMatchObject({ verified: true, line: 10 })
    // The old side is its own: a removed line is quoted there.
    expect(one({ file: 'src/api.py', side: 'old', severity: 'important', issue: 'x', quote: '404: {"model": ErrorOut},' })).toMatchObject({ verified: true, line: 12 })
    // A removed line quoted without its side is found on the old side.
    expect(one({ file: 'src/api.py', severity: 'important', issue: 'x', quote: '404: {"model": ErrorOut},' })).toMatchObject({ verified: true, side: 'old', line: 12 })
    // A quote copied straight from the diff, across both sides, is found in diff order.
    expect(one({ file: 'src/api.py', severity: 'important', issue: 'x', quote: '     400: {"model": ErrorOut},\n-    404: {"model": ErrorOut},\n+    404: {"model": NotFoundOut},' }))
      .toMatchObject({ verified: true, line: 11 })
  })

  it('demotes a quote that is not there, in another file, too short, or on unchanged code away from the change', () => {
    expect(one({ file: 'src/api.py', severity: 'important', issue: 'does not sort by id', quote: 'ORDER BY created_at' }))
      .toMatchObject({ verified: false, severity: 'suggestion', unverified: 'its quote is not in the diff of src/api.py' })
    expect(one({ file: 'src/other.py', severity: 'important', issue: 'x', quote: '410: {"model": ErrorOut},' })).toMatchObject({ unverified: 'src/other.py is not in the diff' })
    expect(one({ file: 'src/api.py', severity: 'important', issue: 'x', quote: '410' })).toMatchObject({ verified: false })
    // A short quote counts only as a whole line, never as a part of one.
    expect(one({ file: 'src/api.py', severity: 'important', issue: 'x', quote: '}' })).toMatchObject({ verified: true, line: 14 })
    expect(one({ file: 'src/api.py', severity: 'important', issue: 'x', quote: 'model' })).toMatchObject({ verified: false })
    expect(one({ file: 'src/api.py', severity: 'important', issue: 'x', quote: 'return None' })).toMatchObject({ unverified: 'its quote is unchanged code, away from the change' })
    expect(one({ severity: 'important', issue: 'x' })).toMatchObject({ unverified: 'it gives no evidence' })
  })

  it('verifies an omission by a quote of the plan or a follow-up and a token the change lacks', () => {
    expect(one({ severity: 'important', issue: 'no limit=100 test', planQuote: 'limit=100 is accepted', absent: 'limit=100' })).toMatchObject({ verified: true })
    // Punctuation counts in the change: a bound written as `1 <= limit <= 100` is no `limit=100` test (trial eval, 2026-11-14).
    const bounded = annotatePatch(['diff --git a/src/q.py b/src/q.py', '--- a/src/q.py', '+++ b/src/q.py', '@@ -0,0 +1 @@', '+    if not 1 <= limit <= 100:'].join('\n'))
    expect(settle(ReviewVerdictSchema.parse({ summary: '', verdict: 'changes', findings: [{ severity: 'important', issue: 'no limit=100 test', planQuote: 'limit=100 is accepted',
      absent: 'limit=100' }] }), { annotated: bounded, plan: PLAN }).findings[0]).toMatchObject({ verified: true })
    expect(one({ severity: 'important', issue: 'no handling', planQuote: 'return 410 for expired codes', absent: 'expired codes' })).toMatchObject({ verified: true })
    // A token the quote and the issue do not name is not the omission's.
    expect(one({ severity: 'important', issue: 'no 410', planQuote: 'return 410 for expired codes', absent: 'xyzzy' }))
      .toMatchObject({ verified: false, unverified: '"xyzzy" is not what its plan quote or issue names' })
    // The token is in the change, so the claim is false; the quote is not the plan's; no token at all.
    expect(one({ severity: 'important', issue: 'no 410', planQuote: 'return 410 for expired codes', absent: '410' })).toMatchObject({ verified: false, unverified: '"410" is in the change' })
    expect(one({ severity: 'important', issue: 'x', planQuote: 'the plan says sorting by id', absent: 'id DESC' })).toMatchObject({ unverified: 'its plan quote is not in the plan or a follow-up' })
    expect(one({ severity: 'important', issue: 'x', planQuote: 'limit=100 is accepted' })).toMatchObject({ unverified: 'it names no token the change lacks' })
  })
})

describe('settling and what each reader gets', () => {
  it('maps the old answer shape, settles "changes" with no blocking finding as a pass, and never raises a pass', () => {
    expect(one({ file: 'src/api.py', issue: 'old shape', blocking: false })).toMatchObject({ severity: 'suggestion' })
    expect(one({ file: 'src/api.py', issue: 'old shape', quote: '410: {"model": ErrorOut},' })).toMatchObject({ severity: 'important', verified: true })
    expect(review({ verdict: 'changes', findings: [{ severity: 'important', issue: 'a doubt', quote: 'not in the diff at all' }] }).verdict).toBe('pass')
    expect(review({ verdict: 'pass', findings: [{ file: 'src/api.py', severity: 'important', issue: 'x', quote: '410: {"model": ErrorOut},' }] }).verdict).toBe('pass')
    expect(review({ verdict: 'changes', findings: [{ file: 'src/api.py', severity: 'important', issue: 'x', quote: '410: {"model": ErrorOut},' }] }).verdict).toBe('changes')
  })

  it('gives the engineer only the blocking findings, and people the notes, the weak tests and the unaudited ones', () => {
    const settled = review({ verdict: 'changes', tests: [{ file: 'tests/test_api.py', name: 'test_defaults_to_twenty', claims: 'the cap of 20', verdict: 'does_not', why: 'makes 3' }],
      findings: [
        { file: 'tests/test_api.py', severity: 'important', issue: 'never reaches the cap', quote: 'assert len(client.get("/codes").json()) == 3' },
        { severity: 'important', issue: 'sorts wrong', quote: 'ORDER BY x', file: 'src/api.py' },
        { severity: 'nit', issue: 'rename it' }] })
    expect(settled.findings.filter(blocking)).toHaveLength(1)
    expect(reviewEvidence(settled)).toBe('review: changes\n1. [important] tests/test_api.py:3: never reaches the cap')
    expect(reviewNotes(settled).split('\n')).toEqual([
      '- (summary) s',
      '- (unverified important: its quote is not in the diff of src/api.py) src/api.py: sorts wrong',
      '- (nit) rename it',
      '- (test does not test its claim) tests/test_api.py test_defaults_to_twenty: makes 3'])
    // A changed test file the audit skipped is said so.
    expect(review({ verdict: 'pass', findings: [] }).unaudited).toEqual(['tests/test_api.py'])
    expect(reviewNotes(review({ verdict: 'pass', findings: [] }))).toBe('- (test not audited) tests/test_api.py')
  })
})

describe('the review of P16 (2026-11-14)', () => {
  const DELETION = annotatePatch(['diff --git a/src/user.ts b/src/user.ts', '--- a/src/user.ts', '+++ b/src/user.ts', '@@ -1,4 +1,3 @@',
    ' export function name(id: string) {', '   const user = find(id)', '-  if (!user) return null', '   return user.name', ' }'].join('\n'))
  const at = (finding: Record<string, unknown>, plan = PLAN, followUps: string[] = []) =>
    settle(ReviewVerdictSchema.parse({ summary: 's', verdict: 'changes', findings: [finding] }), { annotated: DELETION, plan, followUps, files: ['src/user.ts'] }).findings[0]!

  it('verifies a quote of unchanged code beside a deletion, on the new side', () => {
    expect(at({ file: 'src/user.ts', severity: 'critical', issue: 'user.name on null', quote: 'return user.name' })).toMatchObject({ verified: true, side: 'new', line: 3 })
  })

  it('falls back to the plan quote when a quote fails, and rejects a false omission and a stray token', () => {
    expect(at({ file: 'src/user.ts', severity: 'important', issue: 'no 404 test', quote: 'nothing like this', planQuote: 'a test for the 404 of an unknown user',
      absent: '404' }, 'Tests: a test for the 404 of an unknown user.')).toMatchObject({ verified: true })
    // Whitespace and punctuation do not hide a token that is there.
    expect(at({ severity: 'important', issue: 'no name check', planQuote: 'return the user name when found', absent: 'user . name' }, 'Plan: return the user name when found.'))
      .toMatchObject({ verified: false, unverified: '"user . name" is in the change' })
  })

  it('matches a plan quote copied from a follow-up the model saw JSON-escaped, and from a plan with markdown', () => {
    expect(at({ severity: 'important', issue: 'no "x" header', planQuote: 'add the \\"x\\" header', absent: 'x header' }, '', ['please add the "x" header']))
      .toMatchObject({ verified: true })
    expect(at({ severity: 'important', issue: 'no cache', planQuote: 'cache the user', absent: 'cache' }, 'Plan: **cache** the `user`.')).toMatchObject({ verified: true })
  })

  it('splits a quote at "…" or a spaced "...", never inside code', () => {
    expect(at({ file: 'src/user.ts', severity: 'important', issue: 'x', quote: 'const user = find(id) … return user.name' })).toMatchObject({ verified: true })
  })
})

