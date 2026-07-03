"""Общие фикстуры для тестов seomi-metrika."""

from __future__ import annotations

import pytest

from seomi_metrika.client import MetrikaClient


@pytest.fixture
def client_single() -> MetrikaClient:
    """Клиент с одним настроенным счётчиком (counter_id опционален)."""
    return MetrikaClient(oauth_token="test-token", counter_ids=["111"])


@pytest.fixture
def client_multi() -> MetrikaClient:
    """Клиент с несколькими счётчиками (management-методы требуют counter_id)."""
    return MetrikaClient(oauth_token="test-token", counter_ids=["111", "222"])
