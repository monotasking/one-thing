/**
 * 模型注册表域的渲染侧客户端(主线 T1 第二批)。
 *
 * 形状照 E1 判例:壳外一个模块 + 通用 `platformApi.rpcInvoke`,四壳零改动。
 * 方法名与旧的 `platformApi.*` 一一对应,位置参数在这里折成信封。
 */
import { modelsRouter } from '@shared/ipc/providers.js'
import type {
  ModelDisplayNameResponse,
  ModelNameAliasesResponse,
  ModelRefreshRegistryResponse,
  ModelsListResponse,
} from '@shared/ipc/providers.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

const models = createRouterClient(modelsRouter, request => platformApi.rpcInvoke(request))

export const modelsApi = {
  getModelsWithCapabilities: (
    providerId: string,
    options?: { forceRefresh?: boolean },
  ): Promise<ModelsListResponse> =>
    models.getWithCapabilities({ providerId, forceRefresh: options?.forceRefresh }),
  getAllModels: (): Promise<ModelsListResponse> => models.getAll({}),
  searchModels: (query: string, providerId?: string): Promise<ModelsListResponse> =>
    models.search({ query, providerId }),
  refreshModelRegistry: (providerId?: string): Promise<ModelRefreshRegistryResponse> =>
    models.refreshRegistry(providerId ? { providerId } : {}),
  getModelNameAliases: (): Promise<ModelNameAliasesResponse> => models.getNameAliases({}),
  getModelDisplayName: (modelId: string): Promise<ModelDisplayNameResponse> =>
    models.getDisplayName({ modelId }),
}
