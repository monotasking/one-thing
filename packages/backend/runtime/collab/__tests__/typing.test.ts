/**
 * W19 真实 typing — the chunk-sequence → emit-sequence matrix.
 *
 * The whole point of the工单 is that the indicator now has a physical referent:
 * `say` arguments streaming. These tests are the specification of that mapping,
 * written as event sequences a real provider produces, so the "亮/不亮" rules
 * can be argued about without an engine, a bus or a room.
 */
import { describe, expect, it } from 'vitest'
import { createCollabTypingTracker, type CollabTypingSignal } from '../typing.js'

/** Play a sequence and collect only the pulses the tracker decided to emit. */
function run(signals: CollabTypingSignal[], options: { finish?: boolean } = {}): boolean[] {
  const tracker = createCollabTypingTracker()
  const emitted: boolean[] = []
  for (const signal of signals) {
    const next = tracker.observe(signal)
    if (next !== null) emitted.push(next)
  }
  if (options.finish !== false) {
    const final = tracker.finish()
    if (final !== null) emitted.push(final)
  }
  return emitted
}

function inputStart(toolCallId: string, toolName: string): CollabTypingSignal {
  return { type: 'tool:input-start', toolCallId, toolName, toolCall: { toolId: toolName } }
}

function inputEnd(toolCallId: string, toolName: string): CollabTypingSignal {
  return { type: 'tool:input-end', toolCallId, toolCall: { id: toolCallId, toolId: toolName } }
}

const START = { type: 'stream:start' } satisfies CollabTypingSignal
const TEXT = { type: 'message:updated' } satisfies CollabTypingSignal
const REASONING = { type: 'reasoning:delta' } satisfies CollabTypingSignal
const COMPLETE = { type: 'stream:complete' } satisfies CollabTypingSignal

describe('W19 — 信号源:只有 say 的参数流亮灯', () => {
  it('lights for one say call and puts it out when the words are complete', () => {
    expect(run([
      START,
      REASONING,
      inputStart('call-1', 'send_message'),
      inputEnd('call-1', 'send_message'),
      COMPLETE,
    ])).toEqual([true, false])
  })

  it('pulses once per say — 多 say 多脉冲', () => {
    expect(run([
      START,
      inputStart('call-1', 'send_message'),
      inputEnd('call-1', 'send_message'),
      REASONING,
      inputStart('call-2', 'send_message'),
      inputEnd('call-2', 'send_message'),
      COMPLETE,
    ])).toEqual([true, false, true, false])
  })

  it('stays silent through a turn that only thinks', () => {
    expect(run([START, REASONING, TEXT, REASONING, COMPLETE])).toEqual([])
  })

  it('stays silent for a board call — moving a card is not speaking', () => {
    expect(run([
      START,
      inputStart('call-1', 'board'),
      inputEnd('call-1', 'board'),
      COMPLETE,
    ])).toEqual([])
  })

  it('stays dark for any non-say tool, named or not', () => {
    // The predicate is a whitelist (现名 + 退役名), not a blacklist — a tool the
    // room surface has never heard of must not light the room either.
    expect(run([
      START,
      inputStart('call-1', 'read'),
      inputEnd('call-1', 'read'),
      COMPLETE,
    ])).toEqual([])
  })

  it('退役名 `say` 照样亮灯 —— 事件流带的是模型吐出来的原始名(审查 B7)', () => {
    // 派发那一头有退役表兜底,所以这一次调用**确实**把消息发出去了。观察器只认
    // 现名的话,真机症状就是"消息发出来了,打字灯从没亮过"。
    expect(run([
      START,
      inputStart('call-1', 'say'),
      inputEnd('call-1', 'say'),
      COMPLETE,
    ])).toEqual([true, false])
  })

  it('退役名的私聊档仍然不亮这间房的灯 —— 归一只换名字,不换判据', () => {
    // `dm` 是另一个退役名,而它天生带 `to`:归一之后它是一次 send,但仍是私聊档。
    expect(run([
      START,
      {
        type: 'tool:input-start',
        toolCallId: 'call-1',
        toolName: 'dm',
        toolCall: { toolId: 'dm', arguments: { to: '小李#fe', content: '牌发你了' } },
      },
      COMPLETE,
    ])).toEqual([])
  })

  it('ignores the noise between two says (deltas, other tools)', () => {
    expect(run([
      START,
      inputStart('call-1', 'send_message'),
      TEXT,
      REASONING,
      inputEnd('call-1', 'send_message'),
      inputStart('call-2', 'board'),
      inputEnd('call-2', 'board'),
      COMPLETE,
    ])).toEqual([true, false])
  })

  it('reads the name off the tool call when the event carries none', () => {
    expect(run([
      { type: 'tool:input-start', toolCallId: 'call-1', toolCall: { name: 'send_message' } },
      inputEnd('call-1', 'send_message'),
    ])).toEqual([true, false])
  })
})

