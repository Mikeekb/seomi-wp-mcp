"""Тесты write-методов целей: create/update/delete + маппинг ошибок."""

from __future__ import annotations

import httpx
import pytest
import respx

from seomi_metrika._errors import AuthError, BadRequest, NotFound, RateLimited
from seomi_metrika.client import BASE_URL, MetrikaClient


@respx.mock
async def test_create_goal_posts_envelope(client_single: MetrikaClient) -> None:
    route = respx.post(f"{BASE_URL}/management/v1/counter/111/goals").mock(
        return_value=httpx.Response(
            200,
            json={"goal": {"id": 500, "name": "Спасибо", "type": "url"}},
        )
    )
    goal = await client_single.create_goal(
        {"name": "Спасибо", "type": "url", "conditions": [{"type": "contain", "url": "/thanks"}]}
    )
    assert route.called
    sent = route.calls.last.request
    import json as _json

    body = _json.loads(sent.content)
    assert body == {
        "goal": {
            "name": "Спасибо",
            "type": "url",
            "conditions": [{"type": "contain", "url": "/thanks"}],
        }
    }
    assert goal.id == 500
    assert goal.name == "Спасибо"


@respx.mock
async def test_update_goal_puts_with_id(client_single: MetrikaClient) -> None:
    route = respx.put(f"{BASE_URL}/management/v1/counter/111/goal/500").mock(
        return_value=httpx.Response(200, json={"goal": {"id": 500, "name": "New", "type": "url"}})
    )
    goal = await client_single.update_goal(500, {"name": "New", "type": "url"})
    assert route.called
    import json as _json

    body = _json.loads(route.calls.last.request.content)
    assert body["goal"]["id"] == 500
    assert body["goal"]["name"] == "New"
    assert goal.name == "New"


@respx.mock
async def test_delete_goal_calls_delete(client_single: MetrikaClient) -> None:
    route = respx.delete(f"{BASE_URL}/management/v1/counter/111/goal/500").mock(
        return_value=httpx.Response(200, json={"success": True})
    )
    result = await client_single.delete_goal(500)
    assert route.called
    assert result["success"] is True
    assert result["goal_id"] == 500


async def test_create_goal_ambiguous_without_counter(client_multi: MetrikaClient) -> None:
    with pytest.raises(BadRequest, match="ambiguous"):
        await client_multi.create_goal({"name": "x", "type": "url"})


@respx.mock
@pytest.mark.parametrize(
    ("status", "exc"),
    [
        (401, AuthError),
        (403, AuthError),
        (400, BadRequest),
        (404, NotFound),
        (420, RateLimited),
        (429, RateLimited),
    ],
)
async def test_create_goal_error_mapping(
    client_single: MetrikaClient, status: int, exc: type[Exception]
) -> None:
    respx.post(f"{BASE_URL}/management/v1/counter/111/goals").mock(
        return_value=httpx.Response(status, json={"errors": [{"message": "boom"}]})
    )
    with pytest.raises(exc):
        await client_single.create_goal({"name": "x", "type": "url"})
