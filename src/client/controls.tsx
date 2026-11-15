/**
 * The dashboard's primitives (`D13`): icons, tags, a segmented control, tabs, avatars, tool badges, thread links and a copy
 * button. Nothing here changes the workbench: every control filters, navigates, copies or shows.
 */
import { useState, type ReactNode } from 'react'
import type { ThreadInfo } from './format.ts'
import { Link } from './router.tsx'

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

const ICONS = {
  jobs: 'M5 6.5h14M5 12h14M5 17.5h9', inbox: 'M4 13l2.5-7.5h11L20 13M4 13v5.5h16V13M4 13h4.5l1.2 2h4.6l1.2-2H20', health: 'M3 12h4l2.5-6 5 12 2.5-6h4',
  settings: 'M5 7h9M18 7h1M5 17h3M12 17h7M16 5v4M10 15v4', search: 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM19 19l-4.2-4.2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1', external: 'M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4',
  close: 'M6 6l12 12M18 6L6 18', copy: 'M9 9h10v10H9zM5 15V5h10', chevron: 'M9 6l6 6-6 6', sort: 'M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3',
  plug: 'M8 12h8M10 7V3M14 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5', off: 'M3 3l18 18M8.5 8.5A5 5 0 0 0 12 17M12 3v2M5 12H3M21 12h-2',
  hand: 'M8 12.5V6a1.4 1.4 0 0 1 2.8 0v5.5M10.8 10V4.8a1.4 1.4 0 0 1 2.8 0V11M13.6 6.5a1.4 1.4 0 0 1 2.8 0V14a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.7-2.4l-2.1-3a1.4 1.4 0 0 1 2.2-1.7L8 14.5',
  message: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4V6a1 1 0 0 1 1-1z', send: 'M4 12l16-8-6 16-2.5-6.5z', check: 'M5 12.5l4.5 4.5L19 7',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01', agent: 'M8 8h8v8H8zM10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4',
  network: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  branch: 'M7 4v10M7 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM17 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 10c0 4-10 2-10 4', bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  terminal: 'M4 5h16v14H4zM7.5 10l2.5 2-2.5 2M12.5 15h4', file: 'M7 3h7l4 4v14H7zM14 3v4h4', pen: 'M5 19l1-4L16 5l3 3L9 18zM14 7l3 3', flag: 'M6 21V4M6 4h11l-2 4 2 4H6',
  reply: 'M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5v1', play: 'M8 5l11 7-11 7z', lock: 'M7 11h10v9H7zM9 11V8a3 3 0 0 1 6 0v3', stop: 'M6 6h12v12H6z', back: 'M15 5l-7 7 7 7',
  input: 'M4 12h11M11 8l4 4-4 4M20 4v16', pause: 'M9 6v12M15 6v12', x: 'M7 7l10 10M17 7L7 17', dot: 'M12 11.5v1',
} as const
export type IconName = keyof typeof ICONS
export function Icon({ name, size = 15, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>
}

/** Semantic tones: amber waits on a person, blue runs, red is blocked or failed, green is done, grey is cancelled or quiet. */
export type Tone = 'wait' | 'run' | 'bad' | 'ok' | 'mute' | 'acc'
export function Tag({ tone = 'mute', icon, title, children }: { tone?: Tone; icon?: IconName; title?: string; children: ReactNode }) {
  return <span className={cx('tag', `k-${tone}`)} title={title}>{icon ? <Icon name={icon} size={12} /> : null}{children}</span>
}

export function Segmented<V extends string>({ items, value, onChange, label }: { items: readonly { value: V; label: string; count?: number }[]; value: V
  onChange: (value: V) => void; label: string }) {
  return <div className="segm" role="group" aria-label={label}>{items.map(item => <button key={item.value} type="button" aria-pressed={item.value === value}
    onClick={() => onChange(item.value)}>{item.label}{item.count !== undefined ? <span className="cnt">{item.count}</span> : null}</button>)}</div>
}

/** Tabs that are links: each tab has its own address. */
export function Tabs({ items, current, label }: { items: readonly { id: string; to: string; label: string; count?: ReactNode; bad?: boolean }[]; current: string; label: string }) {
  return <nav className="tabs" aria-label={label}>{items.map(item => <Link key={item.id} to={item.to} aria-current={item.id === current ? 'page' : undefined}>
    {item.label}{item.count !== undefined ? <span className={cx('cnt', item.bad && 'bad')}>{item.count}</span> : null}</Link>)}</nav>
}

const HUES = ['#5753D9', '#2D74C4', '#26915F', '#B76E00', '#C2416B', '#7A4FD1', '#0F8A8A']
/** A person's initial on a colour of their own; the workbench is ink, an unresolved id a question mark. */
export function Avatar({ name, workbench = false, known = true }: { name: string; workbench?: boolean; known?: boolean }) {
  if (workbench) return <span className="av wb" title="@workbench">W</span>
  if (!known) return <span className="av unk" title={name}>?</span>
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 997
  const initial = name.replace(/^@/u, '').charAt(0).toUpperCase() || '?'
  return <span className="av" style={{ background: HUES[hash % HUES.length] }} title={name}>{initial}</span>
}

export function ToolBadge({ tool }: { tool: ThreadInfo['tool'] }) {
  return <span className={cx('tl', tool)} aria-hidden="true">{{ j: 'J', m: 'M', g: 'G', o: '•' }[tool]}</span>
}

/** A thread: its tool and label, linking to it when the deployment knows where it opens. */
export function ThreadLink({ info, inert = false }: { info: ThreadInfo; inert?: boolean }) {
  const inner = <><ToolBadge tool={info.tool} /><span>{info.label}</span></>
  if (!info.href || inert) return <span className="lnk" title={info.title}>{inner}</span>
  return <a className="lnk" href={info.href} target="_blank" rel="noopener noreferrer" title={info.title}>{inner}</a>
}

/** Copies `value`; on a browser that refuses, selects the label so it can be copied by hand. */
export function CopyButton({ value, label, title, quiet = false, copiedLabel }: { value: string; label: ReactNode; title?: string; quiet?: boolean; copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (event: { currentTarget: HTMLButtonElement }) => {
    const target = event.currentTarget
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1200)
    } catch {
      const range = document.createRange()
      range.selectNodeContents(target)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  }
  return <button type="button" className={cx('copy', quiet && 'q')} title={title ?? value} onClick={event => { void copy(event) }}>
    <Icon name="copy" size={11} /><span>{copied ? copiedLabel : label}</span></button>
}
