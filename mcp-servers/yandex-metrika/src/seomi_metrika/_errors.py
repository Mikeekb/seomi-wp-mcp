"""Иерархия исключений для MCP-сервера Метрики.

Все ошибки внешнего API маппятся в один из подклассов IntegrationError — это
даёт tools единый контракт на ловлю и формат ответа агенту. Инлайн-порт
lk_core.errors, чтобы сервер не зависел от workspace-пакета.
"""

from __future__ import annotations


class IntegrationError(Exception):
    """База: любая ошибка обращения к внешнему API."""

    code: str = "INTEGRATION"

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status

    def to_dict(self) -> dict[str, object]:
        """Структурированный ответ для MCP-tool."""
        return {"error": str(self), "code": self.code, "status": self.status}


class AuthError(IntegrationError):
    """401 / 403 — токен невалиден или не имеет прав."""

    code = "AUTH"


class BadRequest(IntegrationError):
    """400 — запрос составлен неверно."""

    code = "BAD_REQUEST"


class NotFound(IntegrationError):
    """404 — ресурс не найден."""

    code = "NOT_FOUND"


class RateLimited(IntegrationError):
    """429 / 420 — превышен лимит запросов."""

    code = "RATE_LIMIT"

    def __init__(
        self,
        message: str,
        *,
        retry_after: str | None = None,
        status: int | None = 429,
    ) -> None:
        super().__init__(message, status=status)
        self.retry_after = retry_after

    def to_dict(self) -> dict[str, object]:
        payload = super().to_dict()
        payload["retry_after"] = self.retry_after
        return payload


class UpstreamError(IntegrationError):
    """5xx и сетевые сбои — временная проблема на стороне API."""

    code = "UPSTREAM"


__all__ = [
    "AuthError",
    "BadRequest",
    "IntegrationError",
    "NotFound",
    "RateLimited",
    "UpstreamError",
]
