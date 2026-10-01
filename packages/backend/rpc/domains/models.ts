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
import type { RouteHandlers } from '@shared/ipc/router'
import type { ModelsRoutes } from '@shared/ipc/providers.js'
import type {
  ModelEffectiveFacts,
  ModelParameterSuggestion,
  OpenRouterModel,
  ProviderConfig,
  ReasoningProfileOverride,
} from '@shared/ipc/providers.js'
import { createAgentProviderFromRuntime } from '../../wiring/agent-loop/providers/factory.js'
import type { OnethingProviderOptions } from '@onething/runtime/providers/provider-options'
import {
  catalogFactsOf,
  createOnethingManualModelEntry,
  effectiveModelFactsOf,
  isOnethingManualModelEntry,
  onethingModelOverrideFactsOf,
  openRouterModelToOnethingCapabilityEntry,
  type OnethingCatalogModelEntry,
  type OnethingOpenRouterModel,
  onethingCapabilityEntryToOpenRouterModel,
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
  modelsDevModelToOnethingCapabilityEntry,
  ONETHING_PROVIDER_MAPPING,
} from '@onething/runtime/providers'
import {
  MODEL_SUGGESTION_CAPABILITY_KEYS,
  modelIdentityIndexOf,
  modelParameterSuggestionOf,
  type ModelIdentityIndex,
} from '@onething/runtime/providers/model-identity'
import { authService } from '../../wiring/auth/auth-service.js'
import { createPolicyFetch } from '../../provider-binding/bound-fetch.js'
import {
  VENDOR_RUNTIMES,
  type VendorModelsFetcherDeps,
} from '@onething/runtime/providers/vendors/runtimes'
import * as modelRegistry from '../../wiring/providers/model-registry.js'
import {
  addManualModel,
  foldedCatalogFor,
  removeManualModel,
} from '../../wiring/providers/manual-models.js'
import { getSettings, getSpaceSettings } from '../../stores/settings.js'
import { getCurrentBackendInstance } from '../../current.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { GetOnethingModelsWithCapabilitiesAdapters } from '@onething/runtime/providers/model-registry'
import type { RefreshOnethingModelRegistryOptions, GetOnethingModelRegistryNameAliasesOptions, OnethingModelQueryIpcLogger } from '@onething/runtime/providers/model-query-presentation'
import type { OnethingModelRegistryRefreshLogger } from '@onething/runtime/providers/model-registry'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { GetAllOnethingModelRegistryModelsOptions } from '@onething/runtime/providers/model-query-presentation'
import type { OnethingEndpointModelsFetcher } from '@onething/runtime/providers/model-registry'

const log = getLogger('ipc.models')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingModelQueryIpcLogger & OnethingModelRegistryRefreshLogger = consolePort(log)


/**
 * `endpoint` 来源那几家的列表口(Copilot 拿 OAuth token 现取、Codex 读缓存 ∪ 兜底 / 刷新时现取):
 * 各家自己带(`VendorRuntime.createModelsFetcher`),这里按名册建表,只交一份不点名的宿主依赖
 * (服务商自述试点 P2 第 4 批;从前这里按枚举值手列 Copilot 与 Codex 两家)。
 */
function endpointModelsFetchers(
  getModelsForProvider: (providerId: string) => Promise<OpenRouterModel[]>,
): Record<string, OnethingEndpointModelsFetcher> {
  const deps: VendorModelsFetcherDeps = {
    getModelsForProvider: getModelsForProvider as VendorModelsFetcherDeps['getModelsForProvider'],
    saveProviderModels: (providerId, models) =>
      modelRegistry.saveProviderModels(providerId, models as OpenRouterModel[]),
    configuredSelection: (providerId) =>
      getSettings()?.ai?.providers?.[providerId] as OnethingConfiguredModelSelection | undefined,
    getToken: (providerId) => authService.getToken(providerId),
    refreshTokenIfNeeded: (providerId) =>
      authService.refreshTokenIfNeeded(providerId) as ReturnType<VendorModelsFetcherDeps['refreshTokenIfNeeded']>,
    fetch: (policy) => createPolicyFetch(policy),
    logger: consoleLog,
  }
  const fetchers: Record<string, OnethingEndpointModelsFetcher> = {}
  for (const vendor of VENDOR_RUNTIMES) {
    if (vendor.createModelsFetcher) fetchers[vendor.id] = vendor.createModelsFetcher(deps)
  }
  return fetchers
}

