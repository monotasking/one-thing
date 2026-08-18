/**
 * 权限应答 —— 「按 toolCallId 回话」的唯一实现(去复用重构 R1,§8 铁律 1)。
 *
 * 这一份是从 `MessageList.vue` 原地抬出来的 `handleConfirmTool` /
 * `handleRejectTool`,**逐字搬运**:命令类型、字段名、日志、拒绝后的本地收尾
 * (toolCall + step 双写)全部照旧。抬出来的理由只有一个 —— 房面
 * (`RoomSurface`)不再经过 `MessageList`,而"审批语义零变化"不能靠两份拷贝
 * 互相看齐。
 *
 * 关键不变量:
 *  - 应答按 **toolCallId** 走(`requestId` 只是抓到它时的线索),这是
 *    docs 里权限可操作性一期定下的耐久相关键;
 *  - `canRespond === false` 时**不发命令**(没有活的 prompt,发出去只会被核心
 *    按频道亲和性拒掉),但本地 UI 收尾照常跑 —— 卡片不能停在"待你决定"。
 */
import type { ChatMessage, ToolCall } from '@/types'
import { platformApi } from '@/platform'
import type { PermissionResponse } from '@/components/chat/permission/permission-ledger'

import { SESSION_COMMAND_TYPES } from '@shared/events/index.js'

export type PermissionToolCall = Pick<ToolCall, 'id' | 'permissionId' | 'canRespond'>

export interface UsePermissionResponderOptions {
  /** 这一面所属的会话;拿不到就整体不发(与旧实现的 `panelSession` 判空同义)。 */
  getSessionId: () => string | undefined
  /** 当前渲染的消息列表(本地状态收尾要在这上面写)。 */
  getMessages: () => ChatMessage[]
}

export function usePermissionResponder(options: UsePermissionResponderOptions) {
  function findOwner(toolCallId: string): ChatMessage | undefined {
    return options.getMessages().find(m => m.toolCalls?.some(tc => tc.id === toolCallId))
  }

  async function confirmTool(toolCall: PermissionToolCall, response: PermissionResponse = 'once') {
    const sessionId = options.getSessionId()
    if (!sessionId) return

    // Find the message containing this tool call
    const message = findOwner(toolCall.id)
    const tc = message?.toolCalls?.find(t => t.id === toolCall.id)

    // Find and update the corresponding step
    const step = message?.steps?.find(s => s.toolCallId === toolCall.id)

    if (!toolCall.canRespond) {
      console.warn('[Frontend] Permission response ignored: no live prompt for tool call', toolCall.id)
      return
    }

    // Use unified command channel to respond (EventBus → Permission validates
    // channel). The tool call id is the durable correlation key — the manager
    // resolves it to the pending prompt; requestId is a hint when we caught it.
    console.log(`[Frontend] Responding to permission for tool call ${toolCall.id} with ${response}`)
    try {
      await platformApi.emitCommand(sessionId, {
        type: SESSION_COMMAND_TYPES.PERMISSION_RESPOND,
        requestId: toolCall.permissionId,
        toolCallId: toolCall.id,
        decision: response,
      })
      // The backend will handle execution and resume - just update UI state
      if (tc) {
        tc.status = 'executing'
        tc.requiresConfirmation = false
      }
      if (step) {
        step.status = 'running'
        if (message?.steps) {
          message.steps = [...message.steps]
        }
      }
    } catch (error) {
      console.error('Failed to respond to permission:', error)
    }
  }

  async function rejectTool(toolCall: PermissionToolCall, rejectReasonArg?: string) {
    // Update the tool call status to cancelled/rejected
    const sessionId = options.getSessionId()
    if (!sessionId) return

    // Find the message containing this tool call and update its status
    const message = findOwner(toolCall.id)

    // Only send when the live permission manager has an emitted prompt; the
    // local UI cleanup below still runs either way.
    if (toolCall.canRespond) {
      // Use unified command channel to reject (EventBus → Permission validates channel)
      console.log(`[Frontend] Rejecting permission for tool call ${toolCall.id}`, rejectReasonArg ? `Reason: ${rejectReasonArg}` : '')
      try {
        await platformApi.emitCommand(sessionId, {
          type: SESSION_COMMAND_TYPES.PERMISSION_RESPOND,
          requestId: toolCall.permissionId,
          toolCallId: toolCall.id,
          decision: 'reject',
          rejectReason: rejectReasonArg,
        })
      } catch (error) {
        console.error('Failed to respond to permission:', error)
      }
    }

    if (message) {
      const rejectionMessage = rejectReasonArg
        ? `The user rejected permission for this tool. Reason: ${rejectReasonArg}`
        : 'The user rejected permission for this tool.'
      const tc = message.toolCalls?.find(t => t.id === toolCall.id)
      if (tc) {
        tc.status = 'failed'
        tc.error = rejectionMessage
        tc.rejected = true
        tc.rejectionReason = rejectReasonArg
        tc.requiresConfirmation = false
      }

      // Update the corresponding step (step-own fields only; step.toolCall is
      // the same reference as tc above, so its fields are already updated).
      const step = message.steps?.find(s => s.toolCallId === toolCall.id)
      if (step) {
        step.status = 'failed'
        step.error = rejectionMessage
        step.rejected = true
        step.rejectionReason = rejectReasonArg
        // Force reactivity
        if (message.steps) {
          message.steps = [...message.steps]
        }
      }
    }
  }

  return { confirmTool, rejectTool }
}
