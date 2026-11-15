# Order pricing service (Python, synthetic)

The Python version of the eval's synthetic order-pricing service. Promo codes live in Postgres (`migrations/`), and each quote is
published to RabbitMQ (queue `order-quotes`, for billing) and Kafka (topic `order-quotes`, for analytics).
`OrderPricingService.calculate_quote` does not apply promo codes yet (`ORD-201` in the mock Jira).

Python is pinned in `.python-version`; `python -m pip install -r requirements-dev.txt` installs the test tools, and
`python -m pytest -q` runs the suite against the services named by `DATABASE_URL`, `AMQP_URL` and `KAFKA_BOOTSTRAP_SERVERS`
(defaults: Postgres, RabbitMQ and Kafka on localhost, as `.gitlab-ci.yml` provides them in CI).
