/**
 * plugins 域的渲染侧客户端(结构债 P4 终态批 C2)。
 *
 * 两件事守在这里,都是从别处**搬过来**的:
 *
 *  1. **过线前的 payload 自检**(原 `platform/__tests__/electron-plugin-request.test.ts`)。
 *     R2 的序列化校验只在**插件那一侧**跑。渲染侧发出去之前什么也不查,于是一个
 *     不可克隆的 payload 得到的是 Electron 原生的 "An object could not be cloned"
 *     —— 没有 pluginId、没有 action、没有字段路径。插件作者拿着这句话无从下手。
 *     迁到通用通道之后这道自检对**两个宿主**都跑,不再只有 electron 那一侧有。
 *  2. **能力位 `pluginsManage` 关着时的降级答案**(原 `platform/web.ts` 那批硬桩)。
 *     文案必须**逐字**是迁移前那几句 —— 迁的是通道,不是可感知行为。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpcInvoke: vi.fn(async (_request: unknown) => ({ ok: true, data: { success: true } })),
  capabilities: { pluginsManage: true } as { pluginsManage: boolean },
}))

vi.mock('../index', () => ({
  platformApi: {
    get rpcInvoke() {
      return mocks.rpcInvoke
    },
    get capabilities() {
      return mocks.capabilities
    },
  },
}))

async function client() {
  const { pluginsApi } = await import('../plugins-client')
  return pluginsApi
}

describe('pluginsApi — payload guard', () => {
  beforeEach(() => {
    mocks.rpcInvoke.mockClear()
    mocks.capabilities.pluginsManage = true
  })

  it('forwards a serializable payload untouched', async () => {
    const api = await client()
    const request = { pluginId: 'notes', action: 'search', payload: { q: 'x', nested: { n: 1 } } }

    await api.pluginRequest(request)

    expect(mocks.rpcInvoke).toHaveBeenCalledWith({
      domain: 'plugins',
      method: 'request',
      payload: request,
    })
  })

  it('rejects with our own error — naming the plugin, the action, and the field', async () => {
    const api = await client()

    await expect(api.pluginRequest({
      pluginId: 'notes',
      action: 'panel:action:inbox',
      payload: { actionId: 'go', payload: { onPick: () => {} } },
    })).rejects.toThrow(/notes\/panel:action:inbox.*onPick is a function/s)

    // **只查不修**:边界不该悄悄把不可序列化的东西修好 —— 那会把"有人在往线上
    // 塞它"这件事藏起来。修在源头。
    expect(mocks.rpcInvoke).not.toHaveBeenCalled()
  })

  it('says "JSON-serializable" so the fix is obvious from the message alone', async () => {
    const api = await client()
    await expect(api.pluginRequest({
      pluginId: 'notes',
      action: 'search',
      payload: { when: new Map() },
    })).rejects.toThrow(/JSON-serializable/)
  })
})

describe('pluginsApi — 读面不受能力位管', () => {
  beforeEach(() => {
    mocks.rpcInvoke.mockClear()
    mocks.capabilities.pluginsManage = false
  })

  it('目录 / 启停 / 刷新 / 命令表 / 命令执行 / 只读配置照旧发请求', async () => {
    const api = await client()
    await api.getPlugins()
    await api.enablePlugin('note-skills')
    await api.disablePlugin('note-skills')
    await api.refreshPlugins()
    await api.getPluginCommands()
    await api.executePluginCommand('/demo', '--fast', 'session-1')
    await api.getPluginConfig('log-monitor')

    expect(mocks.rpcInvoke.mock.calls.map(([request]) => (request as { method: string }).method))
      .toEqual(['list', 'enable', 'disable', 'refresh', 'commands', 'executeCommand', 'configGet'])
  })
})

describe('pluginsApi — 能力位关着时的降级答案(逐字沿用迁移前的硬桩)', () => {
  beforeEach(() => {
    mocks.rpcInvoke.mockClear()
    mocks.capabilities.pluginsManage = false
  })

  it('写面一条请求都不发', async () => {
    const api = await client()

    await expect(api.installPlugin({ pkg: 'x' })).resolves.toEqual({
      success: false,
      error: 'Plugins are installed on the desktop host only.',
    })
    await expect(api.updatePlugin('x')).resolves.toEqual({
      success: false,
      pluginId: '',
      error: 'Plugins are updated on the desktop host only.',
    })
    await expect(api.uninstallPlugin('x')).resolves.toEqual({
      success: false,
      error: 'Plugins are installed and uninstalled on the desktop host only; this server mirrors the plugin catalog read-only.',
    })
    await expect(api.setPluginConfig('x', {})).resolves.toEqual({
      success: false,
      error: 'Plugin configuration is editable on the desktop host only; this server mirrors the plugin catalog read-only.',
    })
    await expect(api.getPluginFootprint('x')).resolves.toEqual({
      success: false,
      error: 'Plugin data lives on the desktop host only.',
    })
    await expect(api.readPluginTarball('/tmp/x.tgz')).resolves.toEqual({
      success: false,
      errorCode: 'not-supported',
      error: 'Plugin tarballs are inspected on the desktop host only.',
    })
    await expect(api.getPluginMarket()).resolves.toEqual({
      success: false,
      entries: [],
      fetchedAt: null,
      stale: false,
      error: 'Plugin market is unavailable in the web host',
    })
    await expect(api.checkPluginUpdates()).resolves.toEqual({ success: true, offers: [] })
    await expect(api.getPluginLifecycleInfo()).resolves.toEqual({
      success: true,
      npmAvailable: false,
    })
    await expect(api.abortPluginRequest('r1')).resolves.toEqual({
      success: false,
      aborted: false,
      error: 'Plugins execute on the desktop host only',
    })
    await expect(api.pickPluginFile({ pluginId: 'x' })).resolves.toEqual({
      error: 'Importing files into a plugin works on the desktop app only.',
    })

    expect(mocks.rpcInvoke).not.toHaveBeenCalled()
  })

  /**
   * requestId 是 abort 的**唯一地址**,所以即使这一次根本没过线也要有一个 ——
   * 迁移前 `platform/web.ts` 自己生成它,这里逐字保留(含随机分量:纯时间戳
   * 在同毫秒并发下会撞号)。
   */
  it('统一请求通道回的是那条 501 的正文,并且带一个 requestId', async () => {
    const api = await client()
    const result = await api.pluginRequest({ pluginId: 'notes', action: 'search' })
    expect(result).toMatchObject({
      success: false,
      error: 'Plugins execute on the desktop host only; this server mirrors the plugin catalog read-only.',
    })
    expect(result.requestId).toMatch(/^web-/)
    expect(mocks.rpcInvoke).not.toHaveBeenCalled()
  })

  it('调用方给了 requestId 就用它', async () => {
    const api = await client()
    const result = await api.pluginRequest({ pluginId: 'notes', action: 'search', requestId: 'r-9' })
    expect(result.requestId).toBe('r-9')
  })
})
