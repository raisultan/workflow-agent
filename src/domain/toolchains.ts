/**
 * Toolchain resolution (`T11.3`, `D10` decision 2): the toolchain versions a repository pins, read by the host itself from
 * `mise.toml` (its `[tools]` table only), `.tool-versions`, `.python-version` and `.nvmrc`, plus the repository profile's defaults
 * for tools it does not pin. Nothing here runs anything: `mise` is never pointed at the repository (it runs configuration it can
 * see, `T11.0`), so only the tool names and versions read here reach the setup step.
 *
 * - **Allowed tools only** (`TOOLCHAIN_TOOLS`, DESIGN §5.5). Any other tool is left out and noted, as is a backend-qualified name
 *   (`"aqua:astral-sh/uv"`): only a short name chooses a tool, and the host chooses its backend.
 * - **Plain versions only**: digits and dots, with an optional leading `v`. An allowed tool pinned any other way (`lts/*`, `latest`,
 *   `system`, a range, a path, an inline table with hooks) is an error, not a guess: the setup step blocks with the reason.
 * - **Precedence**, per tool: `mise.toml`, then `.tool-versions`, then `.python-version` or `.nvmrc`, then the profile's default.
 * - **`mise.toml`** is read by a strict line reader that understands only what `[tools]` needs: table headers, `key = "string"`
 *   pairs, comments and multi-line strings (followed so that text inside one is never read as a header). An allowed tool declared
 *   in any other form (an array, an inline table, a `[tools.node]` table, a dotted `tools.node` key) is an error.
 */
import { PLAIN_VERSION, TOOLCHAIN_TOOLS } from './repositories.ts'

export type ToolName = (typeof TOOLCHAIN_TOOLS)[number]
/** The repository files read, in order of precedence. */
export const TOOLCHAIN_FILES = ['mise.toml', '.tool-versions', '.python-version', '.nvmrc'] as const
export type ToolchainFile = (typeof TOOLCHAIN_FILES)[number]

export interface ResolvedTool {
  readonly tool: ToolName
  /** The version as pinned, without a leading `v`; a prefix (`3.12`) is resolved to an exact version by the install. */
  readonly version: string
  readonly from: ToolchainFile | 'profile'
}
export interface ToolchainResolution {
  readonly tools: readonly ResolvedTool[]
  /** What was left out, and why (another tool, a backend-qualified name). */
  readonly ignored: readonly string[]
  /** Pins that cannot be honoured; any error blocks the setup step. */
  readonly errors: readonly string[]
}

const ALLOWED = new Set<string>(TOOLCHAIN_TOOLS)
/** `.tool-versions` uses asdf's plugin names. */
const ALIASES: Readonly<Record<string, ToolName>> = { nodejs: 'node', golang: 'go' }

/** A value from a repository file, shown in a message: printable ASCII only, and short. */
export function shown(value: string): string {
  const clean = value.replace(/[^\x20-\x7e]/gu, '?')
  return JSON.stringify(clean.length > 40 ? `${clean.slice(0, 40)}…` : clean)
}

const versionOf = (raw: string): string | undefined => PLAIN_VERSION.test(raw) ? raw.replace(/^v/u, '') : undefined

interface Pins { tools: Map<ToolName, string>; ignored: string[]; errors: string[] }
const empty = (): Pins => ({ tools: new Map(), ignored: [], errors: [] })

function pin(pins: Pins, file: string, name: string, raw: string): void {
  const tool = (ALIASES[name] ?? name) as ToolName
  if (!ALLOWED.has(tool)) { pins.ignored.push(`${file}: ${shown(name)} is not an allowed tool`); return }
  const version = versionOf(raw)
  if (version === undefined) { pins.errors.push(`${file}: ${tool} is pinned to ${shown(raw)}, which is not a plain version (such as 3.12 or 22.12.0)`); return }
  if (!pins.tools.has(tool)) pins.tools.set(tool, version)
}

