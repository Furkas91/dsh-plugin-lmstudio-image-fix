# dsh-lmstudio-vision-fix

Thin DeepSeek Harness plugin that fixes:

`400: 'url' field must be a base64 encoded image`

when sending images to **LM Studio** vision models. DSH often attaches WebP/PNG;
local LM Studio models typically expect JPEG. This plugin converts image
attachments to JPEG on the `llm/stream` hook **only for configured providers**
(default: `lmstudio`). No settings UI.

## Install

Clone this private repo, then:

```bash
pnpm install
pnpm build
dsh plugin --profile web add .
```

For a local checkout already built:

```bash
dsh plugin --profile web add /path/to/dsh-lmstudio-vision-fix
```


## Config

Edit `cordis.patch.yml`, then restart DSH:

```yaml
- insert:
    - id: lmstudio-vision-fix
      name: 'dsh-lmstudio-vision-fix'
      config:
        providers:
          - lmstudio
        jpegQuality: 90
        convertOversized: true
        maxDimension: 2048
```

- `providers` — case-insensitive exact match on `options.provider`
- Other providers are left untouched (OpenAI / Anthropic / etc.)

## Verify

In DSH host logs after sending an image to an LM Studio vision model:

```
[lmstudio-vision-fix] active; providers=lmstudio
[lmstudio-vision-fix] image/webp → image/jpeg (... → ... bytes)
```

## Requirements

| Component | Version |
|---|---|
| DeepSeek Harness | `0.1.2-rc.1`+ |
| Node.js | ≥ 20 |

## Develop

```bash
pnpm install
pnpm build
```

## License

MIT
