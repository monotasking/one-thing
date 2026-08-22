// @vitest-environment happy-dom
/**
 * P3 市场区组件测试:卡片渲染/徽标、纯前端搜索、装前确认流、minAppVersion
 * 置灰、断网缓存明示 —— 全部走假 platformApi(主进程 join 语义另由
 * runtime 的 market.test.ts 钉住,这里只验渲染与交互)。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// M1:提示音的每插件静音开关读 app settings,于是这个 tab 现在也是 Pinia 的消费者。
import { createPinia, setActivePinia } from 'pinia'
import PluginsSettingsTab from '../PluginsSettingsTab.vue'
import Tooltip from '../../common/Tooltip.vue'

const MARKET_ENTRIES = [
  {
    id: 'plan-status',
    pkg: '@onething-plugins/plan-status',
    version: '2.0.0',
    description: 'status chip above the composer',
    author: 'onething',
    tarballUrl: 'https://releases.example/plan-status-2.0.0.tgz',
    integrity: 'sha512-AAA',
    installedVersion: '1.0.0',
    hasUpdate: true,
    versionBlockedReason: null,
  },
  {
    id: 'fresh-plugin',
    pkg: '@onething-plugins/fresh-plugin',
    version: '1.0.0',
    description: 'brand new',
    tarballUrl: 'https://releases.example/fresh-plugin-1.0.0.tgz',
    integrity: 'sha512-BBB',
    contributes: {
      uiSlots: [{ anchor: 'composer.above', id: 'fresh-plugin', label: 'Plan 执行状态' }],
      permissions: ['session:read'],
    },
    installedVersion: null,
    hasUpdate: false,
    versionBlockedReason: null,
  },
  {
    id: 'too-new',
    pkg: '@onething-plugins/too-new',
    version: '1.0.0',
    description: 'needs a future app',
    tarballUrl: 'https://releases.example/too-new-1.0.0.tgz',
    minAppVersion: '9.9.9',
    installedVersion: null,
    hasUpdate: false,
    versionBlockedReason: 'requires app >= 9.9.9 (current 1.4.0)',
  },
]

const platform = vi.hoisted(() => {
  interface MarketResponse {
    success: boolean
    entries: unknown[]
    fetchedAt: number | null
    stale: boolean
    error?: string
  }
  return {
    getPlugins: vi.fn(async () => ({ success: true, plugins: [] })),
    getPluginLifecycleInfo: vi.fn(async () => ({ success: true, npmAvailable: true })),
    checkPluginUpdates: vi.fn(async () => ({ success: true, offers: [] })),
    getPluginMarket: vi.fn(async (): Promise<MarketResponse> => ({
      success: true,
      entries: MARKET_ENTRIES,
      fetchedAt: 1_754_000_000_000,
      stale: false,
    })),
    installPlugin: vi.fn(async () => ({ success: true, pluginId: 'fresh-plugin' })),
    updatePlugin: vi.fn(async () => ({ success: true, pluginId: 'plan-status', version: '2.0.0' })),
    refreshPlugins: vi.fn(async () => ({ success: true })),
    // 设置 store 在创建时就挂系统主题订阅(M1 起本 tab 是它的消费者)。
    onSystemThemeChanged: vi.fn(() => vi.fn()),
    getSystemTheme: vi.fn(async () => ({ success: true, theme: 'dark' })),
    environment: 'electron',
  }
})

vi.mock('@/platform', () => ({ platformApi: platform }))
// P4 终态批 C2:插件面走 `plugins` 域,客户端在 `@/platform/plugins-client`。
vi.mock('@/platform/plugins-client', () => ({ pluginsApi: platform }))

function mountTab() {
  return mount(PluginsSettingsTab)
}

describe('PluginsSettingsTab 市场区(P3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    platform.getPluginMarket.mockResolvedValue({
      success: true,
      entries: MARKET_ENTRIES,
      fetchedAt: 1_754_000_000_000,
      stale: false,
    })
  })

  it('渲染索引卡片:描述/作者/包名;已装与有更新徽标分置', async () => {
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.text()).toContain('Plugin Market')
    expect(wrapper.text()).toContain('status chip above the composer')
    expect(wrapper.text()).toContain('by onething')
    expect(wrapper.text()).toContain('@onething-plugins/plan-status')
    // plan-status:已装 1.0.0、索引 2.0.0 → 有更新徽标
    expect(wrapper.text()).toContain('v2.0.0 available')
    // 启动时拉取走缓存优先(refresh 缺省)
    expect(platform.getPluginMarket).toHaveBeenCalledWith({ refresh: false })
    wrapper.unmount()
  })

  it('搜索框纯前端过滤:id/description/author', async () => {
    const wrapper = mountTab()
    await flushPromises()

    const search = wrapper.get('input[aria-label="Search the plugin market"]')
    await search.setValue('future app')
    expect(wrapper.text()).toContain('too-new')
    expect(wrapper.text()).not.toContain('status chip above the composer')
    await search.setValue('zzz-nothing-matches-this')
    expect(wrapper.text()).toContain('No plugins match your search.')
    await search.setValue('')
    expect(wrapper.text()).toContain('plan-status')
    wrapper.unmount()
  })

  it('装前确认:声明清单(contributes+permissions)展开;Confirm 以索引事实安装', async () => {
    const wrapper = mountTab()
    await flushPromises()

    // fresh-plugin 的 Install(未被置灰的第一个可装条目)
    const installButtons = wrapper.findAll('.market-list .plugin-toggle .install-btn')
    // 三个条目:plan-status 有更新(无 Install)、fresh-plugin 可装、too-new 置灰
    expect(installButtons.length).toBe(2)
    const tooNewButton = installButtons[1]
    expect(tooNewButton.attributes('disabled')).toBeDefined()

    await installButtons[0].trigger('click')
    // 声明先于代码:清单里是 manifest 的 contributes/permissions,不是营销文案
    expect(wrapper.text()).toContain('This plugin declares:')
    expect(wrapper.text()).toContain('ui slot "Plan 执行状态" on anchor "composer.above"')
    expect(wrapper.text()).toContain('permissions: session:read')
    expect(wrapper.text()).toContain('Integrity (sha512) will be verified')

    // 确认安装 → installPlugin 带索引三件套(pkg/tarballUrl/integrity)
    const confirmBtn = wrapper.findAll('.market-confirm-actions .install-btn')[0]
    await confirmBtn.trigger('click')
    await flushPromises()
    expect(platform.installPlugin).toHaveBeenCalledWith({
      pkg: '@onething-plugins/fresh-plugin',
      tarballUrl: 'https://releases.example/fresh-plugin-1.0.0.tgz',
      integrity: 'sha512-BBB',
    })
    wrapper.unmount()
  })

  it('装前确认披露生命期:persistent 槽说明"会在消息上留下持久内容"', async () => {
    // 市场索引流出的是 manifest 原文(未投影),lifetime 就长这样。
    platform.getPluginMarket.mockResolvedValue({
      success: true,
      entries: [{
        id: 'tps-meter',
        pkg: '@onething-plugins/tps-meter',
        version: '1.0.2',
        description: 'tokens per second on every reply',
        tarballUrl: 'https://releases.example/tps-meter-1.0.2.tgz',
        integrity: 'sha512-CCC',
        contributes: {
          uiSlots: [
            { anchor: 'message.footer', id: 'tps', label: 'TPS', lifetime: 'persistent' },
            { anchor: 'composer.above', id: 'hint', label: 'Hint' },
          ],
        },
        installedVersion: null,
        hasUpdate: false,
        versionBlockedReason: null,
      }],
      fetchedAt: 1_754_000_000_000,
      stale: false,
    })
    const wrapper = mountTab()
    await flushPromises()

    await wrapper.findAll('.market-list .plugin-toggle .install-btn')[0].trigger('click')
    // 披露跟在它所属的那一条槽后面 —— 用户要知道**哪一块**会留下东西。
    expect(wrapper.text()).toContain(
      'ui slot "TPS" on anchor "message.footer" — leaves persistent content on your messages')
    // 未声明的槽保持沉默:不声明 = 纯内存,没有可披露的事。
    expect(wrapper.text()).toContain('ui slot "Hint" on anchor "composer.above"')
    expect(wrapper.text()).not.toContain('"Hint" on anchor "composer.above" — leaves')
    wrapper.unmount()
  })

  it('装前确认披露主题覆盖:overrides theme colors(B 期,L2)', async () => {
    // 市场索引走 manifest 原文:theme 是 `{ overrides: {...} }`,不是投影后的裁决数组。
    platform.getPluginMarket.mockResolvedValue({
      success: true,
      entries: [{
        id: 'brand-skin',
        pkg: '@onething-plugins/brand-skin',
        version: '1.0.0',
        description: 'corporate colors',
        tarballUrl: 'https://releases.example/brand-skin-1.0.0.tgz',
        integrity: 'sha512-DDD',
        contributes: { theme: { overrides: { primary: '#ff0000', 'bg.app': '#101010' } } },
        installedVersion: null,
        hasUpdate: false,
        versionBlockedReason: null,
      }],
      fetchedAt: 1_754_000_000_000,
      stale: false,
    })
    const wrapper = mountTab()
    await flushPromises()

    await wrapper.findAll('.market-list .plugin-toggle .install-btn')[0].trigger('click')
    expect(wrapper.text()).toContain('overrides theme colors (primary, bg.app)')
    wrapper.unmount()
  })

  it('已装卡片说清主题覆盖的三种下场:生效 / 被压 / 非法丢弃', async () => {
    // 已装那条路吃的是**投影后**的逐条裁决(谁压谁要看全体插件,renderer 判不出来)。
    // 默认 mock 返回空数组,元素类型被推成 never —— 这里给一份具体形状。
    const listResponse: { success: boolean; plugins: unknown[] } = {
      success: true,
      plugins: [{
        id: 'brand-skin',
        name: 'brand-skin',
        version: '1.0.0',
        description: '',
        author: '',
        loaded: true,
        enabled: true,
        commands: [],
        error: '',
        dirPath: '/plugins/brand-skin',
        contributes: {
          theme: [
            { token: 'primary', value: '#ff0000', status: 'active' },
            { token: 'accent', value: '#00ff00', status: 'shadowed', shadowedBy: 'zed-skin' },
            { token: 'nope', value: '#0000ff', status: 'invalid', reason: 'unknown-token' },
            { token: 'bg.app', value: 'url(https://x)', status: 'invalid', reason: 'invalid-color' },
          ],
        },
      }],
    }
    platform.getPlugins.mockResolvedValue(listResponse as never)
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.text()).toContain('overrides theme colors (primary)')
    expect(wrapper.text()).toContain('theme "accent" overridden by "zed-skin"')
    expect(wrapper.text()).toContain('theme override "nope" dropped — not a theme token')
    expect(wrapper.text()).toContain('theme override "bg.app" dropped — not an allowed color value')
    wrapper.unmount()
  })

  it('minAppVersion 不足:Install 置灰且说明;npm 缺失时一并置灰', async () => {
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.text()).toContain('Cannot install: requires app >= 9.9.9 (current 1.4.0)')
    const buttons = wrapper.findAll('.market-list .plugin-toggle .install-btn')
    const tooNew = buttons[1]
    expect(tooNew.attributes('disabled')).toBeDefined()
    // 置灰原因走 Tooltip(ui:gate 禁原生 title),断言它的 text prop。
    const tooltips = wrapper.findAllComponents(Tooltip)
    expect(
      tooltips.some(t => String(t.props('text') ?? '').includes('requires app >= 9.9.9')),
    ).toBe(true)
    wrapper.unmount()
  })

  it('拉取失败有缓存 = stale:明示过期与失败原因而不是市场消失', async () => {
    platform.getPluginMarket.mockResolvedValue({
      success: true,
      entries: MARKET_ENTRIES.slice(0, 1),
      fetchedAt: 1_754_000_000_000,
      stale: true,
      error: 'HTTP 503',
    })
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.text()).toContain("Couldn't refresh (HTTP 503)")
    expect(wrapper.text()).toContain('may be outdated')
    expect(wrapper.text()).toContain('plan-status')
    wrapper.unmount()
  })

  it('首帧是加载中而不是闪空态(挂载即拉取)', async () => {
    // 挂起一个永不 resolve 的拉取:首帧必须停在加载态。
    platform.getPluginMarket.mockReturnValue(new Promise(() => {}))
    const wrapper = mountTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Loading the market…')
    expect(wrapper.text()).not.toContain('No plugins match your search.')
    wrapper.unmount()
  })

  it('连缓存都没有 = 真空失败:错误块 + Retry', async () => {
    platform.getPluginMarket.mockResolvedValue({
      success: false,
      entries: [],
      fetchedAt: null,
      stale: false,
      error: 'HTTP 503',
    })
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.text()).toContain('HTTP 503')
    expect(wrapper.text()).toContain('Retry')
    expect(wrapper.text()).not.toContain('market-list')
    wrapper.unmount()
  })
})
