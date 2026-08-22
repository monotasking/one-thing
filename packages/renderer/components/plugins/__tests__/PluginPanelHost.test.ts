// @vitest-environment happy-dom
/**
 * R5 验收(渲染侧):描述树的呈现、动作回程、主动刷新、软隔离错误态、
 * 以及方案 A 的 web 降级。
 *
 * 这里刻意**不 mock PluginPanelNode** —— 要验的正是"UI 用宿主原语把一棵纯数据
 * 的树画出来",把渲染器换成占位组件等于把命题本身挖掉。
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

// MessageMarkdown 拖着整条 shiki 高亮链,对本命题毫无贡献。
vi.mock('@/components/chat/message/MessageMarkdown.vue', () => ({
  default: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
}))

const panel = {
  pluginId: 'log-monitor',
  pluginName: 'Log monitor',
  panelId: 'logs',
  label: 'Agent logs',
  loaded: true,
}

function tree(text: string) {
  return {
    version: 1,
    body: {
      type: 'stack',
      children: [
        { type: 'markdown', text },
        { type: 'button', label: 'Clean up', actionId: 'cleanup' },
      ],
    },
  }
}

/** 从既有的 plugin:notification 轨推一条刷新信号。 */
function pushRefresh(overrides: Record<string, unknown> = {}): void {
  const message = { pluginId: 'log-monitor', panelId: 'logs', kind: 'panel-refresh', ...overrides }
  platformState.notificationHandlers.forEach(handler => handler(message))
}

beforeEach(() => {
  platformState.environment = 'electron'
  platformState.pluginRequest.mockReset()
  platformState.notificationHandlers = []
  toastState.error.mockReset()
  toastState.info.mockReset()
})

