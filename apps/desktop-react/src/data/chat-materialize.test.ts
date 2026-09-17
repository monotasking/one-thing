import { describe, expect, it } from 'vitest'
import {
  createSessionProjectionState,
  reduceSessionProjection,
} from '@onething/core/session/projection/reducer'
import { __countMemoMisses, materializeChatMessagesCached, trimToGraphemeBoundary } from './chat-materialize'
import { StreamWater } from './stream-water'
import { synthesizeCoreToolAnchors } from '@onething/core/session/render-anchors'
import { missingAssistantText } from './missing-assistant-text'
import { dumpPerf } from '../services/perf'

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
/** 壳这条读路的档:段号必须带上,水位才认得出「同一段」(见 includePartIndex 的注)。 */
const R2_OPTS = { includePartIndex: true } as Parameters<typeof materializeChatMessagesCached>[1]

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
    const { messages } = materializeChatMessagesCached(state, R2_OPTS, 0, water)
    const target = messages.find((m) => m.id === 'a2')
    const part = (target?.contentParts ?? []).find(
      (p) => (p as { partIndex?: number }).partIndex === 3,
    ) as { type?: string; turnIndex?: number } | undefined
    expect(part?.type).toBe('reasoning')
    expect(part?.turnIndex).toBe(2)
  })
})

/**
 * **中途入场 / 重连:当前请求已经流出来的正文必须可见**(09-02,编排者读源码审出的真回归)。
 *
 * 链是三段合起来才成立的:`contentParts` 只在 `requestSettled` 之后物化;
 * `anchorMessage` 只在 parts **整个为空**时才回落 `message.content`;而水位表按
 * 连续前缀律把中途入场收到的第一条 delta(偏移不为 0)丢掉——三条各自都对,
 * 合起来就是「当前这一个请求的正文一个字都不画,直到 run/end」。
 * 「账本 ≤2s 自愈」在这里不成立:打包行只让 `message.content` 变长,不物化 parts。
 */
describe('账本比 parts 长的那截照样画(中途入场)', () => {
  /** 第 0 个请求结算了(有 parts),第 1 个请求还在飞(只进了 content)。 */
  function midJoinLedger(): Ev[] {
    return [
      { seq: 1, time: T0, type: 'session/created', data: { sessionId: 's1' } },
      {
        seq: 2,
        time: T0,
        type: 'user/message',
        data: { message: { id: 'u1', role: 'user', content: '问', timestamp: T0 } },
      },
      { seq: 3, time: T0, type: 'run/start', data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 } },
      { seq: 4, time: T0, type: 'request/start', data: { runId: 'r1', requestIndex: 0, time: T0 } },
      {
        seq: 5,
        time: T0,
        type: 'assistant/chunks',
        data: { runId: 'r1', requestIndex: 0, messageId: 'a1', partIndex: 0, kind: 'text', time0: T0, dt: [0], text: ['已结算的一段。'] },
      },
      { seq: 6, time: T0, type: 'request/end', data: { runId: 'r1', requestIndex: 0, time: T0 } },
      // ★ 第二个请求:chunks 到了,request/end 没到 —— parts 画不出来,content 有。
      { seq: 7, time: T0, type: 'request/start', data: { runId: 'r1', requestIndex: 1, time: T0 } },
      {
        seq: 8,
        time: T0,
        type: 'assistant/chunks',
        data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 1, kind: 'text', time0: T0, dt: [0], text: ['正在飞的这一段。'] },
      },
    ]
  }

  const partsOf = (m: { contentParts?: unknown }) =>
    (m.contentParts ?? []) as Array<{ type?: string; content?: string; turnIndex?: number }>

  it('修前的形:未结算那一段不在 parts 里(病根,不是我们造的)', () => {
    const state = fold(midJoinLedger())
    const { messages } = materializeChatMessagesCached(state, {} as typeof OPTS, 0)
    // 不开水位:这是账本自己的样子 —— parts 只有已结算那一格。
    const target = messages.find((m) => m.id === 'a1')!
    expect(partsOf(target).filter((p) => p.type === 'text')).toHaveLength(1)
    expect(target.content).toContain('正在飞的这一段。')
  })

  it('补一格:parts 拼出来的正文与 message.content 逐字相同', () => {
    const state = fold(midJoinLedger())
    const water = new StreamWater() // 中途入场:一格都没有(第一条 delta 偏移不为 0 已被丢)
    const { messages } = materializeChatMessagesCached(state, R2_OPTS, 0, water)
    const target = messages.find((m) => m.id === 'a1')!
    const texts = partsOf(target).filter((p) => p.type === 'text')
    expect(texts).toHaveLength(2)
    expect(texts.map((p) => p.content).join('')).toBe(target.content)
    expect(texts[1].content).toBe('正在飞的这一段。')
  })

  it('补出来那一格使用未结算账本段的真实轮次', () => {
    const state = fold(midJoinLedger())
    const water = new StreamWater()
    const { messages } = materializeChatMessagesCached(state, R2_OPTS, 0, water)
    const target = messages.find((m) => m.id === 'a1')!
    const texts = partsOf(target).filter((p) => p.type === 'text')
    expect(texts[1].turnIndex).toBe(2)
  })

  it('不是前缀关系就一个字都不补 —— 宁可少画一截,不肯画错位置', () => {
    const state = fold(midJoinLedger())
    const water = new StreamWater()
    // 水位替第 0 段说了一句**和账本不一样**的话(前缀关系当场不成立)。
    water.feed(
      { messageId: 'a1', runId: 'r1', requestIndex: 0, partIndex: 0, kind: 'text', charOffset: 0, gen: 0, turnIndex: 0 },
      '另一条路上的一段话,比账本那格长得多也不一样。',
    )
    const { messages } = materializeChatMessagesCached(state, R2_OPTS, 0, water)
    const target = messages.find((m) => m.id === 'a1')!
    const texts = partsOf(target).filter((p) => p.type === 'text')
    // 只有水位那一格,没有凭空补出来的第二格。
    expect(texts).toHaveLength(1)
  })
})

