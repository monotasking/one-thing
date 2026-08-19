/**
 * R4b —— 一次工具直调的**旧形状**,新树里唯一还需要它的那几格。
 *
 * `@shared/ipc` 契约、渲染器、`ipc-bridge` / SSE 都按这个形状读结果,所以它必须
 * 活下来;但它不再是"工具的执行契约"(那是内核的 `Intent` / `Outcome` /
 * `Result`),而只是**投影出来的结果形状**。`IpcProjector.toExecutionResult` 是
 * 唯一的生产者(`OnethingToolExecutionResult` 与这里逐字同构),消费者是
 * `app/engine/stream/tool-execution.ts` 与它下游的编排。
 *
 * 三个类型分别从旧 `app/tools/types.ts` 原样搬过来(那个文件随旧树删除):
 * `ToolExecutionContext` 只剩投影器真的会填的那几格,`ToolExecutionResult` 一个
 * 字未改,`ToolPartialResultUpdate` 仍是 `@shared/ipc` 的 `ToolPartialResult`。
 */

import type { ToolPartialResult } from '@shared/ipc.js'
import type { JsonObject, JsonValue } from '@shared/json.js'
import type { Step } from '@shared/ipc.js'
import type { Principal } from '@onething/core/permission'

/** 工具流式改题 / 改元数据的那条回调载荷。 */
export interface ToolMetadataUpdate {
  title?: string
  metadata?: JsonObject
}

export type ToolPartialResultUpdate = ToolPartialResult

/** 一次直调的上下文(投影器读的就是这几格)。 */
export interface ToolExecutionContext {
  sessionId: string
  messageId: string
  toolCallId?: string
  /** 会话当下的工作目录。 */
  workingDirectory?: string
  /** 额外的沙箱根。 */
  workingDirectoryRoots?: string[]
  /**
   * 谁在跑这次工具。在引擎边界铸一次并一路带下来 —— 这个字段存在的理由是:
   * 下游曾经各自从 `session.agentId` 反推一个 actor,而那个字段每条会话都有,
   * 它的存在什么也证明不了。
   */
  principal?: Principal
  abortSignal?: AbortSignal
  onStepStart?: (step: Step) => void
  onStepComplete?: (step: Step) => void
  onMetadata?: (update: ToolMetadataUpdate) => void
  onPartialResult?: (update: ToolPartialResultUpdate) => void
  /** 副作用之前的等待点(排他队列 + 权限过后刷一次卡片状态)。 */
  beforeSideEffect?: () => Promise<void>
}

/** 一次直调的结果 —— 与旧 `app/tools/types.ts` 的同名类型逐字相同。 */
export interface ToolExecutionResult {
  success: boolean
  data?: object | JsonValue
  error?: string
  /** 危险命令需要用户确认。 */
  requiresConfirmation?: boolean
  commandType?: 'read-only' | 'dangerous' | 'forbidden'
  /** 用户取消。 */
  aborted?: boolean
  /** 用户拒绝授权。 */
  rejected?: boolean
  rejectionReason?: string
  /** N6:这一回合的工具都落定之后收尾(graceful wrap-up)。 */
  terminate?: boolean
}
