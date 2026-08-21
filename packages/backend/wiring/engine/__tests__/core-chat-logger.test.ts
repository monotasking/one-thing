import { describe, expect, it } from 'vitest'
import {
  buildMessageBodyShapePayload,
  chatLogContentTextLength,
} from '@onething/core/engine'

describe('core chat logger helpers', () => {
  it('computes message body shape rows and totals', () => {
    const payload = buildMessageBodyShapePayload([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: 'answer',
        reasoningContent: 'thinking',
        toolCalls: [{ toolCallId: 'call_1', toolName: 'read', args: { path: 'a.txt' } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', result: { ok: true } }],
      },
    ], { provider: 'deepseek' })

    expect(payload.provider).toBe('deepseek')
    expect(payload.messageCount).toBe(3)
    expect(payload.roleCounts).toEqual({ user: 1, assistant: 1, tool: 1 })
    expect(payload.rows).toEqual([
      expect.objectContaining({ role: 'user', contentChars: 5 }),
      expect.objectContaining({ role: 'assistant', toolCalls: 1, reasoningChars: 8 }),
      expect.objectContaining({ role: 'tool', toolResults: 1, resultChars: 11 }),
    ])
    expect(payload.totals.toolCalls).toBe(1)
    expect(payload.totals.toolResults).toBe(1)
  })

  it('keeps compact display helpers deterministic', () => {
    expect(chatLogContentTextLength([{ text: 'abc' }, { data: 'de' }])).toBe(5)
  })
})
