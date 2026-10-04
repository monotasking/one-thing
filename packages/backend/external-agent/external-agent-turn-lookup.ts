/**
 * 「这条执行会话此刻在跑哪一轮、手里那张牌是哪张」—— 由装配填进来的端口(越层清零 A5③,2026-10-04)。
 *
 * 从前这里直接 import 协作 v3 的回合登记簿(`findCollabV3Turn`),外部 agent 因此认识协作。现在
 * `backend-assemble-engine.ts` 造引擎时填这一格(与它给协作填的那几个引擎端口同一处)。
 * 没填 = `undefined`,与「非 v3 路径取不到牌」走同一个分支 —— 取不到牌本来就不是拒绝的理由。
 */
export interface ExternalAgentTurnLookupResult {
  roomSessionId?: string
  leaseId?: string
}
export type ExternalAgentTurnLookup = (execSessionId: string) => ExternalAgentTurnLookupResult | undefined

const turnLookup: { find: ExternalAgentTurnLookup | undefined } = { find: undefined }

/** 幂等:同一个函数重复填即同一个结果;传 `undefined` 摘掉。 */
export function configureExternalAgentTurnLookup(find: ExternalAgentTurnLookup | undefined): void {
  turnLookup.find = find
}

/** 读端口;没填就是 `undefined`。 */
export function findExternalAgentTurn(execSessionId: string): ExternalAgentTurnLookupResult | undefined {
  return turnLookup.find?.(execSessionId)
}
