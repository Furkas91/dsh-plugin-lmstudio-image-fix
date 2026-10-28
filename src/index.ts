import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEBUG_LOG = `${process.env.HOME ?? tmpdir()}/.dsh/lmstudio-vision-fix.log`

function debug(msg: string) {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* ignore */
  }
}

debug(`module loaded pid=${process.pid}`)

export const name = 'lmstudio-vision-fix'

export const inject = ['llm', 'attachments']

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

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || 'no stderr'}`))
    })
  })
}

/**
 * Convert via macOS `sips`. External Electron plugins cannot dlopen npm `sharp`
 * under DSH's hardened runtime (Team ID / library validation).
 */
async function toJpeg(input: Uint8Array, config: Config): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vision-fix-'))
  const src = join(dir, 'input.bin')
  const dst = join(dir, 'output.jpg')
  try {
    writeFileSync(src, input)
    const args = ['-s', 'format', 'jpeg']
    if (config.convertOversized && config.maxDimension > 0) {
      args.push('--resampleHeightWidthMax', String(config.maxDimension))
    }
    const q = Math.min(1, Math.max(0.01, config.jpegQuality / 100))
    args.push('-s', 'formatOptions', String(q), src, '--out', dst)
    await run('/usr/bin/sips', args)
    return readFileSync(dst)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function apply(ctx: Context, config: Config) {
  debug(`apply() enter providers=${(config.providers ?? []).join(',')}`)
  const attachments: any = (ctx as any).attachments
  const llm: any = (ctx as any).llm

  // DSH 0.2 settings API: opt out of auto settings page (no settings.register).
  ;(ctx as any).inject?.(['settings'], (child: any) => {
    child.effect(() => child.settings.configure({ auto: false }, (ctx as any).fiber))
  })

  ctx.logger?.info?.(
    `[lmstudio-vision-fix] active; providers=${(config.providers ?? []).join(',') || '(none)'}`,
  )
  debug(`apply() active`)

  // global:true — plugin fiber is isolated from the llm service; without it the
  // waterfall filter drops this listener (same pattern as dsh-session-title).
  ctx.on(
    'llm/stream',
    async function* (options: any, next: any) {
      debug(
        `llm/stream hit provider=${options?.provider} model=${options?.model} ` +
          `msgs=${Array.isArray(options?.messages) ? options.messages.length : -1}`,
      )

      if (ALREADY_PROCESSED.has(options)) {
        yield* next()
        return
      }

      if (!providerAllowed(options?.provider, config.providers ?? [])) {
        debug(`skip provider=${options?.provider}`)
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
                    if (!read?.data) {
                      debug(`readImage empty ${att.attachmentId}`)
                      return block
                    }

                    const converted = await toJpeg(read.data, config)
                    const baseName = (att.name ?? 'converted').replace(/\.[^.]+$/, '')
                    const saved = await attachments.saveImage({
                      data: converted,
                      mediaType: TARGET_MIME,
                      name: `${baseName}${TARGET_EXT}`,
                    })

                    blockChanged = true
                    changed++
                    const line =
                      `[lmstudio-vision-fix] ${att.mediaType} → ${TARGET_MIME} ` +
                      `(${read.data.length} → ${converted.length} bytes)`
                    ctx.logger?.info?.(line)
                    debug(line)
                    return { type: 'image', attachment: saved }
                  } catch (e) {
                    const line =
                      `[lmstudio-vision-fix] convert failed ` +
                      `${att.attachmentId}: ${(e as Error).message}`
                    ctx.logger?.warn?.(line)
                    debug(line)
                    return block
                  }
                }),
              )

              return blockChanged ? { ...msg, content: newContent } : msg
            }),
          )

          if (changed > 0) {
            // options is frozen — rebuild and re-enter via llm.stream.
            newOptions = { ...options, messages: newMessages }
          }
        }
      } catch (e) {
        const line = `[lmstudio-vision-fix] llm/stream error: ${(e as Error).message}`
        ctx.logger?.warn?.(line)
        debug(line)
        newOptions = options
      }

      debug(`done changed=${changed}`)
      if (changed === 0) {
        yield* next()
        return
      }

      ALREADY_PROCESSED.add(newOptions)
      yield* llm.stream(newOptions)
    },
    { global: true },
  )
}
