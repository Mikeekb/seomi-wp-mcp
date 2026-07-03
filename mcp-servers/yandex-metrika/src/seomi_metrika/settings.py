"""Конфигурация Яндекс.Метрика MCP-сервера из переменных окружения.

Особенности порта в seomi-wp-mcp:
- Credentials хранятся в `.claude/.env` проекта клиента (gitignored). Сервер
  запускается MCP-клиентом с cwd = корень проекта, поэтому env_file указывает
  на `.claude/.env`; для обратной совместимости также читается `.env` в корне.
- `METRIKA_COUNTER_ID` — comma-separated список ID счётчиков (мультисчётчик:
  основной сайт + лендинг под одной кампанией Директа).
"""

from __future__ import annotations

from typing import Annotated

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class MetrikaSettings(BaseSettings):
    """Читает METRIKA_* из `.claude/.env` (или `.env`).

    `oauth_token` хранится как SecretStr — значение маскируется при
    print/repr/JSON-сериализации, чтобы не утечь в логи.

    `counter_ids` парсится из строки `METRIKA_COUNTER_ID=43286099,46188792`
    в список ID. Один счётчик — частный случай.
    """

    # Порядок важен: файлы, идущие позже, имеют приоритет. `.claude/.env` —
    # основное место хранения creds в seomi-wp-mcp, поэтому он перекрывает
    # корневой `.env`. Реальные переменные окружения (напр. LOG_LEVEL из
    # .mcp.json env) перекрывают оба файла.
    model_config = SettingsConfigDict(
        env_file=(".env", ".claude/.env"),
        env_file_encoding="utf-8",
        env_prefix="METRIKA_",
        extra="ignore",
        case_sensitive=False,
    )

    oauth_token: SecretStr = Field(
        ...,
        description="OAuth-токен Яндекс.Метрики (заголовок Authorization: OAuth)",
    )
    # NoDecode отключает JSON-декодирование значения из env — иначе
    # pydantic-settings попытается распарсить "43286099,46188792" как JSON
    # и упадёт. Парсинг руками делаем в `_split_counter_ids`.
    counter_id: Annotated[list[str], NoDecode] = Field(
        ...,
        description=(
            "ID счётчиков Метрики через запятую в .env, например '43286099,46188792'. "
            "В коде доступен как список через `counter_ids`."
        ),
    )

    @field_validator("counter_id", mode="before")
    @classmethod
    def _split_counter_ids(cls, value: object) -> list[str]:
        """Разобрать `METRIKA_COUNTER_ID` в список ID.

        Принимает строку (из env) или уже список (для тестов). Strip каждого
        элемента, отбрасывает пустые. Пустой результат — ошибка валидации.
        """
        if isinstance(value, str):
            items = [item.strip() for item in value.split(",")]
        elif isinstance(value, list):
            items = [str(item).strip() for item in value]
        else:
            raise TypeError(
                f"METRIKA_COUNTER_ID must be string or list, got {type(value).__name__}"
            )
        filtered = [item for item in items if item]
        if not filtered:
            raise ValueError("METRIKA_COUNTER_ID must contain at least one counter id")
        return filtered

    @property
    def counter_ids(self) -> list[str]:
        """Alias для семантически понятного множественного имени."""
        return self.counter_id

    @property
    def counter_id_single(self) -> str | None:
        """Единственный counter_id, если он один; иначе None."""
        return self.counter_id[0] if len(self.counter_id) == 1 else None
