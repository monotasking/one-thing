/**
 * 会话生命周期的两个**非命令采集点**(F 线 F2-c,§16.9)。
 *
 * F2 把十三条命令的事件产地一条条翻成"命令即事件"(`command-events.ts`),
 * `event-translator.ts` 因此整体退役。留下的这两个不是命令 —— 没有哪条
 * `sessionCommands.<cmd>` 对应它们,它们的产地是各自那一处业务代码:
 *
 * | 事件 | 产地 | 谁先说话 |
 * |---|---|---|
 * | `session/created` | `stores/sessions.ts` 的 `createSession`(三个创建入口共用的 `recordSessionCreated`) | **它就是第一句话**:会话目录由这条事件建起来(B4,§10.3 ①) |
 * | `session/compacted` | `wiring/engine/context-compact.ts` 的成功 / 失败两条收尾路 | 结局落到消息上之后 —— 它记的是"压缩有了结局",而结局正是那两步写出来的 |
 *
 * 所以这里不存在"翻转":这两条从来就不是从 store 的 mutation 反推出来的,
 * 调用方本来就是把事实直说给它。搬家只改名字与住址,行为一字未动。
 *
 * 纪律与 `command-events.ts` 同源:只读门面(从 `sessionSurface` 取坐标,
 * 一次都不碰 `session.messages`)、失败自吞、`SessionEventWriteError` 上抛
 * (共用 `safely`)。
 */

import type { ChatSession } from '@shared/ipc.js'
import { sessionOriginFingerprint, type SessionOriginStamp } from '@onething/core/session'
import { getOnethingStorePath } from '@onething/runtime/storage'
import { safely } from './command-events.js'
import { isSessionTranslationEnabled, sessionSurface } from './event-surface.js'
import { writeSessionEvent } from './event-writer.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')

/**
 * **产地印章**(§17.7 #2+#1)—— 写这条 `session/created` 的时候,这个进程认为
 * 自己的 store 在哪儿。形状与理由见 `core/session/events/origin.ts`。
 *
 * 按 store 路径缓存(而不是每进程算一次):测试会在一个进程里换好几个临时 store,
 * 算错就等于给那本账盖了别人的章。指纹本身是纯函数,一次几十个字符的循环。
 */
const originStampCache = new Map<string, SessionOriginStamp>()

function sessionOriginStamp(): SessionOriginStamp {
  const storePath = getOnethingStorePath()
  const cached = originStampCache.get(storePath)
  if (cached) return cached
  const stamp: SessionOriginStamp = {
    store: sessionOriginFingerprint(storePath),
    // 零接线可知的唯一一格宿主标记 —— 而 vitest 正是夹具沉积最大的来源。
    ...(process.env.VITEST ? { host: 'test' as const } : {}),
  }
  originStampCache.set(storePath, stamp)
  return stamp
}

export const sessionLifecycleEvents = {
  /** 会话创建:`session/created` 是这份日志的**第一条**,目录由它建起来。 */
  sessionCreated(session: ChatSession): void {
    safely('sessionCreated', () => {
      writeSessionEvent(session.id, 'session/created', {
        sessionId: session.id,
        ...(session.kind ? { kind: session.kind } : {}),
        ...(session.agentId ? { agentId: session.agentId } : {}),
        ...(session.lastModel ? { model: session.lastModel } : {}),
        ...(session.lastProvider ? { provider: session.lastProvider } : {}),
        ...(session.workingDirectory ? { workingDirectory: session.workingDirectory } : {}),
        // §17.7 #2+#1:账本自证身份。单门之后(§17.7 #6)这一条必经写入口,
        // 所以印章天然全覆盖 —— 没有"另一扇门写的没盖章"这种缝。
        origin: sessionOriginStamp(),
      })
    })
  },

  /**
   * 压缩:`session/compacted`(surface 上是一个节点 + 一段 replace)。
   *
   * **双产地判例(§13.10 M3)**:那条压缩标记消息在账本上早就有自己的一格
   * (`addMessage` → `system/message`,正文 `status:'compacting'`),而这一条记的是
   * 同一条消息的**第二次陈述**。两条事件记的都是真事,病在归约器 —— 修在那里
   * (占位隐藏、新节点插在它原来那一格、时刻取占位消息自己的 `timestamp`),
   * 采集点一个字都不该改。搬家没有碰这一条。
   */
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

      writeSessionEvent(
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
