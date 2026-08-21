/**
 * 模型注册表查询域(主线 T1 第二批)。
 *
 * 替换 `apps/electron/src/main/ipc/models.ts`(已删)与 server 的
 * `runtime.providers.{getModelsWithCapabilities,getAllModels,searchModels,
 * refreshModelRegistry,getModelNameAliases,getModelDisplayName}` +
 * `/api/models*` 四条路由与 `/api/providers/:id/models`。
 *
 * 六个方法都读同一份 model registry(`app/providers/model-registry.ts`,
 * 落在 settings.json 里)。server 原本是 per-owner 的 settings 分库 +
 * 一份自己抄的 models.dev 刷新逻辑 —— 与第一批 prompts / todo-plan 同类,
 * 迁完收敛成 `<store>` 下的单库,旧的 `owners/<uid>/<wid>/` 设置不会自动搬家。
 */
import type { RouteHandlers } from '@onething/core/ipc'
import { modelsRouter, type ModelsRoutes } from '@shared/ipc/providers.js'
import { AIProvider } from '@shared/ipc/providers.js'
import type { OpenRouterModel } from '@shared/ipc/providers.js'
import {
  fetchOnethingGitHubCopilotModelsWithAuth,
  getAllOnethingModelRegistryModelsForIpc,
  getOnethingModelsWithCapabilities,
  getOnethingModelRegistryDisplayNameForIpc,
  getOnethingModelRegistryNameAliasesForIpc,
  refreshOnethingModelRegistryForIpc,
  searchOnethingModelRegistryForIpc,
  type OnethingConfiguredModelSelection,
} from '@onething/runtime/providers'
import { authService } from '../../wiring/auth/auth-service.js'
import { fetchCopilotModels } from '../../providers/builtin/github-copilot.js'
import { fetchCodexModels, getCodexFallbackModels } from '../../providers/builtin/codex.js'
import * as modelRegistry from '../../providers/model-registry.js'
import { getSettings } from '../../stores/settings.js'
import { registerRouterHandlers } from '../registry.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'

const log = getLogger('ipc.models')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


/** Copilot 的模型表不在注册表里,要拿着 OAuth token 现取。 */
async function fetchGitHubCopilotModelsRaw(): Promise<{ id: string; name: string; description?: string }[]> {
  return fetchOnethingGitHubCopilotModelsWithAuth({
    getToken: providerId => authService.getToken(providerId),
    fetchCopilotModels,
  })
}

async function fetchCodexModelsRaw(): Promise<OpenRouterModel[]> {
  const token = await authService.refreshTokenIfNeeded('codex')
  return fetchCodexModels(token)
}

export const modelsRpcHandlers: RouteHandlers<ModelsRoutes> = {
  async getWithCapabilities(request) {
    return getOnethingModelsWithCapabilities(
      { providerId: request?.providerId ?? '', forceRefresh: request?.forceRefresh },
      {
        getModelsForProvider: providerId =>
          modelRegistry.getModelsForProvider(providerId) as Promise<OpenRouterModel[]>,
        fetchCopilotModels: fetchGitHubCopilotModelsRaw,
        fetchCodexModels: fetchCodexModelsRaw,
        saveProviderModels: (providerId, models) =>
          modelRegistry.saveProviderModels(providerId, models as OpenRouterModel[]),
        getCodexFallbackModels: modelIds => getCodexFallbackModels(modelIds) as OpenRouterModel[],
        getConfiguredCodexModelSelection: () =>
          getSettings()?.ai?.providers?.codex as OnethingConfiguredModelSelection | undefined,
        getACPAgents: () => getSettings()?.acp?.agents,
        providerIds: {
          githubCopilot: [AIProvider.GitHubCopilot],
          codex: [AIProvider.Codex],
          acp: [AIProvider.ACP],
        },
        logger: consoleLog,
      },
    )
  },
  async getAll() {
    return getAllOnethingModelRegistryModelsForIpc({
      getAllModels: () => modelRegistry.getAllModels(),
      logger: consoleLog,
    })
  },
  async search(request) {
    return searchOnethingModelRegistryForIpc({
      query: request?.query ?? '',
      providerId: request?.providerId,
      searchModels: (query, providerId) => modelRegistry.searchModels(query, providerId),
      logger: consoleLog,
    })
  },
  async refreshRegistry(request) {
    const providerId = request?.providerId
    return refreshOnethingModelRegistryForIpc({
      forceRefresh: () =>
        providerId ? modelRegistry.refreshProviderModels(providerId) : modelRegistry.forceRefresh(),
      logger: consoleLog,
    })
  },
  async getNameAliases() {
    return getOnethingModelRegistryNameAliasesForIpc({
      getModelNameAliases: () => modelRegistry.getModelNameAliases(),
      logger: consoleLog,
    })
  },
  async getDisplayName(request) {
    return getOnethingModelRegistryDisplayNameForIpc({
      modelId: request?.modelId ?? '',
      getModelDisplayName: modelId => modelRegistry.getModelDisplayName(modelId),
      logger: consoleLog,
    })
  },
}

export function registerModelsRpcDomain(): () => void {
  return registerRouterHandlers(modelsRouter, modelsRpcHandlers)
}
