/**
 * Interaction Module
 *
 * agent 提问 → 用户应答的 wire 契约(claude-code-integration-v2 §4,E1)。
 *
 * 协议本体**不在这里重抄一遍**,直接从 `@onething/core/interaction` 再导出 ——
 * 与 `shared/tool-errors.ts` 从 `@onething/core/permission` 再导出同一条做法。
 * (`ipc/permissions.ts` 当年是手抄的一份平行副本,两边各加一格就漂移;
 * core 的 `interaction/types.ts` 是零 import 的纯类型模块,`export type` 全擦除,
 * 渲染层引到它不会顺带拖进 `node:crypto`。)
 */

export type {
  InteractionAnswer,
  InteractionOption,
  InteractionOrigin,
  InteractionOutcome,
  InteractionQuestion,
  InteractionQuestionAnswer,
  InteractionRequest,
} from '@onething/core/interaction'

import type {
  InteractionQuestionAnswer,
  InteractionRequest,
} from '@onething/core/interaction'

export interface InteractionRespondRequest {
  sessionId: string
  /** 活的请求 id。与 toolCallId 至少给一个。 */
  interactionId?: string
  /** 持久相关键 —— 刷新之后 UI 手上只剩它。 */
  toolCallId?: string
  /** 逐题答案,键是 `InteractionQuestion.id`。decline 时可省。 */
  answers?: Record<string, InteractionQuestionAnswer>
  /** 用户点了「不回答」→ declined,而不是空答案的 answered。 */
  decline?: boolean
  reason?: string
}

export interface InteractionRespondResponse {
  success: boolean
  error?: string
}

export interface InteractionGetPendingRequest {
  sessionId: string
}

export interface InteractionGetPendingResponse {
  success: boolean
  pending?: InteractionRequest[]
  error?: string
}

// ============================================
// Router
// ============================================

/**
 * interaction(agent 提问 → 用户应答)域 —— 结构债 P4c 第九批,两条数据面整只从
 * 手写 IPC 通道迁到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 两条逐条对应从前的 `INTERACTION_RESPOND` / `INTERACTION_GET_PENDING`,形状一字
 * 未改;`getPending` 从前递的是**裸 sessionId**,这里按本仓 router 惯例收成单
 * id 包对象(`InteractionGetPendingRequest` 早就在上面定义好了,只是没人用)。
 *
 * **本域零推送** —— 提问事件走会话事件通道(`interaction:requested` /
 * `interaction:settled`),不是这个域的通道。
 *
 * 注:除了这两条,应答还能走统一命令通道(`command:interaction-respond` →
 * EventBus → Interaction 的订阅),两条路进的是同一个内核。
 */
import { defineRouter } from './router.js'

export type InteractionRoutes = {
  respond: { input: InteractionRespondRequest; output: InteractionRespondResponse }
  getPending: {
    input: InteractionGetPendingRequest
    output: InteractionGetPendingResponse
  }
}

export const interactionRouter = defineRouter<InteractionRoutes>('interaction', [
  'respond',
  'getPending',
])
