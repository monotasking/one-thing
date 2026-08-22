// @vitest-environment happy-dom
/**
 * UiSlotHost 验收:挂点、容量截断、失败块不占容量、会话切换重拉、多实例去重。
 *
 * 渲染内核(usePluginUiBlock)的行为由 PluginPanelHost 的测试钉住;这里验的是
 * **装配语义** —— 哪些块出现、按什么顺序、什么时候重拉。
 */
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UiSlotHost from '../UiSlotHost.vue'
import { setPluginUiSlots, type PluginContributedUiSlot } from '@/workspace/ui-anchor-registry'

const platformState = vi.hoisted(() => ({
  environment: 'electron' as string,
  pluginRequest: vi.fn(),
  notificationHandlers: [] as Array<(payload: any) => void>,
}))

vi.mock('@/platform', () => ({
  platformApi: {
    get environment() { return platformState.environment },
    pluginRequest: (...args: any[]) => platformState.pluginRequest(...args),
    onPluginNotification: (handler: (payload: any) => void) => {
      platformState.notificationHandlers.push(handler)
      return () => {
        platformState.notificationHandlers = platformState.notificationHandlers.filter(item => item !== handler)
      }
    },
  },
}))
// P4 终态批 C2:插件面走 `plugins` 域,客户端在 `@/platform/plugins-client`。
vi.mock('@/platform/plugins-client', () => ({
  pluginsApi: {
    pluginRequest: (...args: any[]) => platformState.pluginRequest(...args),
  },
}))

vi.mock('@/composables/useToast', () => ({
  toast: { error: () => {}, info: () => {} },
}))

vi.mock('@/components/chat/message/MessageMarkdown.vue', () => ({
  default: { props: ['content'], template: '<div>{{ content }}</div>' },
}))

function slot(overrides: Partial<PluginContributedUiSlot>): PluginContributedUiSlot {
  return {
    pluginId: 'plan-status',
    pluginName: 'Plan status',
    anchor: 'composer.above',
    slotId: 'main',
    label: 'Plan',
    loaded: true,
    unsupported: false,
    ...overrides,
  }
}

function tree(text: string) {
  return { version: 2, body: { type: 'row', children: [{ type: 'badge', text }] } }
}

const mountedWrappers: VueWrapper[] = []

function mountHost(props: Record<string, unknown>) {
  const wrapper = mount(UiSlotHost, { props: props as any })
  mountedWrappers.push(wrapper)
  return wrapper
}

beforeEach(() => {
  platformState.environment = 'electron'
  platformState.pluginRequest.mockReset()
  platformState.pluginRequest.mockResolvedValue({ success: true, result: tree('执行中') })
  platformState.notificationHandlers = []
  setPluginUiSlots([])
})

/*
 * 必须显式 unmount:test-utils 的挂载不会自动回收,而上一个用例的宿主仍然
 * 订着响应式注册表 —— 下一个用例 setPluginUiSlots 时它们会跟着重挂块、
 * 跟着发请求(这在生产里恰恰是正确行为:主窗与浮层两个宿主都活着)。
 */
afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
})

