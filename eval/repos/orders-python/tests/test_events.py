import json

import pika
from confluent_kafka import Consumer

from orders.events import QUOTES_QUEUE, QUOTES_TOPIC, amqp_url, kafka_servers
from orders.pricing import OrderItem, OrderPricingService, OrderQuoteRequest


def test_a_quote_is_published_to_the_billing_queue_and_the_analytics_topic(store, events) -> None:
    service = OrderPricingService(store, events)
    service.calculate_quote(OrderQuoteRequest(order_id="ord_700", items=[OrderItem(sku="BOOK-1", unit_price_cents=5000, quantity=3)]))

    connection = pika.BlockingConnection(pika.URLParameters(amqp_url()))
    try:
        method, _properties, body = connection.channel().basic_get(queue=QUOTES_QUEUE, auto_ack=True)
    finally:
        connection.close()
    assert method is not None
    assert json.loads(body)["total_cents"] == 15000

    consumer = Consumer({"bootstrap.servers": kafka_servers(), "group.id": "tests", "auto.offset.reset": "earliest"})
    try:
        consumer.subscribe([QUOTES_TOPIC])
        message = None
        for _ in range(60):
            message = consumer.poll(1.0)
            if message is not None and message.error() is None:
                break
    finally:
        consumer.close()
    assert message is not None and message.error() is None
    assert message.key() == b"ord_700"
    assert json.loads(message.value())["order_id"] == "ord_700"
