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
 *    token store 有 plaintext 回退(见 `runtime/auth/host-ports.ts` 的契约),
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
import { authService } from '../../wiring/auth/auth-service.js'
import {
  credentialTargetFromMarker,
  resolveSpaceProviderCredentialForSpace,
} from '../../wiring/providers/space-credentials.js'
import { toSpaceCredentialMarker } from '@onething/runtime/spaces/provider-credentials'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import { fetchCodexUsage } from '../../wiring/providers/builtin/codex.js'
import { getAvailableProviders } from '../../wiring/providers/index.js'
import { getProviderEnvStatus } from '@onething/runtime/providers/env.wiring'
import { registerRouterHandlers } from '../registry.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'

const log = getLogger('ipc.providers')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


/** 「这个空间的这个 provider 的 OAuth 账号」→ auth 层的读写目标。 */
function providerUsageCredentialTarget(spaceId: string | undefined, providerId: string) {
  const resolution = resolveSpaceProviderCredentialForSpace(spaceId || DEFAULT_SPACE_ID, providerId)
  return credentialTargetFromMarker(toSpaceCredentialMarker(resolution))
}

export const providersRpcHandlers: RouteHandlers<ProvidersRoutes> = {
  async list() {
    return listOnethingProvidersForIpc({ getAvailableProviders, logger: consoleLog })
  },
  async usage(request) {
    return getOnethingProviderUsage({
      providerId: request?.providerId ?? '',
      codexProviderIds: ['codex', AIProvider.Codex],
      canonicalCodexProviderId: AIProvider.Codex,
      refreshTokenIfNeeded: providerId =>
        authService.refreshTokenIfNeeded(
          providerId,
          // C1:token 住在空间的凭证池里,不再有「settings 那一把」。请求带哪个
          // 空间就查哪个空间的账号 —— 用量卡因此在每个空间都说得出话,而不是
          // 在非默认空间静默消失(批 B10 移交项 2)。
          providerUsageCredentialTarget(request?.spaceId, providerId),
        ),
      fetchCodexUsage,
    })
  },
  async envStatus(request) {
    return inspectOnethingProviderEnvStatusForIpc({
      providerId: request?.providerId ?? '',
      getProviderEnvStatus,
      logger: consoleLog,
    })
  },
}

export function registerProvidersRpcDomain(): () => void {
  return registerRouterHandlers(providersRouter, providersRpcHandlers)
}
