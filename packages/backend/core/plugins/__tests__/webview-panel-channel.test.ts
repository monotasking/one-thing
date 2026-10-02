/**
 * C 期验收:webview 面板的**注册语义**与**通道语义**。
 *
 * 三件事在这里被钉住:
 *  1. webview 面板的 render 挂 `panel:init:<id>`(返回初始化数据而不是描述树);
 *  2. 通道守卫按前缀分叉 —— init 只要求"纯数据",render 仍然要求一棵合法的树;
 *  3. 熔断的 surface **不因此分叉**:init/action 仍折成 `panel:<id>`,
 *     家族仍是 ui-request(降级只连坐这一个面板,不连坐插件其余能力)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_PANEL_INIT_ACTION,
  PLUGIN_PANEL_INVOKE_ACTION,
  PLUGIN_PANEL_PROTOCOL_VERSION,
  PLUGIN_PANEL_RENDER_ACTION,
  classifyPluginScope,
  createCorePluginAPI,
  describePluginPanelResultProblem,
  describePluginSurface,
  validatePluginContributes,
} from '../index.js'

function createApi(options: { declaredPanelIds: string[]; declaredWebviewPanelIds?: string[] }) {
  const created = (createCorePluginAPI as any)({
    pluginId: 'demo',
    declaredPanelIds: options.declaredPanelIds,
    declaredWebviewPanelIds: options.declaredWebviewPanelIds,
    scheduler: { schedule: () => {}, cancel: () => {} },
    store: { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] },
    host: { emitPanelRefresh: vi.fn() },
    logger: { log: () => {}, error: () => {} },
  })
  return created as { api: any; state: { requestHandlers: Map<string, any> } }
}

describe('registerWorkspacePanel:形态决定 action 名', () => {
  it('webview 面板挂 panel:init,描述树面板挂 panel:render', () => {
    const { api, state } = createApi({
      declaredPanelIds: ['chart', 'logs'],
      declaredWebviewPanelIds: ['chart'],
    })
    api.registerWorkspacePanel({ id: 'chart', render: () => ({ series: [1, 2, 3] }) })
    api.registerWorkspacePanel({ id: 'logs', render: () => ({ version: 2, body: { type: 'divider' } }) })

    expect(state.requestHandlers.has(`${PLUGIN_PANEL_INIT_ACTION}:chart`)).toBe(true)
    expect(state.requestHandlers.has(`${PLUGIN_PANEL_RENDER_ACTION}:chart`)).toBe(false)
    expect(state.requestHandlers.has(`${PLUGIN_PANEL_RENDER_ACTION}:logs`)).toBe(true)
    expect(state.requestHandlers.has(`${PLUGIN_PANEL_INIT_ACTION}:logs`)).toBe(false)
    // action 通道两种形态共用一条 —— 30s 预算/abort/熔断全继承,不另起一套。
    expect(state.requestHandlers.has(`${PLUGIN_PANEL_INVOKE_ACTION}:chart`)).toBe(true)
  })

  it('纯静态面板(零代码)合法:声明先于代码,不注册也不是错', () => {
    const { state } = createApi({ declaredPanelIds: ['chart'], declaredWebviewPanelIds: ['chart'] })
    // 一行 registerWorkspacePanel 都没调 —— 通道上自然什么也没有,
    // 宿主凭清单照样能把 iframe 挂起来(renderer 据 requestActions 判断)。
    expect(state.requestHandlers.size).toBe(0)
  })

  it('同一个 webview 面板注册两次仍然被拒(重复即错,与描述树面板同规)', () => {
    const { api, state } = createApi({ declaredPanelIds: ['chart'], declaredWebviewPanelIds: ['chart'] })
    api.registerWorkspacePanel({ id: 'chart', render: () => ({ a: 1 }) })
    api.registerWorkspacePanel({ id: 'chart', render: () => ({ a: 2 }) })
    expect(state.requestHandlers.size).toBe(2) // init + action,没有第三份
  })
})

describe('通道守卫按前缀分叉', () => {
  it('init 只要求纯数据 —— 任意 JSON 都放行', () => {
    expect(describePluginPanelResultProblem('panel:init:chart', { series: [1, 2], nested: { a: 'b' } })).toBeNull()
    expect(describePluginPanelResultProblem('panel:init:chart', null)).toBeNull()
    expect(describePluginPanelResultProblem('panel:init:chart', undefined)).toBeNull()
  })

  it('init 仍然禁函数成员(闭包过不了 postMessage 的结构化克隆)', () => {
    const problem = describePluginPanelResultProblem('panel:init:chart', { onClick: () => {} })
    expect(problem).toContain('pure data')
  })

  it('render 仍然要求一棵合法的描述树 —— 两条契约没有互相污染', () => {
    expect(describePluginPanelResultProblem('panel:render:logs', { series: [1] })).toBeTruthy()
    expect(describePluginPanelResultProblem('panel:render:logs', {
      version: PLUGIN_PANEL_PROTOCOL_VERSION,
      body: { type: 'divider' },
    })).toBeNull()
  })
})

describe('熔断语义不因 webview 分叉', () => {
  it('init 归 ui-request 家族', () => {
    expect(classifyPluginScope('request:panel:init:chart')).toBe('ui-request')
  })

  it('init/render/action 折成同一个 panel:<id>', () => {
    expect(describePluginSurface('request:panel:init:chart')).toBe('panel:chart')
    expect(describePluginSurface('request:panel:action:chart')).toBe('panel:chart')
    expect(describePluginSurface('request:panel:render:logs')).toBe('panel:logs')
  })
})

describe('manifest 校验', () => {
  it('panels 的 view/entry 只校验形状 —— 内容非法是"丢弃该 panel",不是拒载', () => {
    expect(validatePluginContributes({
      panels: [{ id: 'a', label: 'A', view: 'webview' }],
    })).toBeNull()
    expect(validatePluginContributes({
      panels: [{ id: 'a', label: 'A', view: 'webview', entry: '../escape.html' }],
    })).toBeNull()
    expect(validatePluginContributes({
      panels: [{ id: 'a', label: 'A', view: 1 }],
    })).toContain('view must be a string')
    expect(validatePluginContributes({ webviewRoot: 3 })).toContain('webviewRoot must be a string')
  })

  it('panels 的 placements 只校验形状(字符串数组)—— 缺省即 workspace(H1)', () => {
    // 缺省合法:老面板没有这个字段,零行为变化(append-only)。
    expect(validatePluginContributes({ panels: [{ id: 'a', label: 'A' }] })).toBeNull()
    // 合法声明:出现在两处宿主表面。
    expect(validatePluginContributes({
      panels: [{ id: 'a', label: 'A', placements: ['workspace', 'workbench'] }],
    })).toBeNull()
    // 形状错:不是数组 / 成员不是字符串。
    expect(validatePluginContributes({
      panels: [{ id: 'a', label: 'A', placements: 'workbench' }],
    })).toContain('placements must be an array')
    expect(validatePluginContributes({
      panels: [{ id: 'a', label: 'A', placements: ['workspace', 2] }],
    })).toContain('placements must be an array of strings')
  })

  it('锚点块声明 webview 当场拒载 —— 这不是版本偏斜,是任何宿主都不会给的能力', () => {
    const problem = validatePluginContributes({
      uiSlots: [{ anchor: 'composer.above', id: 'x', label: 'X', view: 'webview' }],
    })
    expect(problem).toContain('uiSlots[0].view is not supported')
  })
})
