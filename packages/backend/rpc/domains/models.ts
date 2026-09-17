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
import type { ModelsRoutes } from '@shared/ipc/providers.js'
import { AIProvider } from '@shared/ipc/providers.js'
import type { OpenRouterModel, ProviderConfig } from '@shared/ipc/providers.js'
import { createAgentProviderFromRuntime } from '../../wiring/agent-loop/providers/factory.js'
import type { OnethingProviderOptions } from '@onething/runtime/providers/provider-options'
import {
  fetchOnethingGitHubCopilotModelsWithAuth,
  getAllOnethingModelRegistryModelsForIpc,
  getOnethingModelsWithCapabilities,
  getOnethingModelCapabilitiesForIpc,
  getOnethingModelRegistryDisplayNameForIpc,
  getOnethingModelRegistryNameAliasesForIpc,
  projectOnethingThinkingLevels,
  refreshOnethingModelRegistryForIpc,
  resolveOnethingModelCapabilities,
  searchOnethingModelRegistryForIpc,
  type OnethingConfiguredModelSelection,
} from '@onething/runtime/providers'
import { authService } from '../../wiring/auth/auth-service.js'
import { fetchCopilotModels } from '../../wiring/providers/builtin/github-copilot.js'
import { fetchCodexModels, getCodexFallbackModels } from '../../wiring/providers/builtin/codex.js'
import * as modelRegistry from '../../wiring/providers/model-registry.js'
import { getSettings } from '../../stores/settings.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { GetOnethingModelsWithCapabilitiesAdapters } from '@onething/runtime/providers/model-registry'
import type { RefreshOnethingModelRegistryOptions, GetOnethingModelRegistryNameAliasesOptions, OnethingModelQueryIpcLogger } from '@onething/runtime/providers/model-query-presentation'
import type { OnethingModelRegistryRefreshLogger } from '@onething/runtime/providers/model-registry'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { GetAllOnethingModelRegistryModelsOptions } from '@onething/runtime/providers/model-query-presentation'
import type { ModelInfo } from '@shared/ipc.js'
import type { FetchOnethingGitHubCopilotModelsWithAuthOptions } from '@onething/runtime/providers/model-registry'

const log = getLogger('ipc.models')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingModelQueryIpcLogger & OnethingModelRegistryRefreshLogger = consolePort(log)


/** Copilot 的模型表不在注册表里,要拿着 OAuth token 现取。 */
async function fetchGitHubCopilotModelsRaw(): Promise<{ id: string; name: string; description?: string }[]> {
  const fetchOnethingGitHubCopilotModelsWithAuthOptions: FetchOnethingGitHubCopilotModelsWithAuthOptions<ModelInfo> = {
    getToken: providerId => authService.getToken(providerId),
    fetchCopilotModels,
  };
  return fetchOnethingGitHubCopilotModelsWithAuth(fetchOnethingGitHubCopilotModelsWithAuthOptions)
}

async function fetchCodexModelsRaw(): Promise<OpenRouterModel[]> {
  const token = await authService.refreshTokenIfNeeded('codex')
  return fetchCodexModels(token)
}

/**
 * 「这一型的思考能提供几档」—— 目录行上那四格的**唯一填法**(2026-09-05)。
 *
 * 判据一格都不在这里:滤 `'none'`、缺席 profile 读作「不思考」全在
 * `projectOnethingThinkingLevels`(产品层,profile 隔壁)。这一层只做装配层才知道
 * 的那一件事 —— 把设置里的 override / 目录条目喂给能力裁定,与
 * `getModelCapabilities` 下面那段「不解析凭据」同一手:**一次网络都不打**。
 */
function modelProviderConfig(providerId: string) {
  const ai = getSettings()?.ai
  const custom = ai?.customProviders?.find(provider => provider.id === providerId)
  const configured = ai?.providers?.[providerId]
  return (custom ? { ...custom, ...configured } : configured) as
    | (ProviderConfig & { apiType?: 'openai' | 'anthropic' })
    | undefined
}

function thinkingProjectionOf(providerId: string, modelId: string) {
  const providerConfig = modelProviderConfig(providerId)
  const apiType = providerConfig?.apiType
  const caps = resolveOnethingModelCapabilities({
    providerId,
    modelId,
    providerReasoningProfile: (providerConfig as ProviderConfig & { providerOptions?: OnethingProviderOptions })?.providerOptions?.reasoningProfile,
    ...(apiType === 'openai' || apiType === 'anthropic' ? { customApiType: apiType } : {}),
    ...(providerConfig?.modelCapabilitiesByModel?.[modelId]
      ? { override: providerConfig.modelCapabilitiesByModel[modelId] }
      : {}),
    ...(providerConfig?.models?.[modelId] ? { registryEntry: providerConfig.models[modelId] } : {}),
  })
  return projectOnethingThinkingLevels(caps.reasoningProfile)
}

/** 目录一整家逐行盖上那四格。**加性**:原对象一格不改,只多四个键。 */
function withThinkingLevels(
  providerId: string,
  models: readonly OpenRouterModel[],
): OpenRouterModel[] {
  const config = modelProviderConfig(providerId)
  const configuredIds = new Set([
    ...(config?.selectedModels ?? []),
    config?.model,
  ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()))
  const known = new Set(models.map(model => model.id))
  const all = [...models]
  for (const id of configuredIds) {
    if (known.has(id)) continue
    // The legacy envelope overstates which metadata fields are required. Keep
    // absent prices/context/capabilities absent instead of inventing catalog data.
    all.push({ id, name: id, configuredOnly: true } as OpenRouterModel)
  }
  return all.map((model) => ({ ...model, ...thinkingProjectionOf(providerId, model.id) }))
}

