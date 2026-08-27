/**
 * 审批链与提问链的**记账接线**(S1a,§10.6 第 4 条)。
 *
 * `Permission` / `Interaction` 住在 core(零依赖),所以它们只开了一个回调口子
 * (`setRecorder`);把回调接到会话事件日志上是装配层的事,发生在 `backend.ts`
 * 调完 `initialize` 之后。
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

import { Permission } from '@onething/core/permission'
import { Interaction } from '@onething/core/interaction'
import { writeSessionEvent } from './event-writer.js'
import { currentSessionRunId } from './runs.js'

function runIdOf(sessionId: string): { runId?: string } {
  const runId = currentSessionRunId(sessionId)
  return runId ? { runId } : {}
}

export function installSessionPermissionEventRecorders(): void {
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

  Interaction.setRecorder({
    onAsked(request) {
      writeSessionEvent(request.sessionId, 'interaction/asked', {
        requestId: request.id,
        ...runIdOf(request.sessionId),
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        kind: request.origin,
      })
    },
    onAnswered(request, answer) {
      writeSessionEvent(request.sessionId, 'interaction/answered', {
        requestId: request.id,
        ...runIdOf(request.sessionId),
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        // 记的是**决定**,不是正文:选了哪些项而已(自由文本可能很长,而且
        // 它属于那次工具调用的结果,不属于这条时刻账)。
        answer: answer.outcome,
        ...(answer.outcome !== 'answered' ? { cancelled: true } : {}),
      })
    },
  })
}

/** 摘下(关停 / 测试)。 */
export function uninstallSessionPermissionEventRecorders(): void {
  Permission.setRecorder(null)
  Interaction.setRecorder(null)
}
