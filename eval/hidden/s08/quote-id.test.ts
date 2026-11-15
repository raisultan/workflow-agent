import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromoCodeStore } from '../../src/orders/catalog.ts'
import { OrderPricingService } from '../../src/orders/pricing.ts'

import { readFileSync } from 'node:fs'
const quote = () => new OrderPricingService(new PromoCodeStore())
  .calculateQuote({ orderId: 'ord_3', items: [{ sku: 'A', unitPriceCents: 100, quantity: 1 }] }) as Promise<{ status: number; body: Record<string, unknown> }>

describe('quoteId (hidden)', () => {
  it('is a version 4 UUID, different for every quote', async () => {
    const [a, b] = [await quote(), await quote()]
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    assert.match(String(a.body.quoteId), v4)
    assert.match(String(b.body.quoteId), v4)
    assert.notEqual(a.body.quoteId, b.body.quoteId)
  })
  it('comes from the uuid package, declared as a dependency', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> }
    assert.ok(pkg.dependencies?.uuid, 'uuid is in dependencies')
  })
})
