import { describe, expect, it } from 'vitest'
import { derivePhase, estimateTokens } from '../generation-status'

describe('estimateTokens', () => {
  it('CJK ≈ 1 token per char, latin ≈ 4 chars per token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('你好 abcd')).toBeCloseTo(2 + 5 / 4)
  })
})

describe('derivePhase', () => {
  it('nothing yet → waiting; top reasoning → thinking; text → responding', () => {
    expect(derivePhase({ content: '', contentParts: [] }).phase).toBe('waiting')
    expect(derivePhase({ content: '', reasoning: '让我想想', contentParts: [] }).phase).toBe('thinking')
    expect(derivePhase({ content: '好', contentParts: [{ type: 'text', content: '好' }] }).phase).toBe('responding')
  })

  it('last content part decides: inline reasoning / waiting placeholder', () => {
    expect(derivePhase({
      content: 'a',
      contentParts: [{ type: 'text', content: 'a' }, { type: 'reasoning', content: '再想' }],
    }).phase).toBe('thinking')
    expect(derivePhase({
      content: 'a',
      contentParts: [{ type: 'text', content: 'a' }, { type: 'waiting' }],
    }).phase).toBe('waiting')
  })

  it('a live tool wins, and names itself; approval is its own phase', () => {
    const executing = derivePhase({
      content: '',
      contentParts: [{ type: 'text', content: 'x' }],
      toolCalls: [{ id: 't1', toolId: 'bash', toolName: 'bash', arguments: {}, status: 'executing' } as never],
    })
    expect(executing).toEqual({ phase: 'tool', toolName: 'bash' })

    const approval = derivePhase({
      content: '',
      contentParts: [],
      toolCalls: [{ id: 't1', toolId: 'bash', toolName: 'bash', arguments: {}, status: 'pending', requiresConfirmation: true } as never],
    })
    expect(approval).toEqual({ phase: 'approval', toolName: 'bash' })

    // Finished tools do not count.
    expect(derivePhase({
      content: '',
      contentParts: [{ type: 'waiting' }],
      toolCalls: [{ id: 't1', toolId: 'bash', toolName: 'bash', arguments: {}, status: 'completed' } as never],
    }).phase).toBe('waiting')
  })
})
