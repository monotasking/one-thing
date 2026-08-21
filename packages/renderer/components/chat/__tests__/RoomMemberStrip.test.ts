// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RoomMemberStrip from '../RoomMemberStrip.vue'
import { useAgentsStore } from '@/stores/agents'
import { useSessionsStore } from '@/stores/sessions'
import { OPEN_MEMBERS_EVENT } from '@/components/workbench/room-members'

const collab = vi.hoisted(() => ({
  roomUpdate: vi.fn(async () => ({ success: true }) as { success: boolean; error?: string }),
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

function seed(memberAgentIds: string[] = ['pm', 'fe'], pmAgentId = 'pm', dm = false): void {
  const agentsStore = useAgentsStore()
  agentsStore.agents = AGENTS as never
  agentsStore.hasLoaded = true
  const sessionsStore = useSessionsStore()
  sessionsStore.sessions = [{
    id: 'room-1',
    name: '官网改版组',
    kind: 'room',
    createdAt: 0,
    updatedAt: 0,
    room: { memberAgentIds, pmAgentId, ...(dm ? { dm: true } : {}) },
  }] as never
}

async function open(memberAgentIds?: string[], pmAgentId?: string, dm = false) {
  seed(memberAgentIds, pmAgentId, dm)
  const wrapper = mount(RoomMemberStrip, {
    props: { sessionId: 'room-1' },
    global: { stubs: { teleport: true } },
  })
  await nextTick()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  collab.roomUpdate.mockClear()
  collab.roomUpdate.mockResolvedValue({ success: true })
})

describe('RoomMemberStrip', () => {
  it('stamps one chip per member plus the ＋, and marks the lead', async () => {
    const wrapper = await open()
    const chips = wrapper.findAll('.member-chip:not(.member-add)')
    expect(chips.map(chip => chip.text())).toEqual(['📋', '🔧'])
    expect(chips[0].classes()).toContain('is-pm')
    expect(chips[1].classes()).not.toContain('is-pm')
    expect(chips[0].attributes('aria-label')).toBe('阿明 · 产品经理 · 负责人')
    expect(wrapper.find('.member-add').exists()).toBe(true)
    wrapper.unmount()
  })

  it('hides the ＋ when there is nobody left to pull in', async () => {
    const wrapper = await open(['pm', 'fe', 'research'])
    expect(wrapper.find('.member-add').exists()).toBe(false)
    wrapper.unmount()
  })

  it('pulls somebody in through the one room-update channel', async () => {
    const wrapper = await open()
    await wrapper.find('.member-add').trigger('click')
    const items = wrapper.findAll('.app-context-item')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('小研')

    await items[0].trigger('click')
    await nextTick()
    expect(collab.roomUpdate.mock.calls[0]).toEqual([
      { roomSessionId: 'room-1', memberAgentIds: ['pm', 'fe', 'research'] },
    ])
    wrapper.unmount()
  })

  it('pushes somebody out, vacating the lead seat when the lead leaves', async () => {
    const wrapper = await open()
    await wrapper.findAll('.member-chip:not(.member-add)')[0].trigger('contextmenu')
    const items = wrapper.findAll('.app-context-item')
    // The lead gets no 设为负责人 row — it already is one.
    expect(items.map(item => item.text())).toEqual(['移出群聊'])

    await items[0].trigger('click')
    await nextTick()
    expect(collab.roomUpdate.mock.calls[0]).toEqual([
      { roomSessionId: 'room-1', memberAgentIds: ['fe'], pmAgentId: null },
    ])
    wrapper.unmount()
  })

  it('hands the lead over from the chip menu', async () => {
    const wrapper = await open()
    await wrapper.findAll('.member-chip:not(.member-add)')[1].trigger('contextmenu')
    const items = wrapper.findAll('.app-context-item')
    expect(items.map(item => item.text())).toEqual(['设为负责人', '移出群聊'])

    await items[0].trigger('click')
    await nextTick()
    expect(collab.roomUpdate.mock.calls[0]).toEqual([{ roomSessionId: 'room-1', pmAgentId: 'fe' }])
    wrapper.unmount()
  })

  it('says why the last member cannot be removed instead of failing silently', async () => {
    const wrapper = await open(['fe'], '')
    await wrapper.findAll('.member-chip:not(.member-add)')[0].trigger('contextmenu')
    await wrapper.findAll('.app-context-item').at(-1)!.trigger('click')
    await nextTick()
    expect(collab.roomUpdate).not.toHaveBeenCalled()
    expect(wrapper.find('.member-error').text()).toBe('房间至少需要一名成员')
    wrapper.unmount()
  })

  /**
   * 双成员 dm 房(agent-im-dm.md §4.3 + P1b 遗留发现 4):同一条成员条的紧凑
   * 形态,而且名册**只读** —— 形态即身份,加个人就把私聊变成了群。
   */
  describe('双成员 dm 房', () => {
    it('两枚头像紧凑排列,没有 ＋', async () => {
      const wrapper = await open(['pm', 'fe'], '', true)
      expect(wrapper.find('.room-members').classes()).toContain('is-pair-dm')
      expect(wrapper.findAll('.member-chip:not(.member-add)')).toHaveLength(2)
      expect(wrapper.find('.member-add').exists()).toBe(false)
      wrapper.unmount()
    })

    it('点头像不开菜单:移出/设为负责人在私聊里都不成立', async () => {
      const wrapper = await open(['pm', 'fe'], '', true)
      await wrapper.findAll('.member-chip')[0].trigger('click')
      await nextTick()
      expect(wrapper.findAll('.app-context-item')).toHaveLength(0)
      await wrapper.findAll('.member-chip')[0].trigger('contextmenu')
      await nextTick()
      expect(wrapper.findAll('.app-context-item')).toHaveLength(0)
      expect(collab.roomUpdate).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('群房零变化(正控):＋ 与成员菜单照旧', async () => {
      const wrapper = await open(['pm', 'fe'])
      expect(wrapper.find('.room-members').classes()).not.toContain('is-pair-dm')
      expect(wrapper.find('.member-add').exists()).toBe(true)
      await wrapper.findAll('.member-chip:not(.member-add)')[1].trigger('click')
      await nextTick()
      expect(wrapper.findAll('.app-context-item').length).toBeGreaterThan(0)
      wrapper.unmount()
    })
  })

  describe('R2:新房面的左键 = 下钻空间页', () => {
    async function openSpaceStrip() {
      seed(['pm', 'fe'], 'pm')
      const wrapper = mount(RoomMemberStrip, {
        props: { sessionId: 'room-1', openSpaceOnClick: true },
        global: { stubs: { teleport: true } },
      })
      await nextTick()
      return wrapper
    }

    it('左键派 open-members(带 agentId = 直接落在空间页),不再开名册菜单', async () => {
      const wrapper = await openSpaceStrip()
      const seen: unknown[] = []
      const listener = (event: Event) => seen.push((event as CustomEvent).detail)
      window.addEventListener(OPEN_MEMBERS_EVENT, listener)
      await wrapper.findAll('.member-chip:not(.member-add)')[1].trigger('click')
      await nextTick()
      window.removeEventListener(OPEN_MEMBERS_EVENT, listener)

      expect(seen).toEqual([{ sessionId: 'room-1', agentId: 'fe' }])
      expect(wrapper.findAll('.app-context-item')).toHaveLength(0)
      wrapper.unmount()
    })

    it('名册管理退到右键,一颗都没丢', async () => {
      const wrapper = await openSpaceStrip()
      await wrapper.findAll('.member-chip:not(.member-add)')[1].trigger('contextmenu')
      await nextTick()
      expect(wrapper.findAll('.app-context-item').map(item => item.text()))
        .toEqual(['设为负责人', '移出群聊'])
      wrapper.unmount()
    })

    it('旧壳(默认档)左键仍是名册菜单 —— classic 一个字节不变', async () => {
      const wrapper = await open(['pm', 'fe'])
      const seen: unknown[] = []
      const listener = (event: Event) => seen.push(event)
      window.addEventListener(OPEN_MEMBERS_EVENT, listener)
      await wrapper.findAll('.member-chip:not(.member-add)')[1].trigger('click')
      await nextTick()
      window.removeEventListener(OPEN_MEMBERS_EVENT, listener)

      expect(seen).toHaveLength(0)
      expect(wrapper.findAll('.app-context-item').length).toBeGreaterThan(0)
      wrapper.unmount()
    })
  })

  it('surfaces a refusal that only the app layer can make', async () => {
    collab.roomUpdate.mockResolvedValue({ success: false, error: '负责人必须是房间成员' })
    const wrapper = await open()
    await wrapper.find('.member-add').trigger('click')
    await wrapper.findAll('.app-context-item')[0].trigger('click')
    await nextTick()
    await nextTick()
    expect(wrapper.find('.member-error').text()).toBe('负责人必须是房间成员')
    wrapper.unmount()
  })

  /**
   * 写路径经 sessions store 的 action(架构收敛 C4 §4)。桩掉 action 之后桥一次
   * 都不该被碰到 —— 回填约定(`session:collab-updated`)因此有了唯一的落点,
   * 成员条不再自己记着"写完要不要刷"。
   */
  it('writes through the sessions store action, not the bridge', async () => {
    const sessionsStore = useSessionsStore()
    const updateCollabRoom = vi.spyOn(sessionsStore, 'updateCollabRoom')
      .mockResolvedValue({ success: true } as never)
    const wrapper = await open()

    await wrapper.findAll('.member-chip:not(.member-add)')[1].trigger('contextmenu')
    await wrapper.findAll('.app-context-item')[0].trigger('click')
    await nextTick()

    expect(updateCollabRoom).toHaveBeenCalledWith('room-1', { pmAgentId: 'fe' })
    expect(collab.roomUpdate).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
