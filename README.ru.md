# RG

RG — скилл для Codex, который отправляет нетривиальный поиск по репозиторию в явно закреплённые недорогие модели и не расходует контекст основной модели на широкие grep-проходы.

Маршрут по умолчанию:

1. `gpt-6-luna` с `low` выполняет ограниченный read-only поиск.
2. `gpt-6-sol` с `medium` запускается только после валидного ответа Luna с одним из разрешённых смысловых пробелов в доказательствах.
3. Ошибки авторизации, доступности модели, квоты, таймаута, формата результата или fingerprint модели останавливают маршрут. Если файлы изменились во время поиска, RG один раз повторяет весь маршрут. Повторное изменение останавливает поиск; скрытой смены модели нет.

RG переносит подход OpenBuild: явный `codex exec -m`, фиксированный reasoning effort, авторизация через ChatGPT subscription, очистка API-переменных окружения, read-only sandbox, отключённая вложенная делегация, строгий JSON-контракт, fingerprint рабочей копии и терминальные квитанции запуска.

## Установка

Нужны Node.js 20+, Git, Codex CLI с активным входом через ChatGPT и доступ к Luna/Sol. npm-зависимостей нет.

В версии 0.4.0 первый этап использует GPT-6 Luna, а средний переходит с GPT-5.6 Terra на GPT-6 Sol. Настройки моделей в репозитории и профиле пользователя сохраняют приоритет. Для перехода обновите или удалите свои переопределения; см. [конфигурацию](references/configuration.md).

В текущей конфигурации Codex пользовательские скиллы находятся в `$CODEX_HOME/skills`, обычно `~/.codex/skills`.

```powershell
git clone https://github.com/GeorgVahi/RG C:\PROJECTS\RG
New-Item -ItemType Junction -Path "$env:USERPROFILE\.codex\skills\rg" -Target "C:\PROJECTS\RG"
```

После установки откройте новую сессию Codex, чтобы каталог скиллов перечитался. Для постоянного приоритета добавьте в активный глобальный `AGENTS.md`:

```md
## Default repository search

- Before non-trivial repository grep, file/symbol/owner/test discovery, dependency tracing, or cross-file evidence gathering, use the installed $rg skill. Direct reads remain appropriate for an explicit or already-known path and for Git metadata. A live RG `session_id`/`cell_id` remains running regardless of the polling-window count; wait on the same process and allow targeted fallback only after a terminal failure or `rg.status.v1` with `terminal: true` and `fallback_allowed: true`.
```

## Использование

Обычно достаточно попросить Codex найти реализацию, владельца, тесты или проследить поток между файлами — implicit invocation включён. Явный вызов: `Use $rg to find ...`.

```text
node scripts/rg.mjs search --repo <git-root> --mode auto --query <запрос>
node scripts/rg.mjs search --repo <git-root> --mode fast --query <запрос>
node scripts/rg.mjs search --repo <git-root> --mode deep --query <запрос>
node scripts/rg.mjs status --run-id <run-id>
node scripts/rg.mjs status --receipt <абсолютный-путь-к-receipt.json>
node scripts/rg.mjs doctor --repo <git-root>
```

- `auto`: сначала Luna, затем Sol только по валидному evidence-trigger.
- `fast`: один проход Luna.
- `deep`: один явно запрошенный проход Sol.

Количество окон ожидания никогда не означает отказ RG. Пока исходный процесс жив, нужно продолжать опрашивать тот же `session_id`/`cell_id`. `RG_PROGRESS` сообщает `run_id` сразу и затем каждые 30 секунд. Если handle исходной сессии потерян, команда `status` читает receipt без запуска нового скаута. Только состояние `failed` с `terminal: true` и `fallback_allowed: true` разрешает минимальный targeted fallback; все `running_*`, а также `invalid` и `not_found`, запрещают его.

Проверка:

```text
npm run check
npm run doctor
```

`check` проверяет скилл, тесты и сквозной сценарий без обращения к моделям. `doctor` проверяет настройки и вход через ChatGPT; доступность моделей подтверждает только реальный поиск. При `fingerprint-drift` завершите или приостановите параллельные правки файлов перед повторным запуском.

Артефакты и квитанции сохраняются вне исследуемого репозитория в `$CODEX_HOME/rg/runs`. Подробности конфигурации — в [references/configuration.md](references/configuration.md).

Лицензия MIT. Архитектура раннера адаптирована из [OpenBuild](https://github.com/GeorgVahi/OpenBuild); атрибуция — в [NOTICE](NOTICE).
