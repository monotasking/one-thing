/**
 * 审查回归:更新通道的索引新鲜度。
 *
 * P3 引入缓存优先快照时,host 端口 fetchPluginMarketIndex(更新通道的情报
 * 来源)一度被改成缓存优先 —— 设置页拉过一次之后,updatePlugin 会拿旧
 * 索引说"没有更新"。钉住:端口永远先试拉新,缓存只做失败兜底;
 * 而 UI 快照在非强制刷新下才是缓存优先。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configurePluginMarketIndex,
  fetchPluginMarketIndex,
  getPluginMarketIndexSnapshot,
  setPluginMarketIndexForTest,
} from '../install.js'

const V1 = {
  version: 1,
  plugins: [{ id: 'demo', pkg: '@onething-plugins/demo', version: '1.0.0', tarballUrl: 'https://x/demo-1.0.0.tgz' }],
}
const V2 = {
  version: 1,
  plugins: [{ id: 'demo', pkg: '@onething-plugins/demo', version: '2.0.0', tarballUrl: 'https://x/demo-2.0.0.tgz' }],
}

afterEach(() => {
  configurePluginMarketIndex(null)
  vi.unstubAllGlobals()
})

describe('市场索引快照的新鲜度分层(审查回归)', () => {
  it('host 端口(更新通道)永远先试拉新;UI 快照缓存优先;失败才回缓存', async () => {
    // 缓存里是 v1(模拟 UI 早前拉过);线上已经是 v2。
    configurePluginMarketIndex('https://market.example/index.json')
    setPluginMarketIndexForTest(V1 as never)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(V2), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    // UI 快照非强制刷新 = 缓存优先:拿到 v1,不发请求。
    const uiSnapshot = await getPluginMarketIndexSnapshot()
    expect(uiSnapshot.index?.plugins[0].version).toBe('1.0.0')
    expect(fetchMock).not.toHaveBeenCalled()

    // 更新通道端口 = 永远先试拉新:拿到 v2。
    const fresh = await fetchPluginMarketIndex()
    expect(fresh?.plugins[0].version).toBe('2.0.0')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 拉取失败才回缓存兜底。
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const fallback = await fetchPluginMarketIndex()
    expect(fallback?.plugins[0].version).toBe('2.0.0') // 上一步成功缓存了 v2
  })

  it('强制刷新失败且有缓存 = stale + 失败原因;无缓存 = 真空失败', async () => {
    configurePluginMarketIndex('https://market.example/index.json')
    setPluginMarketIndexForTest(V1 as never)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })))

    const stale = await getPluginMarketIndexSnapshot({ refresh: true })
    expect(stale.stale).toBe(true)
    expect(stale.index?.plugins[0].version).toBe('1.0.0')
    expect(stale.error).toContain('503')

    configurePluginMarketIndex(null) // 清缓存
    configurePluginMarketIndex('https://market.example/index.json')
    const empty = await getPluginMarketIndexSnapshot({ refresh: true })
    expect(empty.stale).toBe(false)
    expect(empty.index).toBeNull()
    expect(empty.error).toContain('503')
  })
})
