// @vitest-environment happy-dom
/**
 * 触发式锚点(kind: 'trigger')验收 —— D 期。
 *
 * 钉住的东西:
 *  1. **弹层壳**:打开即 render、关闭即销毁(无常驻实例、无在飞请求),
 *     四态壳全部继承自共享内核(UiSlotBlock → usePluginUiBlock)。
 *  2. **两个挂点**:消息 ⋯ 菜单(message.actions,只挂 assistant)与
 *     输入框工具条(composer.actions,附件按钮之前)。
 *  3. **容量折叠**(3 项)与**降级置灰不消失**(§9.3 第 4 条)。
 *  4. **拆除面**:插件退场后入口消失、弹层不残留。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import PluginTriggerPopover from '../PluginTriggerPopover.vue'
import MessageActions from '@/components/chat/message/MessageActions.vue'
import { setPluginUiSlots, type PluginContributedUiSlot } from '@/workspace/ui-anchor-registry'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '../../..')
const read = (rel: string) => readFileSync(path.join(rendererRoot, rel), 'utf8')

const platformState = vi.hoisted(() => ({
  pluginRequest: vi.fn(),
  notificationHandlers: [] as Array<(payload: any) => void>,
}))

vi.mock('@/platform', () => ({
  platformApi: {
    environment: 'electron',
    pluginRequest: (...args: any[]) => platformState.pluginRequest(...args),
    onPluginNotification: (handler: (payload: any) => void) => {
      platformState.notificationHandlers.push(handler)
      return () => {
        platformState.notificationHandlers = platformState.notificationHandlers.filter(item => item !== handler)
      }
    },
    // 👎 走 evalsApi(P4c 第十批:通用 RPC + 能力位),不再是壳上的一条方法。
    capabilities: { evals: true },
    rpcInvoke: vi.fn(async () => ({ ok: true, data: { success: true } })),
  },
}))

vi.mock('@/composables/useToast', () => ({
  toast: { error: () => {}, info: () => {} },
}))

vi.mock('@/composables/useTTS', () => ({
  useTTS: () => ({
    isSupported: { value: false },
    isSpeaking: { value: false },
    speak: vi.fn(),
    stop: vi.fn(),
  }),
}))

vi.mock('@/stores/evalsWorkbench', () => ({
  useEvalsWorkbenchStore: () => ({ notePendingIncident: vi.fn() }),
}))

vi.mock('@/components/chat/message/MessageMarkdown.vue', () => ({
  default: { props: ['content'], template: '<div>{{ content }}</div>' },
}))

function slot(overrides: Partial<PluginContributedUiSlot>): PluginContributedUiSlot {
  return {
    pluginId: 'tps-meter',
    pluginName: 'TPS meter',
    anchor: 'message.actions',
    slotId: 'tps-usage',
    label: 'Token usage',
    loaded: true,
    unsupported: false,
    ...overrides,
  }
}

function tree(text: string) {
  return { version: 2, body: { type: 'row', children: [{ type: 'badge', text }] } }
}

const mountedWrappers: VueWrapper[] = []

function track<T extends VueWrapper<any>>(wrapper: T): T {
  mountedWrappers.push(wrapper)
  return wrapper
}

beforeEach(() => {
  platformState.pluginRequest.mockReset()
  platformState.pluginRequest.mockResolvedValue({ success: true, result: tree('42.0 tok/s') })
  platformState.notificationHandlers = []
  setPluginUiSlots([])
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
  document.body.innerHTML = ''
})

// ── 弹层壳 ───────────────────────────────────

describe('PluginTriggerPopover · 打开即拉、关闭即销毁', () => {
  function mountPopover(entry: PluginContributedUiSlot | null) {
    const anchorEl = document.createElement('button')
    document.body.appendChild(anchorEl)
    return track(mount(PluginTriggerPopover, {
      attachTo: document.body,
      props: {
        entry,
        anchorEl,
        sessionId: 's-1',
        messageId: 'm-1',
        maxHeight: 320,
      },
    }))
  }

  it('关着的时候一个请求都不打(触发式的全部意义)', async () => {
    mountPopover(null)
    await flushPromises()
    expect(platformState.pluginRequest).not.toHaveBeenCalled()
    expect(document.querySelector('.plugin-trigger-panel')).toBeNull()
  })

  it('打开即走既有 ui:render 通道,ctx 坐标(sessionId + messageId)随 payload 过线', async () => {
    const wrapper = mountPopover(null)
    await wrapper.setProps({ entry: slot({}) })
    await flushPromises()

    expect(platformState.pluginRequest).toHaveBeenCalledTimes(1)
    expect(platformState.pluginRequest.mock.calls[0][0]).toMatchObject({
      pluginId: 'tps-meter',
      action: 'ui:render:message.actions:tps-usage',
      payload: { sessionId: 's-1', messageId: 'm-1' },
    })
    expect(document.body.textContent).toContain('42.0 tok/s')
    expect(document.body.textContent).toContain('Token usage')
  })

  it('关闭即销毁:面消失,且之后的 panel-refresh 通知不会再打请求(无常驻实例)', async () => {
    const wrapper = mountPopover(null)
    await wrapper.setProps({ entry: slot({}) })
    await flushPromises()
    expect(platformState.notificationHandlers.length).toBe(1)

    await wrapper.setProps({ entry: null })
    await flushPromises()
    expect(document.querySelector('.plugin-trigger-panel')).toBeNull()
    // 块随弹层卸载 —— 通知订阅一并退订(这才是"没有在飞请求"的真凭据:
    // 插件之后再喊 refresh,投递面上已经没有这个块了)。
    expect(platformState.notificationHandlers.length).toBe(0)

    platformState.pluginRequest.mockClear()
    for (const handler of [...platformState.notificationHandlers]) {
      handler({ kind: 'panel-refresh', pluginId: 'tps-meter', panelId: 'ui:message.actions:tps-usage' })
    }
    await new Promise(resolve => setTimeout(resolve, 200))
    await flushPromises()
    expect(platformState.pluginRequest).not.toHaveBeenCalled()
  })

  it('四态壳全继承:error 与 degraded 各画各的,degraded 向上报一声', async () => {
    platformState.pluginRequest.mockResolvedValue({ success: false, error: 'boom' })
    const wrapper = mountPopover(null)
    await wrapper.setProps({ entry: slot({}) })
    await flushPromises()
    expect(document.body.textContent).toContain('retry')
    expect(wrapper.emitted('state')?.at(-1)).toEqual([{ degraded: false, error: true }])

    platformState.pluginRequest.mockResolvedValue({ success: false, degraded: true, error: 'too many failures' })
    await wrapper.setProps({ entry: null })
    await wrapper.setProps({ entry: slot({}) })
    await flushPromises()
    expect(document.body.textContent).toContain('paused')
    expect(wrapper.emitted('state')?.at(-1)).toEqual([{ degraded: true, error: false }])
  })
})

// ── 挂点 1:消息 ⋯ 菜单 ──────────────────────────

describe('挂点 · 消息 ⋯ 菜单(message.actions)', () => {
  function mountActions(role: 'assistant' | 'user' = 'assistant') {
    return track(mount(MessageActions, {
      attachTo: document.body,
      props: {
        role,
        content: 'hello',
        visible: true,
        messageId: 'm-1',
        sessionId: 's-1',
      },
    }))
  }

  async function openMoreMenu(wrapper: VueWrapper<any>) {
    await wrapper.find('button.more-btn').trigger('click')
    await flushPromises()
  }

  function menuItems() {
    return [...document.querySelectorAll('.more-menu-actions button.more-menu-item')]
  }

  it('插件项排在内置项之后,文案是 manifest label', async () => {
    setPluginUiSlots([slot({})])
    const wrapper = mountActions()
    await openMoreMenu(wrapper)

    const labels = menuItems().map(item => item.textContent?.trim())
    expect(labels[0]).toContain('Token usage') // 内置的 Token usage
    expect(labels.at(-1)).toContain('Token usage') // 插件项
    expect(menuItems().length).toBe(2)
    // 入口只是菜单项 —— 点之前一个请求都没有。
    expect(platformState.pluginRequest).not.toHaveBeenCalled()
  })

  it('只挂 assistant 消息(与 message.footer 同规)', async () => {
    setPluginUiSlots([slot({})])
    const wrapper = mountActions('user')
    expect(wrapper.find('button.more-btn').exists()).toBe(false)
  })

  it('超过 3 项折叠(容量裁决与常显块同一份)', async () => {
    setPluginUiSlots([
      slot({ pluginId: 'a', slotId: 'a1', label: 'A' }),
      slot({ pluginId: 'b', slotId: 'b1', label: 'B' }),
      slot({ pluginId: 'c', slotId: 'c1', label: 'C' }),
      slot({ pluginId: 'd', slotId: 'd1', label: 'D' }),
    ])
    const wrapper = mountActions()
    await openMoreMenu(wrapper)

    const labels = menuItems().map(item => item.textContent ?? '')
    expect(labels.filter(text => /\b[ABC]\b/.test(text)).length).toBe(3)
    expect(labels.some(text => text.includes('D'))).toBe(false)
    expect(document.querySelector('.more-menu-folded')?.textContent).toContain('+1')
  })

  it('点击:菜单退场、弹层开在这条消息上,ctx 带 {sessionId, messageId}', async () => {
    setPluginUiSlots([slot({})])
    const wrapper = mountActions()
    await openMoreMenu(wrapper)
    await (menuItems().at(-1) as HTMLElement).click()
    await flushPromises()

    expect(document.querySelector('.more-menu-actions')).toBeNull()
    expect(document.querySelector('.plugin-trigger-panel')).not.toBeNull()
    expect(platformState.pluginRequest.mock.calls[0][0]).toMatchObject({
      action: 'ui:render:message.actions:tps-usage',
      payload: { sessionId: 's-1', messageId: 'm-1' },
    })
    // 弹层开着期间悬停操作行必须留在场上(它是弹层的锚)。
    expect(wrapper.emitted('menuOpen')?.at(-1)).toEqual([true])
  })

  it('降级后入口置灰**不消失**,还能再点(看降级态)', async () => {
    platformState.pluginRequest.mockResolvedValue({ success: false, degraded: true, error: 'too many failures' })
    setPluginUiSlots([slot({})])
    const wrapper = mountActions()
    await openMoreMenu(wrapper)
    await (menuItems().at(-1) as HTMLElement).click()
    await flushPromises()

    await openMoreMenu(wrapper)
    const pluginItem = menuItems().at(-1) as HTMLElement
    expect(pluginItem.className).toContain('is-paused')
    expect(pluginItem.textContent).toContain('Token usage')
    expect(pluginItem.textContent).toContain('已暂停')
  })

  it('拆除快照:插件退场 → 菜单项消失、弹层不残留', async () => {
    setPluginUiSlots([slot({})])
    const wrapper = mountActions()
    await openMoreMenu(wrapper)
    await (menuItems().at(-1) as HTMLElement).click()
    await flushPromises()
    expect(document.querySelector('.plugin-trigger-panel')).not.toBeNull()

    setPluginUiSlots([])
    await nextTick()
    await flushPromises()

    expect(document.querySelector('.plugin-trigger-panel')).toBeNull()
    await openMoreMenu(wrapper)
    expect(menuItems().length).toBe(1) // 只剩内置的 Token usage
    platformState.pluginRequest.mockClear()
    await flushPromises()
    expect(platformState.pluginRequest).not.toHaveBeenCalled()
  })
})

// ── 挂点 2:输入框工具条 ──────────────────────────

describe('挂点 · 输入框工具条(composer.actions)', () => {
  const inputBox = read('components/chat/InputBox.vue')

  it('入口住在 toolbar-right,排在附件按钮之前', () => {
    const toolbar = inputBox.slice(
      inputBox.indexOf('class="toolbar-right"'),
      inputBox.indexOf('class="voice-btn"'),
    )
    const triggerAt = toolbar.indexOf('composerPluginEntries')
    const attachAt = toolbar.indexOf('attach-btn')
    expect(triggerAt).toBeGreaterThan(-1)
    expect(attachAt).toBeGreaterThan(-1)
    expect(triggerAt).toBeLessThan(attachAt)
  })

  it('入口是 voice-aux-btn 同款 cell,不画边框(工具条已裁掉逐格竖线)', () => {
    expect(inputBox).toContain('class="voice-aux-btn plugin-trigger-btn"')
    const cellRule = inputBox.slice(
      inputBox.indexOf('.toolbar-right > .plugin-trigger-cell > .voice-aux-btn {'),
      inputBox.indexOf('.plugin-trigger-btn.is-paused'),
    )
    expect(cellRule).toContain('border: 0')
    expect(cellRule).not.toMatch(/border-left:/)
  })

  it('弹层壳挂在工具条之外(teleport 由内核给),会话级 ctx 不带 messageId', () => {
    const popover = inputBox.slice(inputBox.indexOf('<PluginTriggerPopover'))
    expect(popover).toContain(':entry="composerPluginOpenEntry"')
    expect(popover).toContain(':session-id="props.sessionId ?? null"')
    expect(popover.slice(0, popover.indexOf('/>'))).not.toContain('message-id')
  })
})
