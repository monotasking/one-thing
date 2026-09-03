// @vitest-environment happy-dom
/**
 * M1 提示音的**用户主权面**:设置页两个控件真的落到 app settings 里。
 *
 * 这一层只验交互 → 落盘形状。"落盘之后响不响"由主进程裁决,那条线在
 * `packages/backend/wiring/plugins/__tests__/notify-sound.test.ts`;
 * "静音时横幅还在不在"在 `services/__tests__/ipc-hub-plugin-notify-sound.test.ts`。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RpcResponse } from '@shared/ipc'
import PluginsSettingsTab from '../PluginsSettingsTab.vue'
import Switch from '../../common/Switch.vue'

const PLUGINS = [
  { id: 'tps-meter', name: 'TPS meter', version: '1.0.4', description: '', author: 'onething', loaded: true, enabled: true, commands: [], error: '', dirPath: '/p/tps-meter', source: 'user' },
  { id: 'plan-status', name: 'Plan status', version: '1.1.0', description: '', author: 'onething', loaded: true, enabled: true, commands: [], error: '', dirPath: '/p/plan-status', source: 'user' },
]

const platform = vi.hoisted(() => ({
  getPlugins: vi.fn(async () => ({ success: true, plugins: [] as unknown[] })),
  getPluginLifecycleInfo: vi.fn(async () => ({ success: true, npmAvailable: true })),
  checkPluginUpdates: vi.fn(async () => ({ success: true, offers: [] })),
  getPluginMarket: vi.fn(async () => ({ success: true, entries: [], fetchedAt: null, stale: false })),
  refreshPlugins: vi.fn(async () => ({ success: true })),
  onSystemThemeChanged: vi.fn(() => vi.fn()),
  getSystemTheme: vi.fn(async () => ({ success: true, theme: 'dark' })),
  saveSettings: vi.fn(async (settings: Record<string, unknown>) => ({ success: true, settings })),
  // P4c 第十一批:设置面走通用 RPC 通道;`saveSettings` 间谍保留,
  // 由这只 `rpcInvoke` 转调 —— 与真渲染层那条路径同形,断言逐字不变。
  rpcInvoke: vi.fn(async (request: { domain: string; method: string; payload?: unknown }): Promise<RpcResponse> => {
    if (request.domain === 'settings' && request.method === 'saveSettings') {
      return { ok: true, data: await platform.saveSettings(request.payload as Record<string, unknown>) }
    }
    if (request.domain === 'settings' && request.method === 'getSystemTheme') {
      return { ok: true, data: await platform.getSystemTheme() }
    }
    return { ok: true, data: { success: true } }
  }),
  environment: 'electron',
}))
vi.mock('@/platform', () => ({ platformApi: platform }))
// C2:域客户端的传输面从 `platformApi.rpcInvoke` 换成了 `@onething/client` 的
// `Transport`,于是这里多钉一条缝 —— `platform.rpcInvoke` 那只间谍(以及它背后的
// `saveSettings` 间谍)照旧是被断言的那一个,断言逐字不变。
vi.mock('@/platform/client', async () => {
  const { createRouterClient } = await import('@onething/client')
  return {
    clientApi: (router: Parameters<typeof createRouterClient>[0]) =>
      createRouterClient(router, request => platform.rpcInvoke(request as never)),
  }
})
// P4 终态批 C2:插件面走 `plugins` 域,客户端在 `@/platform/plugins-client`。
vi.mock('@/platform/plugins-client', () => ({ pluginsApi: platform }))

const soundState = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('@/services/plugin-notify-sound', () => ({
  playPluginNotifySound: vi.fn(),
  previewPluginNotifySound: (sound: unknown) => soundState.preview(sound),
}))

/** 最近一次落盘的 plugins 段。 */
function savedPluginPreferences(): Record<string, unknown> | undefined {
  const calls = platform.saveSettings.mock.calls
  const last = calls[calls.length - 1]?.[0] as { plugins?: Record<string, unknown> } | undefined
  return last?.plugins
}

/** 页面顶部那个总开关(第一个 Switch;插件卡片上的是 enable,排在后面)。 */
function globalSwitch(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAllComponents(Switch)[0]
}

function muteButtons(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.mute-btn')
}

async function mountTab() {
  const wrapper = mount(PluginsSettingsTab)
  await flushPromises()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  platform.getPlugins.mockResolvedValue({ success: true, plugins: PLUGINS })
  platform.saveSettings.mockImplementation(async (settings: Record<string, unknown>) => ({ success: true, settings }))
})

describe('PluginsSettingsTab 提示音主权(M1)', () => {
  it('缺省:总开关开着,没有插件被静音', async () => {
    const wrapper = await mountTab()

    expect(globalSwitch(wrapper).props('modelValue')).toBe(true)
    // 总开关开着,所以每插件静音按钮出现 —— 每个已装插件一个。
    expect(muteButtons(wrapper)).toHaveLength(PLUGINS.length)
    expect(platform.saveSettings).not.toHaveBeenCalled()
  })

  it('关总开关 → 落盘 notifySoundsEnabled: false,且每插件按钮整体收起', async () => {
    const wrapper = await mountTab()

    await globalSwitch(wrapper).vm.$emit('update:modelValue', false)
    await flushPromises()

    expect(savedPluginPreferences()).toEqual({
      notifySoundsEnabled: false,
      notifySoundMutedPluginIds: [],
      ambientEnabled: true,
      ambientMutedPluginIds: [],
    })

    // 总关之后逐个静音已无意义 —— 藏起来而不是置灰(置灰会让人以为点了有用)。
    await flushPromises()
    expect(muteButtons(wrapper)).toHaveLength(0)
  })

  it('静音单个插件 → 只有它进名单,别人不受影响', async () => {
    const wrapper = await mountTab()

    await muteButtons(wrapper)[0].trigger('click')
    await flushPromises()

    expect(savedPluginPreferences()).toEqual({
      notifySoundsEnabled: true,
      notifySoundMutedPluginIds: ['tps-meter'],
      ambientEnabled: true,
      ambientMutedPluginIds: [],
    })
  })

  it('再点一次 = 取消静音(名单里移除,而不是堆第二条)', async () => {
    const wrapper = await mountTab()

    await muteButtons(wrapper)[0].trigger('click')
    await flushPromises()
    await muteButtons(wrapper)[0].trigger('click')
    await flushPromises()

    expect(savedPluginPreferences()).toEqual({
      notifySoundsEnabled: true,
      notifySoundMutedPluginIds: [],
      ambientEnabled: true,
      ambientMutedPluginIds: [],
    })
  })

  it('静音两个插件时名单累加,不互相顶掉', async () => {
    const wrapper = await mountTab()

    await muteButtons(wrapper)[0].trigger('click')
    await flushPromises()
    await muteButtons(wrapper)[1].trigger('click')
    await flushPromises()

    expect(savedPluginPreferences()?.notifySoundMutedPluginIds).toEqual(['tps-meter', 'plan-status'])
  })

  it('Test 按钮试听,不写任何设置', async () => {
    const wrapper = await mountTab()

    const testButton = wrapper.findAll('button').find(b => b.text() === 'Test')
    await testButton!.trigger('click')

    expect(soundState.preview).toHaveBeenCalledWith('chime')
    expect(platform.saveSettings).not.toHaveBeenCalled()
  })
})
