/**
 * 命令面 → 事件的**翻译器**(S1a,§9.3 的表 + §10.2 的第一行采集点)。
 *
 * `sessionCommands` 的 reducer 落定之后,这里把"刚刚发生了什么"翻成 v2 事件。
 * 三条纪律:
 *
 * 1. **翻译在 reducer 成功之后**。命令没改成任何东西(找不到那条消息、
 *    patch 是空的)就一条事件都不写 —— 事件账本记的是事实,不是意图。
 * 2. **只读门面**。这个模块从 `sessionReads` 取消息,从 `sessionSurface` 取
 *    surface 坐标,一次都不碰 `session.messages`(`session:gate` 盯着这条)。
 * 3. **正文只有一个来源**。`content` / `reasoning` / `contentParts` 永远不进
 *    `message/patched` —— 它们的来源是 `assistant/chunks`(§9.2 的类型级门在
 *    core 里钉着同一条)。`isStreaming` 同理:它是 `run/start`…`run/end` 之间
 *    的**状态**,不是字段。
 *
 * 失败一律自吞:S1 是影子期,翻译坏了不能影响聊天(写失败的计数在
 * `event-stats.ts`)。
 */

import type { ChatMessage, ChatSession, MessageAttachment } from '@shared/ipc.js'
import type { BlobRef } from '@onething/core/session'
import { putSessionBlob } from './blob-store.js'
import { appendSurfaceAwareEvent, isSessionTranslationEnabled, sessionSurface } from './event-surface.js'
import { currentSessionRun } from './runs.js'
import { sessionReads } from './reads.js'

/** 正文字段永远不走命令翻译(它们的来源是 chunks)。 */
const BODY_KEYS = new Set(['content', 'contentParts', 'reasoning'])
/** 派生字段:投影自己算得出来,记一份补丁只会制造第二个真相。 */
const DERIVED_KEYS = new Set(['isStreaming', 'isThinking', 'thinkingStartTime', 'seq', 'steps', 'toolCalls'])

function safely(what: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.warn(`[SessionEvents] translate ${what} failed:`, error)
  }
}

/**
 * 附件里的 `base64Data` 换成 `BlobRef`(§10.1 G8)。
 *
 * 一张图能有几 MB,而事件行是要被逐行 parse 的 —— 把 base64 写进事件行等于让
 * 每一次 fold 都把它读一遍。落 blob、行里只留 `{hash, bytes, mime}`。
 * blob 写不进去时**摘掉** `base64Data`(而不是留原文):事件行的大小上限是
 * 硬约束,而正文还在 `messages.jsonl` 里 —— 影子期不会因此丢东西。
 */
