"""MCP-tools: сегменты аудитории Метрики (list / create / update / delete).

Эндпоинты сверены с офиц. Management API Яндекс.Метрики (ресурс apisegment):
- GET    /management/v1/counter/{id}/apisegment/segments
- POST   /management/v1/counter/{id}/apisegment/segments
- PUT    /management/v1/counter/{id}/apisegment/segment/{segmentId}
- DELETE /management/v1/counter/{id}/apisegment/segment/{segmentId}

Сегменты, созданные через API, НЕ отображаются в веб-интерфейсе Метрики.
Для write нужен OAuth-токен с правом metrika:write.
"""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from pydantic import Field

from seomi_metrika._errors import IntegrationError
from seomi_metrika.client import MetrikaClient

logger = structlog.get_logger("seomi_metrika.tools.segments")

_COUNTER_ID_FIELD = Field(
    description=(
        "ID счётчика. Обязателен, если в `.claude/.env` настроено несколько "
        "счётчиков; при единственном — опционален."
    ),
)
_EXPRESSION_HELP = (
    "Выражение сегментации Метрики, например "
    "\"ym:s:trafficSource=='organic'\" или "
    "\"ym:s:regionCity=='Moscow' AND ym:s:deviceCategory=='mobile'\"."
)


def register(mcp: Any, client: MetrikaClient) -> None:
    """Зарегистрировать tools сегментов."""

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_list_segments(
        counter_id: Annotated[str | None, _COUNTER_ID_FIELD] = None,
    ) -> dict[str, Any]:
        """Список сегментов аудитории, созданных через API.

        Внимание: сегменты, созданные через API, не видны в веб-интерфейсе
        Метрики (только через API).
        """
        logger.debug("tool list_segments called", has_counter_id=counter_id is not None)
        try:
            segments = await client.list_segments(counter_id=counter_id)
            return {
                "segments": [s.model_dump(mode="json") for s in segments],
                "count": len(segments),
            }
        except IntegrationError as e:
            logger.warning("tool list_segments integration error", code=e.code, status=e.status)
            return e.to_dict()

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_create_segment(
        name: Annotated[
            str,
            Field(min_length=1, max_length=255, description="Название сегмента."),
        ],
        expression: Annotated[str, Field(description=_EXPRESSION_HELP)],
        counter_id: Annotated[str | None, _COUNTER_ID_FIELD] = None,
    ) -> dict[str, Any]:
        """Создать сегмент аудитории (write).

        Требуется OAuth-токен с правом metrika:write. Возвращает созданный
        сегмент с присвоенным `segment_id`.
        """
        logger.debug(
            "tool create_segment called",
            has_counter_id=counter_id is not None,
        )
        try:
            segment = await client.create_segment(name, expression, counter_id=counter_id)
            return {"segment": segment.model_dump(mode="json")}
        except IntegrationError as e:
            logger.warning("tool create_segment integration error", code=e.code, status=e.status)
            return e.to_dict()

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_update_segment(
        segment_id: Annotated[int, Field(description="ID изменяемого сегмента.")],
        name: Annotated[
            str | None,
            Field(description="Новое название (опционально)."),
        ] = None,
        expression: Annotated[
            str | None,
            Field(description=f"Новое {_EXPRESSION_HELP} (опционально)."),
        ] = None,
        counter_id: Annotated[str | None, _COUNTER_ID_FIELD] = None,
    ) -> dict[str, Any]:
        """Изменить сегмент (write). Передай `name` и/или `expression`."""
        logger.debug(
            "tool update_segment called",
            segment_id=segment_id,
            has_name=name is not None,
            has_expression=expression is not None,
        )
        try:
            segment = await client.update_segment(
                segment_id,
                name=name,
                expression=expression,
                counter_id=counter_id,
            )
            return {"segment": segment.model_dump(mode="json")}
        except IntegrationError as e:
            logger.warning("tool update_segment integration error", code=e.code, status=e.status)
            return e.to_dict()

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_delete_segment(
        segment_id: Annotated[int, Field(description="ID удаляемого сегмента.")],
        counter_id: Annotated[str | None, _COUNTER_ID_FIELD] = None,
    ) -> dict[str, Any]:
        """Удалить сегмент (write). Операция необратима."""
        logger.debug("tool delete_segment called", segment_id=segment_id)
        try:
            return await client.delete_segment(segment_id, counter_id=counter_id)
        except IntegrationError as e:
            logger.warning("tool delete_segment integration error", code=e.code, status=e.status)
            return e.to_dict()
