import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { GetSessionUsageResponse } from '@shared/ipc/usage'
import { configureChatPort } from './chat-port'
import { configureMeterPort } from './meter-port'
import {
  EMPTY_VIEW,
  cacheHitPctOf,
  contextUsedOf,
  isMeterInvalidation,
  meterViewOf,
  useMeterSource,
} from './meter-source'

/**
 * 读数四真(D2 波一)。两块各自钉死:
 *  ① **缺席态** —— 窗口不知道 / 缓存分母为 0 / 没有会话,三种都不许编出一个数;
 *  ② **刷新时机** —— 会话切换拉一次、`run/end` 与 `session/compacted` 再拉,
 *     别的推送一概不拉(读数是每轮结账一次的东西,不跟着 delta 走)。
 */

function usageResponse(over: Partial<GetSessionUsageResponse['usage']> = {}): GetSessionUsageResponse {
  return {
    apiCostUSD: 0.87,
    subscriptionCostUSD: 0,
    turnCount: 3,
    usage: {
      inputTokens: 48_200,
      outputTokens: 12_600,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 60_800,
      ...over,
    },
  }
}

let fetches: { usage: number; tokens: number }
let emit: ((envelope: SessionEventEnvelope) => void) | undefined
let usageThrows = false

function ledger(sessionId: string, type: string): SessionEventEnvelope {
  return {
    sessionId,
    event: { type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT, record: { type } },
  } as unknown as SessionEventEnvelope
}

beforeEach(() => {
  fetches = { usage: 0, tokens: 0 }
  usageThrows = false
  emit = undefined
  useMeterSource.getState().reset()

  configureChatPort({
    ready: async () => undefined,
    listRaw: async () => ({ events: [] }),
    readBlob: async () => ({}),
    onSessionEvent: (callback) => {
      emit = callback
      return () => {
        emit = undefined
      }
    },
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
  })

  configureMeterPort({
    ready: async () => undefined,
    getSessionUsage: async () => {
      fetches.usage += 1
      if (usageThrows) throw new Error('账本答不上话')
      return usageResponse()
    },
    getTokenUsage: async () => {
      fetches.tokens += 1
      return {
        success: true,
        usage: {
          totalInputTokens: 48_200,
          totalOutputTokens: 12_600,
          totalTokens: 60_800,
          maxTokens: 0,
          lastInputTokens: 110_000,
          contextSize: 124_000,
        },
      }
    },
  })
})

afterEach(() => {
  configureChatPort(undefined)
  configureMeterPort(undefined)
  useMeterSource.getState().reset()
})

describe('这一轮送进去多少', () => {
  it('取 contextSize 与 lastInputTokens 里大的那个(与 core 的 providerInputTokens 同口径)', () => {
    expect(contextUsedOf({ contextSize: 124_000, lastInputTokens: 110_000 } as never)).toBe(124_000)
    expect(contextUsedOf({ contextSize: 0, lastInputTokens: 110_000 } as never)).toBe(110_000)
    expect(contextUsedOf(null)).toBeNull()
  })
})

describe('缓存命中', () => {
  it('分母为 0 → null(整行不画),不是「命中率 0%」', () => {
    expect(cacheHitPctOf(usageResponse({ inputTokens: 0, cacheReadTokens: 0 }))).toBeNull()
    expect(cacheHitPctOf(null)).toBeNull()
  })

  it('有读缓存就按 读/(读+输入) 取整', () => {
    expect(cacheHitPctOf(usageResponse({ inputTokens: 1_000, cacheReadTokens: 9_000 }))).toBe(90)
  })
})

describe('四行的缺席态', () => {
  const facts = {
    sessionId: 's1',
    tokens: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      maxTokens: 0,
      lastInputTokens: 110_000,
      contextSize: 124_000,
    },
    usage: usageResponse(),
  }

  it('窗口不知道 → contextMax 为 null(用量照画)', () => {
    const view = meterViewOf(facts, null)
    expect(view.contextUsed).toBe(124_000)
    expect(view.contextMax).toBeNull()
  })

  it('窗口知道 → 原样带出来', () => {
    expect(meterViewOf(facts, 200_000).contextMax).toBe(200_000)
  })

  it('厂商没报价 → 那一格不出现;报了才有', () => {
    expect(meterViewOf(facts, null).providerCostUsd).toBeNull()
    const quoted = { ...facts, usage: { ...usageResponse(), providerCostUSD: 1.5 } }
    expect(meterViewOf(quoted, null).providerCostUsd).toBe(1.5)
    // 报了 0 与没报是同一件事:那一行都不画。
    const zero = { ...facts, usage: { ...usageResponse(), providerCostUSD: 0 } }
    expect(meterViewOf(zero, null).providerCostUsd).toBeNull()
  })

  it('没有会话(草稿态)→ 整份缺席,一个数都不编', () => {
    expect(meterViewOf(null, 200_000)).toEqual(EMPTY_VIEW)
  })

  it('两口都没答上话 → present 为 false', () => {
    expect(meterViewOf({ sessionId: 's1', tokens: null, usage: null }, 200_000).present).toBe(false)
  })
})

describe('刷新时机', () => {
  it('开一条会话拉一次;两口各拉各的', async () => {
    await useMeterSource.getState().open('s1')
    expect(fetches).toEqual({ usage: 1, tokens: 1 })
    expect(useMeterSource.getState().facts?.sessionId).toBe('s1')
  })

  it('run/end 与 session/compacted 再拉;别的账本行不拉', async () => {
    await useMeterSource.getState().open('s1')
    emit?.(ledger('s1', 'assistant/chunks'))
    await Promise.resolve()
    expect(fetches.usage).toBe(1)

    emit?.(ledger('s1', 'run/end'))
    await Promise.resolve()
    await Promise.resolve()
    expect(fetches.usage).toBe(2)

    emit?.(ledger('s1', 'session/compacted'))
    await Promise.resolve()
    await Promise.resolve()
    expect(fetches.usage).toBe(3)
  })

  it('别人家的会话事件不理会', async () => {
    await useMeterSource.getState().open('s1')
    emit?.(ledger('s2', 'run/end'))
    await Promise.resolve()
    await Promise.resolve()
    expect(fetches.usage).toBe(1)
  })

  it('悬停开卡再拉一次 —— 那一眼要是最新的', async () => {
    await useMeterSource.getState().open('s1')
    await useMeterSource.getState().refresh()
    expect(fetches.usage).toBe(2)
  })

  it('没有会话:不订不拉,读数是缺席态', async () => {
    await useMeterSource.getState().open(null)
    expect(fetches).toEqual({ usage: 0, tokens: 0 })
    expect(useMeterSource.getState().facts).toBeNull()
    // refresh 在草稿态是恒等,不发请求。
    await useMeterSource.getState().refresh()
    expect(fetches.usage).toBe(0)
  })

  it('一半失败不该把另一半也抹掉', async () => {
    usageThrows = true
    await useMeterSource.getState().open('s1')
    const facts = useMeterSource.getState().facts
    expect(facts?.usage).toBeNull()
    expect(facts?.tokens?.contextSize).toBe(124_000)
  })

  it('只认账本活事件那条推送', () => {
    expect(isMeterInvalidation({ type: 'session:stream', record: { type: 'run/end' } })).toBe(false)
    expect(
      isMeterInvalidation({ type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT, record: { type: 'run/end' } }),
    ).toBe(true)
    expect(isMeterInvalidation(null)).toBe(false)
  })
})
