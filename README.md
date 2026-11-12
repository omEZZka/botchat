# botCHAT

Мобильный мессенджер с ИИ-собеседниками, которые читают и правят файлы проекта,
запускают команды, ищут по коду и делегируют подзадачи субагентам.
Интерфейс — Telegram, поведение — агент. Модели облачные, ключи вводит пользователь.

- Kotlin, `minSdk 30`, `targetSdk 34`, `compileSdk 35`, только `arm64-v8a`
- UI: WebView + vanilla JS (`marked`, `DOMPurify`, `highlight.js`, `xterm.js` в `assets/ui/vendor`)
- Сеть: только через `Net.kt`; UI не видит URL и ключей
- Ключи: AES-GCM + Android Keystore, в экспорт не попадают

## Сборка

```bash
./gradlew assembleRelease
```

Для подписи положите `keystore.properties`:

```bash
cp keystore.properties.example keystore.properties
```

## CI

Push в `main` → GitHub Actions собирает подписанный release APK и публикует релиз
`build-N`. Секреты: `BOTCHAT_KEYSTORE_B64`, `BOTCHAT_KEYSTORE_PASSWORD`,
`BOTCHAT_KEY_ALIAS`, `BOTCHAT_KEY_PASSWORD` (кладёт `scripts/set-secret.sh`).

## Rootfs для bash

```bash
bash scripts/build-runtime.sh
```

Без rootfs приложение работает полностью, кроме инструмента `bash`.

## Документы

- `docs/ARCHITECTURE.md` — слои и поток данных
- `docs/DECISIONS.md` — зафиксированные решения
