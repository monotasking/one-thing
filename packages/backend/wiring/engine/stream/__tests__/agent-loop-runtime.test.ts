import { describe, expect, it } from 'vitest'
import {
  buildAgentLoopContextHardLimitError,
  getAgentLoopTransientTail,
  getAgentLoopContextBlockReason,
} from '../agent-loop-runtime.js'
import type { ChatSession } from '@shared/ipc.js'

function sessionWithContextSize(contextSize: number): ChatSession {
  return {
    id: 's1',
    name: 'Session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    contextSize,
  }
}

describe('agent loop stream runtime', () => {
  it('keeps the current in-memory tool turn tail when rebuilding compacted messages', () => {
    expect(getAgentLoopTransientTail([
      { role: 'system', content: 'summary' },
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'file text' },
    ])).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'file text' },
    ])
  })

  it('blocks later provider turns when context remains over the hard limit', () => {
    const reason = getAgentLoopContextBlockReason({
      turn: 2,
      providerId: 'deepseek',
      compactEnabled: true,
      session: sessionWithContextSize(9900),
      budget: {
        modelContextLength: 10000,
        reservedOutputTokens: 512,
        thresholdPercent: 85,
      },
    })

    expect(reason).toBe(buildAgentLoopContextHardLimitError(9900, 512, 10000))
  })

  it('does not block the first turn, disabled compaction, or ACP providers', () => {
    const budget = {
      modelContextLength: 10000,
      reservedOutputTokens: 512,
      thresholdPercent: 85,
    }

    expect(getAgentLoopContextBlockReason({
      turn: 1,
      providerId: 'deepseek',
      compactEnabled: true,
      session: sessionWithContextSize(9900),
      budget,
    })).toBeUndefined()
    expect(getAgentLoopContextBlockReason({
      turn: 2,
      providerId: 'deepseek',
      compactEnabled: false,
      session: sessionWithContextSize(9900),
      budget,
    })).toBeUndefined()
    expect(getAgentLoopContextBlockReason({
      turn: 2,
      providerId: 'acp',
      compactEnabled: true,
      session: sessionWithContextSize(9900),
      budget,
    })).toBeUndefined()
  })
})
