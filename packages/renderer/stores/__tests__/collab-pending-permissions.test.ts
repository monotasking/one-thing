/**
 * 待审批权限收敛成一本账(架构收敛 C4 §5)。
 *
 * 收敛前这件事有三个消费者、两种存储模型:collabBoard 的反查计数、ipc-hub 按
 * `permission:request/queued/settled` 事件 ± 驱动的 chat store 卡片状态、
 * MessageList 切会话时自己直查再自己投影的一份。审批是安全面 ——「屏幕上有没有
 * 这张卡」不允许有第二个答案。
 *
 * 这一组钉的是**收敛前后行为等价**的四个场景,外加那个已知的时序坑:
 *  1. 卡片出现时机 —— 一条 request 事件之后,卡片确实举起来了;
 *  2. queued → actionable 晋升 —— 等待态换成可按的卡;
 *  3. settle 后消失 —— 而且带着 decision 的那次状态推进没有丢;
 *  4. 跨会话切换补水 —— 一条事件都没有的冷开场,卡片照样在;
 *  5. settle 先到、反查后到 —— 迟到的答案里还带着刚批掉的 ask,不许把卡贴回去。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCollabBoardStore } from '../collabBoard'
import { useChatStore } from '../chat'
import type { ChatMessage, ToolCall } from '@/types'

const mocks = vi.hoisted(() => ({
  handlers: [] as Array<(envelope: { sessionId: string; event: unknown }) => void>,
  getPendingPermissions: vi.fn(),
}))

vi.mock('@/platform', () => ({
  platformApi: {
    onSessionEvent: (handler: (envelope: { sessionId: string; event: unknown }) => void) => {
      mocks.handlers.push(handler)
      return () => {}
    },
    getPendingPermissions: mocks.getPendingPermissions,
    updateToolCall: vi.fn().mockResolvedValue({ success: true }),
    updateMessageThinkingTime: vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('@/platform/collab-client', () => ({
  collabApi: { boardGet: vi.fn().mockResolvedValue({ success: false }) },
}))

/** 一条正在流式生成、并且已经开了一个 bash 工具调用的助手消息。 */
function seedToolCall(sessionId = 's1'): ToolCall {
  const chat = useChatStore()
  chat.handleAssistantCreated({
    sessionId,
    message: {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: 0,
      isStreaming: true,
      toolCalls: [],
      steps: [],
      contentParts: [],
    } as ChatMessage,
  })
  chat.handleStreamChunk({
    type: 'tool_input_start',
    sessionId,
    messageId: 'm1',
    content: '',
    toolCallId: 'tc1',
    toolName: 'bash',
  })
  return chat.sessionMessages.get(sessionId)![0].toolCalls![0]
}

function toolCallOf(sessionId = 's1'): ToolCall {
  return useChatStore().sessionMessages.get(sessionId)![0].toolCalls![0]
}

function prompt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    type: 'bash',
    sessionId: 's1',
    messageId: 'm1',
    callId: 'tc1',
    title: 'bun run test',
    metadata: {},
    createdAt: 0,
    targetChannel: 'ipc',
    promptState: 'actionable',
    ...overrides,
  }
}

function emit(sessionId: string, event: unknown): void {
  for (const handler of mocks.handlers) handler({ sessionId, event })
}

