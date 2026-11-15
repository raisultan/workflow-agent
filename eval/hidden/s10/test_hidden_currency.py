"""Hidden: currency (s10)."""
from orders.pricing import OrderItem, OrderPricingService, OrderQuoteRequest


def test_the_quote_is_in_rubles(store) -> None:
    res = OrderPricingService(store).calculate_quote(OrderQuoteRequest(order_id="ord_14", items=[OrderItem(sku="A", unit_price_cents=100, quantity=1)]))
    assert res.status == 200
    assert res.body["currency"] == "RUB"
