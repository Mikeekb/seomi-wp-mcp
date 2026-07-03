"""MCP-tool: цели одного счётчика Метрики."""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from pydantic import Field

from seomi_metrika._errors import IntegrationError
from seomi_metrika.client import MetrikaClient

logger = structlog.get_logger("seomi_metrika.tools.list_goals")


def register(mcp: Any, client: MetrikaClient) -> None:
    """Зарегистрировать tool `yandex_metrika_list_goals`."""

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_list_goals(
        counter_id: Annotated[
            str | None,
            Field(
                description=(
                    "ID счётчика. Передавай явно, если в `.claude/.env` "
                    "несколько счётчиков (например, основной сайт + лендинг). "
                    "Иначе вернётся BadRequest('ambiguous: ...'). При "
                    "единственном настроенном счётчике параметр опционален."
                ),
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Цели одного счётчика Метрики.

        Нужно, чтобы построить метрики вида `ym:s:goal<ID>visits` /
        `ym:s:goal<ID>conversionRate` / `ym:s:goal<ID>reaches` для
        `yandex_metrika_get_report`.
        """
        logger.debug(
            "tool list_goals called",
            has_counter_id=counter_id is not None,
        )
        try:
            goals = await client.list_goals(counter_id=counter_id)
            # Резолвим counter_id повторно, чтобы вернуть агенту фактический ID
            # (важно при единственном настроенном — он мог не передавать аргумент).
            resolved = (
                counter_id
                if counter_id is not None
                else client.get_counter_info()["counter_ids"][0]
            )
            return {
                "goals": [g.model_dump(mode="json") for g in goals],
                "count": len(goals),
                "counter_id": resolved,
            }
        except IntegrationError as e:
            logger.warning("tool list_goals integration error", code=e.code, status=e.status)
            return e.to_dict()
