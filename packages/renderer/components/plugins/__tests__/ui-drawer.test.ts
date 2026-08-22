// @vitest-environment happy-dom
/**
 * 抽屉块(F 期)的挂点验收 —— UiSlotHost 侧。
 *
 * 钉住的东西:
 *  1. **开合控件由宿主画**:抽屉块外面多一层壳 + 两枚钮(⌄/⌃ 展开⇄半收、
 *     ✕ 全收);未声明 drawer 的块**零变化**(没有壳、没有钮、payload 不变);
 *  2. **ctx.drawerState 随档重拉**:切档 = 一次新的 render,payload 带新档;
 *  3. **全收 = 退位**:块不再渲染在 composer.above,S 带(chipShell 挂点)
 *     出一枚 chip,点它回到收起前那一档。
 */
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UiSlotHost from '../UiSlotHost.vue'
import {
  setDrawerState,
  setPluginUiSlots,
  drawerStateOf,
  type PluginContributedUiSlot,
} from '@/workspace/ui-anchor-registry'

const platformState = vi.hoisted(() => ({
  pluginRequest: vi.fn(),
  notificationHandlers: [] as Array<(payload: any) => void>,
}))

vi.mock('@/platform', () => ({
  platformApi: {
    get environment() { return 'electron' },
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

function createFakeStorage() {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => { map.clear() },
  }
}

function slot(overrides: Partial<PluginContributedUiSlot> = {}): PluginContributedUiSlot {
  return {
    pluginId: 'plan-status',
    pluginName: 'Plan status',
    anchor: 'composer.above',
    slotId: 'plan-status',
    label: 'Plan 执行状态',
    loaded: true,
    unsupported: false,
    drawer: true,
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
  vi.stubGlobal('localStorage', createFakeStorage())
  platformState.pluginRequest.mockReset()
  platformState.pluginRequest.mockResolvedValue({ success: true, result: tree('执行中') })
  platformState.notificationHandlers = []
  setPluginUiSlots([])
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
})

describe('composer.above 抽屉块', () => {
  it('抽屉块外面有宿主画的壳与两枚钮,默认半收', async () => {
    setPluginUiSlots([slot()])
    const wrapper = mountHost({ anchor: 'composer.above', sessionId: 's-1' })
    await flushPromises()

    expect(wrapper.find('.ui-slot-drawer').attributes('data-drawer-state')).toBe('peek')
    expect(wrapper.findAll('.ui-slot-drawer-btn')).toHaveLength(2)
    // 半收档的 payload 带 drawerState,块吃到的是半收那棵树。
    expect(platformState.pluginRequest).toHaveBeenCalledWith({
      pluginId: 'plan-status',
      action: 'ui:render:composer.above:plan-status',
      payload: { sessionId: 's-1', drawerState: 'peek' },
    })
  })

  it('未声明 drawer 的块零变化:没有壳、没有钮、payload 不带 drawerState', async () => {
    setPluginUiSlots([slot({ drawer: false })])
    const wrapper = mountHost({ anchor: 'composer.above', sessionId: 's-1' })
    await flushPromises()

    expect(wrapper.find('.ui-slot-drawer').exists()).toBe(false)
    expect(wrapper.findAll('.ui-slot-drawer-btn')).toHaveLength(0)
    expect(platformState.pluginRequest).toHaveBeenCalledWith({
      pluginId: 'plan-status',
      action: 'ui:render:composer.above:plan-status',
      payload: { sessionId: 's-1' },
    })
  })

  it('点 chevron 展开:高度换成展开预算,ctx.drawerState 随档重拉', async () => {
    setPluginUiSlots([slot()])
    const wrapper = mountHost({ anchor: 'composer.above', sessionId: 's-1' })
    await flushPromises()
    platformState.pluginRequest.mockClear()

    await wrapper.findAll('.ui-slot-drawer-btn')[0].trigger('click')
    await flushPromises()

    expect(wrapper.find('.ui-slot-drawer').attributes('data-drawer-state')).toBe('expanded')
    expect(wrapper.find('.ui-slot-block').attributes('style')).toContain('max-height: 240px')
    expect(platformState.pluginRequest).toHaveBeenCalledWith({
      pluginId: 'plan-status',
      action: 'ui:render:composer.above:plan-status',
      payload: { sessionId: 's-1', drawerState: 'expanded' },
    })

    // 再点一次回半收 —— 一个控件只表达"展开⇄半收"这一对。
    await wrapper.findAll('.ui-slot-drawer-btn')[0].trigger('click')
    await flushPromises()
    expect(wrapper.find('.ui-slot-drawer').attributes('data-drawer-state')).toBe('peek')
    expect(wrapper.find('.ui-slot-block').attributes('style')).toContain('max-height: 32px')
  })

  it('全收:块离开 composer.above,S 带出一枚 chip,点它回到收起前那一档', async () => {
    setPluginUiSlots([slot()])
    const above = mountHost({ anchor: 'composer.above', sessionId: 's-1' })
    // S 带的插件段(chipShell)同时挂着 —— 全收 chip 就落在这一支上。
    const band = mountHost({ anchor: 'chat.status-bar', chipShell: true, sessionId: 's-1' })
    await flushPromises()

    // 先展开,再全收 —— 恢复时应该回到展开档而不是默认档。
    await above.findAll('.ui-slot-drawer-btn')[0].trigger('click')
    await flushPromises()
    await above.findAll('.ui-slot-drawer-btn')[1].trigger('click')
    await flushPromises()

    expect(above.find('.ui-slot-drawer').exists()).toBe(false)
    expect(above.find('.ui-slot-block').exists()).toBe(false)
    const chip = band.find('.ui-slot-drawer-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('Plan 执行状态')

    await chip.trigger('click')
    await flushPromises()
    expect(drawerStateOf('plan-status', 'composer.above', 'plan-status')).toBe('expanded')
    expect(above.find('.ui-slot-drawer').attributes('data-drawer-state')).toBe('expanded')
    expect(band.find('.ui-slot-drawer-chip').exists()).toBe(false)
  })

  it('全收块不渲染:不发 render,也不占 composer.above 的容量', async () => {
    setDrawerState('a', 'composer.above', 'a1', 'collapsed')
    setPluginUiSlots([
      slot({ pluginId: 'a', slotId: 'a1' }),
      slot({ pluginId: 'b', slotId: 'b1', drawer: false }),
      slot({ pluginId: 'c', slotId: 'c1', drawer: false }),
      slot({ pluginId: 'd', slotId: 'd1', drawer: false }), // maxBlocks = 3
    ])
    const wrapper = mountHost({ anchor: 'composer.above', sessionId: 's-1' })
    await flushPromises()

    const rendered = platformState.pluginRequest.mock.calls.map(call => call[0].pluginId)
    expect(rendered.sort()).toEqual(['b', 'c', 'd'])
    expect(wrapper.findAll('.ui-slot-block')).toHaveLength(3)
  })

  it('拆除:插件下线后 S 带的 chip 一起消失,档被清掉', async () => {
    setPluginUiSlots([slot()])
    const band = mountHost({ anchor: 'chat.status-bar', chipShell: true, sessionId: 's-1' })
    setDrawerState('plan-status', 'composer.above', 'plan-status', 'collapsed')
    await flushPromises()
    expect(band.find('.ui-slot-drawer-chip').exists()).toBe(true)

    setPluginUiSlots([])
    await flushPromises()
    expect(band.find('.ui-slot-drawer-chip').exists()).toBe(false)
    expect(drawerStateOf('plan-status', 'composer.above', 'plan-status')).toBe('peek')
  })
})
