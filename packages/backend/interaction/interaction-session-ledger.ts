/**
 * 提问链的**记账接线**(S1a,§10.6 第 4 条):把每一次向人提问的时刻与决定记进会话事件日志。
 *
 * `Interaction` 只开了一个回调口子(`setRecorder`);把回调接到会话事件日志上发生在 `backend.ts`
 * 调完 `initialize` 之后。D202 前它与审批链那一半合住在 session(`session-permission-events.ts`);
 * 按依赖方向拆开之后,这一半住 interaction,session 不再引 interaction。
 */

import { currentSessionRunId, writeSessionEvent } from '@onething/backend/session'
import { Interaction } from './interaction-registry.js'

function runIdOf(sessionId: string): { runId?: string } {
  const runId = currentSessionRunId(sessionId)
  return runId ? { runId } : {}
}

export function installInteractionSessionLedger(): void {
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
export function uninstallInteractionSessionLedger(): void {
  Interaction.setRecorder(null)
}
