/**
 * R3a 移植 —— `radio`。§4 的 `ReadOnlyTool` 一族。
 *
 * 描述、参数、输出文案逐字沿用旧 `tools/builtin/radio.ts`;开台 / 关台 / 点歌
 * 那台机器在 adapters 后面(`music/radio.ts`),这里一行都不重写。
 *
 * **无效果**:旧实现 `permissionGuard: 'safe'`、没有 `analyze`。它确实会让音响
 * 响起来,但那不是本仓权限系统认识的效果类,而为它发明一个 kind 属于"功能形状
 * 的洞"(§10.2-② 的纪律)。这一格在 §13 里记了一笔。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import { defineInput } from '../contract.js'
import { ReadOnlyTool } from '../families/read-only.js'

export interface RadioToolStatus {
  active: boolean
  intent: string
  programmeLength: number
  nowPlayingTitle?: string
  lastError?: string
}

export interface RadioToolAdapters {
  /** Stage+apply the intent (open or retune); retune also clears the programme. */
  open(intent: string, options: { clearProgramme: boolean }, executionContext?: unknown): Promise<RadioToolStatus>
  /** active:false + stop playback, in the order that avoids auto-revive. */
  close(executionContext?: unknown): Promise<RadioToolStatus>
  status(executionContext?: unknown): RadioToolStatus
  /** Cut a named song in as the next track (search + playability check inside). */
  request(song: string, executionContext?: unknown): Promise<{ success: boolean; title?: string; error?: string }>
}

export const RadioInputSchema = z.object({
  action: z
    .enum(['open', 'retune', 'close', 'status', 'request'])
    .describe(
      'open: start the station with an intent (the DJ agent curates and playback starts automatically). retune: change direction — new intent, old programme discarded. close: stop the station and the music. status: read current state. request: cut a specific song in as the next track (station must be on).',
    ),
  intent: z
    .string()
    .optional()
    .describe(
      'Required for open/retune: the listener\'s mood/style in one plain sentence, e.g. 「下雨天,安静的中文民谣」. This becomes the station\'s brief for the DJ.',
    ),
  song: z
    .string()
    .optional()
    .describe(
      'Required for request: the song the user named, ideally 「歌名 歌手」. The app searches, verifies playability, and queues it next — never play it manually while the radio is on.',
    ),
})

export const RADIO_DESCRIPTION = `Run the personal radio station — the default way to play music that keeps going ("放点歌", "来点轻音乐,一直放着"). Call open with a one-sentence intent; the DJ agent curates the programme and playback starts on its own (first song within ~a minute). You never pick songs yourself.

- open: start (or restart) with an intent. retune: new direction, pass the new intent. close: the user is done ("别放了"). status: what is playing, songs left, problems. request: the user names a song while the station is on — it cuts in as the next track; NEVER play manually while the radio is on.
- Only play manually (ncm-cli via bash, see the netease-music-cli skill) when the user names ONE song AND the radio is off.`

const RadioContract = defineInput(RadioInputSchema)

export type RadioInput = z.infer<typeof RadioInputSchema>

function describeStatus(status: RadioToolStatus): string {
  return [
    `active: ${status.active}`,
    status.intent ? `intent: ${status.intent}` : null,
    `programme_left: ${status.programmeLength}`,
    status.nowPlayingTitle ? `now_playing: ${status.nowPlayingTitle}` : null,
    status.lastError ? `last_error: ${status.lastError}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

export class RadioTool extends ReadOnlyTool<RadioInput> {
  private readonly adapters: RadioToolAdapters

  readonly spec: ToolSpec = {
    id: 'radio',
    title: 'Radio',
    description: RADIO_DESCRIPTION,
    input: RadioContract.schema,
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'sequential',
  }

  constructor(adapters: RadioToolAdapters) {
    super()
    this.adapters = adapters
  }

  protected async perform(input: RadioInput, ctx: RunContext): Promise<Result> {
    if (input.action === 'request') {
      const song = input.song?.trim()
      if (!song) {
        return this.done(ctx, '缺少歌名', 'request 需要 song:用户点名想听的歌,尽量带歌手,如「晴天 周杰伦」。', { action: input.action })
      }
      const requested = await this.adapters.request(song, ctx.invocation.executionContext)
      if (!requested.success) {
        return this.done(ctx, '点歌失败', requested.error ?? '点歌失败', { action: input.action })
      }
      return this.done(
        ctx,
        '已插队',
        `「${requested.title}」将在下一首播出${requested.error ? `(${requested.error})` : ''}。向用户确认时报这个完整歌名。`,
        { action: input.action },
      )
    }

    if (input.action === 'status') {
      const status = this.adapters.status(ctx.invocation.executionContext)
      return this.done(ctx, status.active ? '电台状态' : '电台未开', describeStatus(status), { action: input.action })
    }

    if (input.action === 'close') {
      const status = await this.adapters.close(ctx.invocation.executionContext)
      return this.done(ctx, '电台已关', describeStatus(status), { action: input.action })
    }

    const intent = input.intent?.trim()
    // Length 1 is never a real direction — historically always debris ('x'),
    // and a station briefed with debris curates blind.
    if (!intent || intent.length < 2) {
      return this.done(
        ctx,
        '缺少意图',
        'open/retune 需要 intent:用一句话概括听众想要的氛围(时间、心情、风格),不要用占位符或单个字符。',
        { action: input.action },
      )
    }

    const status = await this.adapters.open(intent, { clearProgramme: input.action === 'retune' }, ctx.invocation.executionContext)
    return this.done(
      ctx,
      input.action === 'retune' ? '已换台' : '电台已开',
      `${describeStatus(status)}\n\nDJ 正在编排:先凑一小批让音乐尽快响(通常两三分钟内第一首开播),然后边播边补全节目单、准备串词。可随时用 radio(action: "status") 查看进度;向用户转述时请如实说明这个节奏,不要承诺"马上"。`,
      { action: input.action },
    )
  }

  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createRadioTool(adapters: RadioToolAdapters): RadioTool {
  return new RadioTool(adapters)
}