describe('工具之后的正文在缺水位、结算前后保持顺序', () => {
  const body = '最终回复'
  const before = '先查资料。'
  function toolRounds(): Ev[] {
    const events: Ev[] = []
    const add = (type: string, data: unknown) => events.push({ seq: events.length + 1, time: T0, type, data })
    add('session/created', { sessionId: 's1' })
    add('run/start', { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 })
    for (let turn = 1; turn <= 6; turn += 1) {
      add('request/start', { runId: 'r1', requestIndex: turn - 1, time: T0 })
      if (turn === 1) add('assistant/chunks', {
        runId: 'r1', requestIndex: 0, messageId: 'a1', partIndex: 0, turnIndex: 1,
        kind: 'text', time0: T0, dt: [0], text: [before],
      })
      add('tool/call', { runId: 'r1', messageId: 'a1', callId: `c${turn}`, name: 'read_file', arguments: {}, turnIndex: turn })
      add('request/end', { runId: 'r1', requestIndex: turn - 1, time: T0 })
    }
    add('request/start', { runId: 'r1', requestIndex: 6, time: T0 })
    add('assistant/chunks', {
      runId: 'r1', requestIndex: 6, messageId: 'a1', partIndex: 7, turnIndex: 7,
      kind: 'text', time0: T0, dt: [0], text: [body],
    })
    return events
  }
  function order(message: Parameters<typeof synthesizeCoreToolAnchors>[1] & { contentParts?: unknown }) {
    const parts = (message.contentParts ?? []) as Array<{ type: string; content?: string; turnIndex?: number }>
    return (synthesizeCoreToolAnchors(parts, message) ?? parts)
      .map(part => part.type === 'data-steps' ? `tools:${part.turnIndex}` : part.content)
  }
  const expected = [before, ...[1, 2, 3, 4, 5, 6].map(turn => `tools:${turn}`), body]

  it('水位从零开始缺席、半途加入丢首片、正常活流以及请求结算都同序', () => {
    const events = toolRounds()
    const state = fold(events)
    for (const mode of ['empty', 'gap', 'live']) {
      const water = new StreamWater()
      if (mode !== 'empty') water.feed({
        messageId: 'a1', runId: 'r1', requestIndex: 6, partIndex: 7,
        kind: 'text', turnIndex: 7, charOffset: mode === 'gap' ? 2 : 0, gen: 0,
      }, mode === 'gap' ? body.slice(2) : body)
      const message = materializeChatMessagesCached(state, R2_OPTS, 0, water).messages.find(m => m.id === 'a1')!
      expect(order(message), mode).toEqual(expected)
      expect(message.content).toBe(before + body)
      if (mode === 'gap') expect(water.gapCount).toBe(1)
    }
    const settled = fold([...events, {
      seq: events.length + 1, time: T0, type: 'request/end', data: { runId: 'r1', requestIndex: 6, time: T0 },
    }])
    expect(order(materializeChatMessagesCached(settled, R2_OPTS, 0, new StreamWater()).messages.find(m => m.id === 'a1')!))
      .toEqual(expected)
    expect(dumpPerf().some(entry => entry.name === 'stream.water.fallback' && entry.detail?.includes('reason=missing-text-water'))).toBe(true)
  })

  it('有工具的当前轮还未结算时,正文仍在同轮工具之前', () => {
    const events = toolRounds()
    // Remove the first request/end and retain only that request's text/tool.
    const state = fold(events.slice(0, 5))
    const message = materializeChatMessagesCached(state, R2_OPTS, 0, new StreamWater()).messages.find(m => m.id === 'a1')!
    expect(order(message)).toEqual([before, 'tools:1'])
  })

  it('外部执行器的显式轮次优先于 requestIndex 推导', () => {
    const events = toolRounds()
    const last = events[events.length - 1]
    last.data = { ...(last.data as object), turnIndex: 12 }
    const message = materializeChatMessagesCached(fold(events), R2_OPTS, 0, new StreamWater()).messages.find(m => m.id === 'a1')!
    expect((message.contentParts?.at(-1) as { turnIndex?: number }).turnIndex).toBe(12)
    expect(order(message)).toEqual(expected)
  })

  it('只有旧 flat content 的历史页也把补正文放在最后工具轮之后', () => {
    const parts = [{ type: 'text', content: before, turnIndex: 1 }]
    const message = {
      role: 'assistant', content: before + body,
      steps: [1, 2, 3, 4, 5, 6].map(turnIndex => ({ turnIndex, toolCallId: `c${turnIndex}` })),
    }
    const missing = missingAssistantText(message, parts)!
    expect(missing.turnIndex).toBe(7)
    expect(order({ ...message, contentParts: [...parts, missing] })).toEqual(expected)
  })
})


