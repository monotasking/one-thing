// @vitest-environment happy-dom
/**
 * G2 氛围的**用户主权面**:设置页的总闸 + 每插件开关真的落到 app settings 里。
 *
 * 这一层只验交互 → 落盘形状。"落盘之后画不画"由 App.vue 据 preference 叠加,
 * 那条线在 App 侧;裁决(谁压谁)在 core 的 `ambient.test.ts`。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import PluginsSettingsTab from '../PluginsSettingsTab.vue'
import Switch from '../../common/Switch.vue'

// 声明了氛围的插件(投影后的裁决形状:status + entry)。
const PLUGINS = [
  {
    id: 'snow-scene', name: 'Snow Scene', version: '1.0.0', description: '', author: 'onething',
    loaded: true, enabled: true, commands: [], error: '', dirPath: '/p/snow-scene', source: 'user',
    contributes: { ambient: { status: 'active', entry: 'ambient.html' } },
  },
  {
    id: 'plain', name: 'Plain', version: '1.0.0', description: '', author: 'onething',
    loaded: true, enabled: true, commands: [], error: '', dirPath: '/p/plain', source: 'user',
  },
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
  rpcInvoke: vi.fn(async (request: { domain: string; method: string; payload?: unknown }) => {
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
// P4 终态批 C2:插件面走 `plugins` 域,客户端在 `@/platform/plugins-client`。
vi.mock('@/platform/plugins-client', () => ({ pluginsApi: platform }))
vi.mock('@/services/plugin-notify-sound', () => ({
  playPluginNotifySound: vi.fn(),
  previewPluginNotifySound: vi.fn(),
}))

function savedPluginPreferences(): Record<string, unknown> | undefined {
  const calls = platform.saveSettings.mock.calls
  const last = calls[calls.length - 1]?.[0] as { plugins?: Record<string, unknown> } | undefined
  return last?.plugins
}

/** 第二个 Switch = 氛围总闸(第一个是提示音总闸,插件卡片上的是 enable)。 */
function ambientSwitch(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAllComponents(Switch)[1]
}

/**
 * 氛围的每插件开关:`.mute-btn`(与提示音 mute 共享)且 aria-label 带 "ambient"
 * —— 后半个条件把它和提示音 mute(aria-label 不带 ambient)以及总闸 Switch
 * (不是 .mute-btn)都分开。
 */
function ambientButtons(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.mute-btn[aria-label*="ambient"]')
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

describe('PluginsSettingsTab 氛围主权(G2)', () => {
  it('缺省:总闸开着,只有声明了氛围的插件有每插件开关', async () => {
    const wrapper = await mountTab()
    expect(ambientSwitch(wrapper).props('modelValue')).toBe(true)
    // 两个插件里只有 snow-scene 声明了氛围 → 只出一个氛围开关。
    expect(ambientButtons(wrapper)).toHaveLength(1)
    expect(platform.saveSettings).not.toHaveBeenCalled()
  })

  it('关总闸 → 落盘 ambientEnabled: false,每插件开关整体收起', async () => {
    const wrapper = await mountTab()
    await ambientSwitch(wrapper).vm.$emit('update:modelValue', false)
    await flushPromises()

    expect(savedPluginPreferences()).toMatchObject({ ambientEnabled: false, ambientMutedPluginIds: [] })
    // 提示音那半偏好没被吃掉。
    expect(savedPluginPreferences()).toMatchObject({ notifySoundsEnabled: true, notifySoundMutedPluginIds: [] })
    await flushPromises()
    expect(ambientButtons(wrapper)).toHaveLength(0)
  })

  it('关掉单个插件的氛围 → 只有它进静音名单', async () => {
    const wrapper = await mountTab()
    await ambientButtons(wrapper)[0].trigger('click')
    await flushPromises()
    expect(savedPluginPreferences()?.ambientMutedPluginIds).toEqual(['snow-scene'])
  })

  it('再点一次 = 恢复(名单移除,而不是堆第二条)', async () => {
    const wrapper = await mountTab()
    await ambientButtons(wrapper)[0].trigger('click')
    await flushPromises()
    await ambientButtons(wrapper)[0].trigger('click')
    await flushPromises()
    expect(savedPluginPreferences()?.ambientMutedPluginIds).toEqual([])
  })
})
