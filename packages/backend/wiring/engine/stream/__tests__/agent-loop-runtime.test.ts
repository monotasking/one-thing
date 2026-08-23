import { describe, expect, it } from 'vitest'
import { getAgentLoopTransientTail } from '../agent-loop-runtime.js'

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
})
