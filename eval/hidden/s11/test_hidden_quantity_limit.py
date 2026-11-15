"""Hidden: the per-line quantity limit (s11)."""
from orders.pricing import OrderItem, OrderPricingService, OrderQuoteRequest


def quote(store, *quantities: int):
    items = [OrderItem(sku=f"S{n}", unit_price_cents=100, quantity=quantity) for n, quantity in enumerate(quantities)]
    return OrderPricingService(store).calculate_quote(OrderQuoteRequest(order_id="ord_31", items=items))


def test_a_line_over_the_limit_is_refused_without_sums(store) -> None:
    res = quote(store, 2, 101)
    assert res.status == 400
    assert res.body == {"order_id": "ord_31", "error": "QUANTITY_LIMIT_EXCEEDED"}


def test_exactly_the_limit_is_allowed(store) -> None:
    res = quote(store, 100)
    assert res.status == 200
    assert res.body["subtotal_cents"] == 10000


def test_the_limit_is_per_line_not_per_order(store) -> None:
    res = quote(store, 60, 60)
    assert res.status == 200
    assert res.body["total_cents"] == 12000
