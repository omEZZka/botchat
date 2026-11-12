# Архитектура botCHAT

## Слои

| Слой | Файл | Ответственность |
| --- | --- | --- |
| Сеть | `Net.kt` | Единственная точка HTTP/SSE: таймауты, отмена, повторы только для идемпотентных запросов, экспоненциальный backoff, читаемые ошибки. |
| Провайдеры | `Providers.kt` | Каталог, нормализация в «сообщение + tool_calls + streaming-дельты», health, кольцо ключей, кастомные провайдеры. |
| Модели | `Models.kt` (объект в `Api.kt`) | Кеш `/models`, обновление, метаданные. |
| Диалог | `ChatEngine.kt` | Один шаг генерации: потоки OpenAI / Anthropic / Gemini → события `llm.delta`, `llm.tool`, `llm.done`, `llm.error`. |
| Агент | `Agent.kt` + `js/agent.js` | Машина состояний `plan → tool_call → result → continue`, лимит шагов, пауза, отмена. |
| Инструменты | `Tools.kt` | `read/write/edit/bash/grep/glob/list/webfetch/todo/task`; песочница `canonicalPath`, лимиты вывода и времени. |
| Субагенты | `SubAgents.kt` | Очередь дочерних сессий, статусы `queued/running/done/error`. |
| Runtime | `Runtime.kt` | rootfs + proot, маппинг `/workspace`, ring-буфер вывода. |
| Чекпоинты | `Checkpoints.kt` | Shadow-снимки папки чата перед изменениями, откат. |
| Фон | `AgentService.kt`, `Notifier.kt`, `TileService.kt`, `OverlayService.kt`, `widget/` | Одно состояние (`AppState`), действия без дублирования логики. |
| Мост | `MainActivity.kt` | `BCBridge.call(method, json)` → `api`, `tool`, `fs`, `copy`, `share`, … |
| UI | `assets/ui` | Vanilla JS, `store.js` (S + bus), `render.js`, `chat.js`, `agent.js`. |

## Поток данных

```
DOM-событие → Actions/Agent → Native.api / Native.tool (Kotlin)
           → Net/Providers/Tools → события BCEmit
           → Bus → S (store.js) → render.js
```

DOM-обработчики никогда не вызывают сеть напрямую. Ключи не покидают `Secrets`.

## Персистентность

- Настройки: `localStorage` с префиксом `bc.*`.
- История: IndexedDB (`chats`, `messages`, `blobs`, `meta`); рендер окном, батчинг записи.
- Черновики: `localStorage` (`bc.drafts`), очередь офлайна — `bc.queue`.
- Шаги агента и чекпоинты: файлы в папке чата (`steps.jsonl`, `.checkpoints`).

## Песочница

Рабочая папка чата: `files/workspace/<chatId>`. Любой путь приводится `canonicalPath`
и отклоняется, если выходит за пределы папки. `bash` исполняется только при наличии
rootfs, монтирует папку чата в `/workspace`.

## Фоновые поверхности

`AppState` хранит последний снимок статуса, опубликованный UI. Виджет, плитка и
плавающий индикатор только читают его и вызывают `Agent.stop`/открытие чата.
