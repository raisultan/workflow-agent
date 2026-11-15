import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromoCodeStore } from '../../src/orders/catalog.ts'
import { OrderPricingService } from '../../src/orders/pricing.ts'

const quote = (items: { sku: string; unitPriceCents: number; quantity: number }[]) =>
  new OrderPricingService(new PromoCodeStore()).calculateQuote({ orderId: 'ord_3', items }) as Promise<{ status: number; body: Record<string, unknown> }>

describe('lineCount (hidden)', () => {
  it('counts the lines, not the units', async () => {
    const res = await quote([{ sku: 'A', unitPriceCents: 100, quantity: 5 }, { sku: 'B', unitPriceCents: 50, quantity: 1 }])
    assert.equal(res.body.lineCount, 2)
    assert.equal(res.body.totalCents, 550)
  })
  it('is zero for an order with no lines', async () => {
    assert.equal((await quote([])).body.lineCount, 0)
  })
})
