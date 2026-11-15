import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromoCodeStore } from '../../src/orders/catalog.ts'
import { OrderPricingService } from '../../src/orders/pricing.ts'

const quote = (items: { sku: string; unitPriceCents: number; quantity: number }[]) =>
  new OrderPricingService(new PromoCodeStore()).calculateQuote({ orderId: 'ord_1', items }) as Promise<{ status: number; body: Record<string, unknown> }>

describe('itemCount (hidden)', () => {
  it('sums the quantities of every line', async () => {
    const res = await quote([{ sku: 'A', unitPriceCents: 100, quantity: 2 }, { sku: 'B', unitPriceCents: 50, quantity: 3 }])
    assert.equal(res.body.itemCount, 5)
    assert.equal(res.body.subtotalCents, 350)
    assert.equal(res.body.totalCents, 350)
  })
  it('is zero for an order with no lines', async () => {
    assert.equal((await quote([])).body.itemCount, 0)
  })
})
