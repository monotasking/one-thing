import type { OpenRouterModel } from '@shared/ipc/providers'

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
export function openRouterModel(id: string, contextLength: number): OpenRouterModel {
  return {
    id,
    name: id,
    context_length: contextLength,
    architecture: { modality: '', input_modalities: [], output_modalities: [], tokenizer: '' },
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    top_provider: { context_length: 0, max_completion_tokens: 0, is_moderated: false },
    supported_parameters: [],
  } as unknown as OpenRouterModel
}
