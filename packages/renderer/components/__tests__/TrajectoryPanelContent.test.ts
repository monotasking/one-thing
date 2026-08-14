// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventRecord } from '@shared/ipc/session-events.js'
import TrajectoryPanelContent from '../TrajectoryPanelContent.vue'
import {
  requestTrajectoryInspect,
  resetPendingTrajectoryInspect,
} from '@/workspace/trajectory-inspect'

/**
 * 会话 store 的桩必须是**响应式**的:面板靠 `watch(currentSessionId)` 跟随会话,
 * 一个普通对象改字段不会触发 watch,那条"切会话重拉"的用例就会假绿。
 */
const holder = vi.hoisted(() => ({ store: null as { currentSessionId: string } | null }))
const rpc = vi.hoisted(() => ({
  list: vi.fn(),
  inspectCall: vi.fn(),
}))

vi.mock('@/stores/sessions', async () => {
  const { reactive } = await import('vue')
  holder.store = reactive({ currentSessionId: 's1' })
  return { useSessionsStore: () => holder.store }
})

const sessionsStore = new Proxy({} as { currentSessionId: string }, {
  get: (_t, prop) => Reflect.get(holder.store as object, prop),
  set: (_t, prop, value) => Reflect.set(holder.store as object, prop, value),
})

// 面板的唯一数据来路。桩在客户端这一层:通道本身(rpcInvoke → dispatchRpc)
// 有自己的测试,这里要钉的是**投影与跳转**。
vi.mock('@/platform/session-events-client', () => ({
  sessionEventsApi: {
    list: (...args: unknown[]) => rpc.list(...args),
    inspectCall: (...args: unknown[]) => rpc.inspectCall(...args),
  },
}))

const EVENTS: SessionEventRecord[] = [
  // 目录先写、信封后写(同一 turn-start 内的顺序),两者各自独立去重。
  {
    seq: 1,
    time: 1000,
    type: 'request/tools',
    data: {
      requestIndex: 1,
      toolsHash: 'catalog-one',
      tools: [{ name: 'read', description: '读文件' }],
    },
  },
  {
    seq: 2,
    time: 1000,
    type: 'request/header',
    data: {
      requestIndex: 1,
      provider: 'anthropic',
      model: 'claude-sonnet',
      systemPromptHash: 'abc123',
      toolsHash: 'catalog-one',
      reason: 'initial',
    },
  },
  { seq: 3, time: 1010, type: 'request/start', data: { requestIndex: 1, messageId: 'm1' } },
  { seq: 4, time: 1050, type: 'assistant/first-token', data: { requestIndex: 1, messageId: 'm1' } },
  {
    seq: 5,
    time: 1100,
    type: 'tool/call',
    data: { callId: 'c1', argumentsRaw: '{"file_path":"/a.ts"}', name: 'read', messageId: 'm1' },
  },
  {
    seq: 6,
    time: 1600,
    type: 'tool/result',
    data: { callId: 'c1', isError: false, resultPreview: 'file body', sourceSeq: 5 },
  },
  {
    seq: 7,
    time: 1700,
    type: 'request/end',
    data: { requestIndex: 1, stopReason: 'tool_use', usage: { inputTokens: 12, outputTokens: 34 } },
  },
  { seq: 8, time: 2000, type: 'request/start', data: { requestIndex: 2, messageId: 'm2' } },
  {
    seq: 9,
    time: 2100,
    type: 'tool/call',
    // 没有配对的 result —— 执行中 / 未收尾。
    data: { callId: 'c2', argumentsRaw: '{"command":"ls"}', name: 'bash', messageId: 'm2' },
  },
]

/**
 * 每个用例结束都要卸载。
 *
 * 面板的 inspect handoff 是**模块级**的一枚 ref:上一条用例遗留的活实例照样
 * 在 watch 它,而且它的 watcher 建得更早、先跑一步 —— 于是它把 pending 取走,
 * 当前用例的实例什么也没接到。这不是产品缺陷(一个窗口只有一条轨迹页签),
 * 但在测试里是货真价实的假红/假绿源。
 */
const mounted: Array<{ unmount: () => void }> = []

/**
 * 内存版 localStorage。
 *
 * happy-dom 这一档环境里 `globalThis.localStorage` 是 **Node 自带的空壳**
 * (属性齐、方法全 undefined,启动时那句 `--localstorage-file was provided
 * without a valid path` 就是它)—— 也就是 `trajectory-timeline-mode.ts` 里
 * `safeStorage()` 专门要挡的那个东西。产品代码在这种环境下正确地退化成"不持久",
 * 所以要钉持久化就得先给它一枚**真能存**的存储。
 */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => { map.clear() },
  } as Storage
}

