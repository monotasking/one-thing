/**
 * 历史消息形状的诊断记录(logging §9.2.3)。
 *
 * 这个文件曾经是「chat 请求的全套 console 渲染」——请求起止、逐轮计时、续轮消息、
 * 工具/技能清单、系统提示词落盘。L5 清点(`docs/audit/logging-inventory-2026-08-19.md`)
 * 显示 9 个导出里 8 个**全仓零调用点**,`<store>/debug/last-system-prompt.txt`
 * 更是连写者都没有;能观测到的那份事实早已由 `sessions/<id>/events.jsonl`(S 线)
 * 与结构化日志承担。于是整只删掉,只留下唯一活着的这一个。
 *
 * 分层不变:`packages/core/engine/chat-logger.ts` 出纯函数(形状分析),这里出副作用
 * (等级判定 + 落记录)。
 */

import {
  buildMessageBodyShapePayload,
  type CoreChatLogMessageShape,
  type CoreChatLogValue,
} from '@onething/core/engine'
import { getLogger } from '../../wiring/logging/index.js'

export type ChatLogMessageShape = CoreChatLogMessageShape

/** 历史形状是自成一格的命名空间 —— 它的逐行铺开单独可开(见下)。 */
const historyLog = getLogger('engine.history')

/**
 * Per-row inventories (one line per history message, plus the compacted
 * `retainedMessages` list) are opt-in: on a 400-message session they were
 * ~2400 console lines through util.inspect on EVERY send — ~300ms of main
 * thread before the request even left, felt in the composer as a stall
 * (2026-08-18 dev.log). 现在由等级过滤决定:摘要 = `engine.history` 的 debug,
 * 逐行铺开 = 同命名空间的 **trace**(所以"全域 debug"的诊断模式不会把那 300ms
 * 请回来)。旧开关 `ONETHING_DEBUG_HISTORY_SHAPE=1` 保留为 `engine.history=trace`
 * 的废弃别名(app/logging/legacy-debug-env.ts,L5 删)。
 */
export function logMessageBodyShape(
  label: string,
  messages: ChatLogMessageShape[],
  extra: Record<string, CoreChatLogValue> = {},
): void {
  if (!historyLog.isLevelEnabled('debug')) return
  const payload = buildMessageBodyShapePayload(messages, extra)
  if (historyLog.isLevelEnabled('trace')) {
    historyLog.trace('message body shape', { label, ...payload })
    return
  }
  const { rows, retainedMessages, degradedMessageIds, droppedMessages, ...summary } = payload as typeof payload & {
    retainedMessages?: unknown[]
    degradedMessageIds?: unknown[]
    droppedMessages?: unknown[]
  }
  historyLog.debug('message body shape', {
    label,
    ...summary,
    rows: rows.length,
    ...(retainedMessages ? { retainedMessages: retainedMessages.length } : {}),
    ...(degradedMessageIds ? { degradedMessageIds: degradedMessageIds.length } : {}),
    ...(droppedMessages ? { droppedMessages: droppedMessages.length } : {}),
  })
}
