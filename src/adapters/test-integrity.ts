/**
 * Test-integrity rules (`T10.1`, `A14`): what in a diff counts as weakening the tests instead of making them pass. The rules are
 * deliberately plain, so a flag can be explained by naming the rule and quoting the lines. They cover JavaScript/TypeScript and
 * Python first; other languages get the file-level rules (deleted test files, changed test configuration) only.
 *
 * | Rule | Flags |
 * | --- | --- |
 * | `deleted-test` | a test file deleted, or renamed to a path that is not a test file |
 * | `removed-test` | a test file that declares fewer test cases than before (`it(`, `test(`, `describe(`, `def test_`, `class Test…`) |
 * | `skip-marker` | an added line that skips or focuses tests: `.skip`, `.only`, `xit`/`xdescribe`/`xtest`, `.todo`, `pytest.mark.skip`/`skipif`/`xfail` (as a decorator, in `pytestmark` or in `marks=`), `pytest.skip(`, `pytest.xfail(`, `unittest.skip`, `skipTest(` |
 * | `weakened-assertion` | a test file with fewer assertions than before, or one that trades exact matchers (`toBe`, `toEqual`, `assertEqual`, `==`) for loose ones (`toBeTruthy`, `toBeDefined`, `assertTrue`, `is not None`), or that adds an always-true assertion (`expect(true)`, `assert True`) |
 * | `test-config` | a changed test runner, coverage or CI configuration: `jest`/`vitest`/`vite`/`karma`/`mocha`/`playwright`/`cypress`/`nyc`/`c8` configuration files, `.coveragerc`, `pytest.ini`, `tox.ini`, `noxfile.py`, `.gitlab-ci.yml` and `.gitlab/ci/*.yml`; in `setup.cfg`, `pyproject.toml` and `package.json`, changed lines about tests or coverage (`pytest`, `coverage`, `fail_under`, `addopts`, the `test` script and its `pretest`/`posttest` hooks, `jest`, `vitest`, `c8`, `nyc`, `threshold`), but not a dependency's version line, nor a `test` script that only adds test files; in `conftest.py`, collection hooks, ignores and skips (a new fixture is fine) |
 * | `binary-code` | a test file, test configuration or source file that git calls binary (a NUL byte is enough): a reader that skips binary files would not see its lines, so it is never trusted (the diff itself is taken as text) |
 * | `untested-change` | more than `UNTESTED_LINES` changed lines in source files, and no test file added or changed, unless the approved plan says no tests are needed and why (`tests: "none: <reason>"`) |
 */
import type { DiffFile } from './work-diff.ts'

/** Changed source lines above which a change needs a test change (or a plan that says why not). */
export const UNTESTED_LINES = 30

export type IntegrityRule = 'deleted-test' | 'removed-test' | 'skip-marker' | 'weakened-assertion' | 'test-config' | 'untested-change' | 'binary-code'
export interface IntegrityFinding {
  readonly rule: IntegrityRule
  readonly file: string
  /** What the rule found, in one line. */
  readonly detail: string
  /** The lines that show it, as `+12 text` (added, new line number) or `-12 text` (removed, old line number). */
  readonly lines: readonly string[]
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|java|kt|rb|rs|cs|php|swift|scala|c|cc|cpp|h|hpp)$/iu
// Every test pattern ends in a code file's extension: a fixture, a snapshot or a data file under `tests/` is not a test.
const JS_TEST = /(?:^|\/)(?:__tests__|__mocks__)\/(?:.*\/)?[^/]+\.[cm]?[jt]sx?$|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|spec|e2e)\/.*\.[cm]?[jt]sx?$/iu
const PY_TEST = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$|(?:^|\/)tests?\/.*\.py$|(?:^|\/)conftest\.py$/iu
const OTHER_TEST = /(?:^|\/)(?:tests?|spec)\/.*\.(?:go|java|kt|rb|rs|cs|php|swift|scala)$|_test\.go$|Test\.(?:java|kt)$|_spec\.rb$/u
/** A word a test script may gain: a plain relative path of a test file (no shell syntax, no `..`). */
const TEST_PATH_WORD = /^(?:\.\/)?(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/u
const CONFIG = /(?:^|\/)(?:(?:jest|vitest|vite|karma|playwright|cypress|nyc|ava|wdio)\.config\.[cm]?[jt]s|vitest\.workspace\.[cm]?[jt]s|karma\.conf\.[cm]?js|\.mocharc(?:\.[a-z]+)?|\.nycrc(?:\.[a-z]+)?|\.c8rc(?:\.[a-z]+)?|jest\.config\.json|\.coveragerc|pytest\.ini|tox\.ini|noxfile\.py|codecov\.ya?ml|\.codecov\.ya?ml|(?:[\w.-]*\.)?gitlab-ci\.ya?ml|\.gitlab\/ci\/.*\.ya?ml)$/iu
const MIXED_CONFIG = /(?:^|\/)(?:setup\.cfg|pyproject\.toml|package\.json)$/iu
const MIXED_CONFIG_LINE = /pytest|coverage|cov-|fail_under|addopts|testpaths|"(?:pre|post)?test[":]|\bjest\b|\bvitest\b|\bc8\b|\bnyc\b|threshold|--passWithNoTests|python_files|omit/iu
/**
 * A dependency's version line (`"vitest": "^4.1.8"`, `pytest>=8.2`, `pytest = "^8"`): a version bump of a test tool is not a change
 * to how tests run.
 */
