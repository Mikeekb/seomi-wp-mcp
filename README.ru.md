# @seomi/wp-mcp

[English](./README.md) | **Русский**

Универсальный установщик SEOMI MCP Abilities — одна команда подключает любой WordPress-проект к AI-агенту. Идею эргономики позаимствовали у `ai-factory`: ставишь один раз глобально, дальше в каждом проекте — `init`.

```
npm install -g @seomi/wp-mcp
cd my-wp-project
seomi-wp-mcp init
```

Один `init` сделает следующее:

1. Спросит креды WordPress (URL, пользователь, application password) — локально и опционально для продакшена.
2. Запишет их в `.claude/.env`, **сохраняя** все остальные ключи и комментарии в файле.
3. **Автоматически установит** WP-плагины-зависимости (`abilities-api` и `mcp-adapter`) через WP-CLI, если он есть, либо распакует их в `wp-content/plugins/` как фолбэк.
4. Подключит mu-плагин [`seomi/wp-mcp-abilities`](https://github.com/Mikeekb/wp-mcp-abilities) как git submodule (или через Composer / plain clone — на выбор).
5. Положит скилл `aif-wp-mcp` в `.claude/skills/`, чтобы будущие `/aif`-сессии его видели.
6. Вставит managed-блок в основной файл AI-инструкций проекта (`AGENTS.md` или `CLAUDE.md`) между маркерами `<!-- seomi-wp-mcp:start -->` — файл определяется автоматически; если в проекте есть оба, блок синхронизируется в оба файла. Если ни одного нет — `init` спросит, какой создать (по умолчанию `AGENTS.md` как универсальный стандарт).
7. Запишет **project-scope** записи MCP-серверов в `.mcp.json` в корне проекта (каждый проект видит свой `wordpress-local`/`wordpress-prod`, никаких пересечений). Локальный сервер — stdio через WP-CLI `mcp-adapter serve`; прод — тот же транспорт, но с `--ssh=`, так что команды выполняются на проде через SSH.

Можно перезапускать сколько угодно — **идемпотентно**. Ничего не дублируется, ничего не затирается.

## Зачем это нужно

Когда подключаешь WordPress-проект к Claude или другому AI-агенту, обычно приходится:

- Установить плагин [WP Abilities API](https://github.com/WordPress/abilities-api).
- Установить плагин [MCP Adapter](https://github.com/WordPress/mcp-adapter).
- Положить mu-плагин с твоими `seomi/*` (или `your-brand/*`) абилками.
- Создать application password.
- Сохранить креды в `.claude/.env`.
- Зарегистрировать MCP-сервер в Claude через `claude mcp add ...`.
- Описать абилки в `CLAUDE.md`.
- Поставить ai-factory скилл, чтобы AI-агенты в первую очередь использовали MCP-абилки.

Это ~30 минут ручной возни, повторяющейся в каждом WP-проекте, и в каждом из этих шагов можно ошибиться. `seomi-wp-mcp init` сворачивает всё это в один интерактивный диалог.

## Команды

| Команда                              | Что делает                                                              |
|--------------------------------------|-------------------------------------------------------------------------|
| `seomi-wp-mcp init`                  | Интерактивная первоначальная настройка (см. выше)                       |
| `seomi-wp-mcp update`                | Подтягивает свежую версию mu-плагина и пересобирает managed-блок в `AGENTS.md`/`CLAUDE.md` |
| `seomi-wp-mcp doctor`                | Диагностика: env, mu-плагин, регистрация MCP-сервера, плагины-зависимости |
| `seomi-wp-mcp doctor --fix`          | Авто-починка: ставит/активирует Abilities API + MCP Adapter; ставит WP-CLI на прод, если его там нет |
| `seomi-wp-mcp --verbose <command>`   | Включает debug-логи для любой команды                                   |
| `seomi-wp-mcp --version`             | Показывает версию                                                        |

## Требования

- **Node 20+** для самого CLI.
- **PHP 8.0+** + **WordPress 6.4+** на целевом проекте.
- **WP-CLI** (рекомендуется) — для авто-установки плагинов через зависимости.
- **Claude Code CLI** — чтобы автоматически делать `claude mcp add`. Без него CLI просто печатает copy-paste команду, которую можно выполнить руками.

## SSH-доступ к проду

Если в `init` ты сконфигурировал production-таргет, CLI **предложит** настроить SSH-ключ ДО того, как пойдёт ставить плагины по `--ssh`. Сценарий:

1. Сгенерировать ключ `ed25519` (либо переиспользовать существующий `~/.ssh/id_ed25519`).
2. Скопировать публичный ключ на прод через `ssh-copy-id` — пароль SSH спрашивается **ровно один раз**. На системах без `ssh-copy-id` (типично для Windows OpenSSH) визард переключается на портируемый фолбэк `ssh ... cat >> authorized_keys`.
3. Верифицировать через `ssh -o BatchMode=yes ... 'echo ok'`. Если verify прошёл — все последующие wp-cli `--ssh=` вызовы (сейчас и в будущих ре-ранах) идут без пароля.
4. Если verify не прошёл — типично для хостингов уровня Beget, где `authorized_keys` можно править только через панель — визард напечатает публичный ключ и инструкцию, и спросит хочешь ли ты всё равно попробовать удалённую установку плагинов.

Если отказаться от визарда — wp-cli через SSH всё ещё работает, просто спросит пароль интерактивно на каждом вызове. (До 0.1.11 на Windows процесс **зависал** без видимого промпта — это пофикшено: для wp-cli с `--ssh=` теперь используется `stdio: ['inherit','pipe','inherit']`, и терминал пользователя сам обрабатывает пароль.)

### Авто-установка mu-плагина на прод (0.1.12+)

Если SSH к проду настроен **и** ты согласился ставить плагины-зависимости на прод (`installDepsProd`), `init` теперь автоматически ставит на прод и mu-плагин `seomi-mcp-abilities` — отдельного вопроса не задаётся. Используется тот же SSH-транспорт что и для `wp plugin install --ssh=`:

1. Probe: `ssh ... 'test -d <wpRoot>/wp-content/mu-plugins/seomi-mcp-abilities'` — уже стоит? пропуск.
2. Clone: `ssh ... 'mkdir -p ... && git clone --depth=1 <repo> ... && rm -rf .git'`.
3. Loader: `ssh ... 'cat > <wpRoot>/wp-content/mu-plugins/mcp-abilities.php'` — PHP-шим из 4 строк пишется через stdin.

Если какой-то шаг падает — `init` печатает готовый сниппет с точными remote-командами и телом PHP-loader'а, и установку можно завершить руками. **Требование:** на проде должен быть установлен `git` (`apt install git` / `yum install git`). До 0.1.12 на prod-only setup-ах mu-плагин приходилось ставить вручную после `init`.

### Авто-установка WP-CLI на прод (0.1.16+)

Режим `--ssh=` у WP-CLI работает так: локальный `wp` запускает `ssh user@host wp <args>`, то есть бинарь `wp` должен быть в **non-interactive PATH удалённого хоста**. До 0.1.16 отсутствие wp-cli на проде вылезало как `bash: line 1: wp: command not found` и обрубало всю установку прод-плагинов — приходилось ssh-иться вручную, ставить wp-cli, править `~/.bashrc` и перезапускать `init`.

Теперь `init` делает это сам прямо перед установкой прод-плагинов. Strategy chain (`src/lib/ssh-wp-cli-installer.mjs`):

1. **Probe** — `ssh ... 'command -v wp || command -v wp-cli.phar'`. Нашли? Ранний выход с `already-present`.
2. **Tool probe** — один round-trip: `command -v php; command -v curl; command -v wget`. Нет php → выход с понятной ошибкой (без php phar не запустится).
3. **Download** — стратегии по порядку: `curl` → `wget` → локальный fetch + ssh stdin pipe. Последний фолбэк работает даже если у прод-хоста нет исходящего HTTP — лишь бы у локальной машины был доступ к GitHub.
4. **Wrapper** — пишет shell-шим `$HOME/bin/wp` (`exec php "$HOME/bin/wp-cli.phar" "$@"`) через `ssh ... 'cat > $HOME/bin/wp'`.
5. **PATH** — добавляет `export PATH="$HOME/bin:$PATH"` в `~/.bashrc` и `~/.bash_profile` внутри блока-маркера `# >>> seomi-wp-mcp: PATH >>>`. Вставляется **в начало файла**, до стандартного гарда `[ -z "$PS1" ] && return` из дефолтного дебиановского `~/.bashrc` — иначе non-interactive ssh пропустит export. Маркер делает повторные запуски идемпотентными.
6. **Verify** — `ssh -o BatchMode=yes ... 'wp --info'`. Если падает (типично для шеред-хостингов уровня cPanel/Plesk/Beget, которые игнорируют `~/.bashrc` для non-interactive ssh), пробует `"$HOME/bin/wp" --info`. Успех на fallback возвращает `action: installed-no-path` с готовым `manualSnippet` и подсказкой в Next-steps.

Возможные результаты (в init summary видны как `Remote WP-CLI (prod)`):

| Action | Что значит |
|--------|------------|
| `already-present` | `wp` уже был в remote PATH — ничего не меняли. |
| `installed` | Скачали, написали wrapper, прописали PATH, `wp --info` работает. |
| `installed-no-path` | Phar + wrapper на месте, но non-interactive shell игнорит `~/.bashrc`. Используй `$HOME/bin/wp` напрямую, либо пропиши PATH через панель хостинга / `~/.ssh/environment`. См. [docs/troubleshooting.md](./docs/troubleshooting.md). |
| `failed` | Упал какой-то шаг до verify (ssh error, нет php, все download-стратегии не сработали). В `manualSnippet` — точные команды для ручной установки. |

`seomi-wp-mcp doctor` добавляет строку `Prod WP-CLI installed at <path>`, а `doctor --fix` прогоняет тот же `ensureWpCliOnSsh` flow на готовом setup-е без полного перезапуска `init`.

## Использование вместе с `ai-factory`

CLI задуман как соседствующий с [ai-factory](https://github.com/lee-to/ai-factory). Два эквивалентных пути:

**Путь А — полный установщик (рекомендуется для первой настройки проекта):**

```
aif init                          # базовая настройка ai-factory
seomi-wp-mcp init                 # наша интеграция (креды, mu-плагин, MCP-сервер, и т.д.)
```

`seomi-wp-mcp init` положит скилл `aif-wp-mcp` в `.claude/skills/aif-wp-mcp/`, и дальнейшие `/aif`-сессии распознают его автоматически когда увидят папку `wp-content/`.

**Путь Б — только скилл (когда абилки уже развёрнуты и хочется только AI-контекст):**

```
npx skills add Mikeekb/seomi-wp-mcp
```

Это установит **только** скилл `aif-wp-mcp` (из папки `skills/aif-wp-mcp/` в этом репо) — агент теперь знает про наши абилки, но `.claude/.env` не пишется и MCP-сервер не регистрируется. Подходит для read-only сессий, когда WP-проект уже настроен.

> **Discovery из `aif init`:** запланирован issue в [vercel-labs/skills](https://github.com/vercel-labs/skills) с просьбой проиндексировать `aif-wp-mcp` на [skills.sh](https://skills.sh), чтобы `aif init` сам предлагал нашу интеграцию через `npx skills search` когда увидит WordPress-проект. До того момента — двухшаговый флоу выше.

Скилл живёт в `.claude/skills/aif-wp-mcp/` — отдельной папке от `aif-*` скиллов от ai-factory, так что обновления ai-factory его **никогда не затирают**.

## Конфигурация

Все креды лежат в `.claude/.env` (он в gitignored). Ключи, которыми управляет CLI:

| Ключ                      | Назначение                                            |
|---------------------------|-------------------------------------------------------|
| `WP_LOCAL_URL`            | URL локального WordPress                              |
| `WP_LOCAL_USER`           | Пользователь WP для Basic auth                        |
| `WP_LOCAL_APP_PASSWORD`   | Application password локального юзера                 |
| `WP_LOCAL_MCP_SERVER`     | Имя MCP-сервера в конфиге Claude                      |
| `WP_PROD_URL` / `_USER` / `_APP_PASSWORD` / `_MCP_SERVER` | То же для продакшена                  |
| `WP_DEPS_REF`             | Опциональный пин для `abilities-api`/`mcp-adapter` (по умолчанию `trunk`) |

Другие ключи (которые ты добавишь сам, ключи `deploy-prod`, third-party токены) — **сохраняются** при повторных запусках `init`.

## Цепочка авто-установки плагинов-зависимостей

Для каждой зависимости `init` пытается стратегии по очереди:

1. **WP-CLI** (`wp plugin install <github-zip> --activate --force`) — предпочтительно, работает локально и удалённо при правильных `--path` / `--ssh`.
2. **Скачивание zip + распаковка** в `wp-content/plugins/<slug>/` — фолбэк когда WP-CLI нет. В этом режиме **активации не происходит** — CLI попросит активировать вручную из админки.
3. **Печать команды вручную** — последний резерв, CLI выдаёт готовый сниппет для copy-paste.

По умолчанию берётся `trunk`-ветка `WordPress/abilities-api` и `WordPress/mcp-adapter`. Зафиксировать конкретный ref можно через `--pin-deps <тэг-или-ветка>` или через `WP_DEPS_REF` в `.claude/.env`.

## Контракт идемпотентности

- `.claude/.env` обновляется методом **merge** — ключи, которые ты не трогал (комментарии, креды для deploy, third-party токены) сохраняются.
- Managed-блок в `AGENTS.md` / `CLAUDE.md` обёрнут в маркеры `<!-- seomi-wp-mcp:start --> ... <!-- seomi-wp-mcp:end -->` и регенерируется внутри них; всё что вне маркеров — нетронуто. CLI автоматически определяет, какой файл использует проект (или оба) — см. `src/lib/agent-md-target.mjs`.
- Регистрация MCP-серверов проверяет `claude mcp list` перед `claude mcp add` — дубликаты не появятся.
- `wp plugin is-active <slug>` проверяется перед install — повторных установок нет.
- Для release-tracked плагинов (сейчас это `mcp-adapter`) активная установка без `wp-content/plugins/<slug>/vendor/autoload.php` — например, когда более старая версия была поставлена из trunk-архива без `vendor/` — принудительно переустанавливается из release-asset GitHub. Admin-notice «Composer autoloader was not found» убирается без ручного вмешательства.

Запускай `seomi-wp-mcp init` хоть десять раз подряд — состояние проекта стабильно сходится к одному и тому же.

## Разработка

```bash
git clone https://github.com/Mikeekb/seomi-wp-mcp.git
cd seomi-wp-mcp
npm install
npm test         # node:test, без дополнительных зависимостей
node bin/seomi-wp-mcp.mjs --help
```

Структура:

```
bin/                    Точка входа
src/
  commands/             init, update, doctor
  lib/                  logger, markers, env-writer, claude-mcp, wp-plugin-installer,
                        ssh-key-setup, ssh-mu-plugin-installer
skills/
  aif-wp-mcp/           Скилл в стандартном пути (совместим с npx skills);
                        копируется в .claude/skills/ из этого источника на init
templates/
  claude-md-block.md    Managed-блок, который вставляется в AGENTS.md / CLAUDE.md
  claude-dotenv/        Референс .env.example
test/                   Тесты под node:test
```

## Лицензия

Proprietary — © SEOMI. См. `LICENSE`.

## Связанные проекты

- [seomi/wp-mcp-abilities](https://github.com/Mikeekb/wp-mcp-abilities) — mu-плагин, который ставит этот CLI.
- [WordPress/abilities-api](https://github.com/WordPress/abilities-api) — runtime-зависимость.
- [WordPress/mcp-adapter](https://github.com/WordPress/mcp-adapter) — runtime-зависимость.
- [ai-factory](https://github.com/lee-to/ai-factory) — спутник для AI-контекста разработки.

## Документация

| Раздел | Описание |
|--------|----------|
| [Troubleshooting](./docs/troubleshooting.md) | Типовые проблемы (в т.ч. WP-CLI не попал в PATH на шеред-хостинге) и способы починки |

---

Разработка и сопровождение — [Разработка сайтов SEOmi.ru](https://seomi.ru/).