function mountPanel() {
  const wrapper = mount(TrajectoryPanelContent)
  mounted.push(wrapper)
  return wrapper
}

describe('TrajectoryPanelContent', () => {
  afterEach(() => {
    while (mounted.length) mounted.pop()?.unmount()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetPendingTrajectoryInspect()
    // 条带档位是模块外的一枚 localStorage 记忆 —— 每条用例换一枚新的,不串味。
    vi.stubGlobal('localStorage', createMemoryStorage())
    sessionsStore.currentSessionId = 's1'
    rpc.list.mockResolvedValue({ events: EVENTS })
    rpc.inspectCall.mockResolvedValue({
      inspection: {
        callId: 'c1',
        name: 'read',
        argumentsRaw: '{"file_path":"/a.ts"}',
        callTime: 1100,
        callSeq: 4,
        resultPreview: 'file body',
        isError: false,
        resultTime: 1600,
        schema: { name: 'read', description: '读文件', parameters: { type: 'object' } },
      },
    })
  })

  it('按 requestIndex 分组,组头带模型名与开始时刻', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(rpc.list).toHaveBeenCalledWith({ sessionId: 's1' })
    const headers = wrapper.findAll('.ledger-group-header')
    expect(headers).toHaveLength(2)
    expect(headers[0].find('.lgh-label').text()).toContain('#1')
    expect(headers[0].find('.lgh-label').text()).toContain('claude-sonnet')
    // 组内计数只数工具行(刻度行不算一次调用)。
    expect(headers[0].find('.lgh-count').text()).toBe('1')
  })

  it('call/result 配成一行,耗时现算;没配到 result 的显示执行中', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const rows = wrapper.findAll('.trajectory-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.plr-title').text()).toBe('read')
    expect(rows[0].find('.plr-meta').text()).toContain('file_path=/a.ts')
    // 1600 − 1100 = 500ms,派生值,日志里没有这个字段。
    expect(rows[0].find('.row-timing').text()).toBe('500ms')
    expect(rows[1].find('.row-timing').text()).toBe('执行中')
  })

  it('主表不出 token 数 —— 那是 inspector 的事', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const ledger = wrapper.find('.trajectory-ledger').text()
    expect(ledger).not.toContain('12')
    expect(ledger).not.toContain('34')

    // 选中请求组头才看得到 usage。
    await wrapper.findAll('.group-open')[0].trigger('click')
    const inspector = wrapper.find('.trajectory-inspector').text()
    expect(inspector).toContain('12')
    expect(inspector).toContain('34')
    expect(inspector).toContain('abc123')
  })

  it('选中一行拉 inspection,Schema tab 有就展示', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.findAll('.trajectory-row')[0].trigger('click')
    await flushPromises()

    expect(rpc.inspectCall).toHaveBeenCalledWith({ sessionId: 's1', callId: 'c1' })
    // Payload 默认 tab:JSON 解析成功就格式化。
    expect(wrapper.find('.inspector-pre').text()).toContain('"file_path": "/a.ts"')

    const tabs = wrapper.findAll('.inspector-tab')
    await tabs[2].trigger('click')
    expect(wrapper.find('.trajectory-inspector').text()).toContain('读文件')
    expect(wrapper.find('.trajectory-inspector').text()).not.toContain('Schema unavailable')
  })

  it('schema 拿不到时写 unavailable,绝不回填', async () => {
    rpc.inspectCall.mockResolvedValue({
      inspection: {
        callId: 'c1',
        name: 'read',
        argumentsRaw: '{}',
        callTime: 1100,
        callSeq: 4,
      },
    })
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.findAll('.trajectory-row')[0].trigger('click')
    await flushPromises()
    await wrapper.findAll('.inspector-tab')[2].trigger('click')

    expect(wrapper.find('.trajectory-inspector').text()).toContain('Schema unavailable')
  })

  it('inspect 跳转在数据层定位那一行,并把 pending 用完即清', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    requestTrajectoryInspect({ sessionId: 's1', callId: 'c2' })
    await flushPromises()

    const rows = wrapper.findAll('.trajectory-row')
    expect(rows[1].classes()).toContain('is-active')
    expect(rows[0].classes()).not.toContain('is-active')

    // one-shot:第二次挂载不该再跳一次。
    const second = mountPanel()
    await flushPromises()
    expect(second.findAll('.trajectory-row').some(row => row.classes().includes('is-active')))
      .toBe(false)
  })

  it('跳转的 callId 没有账时不设选中态,并明说没有记录', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    requestTrajectoryInspect({ sessionId: 's1', callId: 'ghost' })
    await flushPromises()

    expect(wrapper.findAll('.trajectory-row').some(row => row.classes().includes('is-active')))
      .toBe(false)
    expect(wrapper.find('.panel-shell-status').text()).toContain('该调用无事件记录')
  })

  it('会话没有事件日志时是空态,不是错误', async () => {
    rpc.list.mockResolvedValue({ events: [] })
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('.trajectory-empty').exists()).toBe(true)
    expect(wrapper.find('.trajectory-empty').text()).toContain('没有事件记录')
  })

  // ── 时间条带(E2) ───────────────────────────────────────────────────────
  //
  // 条带与表读的是**同一份投影**,所以这里钉的全是"两边说的是不是同一件事":
  // 点条带能不能选中行、选中行条带亮不亮、档位换了会不会记住。

  it('条带按泳道出 span:assistant 段在上、工具在下,与 ledger 同源', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    // 请求 1:等待 + 生成 + 一次 read;请求 2:生成(未收尾)+ 一次未收尾的 bash。
    const spans = wrapper.findAll('.timeline-span')
    expect(spans).toHaveLength(5)
    expect(wrapper.findAll('.timeline-tick').map(tick => tick.text())).toEqual(['#1', '#2'])
  })

  it('点 span 选中 ledger 对应行;点 assistant 段选中请求组头', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    // 第 4 枚 = 工具泳道第一条(callId c1)。
    await wrapper.findAll('.timeline-span')[3].trigger('click')
    await flushPromises()

    expect(rpc.inspectCall).toHaveBeenCalledWith({ sessionId: 's1', callId: 'c1' })
    expect(wrapper.findAll('.trajectory-row')[0].classes()).toContain('is-active')

    // 第 1 枚 = 请求 1 的等待段 → 选中的是组头(inspector 显示请求信封)。
    await wrapper.findAll('.timeline-span')[0].trigger('click')
    expect(wrapper.find('.trajectory-inspector').text()).toContain('请求 #1')
    expect(wrapper.findAll('.trajectory-row').some(row => row.classes().includes('is-active')))
      .toBe(false)
  })

  it('表格选中 → 条带上对应 span 高亮(双向同步的另一半)', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.findAll('.trajectory-row')[1].trigger('click')
    await flushPromises()

    const spans = wrapper.findAll('.timeline-span')
    expect(spans[4].classes()).toContain('is-active')
    expect(spans[3].classes()).not.toContain('is-active')

    // 选中组头时亮的是那一组的 assistant 段,工具 span 不跟着亮。
    await wrapper.findAll('.group-open')[0].trigger('click')
    const afterGroup = wrapper.findAll('.timeline-span')
    expect(afterGroup[0].classes()).toContain('is-active')
    expect(afterGroup[2].classes()).not.toContain('is-active')
    expect(afterGroup[3].classes()).not.toContain('is-active')
  })

  it('档位切换持久化,重新挂载时读回来', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const options = wrapper.findAll('.timeline-mode .segmented-pill-item')
    expect(options.map(option => option.text())).toEqual(['序号', '时长'])
    expect(options[0].attributes('aria-checked')).toBe('true')

    await options[1].trigger('click')
    expect(localStorage.getItem('onething.trajectory.timelineMode')).toBe('duration')

    const second = mountPanel()
    await flushPromises()
    expect(second.findAll('.timeline-mode .segmented-pill-item')[1].attributes('aria-checked'))
      .toBe('true')
  })

  it('坏掉的档位记录当它不存在,退回默认档而不是让面板起不来', async () => {
    localStorage.setItem('onething.trajectory.timelineMode', 'zoomed')
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.findAll('.timeline-mode .segmented-pill-item')[0].attributes('aria-checked'))
      .toBe('true')
  })

  it('条带可以整条收起,收起后 ledger 还在', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const toggle = wrapper.findAll('.trajectory-reload')
      .find(button => button.text() === '收起时间线')!
    await toggle.trigger('click')

    expect(wrapper.find('.trajectory-timeline').exists()).toBe(false)
    expect(wrapper.findAll('.trajectory-row')).toHaveLength(2)
  })

  it('空会话没有条带,也没有档位丸', async () => {
    rpc.list.mockResolvedValue({ events: [] })
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('.trajectory-timeline').exists()).toBe(false)
    expect(wrapper.find('.timeline-mode').exists()).toBe(false)
  })

  it('切会话重拉,并清掉上一条会话的选中态', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.findAll('.trajectory-row')[0].trigger('click')
    await flushPromises()

    rpc.list.mockResolvedValue({ events: [] })
    sessionsStore.currentSessionId = 's2'
    await flushPromises()

    expect(rpc.list).toHaveBeenLastCalledWith({ sessionId: 's2' })
    expect(wrapper.find('.trajectory-empty').exists()).toBe(true)
  })
})