describe('PluginPanelHost', () => {
  it('renders the description tree with host primitives', async () => {
    platformState.pluginRequest.mockResolvedValue({ success: true, result: tree('buffer: 3 entries') })

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()

    expect(platformState.pluginRequest).toHaveBeenCalledWith({
      pluginId: 'log-monitor',
      action: 'panel:render:logs',
    })
    expect(wrapper.text()).toContain('buffer: 3 entries')
    expect(wrapper.text()).toContain('Clean up')
  })

  it('sends a button press back as actionId + payload and re-pulls on refresh', async () => {
    platformState.pluginRequest
      .mockResolvedValueOnce({ success: true, result: tree('before') })
      .mockResolvedValueOnce({ success: true, result: { refresh: true, notice: 'Cleaned up.' } })
      .mockResolvedValueOnce({ success: true, result: tree('after') })

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text() === 'Clean up')!.trigger('click')
    await flushPromises()

    expect(platformState.pluginRequest.mock.calls[1][0]).toEqual({
      pluginId: 'log-monitor',
      action: 'panel:action:logs',
      payload: { actionId: 'cleanup', payload: undefined },
    })
    expect(toastState.info).toHaveBeenCalledWith('Cleaned up.')
    expect(wrapper.text()).toContain('after')
  })

  it('sends a payload that can actually cross the process boundary', async () => {
    /*
     * **真机走查抓到的缺陷的回归防线。**
     *
     * 描述树存在 `ref` 里,而 `ref` 对对象是深层响应式 —— 从树上读出来的
     * `item.payload` 是 Vue Proxy,Electron 的 structured clone 克隆不了它,
     * 点任何带 payload 的元素都会得到 "an object could not be cloned"。
     *
     * 既有用例喂的是**手搓的 plain object**,所以它们从来碰不到这条路径 ——
     * 这也正是它们没抓到的原因。这条用例让 payload 走真实的那条路:
     * 由 pluginRequest 返回 → 进 ref → 被渲染 → 点击回传。
     */
    const listTree = {
      version: 1,
      body: {
        type: 'list',
        title: 'Files',
        items: [
          { id: 'a', title: 'a.log', actionId: 'select', payload: { name: 'a.log', meta: { size: 12 } } },
        ],
      },
    }
    platformState.pluginRequest
      .mockResolvedValueOnce({ success: true, result: listTree })
      .mockResolvedValueOnce({ success: true, result: { refresh: false } })

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()

    await wrapper.find('.panel-list-row').trigger('click')
    await flushPromises()

    const sent = platformState.pluginRequest.mock.calls[1][0]
    // 判据就是真机上炸掉的那一步:能不能被结构化克隆。
    expect(() => structuredClone(sent)).not.toThrow()
    // 而且内容不能在脱壳过程中走样。
    expect(sent.payload).toEqual({ actionId: 'select', payload: { name: 'a.log', meta: { size: 12 } } })
  })

  it('sends a cloneable payload from a form submit too', async () => {
    // `{ ...formState }` 是浅拷贝 —— 嵌套的数组/对象仍是 proxy,
    // 所以表单这条路和 list 那条路要分别钉住。
    const formTree = {
      version: 1,
      body: {
        type: 'form',
        submitActionId: 'save',
        fields: [
          { key: 'tags', label: 'Tags', control: 'string-list', value: ['a', 'b'] },
          { key: 'enabled', label: 'Enabled', control: 'switch', value: true },
        ],
      },
    }
    platformState.pluginRequest
      .mockResolvedValueOnce({ success: true, result: formTree })
      .mockResolvedValueOnce({ success: true, result: { refresh: false } })

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()

    const sent = platformState.pluginRequest.mock.calls[1][0]
    expect(() => structuredClone(sent)).not.toThrow()
    expect(sent.payload).toEqual({ actionId: 'save', payload: { tags: ['a', 'b'], enabled: true } })
  })

  it('re-pulls when the plugin pushes a panel-refresh notification', async () => {
    platformState.pluginRequest
      .mockResolvedValueOnce({ success: true, result: tree('first') })
      .mockResolvedValueOnce({ success: true, result: tree('second') })

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    expect(wrapper.text()).toContain('first')

    // 走的是既有的 plugin:notification 轨,不是新开的一条。
    pushRefresh()
    await vi.waitFor(() => expect(wrapper.text()).toContain('second'))
  })

  it('coalesces a burst of refreshes into a single re-pull', async () => {
    // 插件在一次批量操作里对每个变化调一次 refresh 是完全合理的写法。
    // 没有合流的话,那是 N 次 render 往返,而且并发返回还能乱序覆盖。
    platformState.pluginRequest.mockResolvedValue({ success: true, result: tree('state') })

    mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    expect(platformState.pluginRequest).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 10; i += 1) pushRefresh()
    await vi.waitFor(() => expect(platformState.pluginRequest).toHaveBeenCalledTimes(2))
    // 再等一个窗口,确认没有第二波补拉。
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(platformState.pluginRequest).toHaveBeenCalledTimes(2)
  })

  it('lets the newest render win when responses come back out of order', async () => {
    // 通道不保证按发出顺序返回。先发的那次后到,就会用一棵旧树盖掉新树 ——
    // 而且盖完看不出哪里错了。
    let releaseFirst: (() => void) | undefined
    platformState.pluginRequest
      .mockImplementationOnce(async () => {
        await new Promise<void>(resolve => { releaseFirst = resolve })
        return { success: true, result: tree('stale') }
      })
      .mockResolvedValueOnce({ success: true, result: tree('fresh') })

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()

    pushRefresh()
    await vi.waitFor(() => expect(platformState.pluginRequest).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(wrapper.text()).toContain('fresh'))

    // 第一次现在才回来 —— 它必须被丢弃。
    releaseFirst?.()
    await flushPromises()
    expect(wrapper.text()).toContain('fresh')
    expect(wrapper.text()).not.toContain('stale')
  })

  it('ignores a refresh addressed at another plugin', async () => {
    platformState.pluginRequest.mockResolvedValue({ success: true, result: tree('first') })

    mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    expect(platformState.pluginRequest).toHaveBeenCalledTimes(1)

    pushRefresh({ pluginId: 'notes', panelId: 'inbox' })
    await new Promise(resolve => setTimeout(resolve, 250))

    expect(platformState.pluginRequest).toHaveBeenCalledTimes(1)
  })

  it('renders an unsupported node as a visible placeholder, not as blank space', async () => {
    // 通道守卫会先拒掉这种树,所以这条路径只在守卫被绕开时可见 ——
    // 但"看得见的占位"和"静默空白"是两种事故:后者只会让人以为面板坏了。
    platformState.pluginRequest.mockResolvedValue({
      success: true,
      result: { version: 1, body: { type: 'hologram', payload: {} } },
    })

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()

    expect(wrapper.text()).toContain('Unsupported panel element "hologram"')
  })

  it('shows an error state (not a blank panel) when render fails, and retries', async () => {
    platformState.pluginRequest
      .mockResolvedValueOnce({ success: false, error: 'Panel "logs" produced an invalid tree' })
      .mockResolvedValueOnce({ success: true, result: tree('recovered') })

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()
    expect(wrapper.text()).toContain('produced an invalid tree')

    await wrapper.findAll('button').find(button => button.text() === 'Retry')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('recovered')
  })

  it('keeps the entry but explains itself when the plugin failed to load', async () => {
    const wrapper = mount(PluginPanelHost, { props: { panel: { ...panel, loaded: false } } })
    await flushPromises()

    expect(platformState.pluginRequest).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('is not running')
  })

  it('catches a render-time throw from a host primitive instead of taking the shell down', async () => {
    // 通道守卫管的是**形状**;一棵形状合法的树照样可能让某个宿主原语在渲染中抛。
    // 没有边界的话,那一抛会顺着组件树往上炸掉整个工作区 —— 软隔离在 UI 侧漏一个口。
    const { default: MessageMarkdown } = await import('@/components/chat/message/MessageMarkdown.vue')
    ;(MessageMarkdown as unknown as { setup?: unknown }).setup = () => {
      throw new Error('markdown blew up')
    }
    platformState.pluginRequest.mockResolvedValue({ success: true, result: tree('boom') })

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()

    expect(wrapper.text()).toContain('markdown blew up')
    delete (MessageMarkdown as unknown as { setup?: unknown }).setup
  })

  it('says desktop-only on the web instead of rendering a fake panel (plan A)', async () => {
    platformState.environment = 'web'

    const wrapper = mount(PluginPanelHost, { props: { panel } })
    await flushPromises()

    expect(platformState.pluginRequest).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Available on desktop only')
  })

  it('polls by the tree\'s refreshIntervalMs and stops on error (v2)', async () => {
    vi.useFakeTimers()
    try {
      platformState.pluginRequest.mockResolvedValue({
        success: true,
        result: { ...tree('tick'), refreshIntervalMs: 1000 },
      })

      mount(PluginPanelHost, { props: { panel } })
      await flushPromises()
      expect(platformState.pluginRequest).toHaveBeenCalledTimes(1)

      // 可见时按周期重拉(测试环境无 IntersectionObserver,按"始终可见"处理)。
      await vi.advanceTimersByTimeAsync(3000)
      expect(platformState.pluginRequest).toHaveBeenCalledTimes(4)

      // 出错即停:轮询不该把错误态刷没,也不该一次次撞闸。
      platformState.pluginRequest.mockResolvedValue({ success: false, error: 'boom' })
      await vi.advanceTimersByTimeAsync(5000)
      const calls = platformState.pluginRequest.mock.calls.length
      expect(calls).toBe(5) // 只多了出错的那一次
      await vi.advanceTimersByTimeAsync(5000)
      expect(platformState.pluginRequest).toHaveBeenCalledTimes(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})
