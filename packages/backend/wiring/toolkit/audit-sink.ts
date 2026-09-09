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
 *
 * ## K2a —— 无会话的那一档
 *
 * K1 留了一笔账:`Invocation.sessionId` 是必填的,于是一次**不是从任何会话里发起**
 * 的「做」(调度、deeplink、CLI、界面上一个与当前会话无关的按钮)只能借一条会话的
 * 坐标,而借到的通常正是**被改的那一条** —— 审计于是读成「A 自己改了自己」。
 *
 * K2a 的答案是一个保留坐标 `NO_ORIGIN_SESSION`(`@onething/core/resource`)加这只
 * 文件里的一支分叉:带着那个坐标的记录**不进任何会话的抄本**,落
 * `<store>/audit/resource.jsonl`,一行一条,append-only。
 *
 * 三件说清楚的事:
 *
 *  1. **它不是日志,管家永远不碰它。** `log/` 那棵树有唯一一个管家
 *     (`LogDirJanitor` + `LOG_DIR_POLICY`)会按份数 / 天数 / 总量删归档;这本账是
 *     产品数据,与 `sessions/<id>/events.jsonl`、`usage/*.jsonl`、调度日志同一档。
 *     它落在 `log/` **之外**,所以「管家不碰」是结构性的,不靠管家自觉绕开。
 *  2. **同步写。** `ToolAuditSink` 的签名是同步的(`(record) => void`),而这条路
 *     的流量是「人点一次按钮 / 一次调度」量级,不是流式。写坏了由
 *     `AuditProjector` 自己那层 try/catch 兜住 —— 审计是旁观者,它炸了不该把一次
 *     成功的调用变成失败。
 *  3. **有会话的那一档一个字没改**:照旧 `appendSessionEvent`。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { NO_ORIGIN_SESSION } from '@onething/core/resource'
import type { SessionToolAuditEventData } from '@onething/runtime/sessions/session-events'
import type { ToolAuditRecord, ToolAuditSink } from '@onething/runtime/toolkit/audit-observer'
import { getOnethingAuditDir, getOnethingResourceAuditPath } from '@onething/runtime/storage'
import { appendSessionEvent } from '../../session/event-log.js'

/** 一条记录的可序列化投影。两条落点共用同一份形状 —— 换个文件不该换个口径。 */
function projectAuditRecord(record: ToolAuditRecord): SessionToolAuditEventData {
  return {
    callId: record.callId,
    toolId: record.toolId,
    // K2a' §10.5:**主体进两条落点**。无会话那本账没有会话可回溯,主体是它唯一的
    // 线索;有会话那一侧照样带,不然同一条 `tool/audit` 换个落点就换一份口径。
    principal: record.principal,
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
  }
}

function appendResourceAudit(record: ToolAuditRecord): void {
  mkdirSync(getOnethingAuditDir(), { recursive: true })
  // `at` 由 `AuditProjector` 的时钟盖(会话账本那一侧是账本自己盖的)—— 这本账
  // 没有别人替它盖时刻,所以这里把记录自带的那一个写出去,不再叫一次 `Date.now()`。
  const line = JSON.stringify({ type: 'tool/audit', at: record.at, ...projectAuditRecord(record) })
  appendFileSync(getOnethingResourceAuditPath(), `${line}\n`, 'utf-8')
}

export const toolkitAuditSink: ToolAuditSink = (record: ToolAuditRecord): void => {
  if (record.sessionId === NO_ORIGIN_SESSION) {
    appendResourceAudit(record)
    return
  }
  appendSessionEvent(record.sessionId, 'tool/audit', projectAuditRecord(record))
}
