/**
 * C2-b 工具进度活流:**发射闸 + 合批器的直送分支**。
 *
 * 三件事在这里钉住,每一件都对应一条「拆掉就红」的反证:
 *
 *  1. **开关**(`ONETHING_TOOL_PROGRESS`)缺省即开、`=0` 一条不出生;
 *  2. **三格全空的一条不发**、`ratio` 按 [0,1] 夹紧、通道抛异常绝不打断工具;
 *  3. **合批器直送而不是攒批**,而且直送那一支**盖了 messageId** —— 渲染层
 *     `chat-source.ts` 的 `if (!messageId) return` 会吃掉没盖章的 chunk,
 *     这一条是那个坑的守卫。
 *
 * 「不进账本」那一条在 `wiring/engine/stream/__tests__/tool-progress-not-in-ledger.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEventEnvelope, StreamChunk } from '@shared/events/index.js'
import type { OutgoingStreamChunk } from '../stream-coalescer.js'
import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { createEventSystem, getStreamChannel } from '../index.js'
import { createBackendHandle, setCurrentBackend } from '../../current.js'
import { isToolProgressStreamEnabled, pushSessionToolProgress } from '../tool-progress-stream.js'
import { SessionStreamCoalescer } from '../stream-coalescer.js'

const SESSION_ID = 'tool-progress-switch'
const CALL_ID = 'call-1'

let previous: string | undefined
let disposeEventSystem: (() => void) | null = null

beforeEach(() => {
  previous = process.env.ONETHING_TOOL_PROGRESS
  const { eventBus, streamChannel } = createEventSystem()
  setCurrentBackend(createBackendHandle({ eventBus, streamChannel }))
  disposeEventSystem = () => {
    eventBus.shutdown()
    streamChannel.shutdown()
  }
})

afterEach(() => {
  if (previous === undefined) delete process.env.ONETHING_TOOL_PROGRESS
  else process.env.ONETHING_TOOL_PROGRESS = previous
  disposeEventSystem?.()
  disposeEventSystem = null
  setCurrentBackend(null)
})

function collect(): unknown[] {
  const seen: unknown[] = []
  getStreamChannel().subscribe(SESSION_ID, chunk => seen.push(chunk))
  return seen
}

describe('ONETHING_TOOL_PROGRESS', () => {
  it('缺省即开 —— 用户报的正是「看不到做了多少」,默认关等于这个功能不存在', () => {
    delete process.env.ONETHING_TOOL_PROGRESS
    expect(isToolProgressStreamEnabled()).toBe(true)

    const seen = collect()
    pushSessionToolProgress(SESSION_ID, CALL_ID, { message: 'ls -la', outputTail: 'a\nb' })
    expect(seen).toEqual([
      { type: 'tool-progress', toolCallId: CALL_ID, message: 'ls -la', outputTail: 'a\nb' },
    ])
  })

  it('=0 —— 关灯开关:一条都不出生', () => {
    process.env.ONETHING_TOOL_PROGRESS = '0'
    expect(isToolProgressStreamEnabled()).toBe(false)

    const seen = collect()
    pushSessionToolProgress(SESSION_ID, CALL_ID, { message: 'ls -la' })
    expect(seen).toEqual([])
  })

  it('每次现读环境变量 —— 测试可以就地改档,不必重开进程', () => {
    delete process.env.ONETHING_TOOL_PROGRESS
    const seen = collect()
    pushSessionToolProgress(SESSION_ID, CALL_ID, { message: 'one' })
    process.env.ONETHING_TOOL_PROGRESS = '0'
    pushSessionToolProgress(SESSION_ID, CALL_ID, { message: 'two' })
    expect(seen).toHaveLength(1)
  })
})

describe('pushSessionToolProgress 的三条纪律', () => {
  beforeEach(() => {
    delete process.env.ONETHING_TOOL_PROGRESS
  })

  it('三格全空的一条不发 —— 那是一条什么都没说的 chunk', () => {
    const seen = collect()
    pushSessionToolProgress(SESSION_ID, CALL_ID, {})
    pushSessionToolProgress(SESSION_ID, CALL_ID, { message: '', outputTail: '' })
    expect(seen).toEqual([])
  })

  it('没有 sessionId / toolCallId 的一条不发', () => {
    const seen = collect()
    pushSessionToolProgress('', CALL_ID, { message: 'x' })
    pushSessionToolProgress(SESSION_ID, '', { message: 'x' })
    expect(seen).toEqual([])
  })

  it('ratio 按 [0,1] 夹紧;NaN / Infinity 当没报(不画一条冲出卡外的条)', () => {
    const seen = collect() as Array<{ ratio?: number }>
    pushSessionToolProgress(SESSION_ID, CALL_ID, { message: 'a', ratio: 1.4 })
    pushSessionToolProgress(SESSION_ID, CALL_ID, { message: 'b', ratio: -0.2 })
    pushSessionToolProgress(SESSION_ID, CALL_ID, { message: 'c', ratio: Number.NaN })
    pushSessionToolProgress(SESSION_ID, CALL_ID, { message: 'd', ratio: 0.25 })
    expect(seen.map(one => one.ratio)).toEqual([1, 0, undefined, 0.25])
  })

  it('事件系统没装配也不抛 —— 进度是读数,丢了少一行字,抛了会让一次真调用失败', () => {
    setCurrentBackend(null)
    expect(() => pushSessionToolProgress(SESSION_ID, CALL_ID, { message: 'x' })).not.toThrow()
  })
})

describe('16ms 合批器:tool-progress 走直送', () => {
  const MESSAGE_ID = 'assistant-7'

  function harness() {
    const sent: Array<{ sessionId: string; chunk: OutgoingStreamChunk }> = []
    const coalescer = new SessionStreamCoalescer({
      sendChunk: (sessionId, chunk) => sent.push({ sessionId, chunk }),
    })
    coalescer.handleEvent({
      sessionId: SESSION_ID,
      event: { type: SESSION_EVENT_TYPES.STREAM_START, assistantMessageId: MESSAGE_ID },
    } as unknown as SessionEventEnvelope)
    return { coalescer, sent }
  }

  it('当场就送(不等 16ms),而且**盖了 messageId**', () => {
    const { coalescer, sent } = harness()
    coalescer.handleChunk(SESSION_ID, {
      type: 'tool-progress',
      toolCallId: CALL_ID,
      outputTail: 'line 1',
    } as StreamChunk)

    expect(sent).toHaveLength(1)
    expect(sent[0].chunk).toEqual({
      type: 'tool-progress',
      toolCallId: CALL_ID,
      outputTail: 'line 1',
      messageId: MESSAGE_ID,
    })
  })

  it('快照不合并:三条进度到了就送三条,后一条不与前一条并批', () => {
    const { coalescer, sent } = harness()
    for (const tail of ['line 1', 'line 2', 'line 3']) {
      coalescer.handleChunk(SESSION_ID, {
        type: 'tool-progress',
        toolCallId: CALL_ID,
        outputTail: tail,
      } as StreamChunk)
    }
    expect(sent.map(one => (one.chunk as { outputTail?: string }).outputTail)).toEqual([
      'line 1',
      'line 2',
      'line 3',
    ])
  })

  it('文本 delta 照旧攒批 —— 直送这条口子只对 tool-progress 开', () => {
    const { coalescer, sent } = harness()
    coalescer.handleChunk(SESSION_ID, { type: 'text-delta', text: 'ab' } as StreamChunk)
    expect(sent).toHaveLength(0)
  })
})
