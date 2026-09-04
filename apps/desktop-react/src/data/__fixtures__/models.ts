import type { OpenRouterModel } from '@shared/ipc/providers'
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

/** 设置的窄投影里一家的那几格。思考两张表缺席 = 没设过。 */
export function providerModelPrefs(partial: Partial<ProviderModelPrefs> = {}): ProviderModelPrefs {
  return { selectedModels: [], model: '', thinking: {}, thinkingEffort: {}, ...partial }
}
