/**
 * 家族表搬家的等价证据(服务商自述试点 P4)。
 *
 * P4 之前,「哪两家是一家」写在 `@shared/provider-families` 的 `PROVIDER_FAMILIES` 里,
 * `isProviderEnabledIn` 直接查那张表。P4 起家族由各家 manifest 自己声明(`family`),
 * runtime 由名册算出两半的对应,经 `ProviderInfo.family` 下发;`isProviderEnabledIn`
 * 改成**接收家族查询作参数**的纯函数。
 *
 * 旧表与旧函数已经从产品代码里删了,这里**逐字冻一份**当参照,证明:
 *  ① 名册算出来的家族与旧表逐行相等(id / 显示名 / 两半 / 订阅标签);
 *  ② 新写法(查询来自下发的 `ProviderInfo.family`)对一组代表性设置 —— 家族两半各自
 *     缺席 / 空配置 / 开 / 关,叠上空间覆盖的各种组合 —— 与旧写法逐个相等。
 */
import { describe, expect, it } from 'vitest'
import {
  isProviderEnabledIn,
  providerFamilyLookupOf,
  type ProviderEnabledOverride,
} from '@shared/provider-families.js'
import { builtinProviderFamilyLookup } from '../builtin-manifests.js'
import { onethingBaseBuiltinProviders } from '../builtin-providers.js'

/* ── 旧写法,逐字冻结(原件:packages/shared/provider-families.ts @ 0507b4090)──────────── */

interface OldProviderFamily {
  id: string
  label: string
  apiProviderId: string
  subscriptionProviderId: string
  subscriptionTag: string
}

const OLD_PROVIDER_FAMILIES: OldProviderFamily[] = [
  { id: 'grok', label: 'Grok', apiProviderId: 'grok', subscriptionProviderId: 'grok-oauth', subscriptionTag: 'Subscription' },
  { id: 'openai', label: 'OpenAI', apiProviderId: 'openai', subscriptionProviderId: 'codex', subscriptionTag: 'Codex' },
  { id: 'claude', label: 'Claude', apiProviderId: 'claude', subscriptionProviderId: 'claude-code', subscriptionTag: 'Claude Code' },
  { id: 'kimi', label: 'Kimi', apiProviderId: 'kimi', subscriptionProviderId: 'kimi-code', subscriptionTag: 'Kimi Code' },
]

function oldProviderFamilyOf(providerId: string): OldProviderFamily | null {
  return (
    OLD_PROVIDER_FAMILIES.find(
      (family) => family.apiProviderId === providerId || family.subscriptionProviderId === providerId,
    ) ?? null
  )
}

function oldIsProviderConfigEnabled(config?: { enabled?: boolean } | null): boolean {
  return config?.enabled !== false
}

function oldIsProviderEnabledIn(
  providers: Record<string, { enabled?: boolean } | undefined> | undefined | null,
  providerId: string,
  spaceOverride?: ProviderEnabledOverride,
): boolean {
  const enabledOf = (id: string): boolean => spaceOverride?.[id] ?? oldIsProviderConfigEnabled(providers?.[id])
  const own = enabledOf(providerId)
  const family = oldProviderFamilyOf(providerId)
  if (!family) return own
  const expressed = (id: string): boolean => spaceOverride?.[id] !== undefined || providers?.[id] != null
  const api = family.apiProviderId
  const sub = family.subscriptionProviderId
  const familyOn = expressed(api) || !expressed(sub) ? enabledOf(api) : enabledOf(sub)
  if (providerId === api) return familyOn
  return own || familyOn
}

/* ── 新写法的输入:后端下发的名册 ───────────────────────────────────────────────── */

const servedRoster = onethingBaseBuiltinProviders.map((definition) => definition.info)
const servedLookup = providerFamilyLookupOf(servedRoster)

