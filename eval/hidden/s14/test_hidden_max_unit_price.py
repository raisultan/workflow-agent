"""Hidden: max_unit_price_cents (s14)."""
from orders.pricing import OrderItem, OrderPricingService, OrderQuoteRequest


def test_the_highest_unit_price(store) -> None:
    res = OrderPricingService(store).calculate_quote(OrderQuoteRequest(order_id="ord_41", items=[
        OrderItem(sku="A", unit_price_cents=300, quantity=1), OrderItem(sku="B", unit_price_cents=1200, quantity=2),
        OrderItem(sku="C", unit_price_cents=50, quantity=9)]))
    assert res.body["max_unit_price_cents"] == 1200
    assert res.body["total_cents"] == 3150


def test_zero_for_an_empty_order(store) -> None:
    assert OrderPricingService(store).calculate_quote(OrderQuoteRequest(order_id="ord_42", items=[])).body["max_unit_price_cents"] == 0
