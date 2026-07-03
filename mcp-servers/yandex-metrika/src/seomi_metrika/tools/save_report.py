"""MCP-tool: выполнить отчёт Метрики и сохранить его в файлы проекта.

«Смотреть аналитику» покрывает `yandex_metrika_get_report`. Этот tool
дополнительно СОХРАНЯЕТ результат в проект клиента:
- `.ai-factory/metrika-reports/<date>_<slug>.json` — сырые данные + query;
- `.ai-factory/metrika-reports/<date>_<slug>.md` — человекочитаемая таблица.

Файлы версионируются в git и не зависят от веб-интерфейса Метрики. Путь —
относительно cwd (корень проекта, где запущен MCP-сервер).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Annotated, Any

import structlog
from pydantic import Field

from seomi_metrika._errors import IntegrationError
from seomi_metrika.client import MetrikaClient

logger = structlog.get_logger("seomi_metrika.tools.save_report")

REPORTS_DIR = Path(".ai-factory") / "metrika-reports"
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str) -> str:
    """Привести имя отчёта к безопасному для файла slug (a-z0-9-)."""
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug or "report"


def _render_markdown(
    name: str,
    report: dict[str, Any],
    *,
    counter_ids: list[str],
    date1: str,
    date2: str,
) -> str:
    """Собрать Markdown-таблицу из плоских строк отчёта."""
    rows: list[dict[str, Any]] = report.get("data") or []
    lines: list[str] = [
        f"# {name}",
        "",
        f"- Период: `{date1}` — `{date2}`",
        f"- Счётчики: {', '.join(counter_ids)}",
        f"- Строк: {len(rows)}",
    ]
    totals = report.get("totals")
    if totals:
        lines.append(f"- Totals: {totals}")
    lines.append("")

    if not rows:
        lines.append("_Нет данных._")
        return "\n".join(lines) + "\n"

    # Колонки — объединение ключей всех строк, порядок первого появления.
    columns: list[str] = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)

    lines.append("| " + " | ".join(columns) + " |")
    lines.append("| " + " | ".join("---" for _ in columns) + " |")
    for row in rows:
        cells = [str(row.get(col, "")) for col in columns]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def register(mcp: Any, client: MetrikaClient) -> None:
    """Зарегистрировать tool `yandex_metrika_save_report`."""

    @mcp.tool()  # type: ignore[untyped-decorator]
    async def yandex_metrika_save_report(
        name: Annotated[
            str,
            Field(description="Человекочитаемое имя отчёта (используется в имени файла и заголовке)."),
        ],
        metrics: Annotated[
            list[str],
            Field(description="Метрики отчёта (см. yandex_metrika_get_report)."),
        ],
        date1: Annotated[str, Field(description="Начало периода ('YYYY-MM-DD' / 'NdaysAgo').")],
        date2: Annotated[str, Field(description="Конец периода в том же формате.")],
        dimensions: Annotated[
            list[str] | None,
            Field(description="Срезы отчёта (тот же namespace, что metrics)."),
        ] = None,
        filters: Annotated[
            str | None,
            Field(description="Выражение фильтра Метрики."),
        ] = None,
        sort: Annotated[
            str | None,
            Field(description="Колонка сортировки, напр. '-ym:s:visits'."),
        ] = None,
        limit: Annotated[
            int,
            Field(ge=1, le=100_000, description="Количество строк (1-100000)."),
        ] = 100,
        counter_ids: Annotated[
            list[str] | None,
            Field(description="Подмножество настроенных counter_ids (по умолчанию все)."),
        ] = None,
    ) -> dict[str, Any]:
        """Выполнить отчёт и сохранить его в `.ai-factory/metrika-reports/`.

        Пишет два файла: `<date2>_<slug>.json` (данные + query) и
        `<date2>_<slug>.md` (таблица). Идемпотентно перезаписывает файлы с тем
        же именем. Возвращает пути и краткую сводку.
        """
        logger.debug(
            "tool save_report called",
            metrics_count=len(metrics),
            dimensions_count=len(dimensions or []),
            date1=date1,
            date2=date2,
            has_filters=filters is not None,
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
                counter_ids=counter_ids,
            )
        except IntegrationError as e:
            logger.warning("tool save_report integration error", code=e.code, status=e.status)
            return e.to_dict()

        effective_ids = (
            counter_ids if counter_ids is not None else client.get_counter_info()["counter_ids"]
        )
        report_dump = report.model_dump(mode="json")

        # Имя файла из date2 (конец периода) + slug имени — детерминировано,
        # без обращения к системным часам.
        date_prefix = _slugify(date2)
        slug = _slugify(name)
        stem = f"{date_prefix}_{slug}"

        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        json_path = REPORTS_DIR / f"{stem}.json"
        md_path = REPORTS_DIR / f"{stem}.md"

        json_payload = {
            "name": name,
            "counter_ids": effective_ids,
            "date1": date1,
            "date2": date2,
            "report": report_dump,
        }
        json_path.write_text(
            json.dumps(json_payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        md_path.write_text(
            _render_markdown(
                name,
                report_dump,
                counter_ids=effective_ids,
                date1=date1,
                date2=date2,
            ),
            encoding="utf-8",
        )

        row_count = len(report_dump.get("data") or [])
        logger.debug(
            "save_report written",
            json_path=str(json_path),
            md_path=str(md_path),
            row_count=row_count,
            counter_count=len(effective_ids),
        )
        return {
            "saved": True,
            "json_path": str(json_path),
            "md_path": str(md_path),
            "row_count": row_count,
            "counter_ids": effective_ids,
        }
