import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventEnvelope, SessionStreamPayload } from '@shared/events/envelope'
import { SESSION_PREFETCH_HOVER_MS } from '../components/motion'
import { configureChatPort, type ChatPort } from './chat-port'
import { chatSources, useChatSource } from './chat-source'
import {
  SESSION_PREFETCH_RATE,
  SESSION_PREFETCH_WINDOW_MS,
  hoverSessionRow,
  leaveSessionRow,
  prefetchSession,
  resetChatPrefetch,
} from './chat-prefetch'

/**
 * **悬停预取的判据**(第 6 单)。一台 core 都不起 —— 端口换成假的,数的是
 * 「这条会话的机器起过几次底」。
 *
 * 钉住的四件事:要停满读认窗口才发、同一行重复报到不重新起表、离开只掐表
 * 不撤单、已经活着的不重发,外加一秒至多 `SESSION_PREFETCH_RATE` 发。
 *
 * (「开机空闲预热最近 3 条」那半边 09-10 被真机读数毙掉了,判词与数字整段
 * 写在 `chat-prefetch.ts` 的文件头 —— 这里因此没有它的用例。)
 */

const T0 = 1_700_000_000_000

/** 一条**能折出东西**的最小账本(与 `chat-source.test` 的 `createdIn` 同形)。 */
const created = (sessionId: string) => ({
  seq: 1,
  time: T0,
  type: 'session/created',
  data: { sessionId },
})

interface Harness {
  port: ChatPort
  /** 这条会话被起底过几次(= 预取真发出去过几次)。 */
  loads: (sessionId: string) => number
}

function harness(): Harness {
  const loadCounts = new Map<string, number>()
  return {
    loads: (sessionId) => loadCounts.get(sessionId) ?? 0,
    port: {
      ready: async () => undefined,
      /*
       * 页那条路在这只假端口上**说不** —— 于是起底退回整份账本那条老路,
       * 而这些用例数的正是「起底发生过没有」,两条路都算数(与 `chat-source.test`
       * 的假端口逐字同判:给一份空页是造事实,说不才是它此刻的真话)。
       */
      readPage: () => Promise.reject(new Error('no page in this fake port')),
      readToolResult: () => Promise.resolve(undefined),
      listRaw: async (sessionId: string) => {
        loadCounts.set(sessionId, (loadCounts.get(sessionId) ?? 0) + 1)
        return { events: [created(sessionId)] as never }
      },
      readBlob: async () => ({}) as never,
      onSessionEvent: (_callback: (envelope: SessionEventEnvelope) => void) => () => undefined,
      onSessionStream: (_callback: (payload: SessionStreamPayload) => void) => () => undefined,
      sendMessage: async () => ({ success: true }),
      listPendingPermissions: async () => ({ success: true, pending: [] }),
      respondPermission: async () => ({ success: true }),
      abort: async () => ({ success: true }),
      retryMessage: async () => ({ success: true }),
    } as unknown as ChatPort,
  }
}

