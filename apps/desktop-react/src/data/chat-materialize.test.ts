import { describe, expect, it } from 'vitest'
import {
  createSessionProjectionState,
  reduceSessionProjection,
} from '@onething/core/session/projection/reducer'
import { __countMemoMisses, materializeChatMessagesCached, trimToGraphemeBoundary } from './chat-materialize'
import { StreamWater } from './stream-water'

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

/**
 * 审查条 6:**渲染边界向字素边界收一格**。
 *
 * 偏移按 UTF-16 码元(与打包行同尺,那一层不能改),而分片按码元切 —— 一条 delta
 * 停在代理对中间时,半个 emoji 在屏幕上是一格 `�`。收格只发生在画的这一刻。
 */
describe('字素边界:半个字不画', () => {
  it('落单的高位代理不画(下一片一到自然补上)', () => {
    const emoji = '😀' // U+1F600 = 一对代理
    expect(trimToGraphemeBoundary(`好${emoji[0]}`)).toBe('好')
    expect(trimToGraphemeBoundary(`好${emoji}`)).toBe(`好${emoji}`)
  })

  it('零宽连接符结尾不画(后面一定还有字)', () => {
    expect(trimToGraphemeBoundary('👨‍')).toBe('👨')
  })

  it('变体选择符结尾不画', () => {
    expect(trimToGraphemeBoundary('❤️')).toBe('❤')
  })

  it('正常文本一个字都不动(空串也不炸)', () => {
    expect(trimToGraphemeBoundary('普通的一段话')).toBe('普通的一段话')
    expect(trimToGraphemeBoundary('')).toBe('')
  })
})

/**
 * **活水位那一段的回合号**(09-02 R3 浸泡第二轮取证的修法)。
 *
 * 工具锚点(`data-steps{turnIndex}`)按回合号排。流式期那一段在账本里**还没有座位**,
 * 从前于是把回合号整个丢掉 —— `partTurn` 按 `?? 0` 兜底,`insertDataStepsByTurn`
 * 判定「所有工具锚点的回合都大于这一段」,把整批已经做完的工具挂到了它**后面**。
 * 屏幕上就是用户报的那一形:思考块在流,而它下面立着刚做完的工具调用。真机读数
 * (无正文的多请求素材,6 字/帧):新推理 321/383 帧排在所有工具之前。
 *
 * 修法是让水位那一段把章上的回合号带出来。这条用例钉的就是那一格 ——
 * 把 `turnIndex` 从 `mergeWater` 的 cell 上拿掉,它当场红。
 */
describe('活水位插进 contentParts 的那一段带着回合号', () => {
  it('账本没有座位时,回合号取章上那一格', () => {
    const state = fold(baseLedger())
    const water = new StreamWater()
    water.feed(
      { messageId: 'a2', runId: 'r2', requestIndex: 1, partIndex: 3, kind: 'reasoning', charOffset: 0, gen: 0, turnIndex: 2 },
      '工具结果之后新到的推理',
    )
    const { messages } = materializeChatMessagesCached(state, OPTS, 0, water)
    const target = messages.find((m) => m.id === 'a2')
    const part = (target?.contentParts ?? []).find(
      (p) => (p as { partIndex?: number }).partIndex === 3,
    ) as { type?: string; turnIndex?: number } | undefined
    expect(part?.type).toBe('reasoning')
    expect(part?.turnIndex).toBe(2)
  })
})
