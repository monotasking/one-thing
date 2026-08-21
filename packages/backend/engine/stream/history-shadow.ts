/**
 * 历史影子断言的接线(S1b,§10.4 第二条)。
 *
 * **发出去之前**比一次:今天 `buildHistoryMessages` 从 messages.jsonl 算出来的
 * 那一份,与从事件 surface 投影出来的那一份,过同一个序列化器之后必须逐字节
 * 相同。不等意味着"S2 切读之后模型会看到另一段历史" —— 这条路上最贵的一类错,
 * 而且在切读之前一点症状都没有。
 *
 * 两侧走**同一条配方**(`historyProjectionRecipe`),差别只有"消息从哪来"。
 *
 * ## 为什么是独立的一个文件
 *
 * 采集点在 `session-event-recorder.ts`(它写 `request/recipe` 的那一刻就是
 * "发出去之前"),但 recorder 只该依赖会话事件那一层。让它直接 import
 * `message-helpers` / `reads` 会把整棵 store 树(settings → paths → …)拖进
 * recorder 的模块图 —— 单测一模拟 `stores/paths` 就当场炸。所以 recorder 只留
 * 一个回调口(`onRequestRecipe`),接线住在这里,由执行器装上。
 */

import { sessionReads } from '../../session/reads.js'
import { checkSessionHistoryShadow } from '../../session/shadow.js'
import { buildHistoryMessages, historyProjectionRecipe } from './message-helpers.js'
import { getLogger } from '../../wiring/logging/index.js'

const log = getLogger('engine.history')


/** 一次请求发出前的历史断言。出错自吞:记账不该影响聊天。 */
export function checkSessionHistoryShadowForRequest(sessionId: string, runId: string): void {
  try {
    const session = sessionReads.getSession(sessionId)
    // F11(§13.2):真相侧只能是抄本。`listMessages` 自 S2a 起带着
    // `ONETHING_SESSION_READ=events` 的岔口 —— 读模式一开,这一份"今天真的发出去
    // 的历史"其实就是投影自己,断言变成自比。
    const messages = [...sessionReads.listMessagesFromTranscript(sessionId)]
    checkSessionHistoryShadow(sessionId, {
      runId,
      actual: buildHistoryMessages(messages, session),
      ...(session
        ? {
            meta: {
              id: session.id,
              ...(session.summary ? { summary: session.summary } : {}),
              ...(session.summaryUpToMessageId
                ? { summaryUpToMessageId: session.summaryUpToMessageId }
                : {}),
            },
          }
        : {}),
      build: historyProjectionRecipe(session),
    })
  } catch (error) {
    log.warn('history shadow build failed', { sessionId }, error)
  }
}
