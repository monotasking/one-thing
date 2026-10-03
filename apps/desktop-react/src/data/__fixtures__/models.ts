import type { ModelEffectiveFacts, OpenRouterModel, ProviderConfig } from '@shared/ipc/providers'
import {
  effectiveModelFactsOf,
  onethingModelOverrideFactsOf,
} from '@onething/backend/provider'
import type { CatalogModel, ModelOption, ProviderModelPrefs } from '../models-source'

/**
 * 目录里的一条 —— 只给测试用的那份夹具。
 *
 * 批 7b 把模型目录合并到 `providers/catalog-query.ts` 那一族之后,想在用例里
 * 摆一份现成的目录就得摆**线上形状**(整份 `OpenRouterModel`),而不是从前那份
 * 窄投影 `{id, contextLength}`。三个用例文件各造一遍这份样板,就是三处会漂 ——
 * 所以造在这里一次。
 *
 * 只填这套壳真正读的那几格(id / name / context_length),其余按契约补齐空值。
 */
export function openRouterModel(
  id: string,
  contextLength: number,
  /** 思考四格与价格按需盖上去 —— 缺席就是「后端没投过」,与真机上旧缓存同形。 */
  extra: Partial<OpenRouterModel> = {},
): OpenRouterModel {
  return {
    id,
    name: id,
    context_length: contextLength,
    architecture: { modality: '', input_modalities: [], output_modalities: [], tokenizer: '' },
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    top_provider: { context_length: 0, max_completion_tokens: 0, is_moderated: false },
    supported_parameters: [],
    ...extra,
  } as unknown as OpenRouterModel
}

/**
 * 目录**投影之后**那一条(`CatalogModel`)。09-05 庚 给它添了价格与思考四格,
 * 于是「手写一个 `{id, contextLength}`」在类型上不再成立 —— 用例关心的只有一两格,
 * 其余按「不知道」补齐。补齐的口径与 `models-source.UNKNOWN_MODEL_READINGS`
 * 逐字相同(不知道就不画,不编)。
 */
export function catalogModel(
  id: string,
  contextLength: number | null,
  extra: Partial<Omit<CatalogModel, 'id' | 'contextLength'>> = {},
): CatalogModel {
  return {
    id,
    contextLength,
    pricing: null,
    thinkingLevels: null,
    thinkingToggleable: false,
    thinkingDefaultOn: false,
    thinkingDefaultLevel: null,
    ...extra,
  }
}

/** 抽屉里的一行。与 `catalogModel` 同一份补齐,只是身份那一格叫 `model`。 */
export function modelOption(
  model: string,
  contextLength: number | null,
  extra: Partial<Omit<ModelOption, 'model' | 'contextLength'>> = {},
): ModelOption {
  const { id: _id, ...readings } = catalogModel(model, contextLength, extra)
  return { model, ...readings }
}

/**
 * 设置的窄投影里一家的那几格。两张按模型的表缺席 = 没设过(思考开关 / 思考档)。
 * 窗口 / 最大输出覆盖不在这里:它们由后端折进目录每行的 `effective`(§5.5)。
 */
export function providerModelPrefs(partial: Partial<ProviderModelPrefs> = {}): ProviderModelPrefs {
  return {
    selectedModels: [],
    model: '',
    thinking: {},
    thinkingEffort: {},
    ...partial,
  }
}

/**
 * 目录条目的形状,取自产品层那一个判据的参数类型 —— 不再单独 import runtime 的类型
 * (服务商自述试点 P4:壳侧只有测试夹具还碰 runtime 的服务商代码,碰的是下面那一个函数)。
 */
type CatalogEntry = NonNullable<Parameters<typeof effectiveModelFactsOf>[0]['entry']>

/** 旧信封 → 目录条目(与后端 `openRouterModelToOnethingCapabilityEntry` 同读法,只取判据要的几格)。 */
function entryOfEnvelope(model: OpenRouterModel): CatalogEntry {
  if (model.source === 'manual') return { id: model.id, name: model.name, provider: 'fixture', source: 'manual' }
  const input = model.architecture?.input_modalities ?? []
  const output = model.architecture?.output_modalities ?? []
  const params = model.supported_parameters ?? []
  return {
    id: model.id,
    name: model.name,
    provider: 'fixture',
    ...(model.source === 'endpoint' ? { source: 'endpoint' as const } : {}),
    contextLength: model.context_length || model.top_provider?.context_length || 0,
    maxOutputTokens: model.top_provider?.max_completion_tokens || 0,
    supportsTools: params.includes('tools'),
    supportsVision: input.includes('image'),
    supportsReasoning: params.includes('reasoning'),
    supportsImageOutput: output.includes('image'),
    supportsTemperature: true,
    inputModalities: input,
    outputModalities: output,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/**
 * 「后端交下来的那一份」:给每行盖上 `effective`,判据用的是**产品层那一个**
 * (`effectiveModelFactsOf`,`models.getWithCapabilities` 与引擎读的同一个),覆盖从
 * 这一家的设置里取。用例据此验「壳只读后端折好的结果」,而不是在壳里再折一遍。
 * 这也是这份夹具 import runtime 的理由:它演的是后端,抄一份折法就会漂 —— 边界门
 * (`checkClientImportsOnlySharedAndClient`,并入了 P4 那条)只放过测试与 `__fixtures__`。
 */
export function servedByBackend(
  models: readonly OpenRouterModel[],
  config?: Partial<ProviderConfig>,
): OpenRouterModel[] {
  return models.map((model) => ({
    ...model,
    effective: effectiveModelFactsOf({
      override: onethingModelOverrideFactsOf(config, model.id),
      entry: entryOfEnvelope(model),
    }) as ModelEffectiveFacts,
  }))
}
