import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromoCodeStore } from '../../src/orders/catalog.ts'
import { OrderPricingService } from '../../src/orders/pricing.ts'

const quote = (items: { sku: string; unitPriceCents: number; quantity: number }[]) =>
  new OrderPricingService(new PromoCodeStore()).calculateQuote({ orderId: 'ord_2', items }) as Promise<{ status: number; body: Record<string, unknown> }>

describe('minimum order (hidden)', () => {
  it('refuses a subtotal under 50000 without sums', async () => {
    const res = await quote([{ sku: 'A', unitPriceCents: 49_999, quantity: 1 }])
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { orderId: 'ord_2', error: 'ORDER_TOO_SMALL' })
  })
  it('allows exactly 50000', async () => {
    const res = await quote([{ sku: 'A', unitPriceCents: 25_000, quantity: 2 }])
    assert.equal(res.status, 200)
    assert.equal(res.body.totalCents, 50_000)
  })
  it('refuses an order with no lines', async () => {
    const res = await quote([])
    assert.equal(res.status, 400)
    assert.equal(res.body.error, 'ORDER_TOO_SMALL')
  })
})
