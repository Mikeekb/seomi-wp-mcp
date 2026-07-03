"""Тесты сохранения отчёта в файлы проекта (save_report helpers + запись)."""

from __future__ import annotations

import json
from pathlib import Path

from seomi_metrika.tools.save_report import (
    REPORTS_DIR,
    _render_markdown,
    _slugify,
)


def test_slugify() -> None:
    assert _slugify("Traffic Sources / weekly!!") == "traffic-sources-weekly"
    assert _slugify("today") == "today"
    # Полностью не-ASCII имя → безопасный fallback.
    assert _slugify("Отчёт") == "report"


def test_render_markdown_table() -> None:
    md = _render_markdown(
        "Sources",
        {"data": [{"ym:s:trafficSource": "yandex", "ym:s:visits": 100}], "totals": [100]},
        counter_ids=["111"],
        date1="7daysAgo",
        date2="today",
    )
    assert "# Sources" in md
    assert "| ym:s:trafficSource | ym:s:visits |" in md
    assert "| yandex | 100 |" in md
    assert "Totals: [100]" in md


def test_render_markdown_empty() -> None:
    md = _render_markdown(
        "Empty", {"data": []}, counter_ids=["111"], date1="a", date2="b"
    )
    assert "_Нет данных._" in md


def test_reports_dir_relative() -> None:
    # Путь строится относительно cwd (корень проекта клиента).
    assert REPORTS_DIR == Path(".ai-factory") / "metrika-reports"


def _write_report(tmp_path: Path) -> tuple[Path, Path]:
    """Сэмулировать запись файлов так же, как это делает tool."""
    reports = tmp_path / ".ai-factory" / "metrika-reports"
    reports.mkdir(parents=True, exist_ok=True)
    stem = f"{_slugify('today')}_{_slugify('Sources')}"
    json_path = reports / f"{stem}.json"
    md_path = reports / f"{stem}.md"
    report = {"data": [{"ym:s:visits": 5}], "totals": [5]}
    json_path.write_text(
        json.dumps({"name": "Sources", "report": report}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    md_path.write_text(
        _render_markdown("Sources", report, counter_ids=["111"], date1="a", date2="today"),
        encoding="utf-8",
    )
    return json_path, md_path


def test_write_and_idempotent_overwrite(tmp_path: Path) -> None:
    json_path, md_path = _write_report(tmp_path)
    assert json_path.exists()
    assert md_path.exists()
    first = json_path.read_text(encoding="utf-8")
    # Повторная запись с тем же именем перезаписывает, не плодит файлы.
    _write_report(tmp_path)
    files = list((tmp_path / ".ai-factory" / "metrika-reports").glob("*"))
    assert len(files) == 2  # ровно .json + .md
    assert json_path.read_text(encoding="utf-8") == first
