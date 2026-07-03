"""Настройка structlog в JSON-формате с уровнем из LOG_LEVEL.

Инлайн-порт lk_core.logging. Никогда не логировать значения токенов — только
факт наличия и длину.
"""

from __future__ import annotations

import logging
import os

import structlog


def setup_logging(level: str | None = None) -> None:
    """Сконфигурировать structlog и стандартный logging.

    Уровень берётся из аргумента → ENV `LOG_LEVEL` → "INFO". Все логи идут в
    JSON-формате, чтобы агенту/оператору было удобно парсить.
    """
    resolved = (level or os.getenv("LOG_LEVEL") or "INFO").upper()
    numeric = getattr(logging, resolved, logging.INFO)

    logging.basicConfig(
        format="%(message)s",
        level=numeric,
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(numeric),
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    structlog.get_logger("seomi_metrika").info("logging configured", level=resolved)