/* ── C2-b:工具进度活流 ─────────────────────────────────────────────────── */

/**
 * 进度**盖在账本那次调用上**,不另画一张卡 —— 一次调用开始执行时账本早就认领了
 * 它(`tool/call` 已落账),屏幕上就是那一行。这里钉的是那次「盖」,以及它对
 * 引用契约的守法(一格没盖就原样交回,盖了就换引用)。
 */
describe('进度盖在账本那次调用上(C2-b)', () => {
  /** 一次**已落账、还没有结局**的调用 —— 投影里它就是 `executing`。 */
  function executingToolLedger(): Ev[] {
    return [
      { seq: 1, time: T0, type: 'session/created', data: { sessionId: 's1' } },
      {
        seq: 2,
        time: T0,
        type: 'user/message',
        data: { message: { id: 'u1', role: 'user', content: '跑一下', timestamp: T0 } },
      },
      { seq: 3, time: T0, type: 'run/start', data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 } },
      { seq: 4, time: T0, type: 'request/start', data: { runId: 'r1', requestIndex: 0, time: T0 } },
      // 参数先收齐(`assistant/part-end` 的 tool-input 那一格),`tool/call` 才落账
      // —— 少了这一条,投影里这次调用停在 `input-streaming` 而不是 `executing`。
      {
        seq: 5,
        time: T0,
        type: 'assistant/part-end',
        data: {
          runId: 'r1',
          requestIndex: 0,
          messageId: 'a1',
          partIndex: 0,
          kind: 'tool-input',
          toolCallId: 'c1',
          toolName: 'bash',
          len: 22,
          hash: 'h',
        },
      },
      {
        seq: 6,
        time: T0,
        type: 'tool/call',
        data: {
          callId: 'c1',
          name: 'bash',
          argumentsRaw: '{"command":"seq 1 20"}',
          messageId: 'a1',
          runId: 'r1',
        },
      },
    ]
  }

  const callOf = (messages: ReadonlyArray<{ id: string; toolCalls?: unknown }>) =>
    (messages.find(m => m.id === 'a1')!.toolCalls as Array<{
      id: string
      status: string
      progress?: { message?: string; ratio?: number; outputTail?: string }
      liveAt?: number
    }>)[0]

  it('执行中的那一次拿到 progress 三格,liveAt 一并推到收到进度的时刻', () => {
    const state = fold(executingToolLedger())
    const water = new StreamWater()
    water.feedToolProgress('a1', 'c1', { message: 'seq 1 20', outputTail: '19\n20', ratio: 0.95 })
    const { messages } = materializeChatMessagesCached(state, R2_OPTS, 0, water)
    const call = callOf(messages)
    expect(call.status).toBe('executing')
    expect(call.progress).toEqual({ message: 'seq 1 20', outputTail: '19\n20', ratio: 0.95 })
    expect(call.liveAt).toBeGreaterThan(0)
  })

  it('别人的 id 一格都不盖 —— 整条消息按引用原样交回', () => {
    const state = fold(executingToolLedger())
    const water = new StreamWater()
    const before = materializeChatMessagesCached(state, R2_OPTS, 0, water).messages.find(m => m.id === 'a1')
    water.feedToolProgress('a1', 'c9', { outputTail: 'x' })
    // blobEpoch 保持不变:换了它就是全量重算,那测的是另一件事。
    const after = materializeChatMessagesCached(state, R2_OPTS, 0, water).messages.find(m => m.id === 'a1')
    expect(after).toBe(before)
  })

  it('进度换了一份 = 换了引用(否则那一行的摘要逐帧在变而屏幕一动不动)', () => {
    const state = fold(executingToolLedger())
    const water = new StreamWater()
    water.feedToolProgress('a1', 'c1', { outputTail: 'a' })
    const first = materializeChatMessagesCached(state, R2_OPTS, 0, water).messages.find(m => m.id === 'a1')
    water.feedToolProgress('a1', 'c1', { outputTail: 'b' })
    const second = materializeChatMessagesCached(state, R2_OPTS, 0, water).messages.find(m => m.id === 'a1')
    expect(second).not.toBe(first)
    expect(callOf([second!] as never).progress?.outputTail).toBe('b')
  })

  it('水位不在场(旧路 / 冷加载)时一格不变 —— 进度是加性字段', () => {
    const state = fold(executingToolLedger())
    const { messages } = materializeChatMessagesCached(state, R2_OPTS, 0)
    expect(callOf(messages).progress).toBeUndefined()
  })
})

