/**
 * Provider 目录 / 配额 / 环境变量域的渲染侧客户端(主线 T1 第二批)。
 *
 * 形状照 E1 判例:壳外一个模块 + 通用 `platformApi.rpcInvoke`,四壳零改动。
 * 对外沿用旧的位置参数签名(`getProviderUsage(providerId)`),信封在这里包 ——
 * 调用点只换引入来源。
 */
import { providersRouter } from '@shared/ipc/providers.js'
import type {
  GetProviderEnvStatusResponse,
  GetProvidersResponse,
  ProviderUsageResponse,
} from '@shared/ipc/providers.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

const providers = createRouterClient(providersRouter, request => platformApi.rpcInvoke(request))

export const providersApi = {
  getProviders: (): Promise<GetProvidersResponse> => providers.list({}),
  getProviderUsage: (providerId: string): Promise<ProviderUsageResponse> =>
    providers.usage({ providerId }),
  getProviderEnvStatus: (providerId: string): Promise<GetProviderEnvStatusResponse> =>
    providers.envStatus({ providerId }),
}
