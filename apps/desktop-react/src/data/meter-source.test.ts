import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { GetSessionUsageResponse } from '@shared/ipc/usage'
import { configureChatPort } from './chat-port'
import { markFirstScreenLanded, markFirstScreenPending, resetFirstScreen } from './first-screen'
import { configureMeterPort } from './meter-port'
import {
  EMPTY_VIEW,
  cacheHitPctOf,
  contextUsedOf,
  isMeterInvalidation,
  meterQuery,
  meterViewOf,
  useMeterSource,
  useMeterView,
} from './meter-source'
import { prefsQuery, useModelsSource } from './models-source'
import { providerModelPrefs } from './__fixtures__/models'
import { currentSpaceId } from '../workspace/current'

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

/**
 * 一道可控的闸:关上之后账本那一口停在半空,直到 `openGate()` 放行。
 * 「重拉期间屏幕上是什么」这类断言必须在**在飞的那一刻**读,所以要有它。
 */
let gate: Promise<void> | undefined
let openGate: (() => void) | undefined

function shutGate(): void {
  gate = new Promise<void>((resolve) => {
    openGate = () => {
      gate = undefined
      resolve()
    }
  })
}

/** 把微任务队列跑干净 —— 一发取数要经过好几层 await。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

/**
 * 「屏幕上有人在看这一格」。kernel 的 `invalidate()` **只在有订阅者时**才后台补拉
 * (没人看就只留一个脏标记),而真机上环与明细卡一直订着当前这条会话 ——
 * 所以要验「账本一响就补拉」,先得把那个看客摆上。
 */
