import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_DOCS = [
  'README.md',
  'AGENTS.md',
  'LICENSE',
  'docs/PRD.md',
  'docs/DESIGN.md',
  'docs/DECISIONS.md',
  'docs/UPSTREAM.md',
  'docs/DEPLOYMENT.md',
]

const markdownFiles = [
  'README.md',
  'AGENTS.md',
  ...readdirSync(join(ROOT, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`),
]

function links(file: string): { path: string; anchor?: string }[] {
  return [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)]
    .map(match => match[1]!)
    .filter(target => target && !/^[a-z]+:/.test(target))
    .map(target => {
      const [path, anchor] = target.split('#')
      return { path: path!, ...(anchor ? { anchor } : {}) }
    })
}

function headingSlugs(file: string): Set<string> {
  return new Set(
    [...readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(match =>
      match[1]!
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-'),
    ),
  )
}

describe('documentation', () => {
  it('contains all required specification, planning, and license files', () => {
    const missing = REQUIRED_DOCS.filter(path => !existsSync(join(ROOT, path)))
    expect(missing).toEqual([])
  })

  it('resolves every relative markdown link and heading anchor', () => {
    const missing = markdownFiles.flatMap(relPath => {
      const fullPath = join(ROOT, relPath)
      return links(fullPath).flatMap(({ path, anchor }) => {
        const targetFile = path ? resolve(dirname(fullPath), path) : fullPath
        if (!existsSync(targetFile)) return [`${relPath} → ${path}`]
        if (anchor && targetFile.endsWith('.md') && !headingSlugs(targetFile).has(anchor)) {
          return [`${relPath} → ${path}#${anchor}`]
        }
        return []
      })
    })
    expect(missing).toEqual([])
  })

  it('leaves no merge conflict markers in any document', () => {
    const conflicted = markdownFiles.filter(relPath => /^(<{7}|>{7}) /m.test(readFileSync(join(ROOT, relPath), 'utf8')))
    expect(conflicted).toEqual([])
  })
})
