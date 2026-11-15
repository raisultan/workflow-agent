from orders.catalog import PromoCodeRule
from orders.pricing import OrderItem, OrderPricingService, OrderQuoteRequest


def test_quote_without_a_promo_code(store) -> None:
    service = OrderPricingService(store)
    response = service.calculate_quote(OrderQuoteRequest(order_id="ord_500", items=[
        OrderItem(sku="BOOK-1", unit_price_cents=120000, quantity=2),
        OrderItem(sku="PEN-3", unit_price_cents=30000, quantity=1),
    ]))
    assert response.status == 200
    assert response.body["subtotal_cents"] == 270000
    assert response.body["discount_cents"] == 0
    assert response.body["total_cents"] == 270000


def test_the_store_keeps_codes_case_insensitively_and_counts_uses_up_to_the_limit(store) -> None:
    store.upsert(PromoCodeRule(code=" spring10 ", kind="percent", value=10, expires_at_ms=4_102_444_800_000, max_uses=1))
    assert store.get("SPRING10") == PromoCodeRule(code="SPRING10", kind="percent", value=10, expires_at_ms=4_102_444_800_000, max_uses=1)
    assert store.increment_usage("spring10") is True
    assert store.increment_usage("spring10") is False
    assert store.get("spring10").used_count == 1
    assert store.get("UNKNOWN") is None
