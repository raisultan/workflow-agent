import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromoCodeStore } from '../../src/orders/catalog.ts'
import { OrderPricingService } from '../../src/orders/pricing.ts'

const quote = (cents: number) => new OrderPricingService(new PromoCodeStore())
  .calculateQuote({ orderId: 'ord_4', items: cents ? [{ sku: 'A', unitPriceCents: cents, quantity: 1 }] : [] }) as Promise<{ status: number; body: Record<string, unknown> }>

describe('totalRubles (hidden)', () => {
  it('formats the total in rubles with two decimals', async () => {
    for (const [cents, rubles] of [[270_000, '2700.00'], [999, '9.99'], [5, '0.05'], [100, '1.00']] as const) {
      assert.equal((await quote(cents)).body.totalRubles, rubles, String(cents))
    }
  })
})
