// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CollabTypingLine from '../CollabTypingLine.vue'
import { useAgentsStore } from '@/stores/agents'
import { useCollabBoardStore } from '@/stores/collabBoard'

const mocks = vi.hoisted(() => ({
  handlers: [] as Array<(envelope: { sessionId: string; event: unknown }) => void>,
}))

vi.mock('@/platform', () => ({
  platformApi: {
    onSessionEvent: (handler: (envelope: { sessionId: string; event: unknown }) => void) => {
      mocks.handlers.push(handler)
      return () => {}
    },
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
      // collab 也走这条通道(P4a):看板/协调器补水在这些用例里一律读不到 ——
      // 打字名单的唯一来源是广播,不是这两次 GET。
      if (request.domain === 'collab') return { ok: true, data: { success: false } }
      return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
    }),
  },
}))

let seq = 0

/**
 * 一次协调器广播 —— 打字名单的**唯一**来源(架构收敛 C4 §1)。
 *
 * 从前这里发的是 `collab:typing` 的单人开关。事件还在线上,但渲染层不再拿它
 * 记账:名单是整份到达的,于是"迟到的一条 false 抹掉后一轮的 true"这种事在
 * 这一层已经不可能发生。
 */
function emitTyping(sessionId: string, agentIds: string[]): void {
  const state = {
    roomSessionId: sessionId,
    mode: 'parallel',
    frozen: false,
    seq: ++seq,
    at: Date.now(),
    speaking: agentIds,
    typing: agentIds,
    turns: [],
    queue: [],
    judging: 0,
    judgingAgentIds: [],
    gates: {
      chain: { value: 0, max: 32 },
      concurrency: { value: 0, max: 6 },
      budget: { value: 0, max: 5 },
    },
    plan: null,
    log: [],
  }
  for (const handler of mocks.handlers) {
    handler({ sessionId, event: { type: 'collab:coordinator-changed', state } })
  }
}

beforeEach(() => {
  mocks.handlers.length = 0
  seq = 0
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-28T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CollabTypingLine', () => {
  it('renders nothing while the room is quiet — silence reserves no row', () => {
    const wrapper = mount(CollabTypingLine, { props: { sessionId: 'room-1' } })
    expect(wrapper.find('.collab-typing').exists()).toBe(false)
    expect(wrapper.html()).toBe('<!--v-if-->')
  })

  it('names the typing members with their avatars and three dots', async () => {
    const agentsStore = useAgentsStore()
    agentsStore.agents = [
      { id: 'agent-li', name: '小李', avatar: '🔧', systemPrompt: '', createdAt: 0, updatedAt: 0 },
      { id: 'agent-yan', name: '小研', avatar: '🔎', systemPrompt: '', createdAt: 0, updatedAt: 0 },
    ]
    agentsStore.hasLoaded = true

    const wrapper = mount(CollabTypingLine, { props: { sessionId: 'room-1' } })
    useCollabBoardStore().ensureSubscribed()

    emitTyping('room-1', ['agent-li', 'agent-yan'])
    await nextTick()

    expect(wrapper.text()).toContain('🔧小李、🔎小研')
    expect(wrapper.text()).toContain('正在输入')
    expect(wrapper.findAll('.typing-dot')).toHaveLength(3)
  })

  it('shows the tombstone, not a raw id, when the roster has no such member', async () => {
    // 域模型 M4:署名一律走 displayAgent —— 一串 uuid 出现在"正在输入"那一行,
    // 对用户等于一句乱码。
    const wrapper = mount(CollabTypingLine, { props: { sessionId: 'room-1' } })
    useCollabBoardStore().ensureSubscribed()

    emitTyping('room-1', ['agent-ghost'])
    await nextTick()

    expect(wrapper.text()).toContain('已注销')
    expect(wrapper.text()).not.toContain('agent-ghost')
  })

  it('名单缩短就少一个人;整份名单陈旧了(60s 没有新快照)整行退场', async () => {
    const wrapper = mount(CollabTypingLine, { props: { sessionId: 'room-1' } })
    useCollabBoardStore().ensureSubscribed()

    emitTyping('room-1', ['agent-li', 'agent-yan'])
    await nextTick()
    expect(wrapper.find('.collab-typing').exists()).toBe(true)

    emitTyping('room-1', ['agent-yan'])
    await nextTick()
    expect(wrapper.text()).not.toContain('agent-li')
    expect(wrapper.find('.collab-typing').exists()).toBe(true)

    // 协调器再也没说过话:1s 脉搏重读 store,兜底把整行退掉。
    vi.advanceTimersByTime(61_000)
    await nextTick()
    expect(wrapper.find('.collab-typing').exists()).toBe(false)
  })

  it('runs no timer while quiet and stops it once the room settles', async () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval')
    const clearInterval = vi.spyOn(globalThis, 'clearInterval')

    const wrapper = mount(CollabTypingLine, { props: { sessionId: 'room-1' } })
    useCollabBoardStore().ensureSubscribed()
    expect(setInterval).not.toHaveBeenCalled()

    emitTyping('room-1', ['agent-li'])
    await nextTick()
    expect(setInterval).toHaveBeenCalledTimes(1)

    emitTyping('room-1', [])
    await nextTick()
    expect(clearInterval).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })
})
