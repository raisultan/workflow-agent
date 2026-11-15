"""Order quote and discount calculation for POST /api/v1/orders/quote.

TODO (ORD-201): apply promo_code rules from PromoCodeStore in calculate_quote(), and count the use.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from orders.catalog import PromoCodeStore


@dataclass(frozen=True)
class OrderItem:
    sku: str
    unit_price_cents: int
    quantity: int


@dataclass(frozen=True)
class OrderQuoteRequest:
    order_id: str
    items: list[OrderItem]
    promo_code: str | None = None
    now_ms: int | None = None


@dataclass
class OrderQuoteResponse:
    status: int
    body: dict[str, object] = field(default_factory=dict)


class QuoteListener(Protocol):
    def quote_created(self, quote: dict[str, object]) -> None: ...


class OrderPricingService:
    def __init__(self, promo_store: PromoCodeStore, events: QuoteListener | None = None) -> None:
        self._promo_store = promo_store
        self._events = events

    def calculate_quote(self, request: OrderQuoteRequest) -> OrderQuoteResponse:
        subtotal_cents = sum(item.unit_price_cents * item.quantity for item in request.items)

        # TODO (ORD-201): validate and apply request.promo_code via self._promo_store

        body: dict[str, object] = {
            "order_id": request.order_id,
            "subtotal_cents": subtotal_cents,
            "discount_cents": 0,
            "total_cents": subtotal_cents,
        }
        if self._events is not None:
            self._events.quote_created(body)
        return OrderQuoteResponse(status=200, body=body)
