"""Hidden: items_count (s07)."""
from orders.pricing import OrderItem, OrderPricingService, OrderQuoteRequest


def test_items_count_sums_quantities(store) -> None:
    res = OrderPricingService(store).calculate_quote(OrderQuoteRequest(order_id="ord_12", items=[
        OrderItem(sku="A", unit_price_cents=100, quantity=2), OrderItem(sku="B", unit_price_cents=50, quantity=3)]))
    assert res.body["items_count"] == 5


def test_an_empty_order_has_no_items(store) -> None:
    assert OrderPricingService(store).calculate_quote(OrderQuoteRequest(order_id="ord_13", items=[])).body["items_count"] == 0
