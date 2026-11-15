import { describe, expect, it } from 'vitest'
import {
  asciiSlug,
  checkedConnectorText,
  GITLAB_MAX_CHARS,
  IM_MAX_CHARS,
  isRussianText,
  JIRA_MAX_CHARS,
  transliterateCyrillicToAscii,
} from '../src/infra/text.ts'

describe('Russian (ru) text, connector limits, and ASCII slug generation (D6)', () => {
  it('detects Cyrillic script in Russian and mixed developer messages', () => {
    expect(isRussianText('Посмотри задачу PAY-123, там падает таймаут')).toBe(true)
    expect(isRussianText('ок, согласовано')).toBe(true)
    expect(isRussianText('Fix timeout in payment service')).toBe(false)
  })

  it('allows multi-thousand-character Russian and English plans up to connector limits (8k-16k chars)', () => {
    const russianPlan = '## План реализации задачи PAY-123\n' + 'Детальное описание шага миграции и тестов. '.repeat(220)
    expect(russianPlan.length).toBeGreaterThan(8_000)
    expect(russianPlan.length).toBeLessThan(IM_MAX_CHARS)

    expect(checkedConnectorText(russianPlan, 'mattermost')).toBe(russianPlan)
    expect(checkedConnectorText(russianPlan, 'jira')).toBe(russianPlan)
    expect(checkedConnectorText(russianPlan, 'gitlab')).toBe(russianPlan)

    const overMattermost = 'а'.repeat(IM_MAX_CHARS + 1)
    expect(() => checkedConnectorText(overMattermost, 'mattermost')).toThrow(`maximum is ${IM_MAX_CHARS}`)
    expect(checkedConnectorText(overMattermost, 'jira')).toBe(overMattermost)

    const overJira = 'б'.repeat(JIRA_MAX_CHARS + 1)
    expect(() => checkedConnectorText(overJira, 'jira')).toThrow(`maximum is ${JIRA_MAX_CHARS}`)
    expect(() => checkedConnectorText('x'.repeat(GITLAB_MAX_CHARS + 1), 'gitlab')).toThrow(`maximum is ${GITLAB_MAX_CHARS}`)
  })

  it('transliterates Cyrillic titles into valid ASCII slugs', () => {
    expect(transliterateCyrillicToAscii('Исправить таймаут оплаты')).toBe('ispravit taymaut oplaty')
    const slug = asciiSlug('Исправить таймаут при оплате картой в сервисе биллинга')
    expect(slug).toBe('ispravit-taymaut-pri-oplate')
    expect(/^[a-z]+(?:-[a-z0-9]+){0,3}$/.test(slug)).toBe(true)
  })
})
