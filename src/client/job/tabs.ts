/**
 * A job page's tabs (`D13`), in order: each has its address (`/jobs/<id>/<tab>`), its label and a count. To add a tab, add an entry.
 */
import type { ComponentType } from 'react'
import type { JobDetail } from '../../app/panel-api.ts'
import type { Key } from '../locales.ts'
import { ActivityTab } from './activity.tsx'
import { ArtifactsTab, ConversationsTab, DetailsTab, NetworkTab } from './panels.tsx'

export interface JobTab {
  readonly id: string
  readonly label: Key
  readonly count?: (detail: JobDetail) => number | undefined
  /** Whether the count is bad news (refused connections). */
  readonly bad?: (detail: JobDetail) => boolean
  readonly Component: ComponentType<{ detail: JobDetail }>
}

export const JOB_TABS: readonly JobTab[] = [
  { id: 'activity', label: 'tab.activity', count: detail => detail.events.length, Component: ActivityTab },
  { id: 'conversations', label: 'tab.talk', count: detail => detail.communication.length + detail.outbound.length, Component: ConversationsTab },
  { id: 'artifacts', label: 'tab.artifacts', count: detail => detail.artifacts.length, Component: ArtifactsTab },
  { id: 'network', label: 'tab.network', count: detail => detail.egress.length, bad: detail => detail.egress.some(connection => !connection.allowed), Component: NetworkTab },
  { id: 'details', label: 'tab.details', Component: DetailsTab },
]
