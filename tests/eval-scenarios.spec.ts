/** The eval's scenarios in English (`--locale en`, `D14`): the four the release is checked with have one, and it replaces the text. */
import { describe, expect, it } from 'vitest'
import { inEnglish, SCENARIOS } from '../eval/scenarios.ts'

describe('the eval in English', () => {
  it('has English versions of s01, s02, s03 and s06 that replace the ticket, facts, approvals and review', () => {
    const byId = (id: string) => inEnglish(SCENARIOS.find(scenario => scenario.id === id)!)
    for (const id of ['s01', 's02', 's03', 's06']) {
      const scenario = byId(id)
      expect([scenario.ticket.summary, scenario.ticket.description, scenario.facts, ...scenario.approvals ?? [], scenario.review ?? ''].join(' '))
        .not.toMatch(/[А-Яа-яЁё]/u)
      expect(scenario).not.toHaveProperty('en')
    }
    // The sarcasm that must not approve is English of its own, and the plan is then approved with "ok".
    expect(byId('s01').approvals).toEqual([expect.stringContaining('🙄'), 'ok'])
    expect(byId('s06').review).toContain('UNSUPPORTED_CURRENCY')
    expect(() => inEnglish(SCENARIOS.find(scenario => scenario.id === 's05')!)).toThrow('has no English version')
  })
})
