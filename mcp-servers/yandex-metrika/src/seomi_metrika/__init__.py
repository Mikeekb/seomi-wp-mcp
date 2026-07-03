"""MCP-сервер для Яндекс.Метрики (Management + Reporting API, чтение и запись).

Портирован из lk-amo-roistat и расширен write-инструментами (цели, сегменты)
и сохранением отчётов. Не зависит от workspace-пакета lk-core — все нужные
утилиты (errors, http, logging) инлайнены в приватные модули `_errors`,
`_http`, `_logging`.
"""
