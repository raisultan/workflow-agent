/**
 * Markdown as artifacts and the workbench's own posts use it (`D13`), rendered as React elements from the text and never as HTML,
 * so nothing in it can inject markup. Links become anchors only for http(s) addresses written out as such.
 */
import type { ReactNode } from 'react'

/** A link's address, when it may become an anchor: http(s) only, written out as such (`inert()`'s zero-width space breaks it). */
function linkHref(url: string): string | undefined {
  if (!/^https?:\/\//iu.test(url)) return undefined
  try { return /^https?:$/u.test(new URL(url).protocol) ? url : undefined } catch { return undefined }
}

/** A line's inline marks: code, bold and `[label](url)` links; anything else, HTML included, stays text. */
function inline(line: string): ReactNode[] {
  return line.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/u).map((part, index) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <b key={index}>{inline(part.slice(2, -2))}</b>
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/u.exec(part)
    const href = link ? linkHref(link[2]!) : undefined
    return href ? <a key={index} href={href} target="_blank" rel="noreferrer">{link![1]}</a> : part
  })
}

interface ListItem { readonly depth: number; readonly ordered: boolean; readonly n: number; readonly text: string }

/** A list and the lists nested in its items, by indent; it is numbered from its first item's number when that is ordered. */
function list(items: readonly ListItem[], key: number): ReactNode {
  const [first] = items
  const entries: { item: ListItem; nested: ListItem[] }[] = []
  for (const item of items) {
    if (entries.length && item.depth > first!.depth) entries.at(-1)!.nested.push(item)
    else entries.push({ item, nested: [] })
  }
  const children = entries.map(({ item, nested }, index) => <li key={index}>{inline(item.text)}{nested.length ? list(nested, 0) : null}</li>)
  return first!.ordered ? <ol key={key} {...first!.n === 1 ? {} : { start: first!.n }}>{children}</ol> : <ul key={key}>{children}</ul>
}

/** Markdown's blocks: headings, paragraphs (a line break within one), nested lists, `> ` quotes, `---` rules and code. */
function blocks(lines: readonly string[]): ReactNode[] {
  const out: ReactNode[] = []
  let items: ListItem[] = [], indents: number[] = [], paragraph: string[] = [], quote: string[] | undefined, code: string[] | undefined
  const flush = () => {
    if (items.length) { out.push(list(items, out.length)); items = []; indents = [] }
    if (paragraph.length) { out.push(<p key={out.length}>{paragraph.flatMap((line, index) => index ? [<br key={`b${index}`} />, ...inline(line)] : inline(line))}</p>); paragraph = [] }
    if (quote) { out.push(<blockquote key={out.length}>{blocks(quote)}</blockquote>); quote = undefined }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (code) { if (/^\s*```/u.test(line)) { out.push(<pre key={out.length}>{code.join('\n')}</pre>); code = undefined } else code.push(raw); continue }
    const quoted = /^\s*>\s?(.*)$/u.exec(line)
    if (quoted) { if (!quote) { flush(); quote = [] } quote.push(quoted[1]!); continue }
    if (quote) flush()
    if (/^\s*```/u.test(line)) { flush(); code = []; continue }
    if (/^\s*([-*_])(\s*\1){2,}$/u.test(line)) { flush(); out.push(<hr key={out.length} />); continue }
    const item = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/u.exec(line)
    if (item) {
      if (paragraph.length) flush()
      const indent = item[1]!.length
      while (indents.length && indent < indents.at(-1)!) indents.pop()
      if (!indents.length || indent > indents.at(-1)!) indents.push(indent)
      items.push({ depth: indents.length - 1, ordered: item[2] !== undefined, n: Number(item[2] ?? 1), text: item[3]! })
      continue
    }
    if (items.length) flush()
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading) { flush(); out.push(<h4 key={out.length}>{inline(heading[2]!)}</h4>) }
    else if (line.trim()) paragraph.push(line.trim())
    else flush()
  }
  flush()
  if (code) out.push(<pre key={out.length}>{code.join('\n')}</pre>)
  return out
}

/**
 * Markdown as plans and the workbench's posts use it (`render()` in `src/adapters/messages.ts`), rendered as elements from the text,
 * never as HTML: headings, paragraphs, nested lists, quotes, rules, code, inline code, bold and http(s) links.
 */
export function Markdown({ text, className = 'doc' }: { text: string; className?: string }) {
  return <div className={className}>{blocks(text.split('\n'))}</div>
}
