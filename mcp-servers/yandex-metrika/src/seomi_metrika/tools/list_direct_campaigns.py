"""MCP-tool: список Direct campaign IDs со счётчика с метриками за период."""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from pydantic import Field

from seomi_metrika._errors import IntegrationError
from seomi_metrika.client import MetrikaClient

logger = structlog.get_logger("seomi_metrika.tools.list_direct_campaigns")


def register(mcp: Any, client: MetrikaClient) -> None:
    """Зарегистрировать tool `yandex_metrika_list_direct_campaigns`."""

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_list_direct_campaigns(
        date1: Annotated[
            str,
            Field(
                description=(
                    "Начало периода: 'YYYY-MM-DD', либо 'today'/'yesterday'/"
                    "'NdaysAgo'."
                ),
            ),
        ],
        date2: Annotated[
            str,
            Field(description="Конец периода в том же формате, что и `date1`."),
        ],
        counter_ids: Annotated[
            list[str] | None,
            Field(
                description=(
                    "Подмножество настроенных counter_ids. По умолчанию — все "
                    "из `METRIKA_COUNTER_ID`. Один Direct-аккаунт обычно "
                    "подключён только к одному счётчику, поэтому при запросе "
                    "по конкретному кабинету полезно сужать."
                ),
            ),
        ] = None,
        with_utm_campaign: Annotated[
            bool,
            Field(
                description=(
                    "Дополнительно вытащить `ym:s:lastsignUTMCampaign` — "
                    "человекочитаемое имя кампании из utm-метки."
                ),
            ),
        ] = True,
        goal_id: Annotated[
            int | None,
            Field(
                description=(
                    "ID цели Метрики — если задан, дополнительно вернётся "
                    "`ym:s:goal<ID>users` (уникальные пользователи, дошедшие "
                    "до цели) по каждой кампании."
                ),
            ),
        ] = None,
        limit: Annotated[
            int,
            Field(ge=1, le=10_000, description="Строк в ответе (1-10000)."),
        ] = 100,
        offset: Annotated[
            int,
            Field(ge=1, description="Смещение пагинации (отсчёт с 1)."),
        ] = 1,
    ) -> dict[str, Any]:
        """Список Direct campaign IDs со счётчика с базовыми метриками.

        Покрывает кейс «у нас несколько рекламных кабинетов на одном
        счётчике — какие кампании наши, какие чужие». Ключ — `ym:s:firstDirectID`
        (ID кампании Директа, формат `N-<int>`).
        """
        dimensions: list[str] = ["ym:s:firstDirectID"]
        if with_utm_campaign:
            dimensions.append("ym:s:lastsignUTMCampaign")
        metrics: list[str] = ["ym:s:visits", "ym:s:users"]
        if goal_id is not None:
            metrics.append(f"ym:s:goal{goal_id}users")

        logger.debug(
            "tool list_direct_campaigns called",
            date1=date1,
            date2=date2,
            counter_ids_override=counter_ids,
            with_utm_campaign=with_utm_campaign,
            has_goal_id=goal_id is not None,
            limit=limit,
            offset=offset,
        )
        try:
            report = await client.get_report(
                metrics=metrics,
                date1=date1,
                date2=date2,
                dimensions=dimensions,
                sort="-ym:s:visits",
                limit=limit,
                offset=offset,
                counter_ids=counter_ids,
            )
            effective_ids = (
                counter_ids
                if counter_ids is not None
                else client.get_counter_info()["counter_ids"]
            )
            return {
                "report": report.model_dump(mode="json"),
                "counter_ids": effective_ids,
                "dimensions": dimensions,
                "metrics": metrics,
            }
        except IntegrationError as e:
            logger.warning(
                "tool list_direct_campaigns integration error",
                code=e.code,
                status=e.status,
            )
            return e.to_dict()