describe('W19 — 并发 say 不闪烁', () => {
  it('holds one light across two overlapping say calls', () => {
    expect(run([
      inputStart('call-1', 'send_message'),
      inputStart('call-2', 'send_message'),
      inputEnd('call-1', 'send_message'),
      inputEnd('call-2', 'send_message'),
    ])).toEqual([true, false])
  })

  it('does not go out on an input-end for a call it never saw start', () => {
    expect(run([
      inputStart('call-1', 'send_message'),
      inputEnd('call-9', 'send_message'),
      inputEnd('call-1', 'send_message'),
    ])).toEqual([true, false])
  })
})

describe('W19 — 兜底:灯不会卡住', () => {
  it('accepts tool:execution-start as the extinguisher when input-end never came', () => {
    expect(run([
      inputStart('call-1', 'send_message'),
      { type: 'tool:execution-start', toolCallId: 'call-1', toolName: 'send_message' },
    ])).toEqual([true, false])
  })

  it('clears on a stream terminal — an aborted turn leaves nobody typing', () => {
    expect(run([
      inputStart('call-1', 'send_message'),
      { type: 'stream:aborted' },
    ])).toEqual([true, false])
  })

  it('forces false when the window closes mid-arguments', () => {
    const tracker = createCollabTypingTracker()
    expect(tracker.observe(inputStart('call-1', 'send_message'))).toBe(true)
    expect(tracker.lit).toBe(true)
    expect(tracker.finish()).toBe(false)
    expect(tracker.lit).toBe(false)
  })

  it('emits nothing on close when the light was already out', () => {
    const tracker = createCollabTypingTracker()
    tracker.observe(inputStart('call-1', 'send_message'))
    tracker.observe(inputEnd('call-1', 'send_message'))
    expect(tracker.finish()).toBeNull()
  })

  it('emits nothing on close after a turn that never spoke', () => {
    expect(run([START, REASONING, COMPLETE])).toEqual([])
  })
})

/**
 * 合并之后的打字灯(collab-send-channel-and-wake.md §4)。
 *
 * `dm` 并进 `send_message` 之后,私聊档的调用顶着同一个工具名 —— 而这盏灯挂在
 * "这一轮在答的那间房"上。"小李正在输入…"之后群里什么都没出现,是一句关于这间
 * 房的假话,而它此前根本不会发生(`dm` 是另一个名字)。
 *
 * 物理边界写在注释里也写在这组用例里:参数看得见的时刻(非流式 provider 的
 * input-start、input-end、execution-start)判据就生效;流式 provider 的私聊档
 * 仍会在参数流的那几秒亮一下再灭 —— 与 W19 §2 已接受的"显式 room 指向别处"
 * 同一种残留。
 */
describe('合并之后:私聊档不在这间房亮灯', () => {
  const ROOM = 'room-1'

  function runIn(signals: CollabTypingSignal[]): boolean[] {
    const tracker = createCollabTypingTracker({ roomSessionId: ROOM })
    const emitted: boolean[] = []
    for (const signal of signals) {
      const next = tracker.observe(signal)
      if (next !== null) emitted.push(next)
    }
    const final = tracker.finish()
    if (final !== null) emitted.push(final)
    return emitted
  }

  it('参数一开始就看得见(非流式 provider):有 to 的调用一次都不亮', () => {
    expect(runIn([
      {
        type: 'tool:input-start',
        toolCallId: 'call-1',
        toolName: 'send_message',
        toolCall: { id: 'call-1', toolId: 'send_message', arguments: { content: '牌给你', to: '小明#3f9c' } },
      },
      { type: 'tool:execution-start', toolCallId: 'call-1', toolName: 'send_message', args: { content: '牌给你', to: '小明#3f9c' } },
    ])).toEqual([])
  })

  it('显式指向别的房,同样不亮', () => {
    expect(runIn([
      {
        type: 'tool:input-start',
        toolCallId: 'call-1',
        toolName: 'send_message',
        toolCall: { id: 'call-1', toolId: 'send_message', arguments: { content: '一', room: 'room-2' } },
      },
    ])).toEqual([])
  })

  it('显式指向的就是这间房:照亮', () => {
    expect(runIn([
      {
        type: 'tool:input-start',
        toolCallId: 'call-1',
        toolName: 'send_message',
        toolCall: { id: 'call-1', toolId: 'send_message', arguments: { content: '一', room: ROOM } },
      },
      { type: 'tool:input-end', toolCallId: 'call-1', toolCall: { id: 'call-1', toolId: 'send_message', arguments: { content: '一', room: ROOM } } },
    ])).toEqual([true, false])
  })

  it('流式 provider:参数流完才看得出是私聊 —— 亮一下,随即灭,不会卡住', () => {
    expect(runIn([
      inputStart('call-1', 'send_message'),
      {
        type: 'tool:input-end',
        toolCallId: 'call-1',
        toolCall: { id: 'call-1', toolId: 'send_message', arguments: { content: '牌给你', to: '小明' } },
      },
    ])).toEqual([true, false])
  })

  it('两条并发,只有群那一条算数:灯跟着它亮灭一次', () => {
    expect(runIn([
      {
        type: 'tool:input-start',
        toolCallId: 'dm-call',
        toolName: 'send_message',
        toolCall: { id: 'dm-call', toolId: 'send_message', arguments: { content: '私聊', to: '小明' } },
      },
      inputStart('room-call', 'send_message'),
      inputEnd('room-call', 'send_message'),
    ])).toEqual([true, false])
  })
})
