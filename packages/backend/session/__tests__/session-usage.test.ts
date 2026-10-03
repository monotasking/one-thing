import { describe, expect, it, vi } from 'vitest'
import {
  clearOnethingSessionUsage,
  getOnethingSessionUsage,
  normalizeOnethingSessionTokenUsage,
  updateOnethingSessionUsage,
} from '../session-usage.js'

describe('session usage runtime operations', () => {
  it('normalizes missing session usage to renderer-facing defaults', () => {
    expect(normalizeOnethingSessionTokenUsage(undefined)).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      maxTokens: 128000,
      lastInputTokens: 0,
      contextSize: 0,
    })
  })

  it('gets normalized usage through the storage adapter', () => {
    const getSessionTokenUsage = vi.fn(() => ({
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalTokens: 30,
      lastInputTokens: 7,
      contextSize: 27,
    }))

    expect(getOnethingSessionUsage({
      sessionId: 's1',
      maxTokens: 200000,
      getSessionTokenUsage,
    })).toEqual({
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalTokens: 30,
      maxTokens: 200000,
      lastInputTokens: 7,
      contextSize: 27,
    })
    expect(getSessionTokenUsage).toHaveBeenCalledWith('s1')
  })

  it('updates usage through the storage adapter', () => {
    const updateSessionTokenUsage = vi.fn()
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
    const lastTurnUsage = { inputTokens: 4, outputTokens: 5 }

    updateOnethingSessionUsage({
      sessionId: 's1',
      usage,
      lastTurnUsage,
      updateSessionTokenUsage,
    })

    expect(updateSessionTokenUsage).toHaveBeenCalledWith('s1', usage, lastTurnUsage)
  })

  it('keeps clear as a storage-owned no-op', () => {
    expect(clearOnethingSessionUsage('s1')).toBeUndefined()
  })
})
