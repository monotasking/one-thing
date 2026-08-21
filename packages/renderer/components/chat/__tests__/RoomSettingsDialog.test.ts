// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RoomSettingsDialog from '../RoomSettingsDialog.vue'
import { useAgentsStore } from '@/stores/agents'
import { useSessionsStore } from '@/stores/sessions'

const collab = vi.hoisted(() => ({
  roomUpdate: vi.fn(async () => ({ success: true })),
  roomSetBudgets: vi.fn(async () => ({ success: true })),
  roomSetFrozen: vi.fn(async () => ({ success: true })),
  roomSpendGet: vi.fn(async () => ({ success: true, spentTodayUSD: 1.234, dailyCostUSD: 5 })),
}))

const api = vi.hoisted(() => ({
  // 域已迁到通用 RPC 通道(主线 T1 第二批):打那一条通道,按 domain.method 分发。
  rpcInvoke: vi.fn(async (request: { domain: string; method: string }) => {
    if (request.domain === 'agents' && request.method === 'list') {
      return { ok: true, data: { success: true, agents: [] } }
    }
    if (request.domain === 'providers' && request.method === 'list') {
      return { ok: true, data: { success: true, providers: [] } }
    }
    if (request.domain === 'models' && request.method === 'getNameAliases') {
      return { ok: true, data: { success: true, aliases: {} } }
    }
    return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
  }),
  getSessions: vi.fn(async () => ({ success: true, sessions: [] })),
}))

vi.mock('@/platform', () => ({ platformApi: api }))
vi.mock('@/platform/collab-client', () => ({ collabApi: collab }))

const AGENTS = [
  { id: 'pm', name: '阿明', title: '产品经理', avatar: '📋', systemPrompt: '', createdAt: 0, updatedAt: 0 },
  { id: 'fe', name: '小李', title: '前端', avatar: '🔧', systemPrompt: '', createdAt: 0, updatedAt: 0 },
  { id: 'research', name: '小研', title: '研究员', avatar: '🔎', systemPrompt: '', createdAt: 0, updatedAt: 0 },
]

function seed(room?: Record<string, unknown>): void {
  const agentsStore = useAgentsStore()
  agentsStore.agents = AGENTS as never
  agentsStore.hasLoaded = true
  const sessionsStore = useSessionsStore()
  sessionsStore.sessions = [{
    id: 'room-1',
    name: '官网改版组',
    kind: 'room',
    permissionMode: 'normal',
    createdAt: 0,
    updatedAt: 0,
    room: room ?? { memberAgentIds: ['pm', 'fe'], pmAgentId: 'pm', budgets: { dailyCostUSD: 5 } },
  }] as never
}

async function open(room?: Record<string, unknown>) {
  seed(room)
  const wrapper = mount(RoomSettingsDialog, {
    props: { visible: true, sessionId: 'room-1' },
    // Stub the Teleport so the dialog stays inside the wrapper's tree.
    global: { stubs: { teleport: true } },
  })
  await nextTick()
  await nextTick()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  collab.roomUpdate.mockClear()
  collab.roomSetBudgets.mockClear()
  collab.roomSetFrozen.mockClear()
  collab.roomSpendGet.mockClear()
  collab.roomSpendGet.mockResolvedValue({ success: true, spentTodayUSD: 1.234, dailyCostUSD: 5 })
})

