/**
 * 深链确认门**请求面**的宿主处理者(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 两条,方向都是渲染层 → 主进程:
 *  - `ready` —— "我能画卡了"。冷启动队列的放行信号**由渲染层给**,不是主进程猜的
 *    "窗口大概建好了";猜的那一版会在慢机器上偶发丢链。
 *  - `respond` —— 用户按了钮。它是派发的唯一入口。
 *
 * 推卡的方向(主进程 → 渲染层)不在这里:投递时机由 URL 到达驱动,不由某次调用
 * 驱动,所以它仍是 `IPC_CHANNELS.DEEPLINK_REQUEST` 上的一条真推送。
 */
import type {
  DeepLinkReadyResponse,
  DeepLinkRespondRequest,
  DeepLinkRespondResponse,
  DeeplinkRoutes,
} from '@shared/ipc/deeplink.js'
import { deeplinkRouter } from '@shared/ipc/deeplink.js'
import { registerShellDomain, type ShellRouteHandlers } from '../shell-registry.js'

export interface DeeplinkShellOperations {
  markReady(): void
  respond(request: DeepLinkRespondRequest): Promise<DeepLinkRespondResponse>
}

export function createDeeplinkShellHandlers(
  operations: DeeplinkShellOperations,
): ShellRouteHandlers<DeeplinkRoutes> {
  return {
    ready: async (): Promise<DeepLinkReadyResponse> => {
      operations.markReady()
      return { success: true }
    },
    respond: async request => {
      try {
        return await operations.respond(request)
      } catch (error) {
        // 派发口本身从不抛(它回结构化结果),这里兜的是"意料之外"—— 兜住是为了让
        // 确认卡拿到一句能显示的话,而不是一个 pending 的 promise。
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

export function registerDeeplinkShellDomain(operations: DeeplinkShellOperations): () => void {
  return registerShellDomain(deeplinkRouter, createDeeplinkShellHandlers(operations))
}
