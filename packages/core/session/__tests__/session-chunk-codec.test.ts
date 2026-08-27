/**
 * **打包编解码器的合同**(F4-c 定律二,
 * `docs/design/session-event-sourcing-2026-08.md` §16.19 / §16.21)。
 *
 * 定律二只有一条合同:**decode(encode(x)) ≡ x**。打包行是存储编码,不是语义 ——
 * 一串逻辑 delta 进编码器、刷出若干打包行、再解回来,必须与进去的那一串逐格
 * 相同(正文、段号、种类、到达时刻、段身份,一格不差)。
 *
 * 这里用的是**生产那台编码器本人**(不是测试里再写一份打包逻辑 —— 那就是第二个
 * 判定点,正是这条线要根治的病根)。随机剧本 + 真机形状剧本各跑一遍。
 *
 * 边界状态机的三条规则(换 kind 换段 / 参数流自成一段 / 分界全收)随它迁居到
 * 编码器,所以也在这里钉。
 */
import { describe, expect, it } from 'vitest'
import {
  createSessionChunkEncoder,
  decodeSessionChunksEventData,
  forEachSessionChunkLogicalDelta,
  SESSION_CHUNK_BATCH_SIZE,
  type SessionAssistantChunksEventData,
  type SessionChunkPartMeta,
  type SessionLogicalDelta,
} from '../events/index.js'

/** 一步剧本 —— 逻辑层认识的全部动作。 */
type Step =
  | { op: 'delta'; kind: 'text' | 'reasoning'; text: string }
  | { op: 'toolStart'; callId: string; toolName: string }
  | { op: 'toolDelta'; callId: string; text: string }
  | { op: 'toolDone'; callId: string }
  | { op: 'reserve' }
  | { op: 'endAll' }
  | { op: 'tick'; ms: number }
  | { op: 'timers' }

interface Harness {
  /** 编码器刷出来的打包行,按刷出的先后。 */
  rows: SessionAssistantChunksEventData[]
  /** 喂进去的逻辑 delta(编码器盖过章的那一份),按喂的先后。 */
  fed: SessionLogicalDelta[]
  run(steps: readonly Step[]): void
}

