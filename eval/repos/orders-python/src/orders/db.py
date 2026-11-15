"""Postgres connection and schema for the promo-code catalog."""
from __future__ import annotations

import os
from pathlib import Path

import psycopg

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/postgres")


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(url or database_url(), autocommit=True)


def migrate(conn: psycopg.Connection) -> None:
    """Applies every migration in order; each is written to be safe to run again."""
    for script in sorted(MIGRATIONS.glob("*.sql")):
        conn.execute(script.read_text())
