"""Точка входа MCP-сервера seomi-metrika.

Регистрирует read- и write-tools в `FastMCP("seomi-metrika")` и запускает
stdio-транспорт. Entry point — `seomi-metrika-mcp`.
"""

from __future__ import annotations

import asyncio

import structlog
from mcp.server.fastmcp import FastMCP

from seomi_metrika._logging import setup_logging
from seomi_metrika.client import MetrikaClient
from seomi_metrika.settings import MetrikaSettings
from seomi_metrika.tools import (
    get_counter_info,
    get_report,
    goals_write,
    list_counters,
    list_direct_campaigns,
    list_goals,
    save_report,
    segments,
)

logger = structlog.get_logger("seomi_metrika.server")


def build() -> tuple[FastMCP, MetrikaClient]:
    """Собрать FastMCP-сервер со всеми tools.

    Возвращает кортеж `(mcp, client)`. Клиент возвращается отдельно, чтобы
    `main()` мог корректно его закрыть после остановки stdio.
    """
    setup_logging()
    settings = MetrikaSettings()
    client = MetrikaClient(
        oauth_token=settings.oauth_token.get_secret_value(),
        counter_ids=settings.counter_ids,
    )

    mcp = FastMCP(name="seomi-metrika")
    get_counter_info.register(mcp, client)
    list_counters.register(mcp, client)
    list_goals.register(mcp, client)
    get_report.register(mcp, client)
    list_direct_campaigns.register(mcp, client)
    goals_write.register(mcp, client)
    segments.register(mcp, client)
    save_report.register(mcp, client)

    logger.info(
        "seomi-metrika mcp built",
        counter_count=len(settings.counter_ids),
        counter_ids=settings.counter_ids,
        oauth_token_present=True,
        tools=[
            "yandex_metrika_get_counter_info",
            "yandex_metrika_list_counters",
            "yandex_metrika_list_goals",
            "yandex_metrika_get_report",
            "yandex_metrika_list_direct_campaigns",
            "yandex_metrika_create_goal",
            "yandex_metrika_update_goal",
            "yandex_metrika_delete_goal",
            "yandex_metrika_list_segments",
            "yandex_metrika_create_segment",
            "yandex_metrika_update_segment",
            "yandex_metrika_delete_segment",
            "yandex_metrika_save_report",
        ],
    )
    return mcp, client


def main() -> None:
    """Запустить сервер по stdio (entry point для seomi-metrika-mcp)."""
    mcp, client = build()
    try:
        mcp.run()
    finally:
        try:
            asyncio.run(client.aclose())
        except RuntimeError:
            logger.debug("client close skipped: event loop unavailable")


if __name__ == "__main__":
    main()
