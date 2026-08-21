/**
 * 交互协议的 IPC / HTTP 操作面(claude-code-integration-v2 §4,E1)。
 *
 * 内核在 `@onething/core/interaction`,调用点直接引 core —— P3'a-2 之前这里
 * 还挂着一层「把 core 原样再导出一遍」的门面,那层门面除了让 `Interaction`
 * 在仓库里有两个来路之外什么都没做,已随本拨删除。
 *
 * 留下的是真东西:两个把 core 的读写包成 `{success, …}` 信封的薄封装 ——
 * 宿主那一层不该各写各的 try/catch。文件名带 `.wiring` 是因为它吃
 * `@shared/ipc` 的请求/响应类型(I3)。
 *
 * **导入本模块不做任何配置** —— 接线发生在 `backend.ts` 调用
 * `Interaction.initialize` 那一刻(`import-side-effect-free.test.ts` 守着这条)。
 */

import { Interaction } from '@onething/core/interaction'

import type {
  InteractionGetPendingResponse,
  InteractionRespondRequest,
  InteractionRespondResponse,
} from '@shared/ipc.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('interaction')


/**
 * IPC / HTTP 面的读:把还没答的提问吐给 UI 补水。
 *
 * 与 `getOnethingPendingPermissionsForIpc` 同款 `{success, …}` 信封 —— 宿主那一层
 * 不该各写各的 try/catch。
 */
export function getPendingInteractionsForIpc(sessionId: string): InteractionGetPendingResponse {
  try {
    return { success: true, pending: Interaction.getPending(sessionId) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('get pending interactions failed', { sessionId, reason: message })
    return { success: false, error: message }
  }
}

/**
 * IPC / HTTP 面的写。
 *
 * `channel` 由**宿主**填(desktop 恒为 'ipc'),不从渲染层传上来 —— 让应答方自报
 * 通道等于把通道亲和这道闸交给被校验方自己,那这道闸就白设了。
 */
export function respondInteractionForIpc(
  request: InteractionRespondRequest,
  channel = 'ipc',
): InteractionRespondResponse {
  try {
    const settled = request.decline
      ? Interaction.decline({
          sessionId: request.sessionId,
          interactionId: request.interactionId,
          toolCallId: request.toolCallId,
          reason: request.reason,
          channel,
        })
      : Interaction.respond({
          sessionId: request.sessionId,
          interactionId: request.interactionId,
          toolCallId: request.toolCallId,
          answers: request.answers ?? {},
          channel,
        })
    if (!settled) {
      // 已经结算过(用户抢答 / 到点超时 / 会话清理)是**常态**,不是错误:
      // UI 迟到的一次点击不该在这里炸出一条红。
      return { success: false, error: 'No pending interaction for this response' }
    }
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('interaction respond failed', { reason: message })
    return { success: false, error: message }
  }
}
