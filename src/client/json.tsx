/**
 * The JSON of any event or step (`D13`): a `{ }` button opens a side drawer with the value pretty-printed and coloured, and a copy
 * button. `Esc` or the backdrop closes it, and focus returns where it was.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CopyButton, Icon } from './controls.tsx'
import type { T } from './locales.ts'
import { useRouter } from './router.tsx'

interface Open { readonly title: string; readonly value: unknown }
const JsonContext = createContext<(title: string, value: unknown) => void>(() => {})

/** One token of pretty JSON, with its class (`jk` key, `js` string, `jn` number, `jl` literal) or none (punctuation, space). */
export function jsonTokens(value: unknown): { text: string; kind?: 'jk' | 'js' | 'jn' | 'jl' }[] {
  const text = JSON.stringify(value, null, 2) ?? 'undefined'
  const pattern = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu
  const tokens: { text: string; kind?: 'jk' | 'js' | 'jn' | 'jl' }[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index) })
    const token = match[0]
    tokens.push({ text: token, kind: token.startsWith('"') ? (token.endsWith(':') ? 'jk' : 'js') : /^(?:true|false|null)$/u.test(token) ? 'jl' : 'jn' })
    last = match.index + token.length
  }
  if (last < text.length) tokens.push({ text: text.slice(last) })
  return tokens
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="json">{jsonTokens(value).map((token, index) => token.kind ? <span key={index} className={token.kind}>{token.text}</span> : token.text)}</pre>
}

export function JsonProvider({ t, children }: { t: T; children: ReactNode }) {
  const [open, setOpen] = useState<Open>()
  const opener = useRef<HTMLElement | null>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const show = useCallback((title: string, value: unknown) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen({ title, value })
  }, [])
  const close = useCallback(() => { setOpen(undefined); opener.current?.focus() }, [])
  // Another address is another page: the drawer does not follow the reader there.
  const { location } = useRouter()
  const address = `${location.path}?${location.query.toString()}`
  useEffect(() => { setOpen(undefined) }, [address])
  useEffect(() => {
    if (!open) return undefined
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [open, close])
  const text = useMemo(() => open ? JSON.stringify(open.value, null, 2) ?? '' : '', [open])
  return <JsonContext.Provider value={show}>
    {children}
    <div className={`drawer-bg${open ? ' open' : ''}`} onClick={close} aria-hidden="true" />
    <aside className={`drawer${open ? ' open' : ''}`} role="dialog" aria-modal="true" aria-label={open?.title ?? t('json')} hidden={!open}>
      {open ? <>
        <div className="drawer-h"><span className="ttl">{open.title}</span><span className="grow" />
          <CopyButton value={text} label={t('copy')} copiedLabel={t('copied')} title={t('copy')} />
          <button ref={closeButton} type="button" className="ibtn ghost" aria-label={t('close')} onClick={close}><Icon name="close" size={14} /></button></div>
        <div className="drawer-b"><JsonView value={open.value} /></div>
      </> : null}
    </aside>
  </JsonContext.Provider>
}

/** The `{ }` button that opens `value` in the drawer. */
export function JsonButton({ title, value }: { title: string; value: unknown }) {
  const show = useContext(JsonContext)
  return <button type="button" className="jbtn" title="JSON" aria-label={`JSON: ${title}`} onClick={() => { show(title, value) }}>{'{ }'}</button>
}
