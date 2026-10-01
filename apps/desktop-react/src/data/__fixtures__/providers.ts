import type { ProviderInfo } from '@shared/ipc/providers'
import { BUILTIN_PROVIDER_MANIFESTS } from '@onething/runtime/providers/builtin-manifests'
import { providerInfoOfManifest } from '@onething/runtime/providers/builtin-providers'

/**
 * 「后端下发的那一份」服务商名册 —— 只给测试用的夹具(服务商自述试点 P4)。
 *
 * P4 起壳不再 import runtime 的服务商代码:档位(`dials`)、有没有余额源(`hasQuota`)、
 * 家族(`family`)都随 `providers.getProviders` 的 `ProviderInfo` 下发。用例要演「后端交下来
 * 什么」,最诚实的做法是跑**产品层那一个**投影(`providerInfoOfManifest`,RPC 发出去的就是它),
 * 而不是在测试里手抄一份档位地址表或家族表 —— 手抄的会漂。所以这里是全壳唯一 import
 * runtime 服务商代码的地方之一,边界门(`checkClientImportsOnlySharedAndClient`,并入了 P4 那条)只放过
 * 测试与 `__fixtures__`,理由同此。
 */

/** 内置一家的那一条(与 RPC 下发的逐字同形)。认不出的 id 抛 —— 夹具写错了要当场红。 */
export function servedProviderInfo(id: string): ProviderInfo {
  const manifest = BUILTIN_PROVIDER_MANIFESTS.find((entry) => entry.id === id)
  if (!manifest) throw new Error(`no builtin provider manifest: ${id}`)
  return providerInfoOfManifest(manifest) as ProviderInfo
}

/**
 * 只取 P4 下发的那三格(有才出现)。给手搭 `ProviderInfo` 的用例盖上去:名字、端点这些
 * 用例自己定,服务商自述的那三格照后端的来。
 */
export function servedProviderFacts(id: string): Pick<ProviderInfo, 'dials' | 'hasQuota' | 'family'> {
  const manifest = BUILTIN_PROVIDER_MANIFESTS.find((entry) => entry.id === id)
  if (!manifest) return {}
  const { dials, hasQuota, family } = servedProviderInfo(id)
  return {
    ...(dials ? { dials } : {}),
    ...(hasQuota ? { hasQuota } : {}),
    ...(family ? { family } : {}),
  }
}

/** 内置名册全体(名册顺序)。 */
export function servedProviderRoster(): ProviderInfo[] {
  return BUILTIN_PROVIDER_MANIFESTS.map((manifest) => providerInfoOfManifest(manifest) as ProviderInfo)
}
