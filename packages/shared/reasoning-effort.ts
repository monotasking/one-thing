/**
 * 思考档位的**梯子**与「这一型没有你要的那一档时落到哪一档」的读法(服务商自述试点 P4)。
 *
 * 从 runtime `providers/model-capability.ts` 搬来,函数体逐字未改:后端算有效档位要它,壳在
 * 模型选择器上写「GPT-5.5 · 高」也要它,而壳不许 import runtime 的服务商代码。它不认识任何
 * 一家服务商、任何一张型号规则表 —— 只是一条固定的六档梯子上「就近取一档」的算法,所以放在
 * `@shared`(纯模块,零 import,壳的浏览器包也吃)。runtime 那边以原名
 * `resolveOnethingReasoningEffort` 再导出,调用点一个不动。
 *
 * 不放 `@shared/contracts/`:那里只收形状、不收函数(边界门)。
 */

export type ReasoningEffortLevel =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** 梯子本身,低到高。「就近」按这个顺序算。 */
export const REASONING_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const REASONING_LEVELS = REASONING_EFFORT_LEVELS

/**
 * 要 `effort`、这一型只给 `allowed`:给得出就是它;给不出就从它往下找最近的一档,再往上找;
 * 都没有(或 `effort` 根本不是一档)就退回 `fallback`。
 */
export function resolveReasoningEffort(effort: string | undefined, allowed: readonly string[], fallback: ReasoningEffortLevel): ReasoningEffortLevel {
  const levels = allowed.filter((level): level is ReasoningEffortLevel => REASONING_LEVELS.includes(level as ReasoningEffortLevel))
  const requested = REASONING_LEVELS.includes(effort as ReasoningEffortLevel) ? effort as ReasoningEffortLevel : fallback
  if (levels.includes(requested)) return requested
  const index = REASONING_LEVELS.indexOf(requested)
  return [...REASONING_LEVELS.slice(0, index).reverse(), ...REASONING_LEVELS.slice(index + 1)].find(level => levels.includes(level)) ?? fallback
}