// W13.5: 预算面板最小形态 — what the room cost today, taken once on open.
describe('RoomSettingsDialog 花费行', () => {
  /** The spend read is a separate async hop after the agents load. */
  async function openWithSpend() {
    const wrapper = await open()
    await nextTick()
    await nextTick()
    return wrapper
  }

  it('reads spend once and prints it to the cent', async () => {
    const wrapper = await openWithSpend()
    expect(collab.roomSpendGet).toHaveBeenCalledTimes(1)
    expect(collab.roomSpendGet).toHaveBeenCalledWith({ roomSessionId: 'room-1' })
    expect(wrapper.find('.spend-line').text()).toBe('今日已用 $1.23')
    wrapper.unmount()
  })

  it('still shows the spend when the room has no cap (0 = 不限额)', async () => {
    collab.roomSpendGet.mockResolvedValue({ success: true, spentTodayUSD: 0.5, dailyCostUSD: 0 })
    const wrapper = await openWithSpend()
    expect(wrapper.find('.spend-line').text()).toBe('今日已用 $0.50')
    wrapper.unmount()
  })

  it('says nothing rather than something wrong when the read fails', async () => {
    collab.roomSpendGet.mockResolvedValue({ success: false, error: 'ledger down' } as never)
    const wrapper = await openWithSpend()
    expect(wrapper.find('.spend-line').exists()).toBe(false)
    expect(wrapper.find('.room-error').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('RoomSettingsDialog', () => {
  it('shows every room member with a lit tick and the rest unlit', async () => {
    const wrapper = await open()
    const lines = wrapper.findAll('.member-line')
    // 3 agents + the freeze switch row + the danger-zone clear button.
    expect(lines).toHaveLength(5)
    expect(lines[0].classes()).toContain('is-on')
    expect(lines[1].classes()).toContain('is-on')
    expect(lines[2].classes()).not.toContain('is-on')
    expect(wrapper.text()).toContain('小研')
    wrapper.unmount()
  })

  it('sends only the changed items, and the roster change in one room update', async () => {
    const wrapper = await open()
    await wrapper.findAll('.member-line')[2].trigger('click') // + 小研
    await wrapper.findAll('.app-dialog-text-btn')[1].trigger('click') // 保存
    await nextTick()

    expect(collab.roomUpdate).toHaveBeenCalledTimes(1)
    expect(collab.roomUpdate.mock.calls[0]).toEqual([{
      roomSessionId: 'room-1',
      memberAgentIds: ['pm', 'fe', 'research'],
    }])
    expect(collab.roomSetBudgets).not.toHaveBeenCalled()
    expect(collab.roomSetFrozen).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  /**
   * 三条写路径都经 sessions store 的 action(架构收敛 C4 §4)。桩掉 action 之后桥
   * 一次都不该被碰到 —— 回填约定(`session:collab-updated`)因此只写在一处。
   */
  it('writes through the sessions store actions, not the bridge', async () => {
    const sessionsStore = useSessionsStore()
    const updateCollabRoom = vi.spyOn(sessionsStore, 'updateCollabRoom')
      .mockResolvedValue({ success: true } as never)
    const setFrozen = vi.spyOn(sessionsStore, 'setCollabRoomFrozen')
      .mockResolvedValue({ success: true } as never)
    const wrapper = await open()

    await wrapper.findAll('.member-line')[2].trigger('click') // + 小研
    await wrapper.findAll('.member-line')[3].trigger('click') // 暂停房间
    await wrapper.findAll('.app-dialog-text-btn')[1].trigger('click') // 保存
    await nextTick()

    expect(updateCollabRoom).toHaveBeenCalledWith('room-1', {
      memberAgentIds: ['pm', 'fe', 'research'],
    })
    expect(setFrozen).toHaveBeenCalledWith('room-1', true)
    expect(collab.roomUpdate).not.toHaveBeenCalled()
    expect(collab.roomSetFrozen).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('drops the PM when the PM is unticked, and clears it with null', async () => {
    const wrapper = await open()
    await wrapper.findAll('.member-line')[0].trigger('click') // − 阿明 (PM)
    await wrapper.findAll('.app-dialog-text-btn')[1].trigger('click')
    await nextTick()

    expect(collab.roomUpdate.mock.calls[0]).toEqual([{
      roomSessionId: 'room-1',
      memberAgentIds: ['fe'],
      pmAgentId: null,
    }])
    wrapper.unmount()
  })

  it('saves the freeze switch through its own channel and closes on a no-op save', async () => {
    const wrapper = await open()
    await wrapper.findAll('.member-line')[3].trigger('click') // 暂停房间
    await wrapper.findAll('.app-dialog-text-btn')[1].trigger('click')
    await nextTick()
    expect(collab.roomSetFrozen).toHaveBeenCalledWith({ roomSessionId: 'room-1', frozen: true })
    expect(collab.roomUpdate).not.toHaveBeenCalled()
    wrapper.unmount()

    const untouched = await open()
    await untouched.findAll('.app-dialog-text-btn')[1].trigger('click')
    await nextTick()
    expect(collab.roomUpdate).not.toHaveBeenCalled()
    expect(untouched.emitted('close')).toBeTruthy()
    untouched.unmount()
  })

  it('refuses to save an empty roster and surfaces a backend error', async () => {
    const wrapper = await open()
    await wrapper.findAll('.member-line')[0].trigger('click')
    await wrapper.findAll('.member-line')[1].trigger('click')
    await wrapper.findAll('.app-dialog-text-btn')[1].trigger('click')
    await nextTick()
    expect(collab.roomUpdate).not.toHaveBeenCalled()
    expect(wrapper.find('.room-error').text()).toBe('房间至少需要一名成员')

    collab.roomUpdate.mockResolvedValueOnce({ success: false, error: 'Unknown agent: ghost' } as never)
    await wrapper.findAll('.member-line')[2].trigger('click')
    await wrapper.findAll('.app-dialog-text-btn')[1].trigger('click')
    await nextTick()
    expect(wrapper.find('.room-error').text()).toBe('Unknown agent: ghost')
    expect(wrapper.emitted('close')).toBeFalsy()
    wrapper.unmount()
  })
})

/**
 * dm 房的名册只读(agent-im-dm.md P1b 遗留发现 4)。
 *
 * 形态即身份:人数决定这间房是什么,而它的 id、房名、免判激活、链长闸默认值
 * 全部建立在这个人数上。加个人就把私聊变成群 —— 那是另一个动作,不该藏在这
 * 张设置表的一次点击里。其余每一格(预算、断路器、权限、暂停)照常。
 */
describe('RoomSettingsDialog · dm 房的名册只读', () => {
  it('双成员 dm 房:成员只读、没有负责人那一格,预算等照常', async () => {
    const wrapper = await open({ memberAgentIds: ['pm', 'fe'], dm: true })
    // 可点的成员行一个都没有(「暂停房间」共用 .member-line 画线,但它没有头像),
    // 只剩陈述用的静态行。
    expect(wrapper.findAll('button.member-line .member-avatar')).toHaveLength(0)
    const statics = wrapper.findAll('.member-line.is-static')
    expect(statics.map(row => row.find('.member-name').text())).toEqual(['阿明', '小李'])
    expect(wrapper.text()).toContain('私聊的成员不能增删')
    expect(wrapper.text()).not.toContain('负责人(PM)')
    // 其余设置照常:预算/链长/断路器/权限四个输入 + 暂停开关都还在。
    expect(wrapper.text()).toContain('日预算(美元)')
    expect(wrapper.text()).toContain('连续发言上限')
    expect(wrapper.text()).toContain('权限模式')
    expect(wrapper.text()).toContain('暂停房间')
    wrapper.unmount()
  })

  it('单成员 dm 房同解 —— 判定读 dm 标记本身,与人数无关', async () => {
    const wrapper = await open({ memberAgentIds: ['fe'], dm: true })
    expect(wrapper.findAll('button.member-line .member-avatar')).toHaveLength(0)
    expect(wrapper.findAll('.member-line.is-static')).toHaveLength(1)
    wrapper.unmount()
  })

  it('普通群零变化(正控):成员可点、负责人那一格还在', async () => {
    const wrapper = await open()
    expect(wrapper.findAll('button.member-line .member-avatar').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.member-line.is-static')).toHaveLength(0)
    expect(wrapper.text()).toContain('负责人(PM)')
    wrapper.unmount()
  })
})
