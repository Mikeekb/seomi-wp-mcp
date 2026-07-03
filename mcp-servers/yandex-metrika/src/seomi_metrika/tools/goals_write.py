"""MCP-tools: создание / изменение / удаление целей Метрики (write).

Эндпоинты сверены с офиц. Management API Яндекс.Метрики:
- POST   /management/v1/counter/{id}/goals
- PUT    /management/v1/counter/{id}/goal/{goalId}
- DELETE /management/v1/counter/{id}/goal/{goalId}

Для write-операций нужен OAuth-токен с правом редактирования счётчика.
"""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from pydantic import Field

from seomi_metrika._errors import IntegrationError
from seomi_metrika.client import MetrikaClient

logger = structlog.get_logger("seomi_metrika.tools.goals_write")

# Допустимые типы целей (13 значений, свернуто с OpenAPI Management API).
GOAL_TYPES = (
    "action, chat, email, file, messenger, number, payment_system, phone, "
    "search, social, step, url, visit_duration"
)
# Типы условий цели.
CONDITION_TYPES = (
    "contain, exact, start, regexp, action, messenger, all_files, file, "
    "search, all_social, social, regexp_action, contain_action"
)

_COUNTER_ID_FIELD = Field(
    description=(
        "ID счётчика. Обязателен, если в `.claude/.env` настроено несколько "
        "счётчиков; при единственном — опционален."
    ),
)


def register(mcp: Any, client: MetrikaClient) -> None:
    """Зарегистрировать write-tools целей."""

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_create_goal(
        name: Annotated[
            str,
            Field(min_length=1, max_length=255, description="Название цели (1-255 символов)."),
        ],
        type: Annotated[
            str,
            Field(description=f"Тип цели. Допустимые значения: {GOAL_TYPES}."),
        ],
        conditions: Annotated[
            list[dict[str, Any]] | None,
            Field(
                description=(
                    "Условия срабатывания цели: список объектов "
                    "`{'type': <тип условия>, 'url': <значение>}`. Типы условий: "
                    f"{CONDITION_TYPES}. Пример для url-цели: "
                    "[{'type': 'contain', 'url': '/thanks'}]. Для messenger-цели: "
                    "[{'type': 'messenger', 'url': 'whatsapp'}]."
                ),
            ),
        ] = None,
        counter_id: Annotated[str | None, _COUNTER_ID_FIELD] = None,
        default_price: Annotated[
            float | None,
            Field(description="Ценность цели (для e-commerce отчётов)."),
        ] = None,
        is_retargeting: Annotated[
            bool | None,
            Field(description="Использовать цель для ретаргетинга."),
        ] = None,
        flag: Annotated[
            str | None,
            Field(description="Классификация Яндекс.Маркет (опционально)."),
        ] = None,
    ) -> dict[str, Any]:
        """Создать цель в Яндекс.Метрике (write).

        Требуется OAuth-токен с правом редактирования счётчика. Возвращает
        созданную цель с присвоенным `id`.
        """
        goal: dict[str, Any] = {"name": name, "type": type}
        if conditions is not None:
            goal["conditions"] = conditions
        if default_price is not None:
            goal["default_price"] = default_price
        if is_retargeting is not None:
            goal["is_retargeting"] = is_retargeting
        if flag is not None:
            goal["flag"] = flag

        logger.debug(
            "tool create_goal called",
            goal_type=type,
            has_conditions=conditions is not None,
            has_counter_id=counter_id is not None,
        )
        try:
            created = await client.create_goal(goal, counter_id=counter_id)
            return {"goal": created.model_dump(mode="json")}
        except IntegrationError as e:
            logger.warning("tool create_goal integration error", code=e.code, status=e.status)
            return e.to_dict()

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_update_goal(
        goal_id: Annotated[int, Field(description="ID изменяемой цели.")],
        name: Annotated[
            str,
            Field(min_length=1, max_length=255, description="Название цели (1-255 символов)."),
        ],
        type: Annotated[
            str,
            Field(description=f"Тип цели. Допустимые значения: {GOAL_TYPES}."),
        ],
        conditions: Annotated[
            list[dict[str, Any]] | None,
            Field(
                description=(
                    "Условия срабатывания цели (см. create). Метрика ожидает "
                    "полный объект цели при изменении — передавай актуальные "
                    "`conditions`, а не только дельту."
                ),
            ),
        ] = None,
        counter_id: Annotated[str | None, _COUNTER_ID_FIELD] = None,
        default_price: Annotated[
            float | None,
            Field(description="Ценность цели."),
        ] = None,
        is_retargeting: Annotated[
            bool | None,
            Field(description="Использовать цель для ретаргетинга."),
        ] = None,
        flag: Annotated[
            str | None,
            Field(description="Классификация Яндекс.Маркет (опционально)."),
        ] = None,
    ) -> dict[str, Any]:
        """Изменить существующую цель (write).

        Метрика заменяет объект целиком (PUT), поэтому передавай полный набор
        полей (`name`, `type`, `conditions`), а не только изменяемые.
        """
        goal: dict[str, Any] = {"name": name, "type": type}
        if conditions is not None:
            goal["conditions"] = conditions
        if default_price is not None:
            goal["default_price"] = default_price
        if is_retargeting is not None:
            goal["is_retargeting"] = is_retargeting
        if flag is not None:
            goal["flag"] = flag

        logger.debug(
            "tool update_goal called",
            goal_id=goal_id,
            goal_type=type,
            has_counter_id=counter_id is not None,
        )
        try:
            updated = await client.update_goal(goal_id, goal, counter_id=counter_id)
            return {"goal": updated.model_dump(mode="json")}
        except IntegrationError as e:
            logger.warning("tool update_goal integration error", code=e.code, status=e.status)
            return e.to_dict()

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_delete_goal(
        goal_id: Annotated[int, Field(description="ID удаляемой цели.")],
        counter_id: Annotated[str | None, _COUNTER_ID_FIELD] = None,
    ) -> dict[str, Any]:
        """Удалить цель (write). Операция необратима."""
        logger.debug(
            "tool delete_goal called",
            goal_id=goal_id,
            has_counter_id=counter_id is not None,
        )
        try:
            return await client.delete_goal(goal_id, counter_id=counter_id)
        except IntegrationError as e:
            logger.warning("tool delete_goal integration error", code=e.code, status=e.status)
            return e.to_dict()
