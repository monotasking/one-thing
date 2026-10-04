// 上下文预算(从 `agent-loop-runtime.ts` 拆出,拆分批 1,D226):按模型窗口与服务商报回来的用量,
// 算这一回合能用多少输入 token、请求的 max_tokens 夹到多少。
import type { CoreCompactSession } from './agent-loop-context-compact.js'
import { resolveCompactOutputTokens } from './agent-loop-context-compact-sizing.js'
import type { CoreAgentLoopProviderConfig } from './agent-loop-runtime-preparation.js'

export interface CoreAgentLoopContextBudget {
  modelContextLength: number
  /**
   * 这一轮打算要多少输出 token。**缺席 = 这个模型的输出上限没人知道,于是
   * 不传 `max_tokens`**(2026-09-09 用户裁定,事故:目录里没有的
   * `deepseek-v4.1-flash-expires-on-0910` 被编造成 4096、对半成 2048,
   * reasoning 吃光后 `length` 收场)。
   *
   * 「知道」只有两个来源:模型目录里有这一条,或用户在
   * `providers[p].maxOutputByModel[model]` 里自己写了。两者都没有就是不知道
   * —— 不许在任何读者处补一个默认数,让 provider 自己说它的默认值是多少。
   */
  reservedOutputTokens?: number
  thresholdPercent: number
}

export interface CoreAgentLoopModelLimits {
  maxInputTokens?: number
  maxOutputTokens?: number
}

export interface ResolveAgentLoopContextBudgetOptions {
  capabilities?: CoreAgentLoopModelLimits
  providerId: string
  providerConfig: CoreAgentLoopProviderConfig
  contextCompactThreshold?: number
  resolveModelContextLength?: (model: string, providerId: string) => number | undefined | Promise<number | undefined>
  resolveModelMaxOutputTokens?: (model: string, providerId: string) => number | undefined | Promise<number | undefined>
}

export interface CoreAgentLoopContextBudgetResolution {
  budget: CoreAgentLoopContextBudget
  error?: unknown
}

export function positiveTokenLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

export function resolveAgentLoopContextBudgetValues(input: {
  capabilities?: CoreAgentLoopModelLimits
  registeredModelContextLength?: number
  registeredModelMaxOutputTokens?: number
  providerConfig: CoreAgentLoopProviderConfig
  contextCompactThreshold?: number
}): CoreAgentLoopContextBudget {
  const modelContextLength = positiveTokenLimit(input.capabilities?.maxInputTokens)
    ?? positiveTokenLimit(input.registeredModelContextLength)
    ?? 128000
  // 上限未知就是 undefined,**不再 `?? 0`**(2026-09-09 裁定):0 会一路走到
  // 「替模型编一个数」那条岔路上,而那正是 4096 的老产地。
  const modelMaxOutputTokens = positiveTokenLimit(input.capabilities?.maxOutputTokens)
    ?? positiveTokenLimit(input.registeredModelMaxOutputTokens)
  const perModelOverride = positiveTokenLimit(
    input.providerConfig.maxOutputByModel?.[input.providerConfig.model],
  )
  const halfDefault = modelMaxOutputTokens !== undefined
    ? Math.max(1, Math.floor(modelMaxOutputTokens / 2))
    : undefined
  // 已知上限时的行为一字不变:用户覆盖优先,否则对半,再按上限夹。
  // 上限未知且无覆盖 = undefined = 不传 max_tokens(2026-09-09 裁定:请求侧
  // 只认这两个来源,全局设置那一格已退役)。
  const requested = perModelOverride ?? halfDefault
  const reservedOutputTokens = modelMaxOutputTokens !== undefined
    ? Math.min(requested ?? modelMaxOutputTokens, modelMaxOutputTokens)
    : requested

  return {
    modelContextLength,
    reservedOutputTokens,
    thresholdPercent: input.contextCompactThreshold ?? 85,
  }
}

/**
 * 发请求那一刻的第二道夹(2026-09-08 事故的聊天侧同病):
 * `resolveAgentLoopContextBudgetValues` 只按「注册上限的一半」算预留量,它不看
 * 这一轮真的塞了多少输入 —— 窗口 1048576 的模型上,384000 的一半 192000 加上
 * 701297 的输入照样越窗。所以在把 `maxTokens` 交给 provider 之前,用压缩侧
 * **同一个纯函数**按当前输入 token 再夹一次。
 *
 * 输入读数用 `buildContextUsageSnapshot` 的 `providerInputTokens` 口径
 * (= max(contextSize, lastInputTokens),provider 上一次自己报的数)。
 * **触发判定一字不碰** —— 压缩只认百分比(2026-08-23 裁定),这里改的只是
 * 请求参数。
 *
 * 夹不出结果(注册上限未知 / 窗口已被输入吃满)就原样返回预留量:本函数只
 * 负责往下夹,不负责编一个更大的数,也不负责替调用方决定塞不下时怎么办。
 *
 * 预留量本身缺席(= 输出上限没人知道,2026-09-09 裁定)就回 `undefined`:
 * 不知道上限时**不**拿窗口余量另造一个数,这与 `resolveCompactOutputTokens`
 * 对未注册模型回 undefined 是同一条(2026-08-15)。
 */
export function clampAgentLoopRequestMaxTokens(input: {
  budget: CoreAgentLoopContextBudget
  providerInputTokens: number
}): number | undefined {
  const reserved = input.budget.reservedOutputTokens
  if (reserved === undefined) return undefined
  const clamped = resolveCompactOutputTokens({
    modelContextLength: input.budget.modelContextLength,
    registeredMaxOutputTokens: reserved,
    inputTokens: input.providerInputTokens,
  })
  return clamped ?? reserved
}

/** `buildContextUsageSnapshot` 的 providerInputTokens 口径,单独拿出来复用。 */
export function providerReportedInputTokens(
  session: Pick<CoreCompactSession, 'contextSize' | 'lastInputTokens'> | null | undefined,
): number {
  return Math.max(
    0,
    Math.floor(session?.contextSize ?? 0),
    Math.floor(session?.lastInputTokens ?? 0),
  )
}

export async function resolveAgentLoopContextBudgetWithRegistry(
  options: ResolveAgentLoopContextBudgetOptions,
): Promise<CoreAgentLoopContextBudgetResolution> {
  // 解析出错 = 我们没问出这个模型的上限,那就是不知道:`reservedOutputTokens`
  // 缺席(2026-09-09 裁定),别在兜底里偷偷塞回 4096。
  const fallbackBudget: CoreAgentLoopContextBudget = {
    modelContextLength: positiveTokenLimit(options.capabilities?.maxInputTokens) ?? 128000,
    thresholdPercent: options.contextCompactThreshold ?? 85,
  }

  try {
    const registeredModelContextLength = positiveTokenLimit(options.capabilities?.maxInputTokens)
      ?? positiveTokenLimit(await options.resolveModelContextLength?.(
        options.providerConfig.model,
        options.providerId,
      ))
    const registeredModelMaxOutputTokens = positiveTokenLimit(options.capabilities?.maxOutputTokens)
      ?? positiveTokenLimit(await options.resolveModelMaxOutputTokens?.(
        options.providerConfig.model,
        options.providerId,
      ))

    return {
      budget: resolveAgentLoopContextBudgetValues({
        capabilities: options.capabilities,
        registeredModelContextLength,
        registeredModelMaxOutputTokens,
        providerConfig: options.providerConfig,
        contextCompactThreshold: options.contextCompactThreshold,
      }),
    }
  } catch (error) {
    return { budget: fallbackBudget, error }
  }
}
