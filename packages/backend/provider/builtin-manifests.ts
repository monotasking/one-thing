/**
 * 内置 manifest 的装配处(批 M,`docs/design/provider-settings-rework-2026-09.md` §5.2;
 * 服务商自述试点 P1,`docs/design/architecture-direction-2026-10.md` §4)。
 *
 * 各家的字面量住在自己的 `vendors/<id>/manifest.ts`,名册是 `vendors/manifests.ts`。
 * 这里只做两件事:按名册的家族登记补上同家的另一半,再接上 `acp` 这一条 ——
 * 它不是一家服务商,是外部执行体那条路的占位。
 *
 * 本文件是**纯**模块:不许 import 碰 `process` 的模块。P4 起壳不再 import 它(壳读的是
 * 后端经 providers RPC 下发的 `ProviderInfo`)。
 *
 * `name` 今天是字面(不走字典);`description` 是字典键 `providers.desc.<id>`,
 * 壳按键查 zh / en 字典显示。
 */
import type { ProviderManifest } from './provider-manifest.js'
import { VENDOR_FAMILIES, VENDOR_MANIFESTS } from './vendors/manifests.js'
import {
  providerFamilyLookupOf,
  type ProviderFamilyInfo,
  type ProviderFamilyLookup,
} from '@shared/provider-families.js'

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
 * 名册的家族登记 → 每家的家族信息(`ProviderInfo.family` 下发的那一格)。
 *
 * 家族键 = API 那一半的 id,家名 = API 那一半的 `name`(四个家族今天的家名都恰好就是它,
 * `provider-families.equivalence.test.ts` 钉着),标签 = 订阅那一半自己声明的 `family.tag`。
 * 登记与半边的 `role` 对不上 = 名册写错了,模块加载时就抛,不让它悄悄拆成两家。
 */
function familyInfoById(): Map<string, ProviderFamilyInfo> {
  const byId = new Map<string, ProviderFamilyInfo>()
  for (const { api, subscription } of VENDOR_FAMILIES) {
    if (api.family?.role !== 'api' || subscription.family?.role !== 'subscription') {
      throw new Error(`provider family ${api.id} + ${subscription.id}: manifests must declare family.role api / subscription`)
    }
    const shared = { id: api.id, label: api.name }
    byId.set(api.id, { ...shared, role: 'api', sibling: subscription.id })
    const tag = subscription.family.tag
    byId.set(subscription.id, { ...shared, role: 'subscription', sibling: api.id, ...(tag ? { tag } : {}) })
  }
  return byId
}

const FAMILY_INFO = familyInfoById()

/** 这家的家族信息(不在任何家族里 = `undefined`)。 */
export function builtinProviderFamilyInfoOf(id: string): ProviderFamilyInfo | undefined {
  return FAMILY_INFO.get(id)
}

/**
 * 内置名册的家族查询 —— 后端发送路问 `isProviderEnabledIn` 时用它(壳用下发的名册)。
 * 与壳那一份同一个构造函数(`providerFamilyLookupOf`),只是输入从名册直接取。
 */
export const builtinProviderFamilyLookup: ProviderFamilyLookup = providerFamilyLookupOf(
  [...FAMILY_INFO].map(([id, family]) => ({ id, family })),
)

/** 同家的另一半(`sibling` / `familyTag`)补进 manifest。读者一律读这两格,不再各自查家族。 */
function withFamily(manifest: ProviderManifest): ProviderManifest {
  const family = FAMILY_INFO.get(manifest.id)
  if (!family?.sibling) return manifest
  return {
    ...manifest,
    sibling: family.sibling,
    ...(family.role === 'subscription' && family.tag ? { familyTag: family.tag } : {}),
  }
}

export const BUILTIN_PROVIDER_MANIFESTS: readonly ProviderManifest[] = BUILTIN_LITERALS.map(withFamily)

// 「只查内置表」的 `getBuiltinProviderManifest` 在 P4 删了:它唯一的产品读者是壳,而壳改读
// 下发的 `ProviderInfo`;别处查 manifest 走进程注册表(`manifest.ts` 的 `getProviderManifest`)。
