// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/types'

type SessionEventCallback = (envelope: {
  sessionId: string
  event: Record<string, unknown>
}) => void

type SessionStreamCallback = (payload: {
  sessionId: string
  chunk: Record<string, unknown>
}) => void

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    isStreaming: true,
    contentParts: [],
    ...overrides,
  }
}

describe('IPC hub stream subscriptions', () => {
  let sessionEventCallback: SessionEventCallback | undefined
  let sessionStreamCallback: SessionStreamCallback | undefined

  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    sessionEventCallback = undefined
    sessionStreamCallback = undefined

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onSessionEvent: vi.fn((callback: SessionEventCallback) => {
          sessionEventCallback = callback
          return vi.fn()
        }),
        onSessionStream: vi.fn((callback: SessionStreamCallback) => {
          sessionStreamCallback = callback
          return vi.fn()
        }),
      },
    })
  })

  it('routes unified session stream chunks into the chat store in realtime', async () => {
    // 旧路用例(U2-a §17.8.7):驱动手写拼装并对着 sessionMessages 断言。
    // 新路的等价覆盖在 `stores/__tests__/fold-tree.test.ts`。
    const { setFoldTreeEnabled } = await import('@/stores/fold-tree')
    setFoldTreeEnabled(false)
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    initializeIPCHub()
    sessionEventCallback?.({
      sessionId: 's1',
      event: {
        type: 'message:assistant-created',
        message: assistantMessage(),
      },
    })

    const before = store.getSessionState('s1').messages.value[0]
    sessionStreamCallback?.({
      sessionId: 's1',
      chunk: {
        type: 'text-delta',
        messageId: 'm1',
        text: 'live',
        turnIndex: 1,
      },
    })

    const after = store.getSessionState('s1').messages.value[0]
    expect(after).not.toBe(before)
    expect(after.content).toBe('live')
    expect(after.contentParts).toEqual([
      { type: 'text', content: 'live', turnIndex: 1 },
    ])
  })

  it('routes reasoning and text stream chunks without waiting for completion', async () => {
    // 旧路用例(U2-a §17.8.7):驱动手写拼装并对着 sessionMessages 断言。
    // 新路的等价覆盖在 `stores/__tests__/fold-tree.test.ts`。
    const { setFoldTreeEnabled } = await import('@/stores/fold-tree')
    setFoldTreeEnabled(false)
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    initializeIPCHub()
    sessionEventCallback?.({
      sessionId: 's1',
      event: {
        type: 'message:assistant-created',
        message: assistantMessage(),
      },
    })

    const initial = store.getSessionState('s1').messages.value[0]
    sessionStreamCallback?.({
      sessionId: 's1',
      chunk: {
        type: 'reasoning-delta',
        messageId: 'm1',
        reasoning: 'think',
        turnIndex: 1,
        placement: 'top',
      },
    })
    const afterReasoning = store.getSessionState('s1').messages.value[0]

    expect(afterReasoning).not.toBe(initial)
    expect(afterReasoning.reasoning).toBe('think')
    expect(afterReasoning.content).toBe('')
    expect(afterReasoning.isStreaming).toBe(true)

    sessionStreamCallback?.({
      sessionId: 's1',
      chunk: {
        type: 'text-delta',
        messageId: 'm1',
        text: 'answer',
        turnIndex: 1,
      },
    })
    const afterText = store.getSessionState('s1').messages.value[0]

    expect(afterText).not.toBe(afterReasoning)
    expect(afterText.reasoning).toBe('think')
    expect(afterText.content).toBe('answer')
    expect(afterText.contentParts).toEqual([
      { type: 'text', content: 'answer', turnIndex: 1 },
    ])
    expect(afterText.isStreaming).toBe(true)
  })

  it('routes final message updates so waiting does not survive until restart', async () => {
    // 旧路用例(U2-a §17.8.7):驱动手写拼装并对着 sessionMessages 断言。
    // 新路的等价覆盖在 `stores/__tests__/fold-tree.test.ts`。
    const { setFoldTreeEnabled } = await import('@/stores/fold-tree')
    setFoldTreeEnabled(false)
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    initializeIPCHub()
    sessionEventCallback?.({
      sessionId: 's1',
      event: {
        type: 'message:assistant-created',
        message: assistantMessage(),
      },
    })
    sessionEventCallback?.({
      sessionId: 's1',
      event: {
        type: 'content:part',
        part: { type: 'waiting' },
      },
    })
    sessionEventCallback?.({
      sessionId: 's1',
      event: {
        type: 'message:updated',
        messageId: 'm1',
        updates: {
          content: 'final',
          contentParts: [{ type: 'text', content: 'final', turnIndex: 1 }],
          isStreaming: false,
        },
      },
    })

    const message = store.getSessionState('s1').messages.value[0]
    expect(message.isStreaming).toBe(false)
    expect(message.content).toBe('final')
    expect(message.contentParts).toEqual([
      { type: 'text', content: 'final', turnIndex: 1 },
    ])
  })

  /**
   * ± 累积路径退役(架构收敛 C4 §5)。
   *
   * 这里从前直接改 chat store 的卡片状态,与 collabBoard 的反查账本并列成两种
   * 存储模型。现在三条事件都只是一句"这个会话的欠账动了",交给账本去重新问。
   */
  it('hands every permission event to the pending ledger instead of applying deltas', async () => {
    // 旧路用例(U2-a §17.8.7):驱动手写拼装并对着 sessionMessages 断言。
    // 新路的等价覆盖在 `stores/__tests__/fold-tree.test.ts`。
    const { setFoldTreeEnabled } = await import('@/stores/fold-tree')
    setFoldTreeEnabled(false)
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useChatStore } = await import('@/stores/chat')
    const { useCollabBoardStore } = await import('@/stores/collabBoard')
    const chat = useChatStore()
    const board = useCollabBoardStore()
    const noted = vi.spyOn(board, 'notePermissionEvent').mockImplementation(() => {})
    const applied = vi.spyOn(chat, 'handlePermissionRequest')
    const queued = vi.spyOn(chat, 'handlePermissionQueued')
    const settled = vi.spyOn(chat, 'handlePermissionSettled')

    initializeIPCHub()
    for (const event of [
      { type: 'permission:request', requestId: 'p1', toolCallId: 'tc1', messageId: 'm1' },
      { type: 'permission:queued', requestId: 'p2', toolCallId: 'tc2', messageId: 'm1' },
      { type: 'permission:settled', requestId: 'p1', toolCallIds: ['tc1'], decision: 'allowed' },
    ]) {
      sessionEventCallback?.({ sessionId: 's1', event })
    }

    expect(noted).toHaveBeenCalledTimes(3)
    expect(noted.mock.calls.map(call => (call[1] as { type: string }).type)).toEqual([
      'permission:request',
      'permission:queued',
      'permission:settled',
    ])
    expect(applied).not.toHaveBeenCalled()
    expect(queued).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
  })
})
