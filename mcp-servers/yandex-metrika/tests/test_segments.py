"""Тесты методов сегментов: list/create/update/delete."""

from __future__ import annotations

import json as _json

import httpx
import pytest
import respx

from seomi_metrika._errors import BadRequest
from seomi_metrika.client import BASE_URL, MetrikaClient


@respx.mock
async def test_list_segments(client_single: MetrikaClient) -> None:
    respx.get(f"{BASE_URL}/management/v1/counter/111/apisegment/segments").mock(
        return_value=httpx.Response(
            200,
            json={"segments": [{"segment_id": 7, "name": "Organic", "expression": "x"}]},
        )
    )
    segments = await client_single.list_segments()
    assert len(segments) == 1
    assert segments[0].segment_id == 7
    assert segments[0].name == "Organic"


@respx.mock
async def test_create_segment_posts_envelope(client_single: MetrikaClient) -> None:
    route = respx.post(f"{BASE_URL}/management/v1/counter/111/apisegment/segments").mock(
        return_value=httpx.Response(
            200,
            json={"segment": {"segment_id": 9, "name": "Mobile", "expression": "expr"}},
        )
    )
    seg = await client_single.create_segment("Mobile", "ym:s:deviceCategory=='mobile'")
    assert route.called
    body = _json.loads(route.calls.last.request.content)
    assert body == {
        "segment": {"name": "Mobile", "expression": "ym:s:deviceCategory=='mobile'"}
    }
    assert seg.segment_id == 9


@respx.mock
async def test_update_segment_partial(client_single: MetrikaClient) -> None:
    route = respx.put(f"{BASE_URL}/management/v1/counter/111/apisegment/segment/9").mock(
        return_value=httpx.Response(200, json={"segment": {"segment_id": 9, "name": "Renamed"}})
    )
    seg = await client_single.update_segment(9, name="Renamed")
    assert route.called
    body = _json.loads(route.calls.last.request.content)
    assert body == {"segment": {"name": "Renamed"}}
    assert seg.name == "Renamed"


async def test_update_segment_requires_fields(client_single: MetrikaClient) -> None:
    with pytest.raises(BadRequest, match="nothing to update"):
        await client_single.update_segment(9)


@respx.mock
async def test_delete_segment(client_single: MetrikaClient) -> None:
    route = respx.delete(f"{BASE_URL}/management/v1/counter/111/apisegment/segment/9").mock(
        return_value=httpx.Response(200, json={})
    )
    result = await client_single.delete_segment(9)
    assert route.called
    assert result["success"] is True
    assert result["segment_id"] == 9


async def test_list_segments_ambiguous_multi(client_multi: MetrikaClient) -> None:
    with pytest.raises(BadRequest, match="ambiguous"):
        await client_multi.list_segments()