function attachmentsForEvent(
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
function messageForEvent(sessionId: string, message: ChatMessage): Record<string, unknown> {
  const attachments = attachmentsForEvent(sessionId, message.attachments)
  const { attachments: _dropped, ...rest } = message
  return {
    ...rest,
    ...(attachments ? { attachments } : {}),
  }
}

// ============ 命令翻译 ============

export const sessionEventTranslator = {
  /**
   * `appendMessage`。三条分支:
   *  - user → `user/message`;
   *  - assistant **且 isStreaming** → 不翻译:它是一次执行的占位,
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

  /**
   * `upsertMessage` 命中已有的那条 = 整条换掉。翻成 `message/patched`
   * (投影侧的叠加层就是"整条盖上去");新增走 `appendMessage` 的那条路。
   */
  upsertMessage(sessionId: string, message: ChatMessage, existed: boolean): void {
    if (!existed) {
      sessionEventTranslator.appendMessage(sessionId, message)
      return
    }
    sessionEventTranslator.patchMessage(sessionId, message.id, message as Partial<ChatMessage>)
  },

  /**
   * `patchMessage`。`turnContext` 单独走 `context/turn-update`(它取代了
   * `ChatMessage.turnContext` 字段,§9.2);正文与派生字段一律丢弃;
   * 剩下全空就一条都不写。
   */
  patchMessage(sessionId: string, messageId: string, patch: Partial<ChatMessage>): void {
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
        if (BODY_KEYS.has(key) || DERIVED_KEYS.has(key)) continue
        if (value === undefined) continue
        kept[key] = key === 'attachments'
          ? attachmentsForEvent(sessionId, value as MessageAttachment[])
          : value
      }
      if (Object.keys(kept).length === 0) return
      appendSurfaceAwareEvent(sessionId, 'message/patched', { messageId, patch: kept })
    })
  },

  /**
   * `truncateFrom`。两种语义,两条事件:
   *  - `inclusive` (regenerate) → `message/deleted` + replace 遮蔽"这条到末尾";
   *  - 否则 (edit-resend) → `user/message-edited` + 同样的 replace,新节点接上。
   *
   * range 与 `sourceEventSeqs` 都从活 surface 取 —— 手数下标会在压缩之后错位
   * (那个节点排在最前面而 seq 最大)。
   */
  truncateFrom(
    sessionId: string,
    payload: { messageId: string; inclusive: boolean },
    updatedMessage: ChatMessage | undefined,
  ): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('truncateFrom', () => {
      const range = sessionSurface(sessionId).rangeFrom(payload.messageId)
      const surfaceOp = range
        ? ({ op: 'replace', start: range.start, end: range.end } as const)
        : undefined
      const options = surfaceOp ? { surfaceOp, sourceEventSeqs: range!.seqs } : {}

      if (payload.inclusive) {
        appendSurfaceAwareEvent(sessionId, 'message/deleted', { messageId: payload.messageId }, options)
        return
      }
      const message = updatedMessage ?? sessionReads.getMessage(sessionId, payload.messageId)
      if (!message) return
      appendSurfaceAwareEvent(
        sessionId,
        'user/message-edited',
        {
          messageId: payload.messageId,
          message: messageForEvent(sessionId, message as ChatMessage) as never,
        },
        { ...options, surfaceOp: surfaceOp ?? 'append' },
      )
    })
  },

  /** `deleteMessage`:只遮蔽它自己那一格(后面的照旧在 surface 上)。 */
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
   * `replaceAll`。
   *  - `clear` → 一条 `session/cleared{reason:'clear'}` 遮蔽整条 surface;
   *  - `replaced`(collab 的 MESSAGES_REPLACED,G11)→ 同样一条 cleared,
   *    再逐条 `message/imported` 把新的一份接上;
   *  - `normalize` → **不翻译**:它是冷加载的形状规整,消息集合没变。
   */
  replaceAll(
    sessionId: string,
    messages: readonly ChatMessage[],
    reason: 'clear' | 'replaced' | 'normalize',
  ): void {
    if (reason === 'normalize') return
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('replaceAll', () => {
      const whole = sessionSurface(sessionId).wholeRange()
      appendSurfaceAwareEvent(
        sessionId,
        'session/cleared',
        { reason },
        whole
          ? { surfaceOp: { op: 'replace', start: whole.start, end: whole.end }, sourceEventSeqs: whole.seqs }
          : {},
      )
      if (reason !== 'replaced') return
      for (const message of messages) {
        appendSurfaceAwareEvent(
          sessionId,
          'message/imported',
          { message: messageForEvent(sessionId, message) as never },
          { surfaceOp: 'append' },
        )
      }
    })
  },

  /**
   * `patchSession`。只有三格进事件:agent / model / workdir —— 它们改变
   * **模型看到的世界**(system 变量、工具的工作树、人格)。其余会话级字段
   * (name / pin / archived / summary…)是 UI 偏好,留在 `meta.json`(§2)。
   */
  patchSession(
    sessionId: string,
    patch: Partial<ChatSession>,
    before: Pick<ChatSession, 'agentId' | 'lastModel' | 'lastProvider' | 'workingDirectory'> | undefined,
  ): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('patchSession', () => {
      if (patch.agentId !== undefined && patch.agentId !== before?.agentId) {
        appendSurfaceAwareEvent(sessionId, 'session/agent-changed', {
          ...(before?.agentId ? { from: before.agentId } : {}),
          to: patch.agentId,
        })
      }
      if (patch.lastModel !== undefined && patch.lastModel !== before?.lastModel) {
        appendSurfaceAwareEvent(sessionId, 'session/model-changed', {
          ...(before?.lastModel ? { from: before.lastModel } : {}),
          to: patch.lastModel,
          ...(patch.lastProvider ? { provider: patch.lastProvider } : {}),
        })
      }
      if (
        patch.workingDirectory !== undefined
        && patch.workingDirectory !== before?.workingDirectory
      ) {
        appendSurfaceAwareEvent(sessionId, 'session/workdir-changed', {
          ...(before?.workingDirectory ? { from: before.workingDirectory } : {}),
          to: patch.workingDirectory,
        })
      }
    })
  },

  /** 会话创建:`session/created` 是这份日志的**第一条**,目录由它建起来。 */
  sessionCreated(session: ChatSession): void {
    safely('sessionCreated', () => {
      appendSurfaceAwareEvent(session.id, 'session/created', {
        sessionId: session.id,
        ...(session.kind ? { kind: session.kind } : {}),
        ...(session.agentId ? { agentId: session.agentId } : {}),
        ...(session.lastModel ? { model: session.lastModel } : {}),
        ...(session.lastProvider ? { provider: session.lastProvider } : {}),
        ...(session.workingDirectory ? { workingDirectory: session.workingDirectory } : {}),
      })
    })
  },

  /** 压缩:`session/compacted`(surface 上是一个节点 + 一段 replace)。 */
  sessionCompacted(
    sessionId: string,
    data: {
      messageId: string
      summary: string
      compactedMessageCount: number
      compactedThroughMessageId?: string
      model?: string
      provider?: string
      status: 'completed' | 'failed'
      error?: string
    },
  ): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('sessionCompacted', () => {
      // 遮蔽的是"被压掉的那一段" —— 从 surface 头到切点那条消息(含)。
      // 切点解不出来(老会话 / 全量压缩)就遮蔽整条 surface。
      const surface = sessionSurface(sessionId)
      const order = surface.order()
      const throughSeq = data.compactedThroughMessageId
        ? surface.seqOf(data.compactedThroughMessageId)
        : undefined
      const at = throughSeq !== undefined ? order.indexOf(throughSeq) : order.length - 1
      // 失败的压缩**不遮蔽任何东西**:一段没压成功的历史照旧要发给模型。
      // 它仍然记一条(UI 上是一张红卡),只是 surfaceOp 是 append。
      const covered = data.status === 'completed' && at >= 0 ? order.slice(0, at + 1) : []

      appendSurfaceAwareEvent(
        sessionId,
        'session/compacted',
        {
          messageId: data.messageId,
          summary: data.summary,
          compactedMessageCount: data.compactedMessageCount,
          ...(data.compactedThroughMessageId
            ? { compactedThroughMessageId: data.compactedThroughMessageId }
            : {}),
          ...(data.model ? { model: data.model } : {}),
          ...(data.provider ? { provider: data.provider } : {}),
          status: data.status,
          ...(data.error ? { error: data.error } : {}),
        },
        covered.length > 0
          ? {
              surfaceOp: { op: 'replace', start: covered[0], end: covered[covered.length - 1] },
              sourceEventSeqs: covered,
            }
          : { surfaceOp: 'append' },
      )
    })
  },
}

/** 当前执行的 runId —— 采集点之间共享同一个身份(见 `runs.ts`)。 */
export function translationRunId(sessionId: string): string | undefined {
  return currentSessionRun(sessionId)?.runId
}
