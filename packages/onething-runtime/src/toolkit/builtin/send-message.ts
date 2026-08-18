/**
 * R3a 移植 —— `send_message`。§4 的 `CollabTool` 一族。
 *
 * 描述、参数、路由规则、回执、校验失败文案逐字沿用旧 `tools/builtin/say.ts`;
 * 落库 / 建房 / 送达即激活那台机器照旧全部在 adapters 后面。
 *
 * ## 效果:一条 `session_message`
 *
 * 四个协作工具里只有它真的把东西送出去,所以只有它报效果(§4 家族表)。
 * `session_message` 在策略表里是 `silent` —— 今天跨会话投递不弹卡,声明它不改变
 * 这件事,只是让"这次调用会往某条会话里写一条消息"进审计。
 *
 * ## 场子门在哪
 *
 * 面上:`CollabTool.visibleIn` 按 `COLLAB_TOOL_VENUES` 摘(chat 场子看不见它)。
 * 硬调时:**拒绝仍然由执行器给** —— `resolveSayContext` 找不到房时那句
 * `COLLAB_SAY_REFUSED_NO_ROOM` 是精心写过的可操作措辞,而且它同时覆盖"不在场子里"
 * 与"场子对但没有房"两种事实。把它提到 plan 里等于把两句话合并成一句更含糊的。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import { makeEffect } from '@onething/core/toolkit'
import type { Effect, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import type { CollabVenueTool } from '../../collab/tool-surface.js'
import {
  COLLAB_SAY_REFUSED_EMPTY,
  COLLAB_SEND_MESSAGE_TOOL_NAME,
  COLLAB_SEND_REFUSED_GATEWAY,
  formatCollabDmReceipt,
  formatCollabSayReceipt,
  resolveCollabSendChannel,
} from '../../collab/index.js'
import { defineInput, listZodIssues } from '../contract.js'
import { CollabTool, type CollabToolAdapters, type CollabScope } from '../families/collab.js'

export interface SayToolResult {
  ok: boolean
  messageId?: string
  error?: string
}

export interface CollabDmSendResult {
  ok: boolean
  targetKind?: 'user' | 'agent'
  roomSessionId?: string
  messageId?: string
  peerName?: string
  wakeRoomName?: string
  error?: string
}

export interface SendMessageToolAdapters extends CollabToolAdapters {
  speak(input: {
    sessionId: string
    content: string
    mentions?: string[]
    replyTo?: string
    room?: string
  }): Promise<SayToolResult>

  sendDm(input: {
    sessionId: string
    to: string
    content: string
    wake?: boolean
    wakeRoom?: string
  }): Promise<CollabDmSendResult>
}

export const SendMessageInputSchema = z.object({
  content: z.string().describe('The message to deliver, exactly as it will appear in the chat. Keep it a chat message — short lines, not an essay; markdown (lists, tables, code) renders fine when the content calls for it.'),
  to: z.string().optional()
    .describe('Send this to ONE person privately instead of into this chat, as the roster writes them: 名字#句柄 (or just #句柄). A bare name works when only one colleague goes by it. Write 用户 (or the user\'s own 名字#句柄) to reach the user themselves.'),
  channel: z.enum(['room', 'dm', 'gateway']).optional()
    .describe('Where this goes. Leave it out: "dm" when you gave a "to", "room" otherwise.'),
  wake: z.boolean().optional()
    .describe('Private messages only: after they have read it, an @ goes out in the room asking them to respond there. None of the private message is carried over — only the fact that you wrote to them.'),
  wakeRoom: z.string().optional()
    .describe('Which chat that @ goes into. Leave it out: by default it is the chat this turn is answering.'),
  mentions: z.array(z.string()).optional()
    .describe('Agent ids to address. Rarely needed: writing @名字#句柄 in the content (the handle is what the roster shows after each name) already addresses them exactly.'),
  replyTo: z.string().optional()
    .describe('Message id this is a reply to — the chat shows your message with that one quoted above it. Only worth using when the thing you answer has scrolled away.'),
  room: z.string().optional()
    .describe('Session id of the chat to send into. Leave it out: by default it goes to the chat whose message you are answering.'),
})

export const SEND_MESSAGE_DESCRIPTION = `Send a message to the chat, or privately to one person.
Exactly like pressing send in a chat app: only the text passed as "content" gets delivered. Nothing written anywhere else is visible to anyone.

- One call = one message bubble; send a few short messages the way people do.
- markdown in "content" renders fine (lists, tables, code).
- @名字#句柄 addresses someone (handle from the roster); "replyTo" quotes a message.
- If the chat is paused or out of budget the send FAILS and tells you so.

With "to" it goes to a private chat with that one person instead — opened if it does not exist yet, and they get pulled in to answer.
- Use it to settle a detail with one person instead of making the whole group read it. Bring the conclusion back with a plain send_message.
- NOTHING is carried over: they cannot see this conversation, the board, or what you were just asked. Whatever background they need, write it into the message.
- The user can see and join that private chat — it is a side room, not a back channel.
- You can write to the user themselves (to: "用户" or their name/handle). They may be away; the message waits with a notification, don't block on a reply.
- A private chat is for talking. Work that actually changes things goes back to the group as a board card.
- "wake": after they read it, an @ goes out in the room asking them to respond there. Use it when you need them to show up in the group, not just to read you.
- Fails (and tells you so) if "to" names no active colleague, if two colleagues share the name you gave (add the handle), or if it is you.`

/**
 * legacy `dm` 的**降级出口**:`message` 被 zod strip 掉、`content` 缺席时,逐字
 * 给出那句可操作的拒绝语,而不是一坨 zod issue。其余校验错误按常规逐条列出 ——
 * 把它们也说成「content 是空的」会把模型引到错的地方。
 */