const DEPENDENCY_LINE = /^\s*(?:"[@\w./-]+"\s*:\s*"[~^<>=]*\d[\w.+-]*"|["']?[\w.-]+(?:\[[\w,.-]+\])?\s*(?:==|>=|<=|~=|!=|>|<)\s*[\w.*+-]+(?:\s*,\s*(?:==|>=|<=|~=|!=|>|<)\s*[\w.*+-]+)*["']?|[\w.-]+\s*=\s*["'][~^<>=!]*\d[\w.*+-]*["'])\s*,?\s*$/u
/** What in a `conftest.py` changes which tests run, beyond fixtures: collection hooks and ignores, and skips applied from there. */
const CONFTEST_LINE = /collect_ignore|pytest_collection_modifyitems|pytest_ignore_collect|pytest_runtest_setup|add_marker|pytest\.skip|pytest\.xfail|addopts/u

export const isTestFile = (path: string): boolean => JS_TEST.test(path) || PY_TEST.test(path) || OTHER_TEST.test(path)
export const isTestConfig = (path: string): boolean => CONFIG.test(path)
export const isSource = (path: string): boolean => SOURCE.test(path) && !isTestFile(path) && !isTestConfig(path)

const CASE = /^\s*(?:[xf]?(?:it|test|describe|context|suite|specify)(?:\.\w+(?:\([^)]*\))?)*\s*[(`]|(?:async\s+)?def\s+test_|class\s+Test\w*\s*[(:])/u
const SKIP = /(?:\b(?:it|test|describe|context|suite)\.(?:skip|only|todo|skipIf|runIf)\b|\b[xf](?:it|describe|test)\s*\(|\bpytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.skip|\bunittest\.skip|\bskipTest\s*\(|@skip\b)/u
const ASSERT = /\bexpect\s*\(|\bassert\b|\bassert[A-Z]\w*\s*\(|\.should\b|\bt\.(?:is|deepEqual|true|false|throws)\s*\(/u
const STRICT = /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toThrow|toHaveBeenCalledWith|toContain)\s*\(|assert(?:Equal|Equals|In|Raises|IsNone|CountEqual|DictEqual)\s*\(|\bassert\b[^#\n]*(?:==|!=|\bin\b|\bis None\b)/u
const LOOSE = /\.(?:toBeTruthy|toBeDefined|toBeFalsy)\s*\(\s*\)|\.not\.toBe(?:Null|Undefined)\s*\(\s*\)|assert(?:True|IsNotNone)\s*\(|\bassert\b[^#\n]*\bis not None\b/u
const ALWAYS = /\bexpect\s*\(\s*(?:true|1|'[^']*'|"[^"]*")\s*\)\s*\.(?:toBe|toEqual|toBeTruthy)\s*\(\s*(?:true|1|'[^']*'|"[^"]*")?\s*\)|\bassert\s+(?:True|1)\b|assertTrue\s*\(\s*True\s*\)/u

const show = (sign: '+' | '-') => (entry: { line: number; text: string }) => `${sign}${entry.line} ${entry.text.trim().slice(0, 200)}`
const count = (lines: readonly { text: string }[], pattern: RegExp) => lines.filter(entry => pattern.test(entry.text)).length

/** The findings of every rule on a diff; `plannedTests` is the approved plan's `tests` field. */
export function integrityFindings(files: readonly DiffFile[], plannedTests?: string, context: { readonly tree?: ReadonlySet<string> } = {}): IntegrityFinding[] {
  const known = new Set([...files.filter(file => file.status !== 'deleted').map(file => file.path), ...context.tree ?? []])
  const findings: IntegrityFinding[] = []
  for (const file of files) {
    if (file.binary && file.status !== 'deleted' && (isTestFile(file.path) || isTestConfig(file.path) || isSource(file.path))) {
      findings.push({ rule: 'binary-code', file: file.path, detail: 'a code file is binary (it holds a NUL byte); code must be plain text to be checked', lines: [] })
    }
    const wasTest = isTestFile(file.from ?? file.path)
    if (file.status === 'deleted' && isTestFile(file.path)) {
      findings.push({ rule: 'deleted-test', file: file.path, detail: 'a test file was deleted', lines: [] })
      continue
    }
    if (file.status === 'renamed' && wasTest && !isTestFile(file.path)) {
      findings.push({ rule: 'deleted-test', file: file.from!, detail: `a test file was renamed to ${file.path}, which is not run as a test`, lines: [] })
    }
    if (isTestConfig(file.path) || (file.from && isTestConfig(file.from))) {
      findings.push({ rule: 'test-config', file: file.path, detail: 'the test or coverage configuration changed',
        lines: [...file.removed.map(show('-')), ...file.added.map(show('+'))].slice(0, 8) })
    } else if (MIXED_CONFIG.test(file.path)) {
      const extended = extendedTestScripts(file, known)
      const counts = (entry: { line: number; text: string }) => MIXED_CONFIG_LINE.test(entry.text) && !extended.has(entry) && !DEPENDENCY_LINE.test(entry.text)
      const removed = file.removed.filter(counts), added = file.added.filter(counts)
      if (removed.length + added.length > 0) {
        findings.push({ rule: 'test-config', file: file.path, detail: 'lines about tests or coverage changed', lines: [...removed.map(show('-')), ...added.map(show('+'))].slice(0, 8) })
      }
    }
    if (/(?:^|\/)conftest\.py$/u.test(file.path)) {
      // A new fixture weakens nothing; a collection hook, an ignore or a skip applied from conftest does.
      const hooks = [...file.removed.filter(entry => CONFTEST_LINE.test(entry.text)).map(show('-')), ...file.added.filter(entry => CONFTEST_LINE.test(entry.text)).map(show('+'))]
      if (hooks.length > 0) findings.push({ rule: 'test-config', file: file.path, detail: 'conftest.py changes which tests are collected or run', lines: hooks.slice(0, 8) })
    }
    if (!isTestFile(file.path)) continue
    const skips = file.added.filter(entry => SKIP.test(entry.text))
    if (skips.length > 0) findings.push({ rule: 'skip-marker', file: file.path, detail: 'tests are skipped or focused', lines: skips.map(show('+')).slice(0, 8) })
    const casesRemoved = count(file.removed, CASE), casesAdded = count(file.added, CASE)
    if (casesRemoved > casesAdded) {
      findings.push({ rule: 'removed-test', file: file.path, detail: `${casesRemoved - casesAdded} test case(s) removed`,
        lines: file.removed.filter(entry => CASE.test(entry.text)).map(show('-')).slice(0, 8) })
    }
    const assertsRemoved = count(file.removed, ASSERT), assertsAdded = count(file.added, ASSERT)
    const strictRemoved = count(file.removed, STRICT), strictAdded = count(file.added, STRICT)
    const looseRemoved = count(file.removed, LOOSE), looseAdded = count(file.added, LOOSE)
    const always = file.added.filter(entry => ALWAYS.test(entry.text))
    if (assertsRemoved > assertsAdded) {
      findings.push({ rule: 'weakened-assertion', file: file.path, detail: `${assertsRemoved - assertsAdded} assertion(s) removed`,
        lines: file.removed.filter(entry => ASSERT.test(entry.text)).map(show('-')).slice(0, 8) })
    } else if (strictRemoved > strictAdded && looseAdded > looseRemoved) {
      findings.push({ rule: 'weakened-assertion', file: file.path, detail: 'exact assertions were replaced by loose ones',
        lines: [...file.removed.filter(entry => STRICT.test(entry.text)).map(show('-')), ...file.added.filter(entry => LOOSE.test(entry.text)).map(show('+'))].slice(0, 8) })
    }
    if (always.length > 0) findings.push({ rule: 'weakened-assertion', file: file.path, detail: 'an assertion that is always true was added', lines: always.map(show('+')).slice(0, 8) })
  }
  const sources = files.filter(file => isSource(file.path))
  const changed = sources.reduce((sum, file) => sum + file.added.length + file.removed.length, 0)
  const testsChanged = files.some(file => isTestFile(file.path) && file.status !== 'deleted')
  if (changed > UNTESTED_LINES && !testsChanged && !noTestsNeeded(plannedTests)) {
    findings.push({ rule: 'untested-change', file: sources.map(file => file.path).slice(0, 5).join(', '),
      detail: `${changed} source lines changed and no test was added or changed; the approved plan ${plannedTests?.trim() ? `says: "${plannedTests.trim().slice(0, 200)}"` : 'names no tests'}`,
      lines: [] })
  }
  return findings
}

/**
 * The `package.json` script lines whose change only adds test files: a `"test…"` script whose new command keeps every word of the
 * old one and adds only paths of test files (`"test": "node --test a.test.ts"` → `"… a.test.ts b.test.ts"`). Running more tests
 * weakens nothing, and an approved plan may ask for it (found in the `G10` live run). Each added word must be a plain path (no
 * shell syntax), a test file by its full name, and a file the work has (in the diff or the tree). Anything else still counts.
 */
function extendedTestScripts(file: DiffFile, known: ReadonlySet<string>): Set<{ line: number; text: string }> {
  const script = /^\s*"(test[^"]*)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/u
  const words = (command: string) => command.trim().split(/\s+/u)
  const ok = new Set<{ line: number; text: string }>()
  if (!/(?:^|\/)package\.json$/u.test(file.path)) return ok
  for (const before of file.removed) {
    const old = script.exec(before.text)
    if (!old) continue
    const after = file.added.find(entry => script.exec(entry.text)?.[1] === old[1])
    const now = after && script.exec(after.text)
    if (!after || !now) continue
    const oldWords = words(old[2]!), newWords = words(now[2]!)
    const extra = [...newWords]
    for (const word of oldWords) {
      const index = extra.indexOf(word)
      if (index === -1) { extra.length = 0; extra.push('\0missing'); break }
      extra.splice(index, 1)
    }
    const testFile = (word: string) => TEST_PATH_WORD.test(word) && isTestFile(word.replace(/^\.\//u, '')) && known.has(word.replace(/^\.\//u, ''))
    if (extra.length > 0 && extra.every(testFile)) { ok.add(before); ok.add(after) }
  }
  return ok
}

/** A rule the approved plan exempts, for one file or for all, and why. */
export interface PlanExemption { readonly rule: IntegrityRule; readonly file?: string; readonly reason: string }
const EXEMPTABLE: ReadonlySet<string> = new Set<IntegrityRule>(['deleted-test', 'removed-test', 'skip-marker', 'weakened-assertion', 'test-config', 'untested-change'])

/**
 * The exemptions an approved plan states in its `tests` field, one per line: `exempt <rule> [<path>]: <reason>` (or
 * `исключение <rule> [<path>]: <причина>`). The approver sees the field in the approval post, so an exemption is approved with the
 * plan. A reason is required; `binary-code` cannot be exempted.
 */
export function planExemptions(plannedTests: string | undefined): PlanExemption[] {
  return [...(plannedTests ?? '').matchAll(/^\s*(?:exempt|исключение)\s+([a-z-]+)(?:\s+([^\s:]+))?\s*:\s*(\S.*)$/gimu)]
    .filter(match => EXEMPTABLE.has(match[1]!.toLowerCase()))
    // A plan may write the path as the format shows it, in brackets or backticks: the path is what is inside.
    .map(match => ({ rule: match[1]!.toLowerCase() as IntegrityRule, file: match[2]?.replace(/^[[`]+|[\]`]+$/gu, ''), reason: match[3]!.trim() }))
    .map(({ file, ...exemption }) => ({ ...exemption, ...file ? { file } : {} }))
}

/** Splits findings into those that stand and those the approved plan exempts. */
export function applyExemptions(findings: readonly IntegrityFinding[], exemptions: readonly PlanExemption[]):
  { kept: IntegrityFinding[]; exempted: { finding: IntegrityFinding; reason: string }[] } {
  const kept: IntegrityFinding[] = [], exempted: { finding: IntegrityFinding; reason: string }[] = []
  for (const finding of findings) {
    const exemption = exemptions.find(entry => entry.rule === finding.rule && (!entry.file || entry.file === finding.file))
    if (exemption) exempted.push({ finding, reason: exemption.reason })
    else kept.push(finding)
  }
  return { kept, exempted }
}

/** Whether the approved plan says no tests are needed, and gives a reason: `none: <reason>` (or `нет: <причина>`). */
export function noTestsNeeded(plannedTests: string | undefined): boolean {
  return /^\s*(?:none|нет|не нужны)\s*[:—–-]\s*\S/iu.test(plannedTests ?? '')
}

/** The findings as evidence: one block per finding, rule first. */
export function integrityEvidence(findings: readonly IntegrityFinding[]): string {
  return findings.map(finding => [`${finding.rule}: ${finding.file}: ${finding.detail}`, ...finding.lines.map(line => `  ${line}`)].join('\n')).join('\n')
}
