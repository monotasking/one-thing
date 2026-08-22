// @vitest-environment happy-dom
/**
 * `file-pick` 节点的渲染与三条出口(B 期,用户壁纸)。
 *
 * 这一层要钉住的是**契约的边**,不是样式:
 *  - 成功 → 发 action,payload 是**地址**({ path, name, size }),
 *    并且回包里一个用户路径的字节都没有;
 *  - 取消 → **不发 action**(插件不该因为用户按了 Esc 被叫醒);
 *  - 闸不过 → toast 一句人话,仍然不发 action;
 *  - 没有 pluginId → 按钮置灰,点了也不拉对话框。
 */
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pickPluginFile = vi.fn()
const toastError = vi.fn()

vi.mock('@/platform', () => ({
  platformApi: {
    get pickPluginFile() { return pickPluginFile },
    openExternal: vi.fn(),
  },
}))
// P4 终态批 C2:插件面走 `plugins` 域,客户端在 `@/platform/plugins-client`。
vi.mock('@/platform/plugins-client', () => ({
  pluginsApi: {
    get pickPluginFile() { return pickPluginFile },
  },
}))

vi.mock('@/composables/useToast', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), info: vi.fn(), success: vi.fn() },
}))

vi.mock('@/components/chat/message/MessageMarkdown.vue', () => ({
  default: { props: ['content'], template: '<div>{{ content }}</div>' },
}))

const PluginPanelNode = (await import('../PluginPanelNode.vue')).default

const NODE = {
  type: 'file-pick',
  label: 'Choose wallpaper',
  accept: ['png', 'webp'],
  maxBytes: 5_000_000,
  actionId: 'picked',
}

function mountNode(pluginId = 'ink') {
  return mount(PluginPanelNode, { props: { node: NODE as never, pluginId } })
}

beforeEach(() => {
  pickPluginFile.mockReset()
  toastError.mockReset()
})

describe('file-pick node', () => {
  it('画成宿主自己的按钮,文案是插件给的 label', () => {
    const wrapper = mountNode()
    expect(wrapper.find('button').text()).toBe('Choose wallpaper')
  })

  it('把节点上的声明原样递给宿主(pluginId + accept + maxBytes)', async () => {
    pickPluginFile.mockResolvedValue({ canceled: true })
    await mountNode().find('button').trigger('click')
    expect(pickPluginFile).toHaveBeenCalledWith({
      pluginId: 'ink',
      accept: ['png', 'webp'],
      maxBytes: 5_000_000,
      label: 'Choose wallpaper',
    })
  })

  it('IPC 参数能过结构化克隆(真机回归:响应式树的 accept 是 Proxy,直递会炸 "An object can\'t be cloned")', async () => {
    pickPluginFile.mockResolvedValue({ canceled: true })
    // 生产里节点来自响应式描述树 —— 用 reactive 复现,mock 捕获实参后真跑一次
    // structuredClone:边界铁律(plain-data.ts)被绕开时这条当场红。
    const reactiveNode = reactive({ ...NODE, accept: ['png', 'webp'] })
    const wrapper = mount(PluginPanelNode, { props: { node: reactiveNode as never, pluginId: 'ink' } })
    await wrapper.find('button').trigger('click')
    const arg = pickPluginFile.mock.calls[0][0]
    expect(() => structuredClone(arg)).not.toThrow()
    expect(arg.accept).toEqual(['png', 'webp'])
  })

  it('成功:发 action,payload 是地址而不是字节', async () => {
    pickPluginFile.mockResolvedValue({ path: 'storage:imports/paper.png', name: 'paper.png', size: 1234 })
    const wrapper = mountNode()
    await wrapper.find('button').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    const emitted = wrapper.emitted('action')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0][0]).toEqual({
      actionId: 'picked',
      payload: { path: 'storage:imports/paper.png', name: 'paper.png', size: 1234 },
    })
    // 地址,不是路径:payload 里不该出现任何看起来像用户磁盘的东西。
    expect(JSON.stringify(emitted?.[0][0])).not.toContain('/Users')
  })

  it('取消:不发 action,也不 toast —— 用户按 Esc 不该叫醒插件', async () => {
    pickPluginFile.mockResolvedValue({ canceled: true })
    const wrapper = mountNode()
    await wrapper.find('button').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(wrapper.emitted('action')).toBeUndefined()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('闸不过:toast 那句人话,仍然不发 action', async () => {
    pickPluginFile.mockResolvedValue({ error: 'That file is too large (20.0 MB).' })
    const wrapper = mountNode()
    await wrapper.find('button').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(wrapper.emitted('action')).toBeUndefined()
    expect(toastError).toHaveBeenCalledWith('That file is too large (20.0 MB).')
  })

  it('宿主抛错时也只 toast,不把错误漏成一个假的 action', async () => {
    pickPluginFile.mockRejectedValue(new Error('bridge is gone'))
    const wrapper = mountNode()
    await wrapper.find('button').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(wrapper.emitted('action')).toBeUndefined()
    expect(toastError).toHaveBeenCalledWith('bridge is gone')
  })

  it('没有 pluginId:置灰而不是消失,点了也不拉对话框', async () => {
    // 显式不给 pluginId(不能走 mountNode 的默认值)。
    const wrapper = mount(PluginPanelNode, { props: { node: NODE as never } })
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    await wrapper.find('button').trigger('click')
    expect(pickPluginFile).not.toHaveBeenCalled()
  })

  it('pluginId 沿描述树往下传 —— 嵌在 stack 里的 file-pick 一样能用', async () => {
    pickPluginFile.mockResolvedValue({ canceled: true })
    const wrapper = mount(PluginPanelNode, {
      props: {
        node: { type: 'stack', children: [NODE] } as never,
        pluginId: 'ink',
      },
    })
    await wrapper.find('button').trigger('click')
    expect(pickPluginFile).toHaveBeenCalledWith(expect.objectContaining({ pluginId: 'ink' }))
  })
})
