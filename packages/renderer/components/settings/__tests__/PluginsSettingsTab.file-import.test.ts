// @vitest-environment happy-dom
/**
 * 设置页的 `file-import` 配置控件。
 *
 * **判例**:选文件是配置,配置的家是设置页;面板留给活内容。此前宿主的 schema
 * 子集没有文件控件,"选图"只能借 file-pick 节点落进工作台面板 —— 能力缺口把
 * UX 拽错了位置。这一层钉住补回来的那条路的**边**:
 *  - 画出来的是按钮 + 当前值(值是地址,显示尾段);
 *  - 参数过得了结构化克隆(响应式字段表是 Proxy,直递会炸);
 *  - 选中 → 写草稿 → Save 走既有的 config 保存路径(不为一个字段发明第二条);
 *  - 取消 / 闸不过 的两条出口与 file-pick 节点逐字同规。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import PluginsSettingsTab from '../PluginsSettingsTab.vue'

const FILE_FIELD = {
  key: 'wallpaper',
  type: 'string',
  control: 'file-import',
  label: 'Wallpaper',
  required: false,
  accept: ['png', 'webp'],
  maxBytes: 5_000_000,
  defaultValue: '',
}

// 工厂而不是常量:保存成功会**就地**改写卡片上的 configValues,共享一份对象
// 会让上一条用例的选中泄漏进下一条。
function plugins(overrides: Record<string, unknown> = {}) {
  return [{
    id: 'ink', name: 'Ink', version: '1.0.0', description: '', author: 'onething',
    loaded: true, enabled: true, commands: [], error: '', dirPath: '/p/ink', source: 'user',
    configTitle: 'Appearance',
    configFields: [{ ...FILE_FIELD, accept: [...FILE_FIELD.accept] }],
    configValues: { wallpaper: '' },
    configUnsupportedReasons: [],
    configEditable: true,
    ...overrides,
  }]
}

const platform = vi.hoisted(() => ({
  getPlugins: vi.fn(async () => ({ success: true, plugins: [] as unknown[] })),
  getPluginLifecycleInfo: vi.fn(async () => ({ success: true, npmAvailable: true })),
  checkPluginUpdates: vi.fn(async () => ({ success: true, offers: [] })),
  getPluginMarket: vi.fn(async () => ({ success: true, entries: [], fetchedAt: null, stale: false })),
  refreshPlugins: vi.fn(async () => ({ success: true })),
  onSystemThemeChanged: vi.fn(() => vi.fn()),
  getSystemTheme: vi.fn(async () => ({ success: true, theme: 'dark' })),
  saveSettings: vi.fn(async (settings: Record<string, unknown>) => ({ success: true, settings })),
  // 形参不能省:mock.calls 的元组类型是从签名推的,省了就取不到第 0 个实参。
  pickPluginFile: vi.fn(async (_request: Record<string, unknown>) => ({ canceled: true }) as unknown),
  setPluginConfig: vi.fn(async () => ({ success: true }) as unknown),
  environment: 'electron',
}))
vi.mock('@/platform', () => ({ platformApi: platform }))
// P4 终态批 C2:插件面走 `plugins` 域,客户端在 `@/platform/plugins-client`。
vi.mock('@/platform/plugins-client', () => ({ pluginsApi: platform }))
vi.mock('@/services/plugin-notify-sound', () => ({
  playPluginNotifySound: vi.fn(),
  previewPluginNotifySound: vi.fn(),
}))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

async function mountTab() {
  const wrapper = mount(PluginsSettingsTab)
  await flushPromises()
  await flushPromises()
  return wrapper
}

function pickButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.findAll('button').find(item => item.text().includes('Choose file'))
  if (!button) throw new Error('the file-import control did not render a picker button')
  return button
}

function clearButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button').find(item => item.text().trim() === '×')
}

function saveButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.findAll('button').find(item => item.text().trim() === 'Save')
  if (!button) throw new Error('the config area did not render a Save button')
  return button
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  platform.getPlugins.mockResolvedValue({ success: true, plugins: plugins() })
  platform.pickPluginFile.mockResolvedValue({ canceled: true })
  platform.setPluginConfig.mockResolvedValue({ success: true })
})

describe('设置页 file-import 控件', () => {
  it('画的是按钮 + 当前值;没选过时说"没选"而不是留一片空白', async () => {
    const wrapper = await mountTab()
    expect(pickButton(wrapper).exists()).toBe(true)
    expect(wrapper.find('.plugin-config-file-value').text()).toBe('No file chosen')
  })

  it('点击带上已裁决的 accept / maxBytes,且实参过得了结构化克隆', async () => {
    const wrapper = await mountTab()
    await pickButton(wrapper).trigger('click')
    await flushPromises()

    expect(platform.pickPluginFile).toHaveBeenCalledWith({
      pluginId: 'ink',
      accept: ['png', 'webp'],
      maxBytes: 5_000_000,
      label: 'Wallpaper',
    })
    // 生产里字段表来自响应式的插件列表 —— 直递 Proxy 会炸 "An object can't be
    // cloned"。边界铁律(plain-data.ts)被绕开时这条当场红。
    const arg = platform.pickPluginFile.mock.calls[0][0]
    expect(() => structuredClone(arg)).not.toThrow()
  })

  it('选中 → 值显示尾段(是地址不是用户磁盘上的路径),Save 走既有 config 路径', async () => {
    platform.pickPluginFile.mockResolvedValue({
      path: 'storage:imports/paper.png', name: 'paper.png', size: 1234,
    })
    const wrapper = await mountTab()
    await pickButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.find('.plugin-config-file-value').text()).toBe('paper.png')

    await saveButton(wrapper).trigger('click')
    await flushPromises()
    expect(platform.setPluginConfig).toHaveBeenCalledWith('ink', { wallpaper: 'storage:imports/paper.png' })
  })

  it('取消:值不变,也不 toast —— 按 Esc 不该产生一次"修改"', async () => {
    const wrapper = await mountTab()
    await pickButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.find('.plugin-config-file-value').text()).toBe('No file chosen')
    expect(toastError).not.toHaveBeenCalled()
    expect(platform.setPluginConfig).not.toHaveBeenCalled()
  })

  it('闸不过:toast 那句人话,草稿不动', async () => {
    platform.pickPluginFile.mockResolvedValue({ error: 'That file is too large (20.0 MB).' })
    const wrapper = await mountTab()
    await pickButton(wrapper).trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('That file is too large (20.0 MB).')
    expect(wrapper.find('.plugin-config-file-value').text()).toBe('No file chosen')
  })

  it('宿主抛错时也只 toast,不把错误漏成一次假的选中', async () => {
    platform.pickPluginFile.mockRejectedValue(new Error('bridge is gone'))
    const wrapper = await mountTab()
    await pickButton(wrapper).trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('bridge is gone')
    expect(wrapper.find('.plugin-config-file-value').text()).toBe('No file chosen')
  })

  it('只读宿主(web):按钮置灰而不是消失,点了也不拉对话框', async () => {
    platform.getPlugins.mockResolvedValue({ success: true, plugins: plugins({ configEditable: false }) })
    const wrapper = await mountTab()
    expect(pickButton(wrapper).attributes('disabled')).toBeDefined()
    await pickButton(wrapper).trigger('click')
    await flushPromises()
    expect(platform.pickPluginFile).not.toHaveBeenCalled()
  })
})

/*
 * 清空钮(恢复默认闭环,2026-08-10)。
 *
 * 走查暴露的空格:Reset 只丢草稿,清不掉**已保存**的值 —— 一个存过的 file
 * 字段在设置页里有进无出,用户想回内置缺省只能停用插件或再换一张图。
 */
