/**
 * 投影的 **blob 回放口 + 退化留痕**(A8/A9/F6,§13.6)。
 *
 * core 的投影是纯的:它只认得 `BlobRef`,换回正文要宿主给一个读口。这个模块
 * 就是那个读口的**唯一**装配处 —— 从前每个消费者(影子断言、events 读路径)
 * 各自 `resolveHistoryBlobRefs(msg, ref => readSessionBlobText(...))` 抄一遍,
 * 于是 A8(工具大结果)这类新落点补上时,补一处漏一处。
 *
 * ## F6:退化不再是静默的
 *
 * blob 读不到时投影仍然退化(附件摘掉 / 结果留引用),但每一次都会:
 *  - 记进 `session-shadow-stats.json` 的 `projectionIssues`(报告与门看得见);
 *  - **每会话 warn 一次**(多了就成刷屏 —— 一条会话里同一个 blob 会被读几十次)。
 *
 * 绝不抛:投影跑在引擎热路径上,记账坏掉不能让聊天挂掉(S1 三条纪律的第一条)。
 */

import type { ProjectionIssue, ProjectionMaterializeOptions } from '@onething/core/session'
import { readSessionBlobText } from './blob-store.js'
import { bumpSessionShadowStats } from './event-stats.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('sessions.events')

/** 已经喊过的会话(每会话一次)。 */
const warned = new Set<string>()

/** 会话删除 / 测试:忘掉"这条会话已经喊过了"。 */
export function resetSessionProjectionIssueCache(sessionId?: string): void {
  if (sessionId) warned.delete(sessionId)
  else warned.clear()
}

export function reportSessionProjectionIssue(sessionId: string, issue: ProjectionIssue): void {
  try {
    bumpSessionShadowStats({ projectionIssues: 1 })
    if (warned.has(sessionId)) return
    warned.add(sessionId)
    log.warn('projection degraded', {
      sessionId,
      kind: issue.kind,
      where: issue.where,
      ...(issue.hash ? { hash: issue.hash } : {}),
      ...(issue.messageId ? { messageId: issue.messageId } : {}),
    })
  } catch {
    // 留痕本身坏掉不该再制造第二条错误路径。
  }
}

/**
 * 这条会话的物化选项:blob 读口 + 退化留痕。
 *
 * 每个读点都用它,别再手搓 `ref => readSessionBlobText(...)` —— 那正是 A8 补上
 * 之后"补一处漏一处"的来源。
 */
export function sessionProjectionOptions(sessionId: string): ProjectionMaterializeOptions {
  return {
    resolveBlob: ref => readSessionBlobText(sessionId, ref.hash),
    onIssue: issue => reportSessionProjectionIssue(sessionId, issue),
  }
}
