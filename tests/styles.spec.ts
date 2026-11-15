/** The dashboard's stylesheet (`D13`): every class it styles is used by a component, and it keeps one rule per line, each selector once. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const dir = join(process.cwd(), 'src/client')
const css = readFileSync(join(dir, 'app.css'), 'utf8')
const code = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(name => /\.tsx?$/.test(name)).map(name => readFileSync(join(dir, name), 'utf8')).join('\n')

it('styles only classes a component uses', () => {
  // A template literal like `k-${tone}` uses every class with that prefix.
  const prefixes = [...code.matchAll(/([a-z][\w-]*-)\$\{/g)].map(match => match[1]!)
  const used = (name: string) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(code) || prefixes.some(prefix => name.startsWith(prefix))
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)|format\([^)]*\)/g, '')
  const classes = new Set([...stripped.matchAll(/\.([a-z][\w-]*)/g)].map(match => match[1]!))
  expect(classes.size).toBeGreaterThan(50)
  expect([...classes].filter(name => !used(name))).toEqual([])
})

it('writes one rule per line, each selector once within its block', () => {
  const blocks: string[][] = [[]]
  for (const line of css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(text => text.trim()).filter(Boolean)) {
    if (line === '}') { blocks.pop(); continue }
    if (/^@(media|container|supports)\b.*\{$/.test(line)) { blocks.push([]); continue }
    // A rule, or a keyframes rule with its steps, opens and closes on its line.
    expect(line).toMatch(/^[^{}]+\{[^{}]*\}$|^@keyframes [\w-]+ \{( [^{}]+ \{[^{}]*\})+ \}$/)
    if (line.startsWith('@')) continue
    const selector = line.slice(0, line.indexOf('{')).trim()
    expect(blocks.at(-1)).not.toContain(selector)
    blocks.at(-1)!.push(selector)
  }
})

it('defines every colour on :root for light, and again for dark both ways (system and the switch)', () => {
  const tokens = (selector: string) => new Set([...(css.split('\n').find(line => line.trim().startsWith(selector)) ?? '').matchAll(/(--[\w-]+):/g)].map(match => match[1]!))
  const light = tokens(':root {'), system = tokens(":root:not([data-theme='light'])"), dark = tokens(":root[data-theme='dark']")
  const colours = [...light].filter(name => !name.startsWith('--f-'))
  expect(colours.length).toBeGreaterThan(30)
  expect(colours.filter(name => !system.has(name))).toEqual([])
  expect(colours.filter(name => !dark.has(name))).toEqual([])
})
