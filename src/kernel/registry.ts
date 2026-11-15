/**
 * Versioned workflow definitions and the run manifests jobs pin. A definition's identity is `(id, version)` and its canonical
 * hash covers the declarative part and every prompt text; the same `(id, version)` with another hash is refused. Guards (the only
 * code a definition needs) are pure functions registered by name. A manifest holds what a job resumes from: the declarative part
 * and prompts by blob digest, the guard names, and data the caller supplies. So a running job needs only its named guards from
 * code, and parks when one is missing.
 */
import { createHash } from 'node:crypto'
import type { KernelDb } from './db.ts'
import type { RunManifest } from './engine.ts'
import type { Env } from './env.ts'
import { Blobs } from './projections.ts'

export interface WorkflowDefinition {
  readonly id: string
  readonly version: number
  /** The declarative part: plain JSON data (stages, transitions, gates, budgets, guard names). */
  readonly declaration: unknown
  /** Prompt texts by name. */
  readonly prompts: Readonly<Record<string, string>>
  /** The guard names the declaration refers to; each must be registered for a job on it to run. */
  readonly guards: readonly string[]
}

/** What a run manifest's `data` holds; the content itself is in the blob store. */
export interface ManifestData {
  readonly declaration: string
  readonly prompts: Readonly<Record<string, string>>
  readonly guards: readonly string[]
  readonly extra: unknown
}

/** JSON with object keys sorted at every level, so equal data always serializes, and hashes, the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new Error(`A definition holds only JSON data; found ${typeof value}`)
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('A definition holds only finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}

/** The definition's hash: its id, version, declaration, prompts and guard names, canonically serialized. */
export function definitionHash(definition: WorkflowDefinition): string {
  const content = canonicalJson({ id: definition.id, version: definition.version, declaration: definition.declaration,
    prompts: definition.prompts, guards: [...definition.guards].sort() })
  return createHash('sha256').update(content).digest('hex')
}

/** Definitions and guards registered by contributor plugins, and the manifests made from them. */
export class Registry {
  private readonly definitions = new Map<string, { definition: WorkflowDefinition; hash: string }>()
  private readonly guards = new Map<string, (...args: never[]) => unknown>()
  private readonly blobs: Blobs
  private readonly db: KernelDb
  private readonly env: Env

  constructor(db: KernelDb, env: Env) {
    this.db = db
    this.env = env
    this.blobs = new Blobs(db)
  }

  /**
   * Registers a definition and returns a disposer (for a Cordis effect). The first registration of an `(id, version)` records its
   * hash; registering it again with another hash is refused, so a changed definition needs a new version.
   */
  register(definition: WorkflowDefinition): () => void {
    const key = `${definition.id}@${definition.version}`
    if (!Number.isInteger(definition.version) || definition.version < 1) throw new Error(`Definition ${definition.id} needs a positive integer version`)
    const hash = definitionHash(definition)
    if (this.definitions.has(key)) throw new Error(`Definition ${key} is registered already`)
    this.db.tx(() => {
      const stored = this.db.get<{ hash: string }>('SELECT hash FROM definition_version WHERE id = ? AND version = ?', definition.id, definition.version)
      if (stored && stored.hash !== hash) throw new Error(`Definition ${key} changed without a new version`)
      if (!stored) {
        this.db.run('INSERT INTO definition_version (id, version, hash, registered_at) VALUES (?, ?, ?, ?)',
          definition.id, definition.version, hash, this.env.clock.now())
      }
    })
    const entry = { definition, hash }
    this.definitions.set(key, entry)
    return () => { if (this.definitions.get(key) === entry) this.definitions.delete(key) }
  }

  /** Registers a guard by name; returns a disposer. */
  registerGuard(name: string, guard: (...args: never[]) => unknown): () => void {
    if (this.guards.has(name)) throw new Error(`Guard ${name} is registered already`)
    this.guards.set(name, guard)
    return () => { if (this.guards.get(name) === guard) this.guards.delete(name) }
  }

  guard(name: string): ((...args: never[]) => unknown) | undefined { return this.guards.get(name) }

  /** The registered definition `(id, version)`, or the highest registered version of `id`. */
  definition(id: string, version?: number): WorkflowDefinition | undefined {
    if (version !== undefined) return this.definitions.get(`${id}@${version}`)?.definition
    return [...this.definitions.values()].map(entry => entry.definition).filter(definition => definition.id === id)
      .sort((a, b) => b.version - a.version)[0]
  }

  /** Every registered definition, ordered by id and then version. */
  list(): WorkflowDefinition[] {
    return [...this.definitions.values()].map(entry => entry.definition)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version)
  }

  /** Makes a frozen manifest for a new job on a registered definition, storing its content in the blob store. */
  manifest(id: string, version: number, extra: unknown): RunManifest {
    const entry = this.definitions.get(`${id}@${version}`)
    if (!entry) throw new Error(`Definition ${id}@${version} is not registered`)
    const { definition, hash } = entry
    const data: ManifestData = {
      declaration: this.blobs.put(canonicalJson(definition.declaration)),
      prompts: Object.fromEntries(Object.entries(definition.prompts).map(([name, text]) => [name, this.blobs.put(text)])),
      guards: [...definition.guards].sort(),
      extra: JSON.parse(canonicalJson(extra ?? null)) as unknown,
    }
    return { id: this.env.ids.next('rm_'), definitionId: id, definitionVersion: version, definitionHash: hash, data }
  }

  /** The declaration and prompt texts a manifest pinned, read back from the blob store. */
  content(manifest: RunManifest): { declaration: unknown; prompts: Record<string, string>; guards: readonly string[]; extra: unknown } {
    const data = manifest.data as ManifestData
    const text = (digest: string) => {
      const value = this.blobs.text(digest)
      if (value === undefined) throw new Error(`Run manifest ${manifest.id} refers to missing content ${digest}`)
      return value
    }
    return {
      declaration: JSON.parse(text(data.declaration)) as unknown,
      prompts: Object.fromEntries(Object.entries(data.prompts).map(([name, digest]) => [name, text(digest)])),
      guards: data.guards,
      extra: data.extra,
    }
  }

  /** The guards a manifest names that are not registered; a job on it parks until they are. */
  missingGuards(manifest: RunManifest): string[] {
    const guards = (manifest.data as Partial<ManifestData> | null)?.guards
    return Array.isArray(guards) ? guards.filter(name => !this.guards.has(name)) : []
  }
}
