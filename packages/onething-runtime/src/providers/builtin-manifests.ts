/**
 * 内置 manifest 的装配处(批 M,`docs/design/provider-settings-rework-2026-09.md` §5.2;
 * 服务商自述试点 P1,`docs/design/architecture-direction-2026-10.md` §4)。
 *
 * 各家的字面量住在自己的 `vendors/<id>/manifest.ts`,名册是 `vendors/manifests.ts`。
 * 这里只做两件事:补上同家的另一半(读 `@shared` 的家族表),再接上 `acp` 这一条 ——
 * 它不是一家服务商,是外部执行体那条路的占位。
 *
 * 本文件是**纯**模块(壳也 import 它):不许 import 碰 `process` 的模块。
 *
 * `name` 今天是字面(不走字典);`description` 是字典键 `providers.desc.<id>`,
 * 壳按键查 zh / en 字典显示。
 */
import type { ProviderManifest } from './manifest.js'
import { VENDOR_MANIFESTS } from './vendors/manifests.js'
import { providerFamilyOf } from '@shared/provider-families.js'

/**
 * 外部执行体(ACP / Claude Code Agent)的「方言」:没有线协议,provider 由执行器注册表建。
 * 住在这里而不是 `manifest.ts`:那边 import 这张表,常量放那边会成环。
 */
export const EXTERNAL_AGENT_DIALECT_ID = 'external-agent'

const ACP_MANIFEST: ProviderManifest = {
  id: 'acp',
  origin: 'builtin',
  name: 'ACP Agents',
  description: 'providers.desc.acp',
  icon: 'acp',
  dialect: EXTERNAL_AGENT_DIALECT_ID,
  auth: { kind: 'none' },
  models: { kind: 'roster' },
  billing: 'api',
  modelRules: 'acp',
  defaultBaseUrl: '',
  supportsCustomBaseUrl: false,
  defaultModel: 'claude-code',
}

const BUILTIN_LITERALS: readonly ProviderManifest[] = [...VENDOR_MANIFESTS, ACP_MANIFEST]

/**
 * 同家的另一半(`sibling` / `familyTag`)**不写在上面的字面量里**,而是读
 * `@shared/provider-families` 的家族表补上:那张表还要喂 `@onething/client` 与后端发送路的
 * `isProviderEnabledIn`(家族读法),而 `@shared` 契约不许反向依赖 runtime(边界门
 * 「shared contracts depend on a product/backend implementation」)。所以家族这一格的产地
 * 在 `@shared`,manifest 读它;别处一律读 manifest 的 `sibling`,不再各自查家族表。
 */
function withFamily(manifest: ProviderManifest): ProviderManifest {
  const family = providerFamilyOf(manifest.id)
  if (!family) return manifest
  const isSubscription = family.subscriptionProviderId === manifest.id
  return {
    ...manifest,
    sibling: isSubscription ? family.apiProviderId : family.subscriptionProviderId,
    ...(isSubscription ? { familyTag: family.subscriptionTag } : {}),
  }
}

export const BUILTIN_PROVIDER_MANIFESTS: readonly ProviderManifest[] = BUILTIN_LITERALS.map(withFamily)

/** 壳用:只查内置表,不经进程注册表(那里还有自定义的)。 */
export function getBuiltinProviderManifest(id: string | undefined | null): ProviderManifest | undefined {
  return id ? BUILTIN_PROVIDER_MANIFESTS.find((manifest) => manifest.id === id) : undefined
}
