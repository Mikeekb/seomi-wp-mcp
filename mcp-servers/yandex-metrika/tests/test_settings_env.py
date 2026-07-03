"""Тесты чтения настроек из `.claude/.env` и парсинга counter_id."""

from __future__ import annotations

from pathlib import Path

import pytest

from seomi_metrika.settings import MetrikaSettings


def _clear_metrika_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Убрать реальные METRIKA_* из окружения, чтобы читались только файлы."""
    monkeypatch.delenv("METRIKA_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("METRIKA_COUNTER_ID", raising=False)


def test_reads_claude_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_metrika_env(monkeypatch)
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    (claude_dir / ".env").write_text(
        "METRIKA_OAUTH_TOKEN=secret-abc\nMETRIKA_COUNTER_ID=43286099,46188792\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    settings = MetrikaSettings()
    assert settings.counter_ids == ["43286099", "46188792"]
    assert settings.oauth_token.get_secret_value() == "secret-abc"


def test_token_is_masked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_metrika_env(monkeypatch)
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    (claude_dir / ".env").write_text(
        "METRIKA_OAUTH_TOKEN=super-secret\nMETRIKA_COUNTER_ID=111\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    settings = MetrikaSettings()
    assert "super-secret" not in repr(settings)
    assert "super-secret" not in str(settings.oauth_token)


def test_single_counter_helper(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_metrika_env(monkeypatch)
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    (claude_dir / ".env").write_text(
        "METRIKA_OAUTH_TOKEN=t\nMETRIKA_COUNTER_ID=  777  \n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    settings = MetrikaSettings()
    assert settings.counter_ids == ["777"]
    assert settings.counter_id_single == "777"


def test_env_var_overrides_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    (claude_dir / ".env").write_text(
        "METRIKA_OAUTH_TOKEN=file-token\nMETRIKA_COUNTER_ID=111\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("METRIKA_OAUTH_TOKEN", "env-token")

    settings = MetrikaSettings()
    # Реальная переменная окружения перекрывает значение из .env-файла.
    assert settings.oauth_token.get_secret_value() == "env-token"
