/**
 * The dashboard's views (`D13`): each has an address pattern, and those in the navigation an icon and a label. The router, the
 * sidebar and the phone's tab bar read this list; to add a view, add a file in `views/` and an entry here.
 */
import type { ComponentType } from 'react'
import type { IconName } from './controls.tsx'
import type { Key } from './locales.ts'
import { HealthView } from './views/health.tsx'
import { InboxView } from './views/inbox.tsx'
import { JobView } from './views/job.tsx'
import { JobsView } from './views/jobs.tsx'
import { SettingsView } from './views/settings.tsx'

export interface View {
  readonly id: string
  /** `/jobs/:id/:tab?`: `:name` is a parameter, `?` makes it optional. */
  readonly path: string
  readonly nav?: { readonly icon: IconName; readonly label: Key }
  /** The navigation entry this view belongs under (a job under Jobs). */
  readonly parent?: string
  readonly Component: ComponentType<{ params: Record<string, string> }>
}

export const VIEWS: readonly View[] = [
  { id: 'jobs', path: '/', nav: { icon: 'jobs', label: 'nav.jobs' }, Component: JobsView },
  { id: 'job', path: '/jobs/:id/:tab?', parent: 'jobs', Component: JobView },
  { id: 'inbox', path: '/inbox', nav: { icon: 'inbox', label: 'nav.inbox' }, Component: InboxView },
  { id: 'health', path: '/health', nav: { icon: 'health', label: 'nav.health' }, Component: HealthView },
  { id: 'settings', path: '/settings', nav: { icon: 'settings', label: 'nav.settings' }, Component: SettingsView },
]
