/**
 * refold 协作式分片的**合同**(§15.14)。
 *
 * 这道门只问一件事:分片版与它替下来的那个写法**同结果**。分片是为了不攥着
 * 主进程不放,不是为了换一种算法 —— 只要有一格不逐字等价,refold 这道对账门
 * 就会开始按"另一种口径"判红绿,而那比慢 164ms 严重得多。
 *
 * 所以每条用例都是同一个形状:同一份输入,原写法 vs 分片写法,`toEqual`。
 * 预算一律传 `0`(每一步都让出),让分片点被最大限度地踩到 —— 生产预算下不
 * 出现的错位,`0` 预算下一定出现。
 *
 * 最后一条用例问的是另一件事:分片**真的让出去了吗**(否则这一批白改)。
 */

import { describe, expect, it } from 'vitest'
import {
  canonicalChatMessage,
  createSessionProjectionState,
  encodeSessionLogEventLine,
  materializeNode,
  parseSessionLogEventLog,
  reduceSessionProjection,
  type SessionLogEventRecord,
  type SessionProjectionState,
} from '@onething/core/session'

import {
  canonicalProjectionMessagesSliced,
  createRefoldSliceGate,
  deepEqualPairsSliced,
  foldSessionProjectionSliced,
  parseSessionLogEventLogSliced,
} from '../refold-slices.js'

// ============ 素材 ============

function userMessageEvent(seq: number, id: string, text: string): SessionLogEventRecord {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'user/message',
    data: { message: { id, role: 'user', content: text, timestamp: 1_700_000_000_000 + seq } },
  } as unknown as SessionLogEventRecord
}

function assistantMessageEvent(seq: number, id: string, text: string): SessionLogEventRecord {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'system/message',
    data: { message: { id, role: 'assistant', content: text, timestamp: 1_700_000_000_000 + seq } },
  } as unknown as SessionLogEventRecord
}

function sampleEvents(count: number): SessionLogEventRecord[] {
  const events: SessionLogEventRecord[] = [
    { seq: 1, time: 1_700_000_000_000, type: 'session/created', data: { sessionId: 's1' } } as unknown as SessionLogEventRecord,
  ]
  for (let index = 0; index < count; index++) {
    const seq = index + 2
    events.push(index % 2 === 0
      ? userMessageEvent(seq, `u${index}`, `问题 ${index} ${'x'.repeat(index % 37)}`)
      : assistantMessageEvent(seq, `a${index}`, `回答 ${index} ${'y'.repeat(index % 53)}`))
  }
  return events
}

/**
 * 一份**难看**的日志文本:空行、乱序 seq、同 seq 重复行、未来类型、坏包封、
 * 末尾半行、以及"最后一行没有 \n"。原函数与分片版必须在每一处上作出同一个决定。
 */
function nastyLogText(): string {
  const lines = [
    encodeSessionLogEventLine(userMessageEvent(3, 'u3', '第三条')).trimEnd(),
    '',
    encodeSessionLogEventLine(userMessageEvent(1, 'u1', '第一条')).trimEnd(),
    '   ',
    encodeSessionLogEventLine(userMessageEvent(2, 'u2a', '同 seq 的前一条')).trimEnd(),
    encodeSessionLogEventLine(userMessageEvent(2, 'u2b', '同 seq 的后一条')).trimEnd(),
    '{"seq":9001,"time":1,"type":"session/teleported","data":{}}',
    '{"seq":"nope","time":1,"type":"user/message","data":{}}',
    'not json at all',
    encodeSessionLogEventLine(userMessageEvent(4, 'u4', '第四条')).trimEnd(),
    '{"seq":999,"time":1,"type":"tool/',
  ]
  return lines.join('\n')
}

function foldAll(events: readonly SessionLogEventRecord[]): SessionProjectionState {
  let state = createSessionProjectionState()
  for (const event of events) state = reduceSessionProjection(state, event)
  return state
}

function canonicalAll(state: SessionProjectionState): unknown[] {
  return state.nodes
    .filter(node => !node.hidden)
    .map(node => canonicalChatMessage(materializeNode(node, {}) as unknown as Record<string, unknown>))
}

// ============ 合同 ============

