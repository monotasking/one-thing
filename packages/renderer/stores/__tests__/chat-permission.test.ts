/**
 * **旧路用例**(U2-a §17.8.7):驱动手写拼装管道并对着 `sessionMessages` 断言。
 * 新路上那棵树由账本折叠产出、手写侧的写在写入口那道闸上被忽略(休眠可回滚),
 * 新路的等价覆盖在 `stores/__tests__/fold-tree.test.ts`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setFoldTreeEnabled } from '@/stores/fold-tree'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '../chat'
import type { ChatMessage, Step, ToolCall } from '@/types'

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    isStreaming: true,
    toolCalls: [],
    steps: [],
    contentParts: [],
    ...overrides,
  }
}

describe('chat store permission ordering', () => {
  beforeEach(() => {
  // 旧路用例(见文件头):把 U2-a 的开关按回手写拼装。
  setFoldTreeEnabled(false)
    setActivePinia(createPinia())
    vi.stubGlobal('window', { electronAPI: {} })
    vi.useRealTimers()
  })

  it('applies cached permission requests when the tool call and step arrive later', () => {
    const store = useChatStore()
    store.handleAssistantCreated({ sessionId: 's1', message: assistantMessage() })

    store.handlePermissionRequest({
      sessionId: 's1',
      requestId: 'p1',
      messageId: 'm1',
      callId: 'tc1',
      permissionType: 'file_edit',
      title: 'Edit file',
      metadata: { diff: 'diff --git', filePath: '/tmp/a.txt' },
      canRespond: true,
    })

    store.handleStreamChunk({
      type: 'tool_input_start',
      sessionId: 's1',
      messageId: 'm1',
      content: '',
      toolCallId: 'tc1',
      toolName: 'edit',
    })

    const message = store.sessionMessages.get('s1')![0]
    expect(message.toolCalls![0]).toMatchObject({
      id: 'tc1',
      permissionId: 'p1',
      canRespond: true,
      requiresConfirmation: true,
      status: 'pending',
    })

    const step: Step = {
      id: 'step1',
      type: 'tool-call',
      title: 'Tool: edit',
      status: 'running',
      timestamp: 0,
      toolCallId: 'tc1',
      toolCall: message.toolCalls![0],
    }
    store.handleStepAdded({ sessionId: 's1', messageId: 'm1', step })

    const updated = store.sessionMessages.get('s1')![0]
    expect(updated.steps![0].status).toBe('awaiting-confirmation')
    expect(updated.steps![0].toolCall).toBe(updated.toolCalls![0])
  })

  it('keeps batched tool input deltas if they arrive before the placeholder', () => {
    const store = useChatStore()
    store.handleAssistantCreated({ sessionId: 's1', message: assistantMessage() })

    store.handleStreamChunk({
      type: 'tool_input_delta',
      sessionId: 's1',
      messageId: 'm1',
      content: '',
      toolCallId: 'tc1',
      argsTextDelta: '{"path":"src/a.ts"',
    })

    store.handleStreamChunk({
      type: 'tool_input_start',
      sessionId: 's1',
      messageId: 'm1',
      content: '',
      toolCallId: 'tc1',
      toolName: 'write',
    })

    store.handleStreamChunk({
      type: 'tool_call',
      sessionId: 's1',
      messageId: 'm1',
      content: '',
      toolCall: {
        id: 'tc1',
        toolId: 'write',
        toolName: 'write',
        arguments: {},
        status: 'executing',
        timestamp: 0,
      },
    })

    const message = store.sessionMessages.get('s1')![0]
    expect(message.toolCalls![0].streamingArgs).toBe('{"path":"src/a.ts"')
  })

  it('clears pending permission UI state when generation is stopped', async () => {
    // P4c 第五批:停止走 chat RPC 域,所以桩的是通用通道而不是壳上那个方法。
    const abortStream = vi.fn(async () => ({ success: true }))
    vi.stubGlobal('window', {
      electronAPI: {
        rpcInvoke: vi.fn(async (request: { domain: string; method: string; payload?: unknown }) => {
          if (request.domain === 'chat' && request.method === 'abortStream') {
            return { ok: true, data: await abortStream() }
          }
          return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
        }),
      },
    })
    const store = useChatStore()
    store.handleAssistantCreated({
      sessionId: 's1',
      message: assistantMessage({
        toolCalls: [{
          id: 'tc1',
          toolId: 'bash',
          toolName: 'bash',
          arguments: { command: 'rm -rf tmp' },
          status: 'pending',
          timestamp: 0,
          permissionId: 'p1',
          canRespond: true,
          requiresConfirmation: true,
        }],
        steps: [{
          id: 'step1',
          type: 'tool-call',
          title: 'Run command',
          status: 'awaiting-confirmation',
          timestamp: 0,
          toolCallId: 'tc1',
        }],
      }),
    })
    store.handleStreamStarted({ sessionId: 's1', messageId: 'm1' })

    await expect(store.stopGeneration('s1')).resolves.toBe(true)

    const message = store.sessionMessages.get('s1')![0]
    expect(message.toolCalls![0]).toMatchObject({
      status: 'cancelled',
      requiresConfirmation: false,
      canRespond: false,
    })
    expect(message.steps![0]).toMatchObject({
      status: 'cancelled',
      toolCall: expect.objectContaining({
        status: 'cancelled',
        requiresConfirmation: false,
      }),
    })
  })

  it('freezes running tool timers when generation is stopped', async () => {
    // P4c 第五批:停止走 chat RPC 域,所以桩的是通用通道而不是壳上那个方法。
    const abortStream = vi.fn(async () => ({ success: true }))
    vi.stubGlobal('window', {
      electronAPI: {
        rpcInvoke: vi.fn(async (request: { domain: string; method: string; payload?: unknown }) => {
          if (request.domain === 'chat' && request.method === 'abortStream') {
            return { ok: true, data: await abortStream() }
          }
          return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
        }),
      },
    })
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2_500)
    const store = useChatStore()
    const canonicalToolCall: ToolCall = {
      id: 'tc1',
      toolId: 'edit',
      toolName: 'edit',
      arguments: { path: 'style.css' },
      status: 'executing',
      timestamp: 0,
      startTime: 1_000,
    }
    const stepToolCall: ToolCall = { ...canonicalToolCall }

    store.handleAssistantCreated({
      sessionId: 's1',
      message: assistantMessage({
        toolCalls: [canonicalToolCall],
        steps: [{
          id: 'step1',
          type: 'tool-call',
          title: 'Edit style.css',
          status: 'running',
          timestamp: 0,
          toolCallId: 'tc1',
          toolCall: stepToolCall,
        }],
      }),
    })
    store.handleStreamStarted({ sessionId: 's1', messageId: 'm1' })

    try {
      await expect(store.stopGeneration('s1')).resolves.toBe(true)
    } finally {
      dateNow.mockRestore()
    }

    const message = store.sessionMessages.get('s1')![0]
    expect(message.isStreaming).toBe(false)
    expect(message.toolCalls![0]).toMatchObject({
      status: 'cancelled',
      endTime: 2_500,
      durationMs: 1_500,
    })
    expect(message.steps![0]).toMatchObject({ status: 'cancelled' })
    expect(message.steps![0].toolCall).toBe(message.toolCalls![0])
    expect(message.steps![0].toolCall).toMatchObject({
      status: 'cancelled',
      endTime: 2_500,
      durationMs: 1_500,
    })
  })

  it('marks queued permission asks as waiting without a respond card, and clears them on settle', () => {
    const store = useChatStore()
    const toolCall: ToolCall = {
      id: 'tc1',
      toolName: 'bash',
      arguments: {},
      status: 'executing',
    } as ToolCall
    const step: Step = {
      id: 'step1',
      type: 'tool-call',
      title: 'Tool: bash',
      status: 'running',
      timestamp: 0,
      toolCallId: 'tc1',
      toolCall,
    }
    store.handleAssistantCreated({
      sessionId: 's1',
      message: assistantMessage({ toolCalls: [toolCall], steps: [step] }),
    })

    store.handlePermissionQueued({
      sessionId: 's1',
      requestId: 'p-head',
      messageId: 'm1',
      toolCallId: 'tc1',
    })

    const queued = store.sessionMessages.get('s1')![0]
    expect(queued.toolCalls![0]).toMatchObject({ permissionQueued: true })
    // Waiting state, but no respond card: requiresConfirmation stays unset.
    expect(queued.toolCalls![0].requiresConfirmation).toBeFalsy()
    expect(queued.steps![0].status).toBe('awaiting-confirmation')

    store.handlePermissionSettled({
      sessionId: 's1',
      requestId: 'p-head',
      toolCallIds: ['tc1'],
      decision: 'allowed',
    })

    const settled = store.sessionMessages.get('s1')![0]
    expect(settled.toolCalls![0].permissionQueued).toBe(false)
    expect(settled.steps![0].status).toBe('running')
  })

  it('upgrades a queued ask to a respond card when its permission:request arrives', () => {
    const store = useChatStore()
    const toolCall: ToolCall = {
      id: 'tc1',
      toolName: 'bash',
      arguments: {},
      status: 'executing',
    } as ToolCall
    store.handleAssistantCreated({
      sessionId: 's1',
      message: assistantMessage({ toolCalls: [toolCall] }),
    })

    store.handlePermissionQueued({
      sessionId: 's1',
      requestId: 'p1',
      messageId: 'm1',
      toolCallId: 'tc1',
    })
    store.handlePermissionRequest({
      sessionId: 's1',
      requestId: 'p1',
      messageId: 'm1',
      callId: 'tc1',
      permissionType: 'bash',
      title: 'Run command',
      metadata: {},
      canRespond: true,
    })

    const message = store.sessionMessages.get('s1')![0]
    expect(message.toolCalls![0]).toMatchObject({
      permissionId: 'p1',
      requiresConfirmation: true,
      permissionQueued: false,
    })
  })
})
