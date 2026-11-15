import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromoCodeStore } from '../../src/orders/catalog.ts'
import { OrderPricingService } from '../../src/orders/pricing.ts'

const FAR = 4_102_444_800_000
const setup = (rules: Record<string, unknown>[]) => {
  const store = new PromoCodeStore()
  for (const rule of rules) store.upsert({ kind: 'percent', value: 10, expiresAtMs: FAR, maxUses: 10, usedCount: 0, ...rule } as never)
  return { store, service: new OrderPricingService(store) }
}
const quote = async (service: OrderPricingService, subtotal: number, promoCode?: string, nowMs = 1_000) =>
  await service.calculateQuote({ orderId: 'ord_7', items: [{ sku: 'A', unitPriceCents: subtotal, quantity: 1 }], promoCode, nowMs }) as
    { status: number; body: Record<string, unknown> }

describe('promo codes (hidden)', () => {
  it('rounds a percent discount down', async () => {
    const { service } = setup([{ code: 'P15', value: 15 }])
    const res = await quote(service, 999, 'P15')
    assert.equal(res.status, 200)
    assert.equal(res.body.discountCents, 149)
    assert.equal(res.body.totalCents, 850)
    assert.equal(res.body.appliedPromoCode, 'P15')
  })
  it('caps a fixed discount at the subtotal', async () => {
    const { service } = setup([{ code: 'FIX', kind: 'fixed', value: 50_000 }])
    const res = await quote(service, 30_000, 'FIX')
    assert.equal(res.status, 200)
    assert.equal(res.body.discountCents, 30_000)
    assert.equal(res.body.totalCents, 0)
  })
  it('matches a code without case or surrounding spaces', async () => {
    const { service } = setup([{ code: 'WINTER25', value: 25 }])
    const res = await quote(service, 1_000, '  winter25 ')
    assert.equal(res.status, 200)
    assert.equal(res.body.discountCents, 250)
    assert.equal(res.body.appliedPromoCode, 'WINTER25')
  })
  it('refuses unknown, expired, exhausted and too-small orders with their codes, in that order', async () => {
    const { service } = setup([{ code: 'OLD', expiresAtMs: 1_000 }, { code: 'USED', maxUses: 1, usedCount: 1 }, { code: 'BIG', minOrderCents: 300_000 },
      { code: 'ALL', expiresAtMs: 1_000, maxUses: 1, usedCount: 1, minOrderCents: 300_000 }])
    for (const [code, error] of [['NOPE', 'INVALID_PROMO_CODE'], ['OLD', 'PROMO_CODE_EXPIRED'], ['USED', 'PROMO_CODE_EXHAUSTED'],
      ['BIG', 'PROMO_MIN_ORDER_NOT_MET'], ['ALL', 'PROMO_CODE_EXPIRED']] as const) {
      const res = await quote(service, 150_000, code, 1_000)
      assert.equal(res.status, 400, code)
      assert.equal(res.body.error, error, code)
    }
  })
  it('does not count a use when it quotes', async () => {
    const { store, service } = setup([{ code: 'ONCE', maxUses: 1 }])
    assert.equal((await quote(service, 1_000, 'ONCE')).status, 200)
    assert.equal(store.get('ONCE')?.usedCount, 0)
    assert.equal((await quote(service, 1_000, 'ONCE')).status, 200)
  })
  it('quotes without a discount when no code is given', async () => {
    const { service } = setup([])
    const res = await quote(service, 1_000, undefined)
    assert.equal(res.status, 200)
    assert.equal(res.body.discountCents, 0)
    assert.equal(res.body.totalCents, 1_000)
  })
})