/**
 * 「这一型的思考能提供几档」—— 目录行上那四格的**唯一填法**(2026-09-05)。
 *
 * 判据一格都不在这里:滤 `'none'`、缺席 profile 读作「不思考」全在
 * `projectOnethingThinkingLevels`(产品层,profile 隔壁)。这一层只做装配层才知道
 * 的那一件事 —— 把设置里的 override / 目录条目喂给能力裁定,与
 * `getModelCapabilities` 下面那段「不解析凭据」同一手:**一次网络都不打**。
 */
function modelProviderConfig(providerId: string, spaceId?: string) {
  // 覆盖表住在 per-space 的 providers.json:缺席 = 默认空间(与 `getSettings()` 同一份)。
  const ai = (spaceId ? getSpaceSettings(spaceId) : getSettings())?.ai
  const custom = ai?.customProviders?.find(provider => provider.id === providerId)
  const configured = ai?.providers?.[providerId]
  return (custom ? { ...custom, ...configured } : configured) as
    | (ProviderConfig & { apiType?: 'openai' | 'anthropic' })
    | undefined
}

function resolvedCapabilitiesOf(
  providerId: string,
  modelId: string,
  providerConfig: ReturnType<typeof modelProviderConfig>,
) {
  const apiType = providerConfig?.apiType
  return resolveOnethingModelCapabilities({
    providerId,
    modelId,
    providerReasoningProfile: (providerConfig as ProviderConfig & { providerOptions?: OnethingProviderOptions })?.providerOptions?.reasoningProfile,
    ...(apiType === 'openai' || apiType === 'anthropic' ? { customApiType: apiType } : {}),
    ...(providerConfig?.modelCapabilitiesByModel?.[modelId]
      ? { override: providerConfig.modelCapabilitiesByModel[modelId] }
      : {}),
    // 手填条目什么都没说过(批 2):`catalogFactsOf` 对它答 undefined,与「目录里没有」同读法。
    ...(catalogFactsOf(providerConfig?.models?.[modelId])
      ? { registryEntry: catalogFactsOf(providerConfig?.models?.[modelId]) }
      : {}),
  })
}

function thinkingProjectionOf(
  providerId: string,
  modelId: string,
  providerConfig = modelProviderConfig(providerId),
) {
  return projectOnethingThinkingLevels(resolvedCapabilitiesOf(providerId, modelId, providerConfig).reasoningProfile)
}

/**
 * 目录行 → 它的目录条目。目录里存着的那一条优先(它带着真的出处);列表口现取、
 * 不落目录的那几家(Copilot 现取、兜底表)从行本身反推一条 —— 出处照行上声明的:
 * `'endpoint'` 就是 endpoint,`'manual'` 是手填,缺席读作 models.dev(与信封同一口径)。
 */
function catalogEntryOfRow(
  providerId: string,
  model: OpenRouterModel,
  catalog: Readonly<Record<string, OnethingCatalogModelEntry>>,
): OnethingCatalogModelEntry {
  const stored = catalog[model.id]
  // 折孤儿只在内存里把「勾了但目录不认识」认作手填;列表口却交出了一条有参数的行
  // (Copilot 现取、兜底表)时,信那一行。
  if (stored && (!isOnethingManualModelEntry(stored) || model.source === 'manual')) return stored
  if (model.source === 'manual') return createOnethingManualModelEntry(providerId, model.id)
  const derived = openRouterModelToOnethingCapabilityEntry(model as OnethingOpenRouterModel, providerId)
  if (model.source === 'endpoint') return derived
  const { source: _endpoint, ...rest } = derived
  return rest
}