/** 起底是异步的(端口 → 折 → 推屏),断言前把那几拍等掉。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  useChatSource.getState().reset()
  resetChatPrefetch()
})

afterEach(() => {
  useChatSource.getState().reset()
  resetChatPrefetch()
  configureChatPort(undefined)
  vi.useRealTimers()
})

describe('① 悬停预取', () => {
  it('没停满读认窗口就走:一发都不发', async () => {
    vi.useFakeTimers()
    const h = harness()
    configureChatPort(h.port)

    hoverSessionRow('s1')
    // 差一毫秒 —— 「快到了」不是「到了」。
    vi.advanceTimersByTime(SESSION_PREFETCH_HOVER_MS - 1)
    leaveSessionRow()
    vi.advanceTimersByTime(SESSION_PREFETCH_HOVER_MS * 4)

    expect(h.loads('s1')).toBe(0)
    expect(chatSources.get('s1')).toBeUndefined()
  })

  it('停满读认窗口:发一发,那台机器停进池里等着被点', async () => {
    const h = harness()
    configureChatPort(h.port)

    hoverSessionRow('s1')
    await new Promise((resolve) => setTimeout(resolve, SESSION_PREFETCH_HOVER_MS + 20))
    await settle()

    expect(h.loads('s1')).toBe(1)
    // 预取**不持有** —— 机器活着,但停在池里(在册那一头是空的)。
    expect(chatSources.dockedIds()).toContain('s1')
    expect(chatSources.ownedIds()).not.toContain('s1')
  })

  it('行里换个子元素重复报到不重新起表(否则永远停不满那个窗口)', async () => {
    const h = harness()
    configureChatPort(h.port)

    // 真表不是假表:这一条要的正是「两段停留加起来算不算停满」,而
    // `prefetchSession` 之后那条起底链是异步的,拨假表拨不出它。
    hoverSessionRow('s1')
    await new Promise((resolve) => setTimeout(resolve, SESSION_PREFETCH_HOVER_MS - 40))
    hoverSessionRow('s1') // 指针从标题走到了图钉上:同一行,恒等
    await new Promise((resolve) => setTimeout(resolve, 60))
    await settle()

    // 重新起表的话这一发要到 140+180=320ms 才出发,此刻(200ms)一定还没到。
    expect(h.loads('s1')).toBe(1)
  })

  it('离开只掐表,**不撤**已经发出去的那一发', async () => {
    const h = harness()
    configureChatPort(h.port)

    hoverSessionRow('s1')
    await new Promise((resolve) => setTimeout(resolve, SESSION_PREFETCH_HOVER_MS + 20))
    leaveSessionRow()
    await settle()

    expect(h.loads('s1')).toBe(1)
    expect(chatSources.dockedIds()).toContain('s1')
  })

  it('已经在册 / 已经在池的那条:一发都不发', async () => {
    const h = harness()
    configureChatPort(h.port)

    // 在册(屏幕上正开着)。
    chatSources.acquire('open')
    await settle()
    expect(prefetchSession('open')).toBe(false)

    // 在池(刚被预取过 / 刚切走)。
    expect(prefetchSession('parked')).toBe(true)
    await settle()
    expect(chatSources.dockedIds()).toContain('parked')
    expect(prefetchSession('parked')).toBe(false)

    expect(h.loads('open')).toBe(1)
    expect(h.loads('parked')).toBe(1)
  })
})

describe('速率闸:一秒内至多 N 发(两条产地共用同一张预算)', () => {
  it(`一秒里第 ${SESSION_PREFETCH_RATE + 1} 发被挡下,窗口过去之后放行`, async () => {
    const h = harness()
    configureChatPort(h.port)
    const t = T0

    const ids = Array.from({ length: SESSION_PREFETCH_RATE + 1 }, (_, i) => `r${i}`)
    const sent = ids.map((id) => prefetchSession(id, t))
    expect(sent.filter(Boolean)).toHaveLength(SESSION_PREFETCH_RATE)
    expect(sent[SESSION_PREFETCH_RATE]).toBe(false)
    await settle()
    // 被挡下的那条**一台机器都没造**(不是造了再丢)。
    expect(chatSources.get(ids[SESSION_PREFETCH_RATE])).toBeUndefined()
    expect(h.loads(ids[SESSION_PREFETCH_RATE])).toBe(0)

    // 滑出窗口之后同一条会话照发。
    expect(prefetchSession(ids[SESSION_PREFETCH_RATE], t + SESSION_PREFETCH_WINDOW_MS)).toBe(true)
    await settle()
    expect(h.loads(ids[SESSION_PREFETCH_RATE])).toBe(1)
  })

  it('闸是**一张**表:谁先用满,后面那一发就没有预算(将来多一条产地也照此)', async () => {
    const h = harness()
    configureChatPort(h.port)

    for (let i = 0; i < SESSION_PREFETCH_RATE; i += 1) {
      expect(prefetchSession(`w${i}`)).toBe(true)
    }
    await settle()
    expect(prefetchSession('hovered')).toBe(false)
    expect(h.loads('hovered')).toBe(0)
  })
})
