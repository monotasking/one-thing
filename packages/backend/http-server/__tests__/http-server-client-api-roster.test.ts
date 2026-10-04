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
import { configureFeatureRegistryRpc, dumpFeatures, resetFeaturesForTests } from '../../feature-registry/feature-registry.js'
import { CLIENT_API_ROSTER, registerAppRpcDomains } from '../http-server-client-api-roster.js'
import { hasRpcDomain, registerRouterHandlers, resetRpcRegistryForTests, type ClientApiRow } from '../http-server-dispatch-table.js'

/**
 * 期望从名册本身读(D252,`docs/design/backend-structure-decisions-2026-10.md`):加一个域 = 名册里加一行,
 * 这只测试不用跟着改。从前这里逐行冻住一份名册的副本(55 行),它守的「不许重排」改名册时本来就在评审里;
 * 真有理由的顺序约束只活在名册的注释里,没有一条断言 —— 现在倒过来:副本删掉,约束逐条断言(下面第一条 it)。
 *
 * 读法:名册行(`ClientApiRow`)挂成 id 照抄的 feature,注册项恰好一个域(`router.domain`);
 * feature(今天只有自进化)在这条路上的注册项**是零** —— 它的工具注册面有一道「已经有 bash 的宿主才给」的门,
 * 而本文件刻意不装工具注册表(被测对象是域册的可逆性,不是工具)。零注册的那一行仍然必须在场,
 * 它证明「装 / 拆 / 再装」这一趟连这个 feature 一起走完了。
 */
const DOMAIN_ROWS = CLIENT_API_ROSTER.filter((entry): entry is ClientApiRow => !('mount' in entry))
const DOMAINS = DOMAIN_ROWS.map(row => row.router.domain)
const EXPECTED_FEATURES = CLIENT_API_ROSTER.map(entry => 'mount' in entry
  ? { id: entry.id, registrations: { rpcDomain: 0, disposer: 0 }, rpcDomains: [] as string[] }
  : { id: entry.id, registrations: { rpcDomain: 1, disposer: 0 }, rpcDomains: [entry.router.domain] })

describe('builtin RPC domains as features', () => {
  beforeEach(() => {
    // 越层清零 C5:挂载基座的 RPC 分发表由 backend.ts 的 configureAppRuntimeAdapters() 交进去;不经装配的这里自己交。
    configureFeatureRegistryRpc({ registerRouterHandlers })
    resetFeaturesForTests()
    resetRpcRegistryForTests()
  })

  it('keeps the ordering constraints the roster states', () => {
    const ids = CLIENT_API_ROSTER.map(entry => entry.id)
    const at = (id: string) => {
      const index = ids.indexOf(id)
      expect(index, `名册里没有 ${id}`).toBeGreaterThanOrEqual(0)
      return index
    }
    // 防假绿:名册读坏了不该像「全干净」(下限与 client-api:gate 的 40 只同一口径)。
    expect(DOMAIN_ROWS.length).toBeGreaterThanOrEqual(40)
    expect(new Set(DOMAINS).size).toBe(DOMAINS.length)
    // 渲染侧日志上行排在最前:它零依赖,接的是别人出问题时的那条上行路。
    expect(ids[0]).toBe('rpc:logs')
    // ACP 宿主工具面紧跟在 acp 后面装。
    expect(at('rpc:host-mcp')).toBe(at('rpc:acp') + 1)
    // 笔记紧跟检索(同一类东西:读一份派生出来的名册)。
    expect(at('rpc:notes')).toBe(at('rpc:search') + 1)
    // 资源是最后一个域:它要资源内核(装配缝 4.1,排在工具目录之后)。
    expect(DOMAIN_ROWS[DOMAIN_ROWS.length - 1].id).toBe('rpc:resources')
    // 自进化 feature 在全表最后。
    expect(ids[ids.length - 1]).toBe('self-evolution')
  })

  it('mounts every builtin domain, in assembly order', { timeout: 60_000 }, async () => {
    const dispose = await registerAppRpcDomains()

    expect(dumpFeatures()).toEqual(EXPECTED_FEATURES)
    for (const domain of DOMAINS) expect(hasRpcDomain(domain)).toBe(true)

    await dispose()
  })

  it('a second assembly after shutdown trips neither duplicate guard', { timeout: 60_000 }, async () => {
    const first = await registerAppRpcDomains()
    await first()

    expect(dumpFeatures()).toEqual([])
    for (const domain of DOMAINS) expect(hasRpcDomain(domain)).toBe(false)

    const second = await registerAppRpcDomains()

    expect(dumpFeatures()).toHaveLength(EXPECTED_FEATURES.length)
    for (const domain of DOMAINS) expect(hasRpcDomain(domain)).toBe(true)

    await second()
  })

  it('the total disposer is idempotent (a double shutdown is not an error)', { timeout: 60_000 }, async () => {
    const dispose = await registerAppRpcDomains()

    await dispose()
    await expect(dispose()).resolves.toBeUndefined()
    expect(dumpFeatures()).toEqual([])
  })
})
