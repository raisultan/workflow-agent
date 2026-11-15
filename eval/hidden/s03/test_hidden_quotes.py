"""Hidden: quotes are saved in Postgres, one row per order (s03)."""
from orders.pricing import OrderItem, OrderPricingService, OrderQuoteRequest
from orders.quotes import QuoteRepository


def test_a_quote_is_saved_and_read_back(conn, store) -> None:
    repo = QuoteRepository(conn)
    OrderPricingService(store, quotes=repo).calculate_quote(OrderQuoteRequest(order_id="ord_9", items=[OrderItem(sku="A", unit_price_cents=700, quantity=3)]))
    saved = repo.get("ord_9")
    assert saved is not None
    assert saved["order_id"] == "ord_9"
    assert saved["subtotal_cents"] == 2100
    assert saved["total_cents"] == 2100


def test_a_second_quote_for_the_same_order_replaces_the_first(conn, store) -> None:
    repo = QuoteRepository(conn)
    service = OrderPricingService(store, quotes=repo)
    service.calculate_quote(OrderQuoteRequest(order_id="ord_10", items=[OrderItem(sku="A", unit_price_cents=100, quantity=1)]))
    service.calculate_quote(OrderQuoteRequest(order_id="ord_10", items=[OrderItem(sku="A", unit_price_cents=100, quantity=4)]))
    assert repo.get("ord_10")["total_cents"] == 400
    assert conn.execute("SELECT count(*) FROM quotes WHERE order_id = 'ord_10'").fetchone()[0] == 1


def test_an_unknown_order_has_no_quote(conn) -> None:
    assert QuoteRepository(conn).get("missing") is None
