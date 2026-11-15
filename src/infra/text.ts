/** Text validation, Russian/Cyrillic detection, transliteration, and ASCII slug utilities. */

/** Connector-appropriate character limits for Russian and English messages, plans, and questions (`D6`). */
export const IM_MAX_CHARS = 12_000
export const JIRA_MAX_CHARS = 16_000
export const GITLAB_MAX_CHARS = 16_000

/**
 * Validates that an outbound connector message (Mattermost, Jira, GitLab) is non-empty and within the connector's character limit (`D6`).
 * Allows multi-thousand-character Russian and English technical plans, requirement clarifications, and stage summaries.
 */
export function checkedConnectorText(text: string, sourceOrMaxChars: string | number = 'mattermost', label?: string): string {
  const maxChars = typeof sourceOrMaxChars === 'number'
    ? sourceOrMaxChars
    : sourceOrMaxChars === 'jira'
      ? JIRA_MAX_CHARS
      : sourceOrMaxChars === 'gitlab'
        ? GITLAB_MAX_CHARS
        : IM_MAX_CHARS
  const name = label ?? (typeof sourceOrMaxChars === 'string' ? `${sourceOrMaxChars} message` : 'connector message')
  if (text.length > maxChars) {
    throw new Error(`Outbound ${name} has ${text.length} characters; maximum is ${maxChars}.`)
  }
  return text
}

/** Returns true when `text` contains Russian / Cyrillic characters (`\p{Script=Cyrillic}`). */
export const isRussianText = (text: string): boolean => /\p{Script=Cyrillic}/u.test(text)

const CYRILLIC_TO_ASCII: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', қ: 'k', ғ: 'g', ү: 'u', ұ: 'u', һ: 'h', ә: 'a', ө: 'o',
}

/** Transliterates Cyrillic characters to lowercase ASCII while lowercasing existing Latin characters. */
export function transliterateCyrillicToAscii(text: string): string {
  let out = ''
  for (const ch of text.toLowerCase()) {
    out += CYRILLIC_TO_ASCII[ch] ?? ch
  }
  return out
}

/**
 * Converts a Russian, English, or mixed title into a valid lowercase kebab-case ASCII slug (`1–4` words, at most `maxLength` chars,
 * starting with a lowercase ASCII letter `[a-z]`).
 */
export function asciiSlug(text: string, maxWords = 4, maxLength = 32): string {
  const transliterated = transliterateCyrillicToAscii(text)
  const rawTokens = transliterated
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  const wordsOut: string[] = []
  for (const token of rawTokens) {
    const cleaned = wordsOut.length === 0 ? token.replace(/^[0-9]+/, '') : token
    if (!cleaned) continue
    wordsOut.push(cleaned)
    if (wordsOut.length >= maxWords) break
  }

  if (wordsOut.length === 0) return 'task'

  let slug = wordsOut[0]!.slice(0, maxLength)
  for (let i = 1; i < wordsOut.length; i++) {
    const candidate = `${slug}-${wordsOut[i]}`
    if (candidate.length <= maxLength) {
      slug = candidate
    } else {
      break
    }
  }
  return slug || 'task'
}

export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