/**
 * 一行的 `effective`(§5.5):「覆盖 > 接口 / 目录 > 不知道」只在这里、经
 * `effectiveModelFactsOf` 算一次 —— 引擎的 `getOnethingModelContextLength` 读的是同一个
 * 判据。壳只读结果,不再自己折(09-10 圆环 unknown 事故)。
 */
function effectiveOfRow(
  providerId: string,
  model: OpenRouterModel,
  config: ReturnType<typeof modelProviderConfig>,
  catalog: Readonly<Record<string, OnethingCatalogModelEntry>>,
  reasoningProfile: ReturnType<typeof resolvedCapabilitiesOf>['reasoningProfile'],
): ModelEffectiveFacts {
  return effectiveModelFactsOf<ReasoningProfileOverride>({
    override: onethingModelOverrideFactsOf(config, model.id),
    entry: catalogEntryOfRow(providerId, model, catalog),
    reasoningProfile: (reasoningProfile ?? null) as ReasoningProfileOverride | null,
  })
}

/**
 * 目录一整家逐行盖上思考那四格与 `effective`。**加性**:原对象一格不改,只多几个键
 * —— 旧信封那几格(`context_length` …)仍是目录自己说的那一份,行上「目录原值」读它。
 *
 * 批 2 起这里不再拼「勾了但目录不认识」的孤儿 —— 手填是目录里的一条 `source:'manual'`
 * 条目。只补一种行:**目录里有、但这一家的列表口没交出来**的手填条目 —— 盘上还没落的
 * 老孤儿(`foldedCatalogFor` 在内存里折的),以及列表不读目录的那几家(Copilot 现取、
 * ACP 读名册)上用户手填的 id。
 */
async function withProjections(
  providerId: string,
  models: readonly OpenRouterModel[],
  spaceId?: string,
): Promise<OpenRouterModel[]> {
  const config = modelProviderConfig(providerId, spaceId)
  const catalog = foldedCatalogFor(providerId)
  const listed = new Set(models.map(model => model.id))
  const all = [...models]
  for (const entry of Object.values(catalog)) {
    if (!isOnethingManualModelEntry(entry) || listed.has(entry.id)) continue
    all.push(onethingCapabilityEntryToOpenRouterModel(entry) as OpenRouterModel)
  }
  const rows = all.map((model) => {
    // 思考四格与 `effective.reasoningProfile` 是同一次能力裁定的两种读法 —— 裁一次。
    const { reasoningProfile } = resolvedCapabilitiesOf(providerId, model.id, config)
    return {
      ...model,
      ...projectOnethingThinkingLevels(reasoningProfile),
      effective: effectiveOfRow(providerId, model, config, catalog, reasoningProfile),
    }
  })
  // 建议只给「谁都没说」的格:整张表一格 unknown 都没有(models.dev 家的常态)就连
  // 索引都不碰 —— 认亲是给转发站 / 手填准备的,不该让 300 行的 OpenRouter 目录白算一遍。
  if (!rows.some(row => hasSuggestionGap(row.effective))) return rows
  const index = await suggestionIndex()
  if (!index) return rows
  return rows.map((row) => {
    const suggestion = suggestionOfRow(row, index, config)
    return suggestion ? { ...row, suggestion } : row
  })
}

/* ── 参数建议(批 3 §6.3)─────────────────────────────────────────────────── */

/** 能力五格里 unknown 的那几格(建议只填它们)。 */
function capabilityGaps(effective: ModelEffectiveFacts) {
  return Object.fromEntries(
    MODEL_SUGGESTION_CAPABILITY_KEYS.map(key => [key, effective.source.capabilities[key] === 'unknown']),
  ) as Record<(typeof MODEL_SUGGESTION_CAPABILITY_KEYS)[number], boolean>
}

function hasSuggestionGap(effective: ModelEffectiveFacts): boolean {
  return (
    effective.source.contextLength === 'unknown' ||
    effective.source.maxOutput === 'unknown' ||
    Object.values(capabilityGaps(effective)).some(Boolean)
  )
}

async function suggestionIndex(): Promise<ModelIdentityIndex | undefined> {
  const snapshot = await modelRegistry.getModelsDevSnapshot()
  return snapshot ? modelIdentityIndexOf(snapshot) : undefined
}

