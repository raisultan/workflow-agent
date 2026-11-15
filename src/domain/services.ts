/**
 * Which Postgres major a job's test services run (`T12.4`, `D11` decision 6): the one the repository's CI names, from the image
 * tags the host read (`adapters/service-files.ts`).
 *
 * - The profile's `postgres`, when set, wins.
 * - Otherwise the major of every `postgres` (or `postgresql`) image tag; two different majors take the newest, with a note.
 * - No tag, or one with no plain major (`$PG_VERSION`, `latest`): the newest the image has, with a note.
 * - A CI or Compose file the host could not read or parse is an error, unless the profile names the major: it may name another
 *   major, and guessing would test against the wrong one.
 * - A major the image does not have is an error: the setup step blocks and says which.
 * - RabbitMQ and Kafka have one version each; a tag naming another major gets a note, and the job runs.
 */
import type { JobServices } from './job.ts'

/** An image a repository file names: the file, and the image reference as written. */
export interface NamedImage {
  readonly file: string
  readonly image: string
}

/** The versions of RabbitMQ and Kafka in the image (`D11`, decision 5). */
export const SINGLE_VERSIONS = { rabbitmq: '3', kafka: '4' } as const

export type ServicesChoice =
  | { readonly kind: 'chosen'; readonly services: JobServices; readonly notes: readonly string[] }
  | { readonly kind: 'error'; readonly error: string }

/** An image reference's name (its last path segment) and tag, without a registry, a path, or a digest. */
export function imageParts(reference: string): { name: string; tag: string | undefined } {
  const withoutDigest = reference.trim().split('@')[0]!
  const lastSlash = withoutDigest.lastIndexOf('/')
  const last = withoutDigest.slice(lastSlash + 1)
  const colon = last.indexOf(':')
  return colon === -1 ? { name: last.toLowerCase(), tag: undefined } : { name: last.slice(0, colon).toLowerCase(), tag: last.slice(colon + 1) }
}

/** The plain leading major of a tag (`15`, `15.4`, `16-alpine`), or `undefined` for `latest`, a variable, or none. */
export function majorOf(tag: string | undefined): string | undefined {
  return tag === undefined ? undefined : /^(\d+)(?:[.-]|$)/u.exec(tag)?.[1]
}

const newest = (majors: readonly string[]) => [...majors].sort((a, b) => Number(a) - Number(b)).at(-1)!

export function chooseServices(input: { images: readonly NamedImage[]; override?: string; available: readonly string[]; unreadable?: readonly string[] }):
  ServicesChoice {
  const notes: string[] = [...(input.unreadable ?? [])]
  const { available } = input
  if (available.length === 0) return { kind: 'error', error: 'the image has no Postgres' }
  if (input.override === undefined && (input.unreadable?.length ?? 0) > 0) {
    return { kind: 'error', error: `${input.unreadable!.join('; ')}; so the Postgres major cannot be read: set \`postgres\` in the repository profile` }
  }
  const has = (major: string) => available.includes(major)
  const missing = (major: string, why: string) =>
    ({ kind: 'error' as const, error: `${why} Postgres ${major}, which this image does not have (it has ${available.join(', ')})` })

  for (const { file, image } of input.images) {
    const { name, tag } = imageParts(image)
    const single = name === 'rabbitmq' ? 'rabbitmq' : name === 'kafka' ? 'kafka' : undefined
    if (!single) continue
    const major = majorOf(tag)
    if (major !== undefined && major !== SINGLE_VERSIONS[single]) {
      notes.push(`${file} names ${image}; jobs get ${single === 'rabbitmq' ? 'RabbitMQ 3.10' : 'Kafka 4.4'}`)
    }
  }

  if (input.override !== undefined) {
    if (!has(input.override)) return missing(input.override, 'the repository profile names')
    return { kind: 'chosen', services: { postgres: input.override }, notes }
  }
  const named = input.images.filter(({ image }) => ['postgres', 'postgresql'].includes(imageParts(image).name))
  const majors = [...new Set(named.map(({ image }) => majorOf(imageParts(image).tag)).filter((major): major is string => major !== undefined))]
  const vague = named.filter(({ image }) => majorOf(imageParts(image).tag) === undefined)
  for (const { file, image } of vague) notes.push(`${file} names ${image}, with no plain major`)
  if (majors.length === 0) {
    const chosen = newest(available)
    notes.push(named.length === 0 ? `no Postgres image is named in the repository's CI or Compose files; using Postgres ${chosen}`
      : `using Postgres ${chosen}, the newest`)
    return { kind: 'chosen', services: { postgres: chosen }, notes }
  }
  const chosen = newest(majors)
  if (majors.length > 1) notes.push(`the repository names Postgres ${majors.join(' and ')}; using ${chosen}, the newest`)
  if (!has(chosen)) {
    const where = named.find(({ image }) => majorOf(imageParts(image).tag) === chosen)!
    return missing(chosen, `${where.file} names`)
  }
  return { kind: 'chosen', services: { postgres: chosen }, notes }
}
