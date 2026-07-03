"""MCP-tool: метаданные настроенных счётчиков (без HTTP)."""

from __future__ import annotations

from typing import Any

import structlog

from seomi_metrika.client import MetrikaClient

logger = structlog.get_logger("seomi_metrika.tools.get_counter_info")


def register(mcp: Any, client: MetrikaClient) -> None:
    """Зарегистрировать tool `yandex_metrika_get_counter_info`."""

    @mcp.tool()  # type: ignore[untyped-decorator]
    def yandex_metrika_get_counter_info() -> dict[str, Any]:
        """Возвращает ВСЕ настроенные счётчики Метрики из `.claude/.env`.

        Список — обычное явление: один рекламный кабинет Директа часто гонит
        трафик на основной сайт и отдельный лендинг, у каждого свой счётчик.
        HTTP-запрос не делается. Значение токена не возвращается — только
        `oauth_token_present` и длина.
        """
        logger.debug("tool get_counter_info called")
        info = client.get_counter_info()
        return info
