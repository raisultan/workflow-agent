import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromoCodeStore } from '../../src/orders/catalog.ts'
import { OrderPricingService } from '../../src/orders/pricing.ts'

const FAR = 4_102_444_800_000
describe('PromoCodeStore.list (hidden)', () => {
  it('lists codes that have neither expired nor run out, sorted by code', () => {
    const store = new PromoCodeStore() as PromoCodeStore & { list(nowMs: number): { code: string }[] }
    const rule = (code: string, extra: Record<string, number> = {}) => ({ code, kind: 'percent' as const, value: 5, expiresAtMs: FAR, maxUses: 3, usedCount: 0, ...extra })
    store.upsert(rule('zeta'))
    store.upsert(rule(' alpha '))
    store.upsert(rule('OLD', { expiresAtMs: 1_000 }))
    store.upsert(rule('EDGE', { expiresAtMs: 2_000 }))
    store.upsert(rule('SPENT', { usedCount: 3 }))
    assert.deepEqual(store.list(2_000).map(item => item.code), ['ALPHA', 'ZETA'])
    assert.deepEqual(store.list(1_999).map(item => item.code), ['ALPHA', 'EDGE', 'ZETA'])
  })
  it('stores codes trimmed and upper-cased', () => {
    const store = new PromoCodeStore()
    store.upsert({ code: '  spring10 ', kind: 'percent', value: 10, expiresAtMs: FAR, maxUses: 5, usedCount: 0 })
    assert.equal(store.get('SPRING10')?.code, 'SPRING10')
  })
})
