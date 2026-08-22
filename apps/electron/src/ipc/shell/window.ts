/**
 * 「关掉发起这次调用的那扇窗」的**宿主处理者**(结构债 P4 终态批 A1-a,
 * 2026-08-23)。
 *
 * 这是 `ShellDispatchContext.callerId` 的**第一个用例**:请求体是空的,要关哪扇窗
 * 由宿主从 `event.sender.id` 认。同 `RpcDispatchContext` 的规矩 —— 身份由宿主盖章,
 * 信封上压根没有这个字段可填,所以渲染层没法点名去关别人的窗。
 */
import type { CloseWindowResponse, WindowRoutes } from '@shared/ipc/window.js'
import { windowRouter } from '@shared/ipc/window.js'
import {
  registerShellDomain,
  type ShellDispatchContext,
  type ShellRouteHandlers,
} from '../shell-registry.js'

export interface WindowShellOperations {
  /** 关掉 `callerId` 指的那扇窗;拿不到窗(已销毁 / in-process 调用)回 false。 */
  closeCallerWindow(callerId: number | undefined): boolean
}

export function createWindowShellHandlers(
  operations: WindowShellOperations,
): ShellRouteHandlers<WindowRoutes> {
  return {
    close: async (_request, context: ShellDispatchContext = {}): Promise<CloseWindowResponse> => ({
      success: operations.closeCallerWindow(context.callerId),
    }),
  }
}

export function registerWindowShellDomain(operations: WindowShellOperations): () => void {
  return registerShellDomain(windowRouter, createWindowShellHandlers(operations))
}
