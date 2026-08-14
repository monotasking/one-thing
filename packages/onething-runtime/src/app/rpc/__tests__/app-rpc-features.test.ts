/**
 * 二次装配门（内核收缩 K0 的验收门，
 * docs/design/kernel-shrink-builtin-plugins-2026-08.md §2）。
 *
 * `createOnethingBackend` 的 shutdown→再装配路径（测试、宿主重启、server 的
 * test-helpers）会把内置 RPC 域册整个装第二遍。域注册表的重复守卫是**会抛
 * 的**，所以「装 → 拆 → 再装」这一趟必须干净 —— K0 把注册包成 feature 之后，
 * 同一条路上又多了一层挂载表的重复守卫，它一样得跟着解绕。
 *
 * 这里不 mock 任何东西：被测对象正是真实域册的形状与它的可逆性。注册本身是
 * 纯记账（闭包进 Map），handler 的依赖是逐调用惰性求值的，所以整册装配不碰
 * 任何 I/O。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { dumpFeatures, resetFeaturesForTests } from '../../features/index.js'
import { registerAppRpcDomains } from '../index.js'
import { hasRpcDomain, resetRpcRegistryForTests } from '../registry.js'

/** 域册的现状快照。顺序 = 装配顺序（包装不重排）。 */
const EXPECTED_FEATURES = [
  ['rpc:usage', 'usage'],
  ['rpc:prompts', 'prompts'],
  ['rpc:goal', 'goal'],
  ['rpc:todo-plan', 'todo-plan'],
  ['rpc:session-events', 'sessionEvents'],
  ['rpc:channel-identity', 'channelIdentity'],
  ['rpc:agents', 'agents'],
  ['rpc:providers', 'providers'],
  ['rpc:models', 'models'],
  ['rpc:markdown', 'markdown'],
  ['rpc:permission-grants', 'permissionGrants'],
] as const

describe('builtin RPC domains as features', () => {
  beforeEach(() => {
    resetFeaturesForTests()
    resetRpcRegistryForTests()
  })

  it('mounts every builtin domain, in assembly order', { timeout: 60_000 }, async () => {
    const dispose = await registerAppRpcDomains()

    expect(dumpFeatures()).toEqual(EXPECTED_FEATURES.map(([id, domain]) => ({
      id,
      registrations: { rpcDomain: 1, disposer: 0 },
      rpcDomains: [domain],
    })))
    for (const [, domain] of EXPECTED_FEATURES) expect(hasRpcDomain(domain)).toBe(true)

    await dispose()
  })

  it('a second assembly after shutdown trips neither duplicate guard', { timeout: 60_000 }, async () => {
    const first = await registerAppRpcDomains()
    await first()

    expect(dumpFeatures()).toEqual([])
    for (const [, domain] of EXPECTED_FEATURES) expect(hasRpcDomain(domain)).toBe(false)

    const second = await registerAppRpcDomains()

    expect(dumpFeatures()).toHaveLength(EXPECTED_FEATURES.length)
    for (const [, domain] of EXPECTED_FEATURES) expect(hasRpcDomain(domain)).toBe(true)

    await second()
  })

  it('the total disposer is idempotent (a double shutdown is not an error)', { timeout: 60_000 }, async () => {
    const dispose = await registerAppRpcDomains()

    await dispose()
    await expect(dispose()).resolves.toBeUndefined()
    expect(dumpFeatures()).toEqual([])
  })
})