describe('家族:名册算出来的 ≡ 旧表', () => {
  it('四个家族逐行相等(id / 显示名 / 两半 / 订阅标签)', () => {
    const derived = new Map<string, OldProviderFamily>()
    for (const info of servedRoster) {
      const family = info.family
      if (!family || family.role !== 'subscription') continue
      derived.set(family.id, {
        id: family.id,
        label: family.label ?? '',
        apiProviderId: family.sibling!,
        subscriptionProviderId: info.id,
        subscriptionTag: family.tag ?? '',
      })
      // API 那一半看见的是同一个家族:同键、同名、指回订阅那一半。
      const api = servedRoster.find((entry) => entry.id === family.sibling)?.family
      expect(api, info.id).toEqual({ id: family.id, role: 'api', sibling: info.id, label: family.label })
    }
    const sortById = (rows: OldProviderFamily[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
    expect(sortById([...derived.values()])).toEqual(sortById(OLD_PROVIDER_FAMILIES))
  })

  it('家族显示名今天恰好等于 API 那一半的名字(显示名由 API 那一半的 manifest 声明)', () => {
    for (const family of OLD_PROVIDER_FAMILIES) {
      expect(servedRoster.find((info) => info.id === family.apiProviderId)?.name).toBe(family.label)
    }
  })

  it('每个 id 的家族查询:下发名册的 ≡ runtime 名册的 ≡ 旧表', () => {
    const ids = [...servedRoster.map((info) => info.id), 'custom-x', 'no-such-provider', '']
    for (const id of ids) {
      const old = oldProviderFamilyOf(id)
      const expected = old
        ? { id: old.id, apiProviderId: old.apiProviderId, subscriptionProviderId: old.subscriptionProviderId }
        : null
      expect(servedLookup(id), id).toEqual(expected)
      expect(builtinProviderFamilyLookup(id), id).toEqual(expected)
    }
  })
})

describe('isProviderEnabledIn:新写法 ≡ 旧写法', () => {
  type Config = { enabled?: boolean } | undefined
  const CONFIG_STATES: Array<{ label: string; value: Config | 'absent' }> = [
    { label: 'absent', value: 'absent' },
    { label: 'undefined-key', value: undefined },
    { label: '{}', value: {} },
    { label: 'on', value: { enabled: true } },
    { label: 'off', value: { enabled: false } },
  ]

  function overridesFor(api: string, sub: string): ProviderEnabledOverride[] {
    return [
      undefined,
      null,
      {},
      { [api]: true },
      { [api]: false },
      { [sub]: true },
      { [sub]: false },
      { [api]: true, [sub]: false },
      { [api]: false, [sub]: true },
      { unrelated: false },
    ]
  }

  const queriedIds = servedRoster.map((info) => info.id).concat('custom-x')

  it('每个家族两半 × 五种配置态 × 十种空间覆盖,每个 id 都相等', () => {
    let compared = 0
    for (const family of OLD_PROVIDER_FAMILIES) {
      const api = family.apiProviderId
      const sub = family.subscriptionProviderId
      for (const apiState of CONFIG_STATES) {
        for (const subState of CONFIG_STATES) {
          const providers: Record<string, Config> = { deepseek: { enabled: false }, 'custom-x': {} }
          if (apiState.value !== 'absent') providers[api] = apiState.value
          if (subState.value !== 'absent') providers[sub] = subState.value
          for (const override of overridesFor(api, sub)) {
            for (const id of queriedIds) {
              const label = `${api}=${apiState.label} ${sub}=${subState.label} override=${JSON.stringify(override)} → ${id}`
              expect(isProviderEnabledIn(providers, id, servedLookup, override), label).toBe(
                oldIsProviderEnabledIn(providers, id, override),
              )
              compared += 1
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(10_000)
  })

  it('providers 整个缺席(undefined / null)时也相等', () => {
    for (const providers of [undefined, null]) {
      for (const id of queriedIds) {
        for (const override of [undefined, { [id]: false }, { [id]: true }]) {
          expect(isProviderEnabledIn(providers, id, servedLookup, override), id).toBe(
            oldIsProviderEnabledIn(providers, id, override),
          )
        }
      }
    }
  })
})
