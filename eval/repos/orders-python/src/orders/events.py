"""Publishes each quote: to RabbitMQ for the billing worker, and to Kafka for analytics."""
from __future__ import annotations

import json
import os

import pika
from confluent_kafka import Producer

QUOTES_QUEUE = "order-quotes"
QUOTES_TOPIC = "order-quotes"


def amqp_url() -> str:
    return os.environ.get("AMQP_URL", "amqp://guest:guest@localhost:5672/")


def kafka_servers() -> str:
    return os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")


class QuoteEvents:
    def __init__(self) -> None:
        self._connection = pika.BlockingConnection(pika.URLParameters(amqp_url()))
        self._channel = self._connection.channel()
        self._channel.queue_declare(queue=QUOTES_QUEUE, durable=True)
        self._producer = Producer({"bootstrap.servers": kafka_servers()})

    def quote_created(self, quote: dict[str, object]) -> None:
        payload = json.dumps(quote, sort_keys=True).encode()
        self._channel.basic_publish(exchange="", routing_key=QUOTES_QUEUE, body=payload,
                                    properties=pika.BasicProperties(content_type="application/json", delivery_mode=2))
        self._producer.produce(QUOTES_TOPIC, key=str(quote["order_id"]).encode(), value=payload)
        self._producer.flush(30)

    def close(self) -> None:
        self._producer.flush(30)
        self._connection.close()