describe('用户消息的 content 是模型版,补账那一段不碰它', () => {
  /**
   * 09-14 真机:发 `/skill:lenovo-scripts` → 引擎落库前把整份 SKILL.md 内联进
   * `content`(`<skill …>…</skill>`),`contentParts` 只有一格 `skill-ref`。
   * 从前「账本比画得出来的长」那一段对每条消息都跑:drawnText 是空串、content
   * 是 18KB 的 skill 块,于是补出一格 text 部件 —— chip 后面拖着整份 SKILL.md。
   */
  function skillLedger(): Ev[] {
    return [
      { seq: 1, time: T0, type: 'session/created', data: { sessionId: 's1' } },
      {
        seq: 2,
        time: T0,
        type: 'user/message',
        data: {
          message: {
            id: 'u1',
            role: 'user',
            content: '<skill name="x" location="/s/SKILL.md">\n# X\n整份 SKILL.md 正文\n</skill>',
            contentParts: [
              { type: 'skill-ref', skillId: 'x', name: 'x', description: 'd', source: 'user', content: '# X', bodyHash: 'h' },
            ],
            timestamp: T0,
          },
        },
      },
      { seq: 3, time: T0, type: 'run/start', data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 } },
      {
        seq: 4,
        time: T0,
        type: 'assistant/chunks',
        data: { runId: 'r1', requestIndex: 0, messageId: 'a1', partIndex: 0, kind: 'text', time0: T0, dt: [0], text: ['好'] },
      },
    ]
  }

  it('带 skill-ref 的用户消息:parts 一格不多,模型版正文一个字不上屏', () => {
    const state = fold(skillLedger())
    const { messages } = materializeChatMessagesCached(state, R2_OPTS, 0, new StreamWater())
    const user = messages.find((m) => m.id === 'u1')
    const types = (user?.contentParts ?? []).map((p) => (p as { type?: string }).type)
    expect(types).toEqual(['skill-ref'])
    const drawn = (user?.contentParts ?? [])
      .filter((p) => (p as { type?: string }).type === 'text')
      .map((p) => (p as { content?: string }).content ?? '')
      .join('')
    expect(drawn).not.toContain('<skill')
  })

  it('反证同形的 assistant 消息:账本比 parts 长的那截照旧补出来', () => {
    const state = fold(skillLedger())
    const { messages } = materializeChatMessagesCached(state, R2_OPTS, 0, new StreamWater())
    const a1 = messages.find((m) => m.id === 'a1')
    const drawn = (a1?.contentParts ?? [])
      .filter((p) => (p as { type?: string }).type === 'text')
      .map((p) => (p as { content?: string }).content ?? '')
      .join('')
    expect(drawn).toBe('好')
  })
})