describe('UiSlotHost', () => {
  it('渲染该锚点上的块,render 经请求通道且 payload 带 sessionId', async () => {
    setPluginUiSlots([slot({})])
    const wrapper = mountHost({ anchor: 'composer.above', sessionId: 's-1' })
    await flushPromises()

    expect(platformState.pluginRequest).toHaveBeenCalledWith({
      pluginId: 'plan-status',
      action: 'ui:render:composer.above:main',
      payload: { sessionId: 's-1' },
    })
    expect(wrapper.text()).toContain('执行中')
  })

  it('超过 maxBlocks 的块被截断(不渲染)', async () => {
    setPluginUiSlots([
      slot({ pluginId: 'a', slotId: 'a1' }),
      slot({ pluginId: 'b', slotId: 'b1' }),
      slot({ pluginId: 'c', slotId: 'c1' }),
      slot({ pluginId: 'd', slotId: 'd1' }), // composer.above maxBlocks = 3
    ])
    const wrapper = mountHost({ anchor: 'composer.above' })
    await flushPromises()

    const rendered = platformState.pluginRequest.mock.calls.map(call => call[0].pluginId)
    expect(rendered.sort()).toEqual(['a', 'b', 'c'])
    expect(wrapper.findAll('.ui-slot-block')).toHaveLength(3)
  })

  it('加载失败的块不占容量,折叠为一个聚合指示', async () => {
    setPluginUiSlots([
      slot({ pluginId: 'a', slotId: 'a1' }),
      slot({ pluginId: 'broken', slotId: 'x1', loaded: false }),
      slot({ pluginId: 'b', slotId: 'b1' }),
      slot({ pluginId: 'c', slotId: 'c1' }), // 若失败块占容量,c 会被挤掉
    ])
    const wrapper = mountHost({ anchor: 'composer.above' })
    await flushPromises()

    const rendered = platformState.pluginRequest.mock.calls.map(call => call[0].pluginId)
    expect(rendered.sort()).toEqual(['a', 'b', 'c'])
    expect(wrapper.text()).toContain('1 plugin block not running')
  })

  it('会话切换时重拉,payload 里的 sessionId 随之更新', async () => {
    setPluginUiSlots([slot({})])
    const wrapper = mountHost({ anchor: 'composer.above', sessionId: 's-1' })
    await flushPromises()
    platformState.pluginRequest.mockClear()

    await wrapper.setProps({ sessionId: 's-2' })
    await flushPromises()
    expect(platformState.pluginRequest).toHaveBeenCalledWith({
      pluginId: 'plan-status',
      action: 'ui:render:composer.above:main',
      payload: { sessionId: 's-2' },
    })
  })

  it('两个宿主同时挂同一块:渲染请求共享在飞的一次(多实例去重)', async () => {
    setPluginUiSlots([slot({})])
    mountHost({ anchor: 'composer.above', sessionId: 's-1' })
    mountHost({ anchor: 'composer.above', sessionId: 's-1' })
    await flushPromises()

    expect(platformState.pluginRequest).toHaveBeenCalledTimes(1)
  })

  it('unsupported 的块不进挂点;其他锚点的块不出现', async () => {
    setPluginUiSlots([
      slot({ slotId: 'known' }),
      slot({ slotId: 'alien', anchor: 'composer.below', unsupported: true }),
      slot({ slotId: 'status', anchor: 'chat.status-bar' }),
    ])
    const wrapper = mountHost({ anchor: 'composer.above' })
    await flushPromises()

    expect(platformState.pluginRequest).toHaveBeenCalledTimes(1)
    expect(platformState.pluginRequest.mock.calls[0][0].action).toBe('ui:render:composer.above:known')
    expect(wrapper.findAll('.ui-slot-block')).toHaveLength(1)
  })

  it('插件块渲染期抛错被错误边界兜住,不带走整条锚点带', async () => {
    setPluginUiSlots([slot({})])
    platformState.pluginRequest.mockResolvedValue({
      success: true,
      result: { version: 2, body: { type: 'table', columns: 'broken', rows: [] } },
    })
    const wrapper = mountHost({ anchor: 'composer.above' })
    await flushPromises()
    // table 的 columns 不是数组:渲染分支访问会抛,错误边界兜成错误态。
    expect(wrapper.find('.ui-slot-host').exists()).toBe(true)
  })

  it('拆除:禁用后注册表空、DOM 无残留、在飞的晚到请求不复活尸体', async () => {
    setPluginUiSlots([slot({})])
    let resolveRender: ((value: unknown) => void) | undefined
    platformState.pluginRequest.mockImplementation(
      () => new Promise(resolve => { resolveRender = resolve }),
    )
    const wrapper = mountHost({ anchor: 'composer.above' })
    await flushPromises()
    expect(wrapper.find('.ui-slot-block').exists()).toBe(true)

    // 禁用插件 = 投影重推,注册表清空(与 R5 拆除同构:面板走同一条投影)。
    setPluginUiSlots([])
    await flushPromises()
    expect(wrapper.find('.ui-slot-block').exists()).toBe(false)
    expect(wrapper.find('.ui-slot-host').exists()).toBe(false)

    // 在飞的 render 此刻才回来:组件已卸,晚到的结果不许写进任何 DOM。
    resolveRender?.({ success: true, result: tree('诈尸') })
    await flushPromises()
    expect(wrapper.text() ?? '').not.toContain('诈尸')
    // 卸载后也不许再发新请求(轮询/通知都已随卸载清理)。
    platformState.pluginRequest.mockClear()
    platformState.notificationHandlers.forEach(handler => handler({ kind: 'panel-refresh', pluginId: 'plan-status' }))
    await flushPromises()
    expect(platformState.pluginRequest).not.toHaveBeenCalled()
  })
})
