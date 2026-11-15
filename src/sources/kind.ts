/** A Source kind (`T9.6`): its configuration schema and the health entries it reports. */
import type { z } from 'zod'

export interface LocalizedObject { ru?: string; en: string }
export type Localized = LocalizedObject | string

/** What a Source plugin registers: its kind, its configuration schema (defaults from the environment), and its health entries. */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: string
  readonly title: Localized
  readonly schema: z.ZodType<C>
  readonly health: readonly string[]
}

/** A Source kind's resolved configuration. Nothing is stored: each installed kind runs on its schema's defaults and the environment. */
export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
