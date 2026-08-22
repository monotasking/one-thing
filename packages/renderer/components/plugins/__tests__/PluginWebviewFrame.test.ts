// @vitest-environment happy-dom
/**
 * C 期验收(渲染侧):webview 面板的握手、通信桥、token 闸与拆除。
 *
 * 走的是**整条链**:PluginPanelHost(四态壳 + 通道)→ PluginWebviewFrame
 * (iframe + postMessage)。刻意不 mock 容器 —— 要验的正是"init → invoke →
 * result → refresh 这四步真的接得上",把桥换成占位组件等于把命题挖掉。
 */
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PluginPanelHost from '../PluginPanelHost.vue'

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

const toastState = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  toast: { error: (...args: any[]) => toastState.error(...args), info: (...args: any[]) => toastState.info(...args) },
}))

vi.mock('@/components/chat/message/MessageMarkdown.vue', () => ({
  default: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
}))

const panel = {
  pluginId: 'charts',
  pluginName: 'Charts',
  panelId: 'chart',
  label: 'Revenue',
  loaded: true,
  view: 'webview' as const,
  entry: 'index.html',
  hasInit: true,
}

/**
 * 假的 iframe contentWindow。
 *
 * happy-dom 不会真的去取 `onething-plugin://` —— 也不该:这份验收要验的是
 * **宿主这一侧**的协议,而不是 Chromium 的加载器。所以把 contentWindow 换成
 * 一个记账用的 stub,再手工触发 load 与 message。
 */
function stubFrame(wrapper: any) {
  const posted: any[] = []
  const contentWindow = { postMessage: (message: any) => posted.push(message) }
  const iframe = wrapper.find('iframe').element as HTMLIFrameElement
  Object.defineProperty(iframe, 'contentWindow', { value: contentWindow, configurable: true })
  return { posted, contentWindow, iframe }
}

/** 从 iframe 那一侧发一条消息(source 必须是它的 contentWindow)。 */
function fromFrame(contentWindow: unknown, data: unknown): void {
  const event = new MessageEvent('message', { data, origin: 'null' })
  Object.defineProperty(event, 'source', { value: contentWindow })
  window.dispatchEvent(event)
}

beforeEach(() => {
  platformState.environment = 'electron'
  platformState.notificationHandlers = []
  platformState.pluginRequest = vi.fn(async () => ({ success: true, result: { series: [1, 2, 3] } }))
  toastState.error.mockClear()
  toastState.info.mockClear()
})

describe('webview 面板:src 与初始化数据', () => {
  it('src 指向插件自己的 origin,并用 sandbox=allow-scripts(无 allow-same-origin)', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()

    const iframe = wrapper.find('iframe')
    expect(iframe.attributes('src')).toBe('onething-plugin://charts/index.html')
    expect(iframe.attributes('sandbox')).toBe('allow-scripts')
    expect(iframe.attributes('referrerpolicy')).toBe('no-referrer')
    // iframe 的 title 是它的可及名(嵌套浏览上下文没有别的命名途径)。
    expect(iframe.attributes('title')).toContain('Revenue')
  })

  it('初始化数据走 panel:init:<id>,不是 panel:render', async () => {
    mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    expect(platformState.pluginRequest).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'charts',
      action: 'panel:init:chart',
    }))
  })

  it('纯静态面板(没有 init handler)不打那一枪,iframe 照样挂起来', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel: { ...panel, hasInit: false } } })
    await flushPromises()
    expect(platformState.pluginRequest).not.toHaveBeenCalled()
    expect(wrapper.find('iframe').exists()).toBe(true)
  })
})