describe('refold slices are byte-for-byte the same computation (§15.14)', () => {
  it('parses a nasty log exactly like parseSessionLogEventLog', async () => {
    const text = nastyLogText()
    const gate = createRefoldSliceGate(0)
    expect(await parseSessionLogEventLogSliced(text, gate)).toEqual(parseSessionLogEventLog(text))
  })

  it('parses the same for a trailing newline, an empty file and a single line', async () => {
    const one = encodeSessionLogEventLine(userMessageEvent(1, 'u1', 'x'))
    for (const text of ['', '\n', '\n\n', one, one.trimEnd(), `${one}${one}`]) {
      const gate = createRefoldSliceGate(0)
      expect(await parseSessionLogEventLogSliced(text, gate)).toEqual(parseSessionLogEventLog(text))
    }
  })

  it('parses a many-line log identically (the slicing points are crossed for real)', async () => {
    const text = sampleEvents(500).map(encodeSessionLogEventLine).join('')
    const gate = createRefoldSliceGate(0)
    expect(await parseSessionLogEventLogSliced(text, gate)).toEqual(parseSessionLogEventLog(text))
  })

  it('folds identically to a straight sequential reduce', async () => {
    const events = sampleEvents(500)
    const gate = createRefoldSliceGate(0)
    // 折出来的 state 里有 Map/Set,直接比整份 state 会把内部索引也钉死;比的是
    // 这道门真正的判据 —— canonical 之后的消息数组,外加节点数与游标。
    const sliced = await foldSessionProjectionSliced(events, gate)
    const straight = foldAll(events)
    expect(sliced.nodes.length).toBe(straight.nodes.length)
    expect(sliced.lastSeq).toBe(straight.lastSeq)
    expect(canonicalAll(sliced)).toEqual(canonicalAll(straight))
  })

  it('materializes the visible nodes identically to visible.map(canonical∘materialize)', async () => {
    const state = foldAll(sampleEvents(300))
    const gate = createRefoldSliceGate(0)
    expect(await canonicalProjectionMessagesSliced(state, {}, gate)).toEqual(canonicalAll(state))
  })

  it('compares pairwise exactly like deepEqual over two arrays', async () => {
    const isEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
    const a = canonicalAll(foldAll(sampleEvents(120)))
    const same = canonicalAll(foldAll(sampleEvents(120)))
    const shorter = same.slice(0, same.length - 1)
    const changed = [...same]
    changed[7] = { ...(changed[7] as Record<string, unknown>), content: '被改过的一条' }

    expect(await deepEqualPairsSliced(a, same, isEqual, createRefoldSliceGate(0))).toBe(true)
    expect(await deepEqualPairsSliced(a, shorter, isEqual, createRefoldSliceGate(0))).toBe(false)
    expect(await deepEqualPairsSliced(a, changed, isEqual, createRefoldSliceGate(0))).toBe(false)
    expect(await deepEqualPairsSliced([], [], isEqual, createRefoldSliceGate(0))).toBe(true)
  })

  it('short-circuits on the first unequal pair (it does not walk the rest)', async () => {
    const seen: number[] = []
    const isEqual = (a: unknown): boolean => {
      seen.push(seen.length)
      return (a as { id?: string }).id !== 'u4'
    }
    const items = [{ id: 'u0' }, { id: 'u2' }, { id: 'u4' }, { id: 'u6' }, { id: 'u8' }]
    expect(await deepEqualPairsSliced(items, items, isEqual, createRefoldSliceGate(0))).toBe(false)
    expect(seen.length).toBe(3)
  })
})

describe('refold slices actually hand the event loop back (§15.14)', () => {
  it('lets a macrotask run while the parse is in flight', async () => {
    const text = sampleEvents(2_000).map(encodeSessionLogEventLine).join('')

    // 一个"别人"的宏任务循环:每被调度一次就 +1。同步跑完的解析期间它一次都
    // 插不进来;分片之后它必须插得进来 —— 这正是"答完顿一下"消失的原因。
    let interleaved = 0
    let running = true
    const beat = (): void => {
      if (!running) return
      interleaved += 1
      setImmediate(beat)
    }
    setImmediate(beat)

    // 先证明同步版一次都不让:同一个宏任务里跑完,计数不动。
    const before = interleaved
    parseSessionLogEventLog(text)
    expect(interleaved).toBe(before)

    await parseSessionLogEventLogSliced(text, createRefoldSliceGate(0))
    running = false
    expect(interleaved).toBeGreaterThan(before)
  })

  it('reports the longest uninterrupted block it measured', async () => {
    const gate = createRefoldSliceGate(0)
    await parseSessionLogEventLogSliced(sampleEvents(200).map(encodeSessionLogEventLine).join(''), gate)
    // 只断言它是个像样的读数(具体毫秒数是机器相关的,真机分布由探针量)。
    expect(gate.longestBlockMs()).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(gate.longestBlockMs())).toBe(true)
  })
})
