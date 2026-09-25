/**
 * `provider-data` 在消息上怎么落,按**数据标签**(`providerData.provider`,即方言的
 * `providerDataTag`)自述 —— 批 M:从前 `provider-data.ts` 里写着三处「是不是 codex」。
 *
 * 由各家的方言模块在加载时登记(`dialects/codex.ts`);`provider-data.ts` 只读这张表,
 * 一个标签名都不认识。没登记的标签 = 通用行为:每一条都落成一格 `provider-data`。
 *
 * 叶子模块,零依赖 —— 方言与 `provider-data.ts` 都 import 它,不成环。
 */
export interface OnethingProviderDataTagPolicy {
  /**
   * 生图之外只留**加密思维链**一种(其余这家的 provider-data 都是瞬态,不上消息),
   * 并且由产品层自己落格,不交回 core 的缺省计划。
   */
  persistOnlyEncryptedReasoning?: boolean
  /** 老消息上散装的 `part.encryptedReasoning` 字段按这个标签还原成 provider-data。 */
  legacyEncryptedReasoningField?: boolean
}

const policies = new Map<string, OnethingProviderDataTagPolicy>()

export function registerProviderDataTagPolicy(
  tag: string,
  policy: OnethingProviderDataTagPolicy,
): () => void {
  policies.set(tag, policy)
  return () => {
    if (policies.get(tag) === policy) policies.delete(tag)
  }
}

export function providerDataTagPolicy(tag: unknown): OnethingProviderDataTagPolicy | undefined {
  return typeof tag === 'string' ? policies.get(tag) : undefined
}
