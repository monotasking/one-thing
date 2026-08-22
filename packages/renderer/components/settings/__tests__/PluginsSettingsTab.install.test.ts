// @vitest-environment happy-dom
/**
 * file: 开发通道的装前预读:**选中 tarball 即可安装**。
 *
 * 包名不再由用户手输 —— 它写在包里,宿主读得出来。这里钉住三件事:
 * 表单上没有包名输入框了;预读成功后确认摘要用的是市场那套披露口径;
 * Install 拿的是预读出来的 pkg。预读失败则照实说,并且装不了。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// M1:提示音的每插件静音开关读 app settings,于是这个 tab 现在也是 Pinia 的消费者。
import { createPinia, setActivePinia } from 'pinia'
import PluginsSettingsTab from '../PluginsSettingsTab.vue'

const TARBALL = '/Users/dev/plugin/packages/tps-meter/dist/onething-plugins-tps-meter-1.0.3.tgz'

const SUMMARY = {
  path: TARBALL,
  pkg: '@onething-plugins/tps-meter',
  pluginId: 'tps-meter',
  version: '1.0.3',
  displayName: 'TPS Meter',
  description: 'tokens per second',
  author: 'onething',
  minAppVersion: '1.4.0',
  contributes: {
    uiSlots: [{ anchor: 'message.footer', id: 'tps-meter', label: 'TPS', lifetime: 'persistent' }],
    permissions: ['session:read'],
  },
}

const platform = vi.hoisted(() => ({
  getPlugins: vi.fn(async () => ({ success: true, plugins: [] })),
  getPluginLifecycleInfo: vi.fn(async () => ({ success: true, npmAvailable: true })),
  checkPluginUpdates: vi.fn(async () => ({ success: true, offers: [] })),
  getPluginMarket: vi.fn(async () => ({ success: true, entries: [], fetchedAt: null, stale: false })),
  readPluginTarball: vi.fn(async (_path: string): Promise<Record<string, unknown>> => ({ success: true, summary: SUMMARY })),
  showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [TARBALL] })),
  installPlugin: vi.fn(async (): Promise<Record<string, unknown>> => ({ success: true, pluginId: 'tps-meter' })),
  refreshPlugins: vi.fn(async () => ({ success: true })),
  getPathForFile: vi.fn((_file: File) => TARBALL),
  // 设置 store 在创建时就挂系统主题订阅(M1 起本 tab 是它的消费者)。
  onSystemThemeChanged: vi.fn(() => vi.fn()),
  getSystemTheme: vi.fn(async () => ({ success: true, theme: 'dark' })),
  environment: 'electron',
}))

vi.mock('@/platform', () => ({ platformApi: platform }))
// P4 终态批 C2:插件面走 `plugins` 域,客户端在 `@/platform/plugins-client`。
vi.mock('@/platform/plugins-client', () => ({ pluginsApi: platform }))

function chooseButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.install-actions button').find(button => button.text().includes('Choose file'))!
}

function installButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('.install-actions .install-btn')
}

describe('PluginsSettingsTab 本地安装(file: 开发通道)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    platform.readPluginTarball.mockResolvedValue({ success: true, summary: SUMMARY })
    platform.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [TARBALL] })
    platform.installPlugin.mockResolvedValue({ success: true, pluginId: 'tps-meter' })
  })

  it('表单只剩路径:包名输入框已删除,Install 在预读出结果前置灰', async () => {
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    expect(wrapper.find('input[aria-label="Plugin package name"]').exists()).toBe(false)
    expect(wrapper.find('input[aria-label="Local plugin tarball path"]').exists()).toBe(true)
    expect(installButton(wrapper).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('选中文件 → 预读 → 摘要用市场那套披露口径 → Install 用预读出的包名', async () => {
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    await chooseButton(wrapper).trigger('click')
    await flushPromises()

    expect(platform.showOpenDialog).toHaveBeenCalledWith({
      title: 'Select a plugin tarball',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Plugin package', extensions: ['tgz'] }],
    })
    expect(platform.readPluginTarball).toHaveBeenCalledWith(TARBALL)
    // 路径回填到输入框(用户还能看到、还能改)
    expect((wrapper.get('input[aria-label="Local plugin tarball path"]').element as HTMLInputElement).value)
      .toBe(TARBALL)

    // 摘要行:名字 + 版本 + 与市场确认页逐字相同的披露文案
    expect(wrapper.text()).toContain('@onething-plugins/tps-meter v1.0.3 declares:')
    expect(wrapper.text()).toContain('ui slot "TPS" on anchor "message.footer"')
    expect(wrapper.text()).toContain('leaves persistent content on your messages')
    expect(wrapper.text()).toContain('permissions: session:read')
    expect(wrapper.text()).toContain('needs app >= 1.4.0')

    await installButton(wrapper).trigger('click')
    await flushPromises()

    // 包名来自预读,不来自任何输入框
    expect(platform.installPlugin).toHaveBeenCalledWith({
      pkg: '@onething-plugins/tps-meter',
      path: TARBALL,
    })
    // 装完清场:摘要撤下,路径清空
    expect(wrapper.text()).not.toContain('declares:')
    wrapper.unmount()
  })

  it('预读失败:显示结构化原因,并且装不了', async () => {
    platform.readPluginTarball.mockResolvedValue({
      success: false,
      errorCode: 'name-contract',
      error: 'Package name "nope" does not match the plugin naming contract @onething-plugins/<id>',
    })
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    await chooseButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('does not match the plugin naming contract')
    expect(installButton(wrapper).attributes('disabled')).toBeDefined()
    expect(platform.installPlugin).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('plugin.json 缺失只降级不拒绝:摘要照给,并把"装得上但不会加载"摆出来', async () => {
    platform.readPluginTarball.mockResolvedValue({
      success: true,
      summary: {
        path: TARBALL,
        pkg: '@onething-plugins/tps-meter',
        pluginId: 'tps-meter',
        version: '1.0.3',
        manifestIssue: 'No plugin.json in the tarball: it would install but never load as a plugin.',
      },
    })
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    await chooseButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('never load as a plugin')
    expect(wrapper.text()).toContain('No contributions declared.')
    expect(installButton(wrapper).attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('把 .tgz 拖到安装区等价于选中', async () => {
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    const zone = wrapper.get('.install-form')
    const file = new File(['x'], 'onething-plugins-tps-meter-1.0.3.tgz')
    // DragEvent.dataTransfer 是只读访问器,Object.assign 塞不进去 —— 手工造事件。
    const dropEvent = new Event('drop', { bubbles: true })
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { types: ['Files'], files: [file], dropEffect: '' },
    })
    zone.element.dispatchEvent(dropEvent)
    await flushPromises()

    expect(platform.getPathForFile).toHaveBeenCalledWith(file)
    expect(platform.readPluginTarball).toHaveBeenCalledWith(TARBALL)
    expect(wrapper.text()).toContain('@onething-plugins/tps-meter v1.0.3 declares:')
    wrapper.unmount()
  })

  it('取消文件选择器 = 什么都不发生', async () => {
    platform.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    await chooseButton(wrapper).trigger('click')
    await flushPromises()

    expect(platform.readPluginTarball).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  // ── 批量:一次选多个 tarball 串行装 ─────────────────────────────

  const TARBALL_B = '/Users/dev/plugin/packages/foo/dist/onething-plugins-foo-2.0.0.tgz'
  const SUMMARY_B = {
    path: TARBALL_B,
    pkg: '@onething-plugins/foo',
    pluginId: 'foo',
    version: '2.0.0',
    contributes: { commands: ['foo'] },
  }

  /** 按路径分流预读:每个 tarball 各出各的摘要。 */
  function readByPath(map: Record<string, Record<string, unknown>>) {
    platform.readPluginTarball.mockImplementation(async (path: string) => map[path]
      ?? { success: false, error: `no fixture for ${path}` })
  }

  it('多选返回多路径 → 批量预读 → 逐条渲染 → 串行装两个', async () => {
    platform.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [TARBALL, TARBALL_B] })
    readByPath({
      [TARBALL]: { success: true, summary: SUMMARY },
      [TARBALL_B]: { success: true, summary: SUMMARY_B },
    })
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    await chooseButton(wrapper).trigger('click')
    await flushPromises()

    // 两条待装,各自的披露摘要逐条渲染
    expect(platform.readPluginTarball).toHaveBeenCalledWith(TARBALL)
    expect(platform.readPluginTarball).toHaveBeenCalledWith(TARBALL_B)
    expect(wrapper.text()).toContain('@onething-plugins/tps-meter v1.0.3 declares:')
    expect(wrapper.text()).toContain('@onething-plugins/foo v2.0.0 declares:')
    // 多选:输入框清空(一个框装不下多条路径)
    expect((wrapper.get('input[aria-label="Local plugin tarball path"]').element as HTMLInputElement).value)
      .toBe('')
    // 按钮文案带数量
    expect(installButton(wrapper).text()).toContain('Install 2 plugins')

    await installButton(wrapper).trigger('click')
    await flushPromises()

    // 串行装两个,顺序与选中一致
    expect(platform.installPlugin).toHaveBeenCalledTimes(2)
    expect(platform.installPlugin).toHaveBeenNthCalledWith(1, { pkg: '@onething-plugins/tps-meter', path: TARBALL })
    expect(platform.installPlugin).toHaveBeenNthCalledWith(2, { pkg: '@onething-plugins/foo', path: TARBALL_B })
    // 装完清场
    expect(wrapper.text()).not.toContain('declares:')
    wrapper.unmount()
  })

  it('批量预读部分失败:坏的那条标红,好的那条照样能装', async () => {
    platform.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [TARBALL, TARBALL_B] })
    readByPath({
      [TARBALL]: { success: true, summary: SUMMARY },
      [TARBALL_B]: { success: false, error: 'Package name does not match the naming contract' },
    })
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    await chooseButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('@onething-plugins/tps-meter v1.0.3 declares:')
    expect(wrapper.text()).toContain('does not match the naming contract')
    // 只有一条能装:按钮不置灰,文案退回单数
    expect(installButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(installButton(wrapper).text()).toContain('Install')
    expect(installButton(wrapper).text()).not.toContain('2 plugins')

    await installButton(wrapper).trigger('click')
    await flushPromises()

    // 只装能装的那条,坏的那条不进安装链
    expect(platform.installPlugin).toHaveBeenCalledTimes(1)
    expect(platform.installPlugin).toHaveBeenCalledWith({ pkg: '@onething-plugins/tps-meter', path: TARBALL })
    wrapper.unmount()
  })

  it('串行安装中单个失败不中断后续', async () => {
    platform.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [TARBALL, TARBALL_B] })
    readByPath({
      [TARBALL]: { success: true, summary: SUMMARY },
      [TARBALL_B]: { success: true, summary: SUMMARY_B },
    })
    // 第一个装失败,第二个仍要被尝试
    platform.installPlugin
      .mockResolvedValueOnce({ success: false, error: 'boom' })
      .mockResolvedValueOnce({ success: true, pluginId: 'foo' })
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    await chooseButton(wrapper).trigger('click')
    await flushPromises()
    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(platform.installPlugin).toHaveBeenCalledTimes(2)
    // 有成有败仍收敛列表(装上了至少一个)
    expect(platform.getPlugins).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('把多个 .tgz 一起拖进安装区 = 批量选中', async () => {
    const fileA = new File(['x'], 'onething-plugins-tps-meter-1.0.3.tgz')
    const fileB = new File(['y'], 'onething-plugins-foo-2.0.0.tgz')
    platform.getPathForFile.mockImplementation((file: File) =>
      (file.name.includes('foo') ? TARBALL_B : TARBALL))
    readByPath({
      [TARBALL]: { success: true, summary: SUMMARY },
      [TARBALL_B]: { success: true, summary: SUMMARY_B },
    })
    const wrapper = mount(PluginsSettingsTab)
    await flushPromises()

    const zone = wrapper.get('.install-form')
    const dropEvent = new Event('drop', { bubbles: true })
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { types: ['Files'], files: [fileA, fileB], dropEffect: '' },
    })
    zone.element.dispatchEvent(dropEvent)
    await flushPromises()

    expect(platform.readPluginTarball).toHaveBeenCalledWith(TARBALL)
    expect(platform.readPluginTarball).toHaveBeenCalledWith(TARBALL_B)
    expect(wrapper.text()).toContain('@onething-plugins/tps-meter v1.0.3 declares:')
    expect(wrapper.text()).toContain('@onething-plugins/foo v2.0.0 declares:')
    expect(installButton(wrapper).text()).toContain('Install 2 plugins')
    wrapper.unmount()
  })
})
