/**
 * **命令面自己的事件产地**(F 线 F2,§16.2 的 F2 行 / §16.7)。
 *
 * F2 之前,一条命令留在账本上的那条事件是**派生物**:命令先让 core reducer 改内存
 * store,`event-translator.ts` 再从"刚刚改成了什么"反推一条事件补上。F2 把产地翻
 * 过来 —— 事件成为命令的**第一手表达**:命令面先在这里把事件构造出来并 append
 * (F1 保证 append 返回前活投影 / 活 surface 已经前进,§16.6),老 reducer 随后照常
 * 把同一条命令应用到 store,作为 F0 的**影子验证器**(§16.5)独立推导一遍。
 *
 * 所以这个文件与 `event-translator.ts` 的差别不是"放在哪儿",是**谁先说话**:
 *
 * | | 产地 | 时序 |
 * |---|---|---|
 * | `event-translator.ts`(未翻转的命令) | 从 store 的 mutation 反推 | reducer 之后 |
 * | 本文件(已翻转的命令) | 命令自己构造 | reducer **之前** |
 *
 * F2-a 翻转的三条:`appendMessage` / `deleteMessage` / `patchMessage`。
 * 其余命令(upsert / truncateFrom / replaceAll / compact / patchSession …)仍住在
 * 翻译器里,并从这里取共用的取材件 —— **共用件只有一份**:两个产地各自演化出一份
 * `messageForEvent` 就是"同一条消息在两种事件里长得不一样"的温床。
 *
 * 纪律(与翻译器同源,§9.3 / §13.18):
 *
 * 1. **只写事实**。这条命令没改成任何东西(那条消息不在)就一条事件都不写 ——
 *    翻转之后"改没改成"由**命令面**在写事件之前自己问一次(它问的是与 reducer
 *    同一份 store,见 `commands.ts`),而不再是等 reducer 的回执。
 * 2. **正文只有一个来源**。`content` / `reasoning` / `contentParts` 永远不进
 *    `message/patched`;`isStreaming` 是 `run/start`…`run/end` 之间的**状态**,不是字段。
 * 3. **写侧取材走抄本真相面**(§13.18 发现 B):`sessionReads.*FromTranscript`,
 *    永不走随读模式分岔的 `getMessage` / `findMessage`。(这条纪律整体翻面归 F3。)
 * 4. **失败一律自吞**,除了 `SessionEventWriteError`(§14.6 裁定 7)—— 见 `safely`。
 */

import type { ChatMessage, MessageAttachment } from '@shared/ipc.js'
import type { BlobRef } from '@onething/core/session'
import { putSessionBlob } from './blob-store.js'
import { appendSurfaceAwareEvent, isSessionTranslationEnabled, sessionSurface } from './event-surface.js'
import { SessionEventWriteError } from './event-log.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')

/** 正文字段永远不由命令产出(它们的来源是 chunks)。 */
export const BODY_KEYS = new Set(['content', 'contentParts', 'reasoning'])
/** 派生字段:投影自己算得出来,记一份补丁只会制造第二个真相。 */
export const DERIVED_KEYS = new Set(['isStreaming', 'isThinking', 'thinkingStartTime', 'seq', 'steps', 'toolCalls'])

/**
 * 事件产出失败一律自吞 —— **除了"账本写不进去"这一类**(§14.6 裁定 7)。
 *
 * 自吞的理由:构造坏了不能影响聊天。但 `SessionEventWriteError` 说的不是"构造坏了",
 * 是"这条事件没落进磁盘";而 `events.jsonl` 已是唯一持久化,吞掉它等于让一段历史
 * 悄悄消失。所以这一类往上抛,由命令面的调用方变成一次可见的失败。
 */
export function safely(what: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    if (error instanceof SessionEventWriteError) throw error
    log.warn('session event production failed', { what }, error)
  }
}

/**
 * 附件里的 `base64Data` 换成 `BlobRef`(§10.1 G8)。
 *
 * 一张图能有几 MB,而事件行是要被逐行 parse 的 —— 把 base64 写进事件行等于让
 * 每一次 fold 都把它读一遍。落 blob、行里只留 `{hash, bytes, mime}`。
 * blob 写不进去时**摘掉** `base64Data`(而不是留原文):事件行的大小上限是
 * 硬约束。
 */
