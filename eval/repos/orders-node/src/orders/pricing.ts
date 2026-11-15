/**
 * Order quote & discount calculation service for POST /api/v1/orders/quote.
 *
 * TODO (ORD-201): Apply promoCode rules from PromoCodeStore in calculateQuote().
 */
import { PromoCodeStore } from './catalog.ts'

export interface OrderItem {
  sku: string
  unitPriceCents: number
  quantity: number
}

export interface OrderQuoteRequest {
  orderId: string
  items: OrderItem[]
  promoCode?: string
  nowMs?: number
}

export interface OrderQuoteResponse {
  status: number
  body: {
    orderId: string
    subtotalCents?: number
    discountCents?: number
    totalCents?: number
    appliedPromoCode?: string
    error?: string
  }
}

export class OrderPricingService {
  private readonly promoStore: PromoCodeStore

  constructor(promoStore: PromoCodeStore) {
    this.promoStore = promoStore
  }

  async calculateQuote(req: OrderQuoteRequest): Promise<OrderQuoteResponse> {
    const subtotalCents = req.items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    )

    // TODO (ORD-201): Validate and apply req.promoCode via this.promoStore
    void this.promoStore

    return {
      status: 200,
      body: {
        orderId: req.orderId,
        subtotalCents,
        discountCents: 0,
        totalCents: subtotalCents,
      },
    }
  }
}
