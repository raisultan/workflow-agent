"""Hidden: the bulk discount, rounded per line, and invalid items (s04)."""
from orders.pricing import OrderItem, OrderPricingService, OrderQuoteRequest


def quote(store, *items):
    return OrderPricingService(store).calculate_quote(OrderQuoteRequest(order_id="ord_11", items=list(items)))


def test_ten_or_more_get_ten_percent_rounded_down_per_line(store) -> None:
    res = quote(store, OrderItem(sku="A", unit_price_cents=103, quantity=11), OrderItem(sku="B", unit_price_cents=107, quantity=11))
    assert res.status == 200
    assert res.body["subtotal_cents"] == 2310
    assert res.body["discount_cents"] == 113 + 117
    assert res.body["total_cents"] == 2310 - 230


def test_exactly_ten_qualifies_and_nine_does_not(store) -> None:
    assert quote(store, OrderItem(sku="A", unit_price_cents=100, quantity=10)).body["discount_cents"] == 100
    assert quote(store, OrderItem(sku="A", unit_price_cents=100, quantity=9)).body["discount_cents"] == 0


def test_a_free_line_is_allowed(store) -> None:
    res = quote(store, OrderItem(sku="GIFT", unit_price_cents=0, quantity=20))
    assert res.status == 200
    assert res.body["total_cents"] == 0


def test_invalid_items_are_refused(store) -> None:
    for item in (OrderItem(sku="A", unit_price_cents=100, quantity=0), OrderItem(sku="A", unit_price_cents=100, quantity=-1),
                 OrderItem(sku="A", unit_price_cents=-5, quantity=1)):
        res = quote(store, OrderItem(sku="OK", unit_price_cents=100, quantity=1), item)
        assert res.status == 400
        assert res.body["error"] == "INVALID_ITEM"
        assert "total_cents" not in res.body
