import { describe, expect, it } from 'vitest'
import {
  createSessionProjectionState,
  reduceSessionProjection,
} from '@onething/core/session/projection/reducer'
import { __countMemoMisses, materializeChatMessagesCached } from './chat-materialize'

/**
 * 增量物化的四条守卫(09-01 P0)。钉的是**引用契约**,不是值:下游(MessageRow
 * 的 memo、assemble 的按引用 memo)短路靠的全是「没变的消息逐帧是同一个对象」。
 * 值相等而引用换新 = 契约破了 = 长会话每帧重付全款,正是修前 1155ms 帧的病。
 */

const T0 = 1_700_000_000_000

type Ev = { seq: number; time: number; type: string; data: unknown }

function baseLedger(): Ev[] {
  return [
    { seq: 1, time: T0, type: 'session/created', data: { sessionId: 's1' } },
    {
      seq: 2,
      time: T0,
      type: 'user/message',
      data: { message: { id: 'u1', role: 'user', content: '第一问', timestamp: T0 } },
    },
    { seq: 3, time: T0, type: 'run/start', data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 } },
    {
      seq: 4,
      time: T0,
      type: 'assistant/chunks',
      data: { runId: 'r1', requestIndex: 0, messageId: 'a1', partIndex: 0, kind: 'text', time0: T0, dt: [0], text: ['答'] },
    },
    { seq: 5, time: T0, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } },
    {
      seq: 6,
      time: T0,
      type: 'user/message',
      data: { message: { id: 'u2', role: 'user', content: '第二问', timestamp: T0 } },
    },
    { seq: 7, time: T0, type: 'run/start', data: { runId: 'r2', kind: 'chat', assistantMessageId: 'a2', timestamp: T0 } },
    {
      seq: 8,
      time: T0,
      type: 'assistant/chunks',
      data: { runId: 'r2', requestIndex: 0, messageId: 'a2', partIndex: 0, kind: 'text', time0: T0, dt: [0], text: ['答二'] },
    },
  ]
}

function fold(events: Ev[]) {
  let state = createSessionProjectionState()
  for (const event of events) state = reduceSessionProjection(state, event as never)
  return state
}

const OPTS = {} as Parameters<typeof materializeChatMessagesCached>[1]

describe('materializeChatMessagesCached 的引用契约', () => {
  it('同一份 state 连问两次:数组与每条消息都是同一个对象,零 miss', () => {
    const state = fold(baseLedger())
    const first = materializeChatMessagesCached(state, OPTS, 0)
    const second = materializeChatMessagesCached(state, OPTS, 0)
    expect(second.messages).toBe(first.messages)
    expect(__countMemoMisses(state, OPTS, 0)).toBe(0)
  })

  it('活消息长一格:只有它换新引用,其余逐条同一个对象(流式期每帧只付一条的钱)', () => {
    const state = fold(baseLedger())
    const before = materializeChatMessagesCached(state, OPTS, 0).messages
    const grown = reduceSessionProjection(state, {
      seq: 9,
      time: T0,
      type: 'assistant/chunks',
      data: { runId: 'r2', requestIndex: 0, messageId: 'a2', partIndex: 0, kind: 'text', time0: T0, dt: [0], text: ['再来'] },
    } as never)
    // 变化只该落在活消息那一条上 —— 其余全部命中上一帧成品。
    expect(__countMemoMisses(grown, OPTS, 0)).toBe(1)
    const after = materializeChatMessagesCached(grown, OPTS, 0).messages
    expect(after).not.toBe(before)
    const changed = after.filter((message, i) => message !== before[i])
    expect(changed.map((m) => m.id)).toEqual(['a2'])
  })

  it('blobEpoch 前进:全部重算(blob 换回来成品会变而账本没动,少这格附件停在旧版)', () => {
    const state = fold(baseLedger())
    const before = materializeChatMessagesCached(state, OPTS, 0).messages
    expect(__countMemoMisses(state, OPTS, 1)).toBe(before.length)
    const after = materializeChatMessagesCached(state, OPTS, 1).messages
    after.forEach((message, i) => expect(message).not.toBe(before[i]))
  })

  it('与全量物化逐条同值(缓存只省钱,不改答案)', async () => {
    const { materializeChatMessages } = await import('@onething/core/session/projection/chat-messages')
    const state = fold(baseLedger())
    const cached = materializeChatMessagesCached(state, OPTS, 0)
    const full = materializeChatMessages(state, OPTS as never)
    expect(cached.messages).toEqual(full.messages)
    expect(cached.activeRun?.messageId).toBe(full.activeRun?.messageId)
  })
})
