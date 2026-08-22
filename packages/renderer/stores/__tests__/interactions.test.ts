/**
 * E2 — 提问账本是**反查**出来的,不是事件累出来的。
 *
 * 与审批徽标那条判例同一条理由(collabBoard 的 `reconcilePending` 注释):事件会
 * 丢、会乱序、窗口重载后一条都不会补发,而「屏幕上有没有这张卡」不允许有第二个
 * 答案。这里钉的是四件事:事件只当触发器、结算的答案由事件转达(反查答不出它)、
 * 补水去重、切会话不串账。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useInteractionsStore } from '../interactions'

const mocks = vi.hoisted(() => ({
  getPendingInteractions: vi.fn(),
  respondInteraction: vi.fn(),
}))

// P4c 第九批:两条走通用 RPC 的 interaction 域,客户端在 `@/platform/interaction-client`
// (能力位 `interactionRespond` 关着时它就地返回失败信封,store 因此逐字同构)。
vi.mock('@/platform/interaction-client', () => ({
  interactionApi: {
    getPending: mocks.getPendingInteractions,
    respond: mocks.respondInteraction,
  },
}))

const T0 = 1_700_000_000_000

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ask-1',
    sessionId: 'work-1',
    toolCallId: 'call-1',
    origin: 'external-agent',
    questions: [
      { id: 'q1', header: '配色', question: '用哪一套配色?', options: [{ label: '暖' }, { label: '冷' }] },
    ],
    deadlineAt: T0 + 120_000,
    createdAt: T0,
    ...overrides,
  }
}

beforeEach(() => {
  mocks.getPendingInteractions.mockReset()
  mocks.respondInteraction.mockReset()
  mocks.getPendingInteractions.mockResolvedValue({ success: true, pending: [] })
  mocks.respondInteraction.mockResolvedValue({ success: true })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('interactions store: 提问账本', () => {
  it('requested 事件只是触发器 —— 账本内容来自反查', async () => {
    vi.useFakeTimers()
    const store = useInteractionsStore()
    // 事件带的 request 与反查回来的那一份**故意不同**:上屏的必须是反查那一份。
    mocks.getPendingInteractions.mockResolvedValue({
      success: true,
      pending: [request({ id: 'ask-2' })],
    })

    store.noteInteractionEvent('work-1', { type: 'interaction:requested', request: request() as never })
    expect(store.pendingFor('work-1')).toEqual([])  // 反查还没回来,不抢跑

    await vi.advanceTimersByTimeAsync(250)
    expect(store.pendingFor('work-1').map(item => item.id)).toEqual(['ask-2'])
    expect(mocks.getPendingInteractions).toHaveBeenCalledTimes(1)
  })

  it('settled 当场摘牌,不等那 200ms —— 否则栏位还在要你答一条已经结了的提问', async () => {
    vi.useFakeTimers()
    const store = useInteractionsStore()
    mocks.getPendingInteractions.mockResolvedValue({ success: true, pending: [request()] })
    await store.ensureForSession('work-1')
    expect(store.pendingFor('work-1')).toHaveLength(1)

    // 结算之后内核已经把它摘牌,反查只会答一份空表。
    mocks.getPendingInteractions.mockResolvedValue({ success: true, pending: [] })
    store.noteInteractionEvent('work-1', {
      type: 'interaction:settled',
      toolCallId: 'call-1',
      answer: { id: 'ask-1', answers: { q1: { selected: ['暖'] } }, outcome: 'answered' } as never,
    })

    expect(store.pendingFor('work-1')).toEqual([])

    await vi.advanceTimersByTimeAsync(250)
    expect(store.pendingFor('work-1')).toEqual([])
  })

  it('答完不留痕:账本里不存第二本「上一次怎么收的场」', async () => {
    const store = useInteractionsStore()
    mocks.getPendingInteractions.mockResolvedValue({ success: true, pending: [request()] })
    await store.ensureForSession('work-1')

    store.noteInteractionEvent('work-1', {
      type: 'interaction:settled',
      answer: { id: 'ask-1', answers: { q1: { selected: ['暖'] } }, outcome: 'answered' } as never,
    })
    expect(store.pendingFor('work-1')).toEqual([])
    expect(Object.keys(store)).not.toContain('settled')
    expect(Object.keys(store)).not.toContain('settledFor')
  })

  it('到点自结算(没有任何人点过东西)同样把栏位收干净', async () => {
    const store = useInteractionsStore()
    mocks.getPendingInteractions.mockResolvedValue({ success: true, pending: [request()] })
    await store.ensureForSession('work-1')

    store.noteInteractionEvent('work-1', {
      type: 'interaction:settled',
      answer: { id: 'ask-1', answers: {}, outcome: 'timeout', reason: '无人应答' } as never,
    })
    expect(store.pendingFor('work-1')).toEqual([])
  })

  it('同一条结算重复到达是幂等的', async () => {
    const store = useInteractionsStore()
    mocks.getPendingInteractions.mockResolvedValue({ success: true, pending: [request()] })
    await store.ensureForSession('work-1')

    const settled = {
      type: 'interaction:settled',
      answer: { id: 'ask-1', answers: {}, outcome: 'declined' } as never,
    }
    store.noteInteractionEvent('work-1', settled)
    store.noteInteractionEvent('work-1', settled)
    expect(store.pendingFor('work-1')).toEqual([])
  })

  it('补水重复调用不会把同一条提问贴两遍', async () => {
    const store = useInteractionsStore()
    mocks.getPendingInteractions.mockResolvedValue({ success: true, pending: [request()] })
    await store.ensureForSession('work-1')
    await store.ensureForSession('work-1')
    expect(store.pendingFor('work-1').map(item => item.id)).toEqual(['ask-1'])
  })

  it('迟到的反查答案不算数(先摘牌再广播,那扇窗就关上了)', async () => {
    const store = useInteractionsStore()
    let releaseStale: (value: unknown) => void = () => {}
    const stale = new Promise(resolve => { releaseStale = resolve })
    mocks.getPendingInteractions.mockImplementationOnce(async () => {
      await stale
      return { success: true, pending: [request()] }
    })
    const first = store.reconcile('work-1')

    mocks.getPendingInteractions.mockResolvedValue({ success: true, pending: [] })
    await store.reconcile('work-1')
    releaseStale(null)
    await first

    expect(store.pendingFor('work-1')).toEqual([])
  })

  it('读失败保留上一份账 —— 读不到不是「没有欠账」的证据', async () => {
    const store = useInteractionsStore()
    mocks.getPendingInteractions.mockResolvedValue({ success: true, pending: [request()] })
    await store.ensureForSession('work-1')

    mocks.getPendingInteractions.mockRejectedValue(new Error('ipc down'))
    await store.ensureForSession('work-1')
    expect(store.pendingFor('work-1')).toHaveLength(1)
  })

  it('两个会话各记各的,切会话不串栏位', async () => {
    const store = useInteractionsStore()
    mocks.getPendingInteractions.mockImplementation(async (sessionId: string) => ({
      success: true,
      pending: sessionId === 'work-1' ? [request()] : [],
    }))
    await store.ensureForSession('work-1')
    await store.ensureForSession('work-2')

    expect(store.pendingFor('work-1')).toHaveLength(1)
    expect(store.pendingFor('work-2')).toEqual([])
  })

  it('交卷按 interactionId + toolCallId 走专用 IPC 面', async () => {
    const store = useInteractionsStore()
    const ok = await store.respond('work-1', request() as never, {
      q1: { selected: ['暖'], freeText: '偏橘一点' },
    })
    expect(ok).toBe(true)
    expect(mocks.respondInteraction).toHaveBeenCalledWith({
      sessionId: 'work-1',
      interactionId: 'ask-1',
      toolCallId: 'call-1',
      answers: { q1: { selected: ['暖'], freeText: '偏橘一点' } },
    })
  })

  it('「不回答」落成 declined,而不是一份空答案的 answered', async () => {
    const store = useInteractionsStore()
    await store.decline('work-1', request() as never, '这个我也不知道')
    expect(mocks.respondInteraction).toHaveBeenCalledWith({
      sessionId: 'work-1',
      interactionId: 'ask-1',
      toolCallId: 'call-1',
      decline: true,
      reason: '这个我也不知道',
    })
  })
})
