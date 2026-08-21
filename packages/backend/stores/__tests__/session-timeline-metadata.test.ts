import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatSession } from '@shared/ipc.js'
import {
  deriveRetainedContextSize,
  repairSessionTimelineMetadata,
  sanitizeSessionOnStartup,
} from '../sessions.js'

function user(index: number): ChatMessage {
  return {
    id: `user-${index}`,
    role: 'user',
    content: `user ${index}`,
    timestamp: index,
  }
}

function assistant(index: number, inputTokens?: number): ChatMessage {
  return {
    id: `assistant-${index}`,
    role: 'assistant',
    content: `assistant ${index}`,
    timestamp: index,
    usage: inputTokens === undefined
      ? undefined
      : {
          inputTokens,
          outputTokens: 1,
          totalTokens: inputTokens + 1,
        },
  }
}

function session(messages: ChatMessage[], summaryUpToMessageId?: string): ChatSession {
  return {
    id: 's1',
    name: 'Test',
    messages,
    createdAt: 0,
    updatedAt: 0,
    summary: summaryUpToMessageId ? 'Previous summary' : undefined,
    summaryUpToMessageId,
    summaryCreatedAt: summaryUpToMessageId ? 1 : undefined,
  }
}

describe('session timeline metadata repair', () => {
  it('keeps valid compact metadata without recomputing context by default', () => {
    const testSession = session([user(1), assistant(2, 120)], 'assistant-2')
    testSession.contextSize = 0
    testSession.lastInputTokens = 0

    // COW(P0.2 area ①/F4):没改就返回 undefined,入参一个字段都没动。
    expect(repairSessionTimelineMetadata(testSession, testSession.messages)).toBeUndefined()
    expect(testSession.summary).toBe('Previous summary')
    expect(testSession.summaryUpToMessageId).toBe('assistant-2')
    expect(testSession.contextSize).toBe(0)
    expect(testSession.lastInputTokens).toBe(0)
  })

  it('clears dangling summary metadata and restores context from retained provider usage', () => {
    const testSession = session([user(1), assistant(2, 120), user(3)], 'missing-message')
    testSession.contextSize = 999
    testSession.lastInputTokens = 999

    const repaired = repairSessionTimelineMetadata(testSession, testSession.messages)
    expect(repaired).toBeDefined()
    expect(repaired!.summary).toBeUndefined()
    expect(repaired!.summaryUpToMessageId).toBeUndefined()
    expect(repaired!.summaryCreatedAt).toBeUndefined()
    expect(repaired!.contextSize).toBe(120)
    expect(repaired!.lastInputTokens).toBe(120)
    // 入参不动:COW 的收益就在这一行。
    expect(testSession.summary).toBe('Previous summary')
    expect(testSession.contextSize).toBe(999)
  })

  it('prefers the latest retained step usage over accumulated assistant usage', () => {
    const assistantMessage = assistant(2, 200)
    assistantMessage.steps = [
      {
        id: 'step-1',
        type: 'tool-call',
        title: 'Step 1',
        status: 'completed',
        timestamp: 1,
        turnIndex: 1,
        usage: { inputTokens: 80, outputTokens: 1, totalTokens: 81 },
      },
      {
        id: 'step-2',
        type: 'tool-call',
        title: 'Step 2',
        status: 'completed',
        timestamp: 2,
        turnIndex: 2,
        usage: { inputTokens: 140, outputTokens: 1, totalTokens: 141 },
      },
    ]

    const derived = session([user(1), assistantMessage])
    expect(deriveRetainedContextSize(derived.messages, derived)).toBe(140)
  })

  it('does not derive context from accumulated tool-loop assistant usage without step usage', () => {
    const assistantMessage = assistant(2, 4606545)
    assistantMessage.toolCalls = [
      {
        id: 'call-1',
        toolName: 'bash',
        toolId: 'bash',
        status: 'completed',
        arguments: {},
      } as NonNullable<ChatMessage['toolCalls']>[number],
    ]

    const testSession = session([user(1), assistantMessage])
    testSession.contextSize = 4606545
    testSession.lastInputTokens = 4606545

    expect(deriveRetainedContextSize(testSession.messages, testSession)).toBe(0)
    const repaired = repairSessionTimelineMetadata(testSession, testSession.messages)
    expect(repaired!.contextSize).toBe(0)
    expect(repaired!.lastInputTokens).toBe(0)
    expect(testSession.contextSize).toBe(4606545)
  })

  it('ignores provider usage before a valid summary anchor when recomputing context', () => {
    const testSession = session([user(1), assistant(2, 300), user(3)], 'assistant-2')
    testSession.contextSize = 999
    testSession.lastInputTokens = 999

    const repaired = repairSessionTimelineMetadata(testSession, testSession.messages, { recomputeContextSize: true })
    expect(repaired!.summaryUpToMessageId).toBe('assistant-2')
    expect(repaired!.contextSize).toBe(0)
    expect(repaired!.lastInputTokens).toBe(0)
  })

  it('derives context from retained assistant usage after a valid summary anchor', () => {
    const testSession = session([
      user(1),
      assistant(2, 300),
      user(3),
      assistant(4, 180),
      user(5),
    ], 'assistant-2')

    expect(deriveRetainedContextSize(testSession.messages, testSession)).toBe(180)
  })

  it('sets context to zero after truncation when no retained provider usage exists', () => {
    const testSession = session([user(1)])
    testSession.contextSize = 999
    testSession.lastInputTokens = 999

    const repaired = repairSessionTimelineMetadata(testSession, testSession.messages, { recomputeContextSize: true })
    expect(repaired!.contextSize).toBe(0)
    expect(repaired!.lastInputTokens).toBe(0)
  })

  it('clears stale requiresConfirmation on startup so no dead approval card renders', () => {
    const paused: ChatMessage = {
      id: 'assistant-paused',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [
        {
          id: 'call-1',
          toolId: 'bash',
          toolName: 'bash',
          arguments: { command: 'rm -rf build' },
          status: 'pending',
          requiresConfirmation: true,
          timestamp: 1,
        },
      ],
      steps: [
        {
          id: 'step-1',
          status: 'awaiting-confirmation',
          title: 'Run bash command',
          toolCallId: 'call-1',
        } as never,
      ],
    }
    const testSession = session([user(1), paused])

    // COW:修好的是新会话里的新消息;手里那条 `paused` 原样不动(F4 的正解 ——
    // 老写法断言的就是"改的是手里这条",那份依赖本身就是这次要修的 bug)。
    const repaired = sanitizeSessionOnStartup(testSession)
    expect(repaired).toBeDefined()
    const repairedMessage = repaired!.messages.find(message => message.id === 'assistant-paused')!
    const toolCall = repairedMessage.toolCalls![0]
    expect(toolCall.status).toBe('cancelled')
    expect(toolCall.requiresConfirmation).toBe(false)
    expect(toolCall.error).toContain('permission request was not answered')
    // R-a(§13.6):cancelled(它没有失败,是没跑完)。
    expect(repairedMessage.steps![0].status).toBe('cancelled')
    expect(paused.toolCalls![0].status).toBe('pending')
    expect(paused.toolCalls![0].requiresConfirmation).toBe(true)
  })

  it('marks stale context compact markers as failed on startup', () => {
    const compactingMessage: ChatMessage = {
      id: 'compact-1',
      role: 'system',
      content: JSON.stringify({
        type: 'context-compact',
        status: 'compacting',
        summary: '',
        compactedMessageCount: 40,
      }),
      timestamp: 1,
    }
    const testSession = session([user(1), compactingMessage])

    const repaired = sanitizeSessionOnStartup(testSession)
    expect(repaired).toBeDefined()
    const repairedMessage = repaired!.messages.find(message => message.id === 'compact-1')!
    expect(JSON.parse(String(repairedMessage.content))).toEqual({
      type: 'context-compact',
      status: 'failed',
      summary: '',
      error: 'Context compact was interrupted before completion.',
      compactedMessageCount: 40,
    })
    // 入参那条仍是 compacting —— 没有就地改。
    expect(JSON.parse(compactingMessage.content)).toMatchObject({ status: 'compacting' })
  })
})
