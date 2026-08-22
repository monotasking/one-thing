/**
 * 发起窗自己的两件事 —— 关掉它、改它的红绿灯显隐(结构债 P4 终态批 A1-a /
 * A1-b,2026-08-23)。
 *
 * 这是 `ShellDispatchContext.callerId` 的**第一个用例**:请求体是空的(或只带
 * 「显还是隐」),要动哪扇窗由宿主从 `event.sender.id` 认。同 `RpcDispatchContext`
 * 的规矩 —— 身份由宿主盖章,信封上压根没有这个字段可填,所以渲染层没法点名去关
 * (或去改)别人的窗。
 *
 * A1-b 加进来的 `setButtonVisibility` 从前是
 * `apps/electron/src/ipc/shell-controller.ts` 里一条**字面量通道**
 * (`window:set-button-visibility`,不在 `IPC_CHANNELS` 表上)。它归这个域而不是
 * 新立的 `shell` 域,判据就是上面那条:处理者动的是发起窗本身。
 * 迁移前那条 handler 是**没有回值**的(`ipcRenderer.invoke` 拿到 undefined),
 * 搬到只有请求/响应面的 router 上之后补一条空回执 `{ success: true }` ——
 * 调用点(`App.vue` 的 `.catch(() => {})`)本来就不看它。
 */
import type {
  CloseWindowResponse,
  SetWindowButtonVisibilityRequest,
  SetWindowButtonVisibilityResponse,
  WindowRoutes,
} from '@shared/ipc/window.js'
import { windowRouter } from '@shared/ipc/window.js'
import {
  registerShellDomain,
  type ShellDispatchContext,
  type ShellRouteHandlers,
} from '../shell-registry.js'

export interface WindowShellOperations {
  /** 关掉 `callerId` 指的那扇窗;拿不到窗(已销毁 / in-process 调用)回 false。 */
  closeCallerWindow(callerId: number | undefined): boolean
  /** 改 `callerId` 指的那扇窗的红绿灯显隐(非 macOS / 拿不到窗即 no-op)。 */
  setCallerWindowButtonVisibility(callerId: number | undefined, visible: boolean): void
}

export function createWindowShellHandlers(
  operations: WindowShellOperations,
): ShellRouteHandlers<WindowRoutes> {
  return {
    close: async (_request, context: ShellDispatchContext = {}): Promise<CloseWindowResponse> => ({
      success: operations.closeCallerWindow(context.callerId),
    }),
    setButtonVisibility: async (
      request: SetWindowButtonVisibilityRequest,
      context: ShellDispatchContext = {},
    ): Promise<SetWindowButtonVisibilityResponse> => {
      operations.setCallerWindowButtonVisibility(context.callerId, request?.visible ?? false)
      return { success: true }
    },
  }
}

export function registerWindowShellDomain(operations: WindowShellOperations): () => void {
  return registerShellDomain(windowRouter, createWindowShellHandlers(operations))
}
