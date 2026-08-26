/**
 * 命令面 → 事件的**翻译器**(S1a,§9.3 的表 + §10.2 的第一行采集点)。
 *
 * `sessionCommands` 的 reducer 落定之后,这里把"刚刚发生了什么"翻成 v2 事件。
 *
 * **F2 起这里是"还没翻转的那几条"的家**(§16.2 的 F2 行 / §16.7 / §16.8)。翻转过的
 * 命令事件产地搬进了 `command-events.ts`(`sessionCommandEvents`),在那里事件是命令的
 * **第一手表达**、写在 reducer **之前**;留在本文件里的这几条仍是老口径:从
 * store 的 mutation 反推,写在 reducer **之后**。已搬走五条:F2-a 的
 * `appendMessage` / `deleteMessage` / `patchMessage`,F2-b 的
 * `upsertMessage` / `truncateFrom`。剩下四个方法里只有 `replaceAll` / `patchSession`
 * 还是命令(F2-c 翻),`sessionCreated` / `sessionCompacted` 是**非命令**采集点。
 * 共用的取材件(`messageForEvent` / `attachmentsForEvent` / `safely` /
 * BODY_KEYS / DERIVED_KEYS)只有一份,住在 `command-events.ts`。
 *
 * 三条纪律:
 *
 * 1. **翻译在 reducer 成功之后**。命令没改成任何东西(找不到那条消息、
 *    patch 是空的)就一条事件都不写 —— 事件账本记的是事实,不是意图。
 * 2. **只读门面**。这个模块从 `sessionSurface` 取 surface 坐标,一次都不碰
 *    `session.messages`(`session:gate` 盯着这条)。
 * 3. **正文只有一个来源**。`content` / `reasoning` / `contentParts` 永远不进
 *    `message/patched` —— 它们的来源是 `assistant/chunks`(§9.2 的类型级门在
 *    core 里钉着同一条)。`isStreaming` 同理:它是 `run/start`…`run/end` 之间
 *    的**状态**,不是字段。
 * 4. **写侧取材走抄本真相面**(§13.18 发现 B)。翻译一条事件要读消息时,一律走
 *    `sessionReads.*FromTranscript`(恒读 `messages.jsonl`),**永不**走
 *    `getMessage` / `findMessage` 这类走投影的门面 ——
 *    正要由这次翻译写出的那条事件,活投影还没看到,走 fromEvents 会自引用滞后的
 *    旧投影,把旧正文焊进账本。`fromEvents` 岔口只属于产品读路;命令面同此纪律。
 *    (F2-b 之后本文件已经不再需要读消息:唯一那两处取材随 upsert / truncateFrom
 *    搬去了命令面。)
 *
 * 失败一律自吞:翻译坏了不能影响聊天(写失败的计数在 `event-stats.ts`)。
 * **有一个例外**:`SessionEventWriteError` 往上抛(批 6b 起无条件)—— 见 `safely`。
 */

import type { ChatMessage, ChatSession } from '@shared/ipc.js'
import { messageForEvent, safely } from './command-events.js'
import { appendSurfaceAwareEvent, isSessionTranslationEnabled, sessionSurface } from './event-surface.js'
import { currentSessionRun } from './runs.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')

// ============ 命令翻译(还没翻转产地的那几条) ============

export const sessionEventTranslator = {
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
      // F3(§13.2):一次**成功**的压缩没找到切点 = replace 静默退化成 append,
      // 后果是模型同时看到摘要和被压掉的原文(预算翻倍,两边的账还都是绿的)。
      // 写侧只能照实记(切点确实解不出来),但不能一声不吭 —— 读侧的
      // `SurfaceIndex` 会把同一件事记成一条 `compact-anchor-unresolved`。
      if (data.status === 'completed' && covered.length === 0 && order.length > 0) {
        log.warn('compaction anchor did not resolve on the surface', {
          sessionId,
          compactedThroughMessageId: data.compactedThroughMessageId,
          surfaceNodes: order.length,
        })
      }

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
