import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromoCodeStore } from '../../src/orders/catalog.ts'
import { OrderPricingService } from '../../src/orders/pricing.ts'

const quote = (currency?: string) => new OrderPricingService(new PromoCodeStore())
  .calculateQuote({ orderId: 'ord_2', items: [{ sku: 'A', unitPriceCents: 100, quantity: 1 }], ...currency === undefined ? {} : { currency } } as never) as
    Promise<{ status: number; body: Record<string, unknown> }>

describe('currency (hidden, after the review changed it)', () => {
  it('defaults to RUB', async () => {
    const res = await quote()
    assert.equal(res.status, 200)
    assert.equal(res.body.currency, 'RUB')
  })
  it('takes RUB, USD or EUR from the request', async () => {
    for (const currency of ['RUB', 'USD', 'EUR']) assert.equal((await quote(currency)).body.currency, currency)
  })
  it('refuses any other currency', async () => {
    const res = await quote('GBP')
    assert.equal(res.status, 400)
    assert.equal(res.body.error, 'UNSUPPORTED_CURRENCY')
  })
})
