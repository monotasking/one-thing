/**
 * Search Everywhere 窗口面的 **web 处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 三条动窗口的在浏览器里没有等价物,老实回迁移前那句逐字相同的话;
 * `executeAction` **有真实现** —— 打 `/api/search/actions`,拿回解析后的 actionId
 * 再在页内广播出去(工作区据此跳转),同样是迁移前 `platform/web.ts` 那段的搬迁。
 */
import type {
  SearchExecuteActionRequest,
  SearchExecuteActionResponse,
  SearchWindowRoutes,
} from '@shared/ipc/search.js'
import { searchWindowRouter } from '@shared/ipc/search.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'
import { webShellUnsupported } from './unsupported'

export interface SearchWindowWebShellDeps {
  postJson<T>(path: string, body: unknown): Promise<T>
  /** 页内广播:把一条动作交给订阅了 `onSearchAction` 的调用点。 */
  emitSearchAction(actionId: string): void
}

export function createSearchWindowWebShellHandlers(
  deps: SearchWindowWebShellDeps,
): WebShellRouteHandlers<SearchWindowRoutes> {
  return {
    toggle: async () => webShellUnsupported('toggleSearchWindow'),
    close: async () => webShellUnsupported('closeSearchWindow'),
    setAnchor: async () => webShellUnsupported('setSearchWindowAnchor'),
    executeAction: async (request: SearchExecuteActionRequest) => {
      const actionId = request?.actionId ?? ''
      const response = await deps.postJson<SearchExecuteActionResponse>(
        '/api/search/actions',
        { actionId },
      )
      if (response.success) deps.emitSearchAction(response.actionId || actionId)
      return response
    },
  }
}

export function registerSearchWindowWebShellDomain(
  deps: SearchWindowWebShellDeps,
): () => void {
  return registerWebShellDomain(searchWindowRouter, createSearchWindowWebShellHandlers(deps))
}
