/**
 * The labelled reply set (`T9.11`, `A12`), the reading cases (`D12`), and the vocabulary fast path. The fast path decides a gate
 * with no model, so it must never approve, and never cancel, a reply labelled otherwise. `pnpm eval:replies` runs the rest of the set,
 * and the reading cases, against the verdict model.
 */
import { describe, expect, it } from 'vitest'
import { isStandaloneApproval, matchCancel } from '../src/domain/vocabulary.ts'
import { APPROVING, REPLIES, type ReplyLabel } from './fixtures/replies.ts'
import { READINGS } from './fixtures/readings.ts'

const LABELS: readonly ReplyLabel[] = ['approve', 'approve_with_notes', 'request_changes', 'question', 'cancel', 'unrelated', 'unclear']

describe('labelled reply set', () => {
  it('has at least 150 distinct replies, every label in both languages, and some mixed-language ones', () => {
    expect(REPLIES.length).toBeGreaterThanOrEqual(150)
    expect(new Set(REPLIES.map(reply => reply.text.trim().toLowerCase())).size).toBe(REPLIES.length)
    for (const label of LABELS) {
      for (const lang of ['ru', 'en'] as const) {
        expect(REPLIES.filter(reply => reply.label === label && reply.lang === lang).length, `${label}/${lang}`).toBeGreaterThanOrEqual(5)
      }
    }
    expect(REPLIES.filter(reply => reply.lang === 'mixed').length).toBeGreaterThanOrEqual(5)
  })

  it('the vocabulary fast path never approves a reply labelled anything but an approval', () => {
    const wrong = REPLIES.filter(reply => !APPROVING.has(reply.label) && isStandaloneApproval(reply.text)).map(reply => `${reply.label}: ${reply.text}`)
    expect(wrong).toEqual([])
  })

  it('the vocabulary fast path never cancels a reply labelled anything but a cancellation', () => {
    const wrong = REPLIES.filter(reply => reply.label !== 'cancel' && matchCancel(reply.text)).map(reply => `${reply.label}: ${reply.text}`)
    expect(wrong).toEqual([])
  })

  it('the fast path still decides the plain approvals and cancellations it is for, so the model is not asked about them', () => {
    const approvals = REPLIES.filter(reply => isStandaloneApproval(reply.text)).map(reply => reply.text)
    expect(approvals).toEqual(expect.arrayContaining(['ок', 'Согласовано', 'LGTM', 'Approved.', '+1', 'Ship it']))
    const cancels = REPLIES.filter(reply => matchCancel(reply.text)).map(reply => reply.text)
    expect(cancels).toEqual(expect.arrayContaining(['Стоп', 'Отмени задачу', '/cancel duplicate of another ticket']))
  })
})

describe('labelled reading cases (D12)', () => {
  it('covers answers, redirects, questions back and replies with nothing to record, in both languages, and are well-formed', () => {
    expect(READINGS.length).toBeGreaterThanOrEqual(30)
    expect(new Set(READINGS.map(reading => `${reading.items.join('|')}#${reading.answered?.join(',') ?? ''}#${reading.text}`)).size).toBe(READINGS.length)
    for (const lang of ['ru', 'en'] as const) {
      const part = READINGS.filter(reading => reading.lang === lang)
      expect(part.some(reading => reading.expect.answers.length > 0), lang).toBe(true)
      expect(part.some(reading => reading.expect.redirects?.length), lang).toBe(true)
      expect(part.some(reading => reading.expect.question), lang).toBe(true)
      expect(part.some(reading => reading.expect.answers.length === 0 && !reading.expect.question && !reading.expect.redirects), lang).toBe(true)
    }
    for (const reading of READINGS) {
      const items = [...reading.expect.answers, ...reading.expect.redirects?.map(redirect => redirect.item) ?? []]
      // An expected item exists, is still open, and is either answered or redirected, not both.
      expect(items.every(item => item >= 1 && item <= reading.items.length && !reading.answered?.includes(item)), reading.text).toBe(true)
      expect(new Set(items).size, reading.text).toBe(items.length)
    }
  })
})
