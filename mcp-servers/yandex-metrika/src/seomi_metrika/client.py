"""HTTP-клиент Яндекс.Метрика API (Management + Reporting).

Инкапсулирует протокол: URL, заголовок `Authorization: OAuth <TOKEN>`,
поддержку списка counter_ids, валидацию namespace `ym:s:`/`ym:pv:`,
маппинг HTTP-кодов и envelope-ошибок Метрики в `IntegrationError`.

Multi-counter контракт:
- Один рекламный кабинет Директа часто гонит трафик на основной сайт и
  отдельный лендинг — у каждого свой счётчик. В `.env` они указываются
  через запятую (`METRIKA_COUNTER_ID=43286099,46188792`).
- `/stat/v1/data` нативно мержит счётчики через `ids=<id1>,<id2>` —
  собственного агрегатора не пишем.
- Management-эндпоинты (`/management/v1/counter/{id}/...`) ходят к одному
  счётчику за раз → методы вроде `list_goals` требуют явный `counter_id`,
  если в settings их несколько; иначе `BadRequest("ambiguous: ...")`.
"""

from __future__ import annotations

from types import TracebackType
from typing import Any

import httpx
import structlog

from seomi_metrika._errors import (
    AuthError,
    BadRequest,
    IntegrationError,
    NotFound,
    RateLimited,
    UpstreamError,
)
from seomi_metrika._http import build_async_client
from seomi_metrika.models import Counter, Goal, Report, ReportQuery, Segment

logger = structlog.get_logger("seomi_metrika.client")

BASE_URL = "https://api-metrika.yandex.net"

DEFAULT_LIMIT = 100
MAX_LIMIT = 100_000
DEFAULT_OFFSET = 1

_NAMESPACE_SESSION = "ym:s:"
_NAMESPACE_HIT = "ym:pv:"


