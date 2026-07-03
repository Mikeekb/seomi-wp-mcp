"""Pydantic-модели для Яндекс.Метрика API (Management + Reporting).

Модели только описывают данные, не вызывают client. Базовый класс разрешает
`extra="allow"`, чтобы расширения API Метрики не ломали парсинг.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class _MetrikaBase(BaseModel):
    """Базовый класс моделей Метрики (extra=allow для гибкости к API)."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)


# ---------------------------------------------------------------------------
# Management API
# ---------------------------------------------------------------------------


class Counter(_MetrikaBase):
    """Счётчик Метрики (GET /management/v1/counters)."""

    id: int
    name: str | None = None
    site: str | None = None
    status: str | None = None
    type: str | None = None
    owner_login: str | None = None


class Goal(_MetrikaBase):
    """Цель счётчика (GET /management/v1/counter/{id}/goals).

    Типы целей Метрики: `url`, `action`, `step`, `phone`, `email`, `form`,
    `messenger`, `button`, `file`, `search`, `payment_system`, `chat`.
    Используется для построения метрик вида `ym:s:goal<ID>visits`.
    """

    id: int
    name: str | None = None
    type: str | None = None
    conditions: list[dict[str, Any]] | None = None
    is_retargeting: bool | None = None


class Segment(_MetrikaBase):
    """Сегмент аудитории, созданный через API
    (`/management/v1/counter/{id}/apisegment/segments`).

    Важно: сегменты, созданные через API, НЕ отображаются в веб-интерфейсе
    Метрики. `expression` — выражение сегментации Метрики, например
    `ym:s:trafficSource=='organic'`.
    """

    segment_id: int | None = None
    counter_id: int | None = None
    name: str | None = None
    expression: str | None = None
    segment_source: str | None = None


# ---------------------------------------------------------------------------
# Reporting API
# ---------------------------------------------------------------------------


class ReportQuery(_MetrikaBase):
    """Эхо параметров запроса от Метрики в ответе `/stat/v1/data`.

    `ids` приходит как массив int (Метрика отдаёт именно так, не строкой).
    """

    ids: list[int] | None = None
    metrics: list[str] | None = None
    dimensions: list[str] | None = None
    date1: str | None = None
    date2: str | None = None
    filters: str | None = None
    sort: list[str] | None = None
    limit: int | None = None
    offset: int | None = None


class Report(_MetrikaBase):
    """Отчёт Метрики (GET /stat/v1/data) после разворачивания.

    Метрика возвращает дерево `data[].dimensions[{name,value}], metrics[v1,v2,...]`;
    здесь оно развёрнуто в плоский `data: list[dict]` — каждая строка =
    `{<dim_name>: <value>, <metric_name>: <value>, ...}`. Порядок метрик в
    строке соответствует `query.metrics`.

    `totals` — список агрегированных значений в том же порядке, что и
    `query.metrics` (например `[12345.0, 678.0]`). Может быть `None`, если
    Метрика не вернула totals (для некоторых пресетов).
    """

    query: ReportQuery | None = None
    data: list[dict[str, Any]] = Field(default_factory=list)
    totals: list[float] | None = None
    total_rows: int | None = None
    sampled: bool | None = None
    sample_share: float | None = None
    min_sample_size: int | None = None


__all__ = [
    "Counter",
    "Goal",
    "Report",
    "ReportQuery",
    "Segment",
]
