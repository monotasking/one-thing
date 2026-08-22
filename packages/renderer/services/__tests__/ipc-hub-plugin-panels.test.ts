// @vitest-environment happy-dom
/**
 * R5:插件面板入口的清单是怎么装满的。
 *
 * 命题只有两条,但都很容易被写反:
 *  - 入口来自 **manifest 的 contributes.panels**,所以装清单这一步**不执行
 *    一行插件代码** —— 加载失败的插件照样有入口,并且能把失败说出来。
 *  - 停用的插件不贡献入口:用户把它关了,它的界面就该消失。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

function plugin(overrides: Record<string, unknown> = {}) {
  return {
    id: 'log-monitor',
    name: 'Log monitor',
    enabled: true,
    loaded: true,
    contributes: { panels: [{ id: 'logs', label: 'Agent logs' }] },
    ...overrides,
  }
}

const toastState = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  toast: {
    info: (...args: unknown[]) => toastState.info(...args),
    error: (...args: unknown[]) => toastState.error(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

describe('IPC hub → plugin workspace panels', () => {
  let getPlugins: Mock<() => Promise<{ success: boolean; plugins: Array<Record<string, unknown>> }>>
  let notify: ((payload: Record<string, unknown>) => void) | undefined

  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    toastState.info.mockReset()
    toastState.error.mockReset()
    notify = undefined
    getPlugins = vi.fn(async () => ({ success: true, plugins: [plugin()] }))

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onSessionEvent: vi.fn(() => vi.fn()),
        onSessionStream: vi.fn(() => vi.fn()),
        onPluginNotification: vi.fn((handler: (payload: Record<string, unknown>) => void) => {
          notify = handler
          return vi.fn()
        }),
        // P4 终态批 C2:目录清单走通用 RPC 的 `plugins` 域,不再是壳上的一条方法。
        rpcInvoke: async (request: { domain: string; method: string }) => {
          if (request.domain === 'plugins' && request.method === 'list') {
            return { ok: true, data: await getPlugins() }
          }
          return { ok: true, data: null }
        },
      },
    })
  })

  it('fills the panel list straight from the manifest projection', async () => {
    const { initializeIPCHub } = await import('../ipc-hub')
    const { usePluginWorkspacePanels } = await import('@/workspace/panel-registry')

    initializeIPCHub()
    await vi.waitFor(() => expect(usePluginWorkspacePanels().value).toHaveLength(1))

    expect(usePluginWorkspacePanels().value[0]).toEqual({
      pluginId: 'log-monitor',
      pluginName: 'Log monitor',
      panelId: 'logs',
      label: 'Agent logs',
      loaded: true,
      // C 期:形态与入口随清单过来;缺省是描述树面板,没有 init handler。
      view: 'descriptor',
      entry: '',
      hasInit: false,
      // H1:面板没声明 placements → 缺省 ['workspace'](只在主工作区)。
      placements: ['workspace'],
    })
  })

  it('carries workbench placement through the projection (H1)', async () => {
    getPlugins = vi.fn(async () => ({
      success: true,
      plugins: [plugin({
        contributes: { panels: [{ id: 'logs', label: 'Agent logs', placements: ['workspace', 'workbench'] }] },
      })],
    }))
    const { initializeIPCHub } = await import('../ipc-hub')
    const { usePluginWorkspacePanels, setPluginWorkspacePanels } = await import('@/workspace/panel-registry')
    setPluginWorkspacePanels([])

    initializeIPCHub()
    await vi.waitFor(() => expect(usePluginWorkspacePanels().value).toHaveLength(1))
    expect(usePluginWorkspacePanels().value[0].placements).toEqual(['workspace', 'workbench'])
  })

  it('keeps the entry of an enabled plugin that failed to load', async () => {
    getPlugins = vi.fn(async () => ({ success: true, plugins: [plugin({ loaded: false })] }))
    const { initializeIPCHub } = await import('../ipc-hub')
    const { usePluginWorkspacePanels } = await import('@/workspace/panel-registry')

    initializeIPCHub()
    await vi.waitFor(() => expect(usePluginWorkspacePanels().value).toHaveLength(1))
    expect(usePluginWorkspacePanels().value[0].loaded).toBe(false)
  })

  it('drops the entry once the plugin is disabled', async () => {
    getPlugins = vi.fn(async () => ({ success: true, plugins: [plugin({ enabled: false })] }))
    const { initializeIPCHub } = await import('../ipc-hub')
    const { usePluginWorkspacePanels, setPluginWorkspacePanels } = await import('@/workspace/panel-registry')
    // 上一条用例留下的清单不该影响这一条 —— 注册表是模块级单例。
    setPluginWorkspacePanels([])

    initializeIPCHub()
    await vi.waitFor(() => expect(getPlugins).toHaveBeenCalled())
    expect(usePluginWorkspacePanels().value).toEqual([])
  })

  it('never toasts a mechanical signal — kind is the judge, not one hard-coded name', async () => {
    // 这是 R5 评审抓到的真症状:判定曾经只豁免 config-changed,于是插件每次
    // ctx.refresh() 用户都收到一条 `plugin-panel-refresh:log-monitor:logs` 弹窗。
    // 判据必须是"有没有 kind" —— 白名单的反面每加一种信号都要记得回来改。
    const { initializeIPCHub } = await import('../ipc-hub')
    initializeIPCHub()
    await vi.waitFor(() => expect(notify).toBeTypeOf('function'))

    notify?.({ pluginId: 'log-monitor', message: 'plugin-panel-refresh:log-monitor:logs', level: 'info', kind: 'panel-refresh' })
    notify?.({ pluginId: 'log-monitor', message: 'plugin-config-changed:log-monitor', level: 'info', kind: 'config-changed' })
    notify?.({ pluginId: 'log-monitor', message: 'plugin-catalog-changed:*', level: 'info', kind: 'catalog-changed' })
    await flushMicrotasks()

    expect(toastState.info).not.toHaveBeenCalled()
    expect(toastState.error).not.toHaveBeenCalled()

    // 给人看的通知不带 kind —— 它还是要弹。
    notify?.({ pluginId: 'log-monitor', message: 'Log folder is full', level: 'error' })
    expect(toastState.error).toHaveBeenCalledWith('Log folder is full')
  })

  it('pulls the catalog exactly once per notification', async () => {
    // 曾经同一条通知既直接调 refresh 又派发事件,于是每条通知拉两次。
    const { initializeIPCHub } = await import('../ipc-hub')
    initializeIPCHub()
    await vi.waitFor(() => expect(getPlugins).toHaveBeenCalled())

    // window 是整个文件共享的,前几条用例挂的监听还在 —— 先量一次"一轮派发
    // 值多少次拉取",再断言一条通知恰好等于一轮,而不是两轮。
    const baseline = getPlugins.mock.calls.length
    window.dispatchEvent(new Event('onething:plugins-changed'))
    await flushMicrotasks()
    const perDispatch = getPlugins.mock.calls.length - baseline
    expect(perDispatch).toBeGreaterThan(0)

    const before = getPlugins.mock.calls.length
    notify?.({ pluginId: 'log-monitor', message: 'plugin-catalog-changed:*', level: 'info', kind: 'catalog-changed' })
    await flushMicrotasks()

    expect(getPlugins.mock.calls.length - before).toBe(perDispatch)
  })

  it('does not re-pull the catalog for a panel-refresh (that one addresses the open panel)', async () => {
    const { initializeIPCHub } = await import('../ipc-hub')
    initializeIPCHub()
    await vi.waitFor(() => expect(getPlugins).toHaveBeenCalled())
    const before = getPlugins.mock.calls.length

    notify?.({ pluginId: 'log-monitor', message: 'x', level: 'info', kind: 'panel-refresh', panelId: 'logs' })
    await flushMicrotasks()

    expect(getPlugins.mock.calls.length).toBe(before)
  })

  it('picks up the winning plugin background from the same catalog pull (G 期,L2.5)', async () => {
    // 背景搭的是**同一班车**:同一次 getPlugins、同一条 plugins-changed。
    // 这条测试同时钉住撤除语义 —— 响应里没有 background 就读成 null,
    // 而不是"保持上一次"(那会让一次降级把一张撤不掉的图钉在屏幕上)。
    const { initializeIPCHub } = await import('../ipc-hub')
    const { usePluginBackground, setPluginBackground } = await import('@/workspace/background-registry')
    setPluginBackground(null)
    getPlugins.mockImplementation(async () => ({
      success: true,
      plugins: [plugin()],
      background: {
        pluginId: 'ink-brand',
        imageUrl: 'onething-plugin://ink-brand/bg.svg',
        darkImageUrl: 'onething-plugin://ink-brand/bg-dark.svg',
        opacity: 0.35,
        blur: 0,
        fit: 'cover',
      },
    }) as never)

    initializeIPCHub()
    await vi.waitFor(() => expect(usePluginBackground().value?.pluginId).toBe('ink-brand'))

    getPlugins.mockImplementation(async () => ({ success: true, plugins: [plugin()] }))
    window.dispatchEvent(new Event('onething:plugins-changed'))
    await vi.waitFor(() => expect(usePluginBackground().value).toBeNull())
  })

  it('picks up the winning plugin ambient from the same catalog pull (G2 —— 全窗动画覆盖)', async () => {
    // 氛围与背景搭同一班车。这条测试同时钉住**拆除撤层**语义:响应里没有
    // ambient 就读成 null,而不是"保持上一次"(那会让一次降级把一层撤不掉的
    // 动画钉在屏幕上)。
    const { initializeIPCHub } = await import('../ipc-hub')
    const { usePluginAmbient, setPluginAmbient } = await import('@/workspace/ambient-registry')
    setPluginAmbient(null)
    getPlugins.mockImplementation(async () => ({
      success: true,
      plugins: [plugin()],
      ambient: {
        pluginId: 'snow-scene',
        entryUrl: 'onething-plugin://snow-scene/ambient.html',
      },
    }) as never)

    initializeIPCHub()
    await vi.waitFor(() => expect(usePluginAmbient().value?.pluginId).toBe('snow-scene'))

    getPlugins.mockImplementation(async () => ({ success: true, plugins: [plugin()] }))
    window.dispatchEvent(new Event('onething:plugins-changed'))
    await vi.waitFor(() => expect(usePluginAmbient().value).toBeNull())
  })

  it('re-pulls the list when the plugin catalog changes', async () => {
    const { initializeIPCHub } = await import('../ipc-hub')

    initializeIPCHub()
    await vi.waitFor(() => expect(getPlugins).toHaveBeenCalled())
    // window 是整个文件共享的,前几条用例挂的监听还在 —— 只断言"又拉了一次",
    // 不断言绝对次数(那会变成在钉测试文件的执行顺序)。
    const before = getPlugins.mock.calls.length

    window.dispatchEvent(new Event('onething:plugins-changed'))
    await vi.waitFor(() => expect(getPlugins.mock.calls.length).toBeGreaterThan(before))
  })
})