describe('webview 面板:init → invoke → result → refresh', () => {
  it('首帧握手带 token 与初始化数据', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    const { posted } = stubFrame(wrapper)

    await wrapper.find('iframe').trigger('load')
    expect(posted).toHaveLength(1)
    expect(posted[0].type).toBe('init')
    expect(posted[0].data).toEqual({ series: [1, 2, 3] })
    expect(typeof posted[0].token).toBe('string')
    expect(posted[0].token.length).toBeGreaterThan(8)
  })

  it('invoke 走既有 panel:action 通道,结果原样回帖', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    const { posted, contentWindow } = stubFrame(wrapper)
    await wrapper.find('iframe').trigger('load')
    const token = posted[0].token

    platformState.pluginRequest = vi.fn(async () => ({ success: true, result: { notice: 'done' } }))
    fromFrame(contentWindow, { token, type: 'invoke', requestId: 'r1', actionId: 'export', payload: { fmt: 'csv' } })
    await flushPromises()

    expect(platformState.pluginRequest).toHaveBeenCalledWith({
      pluginId: 'charts',
      action: 'panel:action:chart',
      payload: { actionId: 'export', payload: { fmt: 'csv' } },
    })
    const result = posted.find(message => message.type === 'result')
    expect(result).toMatchObject({ requestId: 'r1', token })
    expect(result.error).toBeUndefined()
  })

  it('invoke 失败也要回帖 —— 否则 iframe 里的 await 永远挂着', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    const { posted, contentWindow } = stubFrame(wrapper)
    await wrapper.find('iframe').trigger('load')
    const token = posted[0].token

    platformState.pluginRequest = vi.fn(async () => ({ success: false, error: 'boom' }))
    fromFrame(contentWindow, { token, type: 'invoke', requestId: 'r2', actionId: 'export' })
    await flushPromises()

    expect(posted.find(message => message.type === 'result')).toMatchObject({ requestId: 'r2', error: 'boom' })
  })

  it('插件调 ctx.refresh():宿主重拉 init 再推 refresh,不重载 iframe', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    const { posted, contentWindow, iframe } = stubFrame(wrapper)
    await wrapper.find('iframe').trigger('load')
    const token = posted[0].token
    // 握手完成(refresh 只推给已经起来的页面)。
    fromFrame(contentWindow, { token, type: 'ready' })

    platformState.pluginRequest = vi.fn(async () => ({ success: true, result: { series: [9] } }))
    platformState.notificationHandlers.forEach(handler =>
      handler({ pluginId: 'charts', panelId: 'chart', kind: 'panel-refresh' }))
    await new Promise(resolve => setTimeout(resolve, 200))
    await flushPromises()

    const refresh = posted.find(message => message.type === 'refresh')
    expect(refresh).toMatchObject({ token, data: { series: [9] } })
    // 同一个 iframe 元素 —— 刷新是数据更新,不是导航。
    expect(wrapper.find('iframe').element).toBe(iframe)
  })
})

describe('webview 面板:token 闸', () => {
  it('缺 token / token 伪造的消息被静默丢弃', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    const { posted, contentWindow } = stubFrame(wrapper)
    await wrapper.find('iframe').trigger('load')
    const before = posted.length

    fromFrame(contentWindow, { type: 'invoke', requestId: 'x', actionId: 'export' })
    fromFrame(contentWindow, { token: 'forged', type: 'invoke', requestId: 'y', actionId: 'export' })
    await flushPromises()

    // 一次通道调用都没有,一条回帖都没发。
    expect(platformState.pluginRequest).toHaveBeenCalledTimes(1) // 只有最初那次 init
    expect(posted).toHaveLength(before)
  })

  it('陌生 source(别的 frame 冒充)被丢弃 —— origin 是 "null",不能当判据', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    const { posted } = stubFrame(wrapper)
    await wrapper.find('iframe').trigger('load')
    const token = posted[0].token
    const before = posted.length

    fromFrame({ postMessage: () => {} }, { token, type: 'invoke', requestId: 'z', actionId: 'export' })
    await flushPromises()

    expect(posted).toHaveLength(before)
  })
})

describe('webview 面板:拆除', () => {
  it('卸载后 window 上不留 message 监听,迟到的消息什么也触发不了', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    const { posted, contentWindow } = stubFrame(wrapper)
    await wrapper.find('iframe').trigger('load')
    const token = posted[0].token

    const removeSpy = vi.spyOn(window, 'removeEventListener')
    wrapper.unmount()
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function))

    platformState.pluginRequest.mockClear()
    fromFrame(contentWindow, { token, type: 'invoke', requestId: 'late', actionId: 'export' })
    await flushPromises()
    expect(platformState.pluginRequest).not.toHaveBeenCalled()
    removeSpy.mockRestore()
  })

  it('描述树面板一个字没变 —— webview 分支不影响既有路径', async () => {
    platformState.pluginRequest = vi.fn(async () => ({
      success: true,
      result: { version: 1, body: { type: 'markdown', text: 'hello' } },
    }))
    const wrapper = mount(PluginPanelHost, {
      props: { panel: { ...panel, view: 'descriptor' as const, entry: '', hasInit: false } },
    })
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(platformState.pluginRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: 'panel:render:chart',
    }))
  })
})
