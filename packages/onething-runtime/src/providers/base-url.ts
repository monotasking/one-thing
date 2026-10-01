/**
 * 地址的归一:去空白、去结尾的 `/`。叶子模块(零 import)——
 * 各家 `vendors/<id>/endpoint.ts` 与通用的 `endpoint.ts` 用同一把尺,又不必经 manifest 注册表成环。
 */
export function normalizeProviderBaseUrl(value: unknown): string {
  return (typeof value === 'string' ? value : '').trim().replace(/\/+$/, '')
}
