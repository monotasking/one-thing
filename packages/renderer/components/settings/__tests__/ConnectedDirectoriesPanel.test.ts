// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectedDirectoriesPanel from '../ConnectedDirectoriesPanel.vue'
import type { AppSettings } from '@/types'

const mocks = vi.hoisted(() => ({
  spacesStore: null as any,
  platformApi: null as any,
}))

vi.mock('@/stores/spaces', () => ({
  useSpacesStore: () => mocks.spacesStore,
}))

vi.mock('@/platform', () => ({
  get platformApi() {
    return mocks.platformApi
  },
}))

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function settings(dirs: string[]): AppSettings {
  return { tools: { connectedDirectories: dirs } } as unknown as AppSettings
}

function mountPanel(dirs: string[] = ['/global']) {
  return mount(ConnectedDirectoriesPanel, {
    props: { settings: settings(dirs) },
    global: {
      stubs: {
        SettingsSection: { template: '<div><slot /></div>' },
        SettingsGroup: { template: '<div><slot /></div>' },
        Button: { template: '<button><slot /></button>' },
        // Select 的下拉是 teleport 的,测试里只需要拿到它的 update 事件。
        Select: {
          name: 'Select',
          props: ['modelValue', 'options'],
          emits: ['update:modelValue'],
          template: '<div class="select-stub" />',
        },
      },
    },
  })
}

describe('ConnectedDirectoriesPanel —— 接入目录的两层编辑面(批 B2)', () => {
  beforeEach(() => {
    mocks.spacesStore = reactive({
      available: true,
      spaces: [
        { id: 'default', name: '默认空间', createdAt: 0 },
        { id: 'work', name: '工作', createdAt: 1 },
      ],
      load: vi.fn().mockResolvedValue(undefined),
      lastError: null,
      // 真 store 的 `patchOverlay` 是**先读后并**(批 B7):后端那条通道整层写,
      // 只递一格会把 overlay 的其他字段抹掉。这里照抄同一个形状。
      patchOverlay: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const current = await mocks.platformApi.spacesGetOverlay(id)
        const response = await mocks.platformApi.spacesSetOverlay({
          id,
          overlay: { ...(current.overlay ?? {}), ...patch },
        })
        if (!response.success) {
          mocks.spacesStore.lastError = response.error
          return null
        }
        return response.overlay ?? {}
      }),
    })
    mocks.platformApi = {
      capabilities: { localFileSystem: true },
      statPath: vi.fn().mockResolvedValue({ success: true, type: 'directory' }),
      spacesGetOverlay: vi
        .fn()
        .mockResolvedValue({ success: true, overlay: { connectedDirectories: ['/work-only'] } }),
      spacesSetOverlay: vi.fn(async (request: any) => ({
        success: true,
        overlay: request.overlay,
      })),
      showOpenDialog: vi.fn(),
    }
  })

  it('默认停在全局层:列的是 settings 里那份,不碰 spaces IPC', async () => {
    const wrapper = mountPanel(['/global'])
    await settle()

    expect(wrapper.text()).toContain('/global')
    expect(mocks.platformApi.spacesGetOverlay).not.toHaveBeenCalled()
    // 设置窗是独立 window,自己拉一次空间列表。
    expect(mocks.spacesStore.load).toHaveBeenCalled()
  })

  it('切到某个空间:读该空间 overlay,并把全局那几条标成「来自全局」的只读行', async () => {
    const wrapper = mountPanel(['/global'])
    await settle()

    await wrapper.findComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'work')
    await settle()

    expect(mocks.platformApi.spacesGetOverlay).toHaveBeenCalledWith('work')
    expect(wrapper.text()).toContain('/work-only')
    expect(wrapper.find('.directory-item.is-inherited').text()).toContain('/global')
    expect(wrapper.text()).toContain('来自全局')
  })

  it('空间层的删除走 spaces IPC,不发 update:settings(两层落盘通道不同)', async () => {
    const wrapper = mountPanel(['/global'])
    await settle()
    await wrapper.findComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'work')
    await settle()

    await wrapper.find('.directory-list .remove-btn').trigger('click')
    await settle()

    expect(mocks.platformApi.spacesSetOverlay).toHaveBeenCalledWith({
      id: 'work',
      overlay: { connectedDirectories: [] },
    })
    expect(wrapper.emitted('update:settings')).toBeUndefined()
  })

  it('改目录不会顺手抹掉 overlay 里的模型选择(整层写的陷阱)', async () => {
    mocks.platformApi.spacesGetOverlay = vi.fn().mockResolvedValue({
      success: true,
      overlay: { connectedDirectories: ['/work-only'], selectedModels: { deepseek: ['m1'] } },
    })
    const wrapper = mountPanel(['/global'])
    await settle()
    await wrapper.findComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'work')
    await settle()

    await wrapper.find('.directory-list .remove-btn').trigger('click')
    await settle()

    expect(mocks.platformApi.spacesSetOverlay).toHaveBeenCalledWith({
      id: 'work',
      overlay: { connectedDirectories: [], selectedModels: { deepseek: ['m1'] } },
    })
  })

  it('全局层的删除仍走 update:settings,不碰 spaces IPC', async () => {
    const wrapper = mountPanel(['/global'])
    await settle()

    await wrapper.find('.directory-list .remove-btn').trigger('click')
    await settle()

    expect(wrapper.emitted('update:settings')?.[0]?.[0]).toMatchObject({
      tools: { connectedDirectories: [] },
    })
    expect(mocks.platformApi.spacesSetOverlay).not.toHaveBeenCalled()
  })

  it('写失败回滚到写之前那份,不留下界面上有、盘上没有的目录', async () => {
    mocks.platformApi.spacesSetOverlay = vi
      .fn()
      .mockResolvedValue({ success: false, error: '磁盘满了' })
    const wrapper = mountPanel(['/global'])
    await settle()
    await wrapper.findComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'work')
    await settle()

    await wrapper.find('.directory-list .remove-btn').trigger('click')
    await settle()

    expect(wrapper.text()).toContain('/work-only')
    expect(wrapper.find('.overlay-error').text()).toContain('磁盘满了')
  })

  it('后端答不上话(web 宿主)就整段不画,退成纯全局层', async () => {
    mocks.spacesStore.available = false
    const wrapper = mountPanel(['/global'])
    await settle()

    expect(wrapper.find('.scope-row').exists()).toBe(false)
    expect(wrapper.text()).toContain('/global')
  })
})