/**
 * 一行的建议。三格数 / 能力只在 unknown 时给(判据在 `modelParameterSuggestionOf`);
 * 思考档位只在「用户没覆盖、能力账本也没裁出档位、而认出来的那一型会思考」时给 ——
 * 用那一型在它自己那一家下的能力裁定算,与目录行上那四格同一个判据。
 */
function suggestionOfRow(
  row: OpenRouterModel & { effective: ModelEffectiveFacts },
  index: ModelIdentityIndex,
  config: ReturnType<typeof modelProviderConfig>,
): ModelParameterSuggestion | undefined {
  const found = modelParameterSuggestionOf({
    modelId: row.id,
    index,
    gaps: {
      contextLength: row.effective.source.contextLength === 'unknown',
      maxOutput: row.effective.source.maxOutput === 'unknown',
      capabilities: capabilityGaps(row.effective),
    },
  })
  if (!found) return undefined
  const suggestion: ModelParameterSuggestion = { ...found.suggestion }
  const overridden = config?.modelCapabilitiesByModel?.[row.id]?.reasoningProfile !== undefined
  if (!overridden && row.effective.reasoningProfile === null && found.model.reasoning === true) {
    const twinProviderId = ONETHING_PROVIDER_MAPPING[found.twin.twin.provider] ?? found.twin.twin.provider
    const profile = resolveOnethingModelCapabilities({
      providerId: twinProviderId,
      modelId: found.twin.twin.id,
      registryEntry: modelsDevModelToOnethingCapabilityEntry(found.model, twinProviderId),
    }).reasoningProfile
    if (profile) suggestion.reasoningProfile = profile as unknown as ReasoningProfileOverride
  }
  return suggestion
}

export const modelsRpcHandlers: RouteHandlers<ModelsRoutes> = {
  async getWithCapabilities(request) {
    const getModelsForProvider = (providerId: string) =>
      modelRegistry.getModelsForProvider(providerId) as Promise<OpenRouterModel[]>
    const getOnethingModelsWithCapabilitiesAdapters: GetOnethingModelsWithCapabilitiesAdapters = {
      getModelsForProvider,
      // 调度按 manifest 的 `models.kind`(批 M):`endpoint` 查这张按 id 登记的拉取器表,
      // `roster` 读名册,其余走通用路。加一家带列表口的服务商 = 那一家 `runtime.ts` 的
      // `createModelsFetcher` 一格(这张表按服务商名册建)。
      endpointFetchers: endpointModelsFetchers(getModelsForProvider),
      // A1-a:ACP 的「模型」= 名册的生效配置(种子 ⊕ 注册表 ⊕ 用户覆盖),不是设置原样 ——
      // 否则种子来的 agent 永远不出现在选择器里。没有装配好的 backend(单测)退回设置。
      getRoster: () => getCurrentBackendInstance()?.acp.modelAgents() ?? getSettings()?.acp?.agents,
      // 刷新钮对通用厂商的真动作(2026-09-11):重拉 models.dev 落盘,随后
      // `getModelsForProvider` 读到的是新表。挂在这里而不是壳里 —— 壳那一头
      // (`forceRefresh: true`)本来就对,断的是后端这一截。
      // `endpoint` 家(自定义服务商)的直连拉取按**请求的那个空间**取接口地址 / 头 / 密钥。
      refreshProviderModels: providerId =>
        modelRegistry.refreshProviderModels(providerId, { spaceId: request?.spaceId }),
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
    return { ...result, models: await withProjections(providerId, result.models ?? [], request?.spaceId) }
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
  /** 手填 = 一条 `source:'manual'` 的目录条目 + 这个空间里勾上(批 2)。判据在产品层纯函数里。 */
  async addManual(request) {
    return addManualModel(request)
  },
  async removeManual(request) {
    return removeManualModel(request)
  },
  async getDisplayName(request) {
    return getOnethingModelRegistryDisplayNameForIpc({
      modelId: request?.modelId ?? '',
      getModelDisplayName: modelId => modelRegistry.getModelDisplayName(modelId),
      logger: consoleLog,
    })
  },
}
