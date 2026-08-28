/**
 * **这只用例跑的是「旧路」**(U2-a,§17.8.7):它驱动的是手写拼装管道
 * (`handleStreamChunk` 等)并对着 `sessionMessages` 断言,而新路上那棵树由账本
 * 折叠产出、手写侧的写在 `setSessionMessages` 那道闸上被忽略(休眠)。
 *
 * 休眠不是删除 —— 开关一翻整条回来,所以它必须**继续有用例守着**。这里显式把
 * 开关按到旧路,断言一个字未改;新路的等价覆盖在 `fold-tree.test.ts`
 * (新旧路 canonical 对拍)。
 */
// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { setFoldTreeEnabled } from '@/stores/fold-tree'
import { useChatStore } from '../chat'
import type { ChatMessage, Step, ToolCall } from '@/types'

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

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    toolId: 'bash',
    toolName: 'bash',
    arguments: {},
    status: 'executing',
    timestamp: 0,
    ...overrides,
  }
}

function toolStep(call: ToolCall, overrides: Partial<Step> = {}): Step {
  return {
    id: 'step1',
    type: 'tool-call',
    title: 'Running command',
    status: 'running',
    timestamp: 0,
    turnIndex: 1,
    toolCallId: call.id,
    toolCall: call,
    ...overrides,
  }
}

describe('stream end finalizes lingering tool work', () => {
  beforeEach(() => {
    // 旧路用例(见文件头):把 U2-a 的开关按回手写拼装。
    setFoldTreeEnabled(false)
    setActivePinia(createPinia())
  })

  it('cancels steps stuck in running when no execution-end ever arrived', async () => {
    const store = useChatStore()
    const call = toolCall({ status: 'executing', startTime: 1_000 })
    store.setMessagesFromSession('s1', [
      assistantMessage({ toolCalls: [call], steps: [toolStep(call)] }),
    ])

    await store.handleStreamComplete({ sessionId: 's1', messageId: 'm1' })

    const message = store.getSessionState('s1').messages.value[0]
    expect(message.isStreaming).toBe(false)
    expect(message.steps?.[0].status).toBe('cancelled')
    expect(message.steps?.[0].error).toBeTruthy()
    expect(message.toolCalls?.[0].status).toBe('cancelled')
    expect(message.toolCalls?.[0].endTime).toBeTypeOf('number')
  })

  it('leaves tool calls awaiting user confirmation untouched', async () => {
    const store = useChatStore()
    const call = toolCall({ status: 'pending', requiresConfirmation: true })
    store.setMessagesFromSession('s1', [
      assistantMessage({
        toolCalls: [call],
        steps: [toolStep(call, { status: 'awaiting-confirmation' })],
      }),
    ])

    await store.handleStreamComplete({ sessionId: 's1', messageId: 'm1' })

    const message = store.getSessionState('s1').messages.value[0]
    expect(message.steps?.[0].status).toBe('awaiting-confirmation')
    expect(message.toolCalls?.[0].status).toBe('pending')
    expect(message.toolCalls?.[0].requiresConfirmation).toBe(true)
  })

  it('does not touch steps that finished normally', async () => {
    const store = useChatStore()
    const call = toolCall({ status: 'completed', startTime: 1_000, endTime: 2_000 })
    store.setMessagesFromSession('s1', [
      assistantMessage({
        toolCalls: [call],
        steps: [toolStep(call, { status: 'completed' })],
      }),
    ])

    await store.handleStreamComplete({ sessionId: 's1', messageId: 'm1' })

    const message = store.getSessionState('s1').messages.value[0]
    expect(message.steps?.[0].status).toBe('completed')
    expect(message.steps?.[0].error).toBeUndefined()
    expect(message.toolCalls?.[0].status).toBe('completed')
  })
})

describe('tool execution timing is owned by the main process', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('applies the authoritative startTime from the execution-start event', () => {
    const store = useChatStore()
    const call = toolCall({ status: 'pending' })
    store.setMessagesFromSession('s1', [
      assistantMessage({ toolCalls: [call], steps: [toolStep(call, { status: 'pending' })] }),
    ])

    store.handleToolExecutionStart({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      stepId: 'step1',
      toolName: 'bash',
      args: {},
      startTime: 123_456,
    })

    const message = store.getSessionState('s1').messages.value[0]
    expect(message.toolCalls?.[0].startTime).toBe(123_456)
    expect(message.toolCalls?.[0].status).toBe('executing')
  })

  it('applies the authoritative durationMs from the execution-end event', () => {
    const store = useChatStore()
    const call = toolCall({ status: 'executing', startTime: 1_000 })
    store.setMessagesFromSession('s1', [
      assistantMessage({ toolCalls: [call], steps: [toolStep(call)] }),
    ])

    store.handleToolExecutionEnd({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      stepId: 'step1',
      result: { content: [{ type: 'text', text: 'ok' }] },
      durationMs: 843.2,
    })

    const message = store.getSessionState('s1').messages.value[0]
    expect(message.toolCalls?.[0].status).toBe('completed')
    expect(message.toolCalls?.[0].durationMs).toBe(843.2)
    expect(message.steps?.[0].status).toBe('completed')
  })
})
