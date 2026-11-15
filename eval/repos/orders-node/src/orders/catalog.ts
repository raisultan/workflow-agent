/**
 * In-memory promo code catalog and usage store.
 */
export interface PromoCodeRule {
  code: string
  kind: 'percent' | 'fixed'
  /** For 'percent': 1..100; for 'fixed': discount amount in cents. */
  value: number
  minOrderCents?: number
  expiresAtMs: number
  maxUses: number
  usedCount: number
}

export class PromoCodeStore {
  private readonly codes = new Map<string, PromoCodeRule>()

  upsert(rule: PromoCodeRule): void {
    this.codes.set(rule.code.toUpperCase(), { ...rule, code: rule.code.toUpperCase() })
  }

  get(code: string): PromoCodeRule | undefined {
    return this.codes.get(code.trim().toUpperCase())
  }

  incrementUsage(code: string): boolean {
    const rule = this.get(code)
    if (!rule) return false
    rule.usedCount += 1
    return true
  }
}
