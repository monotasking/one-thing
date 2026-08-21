// @vitest-environment happy-dom
/**
 * 调度页租约表那颗「撤牌」—— 人级停止(E5)在界面上的第一个入口。
 *
 * 这一颗按钮的**全部风险在于它撤的是哪一张**:一颗写着「撤牌」、按下去却把整间房
 * 清场的按钮,比没有这颗按钮糟得多(那正是 O2 当初宁可把它做成只读的理由)。所以
 * 这一组钉的是靶子与代数:点第二行就撤第二行那张牌,代数取自屏幕上那份快照。
 *
 * 三条失败原因各自有话可说也一并钉住 —— 一句笼统的"操作失败"会让人反复点,而每
 * 一次点都是一次真的停止尝试。
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabCoordinatorState } from '@shared/ipc'
import RoomSchedulePanel from '../RoomSchedulePanel.vue'

const mocks = vi.hoisted(() => ({
  coordinator: null as CollabCoordinatorState | null,
  revokeLease: vi.fn(),
  loadCoordinator: vi.fn(),
  schedulerLogTail: vi.fn(),
}))

vi.mock('@/stores/agents', () => ({
  useAgentsStore: () => ({
    displayAgent: (agentId: string) => ({
      id: agentId,
      name: agentId === 'fe' ? '小李' : agentId === 'pm' ? '阿明' : agentId,
    }),
  }),
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({ sessions: [] }),
}))

vi.mock('@/stores/collabBoard', () => ({
  useCollabBoardStore: () => ({
    coordinatorFor: () => mocks.coordinator,
    agentActivityFor: () => null,
    ensureAgentActivity: vi.fn(),
    loadCoordinator: mocks.loadCoordinator,
    revokeLease: mocks.revokeLease,
  }),
}))

vi.mock('@/platform/collab-client', () => ({
  collabApi: { schedulerLogTail: mocks.schedulerLogTail },
}))

function coordinator(floorEpoch = 5): CollabCoordinatorState {
  return {
    roomSessionId: 'room-1',
    mode: 'parallel',
    frozen: false,
    seq: 1,
    at: 1_000,
    speaking: ['fe', 'pm'],
    typing: [],
    turns: [
      { agentId: 'fe', reason: 'mention', startedAt: 900, agentSessionId: 'room-1#L1', executing: true },
      { agentId: 'pm', reason: 'mention', startedAt: 950, agentSessionId: 'room-1#L2', executing: false },
    ],
    queue: [],
    judging: 0,
    judgingAgentIds: [],
    gates: {
      chain: { value: 0, max: 32 },
      concurrency: { value: 2, max: 6 },
      budget: { value: 0, max: 5 },
    },
    plan: null,
    log: [],
    judgment: { state: 'idle' },
    deadLetterCount: 0,
    floorEpoch,
  }
}

async function mountPanel() {
  const wrapper = mount(RoomSchedulePanel, {
    props: { roomSessionId: 'room-1' },
    global: { stubs: { Tooltip: { template: '<div><slot /></div>' } } },
  })
  await nextTick()
  await nextTick()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.coordinator = coordinator()
  mocks.schedulerLogTail.mockResolvedValue({ success: true, rows: [] })
  mocks.revokeLease.mockResolvedValue({ ok: true, revoked: true, agentId: 'pm' })
})

describe('调度页「撤牌」(E5 人级停止)', () => {
  it('每一行租约都有一颗撤牌,点第 N 行撤的就是第 N 张牌', async () => {
    const wrapper = await mountPanel()
    const buttons = wrapper.findAll('.rs-revoke')
    expect(buttons).toHaveLength(2)

    await buttons[1]!.trigger('click')
    // 靶子是那一行自己的牌号 —— 不是"当前那张"、更不是整间房。
    expect(mocks.revokeLease).toHaveBeenCalledWith('room-1', 'room-1#L2')
    expect(mocks.revokeLease).toHaveBeenCalledTimes(1)
  })

  it('代数由 store 现取,组件一个字都不传 —— 免得每个入口各自翻错一份', async () => {
    const wrapper = await mountPanel()
    await wrapper.findAll('.rs-revoke')[0]!.trigger('click')
    expect(mocks.revokeLease.mock.calls[0]).toEqual(['room-1', 'room-1#L1'])
  })

  it('epoch-stale 说的是「这一屏过时了」,不是一句笼统的失败', async () => {
    mocks.revokeLease.mockResolvedValue({ ok: false, reason: 'epoch-stale', epoch: 6 })
    const wrapper = await mountPanel()
    await wrapper.findAll('.rs-revoke')[0]!.trigger('click')
    await nextTick()
    expect(wrapper.find('.rs-empty.is-warn').text()).toContain('换过代')
  })

  it('not-found 点名说这张牌已经不在了(带上是谁)', async () => {
    mocks.revokeLease.mockResolvedValue({ ok: false, reason: 'not-found', epoch: 5 })
    const wrapper = await mountPanel()
    await wrapper.findAll('.rs-revoke')[1]!.trigger('click')
    await nextTick()
    const text = wrapper.find('.rs-empty.is-warn').text()
    expect(text).toContain('阿明')
    expect(text).toContain('已经不在了')
  })

  it('撤成之后不留错误行,也不本地删那一行(等广播把补发后的账推回来)', async () => {
    const wrapper = await mountPanel()
    await wrapper.findAll('.rs-revoke')[0]!.trigger('click')
    await nextTick()
    expect(wrapper.find('.rs-empty.is-warn').exists()).toBe(false)
    expect(wrapper.findAll('.rs-lease')).toHaveLength(2)
  })
})
