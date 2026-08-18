import { describe, expect, it, vi } from 'vitest'
import { createDefaultSettings, DEFAULT_CHAT_SETTINGS } from '@shared/defaults/settings.js'
import type { StreamContext, StreamSender } from '../stream-processor.js'

const emit = vi.fn(() => Promise.resolve())
const getSession = vi.fn(() => ({
  id: 's1',
  name: 'Session',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  contextSize: 9000,
}))
const compactSessionContext = vi.fn((_input: {
  onProgress?: (progress: { chunk: number; totalChunks: number }) => Promise<void> | void
}) => Promise.resolve({
  success: true,
  summary: 'compacted',
  retainedContextSize: 0,
}))
const shouldSkipAutoCompactForProviderUsageMismatch = vi.fn(() => false)

vi.mock('../../../store.js', () => ({
  getSession,
}))

vi.mock('../../../events/index.js', () => ({
  getEventBus: () => ({ emit }),
}))

vi.mock('../../context-compact.js', () => ({
  compactSessionContext,
  shouldSkipAutoCompactForProviderUsageMismatch,
}))

const { maybeCompactAgentLoopContext } = await import('../agent-loop-runtime.js')

function mockSender(): StreamSender {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  }
}

function ctx(): StreamContext {
  const settings = createDefaultSettings()
  settings.chat = {
    ...DEFAULT_CHAT_SETTINGS,
    contextCompactEnabled: true,
    contextCompactKeepRecentTurns: 6,
    contextCompactThreshold: 85,
  }

  return {
    sessionId: 's1',
    assistantMessageId: 'm1',
    abortSignal: new AbortController().signal,
    settings,
    providerConfig: { model: 'deepseek-v4-flash', selectedModels: ['deepseek-v4-flash'] },
    providerId: 'deepseek',
    toolSettings: undefined,
    sender: mockSender(),
  }
}

describe('agent loop runtime compaction', () => {
  it('runs compact and returns rebuilt messages before a later turn', async () => {
    const rebuilt = [{ role: 'system' as const, content: 'rebuilt summary' }]
    const rebuildMessages = vi.fn(async () => rebuilt)

    const result = await maybeCompactAgentLoopContext({
      ctx: ctx(),
      turn: 2,
      messages: [
        // Long enough that the request estimate crosses 85% of the
        // 10000-token model context and triggers the threshold reason.
        { role: 'user', content: 'hello '.repeat(10000) },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call_1', content: 'tool result' },
      ],
      budget: {
        modelContextLength: 10000,
        reservedOutputTokens: 512,
        thresholdPercent: 85,
      },
      rebuildMessages,
    })

    expect(compactSessionContext).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      providerId: 'deepseek',
      keepRecentTurns: 6,
    }))
    expect(emit).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'context:compact-completed',
      success: true,
      summary: 'compacted',
    }))
    expect(emit).toHaveBeenCalledWith('s1', {
      type: 'context:size-updated',
      contextSize: 0,
    })
    expect(rebuildMessages).toHaveBeenCalled()
    expect(result).toBe(rebuilt)
  })

  it('C6:回合中这条路自己接进度线 —— onProgress 转发成 context:compact-progress', async () => {
    // 这条路不经过引擎的 runContextCompact,进度必须在 adapters 里接。
    compactSessionContext.mockImplementationOnce(async (input: {
      onProgress?: (progress: { chunk: number; totalChunks: number }) => Promise<void> | void
    }) => {
      await input.onProgress?.({ chunk: 1, totalChunks: 3 })
      await input.onProgress?.({ chunk: 2, totalChunks: 3 })
      return { success: true, summary: 'compacted', retainedContextSize: 0 }
    })

    await maybeCompactAgentLoopContext({
      ctx: ctx(),
      turn: 2,
      messages: [
        { role: 'user', content: 'hello '.repeat(10000) },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call_1', content: 'tool result' },
      ],
      budget: {
        modelContextLength: 10000,
        reservedOutputTokens: 512,
        thresholdPercent: 85,
      },
      rebuildMessages: vi.fn(async () => []),
    })

    expect(emit).toHaveBeenCalledWith('s1', {
      type: 'context:compact-progress',
      chunk: 1,
      totalChunks: 3,
    })
    expect(emit).toHaveBeenCalledWith('s1', {
      type: 'context:compact-progress',
      chunk: 2,
      totalChunks: 3,
    })
  })
})
