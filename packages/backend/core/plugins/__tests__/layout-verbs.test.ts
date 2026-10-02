/**
 * 布局动词与**手势锚定**(I 期)。
 *
 * 治理原语本身是这一期的产出,所以钉的是它的三条边界:
 *  1. **窗内成功**:插件刚收到一次 `ui:action` 派发,动词就能用;
 *  2. **窗外结构化拒绝**:回 `gesture-required`,**不抛错、不计熔断** ——
 *     这是规则拒绝不是插件故障(与声明门同规);
 *  3. **没有布局的宿主回 unsupported**:CLI daemon / headless server 不接
 *     `applyLayoutVerb`,那里"开合侧栏"不是失败,是不存在。
 *
 * 外加拆除面:停用即清手势账 —— 否则"停用→立刻启用"能带回上一条生命周期
 * 里的手势,让一个刚装回来的插件在用户什么都没点的情况下先弹一次工作台。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_LAYOUT_GESTURE_WINDOW_MS,
  PLUGIN_UI_INVOKE_ACTION,
  createCorePluginAPI,
  forgetUiActionGestures,
  hasFreshUiActionGesture,
  noteUiActionGesture,
  type PluginLayoutResult,
  type PluginLayoutVerb,
} from '../index.js'

interface LayoutCall { pluginId: string; verb: PluginLayoutVerb; panelId?: string }

function createApi(options: { withHost?: boolean; pluginId?: string; throws?: boolean } = {}) {
  const pluginId = options.pluginId ?? 'plan-status'
  const calls: LayoutCall[] = []
  const failures: Array<{ pluginId: string; scope: string }> = []
  const errors: string[] = []

  const created = (createCorePluginAPI as any)({
    pluginId,
    declaredUiSlots: [{ anchor: 'composer.above', id: 'block', label: 'Block' }],
    scheduler: { schedule: () => {}, cancel: () => {} },
    store: { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] },
    host: {
      notify: () => {},
      emitPanelRefresh: () => {},
      ...(options.withHost === false
        ? {}
        : {
            applyLayoutVerb: (id: string, verb: PluginLayoutVerb, panelId?: string) => {
              if (options.throws) throw new Error('window is gone')
              calls.push({ pluginId: id, verb, panelId })
            },
          }),
    },
    logger: { log: () => {}, error: (message: string) => errors.push(message) },
    onPluginFailure: (input: { pluginId: string; scope: string }) =>
      failures.push({ pluginId: input.pluginId, scope: input.scope }),
  })

  const api = created.api as {
    ui: {
      toggleSidebar(): Promise<PluginLayoutResult>
      openWorkbench(panelId?: string): Promise<PluginLayoutResult>
    }
    registerUiSlot(registration: unknown): void
  }
  return { api, state: created.state, calls, failures, errors, pluginId }
}

afterEach(() => {
  forgetUiActionGestures()
  vi.useRealTimers()
})

describe('手势账本', () => {
  it('记一次就在窗内;过了窗口就不在了', () => {
    const now = 1_000_000
    noteUiActionGesture('p', now)
    expect(hasFreshUiActionGesture('p', now)).toBe(true)
    expect(hasFreshUiActionGesture('p', now + PLUGIN_LAYOUT_GESTURE_WINDOW_MS)).toBe(true)
    expect(hasFreshUiActionGesture('p', now + PLUGIN_LAYOUT_GESTURE_WINDOW_MS + 1)).toBe(false)
    // 从来没点过的插件没有手势(不是"很久以前点过")。
    expect(hasFreshUiActionGesture('other', now)).toBe(false)
  })

  it('按插件隔离:A 的点击不给 B 开门', () => {
    const now = 2_000_000
    noteUiActionGesture('a', now)
    expect(hasFreshUiActionGesture('b', now)).toBe(false)
  })

  it('拆除即清账(停用→立刻启用不该带回上一条生命周期的手势)', () => {
    const now = 3_000_000
    noteUiActionGesture('a', now)
    forgetUiActionGestures('a')
    expect(hasFreshUiActionGesture('a', now)).toBe(false)
  })
})

describe('api.ui 布局动词', () => {
  /** 走真实的记账点:宿主派发一次 `ui:action` 给这个插件的块。 */
  async function dispatchUiAction(created: ReturnType<typeof createApi>) {
    created.api.registerUiSlot({
      anchor: 'composer.above',
      id: 'block',
      render: () => ({ version: 2, body: { type: 'row', children: [] } }),
    })
    const handler = created.state.requestHandlers.get(`${PLUGIN_UI_INVOKE_ACTION}:composer.above:block`)
    expect(handler).toBeTypeOf('function')
    await handler!({ actionId: 'go' }, { requestId: 'r1' })
  }

  it('窗内:一次 ui:action 之后动词生效,命令投到宿主', async () => {
    const created = createApi()
    await dispatchUiAction(created)

    expect(await created.api.ui.toggleSidebar()).toEqual({ ok: true })
    expect(await created.api.ui.openWorkbench('logs')).toEqual({ ok: true })
    expect(created.calls).toEqual([
      { pluginId: 'plan-status', verb: 'toggle-sidebar', panelId: undefined },
      { pluginId: 'plan-status', verb: 'open-workbench', panelId: 'logs' },
    ])
    // 空 panelId = 只展开右栏,不带一个空串过线。
    await created.api.ui.openWorkbench('   ')
    expect(created.calls.at(-1)).toEqual({
      pluginId: 'plan-status', verb: 'open-workbench', panelId: undefined,
    })
    expect(created.failures).toEqual([])
  })

  it('窗外:gesture-required,不抛错、不计熔断、不投递', async () => {
    const created = createApi()

    const result = await created.api.ui.toggleSidebar()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('gesture-required')
    expect(result.reason).toContain(String(PLUGIN_LAYOUT_GESTURE_WINDOW_MS))
    expect(created.calls).toEqual([])
    // **规则拒绝不是插件故障** —— 熔断账上一条都不许有。
    expect(created.failures).toEqual([])
    // 但要说得出来:作者得知道为什么没反应。
    expect(created.errors.some(message => message.includes('gesture anchoring'))).toBe(true)
  })

  it('窗口过期后同样是 gesture-required(手势不是一次性通行证的永久版)', async () => {
    vi.useFakeTimers()
    const created = createApi()
    await dispatchUiAction(created)
    expect((await created.api.ui.toggleSidebar()).ok).toBe(true)

    vi.advanceTimersByTime(PLUGIN_LAYOUT_GESTURE_WINDOW_MS + 1)
    expect((await created.api.ui.openWorkbench()).error).toBe('gesture-required')
    expect(created.calls).toHaveLength(1)
    expect(created.failures).toEqual([])
  })

  it('宿主没有布局这回事(CLI daemon / headless server):unsupported,不计熔断', async () => {
    const created = createApi({ withHost: false })
    await dispatchUiAction(created)

    // 手势有了也没用 —— 那个宿主根本没有侧栏。
    expect(await created.api.ui.toggleSidebar()).toEqual({
      ok: false, error: 'unsupported', reason: 'this host has no window layout',
    })
    expect(created.failures).toEqual([])
  })

  it('宿主投递抛错:回失败结果而不是炸掉插件,也不计熔断', async () => {
    const created = createApi({ throws: true })
    await dispatchUiAction(created)

    const result = await created.api.ui.toggleSidebar()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('unsupported')
    // 投递失败是宿主侧的事故;插件照常活着,熔断账上不该记它一笔。
    expect(created.failures).toEqual([])
  })

  it('`ui:action` 是唯一记账点:render 拉一次不算手势', async () => {
    const created = createApi()
    created.api.registerUiSlot({
      anchor: 'composer.above',
      id: 'block',
      render: () => ({ version: 2, body: { type: 'row', children: [] } }),
    })
    const render = created.state.requestHandlers.get('ui:render:composer.above:block')
    await render!({ sessionId: 's1' }, { requestId: 'r0' })

    // 宿主"画了一次块"不是"用户点了一下" —— 否则每次重拉都等于开一次门。
    expect((await created.api.ui.toggleSidebar()).error).toBe('gesture-required')
    expect(created.calls).toEqual([])
  })
})
