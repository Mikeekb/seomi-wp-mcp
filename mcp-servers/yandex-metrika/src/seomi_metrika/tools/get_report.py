"""MCP-tool: универсальный отчёт Метрики `/stat/v1/data`."""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from pydantic import Field

from seomi_metrika._errors import IntegrationError
from seomi_metrika.client import MetrikaClient

logger = structlog.get_logger("seomi_metrika.tools.get_report")


def register(mcp: Any, client: MetrikaClient) -> None:
    """Зарегистрировать tool `yandex_metrika_get_report`."""

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_get_report(
        metrics: Annotated[
            list[str],
            Field(
                description=(
                    "Имена метрик с префиксом namespace. Сессии (`ym:s:`): "
                    "'ym:s:visits', 'ym:s:users', 'ym:s:pageviews', "
                    "'ym:s:bounceRate', 'ym:s:avgPageViews', "
                    "'ym:s:avgVisitDurationSeconds', 'ym:s:goal<ID>visits', "
                    "'ym:s:goal<ID>conversionRate', 'ym:s:goal<ID>reaches', "
                    "'ym:s:goal<ID>revenue'. Хиты (`ym:pv:`): 'ym:pv:pageviews'. "
                    "ЗАПРЕЩЕНО смешивать `ym:s:` и `ym:pv:` в одном запросе."
                ),
            ),
        ],
        date1: Annotated[
            str,
            Field(
                description=(
                    "Начало периода: 'YYYY-MM-DD', либо 'today'/'yesterday'/"
                    "'NdaysAgo' (например '7daysAgo')."
                ),
            ),
        ],
        date2: Annotated[
            str,
            Field(
                description=(
                    "Конец периода в том же формате, что и `date1`. По умолчанию "
                    "у Метрики — 'today'."
                ),
            ),
        ],
        dimensions: Annotated[
            list[str] | None,
            Field(
                description=(
                    "Срезы отчёта в том же namespace, что и metrics. Популярные: "
                    "'ym:s:trafficSource', 'ym:s:lastTrafficSource', "
                    "'ym:s:<attr>UTMSource', 'ym:s:<attr>UTMMedium', "
                    "'ym:s:<attr>UTMCampaign', 'ym:s:datePeriodday', "
                    "'ym:s:regionCity', 'ym:s:deviceCategory'."
                ),
            ),
        ] = None,
        filters: Annotated[
            str | None,
            Field(
                description=(
                    "Выражение фильтра Метрики (`ym:s:trafficSource=='organic'`, "
                    "поддерживает AND/OR/EXISTS, см. справку API)."
                ),
            ),
        ] = None,
        sort: Annotated[
            str | None,
            Field(
                description=(
                    "Колонка сортировки, например 'ym:s:visits' или '-ym:s:visits' для убывания."
                ),
            ),
        ] = None,
        limit: Annotated[
            int,
            Field(ge=1, le=100_000, description="Количество строк (1-100000)."),
        ] = 100,
        offset: Annotated[
            int,
            Field(ge=1, description="Смещение пагинации (отсчёт с 1)."),
        ] = 1,
        accuracy: Annotated[
            str | None,
            Field(description="Управление сэмплированием ('full', '0.1', и т.п.)."),
        ] = None,
        preset: Annotated[
            str | None,
            Field(
                description=("Имя пресета Метрики (например 'sources_summary', 'tech_platforms')."),
            ),
        ] = None,
        counter_ids: Annotated[
            list[str] | None,
            Field(
                description=(
                    "Подмножество настроенных counter_ids. По умолчанию "
                    "используются ВСЕ из `METRIKA_COUNTER_ID` — Метрика "
                    "нативно мержит их через `ids=<id1>,<id2>`. Чтобы "
                    "посчитать по одному счётчику — передай "
                    "`counter_ids=['43286099']`."
                ),
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Произвольный аналитический отчёт Яндекс.Метрики.

        По умолчанию агрегирует ВСЕ настроенные счётчики из `.claude/.env`
        (типовой кейс — основной сайт + рекламный лендинг на одной кампании).
        Для разреза по одному счётчику передай `counter_ids` явно.
        """
        logger.debug(
            "tool get_report called",
            metrics_count=len(metrics),
            dimensions_count=len(dimensions or []),
            date1=date1,
            date2=date2,
            has_filters=filters is not None,
            has_preset=preset is not None,
            counter_ids_override=counter_ids,
        )
        try:
            report = await client.get_report(
                metrics=metrics,
                date1=date1,
                date2=date2,
                dimensions=dimensions,
                filters=filters,
                sort=sort,
                limit=limit,
                offset=offset,
                accuracy=accuracy,
                preset=preset,
                counter_ids=counter_ids,
            )
            effective_ids = (
                counter_ids if counter_ids is not None else client.get_counter_info()["counter_ids"]
            )
            return {
                "report": report.model_dump(mode="json"),
                "counter_ids": effective_ids,
            }
        except IntegrationError as e:
            logger.warning("tool get_report integration error", code=e.code, status=e.status)
            return e.to_dict()