const SendMessageContract = defineInput(SendMessageInputSchema, {
  formatError(error) {
    if (error.issues.some(issue => issue.path[0] === 'content')) return COLLAB_SAY_REFUSED_EMPTY
    return `Invalid send_message parameters:\n${listZodIssues(error)}`
  },
})

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>

export class SendMessageTool extends CollabTool<SendMessageInput> {
  protected readonly venueTool: CollabVenueTool = 'send_message'
  private readonly adapters: SendMessageToolAdapters

  readonly spec: ToolSpec = {
    id: COLLAB_SEND_MESSAGE_TOOL_NAME,
    title: 'Send message',
    description: SEND_MESSAGE_DESCRIPTION,
    input: SendMessageContract.schema,
    effects: ['session_message'],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'sequential',
  }

  constructor(adapters: SendMessageToolAdapters) {
    super(adapters)
    this.adapters = adapters
  }

  protected effectsFor(scope: CollabScope<SendMessageInput>): Effect[] {
    const input = scope.input
    const target = input.to?.trim() || input.room?.trim() || scope.sessionId
    return [makeEffect('session_message', [target], {
      metadata: { channel: input.channel, to: input.to, room: input.room },
    })]
  }

  protected async perform(scope: CollabScope<SendMessageInput>, ctx: RunContext): Promise<Result> {
    const args = scope.input
    // 路由是纯规则(设计 §2.1/§2.3):推断 + 矛盾检查在一处,门在执行器里。
    const route = resolveCollabSendChannel(args)
    if (!route.ok) return this.done(ctx, 'Send message — 未送达', route.error, { ok: false })

    if (route.channel === 'gateway') {
      // P3 才接 outbound dispatch。占坑的意义在于:那一天改的是这一支,不是工具契约。
      return this.done(ctx, 'Send message — 未送达', COLLAB_SEND_REFUSED_GATEWAY, { ok: false })
    }

    if (route.channel === 'dm') {
      const dm = await this.adapters.sendDm({
        sessionId: scope.sessionId,
        to: args.to ?? '',
        content: args.content,
        ...(args.wake ? { wake: true } : {}),
        ...(args.wakeRoom ? { wakeRoom: args.wakeRoom } : {}),
      })
      if (!dm.ok) {
        return this.done(ctx, 'Send message — 未送达', dm.error ?? '私聊未送达。', { ok: false })
      }
      return this.done(
        ctx,
        'Send message',
        formatCollabDmReceipt({
          targetKind: dm.targetKind ?? 'agent',
          peerName: dm.peerName || (args.to ?? ''),
          ...(dm.wakeRoomName ? { wakeRoomName: dm.wakeRoomName } : {}),
        }),
        { ok: true, roomSessionId: dm.roomSessionId, messageId: dm.messageId },
      )
    }

    const result = await this.adapters.speak({
      sessionId: scope.sessionId,
      content: args.content,
      ...(args.mentions ? { mentions: args.mentions } : {}),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      ...(args.room ? { room: args.room } : {}),
    })

    if (!result.ok) {
      return this.done(ctx, 'Send message — 未送达', result.error ?? '消息未送达。', { ok: false })
    }

    return this.done(
      ctx,
      'Send message',
      formatCollabSayReceipt(result.messageId ?? ''),
      { ok: true, messageId: result.messageId },
    )
  }

  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createSendMessageTool(adapters: SendMessageToolAdapters): SendMessageTool {
  return new SendMessageTool(adapters)
}
