"""Базовый httpx.AsyncClient под нужды MCP-сервера Метрики.

Инлайн-порт lk_core.http. TLS-проверка включена всегда (`verify=True`).
"""

from __future__ import annotations

import httpx
import structlog

logger = structlog.get_logger("seomi_metrika.http")

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_CONNECT_TIMEOUT_SECONDS = 10.0


def build_async_client(
    base_url: str,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT_SECONDS,
) -> httpx.AsyncClient:
    """Создать настроенный httpx.AsyncClient.

    TLS-проверка включена всегда (`verify=True`). Retry с backoff для 429/5xx
    должен реализовываться на стороне вызывающего client.py, здесь — только
    базовый клиент без retry-transport.
    """
    merged_headers = {"User-Agent": "seomi-metrika-mcp/0.1", **(headers or {})}
    client = httpx.AsyncClient(
        base_url=base_url,
        headers=merged_headers,
        timeout=httpx.Timeout(timeout, connect=connect_timeout),
        verify=True,
    )
    logger.debug(
        "http client built",
        base_url=base_url,
        timeout=timeout,
        header_keys=sorted(merged_headers.keys()),
    )
    return client
