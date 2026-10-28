# dsh-lmstudio-vision-fix

Плагин для **DeepSeek Harness (DSH)**, который убирает ошибку LM Studio:

```text
400: 'url' field must be a base64 encoded image
```

DSH часто сохраняет скриншоты и вложения как **WebP/PNG** (в том числе из‑за альфа-канала). Локальные vision-модели в LM Studio обычно принимают только **JPEG**. Плагин на хуке `llm/stream` конвертирует вложения в JPEG **только для указанных провайдеров** (по умолчанию `lmstudio`). UI настроек нет.

## Как это работает

- Слушает `llm/stream` с `{ global: true }` (иначе хук не видит вызовы LLM из изолированного fiber плагина).
- Для сообщений с `type: image` читает вложение, конвертирует в JPEG и подменяет attachment перед отправкой в адаптер.
- Конвертация через системный **`/usr/bin/sips`** (macOS). Нативный `sharp` из npm в Electron DSH не грузится из‑за hardened runtime / code signing.

## Требования

| Компонент | Версия |
|---|---|
| DeepSeek Harness | `0.2.x` (проверено на `0.2.1-rc.3`) |
| Node.js (для сборки) | ≥ 20 |
| ОС | **macOS** (нужен `sips`) |

## Установка

```bash
git clone https://github.com/Furkas91/dsh-plugin-lmstudio-image-fix.git
cd dsh-plugin-lmstudio-image-fix
pnpm install
pnpm build
```

Добавить в профиль desktop (приложение DeepSeek Harness):

```bash
dsh plugin --profile desktop add /path/to/dsh-lmstudio-vision-fix
```

Если DSH ругается на несовместимость peer-зависимостей:

```bash
dsh plugin --profile desktop allow-version dsh-lmstudio-vision-fix@0.1.0 \
  --dsh-version 0.2.1-rc.3 --accept-risk
dsh plugin --profile desktop add /path/to/dsh-lmstudio-vision-fix
```

После установки **перезапустите** DeepSeek Harness.

Плагин должен появиться в `~/.dsh/profiles/desktop/package.json` в `dependencies` и в `dsh.profile.bundles`.

## Конфиг

Патч бандла (`cordis.patch.yml` плагина) вставляет запись автоматически. При необходимости можно явно добавить в `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
    - id: lmstudio-vision-fix
      name: dsh-lmstudio-vision-fix
      config:
        providers:
          - lmstudio
        jpegQuality: 90
        convertOversized: true
        maxDimension: 2048
```

| Поле | Смысл |
|---|---|
| `providers` | Точное совпадение с `options.provider` (без учёта регистра) |
| `jpegQuality` | Качество JPEG, 1–100 |
| `convertOversized` | Уменьшать длинную сторону, если больше `maxDimension` |
| `maxDimension` | Макс. сторона в пикселях (0 = без ресайза) |

Остальные провайдеры (OpenAI, Anthropic и т.д.) не трогаются.

## Проверка

1. В DSH отправьте PNG/WebP-картинку модели LM Studio с vision (например `qwen3.8-27b-uncensored-mlx`).
2. Ошибка `400: 'url' field must be a base64 encoded image` больше не должна появляться.
3. В логе плагина:

```bash
cat ~/.dsh/lmstudio-vision-fix.log
```

Ожидаемые строки:

```text
apply() active
llm/stream hit provider=lmstudio ...
[lmstudio-vision-fix] image/webp → image/jpeg (... → ... bytes)
done changed=1
```

## Разработка

```bash
pnpm install
pnpm build
pnpm typecheck
```

После правок исходников пересоберите (`pnpm build`) и перезапустите DSH — профиль подключает плагин через `link:`, поэтому подхватывается свежий `lib/`.

## Лицензия

MIT
