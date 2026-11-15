import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromoCodeStore } from '../src/orders/catalog.ts'
import { OrderPricingService } from '../src/orders/pricing.ts'

describe('OrderPricingService', () => {
  it('calculates order quote without a promo code', async () => {
    const store = new PromoCodeStore()
    const service = new OrderPricingService(store)

    const res = await service.calculateQuote({
      orderId: 'ord_500',
      items: [
        { sku: 'BOOK-1', unitPriceCents: 120000, quantity: 2 },
        { sku: 'PEN-3', unitPriceCents: 30000, quantity: 1 },
      ],
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.subtotalCents, 270000)
    assert.equal(res.body.discountCents, 0)
    assert.equal(res.body.totalCents, 270000)
  })
})
