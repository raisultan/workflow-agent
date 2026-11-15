/**
 * The image tags a repository's CI and Compose files name (`T12.4`, `D11` decision 6), for `domain/services.ts` to choose the job's
 * Postgres major. The host reads them as data, by the same rules as the toolchain files (`toolchain-files.ts`: regular files directly
 * in the worktree, size-limited, no links followed), parses them as YAML with aliases limited, and runs nothing.
 *
 * - `.gitlab-ci.yml`: `services` at the top, under `default`, and in each job; an entry is an image name, or a map with `name`.
 *   Included files (`include:`) are not followed.
 * - `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml`: each service's `image`.
 */
import { parseDocument } from 'yaml'
import type { NamedImage } from '../domain/services.ts'
import { readWorktreeFile } from './toolchain-files.ts'

export const CI_FILE = '.gitlab-ci.yml'
export const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] as const

type Value = unknown
const isMap = (value: Value): value is Record<string, Value> => typeof value === 'object' && value !== null && !Array.isArray(value)

function ciImages(document: Value): string[] {
  if (!isMap(document)) return []
  const images: string[] = []
  const servicesOf = (holder: Value) => {
    if (!isMap(holder) || !Array.isArray(holder.services)) return
    for (const entry of holder.services) {
      if (typeof entry === 'string') images.push(entry)
      else if (isMap(entry) && typeof entry.name === 'string') images.push(entry.name)
    }
  }
  servicesOf(document)
  for (const value of Object.values(document)) servicesOf(value)
  return images
}

function composeImages(document: Value): string[] {
  if (!isMap(document) || !isMap(document.services)) return []
  return Object.values(document.services).flatMap(service => isMap(service) && typeof service.image === 'string' ? [service.image] : [])
}

/** The images the files name, and a note for each file that could not be read or parsed. */
export function readServiceImages(worktree: string): { images: NamedImage[]; unreadable: string[] } {
  const images: NamedImage[] = []
  const unreadable: string[] = []
  for (const [file, extract] of [[CI_FILE, ciImages], ...COMPOSE_FILES.map(name => [name, composeImages] as const)] as const) {
    const read = readWorktreeFile(worktree, file)
    if (!read) continue
    if ('error' in read) { unreadable.push(`${read.error}; it was not read`); continue }
    let document: Value
    try {
      // GitLab's `!reference` tags read as empty. Aliases are limited, so a small file cannot expand without bound, but well above
      // the parser's default of 100, which large CI files with nested anchors exceed (review); the 64 KiB cap bounds the work.
      const parsed = parseDocument(read.text, { merge: true, uniqueKeys: false, customTags: [{ tag: '!reference', collection: 'seq', resolve: () => null }] })
      if (parsed.errors.length > 0) throw parsed.errors[0]
      document = parsed.toJS({ maxAliasCount: 10_000 })
    } catch (error) {
      unreadable.push(`${file} could not be parsed (${error instanceof Error ? error.message.split('\n')[0] : 'error'}); it was not read`)
      continue
    }
    for (const image of extract(document)) images.push({ file, image })
  }
  return { images, unreadable }
}