/** Reads the `[tools]` table of a `mise.toml`. */
export function readMiseToml(text: string, file = 'mise.toml'): Pins {
  const pins = empty()
  const fail = (line: number, message: string) => { pins.errors.push(`${file} line ${line}: ${message}`) }
  let table: string | undefined
  let open: '"""' | "'''" | undefined
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index++) {
    const number = index + 1
    let line = lines[index]!
    if (open) {
      const end = line.indexOf(open)
      if (end === -1) continue
      line = line.slice(end + 3)
      open = undefined
    }
    const content = stripComment(line).trim()
    if (content === '') continue
    // A multi-line string opens on this line and does not close on it.
    const multi = /("""|''')/u.exec(content)
    if (multi && content.split(multi[1]!).length % 2 === 0) open = multi[1] as '"""' | "'''"
    const header = /^\[\[?\s*([^\]]*?)\s*\]\]?$/u.exec(content)
    if (header && !multi) {
      table = header[1]!.replace(/\s+/gu, '').replace(/["']/gu, '')
      const [first, second] = table.split('.')
      if (first === 'tools' && second !== undefined && ALLOWED.has(ALIASES[second] ?? second)) fail(number, `[${table}]: declare ${second} as ${second} = "<version>" under [tools]`)
      continue
    }
    const pair = /^("([^"\\]*)"|'([^']*)'|[A-Za-z0-9_.:/-]+)\s*=\s*(.*)$/u.exec(content)
    if (!pair) { if (table === 'tools') fail(number, `cannot read ${shown(content)}`); continue }
    const key = pair[2] ?? pair[3] ?? pair[1]!
    const value = pair[4]!
    // A dotted key at the root, such as tools.node = "22", is a [tools] entry too.
    const dotted = table === undefined && key.startsWith('tools.') ? key.slice('tools.'.length) : undefined
    if (table !== 'tools' && dotted === undefined) continue
    const name = dotted ?? key
    const head = name.split('.')[0]!
    if (name.includes('.') && ALLOWED.has(ALIASES[head] ?? head)) { fail(number, `${head} must be declared as ${head} = "<version>"`); continue }
    if (name.includes(':') || name.includes('/')) { pins.ignored.push(`${file}: ${shown(name)} names a backend; only a tool's short name is read`); continue }
    const string = /^"([^"\\]*)"$|^'([^']*)'$/u.exec(value)
    if (!string) {
      if (ALLOWED.has(ALIASES[name] ?? name)) fail(number, `${name} must be a plain version string, not ${shown(value)}`)
      else pins.ignored.push(`${file}: ${shown(name)} is not an allowed tool`)
      continue
    }
    pin(pins, file, name, string[1] ?? string[2]!)
  }
  if (open) fail(lines.length, 'a multi-line string is not closed')
  return pins
}

/** The text before a `#` that is not inside a string. */
function stripComment(line: string): string {
  let quote: string | undefined
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (quote) { if (char === '\\' && quote === '"') index++; else if (char === quote) quote = undefined }
    else if (char === '"' || char === "'") quote = char
    else if (char === '#') return line.slice(0, index)
  }
  return line
}

/** Reads `.tool-versions`: `<tool> <version> [fallbacks…]` per line; the first version counts. */
export function readToolVersions(text: string): Pins {
  const pins = empty()
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, '').trim()
    if (line === '') continue
    const [name, version] = line.split(/\s+/u)
    if (version === undefined) { pins.errors.push(`.tool-versions: ${shown(line)} names no version`); continue }
    pin(pins, '.tool-versions', name!, version)
  }
  return pins
}

/** Reads a one-version file (`.python-version`, `.nvmrc`): its first line that is not a comment. */
export function readVersionFile(text: string, file: '.python-version' | '.nvmrc'): Pins {
  const pins = empty()
  const first = text.split(/\r?\n/u).map(line => line.replace(/#.*$/u, '').trim()).find(line => line !== '')
  if (first !== undefined) pin(pins, file, file === '.nvmrc' ? 'node' : 'python', first)
  return pins
}

/**
 * The toolchains of a job: the repository's pins, by precedence, then the profile's defaults for tools it does not pin. `files` holds
 * the text of the files that exist (the reader refuses links and large files before this runs).
 */
export function resolveToolchains(files: Partial<Record<ToolchainFile, string>>, defaults: Partial<Record<ToolName, string>> = {}): ToolchainResolution {
  const sources: [ToolchainFile, Pins][] = []
  if (files['mise.toml'] !== undefined) sources.push(['mise.toml', readMiseToml(files['mise.toml'])])
  if (files['.tool-versions'] !== undefined) sources.push(['.tool-versions', readToolVersions(files['.tool-versions'])])
  if (files['.python-version'] !== undefined) sources.push(['.python-version', readVersionFile(files['.python-version'], '.python-version')])
  if (files['.nvmrc'] !== undefined) sources.push(['.nvmrc', readVersionFile(files['.nvmrc'], '.nvmrc')])
  const tools: ResolvedTool[] = []
  for (const [from, pins] of sources) {
    for (const [tool, version] of pins.tools) if (!tools.some(entry => entry.tool === tool)) tools.push({ tool, version, from })
  }
  for (const tool of TOOLCHAIN_TOOLS) {
    const version = defaults[tool]
    if (version !== undefined && !tools.some(entry => entry.tool === tool)) tools.push({ tool, version: version.replace(/^v/u, ''), from: 'profile' })
  }
  tools.sort((a, b) => TOOLCHAIN_TOOLS.indexOf(a.tool) - TOOLCHAIN_TOOLS.indexOf(b.tool))
  return { tools, ignored: sources.flatMap(([, pins]) => pins.ignored), errors: sources.flatMap(([, pins]) => pins.errors) }
}
