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
 * 2. `quota`(批 5 从 `usage` 改名)—— 读 `backend.quota`(`wiring/quota`):manifest 的
 *    `quotaSource` → 配额源注册表,这里一个 provider 名都不认。凭证按请求带的空间(缺席 =
 *    默认空间)与凭证 id(缺席 = 密钥策略的只读 `decide`)取,headless 宿主的 token store
 *    有 plaintext 回退(见 `runtime/auth/host-ports.ts` 的契约),所以 server 照走真链路。
 */
import type { RouteHandlers } from '@onething/core/ipc'
import type { ProviderInfo, ProvidersRoutes } from '@shared/ipc/providers.js'
import {
  inspectOnethingProviderEnvStatusForIpc,
  listOnethingProvidersForIpc,
} from '@onething/runtime/providers'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import { getAvailableProviders } from '../../wiring/providers/index.js'
import { getProviderEnvStatus } from '@onething/runtime/providers/env.wiring'
import { listLabeledDialectsForIpc } from '@onething/runtime/agent-loop/providers/dialect-options'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingProviderPresentationIpcLogger } from '@onething/runtime/providers/provider-presentation'
import { getCurrentBackendInstance } from '../../current.js'
import type { ListOnethingProvidersOptions } from '@onething/runtime/providers/provider-presentation'

const log = getLogger('ipc.providers')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingProviderPresentationIpcLogger = consolePort(log)


export const providersRpcHandlers: RouteHandlers<ProvidersRoutes> = {
  async list() {
    const listOnethingProvidersOptions: ListOnethingProvidersOptions<ProviderInfo> & { logger?: OnethingProviderPresentationIpcLogger | undefined; } = { getAvailableProviders, logger: consoleLog };
    return listOnethingProvidersForIpc(listOnethingProvidersOptions)
  },
  /** 「接口类型」下拉(批 3 §6.1):方言自述人话名,有名字的才进。只读,不碰网。 */
  async listDialects() {
    return listLabeledDialectsForIpc()
  },
  async quota(request) {
    const providerId = request?.providerId ?? ''
    const service = getCurrentBackendInstance()?.quota
    if (!providerId || !service) return { quota: { kind: 'unsupported' } }
    return service.get({
      providerId,
      spaceId: request?.spaceId || DEFAULT_SPACE_ID,
      ...(request?.credentialId ? { credentialId: request.credentialId } : {}),
      ...(request?.force ? { force: true } : {}),
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