class MetrikaClient:
    """Асинхронный клиент Яндекс.Метрики.

    Авторизация — только заголовком `Authorization: OAuth <TOKEN>`.
    `oauth_token` в query запрещён (попадает в логи прокси и историю
    браузера).

    `counter_ids` — список настроенных счётчиков из settings. Хранится как
    `list[str]` (Метрика принимает их и числами, и строками).
    """

    def __init__(
        self,
        oauth_token: str,
        counter_ids: list[str],
        *,
        timeout: float = 30.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not counter_ids:
            raise ValueError("counter_ids must not be empty")
        self._counter_ids: list[str] = list(counter_ids)
        self._token_len = len(oauth_token)

        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            self._client = build_async_client(
                base_url=BASE_URL,
                headers={
                    "Authorization": f"OAuth {oauth_token}",
                    "Accept": "application/json",
                },
                timeout=timeout,
            )
            self._owns_client = True

        logger.debug(
            "metrika client built",
            counter_count=len(self._counter_ids),
            counter_ids=self._counter_ids,
            oauth_token_present=bool(oauth_token),
            oauth_token_len=self._token_len,
            timeout=timeout,
            injected_client=client is not None,
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
            logger.debug("metrika client closed")

    async def __aenter__(self) -> MetrikaClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    # ------------------------------------------------------------------ #
    # Reporting / read API
    # ------------------------------------------------------------------ #

    async def list_counters(
        self,
        *,
        per_page: int = DEFAULT_LIMIT,
        offset: int = DEFAULT_OFFSET,
        search_string: str | None = None,
    ) -> list[Counter]:
        """Доступные по OAuth-токену счётчики (GET /management/v1/counters)."""
        params: dict[str, Any] = {
            "per_page": max(1, min(per_page, 1000)),
            "offset": max(1, offset),
        }
        if search_string is not None:
            params["search_string"] = search_string
        data = await self._get("/management/v1/counters", params=params)
        raw_items = data.get("counters") if isinstance(data, dict) else None
        items: list[Counter] = []
        if isinstance(raw_items, list):
            for raw in raw_items:
                if isinstance(raw, dict):
                    items.append(Counter.model_validate(raw))
        logger.debug("list_counters ok", count=len(items))
        return items

    async def list_goals(self, counter_id: str | None = None) -> list[Goal]:
        """Цели счётчика (GET /management/v1/counter/{id}/goals).

        `counter_id` обязателен по смыслу, если в settings настроено
        несколько счётчиков; при единственном — необязателен и дефолтится
        к нему.
        """
        resolved = self._resolve_counter_id(counter_id)
        data = await self._get(f"/management/v1/counter/{resolved}/goals")
        raw_items = data.get("goals") if isinstance(data, dict) else None
        items: list[Goal] = []
        if isinstance(raw_items, list):
            for raw in raw_items:
                if isinstance(raw, dict):
                    items.append(Goal.model_validate(raw))
        logger.debug("list_goals ok", counter_id=resolved, count=len(items))
        return items

    async def get_report(
        self,
        *,
        metrics: list[str],
        date1: str,
        date2: str,
        dimensions: list[str] | None = None,
        filters: str | None = None,
        sort: str | None = None,
        limit: int = DEFAULT_LIMIT,
        offset: int = DEFAULT_OFFSET,
        accuracy: str | None = None,
        preset: str | None = None,
        counter_ids: list[str] | None = None,
    ) -> Report:
        """Произвольный отчёт Метрики (GET /stat/v1/data).

        По умолчанию агрегирует ВСЕ настроенные счётчики через `ids=<id1>,<id2>`
        — Метрика мержит их на своей стороне. Чтобы посчитать по одному —
        передай `counter_ids=["43286099"]`.

        Валидации до HTTP:
        - переданные `counter_ids` должны быть подмножеством настроенных;
        - все элементы `metrics + dimensions` — в одном namespace (`ym:s:` либо
          `ym:pv:`); смесь Метрика отвергает.
        """
        dims = list(dimensions or [])
        mets = list(metrics)
        _validate_namespace(mets + dims)

        effective_ids = self._resolve_counter_ids(counter_ids)
        params: dict[str, Any] = {
            "ids": ",".join(effective_ids),
            "metrics": ",".join(mets),
            "date1": date1,
            "date2": date2,
            "limit": max(1, min(limit, MAX_LIMIT)),
            "offset": max(1, offset),
        }
        if dims:
            params["dimensions"] = ",".join(dims)
        if filters is not None:
            params["filters"] = filters
        if sort is not None:
            params["sort"] = sort
        if accuracy is not None:
            params["accuracy"] = accuracy
        if preset is not None:
            params["preset"] = preset

        data = await self._get("/stat/v1/data", params=params)
        query = _build_report_query(data.get("query"))
        rows = _flatten_report_rows(data.get("data"), mets)
        totals_raw = data.get("totals")
        totals: list[float] | None = None
        if isinstance(totals_raw, list):
            try:
                totals = [float(v) for v in totals_raw if isinstance(v, int | float)]
            except (TypeError, ValueError):
                totals = None
        report = Report(
            query=query,
            data=rows,
            totals=totals,
            total_rows=_safe_int(data.get("total_rows")),
            sampled=_safe_bool(data.get("sampled")),
            sample_share=_safe_float(data.get("sample_share")),
            min_sample_size=_safe_int(data.get("min_sample_size")),
        )
        logger.debug(
            "get_report ok",
            row_count=len(rows),
            metric_count=len(mets),
            dimension_count=len(dims),
            counter_count=len(effective_ids),
        )
        return report

    def get_counter_info(self) -> dict[str, Any]:
        """Конфиг текущих счётчиков (без HTTP-вызова).

        Возвращает список всех настроенных counter_ids — в типовом кейсе их
        несколько (основной сайт + лендинг). Не возвращает значение токена.
        """
        return {
            "counter_ids": list(self._counter_ids),
            "count": len(self._counter_ids),
            "oauth_token_present": self._token_len > 0,
            "oauth_token_len": self._token_len,
        }

    # ------------------------------------------------------------------ #
    # Management write API — цели
    # ------------------------------------------------------------------ #
    #
    # Эндпоинты сверены с офиц. Management API Метрики:
    #   POST   /management/v1/counter/{id}/goals          — создать
    #   PUT    /management/v1/counter/{id}/goal/{goalId}  — изменить
    #   DELETE /management/v1/counter/{id}/goal/{goalId}  — удалить
    # Тело create/update — конверт {"goal": {...}}; ответ — {"goal": {...}}.
    # Для write нужен OAuth-токен с правом редактирования счётчика.

    async def create_goal(
        self,
        goal: dict[str, Any],
        *,
        counter_id: str | None = None,
    ) -> Goal:
        """Создать цель (POST /management/v1/counter/{id}/goals).

        `goal` — объект цели Метрики: `name`, `type`, `conditions`, опц.
        `default_price`, `is_retargeting`, `flag`. Оборачивается в конверт
        `{"goal": ...}`.
        """
        resolved = self._resolve_counter_id(counter_id)
        data = await self._request(
            "POST",
            f"/management/v1/counter/{resolved}/goals",
            json={"goal": goal},
        )
        created = data.get("goal") if isinstance(data, dict) else None
        logger.debug(
            "create_goal ok",
            counter_id=resolved,
            goal_type=goal.get("type"),
            has_goal=created is not None,
        )
        return Goal.model_validate(created if isinstance(created, dict) else {})

    async def update_goal(
        self,
        goal_id: int,
        goal: dict[str, Any],
        *,
        counter_id: str | None = None,
    ) -> Goal:
        """Изменить цель (PUT /management/v1/counter/{id}/goal/{goalId}).

        `goal` — полный объект цели (Метрика ожидает валидный `name`/`type`/
        `conditions`). `id` проставляется автоматически из `goal_id`.
        """
        resolved = self._resolve_counter_id(counter_id)
        payload = {**goal, "id": goal_id}
        data = await self._request(
            "PUT",
            f"/management/v1/counter/{resolved}/goal/{goal_id}",
            json={"goal": payload},
        )
        updated = data.get("goal") if isinstance(data, dict) else None
        logger.debug(
            "update_goal ok",
            counter_id=resolved,
            goal_id=goal_id,
            has_goal=updated is not None,
        )
        return Goal.model_validate(updated if isinstance(updated, dict) else {})

    async def delete_goal(
        self,
        goal_id: int,
        *,
        counter_id: str | None = None,
    ) -> dict[str, Any]:
        """Удалить цель (DELETE /management/v1/counter/{id}/goal/{goalId})."""
        resolved = self._resolve_counter_id(counter_id)
        data = await self._request(
            "DELETE",
            f"/management/v1/counter/{resolved}/goal/{goal_id}",
        )
        logger.debug("delete_goal ok", counter_id=resolved, goal_id=goal_id)
        return {"success": True, "counter_id": resolved, "goal_id": goal_id, "response": data}

    # ------------------------------------------------------------------ #
    # Management API — сегменты аудитории
    # ------------------------------------------------------------------ #
    #
    # Эндпоинты сверены с офиц. Management API Метрики (ресурс apisegment):
    #   GET    /management/v1/counter/{id}/apisegment/segments            — список
    #   POST   /management/v1/counter/{id}/apisegment/segments            — создать
    #   PUT    /management/v1/counter/{id}/apisegment/segment/{segId}     — изменить
    #   DELETE /management/v1/counter/{id}/apisegment/segment/{segId}     — удалить
    # Конверт тела/ответа — {"segment": {...}}. Сегменты, созданные через API,
    # не видны в веб-интерфейсе Метрики. Нужен токен с правом metrika:write.

    async def list_segments(self, counter_id: str | None = None) -> list[Segment]:
        """Сегменты, созданные через API (GET .../apisegment/segments)."""
        resolved = self._resolve_counter_id(counter_id)
        data = await self._get(f"/management/v1/counter/{resolved}/apisegment/segments")
        raw_items = data.get("segments") if isinstance(data, dict) else None
        items: list[Segment] = []
        if isinstance(raw_items, list):
            for raw in raw_items:
                if isinstance(raw, dict):
                    items.append(Segment.model_validate(raw))
        logger.debug("list_segments ok", counter_id=resolved, count=len(items))
        return items

    async def create_segment(
        self,
        name: str,
        expression: str,
        *,
        counter_id: str | None = None,
    ) -> Segment:
        """Создать сегмент (POST .../apisegment/segments).

        `expression` — выражение сегментации Метрики, напр.
        `ym:s:trafficSource=='organic'`.
        """
        resolved = self._resolve_counter_id(counter_id)
        data = await self._request(
            "POST",
            f"/management/v1/counter/{resolved}/apisegment/segments",
            json={"segment": {"name": name, "expression": expression}},
        )
        created = data.get("segment") if isinstance(data, dict) else None
        logger.debug("create_segment ok", counter_id=resolved, has_segment=created is not None)
        return Segment.model_validate(created if isinstance(created, dict) else {})

    async def update_segment(
        self,
        segment_id: int,
        *,
        name: str | None = None,
        expression: str | None = None,
        counter_id: str | None = None,
    ) -> Segment:
        """Изменить сегмент (PUT .../apisegment/segment/{segId})."""
        resolved = self._resolve_counter_id(counter_id)
        segment: dict[str, Any] = {}
        if name is not None:
            segment["name"] = name
        if expression is not None:
            segment["expression"] = expression
        if not segment:
            raise BadRequest("update_segment: nothing to update (pass name and/or expression)")
        data = await self._request(
            "PUT",
            f"/management/v1/counter/{resolved}/apisegment/segment/{segment_id}",
            json={"segment": segment},
        )
        updated = data.get("segment") if isinstance(data, dict) else None
        logger.debug("update_segment ok", counter_id=resolved, segment_id=segment_id)
        return Segment.model_validate(updated if isinstance(updated, dict) else {})

    async def delete_segment(
        self,
        segment_id: int,
        *,
        counter_id: str | None = None,
    ) -> dict[str, Any]:
        """Удалить сегмент (DELETE .../apisegment/segment/{segId})."""
        resolved = self._resolve_counter_id(counter_id)
        data = await self._request(
            "DELETE",
            f"/management/v1/counter/{resolved}/apisegment/segment/{segment_id}",
        )
        logger.debug("delete_segment ok", counter_id=resolved, segment_id=segment_id)
        return {
            "success": True,
            "counter_id": resolved,
            "segment_id": segment_id,
            "response": data,
        }

    # ------------------------------------------------------------------ #
    # Внутренности
    # ------------------------------------------------------------------ #

    def _resolve_counter_id(self, counter_id: str | None) -> str:
        """Подобрать единственный counter_id для management-эндпоинтов."""
        if counter_id is not None:
            return counter_id
        if len(self._counter_ids) == 1:
            return self._counter_ids[0]
        raise BadRequest("ambiguous: multiple counters configured, pass counter_id explicitly")

    def _resolve_counter_ids(self, counter_ids: list[str] | None) -> list[str]:
        """Подобрать список counter_ids для reporting-эндпоинта."""
        if counter_ids is None:
            return list(self._counter_ids)
        if not counter_ids:
            raise BadRequest("counter_ids override must not be empty")
        configured = set(self._counter_ids)
        for cid in counter_ids:
            if cid not in configured:
                raise BadRequest(f"counter_id {cid} not in configured METRIKA_COUNTER_ID")
        return list(counter_ids)

    async def _get(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._request("GET", path, params=params)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Единая точка выполнения HTTP-запроса с маппингом ошибок.

        Поддерживает GET (read) и write-методы (POST/PUT/DELETE) для
        management-эндпоинтов (цели, сегменты). Тело токена не логируется.
        """
        param_keys = sorted((params or {}).keys())
        body_keys = sorted((json or {}).keys())
        logger.debug(
            "metrika request",
            method=method,
            path=path,
            param_keys=param_keys,
            body_keys=body_keys,
            counter_count=len(self._counter_ids),
            oauth_token_present=self._token_len > 0,
        )
        try:
            response = await self._client.request(
                method,
                path,
                params=params or None,
                json=json,
            )
        except httpx.TimeoutException as e:
            logger.warning("metrika timeout", path=path)
            raise UpstreamError(f"metrika timeout: {e}") from e
        except httpx.TransportError as e:
            logger.warning("metrika transport error", path=path, error=str(e))
            raise UpstreamError(f"metrika transport error: {e}") from e

        self._raise_for_status(response, path=path)
        return self._parse_json(response, path=path)

    @staticmethod
    def _parse_json(response: httpx.Response, *, path: str) -> dict[str, Any]:
        if not response.content:
            logger.debug("metrika empty body", path=path, status=response.status_code)
            return {}
        try:
            data = response.json()
        except ValueError as e:
            logger.warning("metrika invalid JSON", path=path, status=response.status_code)
            raise UpstreamError(f"metrika invalid JSON from {path}: {e}") from e
        if not isinstance(data, dict):
            raise UpstreamError(
                f"metrika unexpected payload type for {path}: {type(data).__name__}"
            )
        return data

    @staticmethod
    def _raise_for_status(response: httpx.Response, *, path: str) -> None:
        code = response.status_code
        if 200 <= code < 300:
            return

        envelope_msg = _extract_envelope_error(response)
        body_preview = envelope_msg or (response.text[:200] if response.text else "")
        logger.warning(
            "metrika http error",
            path=path,
            status=code,
            body_preview=body_preview,
        )

        if code in (401, 403):
            raise AuthError(f"metrika auth failed at {path}: {body_preview}", status=code)
        if code == 400:
            raise BadRequest(f"metrika bad request at {path}: {body_preview}", status=code)
        if code == 404:
            raise NotFound(
                f"metrika resource not found at {path}: {body_preview}",
                status=code,
            )
        if code == 420:
            # Нестандартный код Метрики: «Quota exceeded» (обычно — дневной лимит
            # 5000 req/day или Reports 200 req/5min). Маппим в RateLimited,
            # помечая характер квоты в сообщении.
            raise RateLimited(
                f"metrika quota exceeded at {path} (HTTP 420, daily/window quota): {body_preview}",
                retry_after=response.headers.get("Retry-After"),
                status=code,
            )
        if code == 429:
            raise RateLimited(
                f"metrika rate limit at {path}: {body_preview}",
                retry_after=response.headers.get("Retry-After"),
                status=code,
            )
        if 500 <= code < 600:
            raise UpstreamError(
                f"metrika upstream {code} at {path}: {body_preview}",
                status=code,
            )
        raise UpstreamError(
            f"metrika unexpected {code} at {path}: {body_preview}",
            status=code,
        )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _validate_namespace(parts: list[str]) -> None:
    """Запретить смешивание `ym:s:` и `ym:pv:` в одном запросе."""
    has_session = any(p.startswith(_NAMESPACE_SESSION) for p in parts)
    has_hit = any(p.startswith(_NAMESPACE_HIT) for p in parts)
    if has_session and has_hit:
        raise BadRequest("Cannot mix ym:s: (sessions) and ym:pv: (hits) in a single request")


def _extract_envelope_error(response: httpx.Response) -> str | None:
    """Достать message из envelope-ошибки Метрики (`{"errors":[{...}]}`).

    Возвращает только первую ошибку — обычно её достаточно для диагностики.
    """
    if not response.content:
        return None
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    errors = body.get("errors")
    if not isinstance(errors, list) or not errors:
        # Иногда Метрика кладёт `message` на верхний уровень.
        message = body.get("message")
        return str(message) if message else None
    first = errors[0]
    if not isinstance(first, dict):
        return None
    error_type = first.get("error_type") or ""
    message = first.get("message") or ""
    combined = f"{error_type}: {message}".strip(": ").strip()
    return combined or None


def _build_report_query(raw: Any) -> ReportQuery | None:
    if not isinstance(raw, dict):
        return None
    return ReportQuery.model_validate(raw)


def _flatten_report_rows(
    raw_data: Any,
    metrics: list[str],
) -> list[dict[str, Any]]:
    """Развернуть `data[]` Метрики в плоский список строк.

    Каждая строка приходит как
    `{"dimensions":[{"name":"ym:s:trafficSource","value":"yandex"}],
       "metrics":[100, 5]}`. Преобразуем в
    `{"ym:s:trafficSource": "yandex", "ym:s:visits": 100, "ym:s:users": 5}`.
    """
    rows: list[dict[str, Any]] = []
    if not isinstance(raw_data, list):
        return rows
    for entry in raw_data:
        if not isinstance(entry, dict):
            continue
        row: dict[str, Any] = {}
        dim_entries = entry.get("dimensions")
        if isinstance(dim_entries, list):
            for d in dim_entries:
                if not isinstance(d, dict):
                    continue
                name = d.get("name")
                value = d.get("name_value") or d.get("value")
                if name:
                    row[str(name)] = value
        metric_values = entry.get("metrics")
        if isinstance(metric_values, list):
            for idx, mname in enumerate(metrics):
                row[mname] = metric_values[idx] if idx < len(metric_values) else None
        rows.append(row)
    return rows


def _safe_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _safe_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _safe_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    return None


__all__ = [
    "BASE_URL",
    "DEFAULT_LIMIT",
    "DEFAULT_OFFSET",
    "MAX_LIMIT",
    "IntegrationError",
    "MetrikaClient",
]
