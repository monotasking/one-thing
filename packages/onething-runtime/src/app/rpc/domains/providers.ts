/**
 * Provider 目录与配额查询域(主线 T1 第二批)。
 *
 * 替换 `apps/electron/src/main/ipc/providers.ts`(已删)与 server 的
 * `runtime.providers.{list,usage,envStatus}` + `/api/providers*` 三条路由。
 *
 * **两处不是等价搬迁,说清楚:**
 * 1. `list` —— server 原本返回的是一张写死的表(local + 内建 provider info),
 *    而 desktop 走 `getAvailableProviders()` 读注册表。注册表由
 *    `configureAppProviderRegistry()` 在 `createOnethingBackend` 里装配,**每个
 *    宿主都跑**,所以 server 迁完拿到的是真注册表,不是降级。
 * 2. `usage` —— server 原本无条件抛 "Provider usage requires OAuth in the
 *    desktop host."。那句话在 auth 主机端口未注入时是实话,但 headless 宿主的
 *    token store 有 plaintext 回退(见 `app/auth/host-ports.ts` 的契约),
 *    凭证在同一个 store 里。所以这里不再假装不支持,照 desktop 走真链路 ——
 *    与第一批 `goal` 补齐 web 桩同类:顺带补齐,不是等价搬迁。
 */
import type { RouteHandlers } from '@onething/core/ipc'
import { providersRouter, type ProvidersRoutes } from '@shared/ipc/providers.js'
import { AIProvider } from '@shared/ipc/providers.js'
import {
  getOnethingProviderUsage,
  inspectOnethingProviderEnvStatusForIpc,
  listOnethingProvidersForIpc,
} from '@onething/runtime/providers'
import { authService } from '../../auth/auth-service.js'
import { fetchCodexUsage } from '../../providers/builtin/codex.js'
import { getAvailableProviders } from '../../providers/index.js'
import { getProviderEnvStatus } from '../../providers/env.js'
import { registerRouterHandlers } from '../registry.js'

export const providersRpcHandlers: RouteHandlers<ProvidersRoutes> = {
  async list() {
    return listOnethingProvidersForIpc({ getAvailableProviders, logger: console })
  },
  async usage(request) {
    return getOnethingProviderUsage({
      providerId: request?.providerId ?? '',
      codexProviderIds: ['codex', AIProvider.Codex],
      canonicalCodexProviderId: AIProvider.Codex,
      refreshTokenIfNeeded: providerId => authService.refreshTokenIfNeeded(providerId),
      fetchCodexUsage,
    })
  },
  async envStatus(request) {
    return inspectOnethingProviderEnvStatusForIpc({
      providerId: request?.providerId ?? '',
      getProviderEnvStatus,
      logger: console,
    })
  },
}

export function registerProvidersRpcDomain(): () => void {
  return registerRouterHandlers(providersRouter, providersRpcHandlers)
}
