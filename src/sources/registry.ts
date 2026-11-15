/** The installed Source kinds (`T9.8`): their configurations, and the health entries each claims on the board. */
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { SourceInstance, SourceKind } from './kind.ts'

/** Source kinds that registered from their plugins; each runs on its schema's defaults and the environment (`D9`). */
export class SourceRegistry {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  private readonly board: Pick<HealthBoard, 'claim'>
  constructor(board: Pick<HealthBoard, 'claim'>) { this.board = board }

  /** Registers a kind and claims its health entries; returns the disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); release() }
  }

  /** The health entries for `names` while their kind is registered; a context writes through the ones it received. */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }

  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }

  /** A registered kind's configuration: its schema's defaults (which read the environment). */
  instance<C extends Record<string, unknown>>(id: string): SourceInstance<C> | undefined {
    const kind = this.kinds.get(id)
    return kind ? { id, kind: id, enabled: true, config: kind.schema.parse({}) as C } : undefined
  }
}
