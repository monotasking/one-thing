/**
 * 「这次请求发往哪个地址」的通用一半(`docs/design/architecture-direction-2026-10.md` §4 P1)。
 *
 * 有档位的家(按量 / 套餐 / 地区决定地址)把自己那一半写在 `vendors/<id>/` 的
 * `manifest.endpoint.resolveBaseUrl` 里;这里只问那一格,不认识任何一家。没有那一格的家
 * (包括自定义服务商)地址就是配置里的 `baseUrl`。
 *
 * 纯模块:壳也会经 manifest 链走到这里。
 */
import { normalizeProviderBaseUrl } from './base-url.js'
import { getProviderManifest } from './manifest.js'

export { normalizeProviderBaseUrl }

export function resolveOnethingProviderBaseUrl(
  providerId: string,
  config: object | undefined,
): string | undefined {
  const fields = config as Record<string, unknown> | undefined
  const resolve = getProviderManifest(providerId)?.endpoint?.resolveBaseUrl
  if (resolve) return resolve(fields)
  return normalizeProviderBaseUrl(fields?.baseUrl) || undefined
}
