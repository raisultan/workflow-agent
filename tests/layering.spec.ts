/**
 * The kernel's and the domain's layering: `src/kernel/` imports only `node:*`, `zod` and itself; `src/domain/` imports
 * only the kernel, `zod` and itself. Both read time and chance only through the kernel's `env.ts`, and use no constructor
 * parameter properties.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const KERNEL = join(SRC, 'kernel')
const DOMAIN = join(SRC, 'domain')
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

const sources = (dir: string) => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(path => /\.tsx?$/.test(path))
/** Whether the relative import `specifier` in `dir/path` resolves to a file inside one of `roots`. */
const resolvesInto = (dir: string, path: string, specifier: string, roots: readonly string[]) => specifier.startsWith('.')
  && roots.some(root => !relative(root, resolve(dir, dirname(path), specifier)).startsWith('..'))

const layers = [
  { name: 'kernel', dir: KERNEL, allowed: (path: string, specifier: string) => specifier.startsWith('node:') || specifier === 'zod'
    || resolvesInto(KERNEL, path, specifier, [KERNEL]) },
  { name: 'domain', dir: DOMAIN, allowed: (path: string, specifier: string) => specifier === 'zod'
    || resolvesInto(DOMAIN, path, specifier, [DOMAIN, KERNEL]) },
]

describe.each(layers)('src/$name', ({ name, dir, allowed }) => {
  const files = sources(dir)
  const read = (path: string) => readFileSync(join(dir, path), 'utf8')

  it(`imports only what the ${name} layer may`, () => {
    expect(files.length).toBeGreaterThan(0)
    const outside = files.flatMap(path => [...read(path).matchAll(IMPORT)].flatMap(match => {
      const specifier = match[1] ?? match[2] ?? match[3]!
      if (allowed(path, specifier)) return []
      return [`src/${name}/${path} imports ${specifier}`]
    }))
    expect(outside).toEqual([])
  })

  it('reads the clock and random numbers only through the kernel\'s env.ts', () => {
    const direct = files.filter(path => !(name === 'kernel' && path === 'env.ts'))
      .filter(path => /\bDate\.now\s*\(|\bMath\.random\s*\(|\bnew Date\s*\(\s*\)/.test(read(path)))
    expect(direct).toEqual([])
  })

  it('uses no constructor parameter properties, so Node can strip its types without a compiler', () => {
    const found = files.filter(path => /constructor\s*\((?:[^()]*?,)?\s*(?:(?:private|public|protected|readonly|override)\s+)+\w+\s*[:?,)]/.test(read(path)))
    expect(found).toEqual([])
  })
})
