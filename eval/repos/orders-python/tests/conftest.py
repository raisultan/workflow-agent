"""Fixtures over the services the tests run against: Postgres, RabbitMQ and Kafka, as CI provides them."""
from __future__ import annotations

import pytest

from orders.catalog import PromoCodeStore
from orders.db import connect, migrate
from orders.events import QuoteEvents


@pytest.fixture
def conn():
    connection = connect()
    connection.execute("DROP TABLE IF EXISTS promo_codes")
    migrate(connection)
    yield connection
    connection.close()


@pytest.fixture
def store(conn) -> PromoCodeStore:
    return PromoCodeStore(conn)


@pytest.fixture
def events():
    publisher = QuoteEvents()
    yield publisher
    publisher.close()
