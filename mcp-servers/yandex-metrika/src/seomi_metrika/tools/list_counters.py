"""MCP-tool: список счётчиков, доступных по OAuth-токену."""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from pydantic import Field

from seomi_metrika._errors import IntegrationError
from seomi_metrika.client import MetrikaClient

logger = structlog.get_logger("seomi_metrika.tools.list_counters")


def register(mcp: Any, client: MetrikaClient) -> None:
    """Зарегистрировать tool `yandex_metrika_list_counters`."""

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_list_counters(
        per_page: Annotated[
            int,
            Field(ge=1, le=1000, description="Размер страницы (1-1000)."),
        ] = 100,
        offset: Annotated[
            int,
            Field(ge=1, description="Смещение пагинации (отсчёт с 1)."),
        ] = 1,
        search_string: Annotated[
            str | None,
            Field(description="Подстрока для фильтрации по названию счётчика."),
        ] = None,
    ) -> dict[str, Any]:
        """Все счётчики Метрики, доступные по текущему OAuth-токену.

        Поле `configured_ids` дублирует список из `.claude/.env`, чтобы агент
        мог сразу сопоставить «какой из этих счётчиков сейчас активен у нас».
        """
        logger.debug(
            "tool list_counters called",
            per_page=per_page,
            offset=offset,
            has_search=search_string is not None,
        )
        try:
            counters = await client.list_counters(
                per_page=per_page,
                offset=offset,
                search_string=search_string,
            )
            return {
                "counters": [c.model_dump(mode="json") for c in counters],
                "count": len(counters),
                "configured_ids": client.get_counter_info()["counter_ids"],
            }
        except IntegrationError as e:
            logger.warning("tool list_counters integration error", code=e.code, status=e.status)
            return e.to_dict()
