/**
 * R2b —— `AuditProjector` 的落盘口:events.jsonl(主线 E0 那条七事件流)。
 *
 * ## 为什么是一行而不是三行
 *
 * 任务书写的是"lifecycle 三态各写一条"。`AuditProjector` 的形状不是这样:它
 * **按 callId 攒**,在 `finished` 那一刻吐一条扁平记录(planned 的效果清单、
 * decided 的结论与 asked 位、finished 的结局、拦截归因全在里面)。
 *
 * 保留一行的理由有二:
 *
 *  1. 三行需要三个新事件类型,而 E0 那张表的头注释写着"扩大这个集合需要单独
 *     拍板";一次接线不该顺手把一张被明确关起来的表撑开三格。
 *  2. 三行说的是同样三件事,只是拆开了 —— 读账本的人要把它们重新拼回一次调用,
 *     而拼接靠 callId 就地做,正是 `AuditProjector` 已经做过的事。
 *
 * 代价说清楚:**时刻只剩一个**(finished 的时刻),planned 与 decided 各自发生在
 * 什么时候拿不回来。真需要那两个时刻时再拆成三行,那时是一次有理由的扩表。
 */

import type { ToolAuditRecord, ToolAuditSink } from './audit-observer.js'
import { appendSessionEvent } from '../session/event-log.js'

export const toolkitAuditSink: ToolAuditSink = (record: ToolAuditRecord): void => {
  appendSessionEvent(record.sessionId, 'tool/audit', {
    callId: record.callId,
    toolId: record.toolId,
    effects: [...record.effects],
    effectCount: record.effectCount,
    ...(record.previewTitle !== undefined ? { previewTitle: record.previewTitle } : {}),
    ...(record.decision !== undefined ? { decision: record.decision } : {}),
    ...(record.asked !== undefined ? { asked: record.asked } : {}),
    outcome: record.outcome,
    ...(record.intercepted
      ? {
          intercepted: {
            action: record.intercepted.action,
            ...(record.intercepted.by ? { by: [...record.intercepted.by] } : {}),
          },
        }
      : {}),
    ...(record.messageId !== undefined ? { messageId: record.messageId } : {}),
  })
}
