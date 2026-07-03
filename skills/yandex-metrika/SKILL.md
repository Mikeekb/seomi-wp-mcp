---
name: yandex-metrika
description: >
  Activate whenever the user works with Yandex Metrica (Яндекс.Метрика) analytics
  via AI: creating/editing/deleting goals (цели), viewing analytics reports
  (визиты, конверсии, источники трафика), saving reports to the project, or
  managing audience segments (сегменты аудитории). Auto-trigger when the project
  has a `yandex-metrika` MCP server registered in `.mcp.json` or `METRIKA_*`
  keys in `.claude/.env`.

  Triggers (Russian and English):
  - "добавь цель в метрике", "создай цель", "измени цель", "удали цель",
    "покажи конверсии", "отчёт по трафику", "источники трафика", "визиты за неделю",
    "сохрани отчёт", "создай сегмент аудитории", "сегменты метрики"
  - "add a Metrica goal", "create/edit/delete goal", "traffic report",
    "show conversions", "save report", "create audience segment"

  Do NOT trigger for: Google Analytics, other analytics platforms, or generic
  web analytics unrelated to Yandex Metrica.
---

# yandex-metrika — работа с Яндекс.Метрикой через MCP

Проект подключён к Яндекс.Метрике через MCP-сервер `yandex-metrika` (Python,
`.claude/mcp-servers/yandex-metrika/`). Инструменты вызываются как MCP-tools с
префиксом `yandex_metrika_*`. Токен и ID счётчиков лежат в `.claude/.env`
(`METRIKA_OAUTH_TOKEN`, `METRIKA_COUNTER_ID`) — **никогда не печатай и не
логируй значение токена**.

## Доступные инструменты

### Чтение / аналитика
- `yandex_metrika_get_counter_info` — какие счётчики настроены (без HTTP).
- `yandex_metrika_list_counters` — все счётчики, доступные по токену.
- `yandex_metrika_list_goals(counter_id?)` — цели счётчика.
- `yandex_metrika_get_report(metrics, date1, date2, dimensions?, filters?, sort?, …)`
  — произвольный отчёт (визиты, конверсии, источники, UTM, устройства).
- `yandex_metrika_list_direct_campaigns(date1, date2, …)` — кампании Директа со счётчика.

### Запись целей (нужен токен с правом редактирования счётчика)
- `yandex_metrika_create_goal(name, type, conditions?, counter_id?, …)`
- `yandex_metrika_update_goal(goal_id, name, type, conditions?, …)` — Метрика
  заменяет объект целиком (PUT): передавай полный набор полей, а не только дельту.
- `yandex_metrika_delete_goal(goal_id, counter_id?)` — необратимо.

### Сохранение отчётов
- `yandex_metrika_save_report(name, metrics, date1, date2, …)` — выполняет отчёт
  и сохраняет `.ai-factory/metrika-reports/<date2>_<slug>.json` (данные) и `.md`
  (таблица). Файлы версионируются в git.

### Сегменты аудитории (нужен токен с правом metrika:write)
- `yandex_metrika_list_segments(counter_id?)`
- `yandex_metrika_create_segment(name, expression, counter_id?)`
- `yandex_metrika_update_segment(segment_id, name?, expression?, …)`
- `yandex_metrika_delete_segment(segment_id, counter_id?)`

## Правила

1. **Мультисчётчик.** `METRIKA_COUNTER_ID` может быть списком (основной сайт +
   лендинг). Для management-операций (цели, сегменты, `list_goals`) при нескольких
   счётчиках `counter_id` **обязателен** — иначе вернётся `BadRequest("ambiguous")`.
   Для отчётов (`get_report`) по умолчанию агрегируются все счётчики.
2. **Namespace метрик.** Нельзя смешивать `ym:s:` (сессии) и `ym:pv:` (хиты) в
   одном отчёте — сервер отклонит запрос.
3. **Цели → метрики.** Чтобы посчитать конверсию по цели, сперва возьми её `id`
   через `list_goals`, затем строй метрики `ym:s:goal<ID>visits`,
   `ym:s:goal<ID>conversionRate`, `ym:s:goal<ID>reaches`.
4. **Типы целей:** `action, chat, email, file, messenger, number, payment_system,
   phone, search, social, step, url, visit_duration`. Условия (`conditions`) —
   список `{type, url}`; типы условий: `contain, exact, start, regexp, action,
   messenger, all_files, file, search, all_social, social, regexp_action,
   contain_action`. Пример url-цели: `[{"type":"contain","url":"/thanks"}]`.
5. **Сегменты через API не видны в веб-интерфейсе Метрики** — это ограничение
   API. `expression` — выражение сегментации, напр. `ym:s:trafficSource=='organic'`.
6. **Формат дат:** `YYYY-MM-DD`, либо `today`/`yesterday`/`NdaysAgo` (напр. `7daysAgo`).
7. **Rate limits Метрики:** 30 rps, 5000 запросов/день, 200/5мин для отчётов.
   HTTP 420/429 маппятся в ошибку `RATE_LIMIT` — при ней делай паузу, не долби.
8. **Ошибки** возвращаются как `{error, code, status}` (`AUTH`, `BAD_REQUEST`,
   `NOT_FOUND`, `RATE_LIMIT`, `UPSTREAM`) — не считай их успехом, покажи причину.

## Hard don'ts
- Не печатай/не логируй значение `METRIKA_OAUTH_TOKEN`.
- Не пиши цели/сегменты «наугад» без явного запроса пользователя — это запись в
  боевой счётчик.
- Перед `delete_goal` / `delete_segment` убедись, что пользователь подтвердил —
  операции необратимы.