describe('设置页 file-import 清空钮', () => {
  it('没值时不画钮 —— 没有可清的东西', async () => {
    const wrapper = await mountTab()
    expect(clearButton(wrapper)).toBeUndefined()
  })

  it('已保存的值也画钮(不是只有本次刚选的才清得掉)', async () => {
    platform.getPlugins.mockResolvedValue({
      success: true,
      plugins: plugins({ configValues: { wallpaper: 'storage:imports/paper.png' } }),
    })
    const wrapper = await mountTab()
    expect(wrapper.find('.plugin-config-file-value').text()).toBe('paper.png')
    expect(clearButton(wrapper)).toBeDefined()
  })

  it('点击 → 值置空串 → 走既有 Save 路径落盘,标签回 No file chosen', async () => {
    platform.getPlugins.mockResolvedValue({
      success: true,
      plugins: plugins({ configValues: { wallpaper: 'storage:imports/paper.png' } }),
    })
    const wrapper = await mountTab()
    await clearButton(wrapper)!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.plugin-config-file-value').text()).toBe('No file chosen')
    // 钮跟着退场:清完就没有可清的了。
    expect(clearButton(wrapper)).toBeUndefined()

    await saveButton(wrapper).trigger('click')
    await flushPromises()
    // 空串而不是删键:用户表达的是"我把它清掉了",不是"这个字段没提过"。
    expect(platform.setPluginConfig).toHaveBeenCalledWith('ink', { wallpaper: '' })
  })

  it('刚选完也清得掉,且不回头去删已拷进来的字节(孤儿归卸载归档)', async () => {
    platform.pickPluginFile.mockResolvedValue({
      path: 'storage:imports/paper.png', name: 'paper.png', size: 1234,
    })
    const wrapper = await mountTab()
    await pickButton(wrapper).trigger('click')
    await flushPromises()
    expect(clearButton(wrapper)).toBeDefined()

    await clearButton(wrapper)!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.plugin-config-file-value').text()).toBe('No file chosen')
    // 清空只撤引用:设置页不替插件做数据生命周期的决定。
    expect(platform.pickPluginFile).toHaveBeenCalledTimes(1)
  })

  it('只读宿主(web):钮置灰而不是消失,点了也不改草稿', async () => {
    platform.getPlugins.mockResolvedValue({
      success: true,
      plugins: plugins({ configEditable: false, configValues: { wallpaper: 'storage:imports/paper.png' } }),
    })
    const wrapper = await mountTab()
    const clear = clearButton(wrapper)
    expect(clear?.attributes('disabled')).toBeDefined()
    await clear!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.plugin-config-file-value').text()).toBe('paper.png')
  })
})