beforeEach(() => {
  mocks.handlers.length = 0
  mocks.getPendingPermissions.mockReset()
  mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [] })
  setActivePinia(createPinia())
  vi.stubGlobal('window', { electronAPI: {} })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('待审批账本:收敛前后的四个等价场景', () => {
  it('卡片出现时机:一条 request 事件之后,卡片举起来了', async () => {
    vi.useFakeTimers()
    seedToolCall()
    const board = useCollabBoardStore()
    board.ensureSubscribed()

    mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [prompt()] })
    emit('s1', { type: 'permission:request', requestId: 'p1', toolCallId: 'tc1', messageId: 'm1' })
    await vi.advanceTimersByTimeAsync(300)

    expect(toolCallOf()).toMatchObject({
      permissionId: 'p1',
      requiresConfirmation: true,
      canRespond: true,
      status: 'pending',
    })
    // 徽标读的是同一本账,不是第二处记数。
    expect(board.hasPendingAsk('s1')).toBe(true)
  })

  it('queued → actionable 晋升:等待态换成可按的卡', async () => {
    vi.useFakeTimers()
    seedToolCall()
    const board = useCollabBoardStore()
    board.ensureSubscribed()

    mocks.getPendingPermissions.mockResolvedValue({
      success: true,
      pending: [prompt({ promptState: 'queued' })],
    })
    emit('s1', { type: 'permission:queued', requestId: 'p1', toolCallId: 'tc1', messageId: 'm1' })
    await vi.advanceTimersByTimeAsync(300)
    expect(toolCallOf().permissionQueued).toBe(true)
    expect(toolCallOf().requiresConfirmation).toBeFalsy()

    mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [prompt()] })
    emit('s1', { type: 'permission:request', requestId: 'p1', toolCallId: 'tc1', messageId: 'm1' })
    await vi.advanceTimersByTimeAsync(300)
    expect(toolCallOf().permissionQueued).toBe(false)
    expect(toolCallOf().requiresConfirmation).toBe(true)
  })

  it('settle 后消失:卡当场撤掉,而且 decision 带来的状态推进没有丢', async () => {
    vi.useFakeTimers()
    seedToolCall()
    const board = useCollabBoardStore()
    board.ensureSubscribed()

    mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [prompt()] })
    emit('s1', { type: 'permission:request', requestId: 'p1', toolCallId: 'tc1', messageId: 'm1' })
    await vi.advanceTimersByTimeAsync(300)
    expect(toolCallOf().requiresConfirmation).toBe(true)

    // 反查答得出"还欠不欠",答不出"上次是批还是拒" —— decision 是事件独有的事实,
    // 所以它不等那 200ms,当场转达。
    mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [] })
    emit('s1', {
      type: 'permission:settled',
      requestId: 'p1',
      toolCallIds: ['tc1'],
      decision: 'allowed',
    })
    expect(toolCallOf().requiresConfirmation).toBe(false)
    expect(toolCallOf().status).toBe('executing')

    await vi.advanceTimersByTimeAsync(300)
    expect(toolCallOf().requiresConfirmation).toBe(false)
    expect(board.hasPendingAsk('s1')).toBe(false)
  })

  it('跨会话切换补水:一条事件都没有的冷开场,卡片照样在', async () => {
    seedToolCall()
    const board = useCollabBoardStore()
    mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [prompt()] })

    await board.ensurePendingForSession('s1')

    expect(mocks.getPendingPermissions).toHaveBeenCalledWith('s1')
    expect(toolCallOf()).toMatchObject({ permissionId: 'p1', requiresConfirmation: true })
  })
})

describe('待审批账本:反查的时序防御', () => {
  it('settle 先到、反查后到 —— 迟到的答案不许把卡贴回去', async () => {
    vi.useFakeTimers()
    seedToolCall()
    const board = useCollabBoardStore()
    board.ensureSubscribed()

    // 一次在 settle **之前**发出的反查:它的答案里还带着那条 ask。
    let releaseStale: (value: unknown) => void = () => {}
    mocks.getPendingPermissions.mockReturnValueOnce(
      new Promise(resolve => { releaseStale = resolve }),
    )
    const stale = board.reconcilePending('s1')

    mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [] })
    emit('s1', {
      type: 'permission:settled',
      requestId: 'p1',
      toolCallIds: ['tc1'],
      decision: 'allowed',
    })
    await vi.advanceTimersByTimeAsync(300)

    releaseStale({ success: true, pending: [prompt()] })
    await stale

    expect(toolCallOf().requiresConfirmation).toBeFalsy()
    expect(board.hasPendingAsk('s1')).toBe(false)
  })

  it('读失败不当作空队列 —— 账本原样留着', async () => {
    const board = useCollabBoardStore()
    mocks.getPendingPermissions.mockResolvedValue({ success: true, pending: [prompt()] })
    await board.reconcilePending('s1')
    expect(board.hasPendingAsk('s1')).toBe(true)

    mocks.getPendingPermissions.mockRejectedValue(new Error('bridge down'))
    await board.reconcilePending('s1')
    expect(board.hasPendingAsk('s1')).toBe(true)
    expect(board.pendingPromptsFor('s1')).toHaveLength(1)
  })
})