function watch(sessionId: string): () => void {
  return meterQuery.get(sessionId).subscribe(() => undefined)
}

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
  gate = undefined
  openGate = undefined
  useMeterSource.getState().reset()
  resetFirstScreen()

  configureChatPort({
    ready: async () => undefined,
    /*
     * 页那条路在这只假端口上**说不**(工单 5 ③)—— 于是这一台退回整份账本,
     * 也就是这些用例本来就在测的那条路。假端口给一份空页会把树画成空的,
     * 那是造事实;说不才是它此刻的真话。
     */
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
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
    listPendingPermissions: async () => ({ success: true, pending: [] }),
    respondPermission: async () => ({ success: true }),
  })

  configureMeterPort({
    ready: async () => undefined,
    getSessionUsage: async () => {
      fetches.usage += 1
      if (gate) await gate
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
  resetFirstScreen()
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

/*
 * 09-10 报障:用户在模型覆盖浮层里给一个**手填模型**填了 context window,
 * 读数环仍写「上下文用量未知」。上面那几条钉的是纯函数 `meterViewOf`,而病根
 * 不在它 —— 它拿到的 `windowTokens` 一直是 null,因为窗口那一句只查了目录。
 * 所以这一条必须**从 hook 那一头量**:整条链路(设置窄投影 → 覆盖优先 →
 * `useModelWindow` → `useMeterView`)接上了没有。
 */
describe('窗口:手填模型的用户覆盖', () => {
  it('目录一条都没有,但设置里填过窗口 → contextMax 是那个数,环不再是缺席态', () => {
    useModelsSource.getState().reset()
    prefsQuery.get(currentSpaceId()).patch({
      prefs: {
        defaultProvider: 'my-llm',
        configs: {
          'my-llm': providerModelPrefs({
            model: 'qwen-max',
            selectedModels: ['qwen-max'],
            contextLength: { 'qwen-max': 200_000 },
          }),
        },
      },
      custom: [{ id: 'my-llm', name: '自建' }],
    })
    useMeterSource.setState({ sessionId: 's1' })
    meterQuery.get('s1').patch({
      sessionId: 's1',
      tokens: {
        totalInputTokens: 48_200,
        totalOutputTokens: 12_600,
        totalTokens: 60_800,
        maxTokens: 0,
        lastInputTokens: 110_000,
        contextSize: 124_000,
      },
      usage: usageResponse(),
    })

    const { result, unmount } = renderHook(() => useMeterView())
    expect(result.current.contextMax).toBe(200_000)
    expect(result.current.contextUsed).toBe(124_000)
    expect(result.current.present).toBe(true)
    unmount()
    act(() => {
      useModelsSource.getState().reset()
    })
  })
})

describe('刷新时机', () => {
  it('开一条会话拉一次;两口各拉各的', async () => {
    await useMeterSource.getState().open('s1')
    expect(fetches).toEqual({ usage: 1, tokens: 1 })
    expect(meterQuery.get('s1').get().data?.sessionId).toBe('s1')
  })

  /**
   * 工单 6 ①:**首屏那一页先走**。
   *
   * core 是单线程的,读数这两口(`usage.getSession` + `sessions.getTokenUsage`)
   * 与首屏那一页抢同一根线程 —— 真机上挤在前面就是把 55ms 的第一屏推到几百
   * 毫秒后。判的是「页在飞的时候一发都没出门」,不是「早晚会拉到」。
   */
  it('页在飞的时候一发不发,页落地才拉(工单 6 ①)', async () => {
    markFirstScreenPending('s1')
    const opening = useMeterSource.getState().open('s1')
    await flush()
    expect(fetches).toEqual({ usage: 0, tokens: 0 })

    markFirstScreenLanded('s1')
    await opening
    expect(fetches).toEqual({ usage: 1, tokens: 1 })
  })

  it('让路的那一段里切走了:这一发作废,新那条自己去拉', async () => {
    markFirstScreenPending('s1')
    const opening = useMeterSource.getState().open('s1')
    await flush()
    useMeterSource.setState({ sessionId: 's2' })
    markFirstScreenLanded('s1')
    await opening
    expect(fetches).toEqual({ usage: 0, tokens: 0 })
  })

  it('run/end 与 session/compacted 再拉;别的账本行不拉', async () => {
    await useMeterSource.getState().open('s1')
    // 屏幕上有人在看这一格(真机上环与卡一直订着)——「一响就补拉」的前提。
    const stop = watch('s1')
    emit?.(ledger('s1', 'assistant/chunks'))
    await flush()
    expect(fetches.usage).toBe(1)

    emit?.(ledger('s1', 'run/end'))
    await flush()
    expect(fetches.usage).toBe(2)

    emit?.(ledger('s1', 'session/compacted'))
    await flush()
    expect(fetches.usage).toBe(3)
    stop()
  })

  it('别人家的会话事件不理会 —— 一发请求都不发', async () => {
    await useMeterSource.getState().open('s1')
    emit?.(ledger('s2', 'run/end'))
    await flush()
    expect(fetches.usage).toBe(1)
  })

  /*
   * 键控缓存必须补的那一格:在 s2 期间 s1 又跑完一轮,回到 s1 不该拿一份陈的
   * 读数画在环上。机制是「标脏但不发」+「回去时 ensure 因为脏而重拉」——
   * 没人看的那一格一发请求都不发,所以往返次数与从前逐字相同。
   */
  it('别人家的会话跑完一轮:当场只标脏;回到那条会话时才补拉', async () => {
    await useMeterSource.getState().open('s1')
    await useMeterSource.getState().open('s2')
    expect(fetches.usage).toBe(2)

    // 人在 s2,s1 那边跑完一轮 —— 没人看,所以此刻一发都不发。
    emit?.(ledger('s1', 'run/end'))
    await flush()
    expect(fetches.usage).toBe(2)

    // 回到 s1:那一格是脏的,ensure 于是真去问一次。
    await useMeterSource.getState().open('s1')
    expect(fetches.usage).toBe(3)
  })

  it('什么都没发生时回到旧会话:不白问一次(ensure 是「确保问过」不是「再问」)', async () => {
    await useMeterSource.getState().open('s1')
    await useMeterSource.getState().open('s2')
    await useMeterSource.getState().open('s1')
    expect(fetches.usage).toBe(2)
    expect(meterQuery.get('s1').get().data?.sessionId).toBe('s1')
  })

  it('换一条会话不串值:两格各记各的(键控)', async () => {
    await useMeterSource.getState().open('s1')
    await useMeterSource.getState().open('s2')
    expect(meterQuery.get('s1').get().data?.sessionId).toBe('s1')
    expect(meterQuery.get('s2').get().data?.sessionId).toBe('s2')
    expect(meterQuery.keys()).toEqual(['s1', 's2'])
  })

  it('重拉期间旧读数一直在屏上,骨架判据不退回首载(律②)', async () => {
    await useMeterSource.getState().open('s1')
    const before = meterQuery.get('s1').get().data
    expect(before?.tokens?.contextSize).toBe(124_000)

    shutGate()
    const inflight = useMeterSource.getState().refresh()
    await flush()

    const during = meterQuery.get('s1').get()
    expect(during.inflight).toBe(true)
    // 「有过内容」之后永远是 ready —— 骨架只看 phase,所以重拉不画骨架。
    expect(during.phase).toBe('ready')
    // 连引用都没换:屏幕上一格都没动过。
    expect(during.data).toBe(before)

    openGate?.()
    await inflight
    expect(meterQuery.get('s1').get().inflight).toBe(false)
  })

  it('账本一响:后台补拉的那一程,旧读数仍然在屏上(不清屏)', async () => {
    await useMeterSource.getState().open('s1')
    const before = meterQuery.get('s1').get().data
    const stop = watch('s1')

    shutGate()
    emit?.(ledger('s1', 'run/end'))
    await flush()

    expect(fetches.usage).toBe(2)
    expect(meterQuery.get('s1').get().inflight).toBe(true)
    expect(meterQuery.get('s1').get().data).toBe(before)

    openGate?.()
    await flush()
    expect(meterQuery.get('s1').get().inflight).toBe(false)
    stop()
  })

  it('悬停开卡再拉一次 —— 那一眼要是最新的', async () => {
    await useMeterSource.getState().open('s1')
    await useMeterSource.getState().refresh()
    expect(fetches.usage).toBe(2)
  })

  it('没有会话:不订不拉,读数是缺席态', async () => {
    await useMeterSource.getState().open(null)
    expect(fetches).toEqual({ usage: 0, tokens: 0 })
    expect(meterQuery.get('').get().data).toBeUndefined()
    // refresh 在草稿态是恒等,不发请求。
    await useMeterSource.getState().refresh()
    expect(fetches.usage).toBe(0)
  })

  it('一半失败不该把另一半也抹掉', async () => {
    usageThrows = true
    await useMeterSource.getState().open('s1')
    const facts = meterQuery.get('s1').get().data
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