function harness(options: { batchSize?: number } = {}): Harness {
  const rows: SessionAssistantChunksEventData[] = []
  const fed: SessionLogicalDelta[] = []
  const metaByPart = new Map<number, SessionChunkPartMeta>()
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  let clock = 1000
  let nextPart = 0
  let turnIndex = 1

  const encoder = createSessionChunkEncoder({
    allocate: () => nextPart++,
    resolvePart: partIndex => metaByPart.get(partIndex),
    emitChunks: data => rows.push(data),
    onPartOpened: ref => {
      metaByPart.set(ref.partIndex, {
        runId: 'r1',
        requestIndex: 1,
        messageId: 'a1',
        kind: ref.kind,
        ...(ref.toolCallId ? { toolCallId: ref.toolCallId } : {}),
        ...(ref.toolName ? { toolName: ref.toolName } : {}),
        turnIndex,
      })
    },
    onPartEnded: ref => metaByPart.delete(ref.partIndex),
    onDelta: (partIndex, text, meta) => {
      fed.push({
        runId: meta.runId,
        requestIndex: meta.requestIndex,
        messageId: meta.messageId,
        partIndex,
        kind: meta.kind,
        ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
        ...(meta.toolName ? { toolName: meta.toolName } : {}),
        turnIndex: meta.turnIndex,
        time: clock,
        text,
      })
    },
    now: () => clock,
    batchSize: options.batchSize,
    schedule: (fn, ms) => {
      const timer = { at: clock + ms, fn, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })

  return {
    rows,
    fed,
    run(steps) {
      for (const step of steps) {
        switch (step.op) {
          case 'delta': encoder.delta(step.kind, step.text); break
          case 'toolStart': encoder.toolInputStart(step.callId, step.toolName); break
          case 'toolDelta': encoder.toolInputDelta(step.callId, step.text); break
          case 'toolDone': encoder.toolInputDone(step.callId); break
          case 'reserve': encoder.reservePart(); break
          case 'endAll': encoder.endAll(); turnIndex += 1; break
          case 'tick': clock += step.ms; break
          case 'timers':
            for (const timer of [...timers]) {
              if (!timer.cancelled && timer.at <= clock) {
                timer.cancelled = true
                timer.fn()
              }
            }
            break
        }
      }
      encoder.endAll()
      encoder.flushAll()
    },
  }
}

/** 打包行 → 逻辑 delta 流(解码半边,按行的先后串起来)。 */
function decodeAll(rows: readonly SessionAssistantChunksEventData[]): SessionLogicalDelta[] {
  return rows.flatMap(row => decodeSessionChunksEventData(row))
}

/**
 * 比较用的归一:**同一段里的先后**是编码保住的东西,而两段之间的先后由段号说了算
 * (两段各自攒批,刷行的先后与喂的先后本来就可以不同 —— 那正是"打包不是语义")。
 */
function bySegment(deltas: readonly SessionLogicalDelta[]): Map<number, SessionLogicalDelta[]> {
  const grouped = new Map<number, SessionLogicalDelta[]>()
  for (const delta of deltas) {
    const list = grouped.get(delta.partIndex)
    if (list) list.push(delta)
    else grouped.set(delta.partIndex, [delta])
  }
  return grouped
}

function expectRoundTrip(fed: readonly SessionLogicalDelta[], rows: readonly SessionAssistantChunksEventData[]): void {
  const decoded = decodeAll(rows)
  expect(decoded).toHaveLength(fed.length)
  const left = bySegment(fed)
  const right = bySegment(decoded)
  expect([...right.keys()].sort((a, b) => a - b)).toEqual([...left.keys()].sort((a, b) => a - b))
  for (const [partIndex, expected] of left) {
    expect(right.get(partIndex)).toEqual(expected)
  }
}

describe('assistant/chunks codec — decode ∘ encode ≡ id', () => {
  it('holds on a real-machine shaped script (四道闸各走一遍)', () => {
    const target = harness()
    const steps: Step[] = [
      { op: 'delta', kind: 'text', text: 'he' },
      { op: 'tick', ms: 5 },
      { op: 'delta', kind: 'text', text: 'llo' },
      // 换 kind 换段。
      { op: 'tick', ms: 3 },
      { op: 'delta', kind: 'reasoning', text: 'why' },
      { op: 'tick', ms: 2 },
      { op: 'delta', kind: 'text', text: 'back' },
      // 2 秒闸自己响。
      { op: 'tick', ms: 2100 },
      { op: 'timers' },
      { op: 'delta', kind: 'text', text: 'after-timer' },
      // 参数流自成一段。
      { op: 'toolStart', callId: 'c1', toolName: 'read' },
      { op: 'tick', ms: 1 },
      { op: 'toolDelta', callId: 'c1', text: '{"pa' },
      { op: 'tick', ms: 1 },
      { op: 'toolDelta', callId: 'c1', text: 'th":"a"}' },
      { op: 'toolDone', callId: 'c1' },
      // 不吐 delta 的一格(provider-data)先把正文/推理两段收了。
      { op: 'reserve' },
      { op: 'delta', kind: 'text', text: 'tail' },
      { op: 'endAll' },
    ]
    // 64 条闸。
    for (let index = 0; index < SESSION_CHUNK_BATCH_SIZE + 3; index += 1) {
      steps.push({ op: 'delta', kind: 'text', text: `d${index} ` }, { op: 'tick', ms: 1 })
    }
    target.run(steps)

    expect(target.rows.length).toBeGreaterThan(5)
    expect(target.fed.length).toBe(SESSION_CHUNK_BATCH_SIZE + 3 + 8)
    expectRoundTrip(target.fed, target.rows)
  })

  it('holds on 200 random scripts', () => {
    // 定值种子的线性同余 —— 随机但可复现(失败时同一串剧本一定重来一遍)。
    let seed = 20260827
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length) % items.length]

    for (let script = 0; script < 200; script += 1) {
      const target = harness({ batchSize: 1 + Math.floor(rand() * 6) })
      const steps: Step[] = []
      const openCalls: string[] = []
      const length = 5 + Math.floor(rand() * 60)
      for (let index = 0; index < length; index += 1) {
        const roll = rand()
        if (roll < 0.45) {
          steps.push({ op: 'delta', kind: pick(['text', 'reasoning'] as const), text: `x${index}` })
        } else if (roll < 0.55) {
          const callId = `c${index}`
          openCalls.push(callId)
          steps.push({ op: 'toolStart', callId, toolName: 'read' })
        } else if (roll < 0.7 && openCalls.length) {
          steps.push({ op: 'toolDelta', callId: pick(openCalls), text: `{"a":${index}}` })
        } else if (roll < 0.78 && openCalls.length) {
          steps.push({ op: 'toolDone', callId: openCalls.pop() as string })
        } else if (roll < 0.84) {
          steps.push({ op: 'reserve' })
        } else if (roll < 0.9) {
          steps.push({ op: 'endAll' })
          openCalls.length = 0
        } else if (roll < 0.96) {
          steps.push({ op: 'tick', ms: Math.floor(rand() * 3000) })
        } else {
          steps.push({ op: 'timers' })
        }
        if (rand() < 0.4) steps.push({ op: 'tick', ms: Math.floor(rand() * 40) })
      }
      target.run(steps)
      expectRoundTrip(target.fed, target.rows)
    }
  })

  it('never packs an empty batch, and every row keeps dt and text the same length', () => {
    const target = harness({ batchSize: 3 })
    target.run([
      { op: 'delta', kind: 'text', text: '' },
      { op: 'delta', kind: 'text', text: 'a' },
      { op: 'tick', ms: 4 },
      { op: 'delta', kind: 'text', text: 'b' },
      { op: 'endAll' },
      { op: 'endAll' },
    ])
    expect(target.rows).toHaveLength(1)
    for (const row of target.rows) {
      expect(row.dt).toHaveLength(row.text.length)
      expect(row.dt[0]).toBe(0)
      expect(row.text.length).toBeGreaterThan(0)
    }
    expectRoundTrip(target.fed, target.rows)
  })

  it('lends one object to forEach and hands out fresh ones from the array form', () => {
    const row: SessionAssistantChunksEventData = {
      runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text',
      time0: 100, dt: [0, 5], text: ['a', 'b'],
    }
    // 热路径借一格出去(读侧全库省掉的正是这一半分配)—— 拿到的是同一个对象。
    const seen: SessionLogicalDelta[] = []
    forEachSessionChunkLogicalDelta(row, delta => seen.push(delta))
    expect(seen[0]).toBe(seen[1])
    // 数组形态给的是各自独立的一份,拿走了随便留。
    const copied = decodeSessionChunksEventData(row)
    expect(copied[0]).not.toBe(copied[1])
    expect(copied.map(delta => [delta.text, delta.time])).toEqual([['a', 100], ['b', 105]])
  })

  it('decodes an old row whose dt is short without dropping any delta', () => {
    // 盘上的老行/半行不归我们管:读侧只跳过、绝不"修文件"(§9.1 容错口径)。
    const decoded = decodeSessionChunksEventData({
      runId: 'r1',
      requestIndex: 1,
      messageId: 'a1',
      partIndex: 0,
      kind: 'text',
      time0: 100,
      dt: [0, 5],
      text: ['a', 'b', 'c'],
    })
    expect(decoded.map(delta => [delta.text, delta.time])).toEqual([
      ['a', 100],
      ['b', 105],
      ['c', 105],
    ])
  })
})