export function attachmentsForEvent(
  sessionId: string,
  attachments: readonly MessageAttachment[] | undefined,
): unknown[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.map(attachment => {
    if (!attachment.base64Data) return attachment
    const blob: BlobRef | undefined = putSessionBlob(
      sessionId,
      Buffer.from(attachment.base64Data, 'base64'),
      attachment.mimeType,
    )
    const { base64Data: _dropped, ...rest } = attachment
    return blob ? { ...rest, base64Data: blob } : rest
  })
}

/** 一条消息在事件里的形状:正文原样,附件换引用。 */
export function messageForEvent(sessionId: string, message: ChatMessage): Record<string, unknown> {
  const attachments = attachmentsForEvent(sessionId, message.attachments)
  const { attachments: _dropped, ...rest } = message
  return {
    ...rest,
    ...(attachments ? { attachments } : {}),
  }
}

// ============ 已翻转的命令:事件是第一手产出 ============

export const sessionCommandEvents = {
  /**
   * `appendMessage`(F2-a)。三条分支:
   *  - user → `user/message`;
   *  - assistant **且 isStreaming** → 一条都不写:它是一次执行的占位,
   *    `run/start` 才是它在 surface 上的那一格(§9.3);
   *  - 其余(system / error / 直接落定的 assistant)→ `system/message`,
   *    role 原样。它是一条**完整消息**,和 `message/imported` 同形。
   */
  appendMessage(sessionId: string, message: ChatMessage): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('appendMessage', () => {
      if (message.role === 'assistant' && message.isStreaming) return
      const type = message.role === 'user' ? 'user/message' : 'system/message'
      appendSurfaceAwareEvent(
        sessionId,
        type,
        { message: messageForEvent(sessionId, message) as never },
        { surfaceOp: 'append' },
      )
    })
  },

  /** `deleteMessage`(F2-a):只遮蔽它自己那一格(后面的照旧在 surface 上)。 */
  deleteMessage(sessionId: string, messageId: string): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('deleteMessage', () => {
      const seq = sessionSurface(sessionId).seqOf(messageId)
      appendSurfaceAwareEvent(
        sessionId,
        'message/deleted',
        { messageId },
        seq !== undefined
          ? { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] }
          : {},
      )
    })
  },

  /**
   * `patchMessage`(F2-a)。`turnContext` 单独走 `context/turn-update`(它取代了
   * `ChatMessage.turnContext` 字段,§9.2);正文与派生字段一律丢弃;
   * 剩下全空就一条都不写。
   *
   * `fullBody` 是 **upsert 的整条替换**借道用的那一档(它还在翻译器里,F2-b 才翻转):
   * 正文三件套照旧带上 —— 那一条的语义就是"这条消息现在整条长这样"。
   */
  patchMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<ChatMessage>,
    options: { fullBody?: boolean } = {},
  ): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('patchMessage', () => {
      const turnContext = (patch as { turnContext?: { set?: Record<string, string>; removed?: string[] } }).turnContext
      if (turnContext) {
        appendSurfaceAwareEvent(sessionId, 'context/turn-update', {
          messageId,
          ...(turnContext.set ? { set: turnContext.set } : {}),
          ...(turnContext.removed ? { removed: turnContext.removed } : {}),
        })
      }

      const kept: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'turnContext' || key === 'id') continue
        if (DERIVED_KEYS.has(key)) continue
        // `fullBody`(upsert 的整条替换)是唯一放行正文的档;归约器仍然会对
        // assistant 节点把这三格剥掉。
        if (!options.fullBody && BODY_KEYS.has(key)) continue
        if (value === undefined) continue
        kept[key] = key === 'attachments'
          ? attachmentsForEvent(sessionId, value as MessageAttachment[])
          : value
      }
      if (Object.keys(kept).length === 0) return
      appendSurfaceAwareEvent(sessionId, 'message/patched', { messageId, patch: kept })
    })
  },
}
