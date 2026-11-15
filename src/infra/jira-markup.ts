/**
 * Markdown to Jira wiki markup (`D12`, `T14.6`): Jira Server renders its own markup, so a plan or comment written in Markdown would
 * show its `###` and `**` as text. This converts what plans and comments use: headings, bullet and numbered lists (nested by
 * indentation), fenced code, quotes, rules, tables, inline code, links, bold and italics. Anything else is left as it is.
 */

const BULLET = /^(\s*)[-*+]\s+(.*)$/u
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/u
const FENCE = /^\s*```\s*([\w+-]*)\s*$/u
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/u

/** One line's inline Markdown as Jira markup; inline code is kept verbatim. */
function inline(line: string): string {
  const codes: string[] = []
  let out = line.replace(/`([^`]+)`/gu, (_whole, code: string) => `\u0000${codes.push(code) - 1}\u0000`)
  out = out.replace(/\[([^\]]+)\]\((\S+?)\)/gu, '[$1|$2]')
  out = out.replace(/\*\*(.+?)\*\*/gu, '\u0001$1\u0001').replace(/__(.+?)__/gu, '\u0001$1\u0001')
  out = out.replace(/(?<![\w*\\])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/gu, '_$1_')
  out = out.replace(/\u0001/gu, '*')
  return out.replace(/\u0000(\d+)\u0000/gu, (_whole, index: string) => `{{${codes[Number(index)]}}}`)
}

/** The list depth of an indentation: two spaces (or a tab) per level. */
const depth = (indent: string) => 1 + Math.floor(indent.replace(/\t/gu, '  ').length / 2)

/** `markdown` as Jira wiki markup. */
export function toJiraMarkup(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fence = FENCE.exec(line)
    if (fence) {
      out.push(inCode || !fence[1] ? '{code}' : `{code:${fence[1]}}`)
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(line); continue }
    const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line)
    if (heading) { out.push(`h${heading[1]!.length}. ${inline(heading[2]!)}`); continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) { out.push('----'); continue }
    const bullet = BULLET.exec(line)
    if (bullet) { out.push(`${'*'.repeat(depth(bullet[1]!))} ${inline(bullet[2]!)}`); continue }
    const numbered = NUMBERED.exec(line)
    if (numbered) { out.push(`${'#'.repeat(depth(numbered[1]!))} ${inline(numbered[2]!)}`); continue }
    const quote = /^\s*>\s?(.*)$/u.exec(line)
    if (quote) { out.push(`bq. ${inline(quote[1]!)}`); continue }
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map(cell => inline(cell.trim()))
      const header = TABLE_RULE.test(lines[index + 1] ?? '')
      out.push(header ? `||${cells.join('||')}||` : `|${cells.join('|')}|`)
      if (header) index++
      continue
    }
    out.push(inline(line))
  }
  if (inCode) out.push('{code}')
  return out.join('\n')
}
