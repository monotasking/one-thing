// @vitest-environment happy-dom
/**
 * E2 整条链的接缝:`interaction:requested` 事件 → 账本反查 → 栏位渲染 →
 * 用户点一下 → `respondInteraction` 的入参形状。
 *
 * 单测各自守着自己那一段;这里守的是**接缝**——历史上出问题的从来不是某一段,
 * 而是「事件名对不上」「反查没人触发」「应答少带一个 toolCallId」这类接不上的地方。
 */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InteractionPrompt from '@/components/chat/interaction/InteractionPrompt.vue'

type SessionEventCallback = (envelope: {
  sessionId: string
  event: Record<string, unknown>
}) => void

// 真表跑(这里要的是接缝而不是秒表),所以 deadline 挂在"现在 + 两分钟"上 ——
// 写死一个 2023 年的时间戳,卡片一挂载就是已超时态,按钮全灰。
const T0 = Date.now()

const REQUEST = {
  id: 'ask-1',
  sessionId: 'work-1',
  toolCallId: 'call-1',
  origin: 'external-agent',
  questions: [
    {
      id: 'q1',
      header: '配色',
      question: '这一版用哪一套配色?',
      options: [{ label: '暖' }, { label: '冷' }],
    },
  ],
  deadlineAt: T0 + 120_000,
  createdAt: T0,
}

describe('IPC hub → 提问账本 → 卡片 → 应答', () => {
  let sessionEventCallback: SessionEventCallback | undefined
  let getPendingInteractions: ReturnType<typeof vi.fn<(sessionId: string) => Promise<unknown>>>
  let respondInteraction: ReturnType<typeof vi.fn<(request: unknown) => Promise<unknown>>>

  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    sessionEventCallback = undefined
    getPendingInteractions = vi.fn(async () => ({ success: true, pending: [REQUEST] }))
    respondInteraction = vi.fn(async () => ({ success: true }))
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onSessionEvent: vi.fn((callback: SessionEventCallback) => {
          sessionEventCallback = callback
          return vi.fn()
        }),
        onSessionStream: vi.fn(() => vi.fn()),
        saveUIState: vi.fn(async () => ({ success: true })),
        // P4c 第九批:两条走通用 RPC 的 interaction 域,所以宿主这里要给的是
        // 通用信封,不再是两条具名方法。桌面的能力位 `interactionRespond` 为 true,
        // 客户端不降级,请求真的会打到这条 `rpcInvoke` 上。
        rpcInvoke: vi.fn(async (request: { domain: string, method: string, payload: any }) => {
          if (request.domain !== 'interaction') return { ok: false, error: { message: 'unexpected domain' } }
          if (request.method === 'getPending') {
            return { ok: true, data: await getPendingInteractions(request.payload.sessionId) }
          }
          return { ok: true, data: await respondInteraction(request.payload) }
        }),
      },
    })
  })

  async function settle(ms = 260) {
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  it('事件到达 → 反查 → 账本上有这张卡 → 点一下,应答形状正确', async () => {
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useInteractionsStore } = await import('@/stores/interactions')
    initializeIPCHub()

    sessionEventCallback?.({
      sessionId: 'work-1',
      event: { type: 'interaction:requested', request: REQUEST },
    })
    await settle()

    const store = useInteractionsStore()
    // 账本内容来自反查(不是事件载荷的复制)
    expect(getPendingInteractions).toHaveBeenCalledWith('work-1')
    const pending = store.pendingFor('work-1')
    expect(pending.map(item => item.id)).toEqual(['ask-1'])

    // 栏位自己看账本(宿主只给 sessionId),所以这里连 request 都不用喂。
    const wrapper = mount(InteractionPrompt, { props: { sessionId: 'work-1' } })
    expect(wrapper.text()).toContain('这一版用哪一套配色?')
    await wrapper.findAll('.option')[1]!.trigger('click')
    await wrapper.get('[data-testid="interaction-submit"]').trigger('click')
    await settle(0)

    expect(respondInteraction).toHaveBeenCalledWith({
      sessionId: 'work-1',
      interactionId: 'ask-1',
      toolCallId: 'call-1',
      answers: { q1: { selected: ['冷'] } },
    })
  })

  it('settled 事件把栏位收走(超时自结算也一样,没有人点过任何东西)', async () => {
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useInteractionsStore } = await import('@/stores/interactions')
    initializeIPCHub()

    sessionEventCallback?.({
      sessionId: 'work-1',
      event: { type: 'interaction:requested', request: REQUEST },
    })
    await settle()

    getPendingInteractions.mockResolvedValue({ success: true, pending: [] })
    sessionEventCallback?.({
      sessionId: 'work-1',
      event: {
        type: 'interaction:settled',
        toolCallId: 'call-1',
        answer: { id: 'ask-1', answers: {}, outcome: 'timeout', reason: '无人应答' },
      },
    })
    await settle()

    const store = useInteractionsStore()
    expect(store.pendingFor('work-1')).toEqual([])

    // 收场之后会话里不留痕:栏位整块不画,连一行已办记录都没有。
    const wrapper = mount(InteractionPrompt, { props: { sessionId: 'work-1' } })
    await settle(0)
    expect(wrapper.find('.session-interaction-panel').exists()).toBe(false)
    expect(wrapper.find('[data-testid="interaction-submit"]').exists()).toBe(false)
  })

  it('别的会话的提问不落到这个会话的账上', async () => {
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useInteractionsStore } = await import('@/stores/interactions')
    initializeIPCHub()

    getPendingInteractions.mockImplementation(async (sessionId: string) => ({
      success: true,
      pending: sessionId === 'work-1' ? [REQUEST] : [],
    }))
    sessionEventCallback?.({
      sessionId: 'work-2',
      event: { type: 'interaction:requested', request: { ...REQUEST, id: 'ask-9', sessionId: 'work-2' } },
    })
    await settle()

    const store = useInteractionsStore()
    expect(store.pendingFor('work-2')).toEqual([])
    expect(store.pendingFor('work-1')).toEqual([])
  })
})
