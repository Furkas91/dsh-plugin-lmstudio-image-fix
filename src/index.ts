import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import sharp from 'sharp'

export const name = 'lmstudio-vision-fix'

/** settings is required by DSH plugin loader even without a settings UI. */
export const inject = ['llm', 'attachments', 'settings']

export interface Config {
  /** Provider ids that should receive JPEG conversion (exact, case-insensitive). */
  providers: string[]
  jpegQuality: number
  convertOversized: boolean
  maxDimension: number
}

export const Config: Schema<Config> = Schema.object({
  providers: Schema.array(Schema.string()).default(['lmstudio']),
  jpegQuality: Schema.number().min(1).max(100).default(90),
  convertOversized: Schema.boolean().default(true),
  maxDimension: Schema.number().min(0).default(2048),
})

const TARGET_MIME = 'image/jpeg'
const TARGET_EXT = '.jpg'
const ALREADY_PROCESSED = new WeakSet<object>()

function providerAllowed(provider: string | undefined, allow: string[]): boolean {
  if (!provider) return false
  const needle = provider.toLowerCase()
  return allow.some((p) => p.toLowerCase() === needle)
}

async function toJpeg(input: Uint8Array, config: Config): Promise<Buffer> {
  let pipeline = sharp(Buffer.from(input))

  if (config.convertOversized && config.maxDimension > 0) {
    const meta = await pipeline.metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    if (Math.max(w, h) > config.maxDimension) {
      pipeline = pipeline.resize({
        width: config.maxDimension,
        height: config.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
    }
  }

  return pipeline.jpeg({ quality: config.jpegQuality, mozjpeg: true }).toBuffer()
}

export function apply(ctx: Context, config: Config) {
  const attachments: any = (ctx as any).attachments
  const llm: any = (ctx as any).llm

  const scope = (ctx as any).settings.register('lmstudio-vision-fix', Config, {
    base: config,
  })

  ctx.logger?.info?.(
    `[lmstudio-vision-fix] active; providers=${(scope.get().providers ?? []).join(',') || '(none)'}`,
  )

  ctx.on('llm/stream', async function* (options: any, next: any) {
    if (ALREADY_PROCESSED.has(options)) {
      yield* next()
      return
    }

    const current: Config = scope.get()
    if (!providerAllowed(options?.provider, current.providers ?? [])) {
      yield* next()
      return
    }

    let newOptions = options
    let changed = 0

    try {
      const messages = options?.messages
      if (Array.isArray(messages)) {
        const newMessages = await Promise.all(
          messages.map(async (msg: any) => {
            if (!Array.isArray(msg?.content)) return msg
            let blockChanged = false

            const newContent = await Promise.all(
              msg.content.map(async (block: any) => {
                if (block?.type !== 'image' || !block.attachment) return block
                const att = block.attachment
                if (att.mediaType === TARGET_MIME) return block

                try {
                  const read = await attachments.readImage(att)
                  if (!read?.data) return block

                  const converted = await toJpeg(read.data, current)
                  const baseName = (att.name ?? 'converted').replace(/\.[^.]+$/, '')
                  const saved = await attachments.saveImage({
                    data: converted,
                    mediaType: TARGET_MIME,
                    name: `${baseName}${TARGET_EXT}`,
                  })

                  blockChanged = true
                  changed++
                  ctx.logger?.info?.(
                    `[lmstudio-vision-fix] ${att.mediaType} → ${TARGET_MIME} ` +
                      `(${read.data.length} → ${converted.length} bytes)`,
                  )
                  return { type: 'image', attachment: saved }
                } catch (e) {
                  ctx.logger?.warn?.(
                    `[lmstudio-vision-fix] convert failed ` +
                      `${att.attachmentId}: ${(e as Error).message}`,
                  )
                  return block
                }
              }),
            )

            return blockChanged ? { ...msg, content: newContent } : msg
          }),
        )

        if (changed > 0) newOptions = { ...options, messages: newMessages }
      }
    } catch (e) {
      ctx.logger?.warn?.(
        `[lmstudio-vision-fix] llm/stream error: ${(e as Error).message}`,
      )
      newOptions = options
    }

    if (changed === 0) {
      yield* next()
      return
    }

    ALREADY_PROCESSED.add(newOptions)
    yield* llm.stream(newOptions)
  })
}
