"""Promo code catalog and usage store, in Postgres."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import psycopg
from psycopg.rows import class_row


@dataclass(frozen=True)
class PromoCodeRule:
    code: str
    kind: Literal["percent", "fixed"]
    # For "percent": 1..100; for "fixed": the discount in cents.
    value: int
    expires_at_ms: int
    max_uses: int
    used_count: int = 0
    min_order_cents: int | None = None


class PromoCodeStore:
    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def upsert(self, rule: PromoCodeRule) -> None:
        self._conn.execute(
            """
            INSERT INTO promo_codes (code, kind, value, expires_at_ms, max_uses, used_count, min_order_cents)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (code) DO UPDATE SET kind = EXCLUDED.kind, value = EXCLUDED.value, expires_at_ms = EXCLUDED.expires_at_ms,
                max_uses = EXCLUDED.max_uses, used_count = EXCLUDED.used_count, min_order_cents = EXCLUDED.min_order_cents
            """,
            (rule.code.strip().upper(), rule.kind, rule.value, rule.expires_at_ms, rule.max_uses, rule.used_count, rule.min_order_cents),
        )

    def get(self, code: str) -> PromoCodeRule | None:
        with self._conn.cursor(row_factory=class_row(PromoCodeRule)) as cursor:
            cursor.execute(
                "SELECT code, kind, value, expires_at_ms, max_uses, used_count, min_order_cents FROM promo_codes WHERE code = %s",
                (code.strip().upper(),),
            )
            return cursor.fetchone()

    def increment_usage(self, code: str) -> bool:
        """Counts one use, unless the code is unknown or already used up."""
        cursor = self._conn.execute(
            "UPDATE promo_codes SET used_count = used_count + 1 WHERE code = %s AND used_count < max_uses",
            (code.strip().upper(),),
        )
        return cursor.rowcount == 1
