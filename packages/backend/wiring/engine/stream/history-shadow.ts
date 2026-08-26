/**
 * 历史恒等门的接线(S1b 立为影子断言 §10.4 第二条;F0 转向后是写模型合同,§16.2)。
 *
 * **发出去之前**比一次:从事件 surface 投影出来的那一份(**真相**),与
 * `buildHistoryMessages` 从内存 store 算出来的那一份(**影子验证器**),过同一个
 * 序列化器之后必须逐字节相同。不等意味着两套推导会让模型看到不同的一段历史 ——
 * 这条路上最贵的一类错,而且不比就一点症状都没有。
 *
 * F0(2026-08-27)只翻了归因:一次不等从前读成"投影错了",现在读成"**写模型没
 * 跟上账本**"。两侧的取数与判定一字未动。
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

import { sessionReads } from '../../../session/reads.js'
import { checkSessionHistoryShadow, countSessionShadowSkip } from '../../../session/shadow.js'
import { buildHistoryMessages, historyProjectionRecipe } from './message-helpers.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('engine.history')


export interface SessionHistoryShadowRequestOptions {
  /**
   * 这一刻有没有一次**已经定了身份、消费侧还没接手**的换锚点
   * (`AgentLoopExecutorState.pendingAssistantRotation`)。
   */
  pendingAssistantRotation?: boolean
}

/**
 * 一次请求发出前的历史断言。出错自吞:记账不该影响聊天。
 *
 * ## steer 窗口闸(§15.15)
 *
 * `rotateAssistantWriterIdentity` 在 agent-loop 发 boundary 的**同步点**就把旧 run
 * 收掉、把身份换成新号,而上一条 assistant 消息的 `isStreaming` 要等消费侧那一半
 * (`createNextAssistantWriter` → `finalize()`)才落成 false。这中间的一小段窗口里,
 * store 侧现算的 `buildHistoryMessages` 会被 `core/engine/history.ts` 的
 * `if (message.isStreaming) continue` 把上一条 assistant **整条**滤掉,而投影侧不认
 * `isStreaming`(它是 `run/start`…`run/end` 之间的派生态,见 `command-events.ts`
 * 的 `DERIVED_KEYS`)—— 比出来永远差一整轮。那是**窗口的假红**,哪一侧都没错。
 *
 * 与 run 断言那道闸是**同一条判例**:那边叫 `EndSessionRunInput.shadowGate`
 * (`session/runs.ts`,开闸的两处在 `agent-loop-executor.ts` 的消费侧与 finally),
 * 走的是"等一下再比";历史断言每次请求都跑,等下去等于把这一次请求的口径挪到
 * 别的时刻,所以这边取"这一次不比,并记一笔账"。
 */
export function checkSessionHistoryShadowForRequest(
  sessionId: string,
  runId: string,
  options: SessionHistoryShadowRequestOptions = {},
): void {
  if (options.pendingAssistantRotation) {
    countSessionShadowSkip('history-steer-window')
    return
  }
  try {
    const session = sessionReads.getSession(sessionId)
    // F11(§13.2):验证器侧只能是 store 这一口。`listMessages` 自 S2a 起从投影
    // 取数(批 6b 之后是唯一路)—— 拿它来算这一份,断言就变成投影自比。
    const messages = [...sessionReads.listMessagesFromTranscript(sessionId)]
    checkSessionHistoryShadow(sessionId, {
      runId,
      fromStore: buildHistoryMessages(messages, session),
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