export const modelsRpcHandlers: RouteHandlers<ModelsRoutes> = {
  async getWithCapabilities(request) {
    const getOnethingModelsWithCapabilitiesAdapters: GetOnethingModelsWithCapabilitiesAdapters = {
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
      // 刷新钮对通用厂商的真动作(2026-09-11):重拉 models.dev 落盘,随后
      // `getModelsForProvider` 读到的是新表。挂在这里而不是壳里 —— 壳那一头
      // (`forceRefresh: true`)本来就对,断的是后端这一截。
      refreshProviderModels: providerId => modelRegistry.refreshProviderModels(providerId),
      providerIds: {
        githubCopilot: [AIProvider.GitHubCopilot],
        codex: [AIProvider.Codex],
        acp: [AIProvider.ACP],
      },
      logger: consoleLog,
    };
    const providerId = request?.providerId ?? ''
    const result = await getOnethingModelsWithCapabilities(
      { providerId, forceRefresh: request?.forceRefresh },
      getOnethingModelsWithCapabilitiesAdapters,
    )
    // 这一口是抽屉的目录口:思考档位随行走(逐 (provider, model) 再发一次
    // `getModelCapabilities` 对一张几十上百行的表不成立)。失败那一支原样交回。
    if (!result.success) return result
    return { ...result, models: withThinkingLevels(providerId, result.models ?? []) }
  },
  async getAll() {
    const getAllOnethingModelRegistryModelsOptions: GetAllOnethingModelRegistryModelsOptions<OpenRouterModel> & { logger?: OnethingModelQueryIpcLogger | undefined; } = {
      getAllModels: () => modelRegistry.getAllModels(),
      logger: consoleLog,
    };
    return getAllOnethingModelRegistryModelsForIpc(getAllOnethingModelRegistryModelsOptions)
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
    const refreshOnethingModelRegistryOptions: RefreshOnethingModelRegistryOptions & { logger?: OnethingModelRegistryRefreshLogger } = {
      forceRefresh: () =>
        providerId ? modelRegistry.refreshProviderModels(providerId) : modelRegistry.forceRefresh(),
      logger: consoleLog,
    };
    return refreshOnethingModelRegistryForIpc(refreshOnethingModelRegistryOptions)
  },
  async getNameAliases() {
    const getOnethingModelRegistryNameAliasesOptions: GetOnethingModelRegistryNameAliasesOptions & { logger?: OnethingModelRegistryRefreshLogger } = {
      getModelNameAliases: () => modelRegistry.getModelNameAliases(),
      logger: consoleLog,
    };
    return getOnethingModelRegistryNameAliasesForIpc(getOnethingModelRegistryNameAliasesOptions)
  },
  /**
   * P4-7:渲染层的「文件能力」诚实口。投影与错误成形归 runtime
   * (`model-query-presentation.ts`),这一层只做装配层才知道的那一件事 ——
   * 把设置里的凭据 / 目录折成一个 provider。
   *
   * **不解析凭据**:`getModelCapabilities` 一次网络都不打(账本 + 传输声明,
   * 全是本地判定),而 `resolveProviderAuth` 会顺手刷 OAuth token —— 一个查询
   * 不该改状态。因此只带上设置里现成的 apiKey。构造仍可能抛(未登录的
   * codex、认不出的 dialect),那一支回 `success:false`,渲染层用它今天的
   * vision 别名兜底,而不是骗用户说"不能传文件"。
   */
  async getModelCapabilities(request) {
    const providerId = request?.providerId ?? ''
    const model = request?.model ?? ''
    const result = await getOnethingModelCapabilitiesForIpc({
      providerId,
      model,
      createProvider: (providerId, model) => {
        // `apiType` / `providerOptions` 只住在自建端点那几档上(ProviderConfig 是
        // 联合的窄边),按需放宽读一次 —— 与 system-prompt-snapshot 同一手法。
        const providerConfig = getSettings()?.ai?.providers?.[providerId] as
          | (ProviderConfig & { apiType?: string; providerOptions?: OnethingProviderOptions })
          | undefined
        const apiType = providerConfig?.apiType
        return createAgentProviderFromRuntime(providerId, {
          apiKey: providerConfig?.apiKey,
          baseUrl: typeof providerConfig?.baseUrl === 'string' ? providerConfig.baseUrl : undefined,
          model,
          apiType: apiType === 'openai' || apiType === 'anthropic' ? apiType : undefined,
          providerOptions: providerConfig?.providerOptions,
          modelCapabilitiesByModel: providerConfig?.modelCapabilitiesByModel,
          models: providerConfig?.models,
        })
      },
      logger: consoleLog,
    })
    // 思考档位那四格与目录口**同一份投影**(一致性:同一件事实两条口一个形状)。
    // 失败那一支不补 —— 那一档连 capabilities 都没有。
    if (!('capabilities' in result) || !result.capabilities) return result
    return {
      ...result,
      capabilities: { ...result.capabilities, ...thinkingProjectionOf(providerId, model) },
    }
  },
  async getDisplayName(request) {
    return getOnethingModelRegistryDisplayNameForIpc({
      modelId: request?.modelId ?? '',
      getModelDisplayName: modelId => modelRegistry.getModelDisplayName(modelId),
      logger: consoleLog,
    })
  },
}
