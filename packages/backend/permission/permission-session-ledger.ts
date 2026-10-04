/**
 * 审批链的**记账接线**(S1a,§10.6 第 4 条):把每一次权限问答的时刻与决定记进会话事件日志。
 *
 * `Permission` 只开了一个回调口子(`setRecorder`);把回调接到会话事件日志上发生在 `backend.ts`
 * 调完 `initialize` 之后。D202 前它与提问链那一半合住在 session(`session-permission-events.ts`),
 * 可它属于记账的一方:按依赖方向拆开,审批这一半回 permission,提问那一半回 interaction。
 *
 * 为什么不是"听 EventBus 的 permission:settled":那条总线事件只带
 * allowed/rejected,**拒绝的理由**只活在 `RejectedError.reason` 里,而投影正是
 * 靠它把 `rejectionReason` 接到 toolCall 上(§10.1 G6)。少了理由,UI 上那张
 * 灰卡就说不出"为什么被拒"。
 *
 * 每个 toolCallId 各记一条 `permission/answered`:一次 ask 可能被多次调用**合并**
 * (core 的 coalescing),而投影是按 toolCallId 关联的 —— 只记 head 那一个的话,
 * 被合并的那几次调用就查不到自己的判决。
 */

import { currentSessionRunId, writeSessionEvent } from '@onething/backend/session'
import { Permission } from './permission-asks.js'

function runIdOf(sessionId: string): { runId?: string } {
  const runId = currentSessionRunId(sessionId)
  return runId ? { runId } : {}
}

export function installPermissionSessionLedger(): void {
  Permission.setRecorder({
    onAsked(info) {
      writeSessionEvent(info.sessionId, 'permission/asked', {
        requestId: info.id,
        ...runIdOf(info.sessionId),
        ...(info.callId ? { toolCallId: info.callId } : {}),
        // 工具名住在 metadata 里(`enforcePermissionPolicy` 放进去的那一格)。
        ...(typeof info.metadata?.toolName === 'string'
          ? { toolName: info.metadata.toolName }
          : {}),
      })
    },
    onAnswered({ info, toolCallIds, approved, scope, reason }) {
      const base = {
        requestId: info.id,
        approved,
        ...runIdOf(info.sessionId),
        ...(scope ? { scope } : {}),
        ...(reason !== undefined ? { reason } : {}),
      }
      if (toolCallIds.length === 0) {
        writeSessionEvent(info.sessionId, 'permission/answered', base)
        return
      }
      for (const toolCallId of toolCallIds) {
        writeSessionEvent(info.sessionId, 'permission/answered', { ...base, toolCallId })
      }
    },
  })
}

/** 摘下(关停 / 测试)。 */
export function uninstallPermissionSessionLedger(): void {
  Permission.setRecorder(null)
}
